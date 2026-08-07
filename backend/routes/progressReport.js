const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzeProgress, renderMarkdown } = require('../lib/progressReport');
const { renderProgressReportPdf } = require('../lib/progressReportPdf');
const { friendlyAiError } = require('../lib/aiErrors');
const storage = require('../lib/storage');
const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { brandingFor } = require('../lib/orgBranding');

// Everything here belongs to one organization, and within it a member sees only the
// projects they are on. Applied to the whole router so a new endpoint cannot be added
// without it.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('progress-report'));

// Loads a report only if the caller may see it; otherwise null, which callers turn into a
// 404 rather than a 403 so ids cannot be probed. Always selects the whole row: the
// visibility check needs org_id and project_id, and a narrower select would silently
// defeat it.
function visibleReport(req) {
  const row = db.prepare(`SELECT * FROM progress_reports WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 100 },
});

const ACCEPTED = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);

// Next sequential report number for a project (the template titles reports "…-14", etc.).
function nextReportNumber(projectId) {
  const row = projectId
    ? db.prepare('SELECT MAX(report_number) AS m FROM progress_reports WHERE project_id=?').get(projectId)
    : db.prepare('SELECT MAX(report_number) AS m FROM progress_reports').get();
  return (row && row.m ? row.m : 0) + 1;
}

// Generate a progress report from a batch of site photos. Vision-only: the images (with
// their captions) are sent to Claude, which writes the "Progress" observations; the report
// itself follows the standard template (header block + Progress + captioned photo grid).
router.post('/', upload.array('images', 100), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'Upload at least one site photo (JPG/JPEG).' });
    const bad = files.find(f => !ACCEPTED.has(f.mimetype));
    if (bad) return res.status(400).json({ error: `Only JPG/JPEG images are supported (${bad.originalname} is not).` });

    let captions = [];
    if (req.body.captions) {
      try { captions = JSON.parse(req.body.captions); } catch { captions = []; }
    }
    if (!Array.isArray(captions)) captions = [];

    // The project is confirmed to be one the caller may write to, rather than trusted from
    // the request — otherwise a report could be filed into someone else's project.
    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    let projectName = req.body.project_name || null;
    if (projectId) {
      const project = access.projectForUser(req.user, projectId);
      if (!project || project.org_id !== req.orgId) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (!projectName) projectName = project.project_name;
    }

    const frequency = req.body.frequency || null;
    const periodLabel = req.body.period_label || null;
    const visitDate = req.body.visit_date || null;
    const visitTime = req.body.visit_time || null;
    const weather = req.body.weather || null;
    const submittedBy = req.body.submitted_by || null;
    const contractor = req.body.contractor || null;
    const reportNumber = req.body.report_number ? Number(req.body.report_number) : nextReportNumber(projectId);

    const images = files.map((f, i) => ({
      buffer: f.buffer,
      mediaType: f.mimetype === 'image/jpg' ? 'image/jpeg' : f.mimetype,
      caption: (captions[i] || '').toString().trim(),
      fileName: f.originalname,
    }));

    const report = await analyzeProgress({
      images, projectName, contractor, periodLabel, visitDate, notes: req.body.notes || null,
    });

    const header = {
      projectName, reportNumber, frequency, periodLabel,
      visitDate, visitTime, weather, submittedBy, contractor, imageCount: images.length,
    };
    const markdown = renderMarkdown({ report, header, photos: images });

    const insert = db.prepare(`
      INSERT INTO progress_reports (
        org_id, project_id, report_number, frequency, period_label, visit_date, visit_time, weather,
        submitted_by, contractor, notes, image_count, report_json, report_markdown, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId, projectId, reportNumber, frequency, periodLabel, visitDate, visitTime, weather,
      submittedBy, contractor, req.body.notes || null, images.length,
      JSON.stringify(report), markdown, req.body.created_by || null
    );
    const reportId = insert.lastInsertRowid;

    const insertFile = db.prepare(`
      INSERT INTO progress_report_files (report_id, sort_order, file_name, mime_type, caption, file_key, file_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const { key } = await storage.storeFile('progress', f.buffer, f.mimetype, f.originalname);
      insertFile.run(reportId, i, f.originalname, f.mimetype, images[i].caption || null, key, key ? Buffer.alloc(0) : f.buffer);
    }

    res.json({ id: reportId, report, header });
  } catch (err) {
    console.error('Progress report error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

router.get('/', (req, res) => {
  const { project_id } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_id, report_number, frequency, period_label, visit_date,
             submitted_by, contractor, image_count, created_by, created_at
             FROM progress_reports WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Assembles the header object the report views/PDF expect from a stored row.
function headerFromRow(row) {
  return {
    projectName: null, reportNumber: row.report_number, frequency: row.frequency,
    periodLabel: row.period_label, visitDate: row.visit_date, visitTime: row.visit_time,
    weather: row.weather, submittedBy: row.submitted_by, contractor: row.contractor,
    imageCount: row.image_count,
  };
}

router.get('/:id', (req, res) => {
  const row = visibleReport(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const report = JSON.parse(row.report_json);
  const photos = db.prepare(
    'SELECT id, sort_order, file_name, mime_type, caption FROM progress_report_files WHERE report_id=? ORDER BY sort_order ASC'
  ).all(row.id);
  // Fill projectName from the project if still linked, for the header.
  const header = headerFromRow(row);
  if (row.project_id) {
    const proj = db.prepare('SELECT project_name FROM projects WHERE id=?').get(row.project_id);
    header.projectName = proj?.project_name || null;
  }
  res.json({ ...row, report_json: report, report, header, photos });
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleReport(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stem = row.report_number != null ? `-${row.report_number}` : `_${req.params.id}`;
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Progress_Report${stem}.md"`);
  res.send(row.report_markdown);
});

// The PDF is the primary deliverable — laid out to match the standard report template.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = visibleReport(req);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const report = JSON.parse(row.report_json);
    const header = headerFromRow(row);
    if (row.project_id) {
      const proj = db.prepare('SELECT project_name FROM projects WHERE id=?').get(row.project_id);
      header.projectName = proj?.project_name || null;
    }
    const photoRows = db.prepare(
      'SELECT caption, mime_type, file_key, file_blob FROM progress_report_files WHERE report_id=? ORDER BY sort_order ASC'
    ).all(row.id);
    const photos = [];
    for (const p of photoRows) {
      const buffer = await storage.readFile({ key: p.file_key, blob: p.file_blob });
      if (buffer) photos.push({ caption: p.caption, mimeType: p.mime_type, buffer });
    }

    // The reporting organization's own letterhead. The previous lookup took whichever memo
    // template sorted first across the whole database, which put one customer's address on
    // another's report.
    const branding = await brandingFor(req.orgId);

    const pdf = await renderProgressReportPdf({
      report, header, photos, companyName: branding.companyName, logo: branding.logo,
    });
    const stem = (header.projectName || 'Progress').replace(/[^a-z0-9]+/gi, '_');
    const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_Progress_Report${num}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Progress report PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files/:fileId', async (req, res) => {
  if (!visibleReport(req)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(
    'SELECT file_name, mime_type, file_key, file_blob FROM progress_report_files WHERE id=? AND report_id=?'
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  if (!visibleReport(req)) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare('SELECT file_key FROM progress_report_files WHERE report_id=? AND file_key IS NOT NULL')
    .all(req.params.id).map(r => r.file_key);
  db.prepare('DELETE FROM progress_reports WHERE id=?').run(req.params.id);
  await storage.remove(keys);
  res.json({ success: true });
});

module.exports = router;
