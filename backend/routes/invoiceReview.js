const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzeInvoices } = require('../lib/invoiceExtract');
const { runInvoiceChecks } = require('../lib/invoiceChecks');
const { buildInvoiceReport } = require('../lib/invoiceReport');
const { renderInvoiceReportPdf } = require('../lib/invoiceReportPdf');
const { friendlyAiError } = require('../lib/aiErrors');
const { GOVERNING_SQL } = require('../lib/docTypes');
const { ensureTermsRead } = require('../lib/contractTerms');
const storage = require('../lib/storage');
const jobs = require('../lib/jobs');


const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');

// Scoped to one organization; within it a member sees only projects they belong to.
// Applied to the whole router so a new endpoint cannot silently skip it.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('invoice-review'));

// Loads a row only if the caller may see it, else null -> the caller answers 404 rather
// than 403 so ids cannot be probed. Always selects the whole row, because the check needs
// org_id and project_id.
function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM invoice_reviews WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 100 },
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
    const contractId = req.body.contract_id ? Number(req.body.contract_id) : null;

    // Which agreement this invoice is checked against. A project has several — the
    // architect's, the general contractor's — so the reviewer picks, and an architect's
    // invoice is never measured against the contractor's terms. Falls back to the project's
    // primary contract when nothing is chosen, which is what a one-contract project wants.
    //
    // A contract_id sent empty is the PM choosing no contract at all — "check the maths only" — and
    // is honoured as that. The fallback is only for a request that does not mention one.
    let contractTerms = null;
    let contractRow = null;
    const chosenNone = 'contract_id' in req.body && !req.body.contract_id;
    if (projectId && !chosenNone) {
      contractRow = contractId
        ? db.prepare(`
            SELECT id, label, file_name, terms, doc_type, terms_status, file_key, file_blob,
                   party, party_role
            FROM project_contracts
            WHERE id = ? AND project_id = ? AND doc_type IN (${GOVERNING_SQL})
          `).get(contractId, projectId)
        : db.prepare(`
            SELECT id, label, file_name, terms, doc_type, terms_status, file_key, file_blob,
                   party, party_role
            FROM project_contracts
            WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
            ORDER BY is_primary DESC, created_at ASC LIMIT 1
          `).get(projectId);

      // A contract id that is not this project's is a mistake worth surfacing, not silently
      // swapping for a different contract.
      if (contractId && !contractRow) {
        return res.status(400).json({ error: 'That contract is not on this project.' });
      }
    }

    // The reading does not happen on this request. Everything above is cheap and has already
    // answered where it needed to; what follows takes as long as the package is long, held the
    // connection open throughout, and was lost without trace whenever the service restarted
    // mid-read or the browser gave up waiting.
    const jobId = jobs.startFrom(req, 'invoice-review', async () => {
      try {
        // Read on first use rather than at upload, so filing a contract costs nothing and a
        // contract nobody invoices against is never read.
        if (contractRow) contractTerms = await ensureTermsRead(contractRow);

        const { invoice, observations } = await analyzeInvoices({
          invoiceBuffers: files.map(f => f.buffer),
          contractTerms,
        });

        const data = {
          invoice, contractTerms,
          duplicates: earlierReviewsOf(req, projectId, invoice),
          billing: contractRow ? billedAgainst(req, contractRow.id, contractTerms, invoice) : null,
        };
        const results = runInvoiceChecks(data, {
          groups: ['math', 'backup', 'history', ...(contractRow ? ['contract'] : [])],
        });
        const contractLabel = contractRow ? (contractRow.label || contractRow.file_name) : null;
        const report = buildInvoiceReport({ data, results, observations, contractChosen: !!contractRow, contractLabel });

        const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
        const failCount = results.filter(r => r.status === 'FAIL').length;

        const insert = db.prepare(`
          INSERT INTO invoice_reviews (
            org_id, project_id, contract_id, contract_label, vendor, invoice_number, invoice_date, total_amount,
            extracted_data, checks_result, ai_observations, report_markdown,
            critical_count, fail_count, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.orgId, projectId,
          contractRow?.id ?? null,
          contractRow ? (contractRow.label || contractRow.file_name) : null,
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
          INSERT INTO invoice_review_files (review_id, file_name, mime_type, file_key, file_blob)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const f of files) {
          const { key } = await storage.storeFile('invoice', f.buffer, f.mimetype, f.originalname);
          insertFile.run(reviewId, f.originalname, f.mimetype, key, key ? Buffer.alloc(0) : f.buffer);
        }

        return { id: reviewId, report, results };
      } catch (err) {
        console.error('invoice-review failed:', err);
        err.friendlyMessage = friendlyAiError(err);
        throw err;
      }
    });
    res.status(202).json({ jobId });
  } catch (err) {
    console.error('Invoice review error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

const sameText = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// The vendor's first real word: "Brazos Valley Constructors" and "Brazos Valley Constructors, Inc."
// are one vendor, and "The" is nobody's name.
const firstWord = v => sameText(String(v || '').split(/\s+/).find(w => !/^(the|a|an)$/i.test(w)) || '');

// Earlier reviews that look like the same invoice: the same vendor and invoice number, or — for a
// bill with no number, or one renumbered when it was sent again — the same vendor, date and total.
// Within the project when there is one, else the organization, and never across organizations.
function earlierReviewsOf(req, projectId, invoice) {
  const rows = projectId
    ? db.prepare(`SELECT id, vendor, invoice_number, invoice_date, total_amount, created_at FROM invoice_reviews WHERE org_id=? AND project_id=?`).all(req.orgId, projectId)
    : db.prepare(`SELECT id, vendor, invoice_number, invoice_date, total_amount, created_at FROM invoice_reviews WHERE org_id=?`).all(req.orgId);
  const vendor = firstWord(invoice.vendor);
  const number = sameText(invoice.invoiceNumber);
  return rows
    .filter(r => vendor && firstWord(r.vendor) === vendor)
    .filter(r => (number && sameText(r.invoice_number) === number)
      || (invoice.invoiceDate && r.invoice_date === invoice.invoiceDate
        && typeof invoice.total === 'number' && Math.abs((r.total_amount ?? NaN) - invoice.total) < 0.01))
    .map(r => ({
      id: r.id, invoiceNumber: r.invoice_number, total: r.total_amount, invoiceDate: r.invoice_date,
      reviewedOn: String(r.created_at || '').slice(0, 10),
    }));
}

// What has already been billed against an agreement, as far as Coaster knows: the totals of the
// invoices reviewed against it before. An invoice reviewed twice counts once — the same vendor and
// number is one bill, whichever review of it was the last — and this one, if it was reviewed
// before, does not count against itself.
function billedAgainst(req, contractId, contractTerms, invoice) {
  const value = Number(contractTerms?.originalContractSum);
  if (!(value > 0)) return null;
  const rows = db.prepare(
    `SELECT vendor, invoice_number, invoice_date, total_amount FROM invoice_reviews WHERE org_id=? AND contract_id=?`
  ).all(req.orgId, contractId);
  const keyOf = r => `${firstWord(r.vendor)}|${sameText(r.invoice_number) || `${r.invoice_date}|${r.total_amount}`}`;
  const thisKey = keyOf({ vendor: invoice.vendor, invoice_number: invoice.invoiceNumber, invoice_date: invoice.invoiceDate, total_amount: invoice.total });
  const seen = new Map();
  for (const r of rows) if (keyOf(r) !== thisKey) seen.set(keyOf(r), Number(r.total_amount) || 0);
  return {
    contractValue: value,
    priorBilled: [...seen.values()].reduce((a, b) => a + b, 0),
    priorCount: seen.size,
  };
}

// The report a stored review renders as, on screen and in the PDF alike.
function reportFor(row) {
  const extracted = JSON.parse(row.extracted_data);
  return buildInvoiceReport({
    data: { invoice: extracted.invoice, contractTerms: null },
    results: JSON.parse(row.checks_result),
    observations: row.ai_observations ? JSON.parse(row.ai_observations) : {},
    contractChosen: row.contract_id != null,
    contractLabel: row.contract_label || null,
  });
}

router.get('/', (req, res) => {
  const { project_id, search } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_id, contract_label, vendor, invoice_number, invoice_date, total_amount,
             critical_count, fail_count, created_by, created_at
             FROM invoice_reviews WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) { sql += ' AND (vendor LIKE ? OR invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extracted = JSON.parse(row.extracted_data);
  const results = JSON.parse(row.checks_result);
  const report = reportFor(row);
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

router.get('/:id/report.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const pdf = await renderInvoiceReportPdf({ report: reportFor(row) });
    const stem = (row.invoice_number || row.vendor || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${stem}_Review.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Invoice report PDF error:', err);
    res.status(500).json({ error: 'The report could not be produced.' });
  }
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stem = (row.invoice_number || row.vendor || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_');
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="Invoice_${stem}_Review.md"`);
  res.send(row.report_markdown);
});

router.get('/:id/files/:fileId', async (req, res) => {
  if (!visibleRow(req)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(
    'SELECT file_name, mime_type, file_key, file_blob FROM invoice_review_files WHERE id=? AND review_id=?'
  ).get(req.params.fileId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  if (!visibleRow(req)) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare('SELECT file_key FROM invoice_review_files WHERE review_id=? AND file_key IS NOT NULL')
    .all(req.params.id).map(r => r.file_key);
  db.prepare('DELETE FROM invoice_reviews WHERE id=?').run(req.params.id);
  await storage.remove(keys);
  res.json({ success: true });
});

module.exports = router;
