const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const jobs = require('../lib/jobs');
const storage = require('../lib/storage');
const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { extractEstimate, workLines, selectLines, proposalContext } = require('../lib/veExtract');
const { buildOptions } = require('../lib/veOptions');
const { buildVeReport } = require('../lib/veReport');
const { renderVeReportPdf } = require('../lib/veReportPdf');

router.use(requireOrg);
router.use(requireFeature('ve-analyzer'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM ve_analyses WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

// The stored record, rebuilt into the shapes the page and the documents want. Kept in one place so
// the list, the detail view, the markdown and the PDF cannot drift apart.
function recordView(row) {
  const entries = JSON.parse(row.entries_json);
  const header = {
    projectName: row.project_name,
    estimateTitle: row.estimate_title,
    contractor: row.contractor,
    estimateDate: row.estimate_date,
    estimateTotal: row.estimate_total,
    location: row.location,
    // What share of the estimate's work value the examined rows account for. The report says this
    // out loud rather than implying it looked at everything.
    coverage: row.coverage,
    workLineCount: row.line_count,
    // Where the upload was a proposal rather than a bare estimate: the alternates the contractor
    // priced themselves, and the conditions attached to the price. Derived from the stored
    // extraction rather than kept in its own column, so a record written before this existed simply
    // comes back with nothing here instead of needing a backfill.
    proposal: proposalContext(safeParse(row.extracted_data)),
  };
  return { header, entries, report: buildVeReport({ header, entries }) };
}

// A record whose extraction cannot be read must still open. Losing the proposal context is a
// degraded report; throwing here would be no report at all.
function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

const safeName = s => String(s || 'estimate').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);

// Read the estimate, work its costliest lines, and save the result.
//
// The whole thing runs as a job rather than on this request. Reading a two-hundred-line estimate and
// then writing several paragraphs of prose about twenty-five of its rows is minutes of work, and
// every proxy between the browser and this server would have had a vote on whether it was allowed to
// finish. See lib/jobs.js — this is the same reason the pay application reader moved off the
// request, and the same rule applies here: how big the estimate is must never decide whether the
// feature works.
router.post('/', upload.single('estimate_file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'A cost estimate PDF is required' });
  if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'The estimate must be a PDF' });

  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  const projectName = req.body.project_name || null;
  const orgId = req.orgId;
  const createdBy = req.body.created_by || req.user?.name || null;

  const jobId = jobs.start(
    { orgId, userId: req.user.id, kind: 've-analyze' },
    () => analyze({ file, projectId, projectName, orgId, createdBy }),
  );
  res.status(202).json({ jobId });
});

async function analyze({ file, projectId, projectName, orgId, createdBy }) {
  try {
    const extracted = await extractEstimate(file.buffer);
    const allWork = workLines(extracted);

    if (allWork.length === 0) {
      // Said plainly rather than saved as an empty analysis. An estimate that read as nothing but
      // subtotals is almost always a scan with no text worth reading, and telling the PM that is
      // far more use than a report with no rows in it.
      const err = new Error('No priced line items could be read from the base price of this '
        + 'document. If it is a scan, a version exported from the estimating software will read far '
        + 'better. If everything on it is an alternate or a unit price, there is no base scope to '
        + 'look for options in.');
      err.friendlyMessage = err.message;
      throw err;
    }

    // Which rows are worth arguing about is decided from the estimate, not asked of the PM.
    const selection = selectLines(extracted);
    // Where the building is comes off the estimate too. It is the one piece of context that
    // reliably changes the answer — ordinary cladding in Houston is not ordinary cladding in
    // Anchorage — and it is almost always printed on the document, so nobody needs to type it.
    const location = extracted.projectLocation || null;

    const entries = await buildOptions(selection.lines, {
      estimateTitle: extracted.estimateTitle,
      contractor: extracted.contractor,
      location,
      // Empty on a bare estimate, and the prompt simply omits those sections. On a proposal it
      // carries the alternates the contractor already priced, what they excluded, what the price
      // assumes, and what the written scope actually specified.
      proposal: proposalContext(extracted),
    });

    const key = (await storage.storeFile('ve', file.buffer, file.mimetype, file.originalname)).key;
    const optionCount = entries.reduce((n, e) => n + e.options.length, 0);

    const insert = db.prepare(`
      INSERT INTO ve_analyses (
        org_id, project_id, project_name, estimate_title, contractor, estimate_date,
        estimate_total, location, line_count, worked_count, option_count, coverage,
        extracted_data, entries_json,
        estimate_file_name, estimate_file, estimate_file_key, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, projectId, projectName,
      extracted.estimateTitle || null,
      extracted.contractor || null,
      extracted.estimateDate || null,
      typeof extracted.estimateTotal === 'number' ? extracted.estimateTotal : null,
      location,
      allWork.length, entries.length, optionCount, selection.coverage,
      JSON.stringify(extracted), JSON.stringify(entries),
      file.originalname, key ? Buffer.alloc(0) : file.buffer, key,
      createdBy,
    );

    const row = db.prepare(`SELECT * FROM ve_analyses WHERE id=?`).get(insert.lastInsertRowid);
    // The same shape GET /:id returns, so the page does not have to tell a fresh analysis apart
    // from a reopened one — including the file name, which the "Estimate" download button uses.
    return { id: row.id, estimate_file_name: row.estimate_file_name, ...recordView(row) };
  } catch (err) {
    console.error('VE analyze error:', err);
    err.friendlyMessage = err.friendlyMessage || friendlyAiError(err);
    throw err;
  }
}

router.get('/jobs/:id', (req, res) => {
  const row = jobs.get(req.params.id, { orgId: req.orgId, userId: req.user.id });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== jobs.RUNNING) jobs.sweep();
  res.json(jobs.view(row));
});

router.get('/', (req, res) => {
  const { project_id, search } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_id, project_name, estimate_title, contractor, estimate_date,
             estimate_total, location, line_count, worked_count, option_count,
             estimate_file_name, created_by, created_at, updated_at
             FROM ve_analyses WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) {
    sql += ' AND (estimate_title LIKE ? OR contractor LIKE ? OR project_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    estimate_file: undefined,
    extracted_data: undefined,
    entries_json: undefined,
    ...recordView(row),
  });
});

// The project manager's keep/drop decisions.
//
// Sent as a map of option id to boolean, and applied by walking the stored entries rather than by
// replacing them: the page only ever sends decisions, never the analysis itself, so nothing the
// model wrote can be altered on its way back through the browser.
router.put('/:id/options', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const decisions = req.body?.kept;
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    return res.status(400).json({ error: 'Expected a map of option id to true or false.' });
  }

  const entries = JSON.parse(row.entries_json).map(entry => ({
    ...entry,
    options: entry.options.map(option => (
      Object.prototype.hasOwnProperty.call(decisions, option.id)
        ? { ...option, kept: decisions[option.id] !== false }
        : option
    )),
  }));

  const optionCount = entries.reduce((n, e) => n + e.options.filter(o => o.kept !== false).length, 0);
  db.prepare(`UPDATE ve_analyses SET entries_json=?, option_count=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(entries), optionCount, row.id);

  const updated = db.prepare(`SELECT * FROM ve_analyses WHERE id=?`).get(row.id);
  res.json({ id: updated.id, estimate_file_name: updated.estimate_file_name, ...recordView(updated) });
});

router.get('/:id/report.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const { report } = recordView(row);
    const pdf = await renderVeReportPdf({ report });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="Options_${safeName(row.project_name || row.estimate_title)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('VE report PDF error:', err);
    res.status(500).json({ error: 'The report could not be produced.' });
  }
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition',
    `attachment; filename="Options_${safeName(row.project_name || row.estimate_title)}.md"`);
  res.send(recordView(row).report.markdown);
});

router.get('/:id/original.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.estimate_file_key, blob: row.estimate_file });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.estimate_file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ve_analyses WHERE id=?').run(row.id);
  await storage.remove([row.estimate_file_key]);
  res.json({ success: true });
});

module.exports = router;
