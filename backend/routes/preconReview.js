const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePreconDocuments } = require('../lib/preconReview');
const { renderMarkdown } = require('../lib/preconReport');
const { renderPreconReportPdf } = require('../lib/preconReportPdf');
const { friendlyAiError } = require('../lib/aiErrors');
const storage = require('../lib/storage');


const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');

// Scoped to one organization; within it a member sees only projects they belong to.
// Applied to the whole router so a new endpoint cannot silently skip it.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('precon-review'));

// Loads a row only if the caller may see it, else null -> the caller answers 404 rather
// than 403 so ids cannot be probed. Always selects the whole row, because the check needs
// org_id.
function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM preconstruction_reviews WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row, { projectColumn: null }) ? row : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 100 }
});

router.post('/', upload.array('documents', 100), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one document is required.' });
    }

    const projectName = req.body.project_name || null;
    const reviewFocus = req.body.review_focus || null;

    let analysis;
    try {
      analysis = await analyzePreconDocuments(files, { projectName, reviewFocus });
    } catch (err) {
      console.error('Precon analysis error:', err);
      return res.status(err.status === 429 ? 429 : 502).json({ error: friendlyAiError(err) || 'Document analysis failed. Please try again.' });
    }

    const fileNames = files.map(f => f.originalname);
    const markdown = renderMarkdown({ projectName, reviewFocus, fileNames, analysis });

    const insertReview = db.prepare(`
      INSERT INTO preconstruction_reviews (
        org_id, project_name, review_focus, file_names, report_json, report_markdown, insufficient_info, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId,
      projectName, reviewFocus, JSON.stringify(fileNames),
      JSON.stringify(analysis), markdown,
      analysis.insufficientInfo ? 1 : 0,
      req.body.created_by || null
    );
    const reviewId = insertReview.lastInsertRowid;

    const insertFile = db.prepare(`
      INSERT INTO preconstruction_review_files (review_id, file_name, mime_type, file_key, file_blob) VALUES (?, ?, ?, ?, ?)
    `);
    for (const file of files) {
      const { key } = await storage.storeFile('precon', file.buffer, file.mimetype, file.originalname);
      insertFile.run(reviewId, file.originalname, file.mimetype, key, key ? Buffer.alloc(0) : file.buffer);
    }

    res.json({ id: reviewId, report: { projectName, reviewFocus, fileNames, ...analysis } });
  } catch (err) {
    console.error('Precon review error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, project_name } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId, { projectColumn: null });
  let sql = `SELECT id, project_name, review_focus, file_names, insufficient_info, created_by, created_at
             FROM preconstruction_reviews WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_name) { sql += ' AND project_name = ?'; params.push(project_name); }
  if (search) { sql += ' AND project_name LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, file_names: JSON.parse(r.file_names || '[]') })));
});

router.get('/:id', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const files = db.prepare('SELECT id, file_name, mime_type FROM preconstruction_review_files WHERE review_id=?').all(req.params.id);
  res.json({
    ...row,
    file_names: JSON.parse(row.file_names || '[]'),
    report_json: JSON.parse(row.report_json),
    files,
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Precon_Review_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown);
});

// The PDF is what actually gets sent on to an owner or a design team, so it is generated from
// the stored analysis rather than from the markdown — same source as the .md export, no risk
// of the two saying different things.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = visibleRow(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Reuses the letterhead the proposal memo prints, so editing it in one place keeps every
    // outgoing document consistent.
    const tpl = db.prepare(
      `SELECT company_name FROM memo_templates ORDER BY is_default DESC, id ASC LIMIT 1`
    ).get();

    const pdf = await renderPreconReportPdf({
      projectName: row.project_name,
      reviewFocus: row.review_focus,
      fileNames: JSON.parse(row.file_names || '[]'),
      analysis: JSON.parse(row.report_json),
      companyName: tpl?.company_name || undefined,
    });

    const stem = (row.project_name || 'Precon').replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_Precon_Review.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Precon PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files/:fileId', async (req, res) => {
  if (!visibleRow(req)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT file_name, mime_type, file_key, file_blob FROM preconstruction_review_files WHERE id=? AND review_id=?').get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  if (!visibleRow(req)) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare('SELECT file_key FROM preconstruction_review_files WHERE review_id=? AND file_key IS NOT NULL')
    .all(req.params.id).map(r => r.file_key);
  db.prepare('DELETE FROM preconstruction_reviews WHERE id=?').run(req.params.id);
  await storage.remove(keys);
  res.json({ success: true });
});

module.exports = router;
