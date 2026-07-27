const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzeProgress, renderMarkdown } = require('../lib/progressReport');
const { renderProgressReportPdf } = require('../lib/progressReportPdf');
const { friendlyAiError } = require('../lib/aiErrors');

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

    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    let projectName = req.body.project_name || null;
    if (projectId && !projectName) {
      const proj = db.prepare('SELECT project_name FROM projects WHERE id=?').get(projectId);
      projectName = proj?.project_name || null;
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
        project_id, report_number, frequency, period_label, visit_date, visit_time, weather,
        submitted_by, contractor, notes, image_count, report_json, report_markdown, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, reportNumber, frequency, periodLabel, visitDate, visitTime, weather,
      submittedBy, contractor, req.body.notes || null, images.length,
      JSON.stringify(report), markdown, req.body.created_by || null
    );
    const reportId = insert.lastInsertRowid;

    const insertFile = db.prepare(`
      INSERT INTO progress_report_files (report_id, sort_order, file_name, mime_type, caption, file_blob)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    files.forEach((f, i) => insertFile.run(reportId, i, f.originalname, f.mimetype, images[i].caption || null, f.buffer));

    res.json({ id: reportId, report, header });
  } catch (err) {
    console.error('Progress report error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

router.get('/', (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT id, project_id, report_number, frequency, period_label, visit_date,
             submitted_by, contractor, image_count, created_by, created_at
             FROM progress_reports WHERE 1=1`;
  const params = [];
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
  const row = db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id);
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
  const row = db.prepare('SELECT report_number, report_markdown FROM progress_reports WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stem = row.report_number != null ? `-${row.report_number}` : `_${req.params.id}`;
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Progress_Report${stem}.md"`);
  res.send(row.report_markdown);
});

// The PDF is the primary deliverable — laid out to match the standard report template.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const report = JSON.parse(row.report_json);
    const header = headerFromRow(row);
    if (row.project_id) {
      const proj = db.prepare('SELECT project_name FROM projects WHERE id=?').get(row.project_id);
      header.projectName = proj?.project_name || null;
    }
    const photos = db.prepare(
      'SELECT caption, mime_type, file_blob FROM progress_report_files WHERE report_id=? ORDER BY sort_order ASC'
    ).all(row.id).map(p => ({ caption: p.caption, mimeType: p.mime_type, buffer: Buffer.from(p.file_blob) }));

    // Use the same letterhead address the proposal memo prints, so editing it in one
    // place keeps both documents consistent.
    const tpl = db.prepare(
      `SELECT company_name FROM memo_templates ORDER BY is_default DESC, id ASC LIMIT 1`
    ).get();

    const pdf = await renderProgressReportPdf({ report, header, photos, companyName: tpl?.company_name || undefined });
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

router.get('/:id/files/:fileId', (req, res) => {
  const row = db.prepare(
    'SELECT file_name, mime_type, file_blob FROM progress_report_files WHERE id=? AND report_id=?'
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
  res.send(Buffer.from(row.file_blob));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM progress_reports WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
