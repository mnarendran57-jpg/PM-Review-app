const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { requireOrg } = require('../middleware/auth');
const { brandingFor, setLogo, clearLogo } = require('../lib/orgBranding');
const storage = require('../lib/storage');

// Memo templates and the letterhead that prints on them belong to one organization. None of
// this was scoped before: every query read the whole table, so one customer saw and could
// edit another's template, and "set as default" ran an unfiltered UPDATE that cleared the
// default flag for every organization in the database. Applied to the router so a new
// endpoint cannot be added without it.
router.use(requireOrg);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function serialize(row) {
  return { ...row, sections: JSON.parse(row.sections) };
}

// Loads a template only if it belongs to the caller's organization. Answers null so callers
// can return 404 rather than 403, keeping ids unprobeable.
const visibleTemplate = req =>
  db.prepare('SELECT * FROM memo_templates WHERE id=? AND org_id=?').get(req.params.id, req.orgId) || null;

router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM memo_templates WHERE org_id=? ORDER BY is_default DESC, name ASC'
  ).all(req.orgId);
  res.json(rows.map(serialize));
});

// --- The organization's letterhead ---------------------------------------------------------
// What prints at the top of a memo: the address block, and the logo image. Kept on the
// organization rather than on a template, because it is the company's identity and every
// template it owns should carry the same one.

router.get('/branding', async (req, res) => {
  const branding = await brandingFor(req.orgId);
  res.json({
    companyName: branding.companyName,
    orgName: branding.orgName,
    hasLogo: !!branding.logo,
    logoMime: branding.logo?.mimeType || null,
  });
});

router.put('/branding', (req, res) => {
  const letterhead = typeof req.body.companyName === 'string' ? req.body.companyName.trim() : null;
  db.prepare('UPDATE organizations SET letterhead=? WHERE id=?').run(letterhead || null, req.orgId);
  // Templates carry their own copy for backwards compatibility; keeping them in step means a
  // memo rendered from an older template still shows the address the user just typed.
  db.prepare('UPDATE memo_templates SET company_name=?, updated_at=datetime(\'now\') WHERE org_id=?')
    .run(letterhead || '', req.orgId);
  res.json({ success: true, companyName: letterhead || null });
});

router.post('/branding/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a logo image to upload.' });
    await setLogo({
      orgId: req.orgId, buffer: req.file.buffer,
      mimeType: req.file.mimetype, originalName: req.file.originalname,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/branding/logo', async (req, res) => {
  await clearLogo(req.orgId);
  res.json({ success: true });
});

// Serves the logo back so the settings screen can show what is on file. Not cached, because
// the point of viewing it is usually that it was just replaced.
router.get('/branding/logo', async (req, res) => {
  const org = db.prepare('SELECT logo_key, logo_blob, logo_mime FROM organizations WHERE id=?').get(req.orgId);
  const bytes = org && (org.logo_key || org.logo_blob)
    ? await storage.readFile({ key: org.logo_key, blob: org.logo_blob })
    : null;
  if (!bytes) return res.status(404).json({ error: 'No logo on file' });
  res.setHeader('Content-Type', org.logo_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(bytes);
});

// --- Templates -------------------------------------------------------------------------------

router.get('/:id', (req, res) => {
  const row = visibleTemplate(req);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  res.json(serialize(row));
});

router.post('/', (req, res) => {
  const { name, company_name, header_title, sections } = req.body;
  if (!name || !Array.isArray(sections)) {
    return res.status(400).json({ error: 'name and sections[] are required' });
  }
  // Defaults to this organization's own letterhead rather than a hardcoded company name.
  const org = db.prepare('SELECT letterhead FROM organizations WHERE id=?').get(req.orgId);
  const result = db.prepare(`
    INSERT INTO memo_templates (org_id, name, company_name, header_title, sections, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    req.orgId, name,
    company_name ?? org?.letterhead ?? '',
    header_title ?? '',
    JSON.stringify(sections)
  );
  res.json(serialize(db.prepare('SELECT * FROM memo_templates WHERE id=?').get(result.lastInsertRowid)));
});

router.put('/:id', (req, res) => {
  const existing = visibleTemplate(req);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const { name, company_name, header_title, sections } = req.body;
  db.prepare(`
    UPDATE memo_templates
    SET name=?, company_name=?, header_title=?, sections=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    name ?? existing.name,
    company_name ?? existing.company_name,
    header_title ?? existing.header_title,
    sections ? JSON.stringify(sections) : existing.sections,
    existing.id
  );
  res.json(serialize(db.prepare('SELECT * FROM memo_templates WHERE id=?').get(existing.id)));
});

router.post('/:id/set-default', (req, res) => {
  const row = visibleTemplate(req);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  // Scoped to this organization. Unfiltered, this cleared the default for every customer.
  db.prepare('UPDATE memo_templates SET is_default=0 WHERE org_id=?').run(req.orgId);
  db.prepare('UPDATE memo_templates SET is_default=1 WHERE id=?').run(row.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const row = visibleTemplate(req);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  if (row.is_default) {
    return res.status(400).json({ error: 'Cannot delete the default template. Set another template as default first.' });
  }
  db.prepare('DELETE FROM memo_templates WHERE id=?').run(row.id);
  res.json({ success: true });
});

module.exports = router;
