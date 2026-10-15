const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePco } = require('../lib/pcoExtract');
const { runPcoChecks } = require('../lib/pcoChecks');
const { buildPcoReport } = require('../lib/pcoReport');
const { findAlternatives, alternativesView } = require('../lib/pcoAlternatives');
const { friendlyAiError } = require('../lib/aiErrors');
const { GOVERNING_SQL } = require('../lib/docTypes');
const { clauseFor } = require('../lib/contractClauses');
const { readAgreements, labelAll } = require('../lib/agreementSet');
const { renderPcoReportPdf } = require('../lib/pcoReportPdf');
const { rfiReference } = require('../lib/pcoRfiReference');
const storage = require('../lib/storage');
const jobs = require('../lib/jobs');


const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');

// Scoped to one organization; within it a member sees only projects they belong to.
// Applied to the whole router so a new endpoint cannot silently skip it.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('pco-review'));

// Loads a row only if the caller may see it, else null -> the caller answers 404 rather
// than 403 so ids cannot be probed. Always selects the whole row, because the check needs
// org_id and project_id.
function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM pco_reviews WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 12 },
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

// What the PM asked for the change order to be checked against. The math is always checked; the
// contract and the RFI/ASI only when asked. A request from before the PM could choose sends no
// `checks` and gets what it always got: the contract when one is named or on file, the RFI/ASI when
// one is attached.
function checksRequested(body) {
  if (body.checks == null) return null;
  let list = body.checks;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list.split(','); }
  }
  const set = new Set((Array.isArray(list) ? list : [list]).map(String));
  return { contract: set.has('contract'), reference: set.has('reference') };
}

// One-shot analysis: extract the PCO (and its generating RFI/ASI, if supplied) in a
// single AI call, then run the deterministic checks in code. The project's stored
// contract terms feed the tax / markup / unallowable-item checks — the contract PDF
// itself is never re-sent.
router.post('/', upload.fields([
  { name: 'pco_file', maxCount: 1 },
  // The RFI(s) or ASI(s), uploaded for this review alone. `reference_file` is the single one a
  // page from before several could be given still sends.
  { name: 'reference_files', maxCount: 6 },
  { name: 'reference_file', maxCount: 1 },
  // Agreements uploaded for this review alone, rather than chosen from Shared Documents — a contract,
  // a PO, or both. contract_file is the single one a page from before several could be given sends.
  { name: 'contract_files', maxCount: 20 },
  { name: 'contract_file', maxCount: 1 },
]), async (req, res) => {
  try {
    const pcoFile = req.files?.pco_file?.[0];
    if (!pcoFile) return res.status(400).json({ error: 'PCO PDF is required' });
    if (pcoFile.mimetype !== 'application/pdf') return res.status(400).json({ error: 'PCO must be a PDF' });

    const uploadedRefs = [...(req.files?.reference_files || []), ...(req.files?.reference_file || [])];
    const contractFiles = [...(req.files?.contract_files || []), ...(req.files?.contract_file || [])];
    for (const f of [...uploadedRefs, ...contractFiles]) {
      if (f.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: `${f.originalname} is not a PDF — only PDFs can be read.` });
      }
    }

    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    const requested = checksRequested(req.body);
    // The filed agreements chosen: contract_ids, a list, or contract_id, the single one a page from
    // before several could be chosen sends.
    const chosenIds = [
      ...(projectId ? parseIdList(req.body.contract_ids) : []),
      ...(req.body.contract_id ? [Number(req.body.contract_id)] : []),
    ].filter((id, i, all) => all.indexOf(id) === i);

    // Which agreements this change order is measured against. A project carries several — the
    // architect's, the general contractor's, a PO beside a contract — and the markup ceiling and
    // unallowable-item list differ between them, so the reviewer picks, as many as apply. A request
    // that does not say falls back to the project's primary contract, which is what a single-contract
    // job wants.
    const SELECT = `SELECT id, label, file_name, terms, doc_type, terms_status, file_key, file_blob, party, party_role
                    FROM project_contracts`;
    let contractRows = [];
    const wantsContract = requested ? requested.contract : true;
    if (projectId && wantsContract) {
      if (chosenIds.length) {
        const find = db.prepare(`${SELECT} WHERE id = ? AND project_id = ? AND doc_type IN (${GOVERNING_SQL})`);
        contractRows = chosenIds.map(id => find.get(id, projectId));
        // An id belonging to another project is a mistake worth surfacing, not something to skip.
        if (contractRows.some(r => !r)) return res.status(400).json({ error: 'That contract is not on this project.' });
      } else if (!requested && contractFiles.length === 0) {
        const primary = db.prepare(`${SELECT} WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
                                    ORDER BY is_primary DESC, created_at ASC LIMIT 1`).get(projectId);
        if (primary) contractRows = [primary];
      }
    }
    if (requested?.contract && contractRows.length === 0 && contractFiles.length === 0) {
      return res.status(400).json({ error: 'Choose the contract to check against, or upload one.' });
    }

    // The RFI(s) or ASI(s) chosen from the project's Shared Documents, scoped to this project inside
    // the query so an id from elsewhere reads as missing.
    const referenceIds = projectId ? parseIdList(req.body.reference_ids) : [];
    const findDoc = db.prepare(
      `SELECT file_name, file_key, file_blob FROM project_contracts WHERE id=? AND project_id=?`
    );
    const sharedRefs = [];
    for (const id of referenceIds) {
      const doc = findDoc.get(id, projectId);
      if (!doc) continue;
      const buffer = await storage.readFile({ key: doc.file_key, blob: doc.file_blob });
      if (buffer) sharedRefs.push({ name: doc.file_name, buffer });
    }
    // RFIs chosen from the project's RFI Log, each as its log entry plus the front of its files.
    const fromLog = [];
    for (const id of projectId ? parseIdList(req.body.rfi_ids) : []) {
      const ref = await rfiReference(id, projectId);
      if (ref) fromLog.push(ref);
    }
    const references = [
      ...fromLog,
      ...uploadedRefs.map(f => ({ name: f.originalname, buffer: f.buffer })),
      ...sharedRefs,
    ];
    if (requested?.reference && references.length === 0) {
      return res.status(400).json({ error: 'Choose the RFI or ASI to check against, or upload it.' });
    }

    const checkedAgainst = requested || { contract: contractRows.length > 0 || contractFiles.length > 0, reference: references.length > 0 };
    const contractLabel = labelAll({ rows: contractRows, files: contractFiles });

    // The reading no longer happens on this request. Everything above is cheap and has
    // already answered where it needed to; what follows takes minutes, held the connection
    // open throughout, and was lost without trace whenever the service restarted mid-read.
    const jobId = jobs.startFrom(req, 'pco-review', async () => {
      try {
      // The agreements' terms, read as one set when there are several; see lib/agreementSet.js.
      const { terms: contractTerms } = checkedAgainst.contract
        ? await readAgreements({ rows: contractRows, files: contractFiles })
        : { terms: null };

      const { pco, reference, observations } = await analyzePco({
        pcoBuffer: pcoFile.buffer,
        referenceBuffers: checkedAgainst.reference ? references.map(r => r.buffer) : [],
        contractTerms: checkedAgainst.contract ? contractTerms : null,
      });

      // Each of Coaster's contract flags keeps the clause it quoted, found now while the contract's
      // clauses are to hand: a stored review is rebuilt without them.
      if (contractTerms && Array.isArray(observations.contractConcerns)) {
        observations.contractConcerns = observations.contractConcerns.map(c => (c && typeof c === 'object'
          ? { ...c, clause: clauseFor(c, contractTerms) } : c));
      }

      // The uploader knows better than the document whether this is an allowance —
      // an explicit flag from the form overrides the model's reading.
      if (req.body.is_allowance === 'true') pco.isAllowance = true;
      if (req.body.is_allowance === 'false') pco.isAllowance = false;

      const data = { pco, contractTerms, markupPolicy: null };
      const results = runPcoChecks(data, {
        groups: ['math', 'backup', ...(checkedAgainst.contract ? ['contract'] : [])],
      });

      // Whether there is another way to do what this prices — asked only where the change order
      // buys a product, and never allowed to cost the review itself. A change order that could not
      // be looked at for alternatives is still a change order whose price was checked.
      let alternativesFound = null;
      try {
        alternativesFound = await findAlternatives({ pco, reference });
      } catch (err) {
        console.error('[pco alternatives] skipped:', err.message);
      }
      const report = buildPcoReport({
        data, results, observations, reference,
        alternatives: alternativesView(alternativesFound),
        checkedAgainst, contractLabel,
      });

      const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
      const failCount = results.filter(r => r.status === 'FAIL').length;

      const pcoKey = (await storage.storeFile('pco', pcoFile.buffer, pcoFile.mimetype, pcoFile.originalname)).key;
      // The first uploaded RFI/ASI is kept with the review, as the single one always was.
      const firstRef = uploadedRefs[0] || null;
      const refKey = firstRef
        ? (await storage.storeFile('pco', firstRef.buffer, firstRef.mimetype, firstRef.originalname)).key
        : null;

      const insert = db.prepare(`
        INSERT INTO pco_reviews (
          org_id, project_id, contract_id, contract_label,
          pco_number, title, contractor, total_amount, is_allowance,
          extracted_data, checks_result, ai_observations, alternatives_json, checked_against, report_markdown,
          pco_file_name, pco_file, pco_file_key, reference_file_name, reference_file, reference_file_key,
          critical_count, fail_count, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.orgId, projectId,
        // Copied rather than joined, so a saved review still says whose terms it applied even
        // after that contract is renamed or removed.
        contractRows[0]?.id ?? null,
        contractLabel,
        pco.pcoNumber || null,
        pco.title || null,
        pco.contractor || null,
        pco.totalAmount ?? null,
        pco.isAllowance ? 1 : 0,
        JSON.stringify({ pco, reference }),
        JSON.stringify(results),
        JSON.stringify(observations),
        alternativesFound ? JSON.stringify(alternativesFound) : null,
        JSON.stringify(checkedAgainst),
        report.markdown,
        pcoFile.originalname, pcoKey ? Buffer.alloc(0) : pcoFile.buffer, pcoKey,
        firstRef?.originalname || null,
        firstRef ? (refKey ? Buffer.alloc(0) : firstRef.buffer) : null, refKey,
        criticalCount, failCount,
        req.body.created_by || null
      );

    return { id: insert.lastInsertRowid, report, results };
      } catch (err) {
        console.error('pco-review failed:', err);
        err.friendlyMessage = friendlyAiError(err);
        throw err;
      }
    });
    res.status(202).json({ jobId });
  } catch (err) {
    console.error('PCO review error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

router.get('/', (req, res) => {
  const { project_id, search } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_id, pco_number, title, contractor, total_amount, is_allowance,
             critical_count, fail_count, created_by, created_at
             FROM pco_reviews WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) { sql += ' AND (title LIKE ? OR pco_number LIKE ? OR contractor LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const extracted = JSON.parse(row.extracted_data);
  const results = JSON.parse(row.checks_result);
  const report = reportFor(row);
  res.json({
    ...row,
    pco_file: undefined,
    reference_file: undefined,
    alternatives_json: undefined,
    extracted_data: extracted,
    checks_result: results,
    report,
  });
});

// The report a stored review renders as, on screen and in the PDF alike.
function reportFor(row) {
  const extracted = JSON.parse(row.extracted_data);
  return buildPcoReport({
    data: { pco: extracted.pco, contractTerms: null },
    results: JSON.parse(row.checks_result),
    observations: row.ai_observations ? JSON.parse(row.ai_observations) : {},
    reference: extracted.reference,
    alternatives: alternativesView(row.alternatives_json ? JSON.parse(row.alternatives_json) : null),
    checkedAgainst: row.checked_against ? JSON.parse(row.checked_against) : null,
    contractLabel: row.contract_label || null,
    contractChosen: row.contract_id != null,
  });
}

const safeName = v => String(v || 'review').replace(/[^a-z0-9]+/gi, '_');

router.get('/:id/report.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    // The change order itself follows the report, marked up where the findings are.
    const original = await storage.readFile({ key: row.pco_file_key, blob: row.pco_file }).catch(() => null);
    const pco = JSON.parse(row.extracted_data).pco;
    const pdf = await renderPcoReportPdf({ report: reportFor(row), original, pco });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PCO_${safeName(row.pco_number || req.params.id)}_Review.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('PCO report PDF error:', err);
    res.status(500).json({ error: 'The report could not be produced.' });
  }
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PCO_${(row.pco_number || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_')}_Review.md"`);
  res.send(row.report_markdown);
});

router.get('/:id/original.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.pco_file_key, blob: row.pco_file });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.pco_file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM pco_reviews WHERE id=?').run(req.params.id);
  await storage.remove([row?.pco_file_key, row?.reference_file_key]);
  res.json({ success: true });
});

module.exports = router;
