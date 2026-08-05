const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const access = require('../lib/access');
const storage = require('../lib/storage');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { extractSubmittal, extractResponse } = require('../lib/submittalExtract');
const {
  REVIEW_ACTIONS, isReopening, buildLogRow, summarize, dueDateFor, toIsoDay, todayUtc,
} = require('../lib/submittalLog');

// Same scoping as every other tool: one organization, and within it only the projects the
// caller is actually on. Applied to the whole router so no endpoint can be added without it.
router.use(requireOrg);
router.use(requireFeature('submittal-log'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

// How long the A/E gets before a submittal counts as overdue. A project-wide setting rather
// than a per-submittal field, because it comes from the specifications and is the same for
// every submittal on the job.
function reviewDays() {
  const row = db.prepare(`SELECT value FROM settings WHERE key='submittal_review_days'`).get();
  const days = parseInt(row?.value ?? '', 10);
  return Number.isFinite(days) && days > 0 ? days : 14;
}

// Confirms the project is one the caller may write to, rather than trusting the id in the
// request — otherwise a submittal could be filed into another organization's project.
function projectInScope(req, projectId) {
  if (!projectId) return null;
  const project = access.projectForUser(req.user, Number(projectId));
  if (!project || project.org_id !== req.orgId) return null;
  return project;
}

// Loads a submittal only if the caller may see it; otherwise null, which every caller turns
// into a 404 rather than a 403 so ids cannot be probed for existence.
function visibleSubmittal(req, id = req.params.id) {
  const row = db.prepare(`SELECT * FROM submittals WHERE id=?`).get(id);
  return access.recordVisible(req.user, row) ? row : null;
}

const revisionsOf = submittalId => db.prepare(
  `SELECT * FROM submittal_revisions WHERE submittal_id=? ORDER BY revision_number ASC`
).all(submittalId);

const filesOf = submittalId => db.prepare(
  `SELECT id, revision_id, kind, file_name, mime_type, created_at
   FROM submittal_files WHERE submittal_id=? ORDER BY id ASC`
).all(submittalId);

// The full record as every screen wants it: identity, derived status, revision history, and
// the paperwork attached to each round trip.
function detail(row, options) {
  const log = buildLogRow(row, revisionsOf(row.id), options);
  const files = filesOf(row.id);
  return {
    ...log,
    files,
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

async function attachFile({ submittalId, revisionId, kind, file }) {
  const { key } = await storage.storeFile('submittals', file.buffer, file.mimetype, file.originalname);
  db.prepare(`
    INSERT INTO submittal_files (submittal_id, revision_id, kind, file_name, mime_type, file_key, file_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(submittalId, revisionId, kind, file.originalname, file.mimetype || null, key, key ? Buffer.alloc(0) : file.buffer);
}

const touch = submittalId =>
  db.prepare(`UPDATE submittals SET updated_at=datetime('now') WHERE id=?`).run(submittalId);

// The received date defaults to today, which is right when a submittal is logged as it
// arrives but wrong when one is entered after the fact — the PM back-dates the day it went
// to the A/E and the entry then claims to have been received after it was sent. A submittal
// cannot be forwarded before it arrived, so the received date is pulled back to match.
// ISO dates compare correctly as strings, so no parsing is needed.
function arrivalDates(body) {
  const forwarded = nullable(body.date_forwarded);
  let received = nullable(body.date_received) || toIsoDay(todayUtc());
  if (forwarded && received > forwarded) received = forwarded;
  return { received, forwarded };
}

// --- Reading the log --------------------------------------------------------------------

// The log itself. Ordered by submittal number the way a register reads, and returned with
// its counts so the page never recomputes them differently from the export.
router.get('/', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT * FROM submittals WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }

  const options = { reviewDays: reviewDays(), today: todayUtc() };
  const rows = db.prepare(sql).all(...params)
    .map(row => buildLogRow(row, revisionsOf(row.id), options));

  // Natural-ish ordering: "S-2" before "S-10", which a plain string sort gets wrong and a
  // submittal register is always read in.
  rows.sort((a, b) => String(a.submittal_number || '')
    .localeCompare(String(b.submittal_number || ''), undefined, { numeric: true, sensitivity: 'base' }));

  res.json({ submittals: rows, summary: summarize(rows), reviewDays: options.reviewDays });
});

const CSV_COLUMNS = [
  ['Submittal #', r => r.submittal_number],
  ['Rev', r => r.currentRevision],
  ['Spec Section', r => r.spec_section],
  ['Description', r => r.description],
  ['Vendor', r => r.vendor],
  ['Type', r => r.submittal_type],
  ['Status', r => r.statusLabel],
  ['Ball in Court', r => r.ballInCourt],
  ['Received', r => r.dateReceived],
  ['Sent to A/E', r => r.dateForwarded],
  ['Response Due', r => r.dueDate],
  ['Returned', r => r.dateReturned],
  ['A/E Action', r => r.reviewAction],
  ['Reviewed By', r => r.reviewedBy],
  ['Days Overdue', r => r.daysOverdue],
  ['Days With A/E', r => r.daysWithReviewer],
  ['Response', r => r.responseNotes],
  ['Notes', r => r.notes],
];

// A value is quoted whenever a comma, quote or newline would otherwise break the row —
// review comments routinely contain all three.
function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Defined before "/:id" so "export.csv" is not read as a submittal id.
router.get('/export.csv', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT * FROM submittals WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }

  const options = { reviewDays: reviewDays(), today: todayUtc() };
  const rows = db.prepare(sql).all(...params)
    .map(row => buildLogRow(row, revisionsOf(row.id), options))
    .sort((a, b) => String(a.submittal_number || '')
      .localeCompare(String(b.submittal_number || ''), undefined, { numeric: true, sensitivity: 'base' }));

  const lines = [CSV_COLUMNS.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Submittal_Log.csv"');
  // Excel ignores the charset above and falls back to the system codepage unless the file
  // opens with a byte-order mark, which turns every em-dash in a spec section or a set of
  // A/E comments into mojibake. The BOM is what makes the export open correctly.
  res.send(`﻿${lines.join('\r\n')}`);
});

router.get('/:id', (req, res) => {
  const row = visibleSubmittal(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(detail(row, { reviewDays: reviewDays(), today: todayUtc() }));
});

// --- Entering a new submittal -----------------------------------------------------------

// Reads an uploaded submittal so the entry form opens pre-filled. Saves nothing: the PM
// confirms or corrects every field, then posts it back to "/".
router.post('/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload the submittal PDF to read.' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF submittals can be read automatically. Enter this one by hand.' });
    }
    res.json(await extractSubmittal(req.file.buffer));
  } catch (err) {
    console.error('Submittal extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Enters a submittal into the log, creating its first revision at the same time. The two are
// always created together: a submittal with no revision has no dates and no status, and
// would render as a permanently blank row.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const project = projectInScope(req, req.body.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const submittalNumber = nullable(req.body.submittal_number);
    const description = nullable(req.body.description);
    if (!submittalNumber) return res.status(400).json({ error: 'A submittal number is required.' });
    if (!description) return res.status(400).json({ error: 'A description is required.' });

    // Duplicate numbers are refused rather than merged. On a real job the same number coming
    // in twice is either a resubmittal — which belongs on the existing entry as a new
    // revision — or a mistake, and silently creating a second row hides both.
    const clash = db.prepare(
      `SELECT id FROM submittals WHERE project_id=? AND lower(trim(submittal_number))=lower(trim(?))`
    ).get(project.id, submittalNumber);
    if (clash) {
      return res.status(409).json({
        error: `Submittal ${submittalNumber} is already in this project's log. If the contractor has sent it back after an A/E review, add it as a revision to that entry instead.`,
        existingId: clash.id,
      });
    }

    const revisionNumber = Number.parseInt(req.body.revision_number, 10);
    const { received: dateReceived, forwarded: dateForwarded } = arrivalDates(req.body);

    const insert = db.prepare(`
      INSERT INTO submittals (org_id, project_id, submittal_number, spec_section, description,
        vendor, submittal_type, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId, project.id, submittalNumber, nullable(req.body.spec_section), description,
      nullable(req.body.vendor), nullable(req.body.submittal_type), nullable(req.body.notes),
      req.user.name || req.user.email
    );
    const submittalId = insert.lastInsertRowid;

    const revision = db.prepare(`
      INSERT INTO submittal_revisions (submittal_id, revision_number, date_received,
        date_forwarded, date_response_due)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      submittalId,
      Number.isFinite(revisionNumber) && revisionNumber >= 0 ? revisionNumber : 0,
      dateReceived, dateForwarded,
      nullable(req.body.date_response_due) || dueDateFor({ date_forwarded: dateForwarded }, reviewDays())
    );

    if (req.file) {
      await attachFile({
        submittalId, revisionId: revision.lastInsertRowid, kind: 'submittal', file: req.file,
      });
    }

    res.json(detail(
      db.prepare(`SELECT * FROM submittals WHERE id=?`).get(submittalId),
      { reviewDays: reviewDays(), today: todayUtc() }
    ));
  } catch (err) {
    console.error('Submittal create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Identity only. The dates and the A/E's answer belong to a revision and are edited there,
// so that a correction can never be applied to the wrong round trip.
router.patch('/:id', (req, res) => {
  const row = visibleSubmittal(req);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const fields = {
    submittal_number: nullable(req.body.submittal_number) ?? row.submittal_number,
    spec_section: 'spec_section' in req.body ? nullable(req.body.spec_section) : row.spec_section,
    description: nullable(req.body.description) ?? row.description,
    vendor: 'vendor' in req.body ? nullable(req.body.vendor) : row.vendor,
    submittal_type: 'submittal_type' in req.body ? nullable(req.body.submittal_type) : row.submittal_type,
    notes: 'notes' in req.body ? nullable(req.body.notes) : row.notes,
  };

  db.prepare(`
    UPDATE submittals SET submittal_number=?, spec_section=?, description=?, vendor=?,
      submittal_type=?, notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    fields.submittal_number, fields.spec_section, fields.description, fields.vendor,
    fields.submittal_type, fields.notes, row.id
  );

  res.json(detail(db.prepare(`SELECT * FROM submittals WHERE id=?`).get(row.id),
    { reviewDays: reviewDays(), today: todayUtc() }));
});

router.delete('/:id', async (req, res) => {
  const row = visibleSubmittal(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare(`SELECT file_key FROM submittal_files WHERE submittal_id=? AND file_key IS NOT NULL`)
    .all(row.id).map(r => r.file_key);
  // Revisions and files are removed by the cascade on their foreign keys.
  db.prepare(`DELETE FROM submittals WHERE id=?`).run(row.id);
  await storage.remove(keys);
  res.json({ success: true });
});

// --- Revisions --------------------------------------------------------------------------

function visibleRevision(req) {
  const submittal = visibleSubmittal(req);
  if (!submittal) return {};
  const revision = db.prepare(`SELECT * FROM submittal_revisions WHERE id=? AND submittal_id=?`)
    .get(req.params.revId, submittal.id);
  return { submittal, revision: revision || null };
}

// A resubmittal: the contractor has sent the package back after the A/E asked for changes.
// It becomes the next revision of the same log entry rather than a new entry, so the log
// keeps one line per submittal with its full history behind it.
router.post('/:id/revisions', upload.single('file'), async (req, res) => {
  try {
    const submittal = visibleSubmittal(req);
    if (!submittal) return res.status(404).json({ error: 'Not found' });

    const existing = revisionsOf(submittal.id);
    const current = existing[existing.length - 1];
    // Refused while the current round trip is still open, because two open revisions would
    // leave the log unable to say what the submittal is waiting on.
    if (current && !current.review_action) {
      return res.status(409).json({
        error: 'This submittal is still out for review. Record the A/E\'s response on the current revision first, then add the resubmittal.',
      });
    }

    const { received: dateReceived, forwarded: dateForwarded } = arrivalDates(req.body);
    const revision = db.prepare(`
      INSERT INTO submittal_revisions (submittal_id, revision_number, date_received,
        date_forwarded, date_response_due)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      submittal.id,
      (current?.revision_number ?? -1) + 1,
      dateReceived, dateForwarded,
      nullable(req.body.date_response_due) || dueDateFor({ date_forwarded: dateForwarded }, reviewDays())
    );

    if (req.file) {
      await attachFile({
        submittalId: submittal.id, revisionId: revision.lastInsertRowid, kind: 'submittal', file: req.file,
      });
    }
    touch(submittal.id);

    res.json(detail(submittal, { reviewDays: reviewDays(), today: todayUtc() }));
  } catch (err) {
    console.error('Submittal revision error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dates on one round trip — sending it to the A/E, or correcting a date entered wrongly.
router.patch('/:id/revisions/:revId', (req, res) => {
  const { submittal, revision } = visibleRevision(req);
  if (!submittal || !revision) return res.status(404).json({ error: 'Not found' });

  // Only fields actually sent are changed — an omitted key keeps what is on file, so a form
  // that submits one date cannot blank out the others.
  const pick = (key, fallback) => (key in req.body ? nullable(req.body[key]) : fallback);
  const dateForwarded = pick('date_forwarded', revision.date_forwarded);
  // Sending it to the A/E is what starts the clock, so the deadline follows the forward date
  // unless one was typed in explicitly.
  const due = 'date_response_due' in req.body && nullable(req.body.date_response_due)
    ? nullable(req.body.date_response_due)
    : dueDateFor({ date_forwarded: dateForwarded }, reviewDays()) || revision.date_response_due;

  db.prepare(`
    UPDATE submittal_revisions SET date_received=?, date_forwarded=?, date_response_due=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(pick('date_received', revision.date_received), dateForwarded, due, revision.id);

  touch(submittal.id);
  res.json(detail(submittal, { reviewDays: reviewDays(), today: todayUtc() }));
});

// Reads the A/E's stamp off a returned document so the response form opens pre-filled.
// Saves nothing — the action is a suggestion the PM confirms, because a misread stamp would
// either close a live submittal or hold a finished one open.
router.post('/:id/revisions/:revId/extract-response', upload.single('file'), async (req, res) => {
  try {
    const { submittal, revision } = visibleRevision(req);
    if (!submittal || !revision) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'Upload the returned document to read.' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDFs can be read automatically. Enter the response by hand.' });
    }
    res.json(await extractResponse(req.file.buffer));
  } catch (err) {
    console.error('Submittal response extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Records the A/E's answer, which is what closes the round trip. This is the step that moves
// the submittal out of "With A/E" — to closed, or to awaiting a resubmittal.
router.post('/:id/revisions/:revId/response', upload.single('file'), async (req, res) => {
  try {
    const { submittal, revision } = visibleRevision(req);
    if (!submittal || !revision) return res.status(404).json({ error: 'Not found' });

    const action = nullable(req.body.review_action);
    if (!REVIEW_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: `Choose what the A/E returned it as: ${REVIEW_ACTIONS.join(', ')}.`,
      });
    }

    const dateReturned = nullable(req.body.date_returned) || toIsoDay(todayUtc());
    // A response implies it was sent, so a missing forward date is backfilled to the day it
    // was received. Without this the revision would read as answered but never sent, and its
    // turnaround time would be blank.
    const dateForwarded = revision.date_forwarded || nullable(req.body.date_forwarded) || revision.date_received;

    db.prepare(`
      UPDATE submittal_revisions SET review_action=?, reviewed_by=?, response_notes=?,
        date_returned=?, date_forwarded=?, date_response_due=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      action, nullable(req.body.reviewed_by), nullable(req.body.response_notes), dateReturned,
      dateForwarded,
      revision.date_response_due || dueDateFor({ date_forwarded: dateForwarded }, reviewDays()),
      revision.id
    );

    if (req.file) {
      await attachFile({ submittalId: submittal.id, revisionId: revision.id, kind: 'response', file: req.file });
    }
    touch(submittal.id);

    const record = detail(submittal, { reviewDays: reviewDays(), today: todayUtc() });
    res.json({
      ...record,
      // The log's next step follows from the answer, so it is stated here rather than left
      // for the page to re-derive from the action.
      nextStep: isReopening(action)
        ? 'Waiting on the contractor to resubmit. Add the resubmittal as a new revision when it arrives.'
        : 'This submittal is closed. No further action is needed.',
    });
  } catch (err) {
    console.error('Submittal response error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Attachments --------------------------------------------------------------------------

router.get('/:id/files/:fileId', async (req, res) => {
  if (!visibleSubmittal(req)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(
    `SELECT file_name, mime_type, file_key, file_blob FROM submittal_files WHERE id=? AND submittal_id=?`
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
  res.send(bytes);
});

module.exports = router;
