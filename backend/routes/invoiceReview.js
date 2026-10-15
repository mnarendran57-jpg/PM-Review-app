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
const { clauseFor } = require('../lib/contractClauses');
const { readAgreements, labelAll } = require('../lib/agreementSet');
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

// Ids arrive as a JSON array from the form; a bare comma-separated string is tolerated so a
// hand-made request is not silently ignored.
function parseIdList(raw) {
  if (raw == null || raw === '') return [];
  let ids = raw;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { ids = ids.split(','); }
  }
  return (Array.isArray(ids) ? ids : [ids]).map(Number).filter(n => Number.isInteger(n) && n > 0);
}

// What the PM chose to check the invoice against: the architect's agreement, the contractor's, or
// neither ("math checks"). `checks` is a JSON list holding at most one of 'architect' and
// 'contractor'; an empty list is the math alone. Null when the request does not say — one from before
// the choice existed — which is then decided by contract_id as it always was.
const AGREEMENTS = ['architect', 'contractor'];
function agreementRequested(body) {
  if (body.checks === undefined) return undefined;
  let list;
  try { list = JSON.parse(body.checks); } catch { list = String(body.checks).split(','); }
  return (Array.isArray(list) ? list : []).find(k => AGREEMENTS.includes(k)) || null;
}

// One-shot analysis: extract the invoice(s) in a single AI call, then run the
// deterministic checks in code. The agreement's stored terms feed the tax, unallowable-item,
// PO and billing checks — the contract PDF itself is never re-sent once read. The uploaded set
// is one primary invoice plus any backup receipts/invoices.
router.post('/', upload.fields([
  { name: 'invoices', maxCount: 100 }, { name: 'contract_files', maxCount: 20 }, { name: 'contract_file', maxCount: 1 },
]), async (req, res) => {
  try {
    const files = req.files?.invoices || [];
    if (files.length === 0) return res.status(400).json({ error: 'At least one invoice PDF is required' });
    const nonPdf = files.find(f => f.mimetype !== 'application/pdf');
    if (nonPdf) return res.status(400).json({ error: `Every file must be a PDF (${nonPdf.originalname} is not)` });
    // Agreements uploaded for this review alone — a contract, a PO, or both.
    const contractFiles = [...(req.files?.contract_files || []), ...(req.files?.contract_file || [])];
    const notPdf = contractFiles.find(f => f.mimetype !== 'application/pdf');
    if (notPdf) return res.status(400).json({ error: `${notPdf.originalname} is not a PDF — only PDFs can be read.` });

    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    const agreement = agreementRequested(req.body);
    // The filed agreements chosen: contract_ids, a list, or contract_id, the single one a request from
    // before several could be chosen sends.
    const chosenIds = [
      ...(projectId ? parseIdList(req.body.contract_ids) : []),
      ...(req.body.contract_id ? [Number(req.body.contract_id)] : []),
    ].filter((id, i, all) => all.indexOf(id) === i);

    // Which agreements this invoice is checked against. A project has several — the architect's, the
    // general contractor's, a PO beside a contract — so the reviewer picks, and an architect's
    // invoice is never measured against the contractor's terms. A request that names none falls back
    // to the project's primary contract, which is what a one-contract project wants.
    //
    // A contract_id sent empty is the PM choosing no contract at all — "check the maths only" — and
    // is honoured as that. The fallback is only for a request that does not mention one.
    const SELECT = `SELECT id, label, file_name, terms, doc_type, terms_status, file_key, file_blob, party, party_role
                    FROM project_contracts`;
    let contractRows = [];
    const chosenNone = agreement === null
      || (agreement === undefined && 'contract_id' in req.body && !req.body.contract_id && chosenIds.length === 0);
    if (projectId && !chosenNone) {
      if (chosenIds.length) {
        const find = db.prepare(`${SELECT} WHERE id = ? AND project_id = ? AND doc_type IN (${GOVERNING_SQL})`);
        contractRows = chosenIds.map(id => find.get(id, projectId));
        // An id that is not this project's is a mistake worth surfacing, not something to skip.
        if (contractRows.some(r => !r)) return res.status(400).json({ error: 'That contract is not on this project.' });
      } else if (contractFiles.length === 0) {
        const primary = db.prepare(`${SELECT} WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
                                    ORDER BY is_primary DESC, created_at ASC LIMIT 1`).get(projectId);
        if (primary) contractRows = [primary];
      }
    }
    if (agreement && contractRows.length === 0 && contractFiles.length === 0) {
      return res.status(400).json({ error: `Choose the ${agreement}'s contract or PO, or upload it.` });
    }
    const chosen = contractRows.length > 0 || contractFiles.length > 0;
    const contractLabel = labelAll({ rows: contractRows, files: contractFiles });

    // The reading does not happen on this request. Everything above is cheap and has already
    // answered where it needed to; what follows takes as long as the package is long, held the
    // connection open throughout, and was lost without trace whenever the service restarted
    // mid-read or the browser gave up waiting.
    const jobId = jobs.startFrom(req, 'invoice-review', async () => {
      try {
        // Several agreements are checked as one set of terms; see lib/agreementSet.js.
        const { terms: contractTerms, valueFrom } = await readAgreements({ rows: contractRows, files: contractFiles });

        const { invoice, observations } = await analyzeInvoices({
          invoiceBuffers: files.map(f => f.buffer),
          contractTerms,
        });
        // Each of Coaster's contract flags keeps the clause it quoted, found now while the clauses
        // are to hand: a stored review is rebuilt without them.
        if (contractTerms && Array.isArray(observations.contractConcerns)) {
          observations.contractConcerns = observations.contractConcerns.map(c => (c && typeof c === 'object'
            ? { ...c, clause: clauseFor(c, contractTerms) } : c));
        }

        const data = {
          invoice, contractTerms,
          duplicates: earlierReviewsOf(req, projectId, invoice),
          // Billed so far is counted against the agreement whose value is used — the PO, where one
          // states it.
          billing: chosen && valueFrom ? billedAgainst(req, valueFrom.id, contractTerms, invoice) : null,
        };
        const results = runInvoiceChecks(data, {
          groups: ['math', 'backup', 'history', ...(chosen ? ['contract'] : [])],
        });
        const report = buildInvoiceReport({
          data, results, observations, contractChosen: chosen, contractLabel, agreement: agreement || null,
        });

        const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
        const failCount = results.filter(r => r.status === 'FAIL').length;

        const insert = db.prepare(`
          INSERT INTO invoice_reviews (
            org_id, project_id, contract_id, contract_label, checked_against, vendor, invoice_number, invoice_date, total_amount,
            extracted_data, checks_result, ai_observations, report_markdown,
            critical_count, fail_count, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.orgId, projectId,
          // The agreement the billing is counted against, so the next invoice adds to the same total.
          (valueFrom?.id ?? contractRows[0]?.id) ?? null,
          contractLabel,
          JSON.stringify({ agreement: agreement || null, contract: chosen, agreementIds: contractRows.map(r => r.id) }),
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
// An agreement uploaded for one review is not filed, so nothing was billed against it before.
function billedAgainst(req, contractId, contractTerms, invoice) {
  const value = Number(contractTerms?.originalContractSum) || Number(contractTerms?.clauses?.contractSum?.amount);
  if (!(value > 0)) return null;
  const rows = contractId == null ? [] : db.prepare(
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
  // What the PM chose; a review from before the choice was checked against a contract if it named one.
  let checked = null;
  try { checked = row.checked_against ? JSON.parse(row.checked_against) : null; } catch { checked = null; }
  return buildInvoiceReport({
    data: { invoice: extracted.invoice, contractTerms: null },
    results: JSON.parse(row.checks_result),
    observations: row.ai_observations ? JSON.parse(row.ai_observations) : {},
    contractChosen: checked ? !!checked.contract : row.contract_id != null,
    contractLabel: row.contract_label || null,
    agreement: checked?.agreement || null,
  });
}

// The files as uploaded, in order, for the marked-up pages. One that cannot be read back is left out.
async function sourcesOf(row) {
  const files = db.prepare(
    'SELECT file_name, file_key, file_blob FROM invoice_review_files WHERE review_id=? ORDER BY id'
  ).all(row.id);
  const out = [];
  for (const f of files) {
    const buffer = await storage.readFile({ key: f.file_key, blob: f.file_blob }).catch(() => null);
    if (buffer && buffer.length) out.push({ name: f.file_name, buffer });
  }
  return out;
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
    const pdf = await renderInvoiceReportPdf({ report: reportFor(row), sources: await sourcesOf(row) });
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
