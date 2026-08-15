const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePco } = require('../lib/pcoExtract');
const { runPcoChecks } = require('../lib/pcoChecks');
const { buildPcoReport } = require('../lib/pcoReport');
const { friendlyAiError } = require('../lib/aiErrors');
const { GOVERNING_SQL } = require('../lib/docTypes');
const { ensureTermsRead } = require('../lib/contractTerms');
const storage = require('../lib/storage');


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
  limits: { fileSize: 500 * 1024 * 1024 },
});

// One-shot analysis: extract the PCO (and its generating RFI/ASI, if supplied) in a
// single AI call, then run the deterministic checks in code. The project's stored
// contract terms feed the tax / markup / unallowable-item checks — the contract PDF
// itself is never re-sent.
router.post('/', upload.fields([
  { name: 'pco_file', maxCount: 1 },
  { name: 'reference_file', maxCount: 1 },
]), async (req, res) => {
  try {
    const pcoFile = req.files?.pco_file?.[0];
    if (!pcoFile) return res.status(400).json({ error: 'PCO PDF is required' });
    if (pcoFile.mimetype !== 'application/pdf') return res.status(400).json({ error: 'PCO must be a PDF' });

    const referenceFile = req.files?.reference_file?.[0];
    if (referenceFile && referenceFile.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'RFI/ASI must be a PDF' });
    }

    const projectId = req.body.project_id ? Number(req.body.project_id) : null;
    const contractId = req.body.contract_id ? Number(req.body.contract_id) : null;

    // Which agreement this change order is measured against. A project carries several — the
    // architect's, the general contractor's — and the markup ceiling and unallowable-item list
    // differ between them, so the reviewer picks. Falls back to the project's primary contract,
    // which is what a single-contract job wants.
    //
    // The old query took whichever row was newest and did not filter on doc_type, so a drawing
    // set uploaded after the contract could be read as the contract.
    let contractTerms = null;
    let contractRow = null;
    if (projectId) {
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

      // A contract id belonging to another project is a mistake worth surfacing, not something
      // to silently swap for a different agreement.
      if (contractId && !contractRow) {
        return res.status(400).json({ error: 'That contract is not on this project.' });
      }
      // Read on first use rather than at upload, so filing a contract costs nothing and a
      // contract no change order is measured against is never read.
      if (contractRow) contractTerms = await ensureTermsRead(contractRow);
    }

    const { pco, reference, observations } = await analyzePco({
      pcoBuffer: pcoFile.buffer,
      referenceBuffer: referenceFile?.buffer,
      contractTerms,
    });

    // The uploader knows better than the document whether this is an allowance —
    // an explicit flag from the form overrides the model's reading.
    if (req.body.is_allowance === 'true') pco.isAllowance = true;
    if (req.body.is_allowance === 'false') pco.isAllowance = false;

    const data = { pco, contractTerms, markupPolicy: null };
    const results = runPcoChecks(data);
    const report = buildPcoReport({ data, results, observations, reference });

    const criticalCount = results.filter(r => r.critical && r.status === 'FAIL').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;

    const pcoKey = (await storage.storeFile('pco', pcoFile.buffer, pcoFile.mimetype, pcoFile.originalname)).key;
    const refKey = referenceFile
      ? (await storage.storeFile('pco', referenceFile.buffer, referenceFile.mimetype, referenceFile.originalname)).key
      : null;

    const insert = db.prepare(`
      INSERT INTO pco_reviews (
        org_id, project_id, contract_id, contract_label,
        pco_number, title, contractor, total_amount, is_allowance,
        extracted_data, checks_result, ai_observations, report_markdown,
        pco_file_name, pco_file, pco_file_key, reference_file_name, reference_file, reference_file_key,
        critical_count, fail_count, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId, projectId,
      // Copied rather than joined, so a saved review still says whose terms it applied even
      // after that contract is renamed or removed.
      contractRow?.id ?? null,
      contractRow ? (contractRow.label || contractRow.file_name) : null,
      pco.pcoNumber || null,
      pco.title || null,
      pco.contractor || null,
      pco.totalAmount ?? null,
      pco.isAllowance ? 1 : 0,
      JSON.stringify({ pco, reference }),
      JSON.stringify(results),
      JSON.stringify(observations),
      report.markdown,
      pcoFile.originalname, pcoKey ? Buffer.alloc(0) : pcoFile.buffer, pcoKey,
      referenceFile?.originalname || null,
      referenceFile ? (refKey ? Buffer.alloc(0) : referenceFile.buffer) : null, refKey,
      criticalCount, failCount,
      req.body.created_by || null
    );

    res.json({ id: insert.lastInsertRowid, report, results });
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
  const observations = row.ai_observations ? JSON.parse(row.ai_observations) : {};
  const report = buildPcoReport({
    data: { pco: extracted.pco, contractTerms: null },
    results, observations, reference: extracted.reference,
  });
  res.json({
    ...row,
    pco_file: undefined,
    reference_file: undefined,
    extracted_data: extracted,
    checks_result: results,
    report,
  });
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
