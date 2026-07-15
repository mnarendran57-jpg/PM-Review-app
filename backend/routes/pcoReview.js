const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { analyzePco } = require('../lib/pcoExtract');
const { runPcoChecks } = require('../lib/pcoChecks');
const { buildPcoReport } = require('../lib/pcoReport');
const { friendlyAiError } = require('../lib/aiErrors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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
    let contractTerms = null;
    if (projectId) {
      const contractRow = db.prepare(`
        SELECT terms FROM project_contracts WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId);
      if (contractRow) contractTerms = JSON.parse(contractRow.terms);
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

    const insert = db.prepare(`
      INSERT INTO pco_reviews (
        project_id, pco_number, title, contractor, total_amount, is_allowance,
        extracted_data, checks_result, ai_observations, report_markdown,
        pco_file_name, pco_file, reference_file_name, reference_file,
        critical_count, fail_count, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      pco.pcoNumber || null,
      pco.title || null,
      pco.contractor || null,
      pco.totalAmount ?? null,
      pco.isAllowance ? 1 : 0,
      JSON.stringify({ pco, reference }),
      JSON.stringify(results),
      JSON.stringify(observations),
      report.markdown,
      pcoFile.originalname, pcoFile.buffer,
      referenceFile?.originalname || null, referenceFile?.buffer || null,
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
  let sql = `SELECT id, project_id, pco_number, title, contractor, total_amount, is_allowance,
             critical_count, fail_count, created_by, created_at
             FROM pco_reviews WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) { sql += ' AND (title LIKE ? OR pco_number LIKE ? OR contractor LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pco_reviews WHERE id=?').get(req.params.id);
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
  const row = db.prepare('SELECT pco_number, report_markdown FROM pco_reviews WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="PCO_${(row.pco_number || req.params.id).toString().replace(/[^a-z0-9]+/gi, '_')}_Review.md"`);
  res.send(row.report_markdown);
});

router.get('/:id/original.pdf', (req, res) => {
  const row = db.prepare('SELECT pco_file_name, pco_file FROM pco_reviews WHERE id=?').get(req.params.id);
  if (!row || !row.pco_file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.pco_file_name}"`);
  res.send(Buffer.from(row.pco_file));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM pco_reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
