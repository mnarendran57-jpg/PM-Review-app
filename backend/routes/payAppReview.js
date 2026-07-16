const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePayApps } = require('../lib/payAppExtract');
const { runChecks } = require('../lib/payAppChecks');
const { buildReport } = require('../lib/payAppReport');
const { renderPayAppReportPdf } = require('../lib/payAppReportPdf');
const { extractContractTerms } = require('../lib/contractExtract');
const { scanCompliance } = require('../lib/payAppCompliance');
const { buildSiteVerificationChecklist } = require('../lib/payAppChecklist');
const { backfillPayApp } = require('../lib/payAppNormalize');
const { parseCoLogCsv } = require('../lib/csv');
const { friendlyAiError } = require('../lib/aiErrors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
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
    WHERE p.status = 'Active'
    GROUP BY p.id
    ORDER BY (last_reviewed_at IS NULL), last_reviewed_at DESC, p.project_name ASC
  `).all());
});

// Billing history for one project: every pay app reviewed so far, oldest first, with the
// period-over-period movement. This is what makes a new application legible in context —
// "is this pace normal for this job?" — rather than as an isolated document.
router.get('/project/:id/history', (req, res) => {
  const project = db.prepare(`SELECT id, project_name, project_number, client_name, contract_value FROM projects WHERE id=?`).get(req.params.id);
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

// --- Executed contract, stored per project -----------------------------------------
// The contract is signed once, so it is uploaded once and its terms extracted once.
// Later pay app reviews read the stored terms instead of re-sending the PDF, which
// keeps a long contract from being re-billed to the API every period.

router.get('/project/:id/contract', (req, res) => {
  const row = db.prepare(`
    SELECT id, project_id, file_name, terms, terms_edited, created_at, updated_at
    FROM project_contracts WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(req.params.id);
  if (!row) return res.json(null);
  res.json({ ...row, terms: JSON.parse(row.terms) });
});

router.post('/project/:id/contract', upload.single('contract_file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Contract PDF is required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Contract must be a PDF' });

    const project = db.prepare(`SELECT id FROM projects WHERE id=?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const terms = await extractContractTerms(file.buffer);
    const { usage, ...storedTerms } = terms;
    if (usage) {
      console.log(`[contract extract] project=${req.params.id} in=${usage.inputTokens} out=${usage.outputTokens} tokens`);
    }

    // One contract per project: replace any prior upload rather than accumulating
    // versions the reviewer would have to choose between.
    db.prepare(`DELETE FROM project_contracts WHERE project_id = ?`).run(req.params.id);
    const result = db.prepare(`
      INSERT INTO project_contracts (project_id, file_name, file_blob, terms, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, file.originalname, file.buffer, JSON.stringify(storedTerms), req.body.created_by || null);

    res.json({ id: result.lastInsertRowid, file_name: file.originalname, terms: storedTerms });
  } catch (err) {
    console.error('Contract extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// The extraction is a model reading a legal document — it can be wrong. Let the PM
// correct the terms once, rather than re-litigating a bad flag every month.
router.patch('/project/:id/contract', (req, res) => {
  const row = db.prepare(`SELECT id FROM project_contracts WHERE project_id=? ORDER BY created_at DESC LIMIT 1`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No contract on file for this project' });
  if (!req.body.terms) return res.status(400).json({ error: 'terms is required' });

  db.prepare(`
    UPDATE project_contracts SET terms=?, terms_edited=1, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(req.body.terms), row.id);
  res.json({ success: true });
});

router.delete('/project/:id/contract', (req, res) => {
  db.prepare(`DELETE FROM project_contracts WHERE project_id=?`).run(req.params.id);
  res.json({ success: true });
});

router.get('/project/:id/contract/original.pdf', (req, res) => {
  const row = db.prepare(`
    SELECT file_name, file_blob FROM project_contracts WHERE project_id=?
    ORDER BY created_at DESC LIMIT 1
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(Buffer.from(row.file_blob));
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
    let contractTerms = null;
    if (projectId) {
      const contractRow = db.prepare(`
        SELECT terms FROM project_contracts WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(projectId);
      if (contractRow) contractTerms = JSON.parse(contractRow.terms);
    }
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
    const results = runChecks(data);

    // Advisory half: read the pay app (and any separate backup) against the contract's
    // tax status and unallowable items. Never let this sink the review — the math checks
    // above are the load-bearing part and have already succeeded.
    let compliance = null;
    if (contractTerms) {
      try {
        compliance = await scanCompliance({
          payAppBuffer: currentFile.buffer,
          backupBuffers: backupFiles.map(f => f.buffer),
          contractTerms,
        });
      } catch (err) {
        console.error('Compliance scan failed (review continues):', err.message);
        compliance = {
          taxFindings: [], unallowableFindings: [], backupCoverage: null,
          notes: `The contract compliance scan could not be completed (${friendlyAiError(err)}). The math checks are unaffected.`,
          incomplete: true,
        };
      }
    }

    const report = buildReport({ data, results, compliance, contractTerms });

    const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    const insertResult = db.prepare(`
      INSERT INTO pay_app_reviews (
        project_name, application_number, period_to, contract_sum_to_date,
        total_completed_to_date, current_payment_due, balance_to_finish,
        extracted_data, checks_result, report_markdown,
        current_file_name, current_file, previous_review_id,
        contract_sum, co_log, critical_count, fail_count, created_by, project_id,
        compliance_findings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      currentFile.originalname, currentFile.buffer,
      previousReviewId,
      originalContractSum,
      changeOrderLog ? JSON.stringify(changeOrderLog) : null,
      criticalCount, failCount,
      req.body.created_by || null,
      projectId,
      compliance ? JSON.stringify(compliance) : null
    );

    res.json({ id: insertResult.lastInsertRowid, projectId, report, results });
  } catch (err) {
    console.error('Pay app review error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, project_name } = req.query;
  let sql = `SELECT id, project_name, application_number, period_to, contract_sum_to_date,
             total_completed_to_date, current_payment_due, balance_to_finish,
             critical_count, fail_count, created_by, created_at
             FROM pay_app_reviews WHERE 1=1`;
  const params = [];
  if (project_name) { sql += ' AND project_name = ?'; params.push(project_name); }
  if (search) { sql += ' AND project_name LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pay_app_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extractedData = JSON.parse(row.extracted_data);
  res.json({
    ...row,
    current_file: undefined,
    extracted_data: extractedData,
    checks_result: JSON.parse(row.checks_result),
    checklist: buildSiteVerificationChecklist(extractedData.current, extractedData.previous),
    co_log: row.co_log ? JSON.parse(row.co_log) : null,
    compliance_findings: row.compliance_findings ? JSON.parse(row.compliance_findings) : null,
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = db.prepare('SELECT project_name, application_number, report_markdown FROM pay_app_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown);
});

// Client-facing PDF of the review, on Olivier letterhead. Rebuilt from the stored
// extraction + check results (not the markdown) so it can never drift from what
// the reviewer saw on screen. No AI call — pure rendering.
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM pay_app_reviews WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const data = JSON.parse(row.extracted_data);
    const results = JSON.parse(row.checks_result);
    const report = buildReport({
      data, results,
      compliance: row.compliance_findings ? JSON.parse(row.compliance_findings) : null,
    });

    // Reuse the letterhead the user maintains on their default memo template, so
    // editing the address in Settings updates this report too.
    const tpl = db.prepare(
      `SELECT company_name FROM memo_templates ORDER BY is_default DESC, id ASC LIMIT 1`
    ).get();

    const pdf = await renderPayAppReportPdf({ report, companyName: tpl?.company_name || 'Olivier Inc.' });
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
  const row = db.prepare('SELECT * FROM pay_app_reviews WHERE id=?').get(req.params.id);
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

router.get('/:id/original.pdf', (req, res) => {
  const row = db.prepare('SELECT current_file_name, current_file FROM pay_app_reviews WHERE id=?').get(req.params.id);
  if (!row || !row.current_file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.current_file_name}"`);
  res.send(Buffer.from(row.current_file));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM pay_app_reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
