const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePayApps } = require('../lib/payAppExtract');
const { runChecks } = require('../lib/payAppChecks');
const { buildReport } = require('../lib/payAppReport');
const { renderPayAppReportPdf } = require('../lib/payAppReportPdf');
const { annotatePayAppPdf } = require('../lib/payAppAnnotate');
const { extractContractTerms } = require('../lib/contractExtract');
const { scanCompliance } = require('../lib/payAppCompliance');
const { buildSubReconciliation, runMissedItemChecks } = require('../lib/payAppReconcile');
const { buildSiteVerificationChecklist } = require('../lib/payAppChecklist');
const { backfillPayApp } = require('../lib/payAppNormalize');
const { buildQuestions, formatAnswers, retainageFrom } = require('../lib/payAppQuestions');
const { parseCoLogCsv } = require('../lib/csv');
const { friendlyAiError } = require('../lib/aiErrors');
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
router.post('/extract', upload.fields([{ name: 'current_file', maxCount: 1 }, { name: 'previous_file', maxCount: 1 }]), async (req, res) => {
  try {
    const currentFile = req.files?.current_file?.[0];
    if (!currentFile) return res.status(400).json({ error: 'Current pay application PDF is required' });
    if (currentFile.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Current pay application must be a PDF' });

    const previousFile = req.files?.previous_file?.[0];
    if (previousFile && previousFile.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Previous pay application must be a PDF' });
    }

    const { current, previous } = await analyzePayApps(currentFile.buffer, previousFile?.buffer);
    res.json({ current: backfillPayApp(current), previous: backfillPayApp(previous) });
  } catch (err) {
    console.error('Pay app extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// The terms of the contract this project's pay apps are judged against.
function storedContractTerms(projectId) {
  if (!projectId) return null;
  const row = db.prepare(`
    SELECT terms FROM project_contracts WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(projectId);
  return row ? JSON.parse(row.terms) : null;
}

// Both review standards say to ask the reviewer only about what the documents cannot
// settle, and never to hold up the review waiting. So the questions are computed from
// the gaps left after reading the contract and the extracted application — the reviewer
// is asked two or three things on a well-documented job, and more on a thin one.
//
// Called after extraction and before the review runs, so the answers can feed both the
// arithmetic and the document scan.
router.post('/questions', (req, res) => {
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  if (projectId && !visibleProject(req, projectId)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const current = req.body.current ? JSON.parse(req.body.current) : null;
  if (!current) return res.status(400).json({ error: 'The extracted current application is required' });

  const retainageRate = req.body.retainage_rate ? parseFloat(req.body.retainage_rate) : null;

  res.json({
    questions: buildQuestions({
      current,
      contractTerms: storedContractTerms(projectId),
      retainagePolicy: retainageRate ? { rate: retainageRate } : null,
      originalContractSum: req.body.original_contract_sum ? parseFloat(req.body.original_contract_sum) : null,
      coLog: req.body.co_log_csv || req.body.co_log_json || null,
      hasBackup: req.body.has_backup === 'true' || req.body.has_backup === true,
    }),
  });
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
           current_payment_due, balance_to_finish, critical_count, fail_count, created_at
    FROM pay_app_reviews
    WHERE project_id = ?
    ORDER BY application_number ASC, created_at ASC
  `).all(req.params.id);

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
// doc_type 'contract' has terms and can be reviewed against. 'reference' is storage for the
// team: downloadable, never sent to the model.

const DOC_TYPES = ['contract', 'reference'];

// Falls back to the filename so a document is never nameless in a dropdown.
const docLabel = (label, fileName) =>
  (label || '').trim() || fileName.replace(/\.pdf$/i, '');

function listDocuments(projectId) {
  return db.prepare(`
    SELECT id, project_id, file_name, label, doc_type, is_primary, terms_edited, created_at, updated_at
    FROM project_contracts WHERE project_id = ?
    ORDER BY doc_type ASC, is_primary DESC, created_at ASC
  `).all(projectId);
}

router.get('/project/:id/documents', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  res.json(listDocuments(req.params.id));
});

async function addDocument(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'A PDF is required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'The document must be a PDF' });
    if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });

    const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'contract';
    const label = docLabel(req.body.label, file.originalname);

    // Only an agreement is worth reading: extracting "terms" from a schedule or an estimate
    // would spend tokens to produce nonsense.
    let storedTerms = {};
    if (docType === 'contract') {
      const terms = await extractContractTerms(file.buffer);
      const { usage, ...rest } = terms;
      storedTerms = rest;
      if (usage) {
        console.log(`[contract extract] project=${req.params.id} in=${usage.inputTokens} out=${usage.outputTokens} tokens`);
      }
    }

    // The first contract on a project becomes its primary, which is what Pay App Review and
    // Change Order Review read. Existing projects keep the contract they already had.
    const hasPrimary = db.prepare(
      `SELECT 1 FROM project_contracts WHERE project_id=? AND doc_type='contract' AND is_primary=1`
    ).get(req.params.id);
    const isPrimary = docType === 'contract' && !hasPrimary ? 1 : 0;

    const key = (await storage.storeFile('contract', file.buffer, file.mimetype, file.originalname)).key;
    const result = db.prepare(`
      INSERT INTO project_contracts
        (project_id, file_name, label, doc_type, is_primary, file_blob, file_key, terms, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, file.originalname, label, docType, isPrimary,
      key ? Buffer.alloc(0) : file.buffer, key, JSON.stringify(storedTerms),
      req.body.created_by || null,
    );

    res.json({
      id: result.lastInsertRowid, file_name: file.originalname,
      label, doc_type: docType, is_primary: isPrimary, terms: storedTerms,
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
  if (req.body.terms) {
    // The extraction is a model reading a legal document — it can be wrong. Let the PM
    // correct it once rather than re-litigating a bad flag every month.
    db.prepare(`UPDATE project_contracts SET terms=?, terms_edited=1, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(req.body.terms), row.id);
  }
  if (req.body.is_primary && row.doc_type === 'contract') {
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
      `SELECT id FROM project_contracts WHERE project_id=? AND doc_type='contract' ORDER BY created_at ASC LIMIT 1`
    ).get(req.params.id);
    if (next) db.prepare(`UPDATE project_contracts SET is_primary=1 WHERE id=?`).run(next.id);
  }
  res.json({ success: true });
});

router.get('/project/:id/documents/:docId/file.pdf', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT file_name, file_blob, file_key FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

// --- The project's primary contract --------------------------------------------------
// Pay App Review and Change Order Review still work against a single contract. These read
// the one flagged primary, so which contract they use stays deterministic and visible rather
// than following whatever happened to be uploaded last.

const primaryContract = projectId => db.prepare(`
  SELECT * FROM project_contracts WHERE project_id = ? AND doc_type = 'contract'
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
    `SELECT id FROM project_contracts WHERE project_id=? AND doc_type='contract' ORDER BY created_at ASC LIMIT 1`
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

router.post('/', upload.fields([
  { name: 'current_file', maxCount: 1 },
  { name: 'backup_files', maxCount: 10 },
]), async (req, res) => {
  try {
    const currentFile = req.files?.current_file?.[0];
    if (!currentFile) return res.status(400).json({ error: 'Current pay application PDF is required' });
    const backupFiles = (req.files?.backup_files || []).filter(f => f.mimetype === 'application/pdf');

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
    let contractTerms = storedContractTerms(projectId);

    // What the reviewer answered when asked about the gaps. Recomputing the questions
    // here rather than trusting the ones the browser sent keeps the answers tied to real
    // questions — a client cannot invent a question to smuggle text into the prompt.
    const answers = req.body.answers_json ? JSON.parse(req.body.answers_json) : null;
    const questions = answers
      ? buildQuestions({
          current,
          contractTerms,
          retainagePolicy,
          originalContractSum,
          coLog: changeOrderLog,
          hasBackup: backupFiles.length > 0,
        })
      : [];
    const answersBlock = formatAnswers(questions, answers);
    const answersForReport = questions
      .filter(q => answers?.[q.id] != null && answers[q.id] !== '' && answers[q.id] !== 'unknown')
      .map(q => ({
        question: q.question,
        answer: q.type === 'choice'
          ? (q.options.find(o => o.value === answers[q.id])?.label ?? answers[q.id])
          : (q.unit === '%' ? `${answers[q.id]}%` : String(answers[q.id])),
      }));

    // A tax status the reviewer confirmed is a contract term the extraction simply missed,
    // so it feeds the scan the same way an extracted one does. It only ever fills a gap —
    // an answer never overwrites a status actually found in the contract.
    if (answers?.taxStatus && answers.taxStatus !== 'unknown'
      && contractTerms?.taxExempt !== true && contractTerms?.taxExempt !== false) {
      contractTerms = {
        ...(contractTerms || {}),
        taxExempt: answers.taxStatus === 'exempt',
        taxExemptBasis: 'Confirmed by the reviewer — not stated in the contract on file.',
      };
    }

    // Same for retainage: a rate given in answer to a question is a real contract term,
    // so it should drive the arithmetic, not just the narrative.
    if (!retainagePolicy) retainagePolicy = retainageFrom(answers);

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
    const subRecon = buildSubReconciliation(current);
    const results = [
      ...runChecks(data),
      ...subRecon.results,
      ...runMissedItemChecks({ current, previous, subReconciliation: subRecon }),
    ];

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
    let compliance = null;
    if (contractTerms || scopeBaseline) {
      try {
        compliance = await scanCompliance({
          payAppBuffer: currentFile.buffer,
          backupBuffers: backupFiles.map(f => f.buffer),
          contractTerms,
          scopeBaseline,
          currentItems: current.lineItems.map(li => ({
            itemNo: li.itemNo, description: li.description, scheduledValue: li.c ?? null, billedToDate: li.g ?? null,
          })),
          coLog: changeOrderLog,
          answersBlock,
        });
      } catch (err) {
        console.error('Compliance scan failed (review continues):', err.message);
        compliance = {
          scopeComparison: null, scopeSource: null,
          taxFindings: [], unallowableFindings: [], anomalies: [], backupCoverage: null,
          notes: `The contract compliance scan could not be completed (${friendlyAiError(err)}). The math checks are unaffected.`,
          incomplete: true,
        };
      }
    }

    const report = buildReport({ data, results, compliance, contractTerms, subReconciliation: subRecon.rows, answers: answersForReport });

    const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    const currentKey = (await storage.storeFile('pay-app', currentFile.buffer, currentFile.mimetype, currentFile.originalname)).key;

    const insertResult = db.prepare(`
      INSERT INTO pay_app_reviews (
        org_id, project_name, application_number, period_to, contract_sum_to_date,
        total_completed_to_date, current_payment_due, balance_to_finish,
        extracted_data, checks_result, report_markdown,
        current_file_name, current_file, current_file_key, previous_review_id,
        contract_sum, co_log, critical_count, fail_count, created_by, project_id,
        compliance_findings, review_answers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(results),
      report.markdown,
      currentFile.originalname, currentKey ? Buffer.alloc(0) : currentFile.buffer, currentKey,
      previousReviewId,
      originalContractSum,
      changeOrderLog ? JSON.stringify(changeOrderLog) : null,
      criticalCount, failCount,
      req.body.created_by || null,
      projectId,
      compliance ? JSON.stringify(compliance) : null,
      answersForReport.length ? JSON.stringify(answersForReport) : null
    );

    res.json({ id: insertResult.lastInsertRowid, projectId, report, results });
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

router.get('/:id', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extractedData = JSON.parse(row.extracted_data);
  const results = JSON.parse(row.checks_result);
  const compliance = row.compliance_findings ? JSON.parse(row.compliance_findings) : null;
  // Rebuild the full report server-side — the sub-reconciliation chart is derived from
  // the stored extraction, and one builder means the stored view can never drift from
  // what the reviewer saw when the review ran.
  const report = buildReport({
    data: extractedData, results, compliance,
    subReconciliation: buildSubReconciliation(extractedData.current).rows,
    answers: row.review_answers ? JSON.parse(row.review_answers) : [],
  });
  res.json({
    ...row,
    current_file: undefined,
    extracted_data: extractedData,
    checks_result: results,
    checklist: report.checklist,
    co_log: row.co_log ? JSON.parse(row.co_log) : null,
    compliance_findings: compliance,
    report,
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleReview(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown);
});

// Client-facing PDF of the review, on the Coaster letterhead. Rebuilt from the stored
// extraction + check results (not the markdown) so it can never drift from what
// the reviewer saw on screen. No AI call — pure rendering.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = visibleReview(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const data = JSON.parse(row.extracted_data);
    const results = JSON.parse(row.checks_result);
    const report = buildReport({
      data, results,
      compliance: row.compliance_findings ? JSON.parse(row.compliance_findings) : null,
      subReconciliation: buildSubReconciliation(data.current).rows,
      answers: row.review_answers ? JSON.parse(row.review_answers) : [],
    });

    const pdf = await renderPayAppReportPdf({ report, companyName: 'Coaster' });
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
    checks_result: JSON.parse(row.checks_result),
    checklist: buildSiteVerificationChecklist(extractedData.current, extractedData.previous),
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

    const results = JSON.parse(row.checks_result);
    const { buffer, markedCount, unplacedCount } = await annotatePayAppPdf({
      pdfBuffer: original,
      results,
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
