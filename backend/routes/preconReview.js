const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePreconDocuments } = require('../lib/preconReview');
const { renderMarkdown } = require('../lib/preconReport');
const { friendlyAiError } = require('../lib/aiErrors');

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
        project_name, review_focus, file_names, report_json, report_markdown, insufficient_info, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectName, reviewFocus, JSON.stringify(fileNames),
      JSON.stringify(analysis), markdown,
      analysis.insufficientInfo ? 1 : 0,
      req.body.created_by || null
    );
    const reviewId = insertReview.lastInsertRowid;

    const insertFile = db.prepare(`
      INSERT INTO preconstruction_review_files (review_id, file_name, mime_type, file_blob) VALUES (?, ?, ?, ?)
    `);
    for (const file of files) {
      insertFile.run(reviewId, file.originalname, file.mimetype, file.buffer);
    }

    res.json({ id: reviewId, report: { projectName, reviewFocus, fileNames, ...analysis } });
  } catch (err) {
    console.error('Precon review error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search } = req.query;
  let sql = `SELECT id, project_name, review_focus, file_names, insufficient_info, created_by, created_at
             FROM preconstruction_reviews WHERE 1=1`;
  const params = [];
  if (search) { sql += ' AND project_name LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, file_names: JSON.parse(r.file_names || '[]') })));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM preconstruction_reviews WHERE id=?').get(req.params.id);
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
  const row = db.prepare('SELECT project_name, report_markdown FROM preconstruction_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Precon_Review_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown);
});

router.get('/:id/files/:fileId', (req, res) => {
  const row = db.prepare('SELECT file_name, mime_type, file_blob FROM preconstruction_review_files WHERE id=? AND review_id=?').get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(Buffer.from(row.file_blob));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM preconstruction_reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
