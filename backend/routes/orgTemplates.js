const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const storage = require('../lib/storage');
const { requireOrg, requireOrgAdmin } = require('../middleware/auth');
const { friendlyAiError } = require('../lib/aiErrors');
const { proposePlaceholders, applyPlaceholders } = require('../lib/memoCover');
const { COVER_KINDS, coverKindFor } = require('../lib/coverTemplates');

// The organization's own Word documents — their memo cover, their progress report.
//
// These began life on the project, alongside the contract and the drawings, because that is where
// the first one was needed. It is the wrong home: a company writes one memo letter and one
// progress report, and a customer with fifteen jobs was uploading the same two files fifteen
// times, confirming the same placeholder mapping fifteen times, and getting fifteen chances for
// one of them to drift.
//
// They live on the company now, fed once by an admin — either the customer's own, in Settings, or
// Coaster's, on the customer's behalf, since a platform administrator is an admin of the
// organizations they manage. A project can still upload its own on Shared Documents and that one
// wins; see lib/coverLookup.js, which is the single place that decides.

router.use(requireOrg);
// Feeding a company's standard template is an administrative act: it changes what every project in
// the organization produces, not just the caller's own work.
router.use(requireOrgAdmin);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const rowFor = (orgId, docType) =>
  db.prepare(`SELECT * FROM org_templates WHERE org_id=? AND doc_type=?`).get(orgId, docType);

// What the settings screen shows: one entry per kind of template, whether or not one is on file,
// so the page can render the whole set from this alone.
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT doc_type, file_name, terms, created_by, updated_at FROM org_templates WHERE org_id=?`
  ).all(req.orgId);
  const byType = new Map(rows.map(r => [r.doc_type, r]));

  res.json(Object.values(COVER_KINDS).map(kind => {
    const row = byType.get(kind.key);
    let terms = {};
    if (row) { try { terms = JSON.parse(row.terms || '{}'); } catch { terms = {}; } }
    return {
      doc_type: kind.key,
      noun: kind.noun,
      onFile: !!row,
      file_name: row?.file_name || null,
      updated_at: row?.updated_at || null,
      confirmed: !!terms.confirmed,
      replacements: terms.replacements || [],
      notes: terms.notes || null,
      hasPlaceholders: !!terms.hasPlaceholders,
    };
  }));
});

// Upload, or replace what is on file. Replacing is a deliberate reset of the mapping: the new
// document is a different document, and carrying the old confirmation across would mean a template
// nobody has read going out on every memo from that moment.
router.post('/:docType', upload.single('file'), async (req, res) => {
  try {
    const kind = coverKindFor(req.params.docType);
    if (!kind) return res.status(404).json({ error: 'No such template' });
    if (!req.file) return res.status(400).json({ error: 'Choose a Word document to upload.' });
    if (req.file.mimetype !== DOCX_MIME) {
      return res.status(400).json({ error: `A ${kind.noun} must be a Word document (.docx).` });
    }

    const proposal = await proposePlaceholders(req.file.buffer, kind.key);
    const terms = {
      kind: kind.key,
      confirmed: false,
      hasPlaceholders: proposal.hasPlaceholders,
      replacements: proposal.replacements,
      notes: proposal.notes,
      paragraphs: proposal.paragraphs,
    };

    const previous = rowFor(req.orgId, kind.key);
    const { key } = await storage.storeFile('branding', req.file.buffer, req.file.mimetype, req.file.originalname);

    db.prepare(`
      INSERT INTO org_templates (org_id, doc_type, file_name, file_blob, file_key, terms, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (org_id, doc_type) DO UPDATE SET
        file_name = excluded.file_name, file_blob = excluded.file_blob, file_key = excluded.file_key,
        terms = excluded.terms, created_by = excluded.created_by, updated_at = datetime('now')
    `).run(
      req.orgId, kind.key, req.file.originalname,
      key ? null : req.file.buffer, key, JSON.stringify(terms),
      req.user.name || req.user.email || null,
    );

    // Only after the new one is safely stored — a failed upload must not cost the old template.
    if (previous?.file_key && previous.file_key !== key) await storage.remove([previous.file_key]);

    res.json({ doc_type: kind.key, file_name: req.file.originalname, terms });
  } catch (err) {
    console.error('Org template error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Confirming the mapping, or correcting it later.
router.patch('/:docType', (req, res) => {
  const kind = coverKindFor(req.params.docType);
  if (!kind) return res.status(404).json({ error: 'No such template' });
  const row = rowFor(req.orgId, kind.key);
  if (!row) return res.status(404).json({ error: 'No template on file' });
  if (!req.body.terms) return res.status(400).json({ error: 'terms is required' });

  db.prepare(`UPDATE org_templates SET terms=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(req.body.terms), row.id);
  res.json({ success: true });
});

router.delete('/:docType', async (req, res) => {
  const kind = coverKindFor(req.params.docType);
  if (!kind) return res.status(404).json({ error: 'No such template' });
  const row = rowFor(req.orgId, kind.key);
  if (!row) return res.status(404).json({ error: 'No template on file' });

  db.prepare(`DELETE FROM org_templates WHERE id=?`).run(row.id);
  if (row.file_key) await storage.remove([row.file_key]);
  res.json({ success: true });
});

// The document as it was uploaded.
router.get('/:docType/file.docx', async (req, res) => {
  const row = rowFor(req.orgId, req.params.docType);
  if (!row) return res.status(404).json({ error: 'No template on file' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'No template on file' });
  res.setHeader('Content-Type', DOCX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(bytes);
});

// The same document with the confirmed placeholders written into it — what the organization keeps
// so they can see, and edit, the template Coaster fills from now on.
router.get('/:docType/template.docx', async (req, res) => {
  try {
    const row = rowFor(req.orgId, req.params.docType);
    if (!row) return res.status(404).json({ error: 'No template on file' });
    const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
    if (!bytes) return res.status(404).json({ error: 'No template on file' });

    const terms = JSON.parse(row.terms || '{}');
    const { buffer } = applyPlaceholders(bytes, terms.replacements || [], row.doc_type);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition',
      `attachment; filename="${row.file_name.replace(/\.docx$/i, '')}_template.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
