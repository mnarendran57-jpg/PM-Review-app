const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const access = require('../lib/access');
const storage = require('../lib/storage');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { extractRfi, extractRfiResponse } = require('../lib/rfiExtract');
const { analyzeRfi } = require('../lib/rfiAnalysis');
const {
  RESPONSE_ACTIONS, DISCIPLINES, isReopening, buildLogRow, summarize, dueDateFor,
  toIsoDay, todayUtc,
} = require('../lib/rfiLog');

router.use(requireOrg);
router.use(requireFeature('rfi-log'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 6 },
});

// How long the A/E gets before an RFI counts as overdue. Ten days by convention, and it comes
// from the specifications, so it is a project-wide setting rather than a per-RFI field.
function reviewDays() {
  const row = db.prepare(`SELECT value FROM settings WHERE key='rfi_response_days'`).get();
  const days = parseInt(row?.value ?? '', 10);
  return Number.isFinite(days) && days > 0 ? days : 10;
}

function projectInScope(req, projectId) {
  if (!projectId) return null;
  const project = access.projectForUser(req.user, Number(projectId));
  if (!project || project.org_id !== req.orgId) return null;
  return project;
}

// Loads an RFI only if the caller may see it; otherwise null, which callers turn into a 404
// rather than a 403 so ids cannot be probed.
function visibleRfi(req, id = req.params.id) {
  const row = db.prepare(`SELECT * FROM rfis WHERE id=?`).get(id);
  return access.recordVisible(req.user, row) ? row : null;
}

const revisionsOf = rfiId => db.prepare(
  `SELECT * FROM rfi_revisions WHERE rfi_id=? ORDER BY revision_number ASC`
).all(rfiId);

const filesOf = rfiId => db.prepare(
  `SELECT id, revision_id, kind, file_name, mime_type, created_at
   FROM rfi_files WHERE rfi_id=? ORDER BY id ASC`
).all(rfiId);

// The Shared Documents this RFI is read against. Joined rather than stored as a list of ids,
// so a document removed from the project simply drops out.
const documentsOf = rfiId => db.prepare(`
  SELECT pc.id, pc.file_name, pc.label, pc.doc_type
  FROM rfi_documents rd JOIN project_contracts pc ON pc.id = rd.contract_id
  WHERE rd.rfi_id = ? ORDER BY pc.doc_type ASC, pc.created_at ASC
`).all(rfiId);

const latestAnalysis = rfiId => {
  const row = db.prepare(
    `SELECT * FROM rfi_analyses WHERE rfi_id=? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(rfiId);
  if (!row) return null;
  return {
    ...row,
    analysis: JSON.parse(row.analysis_json),
    sources: JSON.parse(row.sources_json || '[]'),
    analysis_json: undefined,
    sources_json: undefined,
  };
};

function detail(row, options) {
  const log = buildLogRow(row, revisionsOf(row.id), options);
  const files = filesOf(row.id);
  return {
    ...log,
    files,
    documents: documentsOf(row.id),
    analysis: latestAnalysis(row.id),
    revisions: log.revisions.map(rev => ({
      ...rev,
      files: files.filter(f => f.revision_id === rev.id),
    })),
  };
}

const nullable = value => {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text === '' ? null : text;
};

// See the matching helper in routes/submittals.js: the received date defaults to today, which
// is wrong when an RFI is entered after the fact and the sent date is back-dated. An RFI
// cannot be forwarded before it arrived.
function arrivalDates(body) {
  const forwarded = nullable(body.date_forwarded);
  let received = nullable(body.date_received) || toIsoDay(todayUtc());
  if (forwarded && received > forwarded) received = forwarded;
  return { received, forwarded };
}

async function attachFile({ rfiId, revisionId, kind, file }) {
  const { key } = await storage.storeFile('rfis', file.buffer, file.mimetype, file.originalname);
  db.prepare(`
    INSERT INTO rfi_files (rfi_id, revision_id, kind, file_name, mime_type, file_key, file_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(rfiId, revisionId, kind, file.originalname, file.mimetype || null, key, key ? Buffer.alloc(0) : file.buffer);
}

const touch = rfiId => db.prepare(`UPDATE rfis SET updated_at=datetime('now') WHERE id=?`).run(rfiId);

// The Shared Documents chosen for an RFI, replaced wholesale. Ids are checked against the
// RFI's own project so a document from another project cannot be attached.
function setDocuments(rfiId, projectId, rawIds) {
  let ids = rawIds;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { ids = ids.split(',').map(s => s.trim()); }
  }
  if (!Array.isArray(ids)) return;

  db.prepare(`DELETE FROM rfi_documents WHERE rfi_id=?`).run(rfiId);
  const valid = db.prepare(`SELECT id FROM project_contracts WHERE id=? AND project_id=?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO rfi_documents (rfi_id, contract_id) VALUES (?, ?)`);
  for (const raw of ids) {
    const id = Number(raw);
    if (Number.isInteger(id) && valid.get(id, projectId)) insert.run(rfiId, id);
  }
}

// --- Reading the log --------------------------------------------------------------------

router.get('/', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT * FROM rfis WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }

  const options = { reviewDays: reviewDays(), today: todayUtc() };
  const rows = db.prepare(sql).all(...params).map(row => ({
    ...buildLogRow(row, revisionsOf(row.id), options),
    // Only whether a prediction exists — the analysis itself is far too big for a log row.
    hasAnalysis: !!db.prepare(`SELECT 1 FROM rfi_analyses WHERE rfi_id=? LIMIT 1`).get(row.id),
  }));

  rows.sort((a, b) => String(a.rfi_number || '')
    .localeCompare(String(b.rfi_number || ''), undefined, { numeric: true, sensitivity: 'base' }));

  res.json({ rfis: rows, summary: summarize(rows), reviewDays: options.reviewDays, disciplines: DISCIPLINES });
});

const CSV_COLUMNS = [
  ['RFI #', r => r.rfi_number],
  ['Rev', r => r.currentRevision],
  ['Subject', r => r.subject],
  ['Discipline', r => r.discipline],
  ['Submitted By', r => r.submitted_by],
  ['Status', r => r.statusLabel],
  ['Ball in Court', r => r.ballInCourt],
  ['Received', r => r.dateReceived],
  ['Sent to A/E', r => r.dateForwarded],
  ['Response Due', r => r.dueDate],
  ['Returned', r => r.dateReturned],
  ['A/E Disposition', r => r.responseAction],
  ['Responded By', r => r.respondedBy],
  ['Days Overdue', r => r.daysOverdue],
  ['Days With A/E', r => r.daysWithReviewer],
  ['A/E Response', r => r.responseNotes],
  ['Question', r => r.question],
];

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Before "/:id", so "export.csv" is not read as an RFI id.
router.get('/export.csv', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT * FROM rfis WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }

  const options = { reviewDays: reviewDays(), today: todayUtc() };
  const rows = db.prepare(sql).all(...params)
    .map(row => buildLogRow(row, revisionsOf(row.id), options))
    .sort((a, b) => String(a.rfi_number || '')
      .localeCompare(String(b.rfi_number || ''), undefined, { numeric: true, sensitivity: 'base' }));

  const lines = [CSV_COLUMNS.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="RFI_Log.csv"');
  // The BOM is what makes Excel read this as UTF-8 rather than the system codepage.
  res.send(`﻿${lines.join('\r\n')}`);
});

router.get('/:id', (req, res) => {
  const row = visibleRfi(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(detail(row, { reviewDays: reviewDays(), today: todayUtc() }));
});

// --- Entering an RFI ----------------------------------------------------------------------

router.post('/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload the RFI PDF to read.' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF RFIs can be read automatically. Enter this one by hand.' });
    }
    res.json(await extractRfi(req.file.buffer));
  } catch (err) {
    console.error('RFI extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Logs an RFI and its first revision together. The two are always created as a pair: an RFI
// with no revision has no dates and no status, and would render as a permanently blank row.
router.post('/', upload.array('files', 6), async (req, res) => {
  try {
    const project = projectInScope(req, req.body.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const rfiNumber = nullable(req.body.rfi_number);
    const subject = nullable(req.body.subject);
    if (!rfiNumber) return res.status(400).json({ error: 'An RFI number is required.' });
    if (!subject) return res.status(400).json({ error: 'A subject is required.' });

    // A repeated number is either a re-ask — which belongs on the existing entry as a new
    // revision — or a mistake. Creating a second row would hide both.
    const clash = db.prepare(
      `SELECT id FROM rfis WHERE project_id=? AND lower(trim(rfi_number))=lower(trim(?))`
    ).get(project.id, rfiNumber);
    if (clash) {
      return res.status(409).json({
        error: `${rfiNumber} is already in this project's log. If the A/E asked for more information and the contractor has come back, add it as a revision to that entry instead.`,
        existingId: clash.id,
      });
    }

    const discipline = nullable(req.body.discipline);
    const { received: dateReceived, forwarded: dateForwarded } = arrivalDates(req.body);

    const insert = db.prepare(`
      INSERT INTO rfis (org_id, project_id, rfi_number, subject, question, discipline,
        submitted_by, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId, project.id, rfiNumber, subject, nullable(req.body.question),
      DISCIPLINES.includes(discipline) ? discipline : null,
      nullable(req.body.submitted_by), nullable(req.body.notes),
      req.user.name || req.user.email
    );
    const rfiId = insert.lastInsertRowid;

    const revision = db.prepare(`
      INSERT INTO rfi_revisions (rfi_id, revision_number, date_received, date_forwarded, date_response_due)
      VALUES (?, 0, ?, ?, ?)
    `).run(
      rfiId, dateReceived, dateForwarded,
      nullable(req.body.date_response_due) || dueDateFor({ date_forwarded: dateForwarded }, reviewDays())
    );

    setDocuments(rfiId, project.id, req.body.document_ids);

    // The first upload is the RFI itself; anything after it is supporting material the
    // contractor sent with it, which the analysis reads alongside the Shared Documents.
    const files = req.files || [];
    for (const [index, file] of files.entries()) {
      await attachFile({
        rfiId, revisionId: revision.lastInsertRowid,
        kind: index === 0 ? 'rfi' : 'reference', file,
      });
    }

    res.json(detail(db.prepare(`SELECT * FROM rfis WHERE id=?`).get(rfiId),
      { reviewDays: reviewDays(), today: todayUtc() }));
  } catch (err) {
    console.error('RFI create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Identity and the document selection. Dates and the A/E's answer belong to a revision and
// are edited there, so a correction cannot land on the wrong round trip.
router.patch('/:id', (req, res) => {
  const row = visibleRfi(req);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const keep = (key, current) => (key in req.body ? nullable(req.body[key]) : current);
  const discipline = keep('discipline', row.discipline);

  db.prepare(`
    UPDATE rfis SET rfi_number=?, subject=?, question=?, discipline=?, submitted_by=?,
      notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    nullable(req.body.rfi_number) ?? row.rfi_number,
    nullable(req.body.subject) ?? row.subject,
    keep('question', row.question),
    DISCIPLINES.includes(discipline) ? discipline : null,
    keep('submitted_by', row.submitted_by),
    keep('notes', row.notes),
    row.id
  );

  if ('document_ids' in req.body) setDocuments(row.id, row.project_id, req.body.document_ids);

  res.json(detail(db.prepare(`SELECT * FROM rfis WHERE id=?`).get(row.id),
    { reviewDays: reviewDays(), today: todayUtc() }));
});

router.delete('/:id', async (req, res) => {
  const row = visibleRfi(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare(`SELECT file_key FROM rfi_files WHERE rfi_id=? AND file_key IS NOT NULL`)
    .all(row.id).map(r => r.file_key);
  db.prepare(`DELETE FROM rfis WHERE id=?`).run(row.id);
  await storage.remove(keys);
  res.json({ success: true });
});

// --- Revisions ----------------------------------------------------------------------------

function visibleRevision(req) {
  const rfi = visibleRfi(req);
  if (!rfi) return {};
  const revision = db.prepare(`SELECT * FROM rfi_revisions WHERE id=? AND rfi_id=?`)
    .get(req.params.revId, rfi.id);
  return { rfi, revision: revision || null };
}

// A re-ask: the A/E wanted more information and the contractor has come back. It becomes the
// next revision of the same entry, so the log keeps one line per RFI.
router.post('/:id/revisions', upload.array('files', 6), async (req, res) => {
  try {
    const rfi = visibleRfi(req);
    if (!rfi) return res.status(404).json({ error: 'Not found' });

    const existing = revisionsOf(rfi.id);
    const current = existing[existing.length - 1];
    if (current && !current.response_action) {
      return res.status(409).json({
        error: 'This RFI is still out for response. Record the A/E\'s reply on the current revision first, then add the follow-up.',
      });
    }

    const { received: dateReceived, forwarded: dateForwarded } = arrivalDates(req.body);
    const revision = db.prepare(`
      INSERT INTO rfi_revisions (rfi_id, revision_number, date_received, date_forwarded, date_response_due)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      rfi.id, (current?.revision_number ?? -1) + 1, dateReceived, dateForwarded,
      nullable(req.body.date_response_due) || dueDateFor({ date_forwarded: dateForwarded }, reviewDays())
    );

    for (const [index, file] of (req.files || []).entries()) {
      await attachFile({
        rfiId: rfi.id, revisionId: revision.lastInsertRowid,
        kind: index === 0 ? 'rfi' : 'reference', file,
      });
    }
    touch(rfi.id);

    res.json(detail(rfi, { reviewDays: reviewDays(), today: todayUtc() }));
  } catch (err) {
    console.error('RFI revision error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/revisions/:revId', (req, res) => {
  const { rfi, revision } = visibleRevision(req);
  if (!rfi || !revision) return res.status(404).json({ error: 'Not found' });

  const pick = (key, fallback) => (key in req.body ? nullable(req.body[key]) : fallback);
  const dateForwarded = pick('date_forwarded', revision.date_forwarded);
  const due = 'date_response_due' in req.body && nullable(req.body.date_response_due)
    ? nullable(req.body.date_response_due)
    : dueDateFor({ date_forwarded: dateForwarded }, reviewDays()) || revision.date_response_due;

  db.prepare(`
    UPDATE rfi_revisions SET date_received=?, date_forwarded=?, date_response_due=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(pick('date_received', revision.date_received), dateForwarded, due, revision.id);

  touch(rfi.id);
  res.json(detail(rfi, { reviewDays: reviewDays(), today: todayUtc() }));
});

// Reads the A/E's written response so the form opens pre-filled. Saves nothing.
router.post('/:id/revisions/:revId/extract-response', upload.single('file'), async (req, res) => {
  try {
    const { rfi, revision } = visibleRevision(req);
    if (!rfi || !revision) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'Upload the A/E\'s response to read.' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDFs can be read automatically. Enter the response by hand.' });
    }
    res.json(await extractRfiResponse(req.file.buffer));
  } catch (err) {
    console.error('RFI response extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Records the A/E's answer, which closes the round trip and moves the RFI out of "With A/E".
router.post('/:id/revisions/:revId/response', upload.single('file'), async (req, res) => {
  try {
    const { rfi, revision } = visibleRevision(req);
    if (!rfi || !revision) return res.status(404).json({ error: 'Not found' });

    const action = nullable(req.body.response_action);
    if (!RESPONSE_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Choose how the A/E answered: ${RESPONSE_ACTIONS.join(', ')}.` });
    }

    const dateReturned = nullable(req.body.date_returned) || toIsoDay(todayUtc());
    // A response implies it was sent. Backfilling a missing forward date keeps the revision
    // from reading as answered but never issued, with a blank turnaround.
    const dateForwarded = revision.date_forwarded || nullable(req.body.date_forwarded) || revision.date_received;

    db.prepare(`
      UPDATE rfi_revisions SET response_action=?, responded_by=?, response_notes=?,
        date_returned=?, date_forwarded=?, date_response_due=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      action, nullable(req.body.responded_by), nullable(req.body.response_notes), dateReturned,
      dateForwarded,
      revision.date_response_due || dueDateFor({ date_forwarded: dateForwarded }, reviewDays()),
      revision.id
    );

    if (req.file) {
      await attachFile({ rfiId: rfi.id, revisionId: revision.id, kind: 'response', file: req.file });
    }
    touch(rfi.id);

    const record = detail(rfi, { reviewDays: reviewDays(), today: todayUtc() });
    res.json({
      ...record,
      nextStep: isReopening(action)
        ? 'The A/E needs more information. Waiting on the contractor to come back — add that as a new revision when it arrives.'
        : 'This RFI is closed. No further action is needed.',
    });
  } catch (err) {
    console.error('RFI response error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- The predicted answer -------------------------------------------------------------------

// Reads the RFI against the selected documents and suggests how the A/E is likely to answer.
// Deliberately on demand rather than on upload: a drawing set costs a real share of the
// per-minute token allowance, and entering several RFIs in a row would otherwise fail.
//
// Nothing here touches the log. The prediction is for the PM's understanding, and is stored
// separately so it can never be mistaken for the A/E's actual answer.
router.post('/:id/analysis', upload.array('files', 4), async (req, res) => {
  try {
    const rfi = visibleRfi(req);
    if (!rfi) return res.status(404).json({ error: 'Not found' });

    // A discipline sent with the request is treated as a correction and saved, so re-running
    // after changing it does not silently revert next time.
    const requested = nullable(req.body.discipline);
    const discipline = DISCIPLINES.includes(requested) ? requested : rfi.discipline;
    if (!discipline) {
      return res.status(400).json({
        error: `Choose what the RFI is about first (${DISCIPLINES.join(', ')}) — it decides which drawings are read.`,
      });
    }
    if (requested && requested !== rfi.discipline) {
      db.prepare(`UPDATE rfis SET discipline=?, updated_at=datetime('now') WHERE id=?`).run(discipline, rfi.id);
    }
    if ('document_ids' in req.body) setDocuments(rfi.id, rfi.project_id, req.body.document_ids);

    const chosen = db.prepare(`
      SELECT pc.id, pc.file_name, pc.label, pc.doc_type, pc.file_key, pc.file_blob
      FROM rfi_documents rd JOIN project_contracts pc ON pc.id = rd.contract_id
      WHERE rd.rfi_id = ?
    `).all(rfi.id);

    const documents = [];
    for (const doc of chosen) {
      const buffer = await storage.readFile({ key: doc.file_key, blob: doc.file_blob });
      if (buffer) {
        documents.push({
          label: (doc.label || '').trim() || doc.file_name,
          doc_type: doc.doc_type,
          buffer,
        });
      }
    }

    // The RFI's own attachments travel with it: a marked-up sketch from the contractor is
    // often what the question is really about.
    const extraFiles = [];
    for (const file of req.files || []) {
      extraFiles.push({ label: file.originalname, buffer: file.buffer });
    }
    if (extraFiles.length === 0) {
      const stored = db.prepare(
        `SELECT file_name, file_key, file_blob FROM rfi_files WHERE rfi_id=? AND kind='rfi' ORDER BY id DESC LIMIT 1`
      ).get(rfi.id);
      if (stored) {
        const buffer = await storage.readFile({ key: stored.file_key, blob: stored.file_blob });
        if (buffer) extraFiles.push({ label: stored.file_name, buffer });
      }
    }

    if (documents.length === 0 && extraFiles.length === 0) {
      return res.status(400).json({
        error: 'Choose at least one of the project\'s shared documents for this RFI to be read against, or attach one to the RFI.',
      });
    }

    const { analysis, sources, markdown } = await analyzeRfi({ rfi, discipline, documents, extraFiles });

    const revisions = revisionsOf(rfi.id);
    const current = revisions[revisions.length - 1];
    const saved = db.prepare(`
      INSERT INTO rfi_analyses (rfi_id, revision_id, discipline, sources_json, analysis_json,
        analysis_markdown, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      rfi.id, current?.id || null, discipline, JSON.stringify(sources),
      JSON.stringify(analysis), markdown, req.user.name || req.user.email
    );

    res.json({
      id: saved.lastInsertRowid, discipline, analysis, sources, analysis_markdown: markdown,
    });
  } catch (err) {
    console.error('RFI analysis error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

router.get('/:id/analysis.md', (req, res) => {
  const rfi = visibleRfi(req);
  if (!rfi) return res.status(404).json({ error: 'Not found' });
  const found = latestAnalysis(rfi.id);
  if (!found) return res.status(404).json({ error: 'No analysis has been run for this RFI yet.' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${String(rfi.rfi_number).replace(/[^a-z0-9-]+/gi, '_')}_suggested_answer.md"`);
  res.send(found.analysis_markdown || '');
});

// --- Attachments ----------------------------------------------------------------------------

router.get('/:id/files/:fileId', async (req, res) => {
  if (!visibleRfi(req)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(
    `SELECT file_name, mime_type, file_key, file_blob FROM rfi_files WHERE id=? AND rfi_id=?`
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
  res.send(bytes);
});

module.exports = router;
