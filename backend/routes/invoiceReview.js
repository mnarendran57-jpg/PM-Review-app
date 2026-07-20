const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzeInvoices } = require('../lib/invoiceExtract');
const { runInvoiceChecks } = require('../lib/invoiceChecks');
const { buildInvoiceReport } = require('../lib/invoiceReport');
const { friendlyAiError } = require('../lib/aiErrors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 100 },
});

// One-shot analysis: extract the invoice(s) in a single AI call, then run the
// deterministic checks in code. The project's stored contract terms feed the tax,
// unallowable-item, and reimbursable-backup checks — the contract PDF itself is never
// re-sent. The uploaded set is one primary invoice plus any backup receipts/invoices.
router.post('/', upload.array('invoices', 100), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'At least one invoice PDF is required' });
    const nonPdf = files.find(f => f.mimetype !== 'application/pdf');
    if (nonPdf) return res.status(400).json({ error: `Every file must be a PDF (${nonPdf.originalname} is not)` });

    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    let contractTerms = null;
    if (projectId) {
      const contractRow = db.prepare(`
        SELECT terms FROM project_contracts WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId);
      if (contractRow) contractTerms = JSON.parse(contractRow.terms);
    }

    const { invoice, observations } = await analyzeInvoices({
      invoiceBuffers: files.map(f => f.buffer),
      contractTerms,
    });

    const data = { invoice, contractTerms };
    const results = runInvoiceChecks(data);
    const report = buildInvoiceReport({ data, results, observations });

    const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    const insert = db.prepare(`
      INSERT INTO invoice_reviews (
        project_id, vendor, invoice_number, invoice_date, total_amount,
        extracted_data, checks_result, ai_observations, report_markdown,
        critical_count, fail_count, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      invoice.vendor || null,
      invoice.invoiceNumber || null,
      invoice.invoiceDate || null,
      invoice.total ?? null,
      JSON.stringify({ invoice }),
      JSON.stringify(results),
      JSON.stringify(observations),
      report.markdown,
      criticalCount, failCount,
      req.body.created_by || null
    );
    const reviewId = insert.lastInsertRowid;

    const insertFile = db.prepare(`
      INSERT INTO invoice_review_files (review_id, file_name, mime_type, file_blob)
      VALUES (?, ?, ?, ?)
    `);
    for (const f of files) insertFile.run(reviewId, f.originalname, f.mimetype, f.buffer);

    res.json({ id: reviewId, report, results });
  } catch (err) {
    console.error('Invoice review error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

router.get('/', (req, res) => {
  const { project_id, search } = req.query;
  let sql = `SELECT id, project_id, vendor, invoice_number, invoice_date, total_amount,
             critical_count, fail_count, created_by, created_at
             FROM invoice_reviews WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) { sql += ' AND (vendor LIKE ? OR invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM invoice_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extracted = JSON.parse(row.extracted_data);
  const results = JSON.parse(row.checks_result);
  const observations = row.ai_observations ? JSON.parse(row.ai_observations) : {};
  const report = buildInvoiceReport({
    data: { invoice: extracted.invoice, contractTerms: null },
    results, observations,
  });
  const attachments = db.prepare(
    'SELECT id, file_name, mime_type FROM invoice_review_files WHERE review_id=?'
  ).all(row.id);
  res.json({
    ...row,
    extracted_data: extracted,
    checks_result: results,
    report,
    files: attachments,
  });
});

router.get('/:id/report.md', (req, res) => {
  const row = db.prepare('SELECT vendor, invoice_number, report_markdown FROM invoice_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stem = (row.invoice_number || row.vendor || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_');
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Invoice_${stem}_Review.md"`);
  res.send(row.report_markdown);
});

router.get('/:id/files/:fileId', (req, res) => {
  const row = db.prepare(
    'SELECT file_name, mime_type, file_blob FROM invoice_review_files WHERE id=? AND review_id=?'
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(Buffer.from(row.file_blob));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM invoice_reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
