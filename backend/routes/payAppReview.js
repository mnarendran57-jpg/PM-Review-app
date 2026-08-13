const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePayApps, analyzeBackup } = require('../lib/payAppExtract');
const { buildReportDoc, annotationsFor } = require('../lib/payAppReportDoc');
const { renderPayAppReportPdf } = require('../lib/payAppReportPdf');
const { brandingFor } = require('../lib/orgBranding');
const { annotatePayAppPdf } = require('../lib/payAppAnnotate');
const contractQueue = require('../lib/contractQueue');
const { proposePlaceholders, applyPlaceholders, readDocx } = require('../lib/memoCover');
const { runEngines, attachReadCheck } = require('../lib/payAppEngines');
const { verifyRead } = require('../lib/payAppVerifyRead');
const { buildReportHtml } = require('../lib/payAppReportHtml');
const { backfillPayApp } = require('../lib/payAppNormalize');
const { parseCoLogCsv } = require('../lib/csv');
const { friendlyAiError } = require('../lib/aiErrors');
const { DOC_TYPE_KEYS, GOVERNING_SQL, isGoverning } = require('../lib/docTypes');
const storage = require('../lib/storage');

const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');

// Scoped to one organization; within it a member sees only projects they belong to.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('pay-app-review'));

// A review the caller may see, else null -> 404 (not 403) so ids cannot be probed.
function visibleReview(req) {
  const row = db.prepare('SELECT * FROM pay_app_reviews WHERE id=?').get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

// A project in the active organization that the caller may use, else null.
function visibleProject(req, id) {
  const project = access.projectForUser(req.user, id);
  return project && project.org_id === req.orgId ? project : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Extract structured data from one or two uploaded pay app PDFs — both files (if present)
// are sent to Claude in a single request to minimize API calls against tight rate limits.
router.post('/extract', upload.fields([
  { name: 'current_file', maxCount: 1 },
  { name: 'previous_file', maxCount: 1 },
  { name: 'backup_files', maxCount: 10 },
]), async (req, res) => {
  try {
    const currentFile = req.files?.current_file?.[0];
    if (!currentFile) return res.status(400).json({ error: 'Current pay application PDF is required' });
    if (currentFile.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Current pay application must be a PDF' });

    const previousFile = req.files?.previous_file?.[0];
    if (previousFile && previousFile.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Previous pay application must be a PDF' });
    }

    const { current, previous } = await analyzePayApps(currentFile.buffer, previousFile?.buffer);

    // Backup that arrived separately from the package. It is read HERE, with the pay app,
    // rather than at review time, so the review itself stays free of AI calls and so the
    // evidence lands inside the extraction the PM can see and correct on screen.
    //
    // These files used to be accepted by the review route and never referenced again — the
    // form invited them, multer parsed them, and they were dropped. A reconciliation pass that
    // stood down for want of invoices the contractor had actually supplied is the worst kind of
    // silence: it reads as "nothing was submitted".
    const backupFiles = (req.files?.backup_files || []).filter(f => f.mimetype === 'application/pdf');
    let backupRead = null;
    if (backupFiles.length && current) {
      const extra = await analyzeBackup(backupFiles.map(f => f.buffer));
      const join = key => [...(current[key] || []), ...(extra[key] || [])];
      current.subBreakdowns = join('subBreakdowns');
      current.waivers = join('waivers');
      current.backupDocuments = join('backupDocuments');
      backupRead = {
        files: backupFiles.length,
        documents: extra.backupDocuments.length,
        waivers: extra.waivers.length,
        breakdowns: extra.subBreakdowns.length,
      };
    }

    res.json({ current: backfillPayApp(current), previous: backfillPayApp(previous), backupRead });
  } catch (err) {
    console.error('Pay app extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Projects to offer in the Pay App Review dropdown. Deliberately not a full project
// list: only projects that are Active, ordered so the ones with recent pay app
// activity surface first. Projects are created implicitly when a pay app is reviewed,
// so this fills in on its own with no setup step.
router.get('/projects', (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.project_name, p.project_number, p.client_name,
           COUNT(r.id)                AS pay_app_count,
           MAX(r.application_number)  AS latest_application_number,
           MAX(r.created_at)          AS last_reviewed_at
    FROM projects p
    LEFT JOIN pay_app_reviews r ON r.project_id = p.id
    WHERE p.status = 'Active' AND p.org_id = ?
    GROUP BY p.id
    ORDER BY (last_reviewed_at IS NULL), last_reviewed_at DESC, p.project_name ASC
  `).all(req.orgId));
});

// Create a project up front. Projects are also created implicitly when a pay app names a
// new one, but that left a fresh install with nothing to select — and therefore no way to
// attach a contract, which must exist before the first pay app is reviewed if the tax and
// unallowable-cost checks are to run on it.
router.post('/projects', (req, res) => {
  const name = (req.body.project_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  const existing = db.prepare(`SELECT id, project_name, status FROM projects WHERE project_name = ? AND org_id = ?`).get(name, req.orgId);
  if (existing) {
    // Re-selecting an existing project is the sane outcome here; a duplicate-name error
    // would just make the reviewer guess at what is already on file.
    if (existing.status !== 'Active') {
      db.prepare(`UPDATE projects SET status='Active' WHERE id=?`).run(existing.id);
    }
    return res.json({ id: existing.id, project_name: existing.project_name, existed: true });
  }

  const result = db.prepare(`
    INSERT INTO projects (org_id, project_name, project_number, client_name, status)
    VALUES (?, ?, ?, ?, 'Active')
  `).run(req.orgId, name, req.body.project_number || null, req.body.client_name || null);
  res.json({ id: result.lastInsertRowid, project_name: name, existed: false });
});

// Billing history for one project: every pay app reviewed so far, oldest first, with the
// period-over-period movement. This is what makes a new application legible in context —
// "is this pace normal for this job?" — rather than as an isolated document.
router.get('/project/:id/history', (req, res) => {
  const project = visibleProject(req, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const rows = db.prepare(`
    SELECT id, application_number, period_to, contract_sum_to_date, total_completed_to_date,
           current_payment_due, balance_to_finish, critical_count, fail_count, created_at,
           delivery_method
    FROM pay_app_reviews
    WHERE project_id = ?
    ORDER BY application_number ASC, created_at ASC
  `).all(req.params.id);

  // What this project was last reviewed as, so the upload form can default rather than ask cold.
  // The answer is still recorded per application: defaulting is a convenience, not an assumption.
  const lastMethod = [...rows].reverse().find(r => r.delivery_method)?.delivery_method || null;

  let prevCompleted = 0;
  const applications = rows.map(r => {
    const completed = r.total_completed_to_date ?? 0;
    const billedThisPeriod = completed - prevCompleted;
    const pctComplete = r.contract_sum_to_date ? (completed / r.contract_sum_to_date) * 100 : null;
    prevCompleted = completed;
    return { ...r, billed_this_period: billedThisPeriod, pct_complete: pctComplete };
  });

  const latest = applications[applications.length - 1] || null;
  res.json({
    project,
    applications,
    lastDeliveryMethod: lastMethod,
    summary: latest ? {
      applicationsReviewed: applications.length,
      latestApplicationNumber: latest.application_number,
      contractSumToDate: latest.contract_sum_to_date,
      totalCompletedToDate: latest.total_completed_to_date,
      balanceToFinish: latest.balance_to_finish,
      pctComplete: latest.pct_complete,
      totalPaidToDate: applications.reduce((a, r) => a + (r.current_payment_due || 0), 0),
      totalIssuesFlagged: applications.reduce((a, r) => a + (r.fail_count || 0), 0),
    } : null,
  });
});

// --- Shared Documents, stored per project -------------------------------------------
// A project has several agreements — the architect's, the general contractor's, often an
// engineer's — plus files that are not agreements at all (schedule, estimate). Each is
// uploaded once and, if it is a contract, its terms are extracted once; later reviews read
// the stored terms instead of re-sending a long PDF to the API every period.
//
// doc_type 'contract' is the load-bearing value: only a contract has its terms extracted, can
// be marked primary, and is what Pay App and Change Order Review read. Every other value is
// simply what kind of document it is — stored for the team, downloadable, and selectable by
// tools that read documents on request (the RFI log reads drawings this way).
//
// 'reference' predates the richer list and is kept so existing rows stay valid; the app
// presents it as "Other".
const DOC_TYPES = DOC_TYPE_KEYS;

// The only category that is not a PDF. A memo cover is the organization's own Word letter,
// filled in and handed back as a Word file, so it has to stay a .docx all the way through —
// converting it to PDF on upload would throw away the thing that makes it useful.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Falls back to the filename so a document is never nameless in a dropdown.
const docLabel = (label, fileName) =>
  (label || '').trim() || fileName.replace(/\.pdf$/i, '');

function listDocuments(projectId) {
  // `terms` travels with the list so a memo cover can show whether its placeholder mapping has
  // been confirmed without a second request per row.
  return db.prepare(`
    SELECT id, project_id, file_name, label, doc_type, is_primary, terms, terms_edited,
           extract_json, party, party_role, terms_status, terms_error, created_at, updated_at
    FROM project_contracts WHERE project_id = ?
    ORDER BY (doc_type IN (${GOVERNING_SQL})) DESC, is_primary DESC, doc_type ASC, created_at ASC
  `).all(projectId);
}

router.get('/project/:id/documents', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  // The stored reading travels with the list — a size worth paying because the page shows what
  // each document yielded, and a second request per row to find out would be worse.
  res.json(listDocuments(req.params.id).map(d => ({
    ...d,
    terms: JSON.parse(d.terms || '{}'),
    extract: d.extract_json ? JSON.parse(d.extract_json) : null,
    extract_json: undefined,
  })));
});

async function addDocument(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'A file is required' });
    if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });

    const wantsMemoCover = req.body.doc_type === 'memo-cover';
    if (wantsMemoCover && file.mimetype !== DOCX_MIME) {
      return res.status(400).json({ error: 'A memo cover must be a Word document (.docx).' });
    }
    if (!wantsMemoCover && file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'The document must be a PDF' });
    }

    // Falls back to 'other', never to 'contract'. Being a contract is the one consequential
    // choice here — it spends an AI call reading the document and can become the agreement
    // every review is checked against — so it has to be asked for explicitly rather than
    // arrived at because a value was missing or misspelt.
    const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';
    const label = docLabel(req.body.label, file.originalname);

    // Every document is read, not only an agreement — see lib/documentExtract.js. The memo
    // cover is the one read here rather than on the queue, because its placeholder mapping is
    // the thing the very next screen asks the user to confirm.
    let storedTerms = {};
    if (docType === 'memo-cover') {
      // Stored on the document row alongside the file. The column is named `terms` because a
      // contract's terms were the first thing kept here; for a memo cover it holds the
      // placeholder mapping and whether the user has confirmed it yet.
      const proposal = await proposePlaceholders(file.buffer);
      storedTerms = {
        kind: 'memo-cover',
        confirmed: false,
        hasPlaceholders: proposal.hasPlaceholders,
        replacements: proposal.replacements,
        notes: proposal.notes,
        paragraphs: proposal.paragraphs,
      };
    }
    // A contract is NOT read here. Reading a long agreement is several AI calls with rate-limit
    // waits between them — minutes of work — and doing it inside the upload meant the browser held
    // a connection open for all of it and gave up at three minutes. The length of a document
    // decided whether the feature worked at all, which is not something a user can do anything
    // about. The file is stored now and queued; lib/contractQueue.js takes it from there.

    // The first contract on a project becomes its primary, which is what Pay App Review and
    // Change Order Review read. Existing projects keep the contract they already had.
    const hasPrimary = db.prepare(
      `SELECT 1 FROM project_contracts WHERE project_id=? AND doc_type IN (${GOVERNING_SQL}) AND is_primary=1`
    ).get(req.params.id);
    const isPrimary = isGoverning(docType) && !hasPrimary ? 1 : 0;

    const key = (await storage.storeFile('contract', file.buffer, file.mimetype, file.originalname)).key;
    // Who the contract is with, in its own column rather than only inside `terms`. The review
    // matches each party's billing to their own agreement, so this is the field that decides
    // whether a subcontractor is measured against their subcontract or against nothing — and the
    // one a PM is most likely to want to correct by hand. What the form says beats what the model
    // read; a person naming the party is better evidence than a signature block.
    const party = (req.body.party || '').trim() || storedTerms.party || null;
    const partyRole = ['prime', 'subcontractor', 'supplier'].includes(req.body.party_role)
      ? req.body.party_role : (storedTerms.partyRole || null);

    // Everything but the memo cover has a reading to wait for now: a contract and a purchase
    // order for their terms, every other document for its index and key facts. The memo cover was
    // read above and is complete the moment it is stored.
    const status = docType === 'memo-cover' ? 'ready' : contractQueue.STATUS.PENDING;

    const result = db.prepare(`
      INSERT INTO project_contracts
        (project_id, file_name, label, doc_type, is_primary, file_blob, file_key, terms,
         created_by, party, party_role, terms_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, file.originalname, label, docType, isPrimary,
      key ? Buffer.alloc(0) : file.buffer, key, JSON.stringify(storedTerms),
      req.body.created_by || null, party, partyRole, status,
    );

    // Handed over AFTER the row exists, so the queue always has something to read back.
    if (docType !== 'memo-cover') contractQueue.enqueue(result.lastInsertRowid);

    res.json({
      id: result.lastInsertRowid, file_name: file.originalname,
      label, doc_type: docType, is_primary: isPrimary, terms: storedTerms,
      party, party_role: partyRole, terms_status: status,
    });
  } catch (err) {
    console.error('Shared document error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
}

router.post('/project/:id/documents', upload.single('file'), addDocument);

// One document's stored terms — what a review compares an invoice against.
router.get('/project/:id/documents/:docId', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT * FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, file_blob: undefined, terms: JSON.parse(row.terms || '{}') });
});

// Rename, or make this the contract the other tabs read.
router.patch('/project/:id/documents/:docId', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT * FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (req.body.label !== undefined) {
    db.prepare(`UPDATE project_contracts SET label=?, updated_at=datetime('now') WHERE id=?`)
      .run(docLabel(req.body.label, row.file_name), row.id);
  }
  // Who the contract is with. The single most consequential field on the row — it decides whose
  // billing gets measured against these terms — and the one the model is most likely to get wrong,
  // because a signature block names the owner, the contractor and often a surety on the same page.
  if (req.body.party !== undefined || req.body.party_role !== undefined) {
    const role = ['prime', 'subcontractor', 'supplier'].includes(req.body.party_role)
      ? req.body.party_role : null;
    db.prepare(`UPDATE project_contracts SET party=?, party_role=?, updated_at=datetime('now') WHERE id=?`)
      .run((req.body.party || '').trim() || null, role, row.id);
  }
  if (req.body.terms) {
    // The extraction is a model reading a legal document — it can be wrong. Let the PM
    // correct it once rather than re-litigating a bad flag every month.
    db.prepare(`UPDATE project_contracts SET terms=?, terms_edited=1, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(req.body.terms), row.id);
  }
  if (req.body.is_primary && isGoverning(row.doc_type)) {
    db.prepare(`UPDATE project_contracts SET is_primary=0 WHERE project_id=?`).run(req.params.id);
    db.prepare(`UPDATE project_contracts SET is_primary=1 WHERE id=?`).run(row.id);
  }
  res.json({ success: true });
});

router.delete('/project/:id/documents/:docId', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT * FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare(`DELETE FROM project_contracts WHERE id=?`).run(row.id);
  if (row.file_key) await storage.remove([row.file_key]);

  // Never leave a project with contracts but no primary — the other tabs read it.
  if (row.is_primary) {
    const next = db.prepare(
      `SELECT id FROM project_contracts WHERE project_id=? AND doc_type IN (${GOVERNING_SQL}) ORDER BY created_at ASC LIMIT 1`
    ).get(req.params.id);
    if (next) db.prepare(`UPDATE project_contracts SET is_primary=1 WHERE id=?`).run(next.id);
  }
  res.json({ success: true });
});

// Named file.pdf for historical reasons and kept so existing links work, but a memo cover is
// a Word file, so the type is taken from the row rather than assumed.
router.get('/project/:id/documents/:docId/file.pdf', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT file_name, file_blob, file_key, doc_type FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.doc_type === 'memo-cover' ? DOCX_MIME : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

// The memo cover with its confirmed placeholders written in — what the organization gets back
// so they can see, and keep, the template Coaster will fill from now on.
router.get('/project/:id/documents/:docId/template.docx', async (req, res) => {
  try {
    if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
    const row = db.prepare(`SELECT * FROM project_contracts WHERE id=? AND project_id=? AND doc_type='memo-cover'`)
      .get(req.params.docId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
    if (!bytes) return res.status(404).json({ error: 'Not found' });

    const terms = JSON.parse(row.terms || '{}');
    const { buffer } = applyPlaceholders(bytes, terms.replacements || []);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${row.file_name.replace(/\.docx$/i, '')}_template.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- The project's primary contract --------------------------------------------------
// Pay App Review and Change Order Review still work against a single contract. These read
// the one flagged primary, so which contract they use stays deterministic and visible rather
// than following whatever happened to be uploaded last.

const primaryContract = projectId => db.prepare(`
  SELECT * FROM project_contracts WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
  ORDER BY is_primary DESC, created_at ASC LIMIT 1
`).get(projectId);

router.get('/project/:id/contract', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = primaryContract(req.params.id);
  if (!row) return res.json(null);
  res.json({ ...row, file_blob: undefined, terms: JSON.parse(row.terms || '{}') });
});

// Kept so the original upload box keeps working; a contract added here joins the others
// rather than replacing them.
router.post('/project/:id/contract', upload.single('contract_file'), (req, res) => {
  req.body.doc_type = 'contract';
  return addDocument(req, res);
});

router.delete('/project/:id/contract', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = primaryContract(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM project_contracts WHERE id=?`).run(row.id);
  if (row.file_key) await storage.remove([row.file_key]);
  const next = db.prepare(
    `SELECT id FROM project_contracts WHERE project_id=? AND doc_type IN (${GOVERNING_SQL}) ORDER BY created_at ASC LIMIT 1`
  ).get(req.params.id);
  if (next) db.prepare(`UPDATE project_contracts SET is_primary=1 WHERE id=?`).run(next.id);
  res.json({ success: true });
});

router.patch('/project/:id/contract', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = primaryContract(req.params.id);
  if (!row) return res.status(404).json({ error: 'No contract on file for this project' });
  if (!req.body.terms) return res.status(400).json({ error: 'terms is required' });

  db.prepare(`
    UPDATE project_contracts SET terms=?, terms_edited=1, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(req.body.terms), row.id);
  res.json({ success: true });
});

router.get('/project/:id/contract/original.pdf', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = primaryContract(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

// Look up the most recent stored review for a project, to use as "previous application"
// without requiring the user to re-upload the prior PDF.
router.get('/latest-for-project', (req, res) => {
  const { project_name, project_id } = req.query;
  if (!project_name && !project_id) {
    return res.status(400).json({ error: 'project_id or project_name is required' });
  }
  // Prefer project_id: matching on the name text read off the PDF silently misses
  // whenever a vendor spells the project differently between applications.
  const row = project_id
    ? db.prepare(`
        SELECT id, application_number, period_to, extracted_data
        FROM pay_app_reviews WHERE project_id = ?
        ORDER BY application_number DESC, created_at DESC LIMIT 1
      `).get(project_id)
    : db.prepare(`
        SELECT id, application_number, period_to, extracted_data
        FROM pay_app_reviews WHERE project_name = ?
        ORDER BY application_number DESC, created_at DESC LIMIT 1
      `).get(project_name);
  if (!row) return res.json(null);
  const extracted = JSON.parse(row.extracted_data);
  res.json({ id: row.id, applicationNumber: row.application_number, periodTo: row.period_to, current: extracted.current });
});

// Separately-sent backup is read at /extract, not here, so this route stays free of AI calls
// and a recompute after editing the extracted figures costs nothing. The evidence travels in
// req.body.current, where the PM can see it before it is used.
router.post('/', upload.fields([
  { name: 'current_file', maxCount: 1 },
]), async (req, res) => {
  try {
    const currentFile = req.files?.current_file?.[0];
    if (!currentFile) return res.status(400).json({ error: 'Current pay application PDF is required' });

    const normalizePayApp = pa => pa && backfillPayApp({
      ...pa,
      summary: pa.summary || {},
      lineItems: Array.isArray(pa.lineItems) ? pa.lineItems : [],
    });

    const current = normalizePayApp(JSON.parse(req.body.current));
    const previous = req.body.previous ? normalizePayApp(JSON.parse(req.body.previous)) : null;
    const previousReviewId = req.body.previous_review_id ? Number(req.body.previous_review_id) : null;

    let contract = null;
    let originalContractSum = req.body.original_contract_sum ? parseFloat(req.body.original_contract_sum) : null;
    let changeOrderLog = null;
    if (req.body.co_log_csv) changeOrderLog = parseCoLogCsv(req.body.co_log_csv);
    else if (req.body.co_log_json) changeOrderLog = JSON.parse(req.body.co_log_json);

    let retainagePolicy = null;
    if (req.body.retainage_rate) {
      retainagePolicy = {
        rate: parseFloat(req.body.retainage_rate),
        reductionMilestonePct: req.body.retainage_milestone_pct ? parseFloat(req.body.retainage_milestone_pct) : null,
        reducedRate: req.body.retainage_reduced_rate ? parseFloat(req.body.retainage_reduced_rate) : null,
      };
    }

    // Resolve which project this review belongs to. The user normally picks from the
    // dropdown (project_id); if they didn't, fall back to the name on the PDF and create
    // the project on the fly so the dropdown fills in without a separate setup step.
    let projectId = req.body.project_id ? Number(req.body.project_id) : null;
    if (!projectId) {
      const name = (current.summary.projectName || '').trim();
      if (name) {
        const found = db.prepare(`SELECT id FROM projects WHERE project_name = ?`).get(name);
        projectId = found
          ? found.id
          : db.prepare(`INSERT INTO projects (project_name, status) VALUES (?, 'Active')`).run(name).lastInsertRowid;
      }
    }

    // The project's executed contract, if one is on file, is the source of truth for the
    // contract-level figures the reviewer would otherwise re-type every period, and for
    // the tax / unallowable-item rules. Anything typed on the form still wins — the PM
    // overriding a term is a deliberate act.
    // Every contract on file, not just one. A CMAR package is governed by the owner-contractor
    // agreement AND a subcontract behind each subcontractor billing through it, and those carry
    // different retainage rates and different exclusions. The contracts engine matches each to the
    // party billing under it; the PRIMARY one still supplies the project-level defaults below,
    // because tax status and the owner's contract sum are properties of the head agreement.
    //
    // The reviewer can narrow that set. On a CMAR job with a subcontract that does not apply this
    // period, unticking it has to actually stop it being applied — a control that changed nothing
    // would be worse than no control, because the report would then contradict the form. Omitted
    // entirely (an older client, or a CSP job) still means every contract on file.
    const chosenIds = String(req.body.contract_ids || '')
      .split(',').map(s => Number(s.trim())).filter(Number.isInteger);

    let contractTerms = null;
    let contracts = [];
    if (projectId) {
      contracts = db.prepare(`
        SELECT id, file_name, label, terms, is_primary, party, party_role, terms_status
        FROM project_contracts
        WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
        ORDER BY is_primary DESC, created_at ASC
      `).all(projectId).filter(row => !chosenIds.length || chosenIds.includes(row.id)).map((row) => {
        const terms = JSON.parse(row.terms || '{}');
        return {
          id: row.id,
          fileName: row.file_name,
          label: row.label,
          isPrimary: !!row.is_primary,
          // The party may have been corrected by hand on the document row, which outranks
          // whatever the model read off the signature block.
          party: row.party || terms.party || null,
          partyRole: row.party_role || terms.partyRole || null,
          partyScope: terms.partyScope || null,
          commitment: terms.commitment || null,
          termsStatus: row.terms_status || 'ready',
          terms,
        };
      });
      // A contract still being read has no terms yet. Including it would have the review measure
      // a party against an empty agreement and report everything about them as unverified, which
      // is worse than saying plainly that its reading is not finished.
      const readable = contracts.filter(c => c.termsStatus === 'ready');
      const primary = readable.find(c => c.isPrimary) || readable[0];
      if (primary) contractTerms = primary.terms;
    }

    // How this job is procured now comes from the PROJECT, set when it was created. The request
    // body is still honoured so an older client keeps working, and whatever is used is recorded on
    // the review itself — a project's setting can be corrected later without rewriting history.
    const projectRow = projectId
      ? db.prepare(`SELECT delivery_method FROM projects WHERE id=?`).get(projectId) : null;
    const requested = String(req.body.delivery_method || '').trim().toUpperCase();
    const deliveryMethod = ['CSP', 'CMAR'].includes(requested)
      ? requested
      : (['CSP', 'CMAR'].includes(projectRow?.delivery_method) ? projectRow.delivery_method : null);


    if (contractTerms) {
      if (originalContractSum == null && contractTerms.originalContractSum != null) {
        originalContractSum = contractTerms.originalContractSum;
      }
      if (!retainagePolicy && contractTerms.retainageRate != null) {
        retainagePolicy = { rate: contractTerms.retainageRate, reductionMilestonePct: null, reducedRate: null };
      }
    }
    if (originalContractSum != null || changeOrderLog) {
      contract = { originalContractSum, changeOrderLog };
    }

    const data = { current, previous, contract, retainagePolicy };

    // Scope baseline for the in/out-of-contract comparison: the contract's schedule of
    // values when one was extracted, else the project's FIRST pay application, which
    // established the agreed schedule. The first app is never compared against itself.
    let scopeBaseline = null;
    if (contractTerms?.scheduleOfValues?.length) {
      scopeBaseline = { source: 'contract', items: contractTerms.scheduleOfValues };
    } else if (projectId) {
      const firstReview = db.prepare(`
        SELECT id, application_number, extracted_data FROM pay_app_reviews WHERE project_id = ?
        ORDER BY application_number ASC, created_at ASC LIMIT 1
      `).get(projectId);
      // The baseline must verifiably predate the application under review — comparing
      // an app against its own stored review proves nothing, so when either
      // application number is unknown, skip rather than guess.
      if (firstReview && firstReview.application_number != null
        && current.summary.applicationNumber != null
        && firstReview.application_number < current.summary.applicationNumber) {
        const firstItems = JSON.parse(firstReview.extracted_data)?.current?.lineItems || [];
        if (firstItems.length) {
          scopeBaseline = {
            source: 'first_app',
            items: firstItems.map(li => ({ itemNo: li.itemNo, description: li.description, amount: li.c ?? null })),
          };
        }
      }
    }

    // Advisory half: read the pay app (and any separate backup) against the contract's
    // tax status and unallowable items, and compare billed lines to the agreed scope.
    // Never let this sink the review — the math checks above are the load-bearing part
    // and have already succeeded.
    // The prior application's certified figure, so Line 7 can be checked against the document
    // it should tie to rather than only for internal consistency, as the standard requires.
    let priorApplication = null;
    if (projectId) {
      const prior = db.prepare(`
        SELECT application_number, extracted_data FROM pay_app_reviews
        WHERE project_id = ? AND application_number IS NOT NULL AND application_number < ?
        ORDER BY application_number DESC LIMIT 1
      `).get(projectId, current.summary.applicationNumber ?? Number.MAX_SAFE_INTEGER);
      const priorSummary = prior && JSON.parse(prior.extracted_data)?.current?.summary;
      if (priorSummary?.line6 != null) {
        priorApplication = { applicationNumber: prior.application_number, line6: priorSummary.line6 };
      }
    }

    // The deterministic engines: I1-I24 on the G702 and continuation sheet, S1-S9 down the
    // contractor's breakdown into each subcontractor's own application, R1-R12 across a cost
    // report and its receipts, C1-C7 on the documents attached to each billed line.
    //
    // These replaced a model-conducted audit that used to run here. The engines only compare
    // figures that have already been read, every rule is measured against real applications in
    // backend/tests/fixtures/payapp, and each engine states out loud when it had no documents to
    // work with — so a quiet report can never mean an unexamined one.
    //
    // The engines ARE the review. Nothing else checks this application, so a failure here is a
    // failure of the whole thing rather than a degraded extra — it is reported plainly instead
    // of leaving a report that looks complete and has examined nothing.
    // Before anything is checked, check the reading. The figures arrive from a model that is
    // good at finding them in an unfamiliar layout and imperfect at copying them — one digit on
    // one line is enough to make every arithmetic check downstream report a contractor for the
    // reviewer's own mistake. Where the page has a text layer, each line is reconciled against
    // it and an unambiguous misread is corrected from the document itself.
    let readCheck = null;
    try {
      readCheck = await verifyRead(currentFile.buffer, current);
    } catch (err) {
      console.error('Read verification failed (review continues):', err.message);
    }

    let engineResult = null;
    try {
      engineResult = runEngines(
        { current, previous, contract, retainagePolicy, priorApplication }, contractTerms,
        { deliveryMethod, contracts: contracts.filter(c => c.termsStatus === 'ready'),
          contractsPending: contracts.filter(c => c.termsStatus !== 'ready') });
      attachReadCheck(engineResult, readCheck);
    } catch (err) {
      console.error('Pay app engines failed (review continues):', err.message);
    }

    // Kept only because stored reviews and the project dashboard already read this column.
    // Everything in it now comes from the engines.
    const engineTax = (engineResult?.findings || []).filter(f => f.id === 'S7');
    const compliance = engineResult ? {
      audit: null,
      scopeComparison: null,
      scopeSource: scopeBaseline?.source ?? null,
      taxFindings: engineTax.map(f => ({
        where: [f.where?.vendor, f.where?.ref].filter(Boolean).join(' — '),
        description: f.where?.vendor || f.where?.ref,
        amount: f.actual,
        detail: f.detail,
      })),
      unallowableFindings: [],
      backupCoverage: engineResult.notChecked.length ? engineResult.notChecked.join(' ') : null,
      notes: null,
      incomplete: false,
    } : {
      audit: null, scopeComparison: null, scopeSource: null, taxFindings: [],
      unallowableFindings: [], backupCoverage: null,
      notes: 'The review engines could not be run on this application.', incomplete: true,
    };

    const report = buildReportDoc({
      result: engineResult, data,
      projectName: current.summary.projectName, contractor: current.summary.contractor,
    });

    const criticalCount = engineResult ? engineResult.stats.critical : 0;
    const failCount = engineResult ? engineResult.stats.failed : 0;

    const currentKey = (await storage.storeFile('pay-app', currentFile.buffer, currentFile.mimetype, currentFile.originalname)).key;

    const insertResult = db.prepare(`
      INSERT INTO pay_app_reviews (
        org_id, project_name, application_number, period_to, contract_sum_to_date,
        total_completed_to_date, current_payment_due, balance_to_finish,
        extracted_data, checks_result, report_markdown,
        current_file_name, current_file, current_file_key, previous_review_id,
        contract_sum, co_log, critical_count, fail_count, created_by, project_id,
        compliance_findings, engine_result, delivery_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId,
      current.summary.projectName || null,
      current.summary.applicationNumber ?? null,
      current.summary.periodTo || null,
      current.summary.line3 ?? null,
      current.summary.line4 ?? null,
      current.summary.line8 ?? null,
      current.summary.line9 ?? null,
      JSON.stringify({ current, previous }),
      JSON.stringify(engineResult?.findings || []),
      report.markdown,
      currentFile.originalname, currentKey ? Buffer.alloc(0) : currentFile.buffer, currentKey,
      previousReviewId,
      originalContractSum,
      changeOrderLog ? JSON.stringify(changeOrderLog) : null,
      criticalCount, failCount,
      req.body.created_by || null,
      projectId,
      compliance ? JSON.stringify(compliance) : null,
      engineResult ? JSON.stringify(engineResult) : null,
      deliveryMethod
    );

    res.json({ id: insertResult.lastInsertRowid, projectId, report, engineResult });
  } catch (err) {
    console.error('Pay app review error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, project_name, project_id } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_name, application_number, period_to, contract_sum_to_date,
             total_completed_to_date, current_payment_due, balance_to_finish,
             critical_count, fail_count, created_by, created_at
             FROM pay_app_reviews WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (project_name) { sql += ' AND project_name = ?'; params.push(project_name); }
  if (search) { sql += ' AND project_name LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Rebuilds a stored review's report document. Reviews produced before the engines existed have
// no engine output to render, and are given null rather than being re-scored now against rules
// that did not exist when they ran — a report that changes its findings the day the rules change
// is not a record of anything.
function storedReportDoc(row, extractedData, engineResult) {
  if (!engineResult) return null;
  return buildReportDoc({
    result: engineResult,
    data: extractedData,
    projectName: row.project_name,
    contractor: extractedData?.current?.summary?.contractor || null,
  });
}

const NO_ENGINE_OUTPUT = 'This review was produced before the current review engines were in '
  + 'place, so there is no findings report for it. Re-running the application will produce one.';

router.get('/:id', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extractedData = JSON.parse(row.extracted_data);
  const engineResult = row.engine_result ? JSON.parse(row.engine_result) : null;
  const report = storedReportDoc(row, extractedData, engineResult);
  res.json({
    ...row,
    current_file: undefined,
    extracted_data: extractedData,
    checks_result: JSON.parse(row.checks_result || '[]'),
    checklist: report?.checklist || [],
    co_log: row.co_log ? JSON.parse(row.co_log) : null,
    compliance_findings: row.compliance_findings ? JSON.parse(row.compliance_findings) : null,
    engine_result: engineResult,
    report,
  });
});

// The review as the PM reads it. Rendered from the stored engine output rather than re-run, so
// reopening a review shows exactly what it showed the day it was produced. Reviews created
// before the engines existed have nothing stored and are told so plainly rather than being
// silently re-scored against rules that did not exist at the time.
router.get('/:id/report.html', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const data = JSON.parse(row.extracted_data);
  const engineResult = row.engine_result ? JSON.parse(row.engine_result) : null;
  const report = storedReportDoc(row, data, engineResult);
  if (!report) {
    return res.send('<!doctype html><meta charset="utf-8"><body style="font:15px/1.5 system-ui;'
      + `color:#535b67;padding:32px;max-width:44em">${NO_ENGINE_OUTPUT}</body>`);
  }
  res.send(buildReportHtml({ report }));
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown || NO_ENGINE_OUTPUT);
});

// Client-facing PDF of the review, on the Coaster letterhead. Rebuilt from the stored
// extraction + check results (not the markdown) so it can never drift from what
// the reviewer saw on screen. No AI call — pure rendering.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = visibleReview(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const data = JSON.parse(row.extracted_data);
    const engineResult = row.engine_result ? JSON.parse(row.engine_result) : null;
    const report = storedReportDoc(row, data, engineResult);
    if (!report) return res.status(409).json({ error: NO_ENGINE_OUTPUT });

    // The reviewing organization's letterhead, not a hardcoded name.
    const branding = await brandingFor(req.orgId);
    const pdf = await renderPayAppReportPdf({ report, companyName: branding.companyName || undefined });
    const safeProject = (row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${safeProject}_Review.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Pay app report PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/report.json', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extractedData = JSON.parse(row.extracted_data);
  const payload = {
    project_name: row.project_name,
    application_number: row.application_number,
    period_to: row.period_to,
    extracted_data: extractedData,
    findings: JSON.parse(row.checks_result || '[]'),
    engine_result: row.engine_result ? JSON.parse(row.engine_result) : null,
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// The contractor's own application, marked up with the review findings — each problem
// circled and annotated next to the figure it concerns. Preferred over the standalone
// report when the reviewer wants the issues in context on the source document.
router.get('/:id/marked-up.pdf', async (req, res) => {
  try {
    const row = visibleReview(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const original = await storage.readFile({ key: row.current_file_key, blob: row.current_file });
    if (!original) return res.status(404).json({ error: 'The original pay application PDF is not on file for this review.' });

    // Annotations come from the engine findings, through the same document builder as every
    // other output. They used to come from a separate check suite, which is how the marked-up
    // copy ended up showing findings the report beside it no longer agreed with.
    const data = JSON.parse(row.extracted_data);
    const engineResult = row.engine_result ? JSON.parse(row.engine_result) : null;
    const report = storedReportDoc(row, data, engineResult);
    if (!report) return res.status(409).json({ error: NO_ENGINE_OUTPUT });

    const { buffer, markedCount, unplacedCount } = await annotatePayAppPdf({
      pdfBuffer: original,
      results: annotationsFor(report),
      header: { projectName: row.project_name, applicationNumber: row.application_number },
    });
    console.log(`[pay app markup] review=${row.id} marked=${markedCount} unplaced=${unplacedCount}`);

    const safeProject = (row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${safeProject}_MARKED_UP.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Pay app markup error:', err);
    res.status(500).json({ error: `Could not mark up this pay application (${err.message}).` });
  }
});

router.get('/:id/original.pdf', async (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.current_file_key, blob: row.current_file });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.current_file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  const row = visibleReview(req);
  db.prepare('DELETE FROM pay_app_reviews WHERE id=?').run(req.params.id);
  await storage.remove([row?.current_file_key]);
  res.json({ success: true });
});

module.exports = router;
