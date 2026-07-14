const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePayApps } = require('../lib/payAppExtract');
const { runChecks } = require('../lib/payAppChecks');
const { buildReport } = require('../lib/payAppReport');
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

// Look up the most recent stored review for a project, to use as "previous application"
// without requiring the user to re-upload the prior PDF.
router.get('/latest-for-project', (req, res) => {
  const { project_name } = req.query;
  if (!project_name) return res.status(400).json({ error: 'project_name is required' });
  const row = db.prepare(`
    SELECT id, application_number, period_to, extracted_data
    FROM pay_app_reviews WHERE project_name = ?
    ORDER BY application_number DESC, created_at DESC LIMIT 1
  `).get(project_name);
  if (!row) return res.json(null);
  const extracted = JSON.parse(row.extracted_data);
  res.json({ id: row.id, applicationNumber: row.application_number, periodTo: row.period_to, current: extracted.current });
});

router.post('/', upload.single('current_file'), async (req, res) => {
  try {
    const currentFile = req.file;
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
    const originalContractSum = req.body.original_contract_sum ? parseFloat(req.body.original_contract_sum) : null;
    let changeOrderLog = null;
    if (req.body.co_log_csv) changeOrderLog = parseCoLogCsv(req.body.co_log_csv);
    else if (req.body.co_log_json) changeOrderLog = JSON.parse(req.body.co_log_json);
    if (originalContractSum != null || changeOrderLog) {
      contract = { originalContractSum, changeOrderLog };
    }

    let retainagePolicy = null;
    if (req.body.retainage_rate) {
      retainagePolicy = {
        rate: parseFloat(req.body.retainage_rate),
        reductionMilestonePct: req.body.retainage_milestone_pct ? parseFloat(req.body.retainage_milestone_pct) : null,
        reducedRate: req.body.retainage_reduced_rate ? parseFloat(req.body.retainage_reduced_rate) : null,
      };
    }

    const data = { current, previous, contract, retainagePolicy };
    const results = runChecks(data);
    const report = buildReport({ data, results });

    const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    const insertResult = db.prepare(`
      INSERT INTO pay_app_reviews (
        project_name, application_number, period_to, contract_sum_to_date,
        total_completed_to_date, current_payment_due, balance_to_finish,
        extracted_data, checks_result, report_markdown,
        current_file_name, current_file, previous_review_id,
        contract_sum, co_log, critical_count, fail_count, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      req.body.created_by || null
    );

    res.json({ id: insertResult.lastInsertRowid, report, results });
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
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = db.prepare('SELECT project_name, application_number, report_markdown FROM pay_app_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PayApp_${row.application_number || row.id}_${(row.project_name || 'report').replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(row.report_markdown);
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
