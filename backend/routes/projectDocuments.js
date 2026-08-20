// --- Shared Documents, stored per project -------------------------------------------
// A project has several agreements — the architect's, the general contractor's, often an
// engineer's — plus files that are not agreements at all (schedule, estimate). Each is
// uploaded once and, if it is a contract, its terms are extracted once; later reviews read
// the stored terms instead of re-sending a long PDF to the API every period.
//
// doc_type 'contract' is the load-bearing value: only a contract has its terms extracted, can
// be marked primary, and is what Pay App and Change Order Review read. Every other value is
// simply what kind of document it is — stored for the team, downloadable, and selectable by
// tools that read documents on request (the RFI log reads drawings this way).
//
// 'reference' predates the richer list and is kept so existing rows stay valid; the app
// presents it as "Other".
//
// This lived inside routes/payAppReview.js, and was copied into routes/payAppReview2.js when the
// sandbox was forked. Holding the live module at its 1-2 August behaviour then took the only
// copy the frontend actually calls with it, and Shared Documents 404'd for everyone. It is its
// own router now, mounted by both, so a module's own history cannot take the project's filing
// cabinet away again.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const storage = require('../lib/storage');
const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { DOC_TYPE_KEYS, GOVERNING_SQL, isGoverning } = require('../lib/docTypes');
const { proposePlaceholders, applyPlaceholders } = require('../lib/memoCover');
const { COVER_KINDS, coverKindFor } = require('../lib/coverTemplates');

router.use(requireOrg);
router.use(requireFeature('pay-app-review'));

const DOC_TYPES = DOC_TYPE_KEYS;

// The categories that are not PDFs. A cover is the organization's own Word document, filled in
// and handed back as a Word file, so it has to stay a .docx all the way through — converting it
// to PDF on upload would throw away the thing that makes it useful.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// A project in the active organization that the caller may use, else null.
function visibleProject(req, id) {
  const project = access.projectForUser(req.user, id);
  return project && project.org_id === req.orgId ? project : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Falls back to the filename so a document is never nameless in a dropdown.
const docLabel = (label, fileName) =>
  (label || '').trim() || fileName.replace(/\.pdf$/i, '');

function listDocuments(projectId) {
  // `terms` travels with the list so a cover can show whether its placeholder mapping has
  // been confirmed without a second request per row.
  return db.prepare(`
    SELECT id, project_id, file_name, label, doc_type, is_primary, terms, terms_edited,
           party, party_role, terms_status, terms_error, created_at, updated_at
    FROM project_contracts WHERE project_id = ?
    ORDER BY (doc_type IN (${GOVERNING_SQL})) DESC, is_primary DESC, doc_type ASC, created_at ASC
  `).all(projectId);
}

router.get('/project/:id/documents', (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  res.json(listDocuments(req.params.id).map(d => ({ ...d, terms: JSON.parse(d.terms || '{}') })));
});

async function addDocument(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'A file is required' });
    if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });

    // Word covers — the memo letter Proposal Intake fills, and the progress report template
    // Progress Report fills. Both are the customer's own document and both stay .docx.
    const wantsCover = coverKindFor(req.body.doc_type);
    if (wantsCover && file.mimetype !== DOCX_MIME) {
      return res.status(400).json({ error: `A ${wantsCover.noun} must be a Word document (.docx).` });
    }
    if (!wantsCover && file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'The document must be a PDF' });
    }

    // Falls back to 'other', never to 'contract'. Being a contract is the one consequential
    // choice here — it spends an AI call reading the document and can become the agreement
    // every review is checked against — so it has to be asked for explicitly rather than
    // arrived at because a value was missing or misspelt.
    const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';
    const label = docLabel(req.body.label, file.originalname);

    // Only an agreement is worth reading on upload: a drawing set or a project manual is read
    // later, by whichever module needs it and only as far as it needs. A cover is the one
    // exception read here rather than on the queue, because its placeholder mapping is the thing
    // the very next screen asks the user to confirm.
    let storedTerms = {};
    const cover = coverKindFor(docType);
    if (cover) {
      // Stored on the document row alongside the file. The column is named `terms` because a
      // contract's terms were the first thing kept here; for a cover it holds the placeholder
      // mapping and whether the user has confirmed it yet.
      const proposal = await proposePlaceholders(file.buffer, cover.key);
      storedTerms = {
        kind: docType,
        confirmed: false,
        hasPlaceholders: proposal.hasPlaceholders,
        replacements: proposal.replacements,
        notes: proposal.notes,
        paragraphs: proposal.paragraphs,
      };
    }
    // A contract is NOT read here, and nothing is queued to read it either. Reading an agreement
    // is several AI calls, and spending them on an upload charges for an action that produces
    // nothing anybody asked for — a contract filed on Monday was read on Monday whether or not
    // anything was ever reviewed against it. lib/contractTerms.js reads it inside the first
    // review that measures against it, once, and every review after that uses what was stored.

    // The first contract on a project becomes its primary, which is what Pay App Review and
    // Change Order Review read. Existing projects keep the contract they already had.
    const hasPrimary = db.prepare(
      `SELECT 1 FROM project_contracts WHERE project_id=? AND doc_type IN (${GOVERNING_SQL}) AND is_primary=1`
    ).get(req.params.id);
    const isPrimary = isGoverning(docType) && !hasPrimary ? 1 : 0;

    const key = (await storage.storeFile('contract', file.buffer, file.mimetype, file.originalname)).key;
    // Who the contract is with, in its own column rather than only inside `terms`. The review
    // matches each party's billing to their own agreement, so this is the field that decides
    // whether a subcontractor is measured against their subcontract or against nothing — and the
    // one a PM is most likely to want to correct by hand. What the form says beats what the model
    // read; a person naming the party is better evidence than a signature block.
    const party = (req.body.party || '').trim() || storedTerms.party || null;
    const partyRole = ['prime', 'subcontractor', 'supplier'].includes(req.body.party_role)
      ? req.body.party_role : (storedTerms.partyRole || null);

    // Uploading is filing, and filing costs nothing. A governing document is marked as not yet
    // read; the first review that measures against it reads it then, once, and every review
    // after that uses the stored terms. A contract nobody reviews against is never read at all.
    const status = isGoverning(docType) ? 'pending' : 'ready';

    const result = db.prepare(`
      INSERT INTO project_contracts
        (project_id, file_name, label, doc_type, is_primary, file_blob, file_key, terms,
         created_by, party, party_role, terms_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, file.originalname, label, docType, isPrimary,
      key ? Buffer.alloc(0) : file.buffer, key, JSON.stringify(storedTerms),
      req.body.created_by || null, party, partyRole, status,
    );

    res.json({
      id: result.lastInsertRowid, file_name: file.originalname,
      label, doc_type: docType, is_primary: isPrimary, terms: storedTerms,
      party, party_role: partyRole, terms_status: status,
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
  // Who the contract is with. The single most consequential field on the row — it decides whose
  // billing gets measured against these terms — and the one the model is most likely to get wrong,
  // because a signature block names the owner, the contractor and often a surety on the same page.
  if (req.body.party !== undefined || req.body.party_role !== undefined) {
    const role = ['prime', 'subcontractor', 'supplier'].includes(req.body.party_role)
      ? req.body.party_role : null;
    db.prepare(`UPDATE project_contracts SET party=?, party_role=?, updated_at=datetime('now') WHERE id=?`)
      .run((req.body.party || '').trim() || null, role, row.id);
  }
  if (req.body.terms) {
    // The extraction is a model reading a legal document — it can be wrong. Let the PM
    // correct it once rather than re-litigating a bad flag every month.
    db.prepare(`UPDATE project_contracts SET terms=?, terms_edited=1, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(req.body.terms), row.id);
  }
  if (req.body.is_primary && isGoverning(row.doc_type)) {
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
      `SELECT id FROM project_contracts WHERE project_id=? AND doc_type IN (${GOVERNING_SQL}) ORDER BY created_at ASC LIMIT 1`
    ).get(req.params.id);
    if (next) db.prepare(`UPDATE project_contracts SET is_primary=1 WHERE id=?`).run(next.id);
  }
  res.json({ success: true });
});

// Named file.pdf for historical reasons and kept so existing links work, but a cover is a Word
// file, so the type is taken from the row rather than assumed.
router.get('/project/:id/documents/:docId/file.pdf', async (req, res) => {
  if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(`SELECT file_name, file_blob, file_key, doc_type FROM project_contracts WHERE id=? AND project_id=?`)
    .get(req.params.docId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', coverKindFor(row.doc_type) ? DOCX_MIME : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

// The cover with its confirmed placeholders written in — what the organization gets back so
// they can see, and keep, the template Coaster will fill from now on.
router.get('/project/:id/documents/:docId/template.docx', async (req, res) => {
  try {
    if (!visibleProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found' });
    const row = db.prepare(`SELECT * FROM project_contracts WHERE id=? AND project_id=?`)
      .get(req.params.docId, req.params.id);
    if (!row || !coverKindFor(row.doc_type)) return res.status(404).json({ error: 'Not found' });
    const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
    if (!bytes) return res.status(404).json({ error: 'Not found' });

    const terms = JSON.parse(row.terms || '{}');
    const { buffer } = applyPlaceholders(bytes, terms.replacements || [], row.doc_type);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${row.file_name.replace(/\.docx$/i, '')}_template.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.addDocument = addDocument;
module.exports.visibleProject = visibleProject;
module.exports.DOCX_MIME = DOCX_MIME;
module.exports.COVER_KINDS = COVER_KINDS;
