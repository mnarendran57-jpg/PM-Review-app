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
const { uprightJpeg, fitJpeg } = require('../lib/imageOrientation');
const { fillProgressTemplate, templateFor, loadTemplate } = require('../lib/progressCover');
const { renderProgressReportDocx } = require('../lib/progressReportDocx');

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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

    // Turned the right way up before anything looks at it. A phone held sideways writes the
    // pixels in the sensor's orientation and records a tag saying how far round to turn them;
    // the upload box honours that tag, and every consumer downstream of here does not. Doing it
    // once, here, means Claude, the PDF and the Word template all see the same upright photo —
    // and the stored file is upright too, so an old report reprinted later is still right.
    let turned = 0;
    const images = files.map((f, i) => {
      const upright = uprightJpeg(f.buffer);
      if (upright.rotated) turned++;
      return {
        buffer: upright.buffer,
        mediaType: f.mimetype === 'image/jpg' ? 'image/jpeg' : f.mimetype,
        caption: (captions[i] || '').toString().trim(),
        fileName: f.originalname,
      };
    });
    if (turned) console.log(`[progress] ${turned} of ${files.length} photo(s) turned upright`);

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
      INSERT INTO progress_report_files
        (report_id, sort_order, file_name, mime_type, caption, file_key, file_blob, display_key, display_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // The upright bytes, not the ones that were uploaded. Storing the original would mean
      // every reprint of this report had to rotate it again — and the report the PM downloads
      // a month from now would depend on code that could have changed since.
      const bytes = images[i].buffer;
      const { key } = await storage.storeFile('progress', bytes, f.mimetype, f.originalname);

      // And a second copy at the size the report prints it, made once here rather than on every
      // download. Both are kept: the original is what the viewer shows and what a PM would want
      // back if they ever needed the full-resolution picture.
      const display = fitJpeg(bytes);
      const displayStored = display === bytes
        ? { key: null }   // already small enough — no second copy is worth keeping
        : await storage.storeFile('progress', display, f.mimetype, `display_${f.originalname}`);

      insertFile.run(
        reportId, i, f.originalname, f.mimetype, images[i].caption || null,
        key, key ? Buffer.alloc(0) : bytes,
        displayStored.key,
        displayStored.key || display === bytes ? null : display,
      );
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

// The report's photographs, ready to be put into a document.
//
// Already upright — they were turned at upload, see above — and fitted here to roughly the size
// they are actually printed at. Embedding the originals meant a four-photo report came to 11MB and
// a twenty-photo site visit would have been fifty, which most mail servers refuse; the report
// existed but could not be sent, which is the same as not existing. The originals stay untouched
// on the server and are what the photo viewer serves.
//
// Both downloads read their photographs through here, so the PDF and the Word file always contain
// the same pictures at the same size.
async function photosForReport(reportId) {
  const rows = db.prepare(`
    SELECT caption, mime_type, file_key, file_blob, display_key, display_blob
    FROM progress_report_files WHERE report_id=? ORDER BY sort_order ASC
  `).all(reportId);

  const photos = [];
  for (const p of rows) {
    // The copy made at upload, where there is one.
    let buffer = (p.display_key || p.display_blob)
      ? await storage.readFile({ key: p.display_key, blob: p.display_blob })
      : null;

    if (!buffer) {
      // A photo uploaded before display copies existed, or one small enough that no second copy
      // was worth keeping. Fitting it here costs a second or two per photo, once per download,
      // which is the price of not rewriting everybody's stored files behind their back.
      const stored = await storage.readFile({ key: p.file_key, blob: p.file_blob });
      if (!stored) continue;
      buffer = fitJpeg(stored);
    }

    photos.push({ caption: p.caption || '', mimeType: p.mime_type || 'image/jpeg', buffer });
  }
  return photos;
}

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
    const photos = await photosForReport(row.id);

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

// The report as a Word document, always. A site report routinely needs a line changed after the
// walk — a trade named properly, an observation the photographs do not carry — and a PDF cannot
// take one.
//
// Which document it is depends on what is on file. Where the organization has fed Coaster its own
// progress report, or this project has one of its own, that is what comes back: their formatting,
// with this visit written into it. Otherwise it is Coaster's own layout, the same one the PDF uses,
// in a form the PM can edit. Both are offered under one button, because from where the PM stands
// this is simply "the Word version".
router.get('/:id/report.docx', async (req, res) => {
  try {
    const row = visibleReport(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const report = JSON.parse(row.report_json);
    const header = headerFromRow(row);
    if (row.project_id) {
      const proj = db.prepare('SELECT project_name FROM projects WHERE id=?').get(row.project_id);
      header.projectName = proj?.project_name || null;
    }

    const photos = await photosForReport(row.id);

    const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
    const template = await loadTemplate({ projectId: row.project_id, orgId: req.orgId });

    let docx;
    if (template) {
      docx = fillProgressTemplate({
        templateBuffer: template.buffer,
        replacements: template.terms.replacements,
        fields: {
          report_title: `${header.projectName || 'Project'} Progress Report${num}`,
          report_number: header.reportNumber != null ? String(header.reportNumber) : '',
          date: header.visitDate || '',
          time: header.visitTime || '',
          weather: header.weather || '',
          submitted_by: header.submittedBy || '',
          project_name: header.projectName || '',
          contractor: header.contractor || '',
          progress: report.progress || [],
        },
        photos,
      });
    } else {
      const branding = await brandingFor(req.orgId);
      docx = renderProgressReportDocx({
        report, header, photos, companyName: branding.companyName, logo: branding.logo,
      });
    }

    const stem = (header.projectName || 'Progress').replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_Progress_Report${num}.docx"`);
    res.send(docx);
  } catch (err) {
    console.error('Progress report Word error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Whose format the Word download will be in. The button is always shown — this only tells the page
// what to say underneath it, so a PM who has fed Coaster their own report can see that it is the
// one being used, and one who has not can see that there is something to upload.
router.get('/project/:projectId/template', (req, res) => {
  const project = access.projectForUser(req.user, req.params.projectId);
  if (!project || project.org_id !== req.orgId) return res.status(404).json({ error: 'Project not found' });
  const found = templateFor({ projectId: Number(req.params.projectId), orgId: req.orgId });
  res.json(found
    ? { available: true, source: found.source, fileName: found.row.file_name }
    : { available: false, source: null, fileName: null });
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
  // Both copies of every photo. Missing the display copy here would leave an orphan in object
  // storage for every photo ever uploaded — invisible, and billed for indefinitely.
  const keys = db.prepare('SELECT file_key, display_key FROM progress_report_files WHERE report_id=?')
    .all(req.params.id)
    .flatMap(r => [r.file_key, r.display_key])
    .filter(Boolean);
  db.prepare('DELETE FROM progress_reports WHERE id=?').run(req.params.id);
  await storage.remove(keys);
  res.json({ success: true });
});

module.exports = router;
