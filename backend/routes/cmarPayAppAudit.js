const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const jobs = require('../lib/jobs');
const storage = require('../lib/storage');
const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { GOVERNING_SQL } = require('../lib/docTypes');
const { readPacket, readContractTerms } = require('../lib/cmarRead');
const { runChecks } = require('../lib/cmarChecks');
const { judge } = require('../lib/cmarJudgement');
const { buildReport } = require('../lib/cmarReport');
const { renderCmarReportPdf } = require('../lib/cmarReportPdf');
const { buildMarkedUpPacket } = require('../lib/cmarAnnotate');

// The CMAR pay application audit.
//
// Deliberately its own module, sharing no code with the other pay application tools. It implements
// one specific review method end to end, and the whole value of it is that it does that method
// faithfully — a shared helper that drifted to suit a different module would change this one's
// answers without anybody deciding to.
//
// It reads the project's Shared Documents for the contract rather than asking for it to be uploaded
// again: the agreement is already on file, it is the same one every period, and a PM re-uploading a
// 200-page contract every month is exactly the kind of effort this application exists to remove.

router.use(requireOrg);
router.use(requireFeature('cmar-pay-app-audit'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM cmar_audits WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
}

const safeParse = (json, fallback = null) => {
  try { return JSON.parse(json || 'null') ?? fallback; } catch { return fallback; }
};

// The stored record rebuilt into the shape the page and the documents both want, so the screen and
// the PDF cannot disagree about what the audit found.
function recordView(row) {
  const packet = safeParse(row.packet_json, {});
  const checks = safeParse(row.checks_json, { findings: [], counts: {}, tax: { taxed: [], exempt: [], total: 0 } });
  const judgement = safeParse(row.judgement_json, null);
  const terms = safeParse(row.terms_json, null);
  const header = {
    projectName: row.project_name || packet.projectName,
    ownerName: packet.ownerName,
    contractorName: row.contractor,
    applicationNumber: row.application_number,
    periodTo: row.period_to,
    contractName: row.contract_name,
    mathOnly: row.math_only === 1,
  };
  return { header, report: buildReport({ header, packet, checks, judgement, terms }) };
}

const safeName = s => String(s || 'pay_application').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);

// The governing documents already on file for a project, for the contract picker.
router.get('/contracts', (req, res) => {
  const projectId = Number(req.query.project_id);
  if (!projectId) return res.status(400).json({ error: 'A project is required.' });
  if (!access.projectForUser(req.user, projectId, req.orgId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const rows = db.prepare(`
    SELECT id, file_name, label, doc_type, party, party_role, is_primary, created_at
    FROM project_contracts
    WHERE project_id = ? AND doc_type IN (${GOVERNING_SQL})
    ORDER BY is_primary DESC, created_at DESC
  `).all(projectId);
  res.json(rows);
});

// Read the packet, check it, and save the result.
//
// Runs as a job for the same reason every other reader in this application does: a full packet is a
// hundred pages of forms and invoices, and reading it takes minutes. Holding the request open for
// that hands every proxy between the browser and this server a vote on whether the review is allowed
// to finish. How big the packet is must never decide whether the feature works.
router.post('/', upload.single('packet_file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'A pay application packet PDF is required.' });
  if (file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'The packet must be a PDF.' });
  }

  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  const mathOnly = req.body.math_only === 'true' || req.body.math_only === true;
  const contractId = req.body.contract_id ? Number(req.body.contract_id) : null;

  if (!mathOnly && !contractId) {
    return res.status(400).json({
      error: 'Choose the contract this application is measured against, or ask for a math check only.',
    });
  }

  let contractRow = null;
  if (contractId) {
    contractRow = db.prepare(`SELECT * FROM project_contracts WHERE id=?`).get(contractId);
    if (!contractRow || (projectId && contractRow.project_id !== projectId)) {
      return res.status(404).json({ error: 'That contract is not on file for this project.' });
    }
    if (!access.projectForUser(req.user, contractRow.project_id, req.orgId)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  const jobId = jobs.start(
    { orgId: req.orgId, userId: req.user.id, kind: 'cmar-audit' },
    () => audit({
      file,
      projectId,
      projectName: req.body.project_name || null,
      contractRow,
      mathOnly,
      orgId: req.orgId,
      createdBy: req.body.created_by || req.user?.name || null,
    }),
  );
  res.status(202).json({ jobId });
});

async function audit({ file, projectId, projectName, contractRow, mathOnly, orgId, createdBy }) {
  try {
    // The contract is read alongside the packet rather than after it. They are independent reads of
    // independent documents, and running them one after the other would add a minute to every audit
    // for no reason.
    const contractBytes = contractRow
      ? await storage.readFile({ key: contractRow.file_key, blob: contractRow.file_blob })
      : null;

    const [packet, terms] = await Promise.all([
      readPacket(file.buffer, file.originalname),
      contractBytes
        ? readContractTerms(contractBytes, contractRow.file_name)
        : Promise.resolve(null),
    ]);

    if (!packet?.certificate || !Array.isArray(packet.sovRows) || !packet.sovRows.length) {
      const err = new Error('No pay application could be read from this file. A G702 certificate and '
        + 'its G703 continuation sheet are what this review works from — if the upload is a single '
        + 'invoice or a cover letter, there is nothing here to check.');
      err.friendlyMessage = err.message;
      throw err;
    }

    const checks = runChecks(packet, terms);
    const judgement = await judge({ packet, checks, terms });

    const key = (await storage.storeFile('cmar', file.buffer, file.mimetype, file.originalname)).key;
    const cert = packet.certificate || {};

    const insert = db.prepare(`
      INSERT INTO cmar_audits (
        org_id, project_id, project_name, contractor, owner_name,
        application_number, period_to, payment_due, contract_sum_to_date, completed_to_date,
        math_only, contract_id, contract_name,
        issue_count, note_count, unchecked_count, tax_total,
        packet_json, checks_json, judgement_json, terms_json,
        packet_file_name, packet_file, packet_file_key, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, projectId, projectName || packet.projectName || null,
      packet.contractorName || null,
      packet.ownerName || null,
      cert.applicationNumber || null,
      cert.periodTo || null,
      typeof cert.line8CurrentPaymentDue === 'number' ? cert.line8CurrentPaymentDue : null,
      typeof cert.line3ContractSumToDate === 'number' ? cert.line3ContractSumToDate : null,
      typeof cert.line4CompletedAndStoredToDate === 'number' ? cert.line4CompletedAndStoredToDate : null,
      mathOnly ? 1 : 0,
      contractRow?.id || null,
      contractRow ? (contractRow.label || contractRow.file_name) : null,
      checks.counts.fail, checks.counts.note, checks.counts.unknown,
      checks.tax.total || 0,
      JSON.stringify(packet), JSON.stringify(checks), JSON.stringify(judgement), JSON.stringify(terms),
      file.originalname, key ? Buffer.alloc(0) : file.buffer, key,
      createdBy,
    );

    const row = db.prepare(`SELECT * FROM cmar_audits WHERE id=?`).get(insert.lastInsertRowid);
    return { id: row.id, packet_file_name: row.packet_file_name, ...recordView(row) };
  } catch (err) {
    console.error('CMAR audit error:', err);
    err.friendlyMessage = err.friendlyMessage || friendlyAiError(err);
    throw err;
  }
}

router.get('/jobs/:id', (req, res) => {
  const row = jobs.get(req.params.id, { orgId: req.orgId, userId: req.user.id });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== jobs.RUNNING) jobs.sweep();
  res.json(jobs.view(row));
});

router.get('/', (req, res) => {
  const { project_id, search } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `SELECT id, project_id, project_name, contractor, owner_name, application_number,
             period_to, payment_due, math_only, contract_name, issue_count, note_count,
             unchecked_count, tax_total, packet_file_name, created_by, created_at
             FROM cmar_audits WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  if (search) {
    sql += ' AND (project_name LIKE ? OR contractor LIKE ? OR application_number LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: row.id,
    project_id: row.project_id,
    packet_file_name: row.packet_file_name,
    created_by: row.created_by,
    created_at: row.created_at,
    ...recordView(row),
  });
});

router.get('/:id/report.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const { report } = recordView(row);
    const pdf = await renderCmarReportPdf({ report });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="Pay_App_Audit_${safeName(row.project_name)}_${safeName(row.application_number || '')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('CMAR report PDF error:', err);
    res.status(500).json({ error: 'The report could not be produced.' });
  }
});

// The contractor's own packet with the findings circled on it.
//
// Built here rather than stored: it is derived from the audit and the original upload, both of
// which are kept, so a second copy of a long packet in object storage buys nothing — and reading
// the page positions is the heaviest thing this module does, which is better spent on a download
// than added to every audit's memory peak.
router.get('/:id/marked-up.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const original = await storage.readFile({ key: row.packet_file_key, blob: row.packet_file });
    if (!original) return res.status(404).json({ error: 'The original packet is no longer on file.' });

    const { report } = recordView(row);
    const { buffer, findingCount, placedCount } = await buildMarkedUpPacket({ pdfBuffer: original, report });

    console.log(`[cmar] marked-up packet for audit ${row.id}: `
      + `${placedCount}/${findingCount} findings placed on the page`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="Marked_Up_${safeName(row.project_name)}_${safeName(row.application_number || '')}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CMAR marked-up PDF error:', err);
    res.status(500).json({ error: 'The marked-up packet could not be produced.' });
  }
});

router.get('/:id/report.md', (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition',
    `attachment; filename="Pay_App_Audit_${safeName(row.project_name)}.md"`);
  res.send(recordView(row).report.markdown);
});

router.get('/:id/original.pdf', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.packet_file_key, blob: row.packet_file });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.packet_file_name}"`);
  res.send(bytes);
});

router.delete('/:id', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM cmar_audits WHERE id=?').run(row.id);
  await storage.remove([row.packet_file_key]);
  res.json({ success: true });
});

module.exports = router;
