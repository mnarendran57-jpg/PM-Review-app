const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const access = require('../lib/access');
const storage = require('../lib/storage');
const { analyzeSubmittal } = require('../lib/submittalAnalysis');
const { compareToReview } = require('../lib/submittalComparison');
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

// The review takes the contractor's package and, optionally, the specification the PM has to
// hand. That is two fields at once, and multer counts `files` across the WHOLE request rather
// than per field — so the single-file limit above would reject the second upload with "Too many
// files" no matter which field it arrived on.
const uploadForAnalysis = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 8 },
});

// How long the A/E gets before this counts as overdue.
//
// It comes from the PROJECT's specification, so it is a project field first. Two specifications
// on two jobs routinely disagree, and a single organization-wide number quietly applied the wrong
// deadline to one of them. Falling back in order: the project, the organization's default, then
// the convention — never to zero, which would mark everything overdue the day it was logged.
function reviewDays(projectId) {
  if (projectId) {
    const project = db.prepare(`SELECT submittal_review_days AS days FROM projects WHERE id=?`).get(projectId);
    const own = parseInt(project?.days ?? '', 10);
    if (Number.isFinite(own) && own > 0) return own;
  }
  const row = db.prepare(`SELECT value FROM settings WHERE key='submittal_review_days'`).get();
  const days = parseInt(row?.value ?? '', 10);
  return Number.isFinite(days) && days > 0 ? days : 14;
}

// The options every log row is built with, resolved from the row's own project.
const optionsFor = row => ({ reviewDays: reviewDays(row?.project_id), today: todayUtc() });

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
  // The newest revision's id. The submittal log row carries the revision NUMBER but not its
  // id — unlike the RFI log — so it is taken from the revisions themselves rather than assumed
  // to be there. Getting this wrong silently returned no comparison at all: the row was stored
  // correctly and simply never looked up.
  const currentRevisionId = log.revisions[log.revisions.length - 1]?.id || null;
  return {
    ...log,
    files,
    currentRevisionId,
    documents: documentsOf(row.id),
    analysis: latestAnalysis(row.id),
    reviewComparison: reviewForRevision(currentRevisionId),
    revisions: log.revisions.map(rev => ({
      ...rev,
      files: files.filter(f => f.revision_id === rev.id),
      reviewComparison: reviewForRevision(rev.id),
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

// --- The predicted review, and how it compared -----------------------------------------
//
// Mirrors the RFI log deliberately, down to the shape of the stored rows. The PM's question is
// the same on both: "is this what the documents said, and if not, what does that change?" —
// and answering it the same way in both places means one thing to learn rather than two.

// Document ids arrive as a JSON array from the form, but a bare comma-separated string is
// tolerated so a hand-made request is not silently ignored.
//
// Splitting on commas alone is not enough, and the failure is silent: "[3,7]" splits into "[3"
// and "7]", both of which are NaN, so every ticked document is dropped and the review runs
// against nothing while the panel still shows them ticked.
const parseIdList = (raw) => {
  if (raw == null) return [];
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list.split(','); }
    // A single id survives JSON.parse as a number rather than an array — "37" parses to 37,
    // not [37]. Treating that as "not a list" silently dropped it, so one ticked document
    // linked nothing while two linked both.
    if (!Array.isArray(list)) list = [list];
  }
  if (!Array.isArray(list)) return [];
  return list.map(v => Number(String(v).trim())).filter(n => Number.isInteger(n) && n > 0);
};

// The Shared Documents this submittal is read against — usually the specification. Joined
// rather than stored as a list of ids, so a document removed from the project drops out.
const documentsOf = submittalId => db.prepare(`
  SELECT pc.id, pc.file_name, pc.label, pc.doc_type
  FROM submittal_documents sd JOIN project_contracts pc ON pc.id = sd.contract_id
  WHERE sd.submittal_id = ? ORDER BY pc.doc_type ASC, pc.created_at ASC
`).all(submittalId);

function setDocuments(submittalId, projectId, rawIds) {
  if (rawIds == null) return;
  db.prepare(`DELETE FROM submittal_documents WHERE submittal_id=?`).run(submittalId);
  const valid = db.prepare(`SELECT id FROM project_contracts WHERE id=? AND project_id=?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO submittal_documents (submittal_id, contract_id) VALUES (?, ?)`);
  for (const id of parseIdList(rawIds)) {
    if (valid.get(id, projectId)) insert.run(submittalId, id);
  }
}

// Pulls the bytes of the chosen Shared Documents. Scoped by project inside the query, so an id
// from another project reads as missing rather than as a permission error.
async function loadDocumentBuffers(projectId, ids) {
  const find = db.prepare(
    `SELECT file_name, label, doc_type, file_key, file_blob
     FROM project_contracts WHERE id=? AND project_id=?`
  );
  const out = [];
  for (const id of ids) {
    const doc = find.get(id, projectId);
    if (!doc) continue;
    const buffer = await storage.readFile({ key: doc.file_key, blob: doc.file_blob });
    if (buffer) {
      out.push({ label: (doc.label || '').trim() || doc.file_name, doc_type: doc.doc_type, buffer });
    }
  }
  return out;
}

// Files a specification the PM attached while logging a submittal, and returns its id.
//
// It goes into Shared Documents rather than being held against this one submittal, because a
// specification is a project document that happens to have arrived here: the next submittal in
// the same division is measured against the same manual, and a copy invisible outside this
// entry would make the PM upload it again. terms_status is 'ready' because only a contract or a
// purchase order has terms to read — nothing here reads a specification on upload.
async function fileSpecification(projectId, file, createdBy) {
  const { key } = await storage.storeFile('contract', file.buffer, file.mimetype, file.originalname);
  return db.prepare(`
    INSERT INTO project_contracts
      (project_id, file_name, label, doc_type, is_primary, file_blob, file_key, terms,
       created_by, terms_status)
    VALUES (?, ?, ?, 'specifications', 0, ?, ?, '{}', ?, 'ready')
  `).run(
    projectId, file.originalname, file.originalname.replace(/\.pdf$/i, ''),
    key ? Buffer.alloc(0) : file.buffer, key, createdBy || null,
  ).lastInsertRowid;
}

// The project's specifications, for a submittal nobody has chosen documents for.
//
// Choosing them by hand was busywork with one right answer: a submittal is judged against the
// specification, the specification is filed under Shared Documents, and the PM knows which one
// it is because they uploaded it. Asking them to tick it every time — and blocking the review
// until they did — spent the PM's attention on a question the project already answers.
//
// Only genuine specifications are taken. A drawing set or a contract would be read as though it
// were the governing text, and a review measured against the wrong document is worse than one
// that says it could not find the right one.
async function specificationsFor(projectId) {
  const rows = db.prepare(`
    SELECT id FROM project_contracts
    WHERE project_id=? AND doc_type='specifications'
    ORDER BY created_at ASC
  `).all(projectId).map(r => r.id);
  return loadDocumentBuffers(projectId, rows);
}

const latestAnalysis = (submittalId) => {
  const row = db.prepare(
    `SELECT * FROM submittal_analyses WHERE submittal_id=? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(submittalId);
  if (!row) return null;
  return {
    ...row,
    analysis: JSON.parse(row.analysis_json),
    sources: JSON.parse(row.sources_json || '[]'),
    analysis_json: undefined,
    sources_json: undefined,
  };
};

// How the A/E's review compared with the prediction, for one round trip. Looked up per
// revision rather than per submittal: one that went round twice has two reviews, and showing
// the first one's comparison against the second one's stamp would be worse than showing none.
const reviewForRevision = (revisionId) => {
  if (!revisionId) return null;
  const row = db.prepare(
    `SELECT * FROM submittal_response_reviews WHERE revision_id=? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(revisionId);
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    created_by: row.created_by,
    review: JSON.parse(row.review_json),
    markdown: row.review_markdown,
  };
};

// The contractor's own package, for the revision being predicted. It is half of the
// comparison: a review that read the specification and not the submittal has nothing to say.
async function submittalFilesFor(submittalId, revisionId) {
  const rows = db.prepare(`
    SELECT file_name, file_key, file_blob FROM submittal_files
    WHERE submittal_id=? AND kind='submittal'${revisionId ? ' AND revision_id=?' : ''}
    ORDER BY id DESC LIMIT 2
  `).all(...(revisionId ? [submittalId, revisionId] : [submittalId]));
  const out = [];
  for (const r of rows) {
    const buffer = await storage.readFile({ key: r.file_key, blob: r.file_blob });
    if (buffer) out.push({ label: r.file_name, buffer });
  }
  return out;
}

// Runs the prediction-versus-review comparison for one revision and stores it. Returns null
// when there is nothing to compare — no prediction was ever run, or the revision has no A/E
// action yet — which is a normal state rather than an error.
async function runReviewComparison(req, submittal, revision) {
  const stored = latestAnalysis(submittal.id);
  if (!stored || !revision?.review_action) return null;

  const { review, markdown } = await compareToReview({
    submittal,
    analysis: stored.analysis,
    sources: stored.sources,
    response: {
      action: revision.review_action,
      notes: revision.response_notes,
      reviewedBy: revision.reviewed_by,
      dateReturned: revision.date_returned,
    },
  });

  // One comparison per revision: a re-run replaces the previous rather than stacking, so the
  // detail view cannot show two contradictory readings of the same stamp.
  db.prepare(`DELETE FROM submittal_response_reviews WHERE revision_id=?`).run(revision.id);
  db.prepare(`
    INSERT INTO submittal_response_reviews (submittal_id, revision_id, analysis_id, review_json,
      review_markdown, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(submittal.id, revision.id, stored.id, JSON.stringify(review), markdown,
    req.user.name || req.user.email);
  return review;
}

// --- Reading the log --------------------------------------------------------------------

// The log itself. Ordered by submittal number the way a register reads, and returned with
// its counts so the page never recomputes them differently from the export.
router.get('/', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT * FROM submittals WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }

  // Per row, not per page: a log filtered to one project could use one number, but an
  // unfiltered one spans jobs whose specifications set different deadlines.
  const rows = db.prepare(sql).all(...params)
    .map(row => buildLogRow(row, revisionsOf(row.id), optionsFor(row)));

  // Natural-ish ordering: "S-2" before "S-10", which a plain string sort gets wrong and a
  // submittal register is always read in.
  rows.sort((a, b) => String(a.submittal_number || '')
    .localeCompare(String(b.submittal_number || ''), undefined, { numeric: true, sensitivity: 'base' }));

  res.json({
    submittals: rows, summary: summarize(rows),
    reviewDays: reviewDays(req.query.project_id || null),
  });
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

  // Per row, not per page. A log filtered to one project could use one number, but an
  // unfiltered one spans jobs whose specifications set different deadlines.
  const rows = db.prepare(sql).all(...params)
    .map(row => buildLogRow(row, revisionsOf(row.id), optionsFor(row)))
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
  res.json(detail(row, optionsFor(row)));
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
router.post('/', uploadForAnalysis.fields([
  { name: 'file', maxCount: 1 },
  { name: 'spec_file', maxCount: 1 },
]), async (req, res) => {
  try {
    const project = projectInScope(req, req.body.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const submittalNumber = nullable(req.body.submittal_number);
    const description = nullable(req.body.description);
    if (!submittalNumber) return res.status(400).json({ error: 'A submittal number is required.' });
    if (!description) return res.status(400).json({ error: 'A description is required.' });

    // What this submittal would be judged against, if the PM wants a prediction. Offered when
    // the entry is made because that is when the specification is in mind, but never required:
    // the log is a record of what was sent and when, and that record has to be enterable by
    // someone who has the submittal in front of them and nothing else.
    const specFile = req.files?.spec_file?.[0] || null;

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
      // project.id, not projectId — there is no such variable in this handler, and referencing
      // it threw before a single submittal could be saved.
      nullable(req.body.date_response_due)
        || dueDateFor({ date_forwarded: dateForwarded }, reviewDays(project.id))
    );

    // The specification, filed if it arrived here and linked either way, so the review that
    // runs next already knows what it is measured against.
    const documentIds = parseIdList(req.body.document_ids);
    if (specFile) {
      documentIds.push(await fileSpecification(project.id, specFile, req.user.name || req.user.email));
    }
    // The array itself, not a joined string — round-tripping ids through text is what dropped
    // them in the first place, and there is nothing here that needs them to be text.
    setDocuments(submittalId, project.id, documentIds);

    const packageFile = req.files?.file?.[0] || null;
    if (packageFile) {
      await attachFile({
        submittalId, revisionId: revision.lastInsertRowid, kind: 'submittal', file: packageFile,
      });
    }

    res.json(detail(
      db.prepare(`SELECT * FROM submittals WHERE id=?`).get(submittalId),
      optionsFor({ project_id: project.id })
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
    optionsFor(row)));
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
      nullable(req.body.date_response_due)
        || dueDateFor({ date_forwarded: dateForwarded }, reviewDays(submittal.project_id))
    );

    if (req.file) {
      await attachFile({
        submittalId: submittal.id, revisionId: revision.lastInsertRowid, kind: 'submittal', file: req.file,
      });
    }
    touch(submittal.id);

    res.json(detail(submittal, optionsFor(submittal)));
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
    : dueDateFor({ date_forwarded: dateForwarded }, reviewDays(submittal.project_id))
      || revision.date_response_due;

  db.prepare(`
    UPDATE submittal_revisions SET date_received=?, date_forwarded=?, date_response_due=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(pick('date_received', revision.date_received), dateForwarded, due, revision.id);

  touch(submittal.id);
  res.json(detail(submittal, optionsFor(submittal)));
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
      revision.date_response_due
        || dueDateFor({ date_forwarded: dateForwarded }, reviewDays(submittal.project_id)),
      revision.id
    );

    if (req.file) {
      await attachFile({ submittalId: submittal.id, revisionId: revision.id, kind: 'response', file: req.file });
    }
    touch(submittal.id);

    // The A/E's review is now safely on the record, so the comparison against Coaster's
    // prediction runs afterwards and on a best-effort basis. It is worth having, but it is an
    // AI call on a rate-limited account, and losing the A/E's review because a comparison
    // failed would be a bad trade. If it does not run, the detail view offers a button.
    let comparisonError = null;
    try {
      const updated = db.prepare(`SELECT * FROM submittal_revisions WHERE id=?`).get(revision.id);
      await runReviewComparison(req, submittal, updated);
    } catch (err) {
      console.error('Submittal review comparison error:', err);
      comparisonError = friendlyAiError(err);
    }

    const record = detail(submittal, optionsFor(submittal));
    res.json({
      ...record,
      comparisonError,
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

// --- The predicted review ------------------------------------------------------------------
//
// Run before the submittal goes to the A/E, which is the whole point: a missing certificate
// found today costs an email, and found after the stamp costs a resubmittal and three weeks.

router.post('/:id/analysis', uploadForAnalysis.fields([
  { name: 'files', maxCount: 4 },
  { name: 'spec_files', maxCount: 4 },
]), async (req, res) => {
  try {
    const submittal = visibleSubmittal(req);
    if (!submittal) return res.status(404).json({ error: 'Not found' });

    // A spec section sent with the request is treated as a correction and saved, so re-running
    // after fixing it does not silently revert next time.
    const requested = nullable(req.body.spec_section);
    if (requested && requested !== submittal.spec_section) {
      db.prepare(`UPDATE submittals SET spec_section=?, updated_at=datetime('now') WHERE id=?`)
        .run(requested, submittal.id);
      submittal.spec_section = requested;
    }
    if ('document_ids' in req.body) setDocuments(submittal.id, submittal.project_id, req.body.document_ids);

    const chosenIds = db.prepare(`SELECT contract_id FROM submittal_documents WHERE submittal_id=?`)
      .all(submittal.id).map(r => r.contract_id);
    const documents = await loadDocumentBuffers(submittal.project_id, chosenIds);

    // The specification a PM has on their desk but has not filed yet. Read for this review only
    // and not added to the project, because filing documents is the Shared Documents page's job
    // and doing it as a side effect of a review would put copies there nobody chose to keep.
    for (const f of (req.files?.spec_files || [])) {
      documents.push({ label: f.originalname, doc_type: 'specifications', buffer: f.buffer });
    }

    // Nothing chosen and nothing handed over: use what the project already holds. The section
    // inside it is found by number, so handing over a whole manual costs no more than handing
    // over the one section would.
    if (documents.length === 0) {
      documents.push(...await specificationsFor(submittal.project_id));
    }

    // The contractor's package: whatever was uploaded with this request, else what is already
    // stored against the open revision.
    const revisions = revisionsOf(submittal.id);
    const current = revisions[revisions.length - 1];
    let submittalFiles = (req.files?.files || []).map(f => ({ label: f.originalname, buffer: f.buffer }));
    if (!submittalFiles.length) submittalFiles = await submittalFilesFor(submittal.id, current?.id);
    if (!submittalFiles.length) submittalFiles = await submittalFilesFor(submittal.id, null);

    if (documents.length === 0 && submittalFiles.length === 0) {
      return res.status(400).json({
        error: 'There is nothing to read yet. Attach the contractor\'s submittal, and add the '
          + 'specification to the project\'s Shared Documents.',
      });
    }
    if (documents.length === 0) {
      return res.status(400).json({
        error: 'No specification is on this project yet. Upload it under Shared Documents — or '
          + 'attach the section here — and the review will find the section this submittal was '
          + 'made under.',
      });
    }

    const { analysis, sources, markdown } = await analyzeSubmittal({ submittal, documents, submittalFiles });

    const saved = db.prepare(`
      INSERT INTO submittal_analyses (submittal_id, revision_id, spec_section, sources_json,
        analysis_json, analysis_markdown, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      submittal.id, current?.id || null, submittal.spec_section || null, JSON.stringify(sources),
      JSON.stringify(analysis), markdown, req.user.name || req.user.email
    );

    res.json({
      id: saved.lastInsertRowid, analysis, sources, analysis_markdown: markdown,
      submittal: detail(submittal, optionsFor(submittal)),
    });
  } catch (err) {
    console.error('Submittal analysis error:', err);
    res.status(err.status === 429 ? 429 : err.status || 500).json({ error: friendlyAiError(err) });
  }
});

// Runs the comparison on demand — after a failure when the review was recorded, or to redo it
// once the prediction has been re-run against a better specification.
router.post('/:id/revisions/:revId/comparison', async (req, res) => {
  try {
    const { submittal, revision } = visibleRevision(req);
    if (!submittal || !revision) return res.status(404).json({ error: 'Not found' });

    if (!revision.review_action) {
      return res.status(400).json({
        error: 'There is nothing to compare yet — record what the A/E returned on this revision first.',
      });
    }
    if (!latestAnalysis(submittal.id)) {
      return res.status(400).json({
        error: 'There is no predicted review to compare against. Run one from this submittal '
          + 'first, and it will be read against the A/E\'s stamp.',
      });
    }

    await runReviewComparison(req, submittal, revision);
    res.json(detail(submittal, optionsFor(submittal)));
  } catch (err) {
    console.error('Submittal review comparison error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

const asMarkdown = (res, name, body) => {
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body || '');
};

router.get('/:id/analysis.md', (req, res) => {
  const submittal = visibleSubmittal(req);
  if (!submittal) return res.status(404).json({ error: 'Not found' });
  const found = latestAnalysis(submittal.id);
  if (!found) return res.status(404).json({ error: 'No predicted review has been run for this submittal yet.' });
  const safe = String(submittal.submittal_number).replace(/[^a-z0-9-]+/gi, '_');
  asMarkdown(res, `${safe}_predicted_review.md`, found.analysis_markdown);
});

router.get('/:id/comparison.md', (req, res) => {
  const submittal = visibleSubmittal(req);
  if (!submittal) return res.status(404).json({ error: 'Not found' });
  const revisions = revisionsOf(submittal.id);
  const found = reviewForRevision(revisions[revisions.length - 1]?.id);
  if (!found) return res.status(404).json({ error: 'No review comparison has been produced for this submittal yet.' });
  const safe = String(submittal.submittal_number).replace(/[^a-z0-9-]+/gi, '_');
  asMarkdown(res, `${safe}_review_comparison.md`, found.markdown);
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
