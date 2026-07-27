const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzeProgress, renderMarkdown } = require('../lib/progressReport');
const { friendlyAiError } = require('../lib/aiErrors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 100 },
});

const ACCEPTED = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);

// Generate a progress report from a batch of site photos. Vision-only: the images (with
// their captions) are sent to Claude, which writes the narrative report. No deterministic
// checks — this is a reporting tool, not an audit tool.
router.post('/', upload.array('images', 100), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'Upload at least one site photo (JPG/JPEG).' });
    const bad = files.find(f => !ACCEPTED.has(f.mimetype));
    if (bad) return res.status(400).json({ error: `Only JPG/JPEG images are supported (${bad.originalname} is not).` });

    // Captions arrive as a JSON array aligned to the file order.
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
    const notes = req.body.notes || null;

    const images = files.map((f, i) => ({
      buffer: f.buffer,
      mediaType: f.mimetype === 'image/jpg' ? 'image/jpeg' : f.mimetype,
      caption: (captions[i] || '').toString().trim(),
      fileName: f.originalname,
    }));

    const report = await analyzeProgress({
      images, projectName, frequency, periodLabel, visitDate, notes,
    });

    const header = { projectName, frequency, periodLabel, visitDate, imageCount: images.length };
    const markdown = renderMarkdown({ report, header });

    const insert = db.prepare(`
      INSERT INTO progress_reports (
        project_id, frequency, period_label, visit_date, notes, image_count,
        report_json, report_markdown, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, frequency, periodLabel, visitDate, notes, images.length,
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
  let sql = `SELECT id, project_id, frequency, period_label, visit_date, image_count, created_by, created_at
             FROM progress_reports WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const report = JSON.parse(row.report_json);
  const photos = db.prepare(
    'SELECT id, sort_order, file_name, mime_type, caption FROM progress_report_files WHERE report_id=? ORDER BY sort_order ASC'
  ).all(row.id);
  res.json({
    ...row,
    report_json: report,
    report,
    header: {
      projectName: null, frequency: row.frequency, periodLabel: row.period_label,
      visitDate: row.visit_date, imageCount: row.image_count,
    },
    photos,
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = db.prepare('SELECT period_label, report_markdown FROM progress_reports WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stem = (row.period_label || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_');
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Progress_Report_${stem}.md"`);
  res.send(row.report_markdown);
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
