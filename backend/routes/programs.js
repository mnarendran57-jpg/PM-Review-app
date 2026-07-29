const express = require('express');
const router = express.Router();
const db = require('../database');
const access = require('../lib/access');
const { requireOrg, requireOrgAdmin } = require('../middleware/auth');

// Programs group projects inside one Organization. Which programs a user sees follows the
// access model: an Org Admin sees them all, everyone else sees only the programs holding a
// project they are a member of. There is no program-level membership by design.

router.get('/', requireOrg, (req, res) => {
  res.json(access.programsForUser(req.user, req.orgId));
});

router.get('/:id', requireOrg, (req, res) => {
  const visible = access.programsForUser(req.user, req.orgId).find(p => p.id === Number(req.params.id));
  if (!visible) return res.status(404).json({ error: 'Not found' });
  res.json(visible);
});

router.post('/', requireOrgAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Program name is required' });

  const existing = db.prepare(`SELECT id FROM programs WHERE org_id=? AND lower(name)=lower(?)`)
    .get(req.orgId, name);
  if (existing) return res.json({ id: existing.id, existed: true });

  const result = db.prepare(`
    INSERT INTO programs (org_id, name, contact_name, contact_email, notes) VALUES (?, ?, ?, ?, ?)
  `).run(req.orgId, name, req.body.contact_name ?? null, req.body.contact_email ?? null, req.body.notes ?? null);
  res.json({ id: result.lastInsertRowid, existed: false });
});

router.put('/:id', requireOrgAdmin, (req, res) => {
  const row = db.prepare(`SELECT id FROM programs WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Program name is required' });

  db.prepare(`
    UPDATE programs SET name=?, contact_name=?, contact_email=?, notes=?, status=? WHERE id=? AND org_id=?
  `).run(
    name, req.body.contact_name ?? null, req.body.contact_email ?? null,
    req.body.notes ?? null, req.body.status ?? 'Active', req.params.id, req.orgId
  );
  res.json({ success: true });
});

// Refused while projects remain — cascading them away would silently destroy their whole
// review history. An organization also always keeps at least one program.
router.delete('/:id', requireOrgAdmin, (req, res) => {
  const row = db.prepare(`SELECT id FROM programs WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const projects = db.prepare(`SELECT COUNT(*) AS c FROM projects WHERE program_id=?`).get(req.params.id).c;
  if (projects > 0) {
    return res.status(400).json({
      error: `This program still has ${projects} project${projects === 1 ? '' : 's'}. Move or delete them first.`,
    });
  }
  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM programs WHERE org_id=?`).get(req.orgId).c;
  if (remaining <= 1) {
    return res.status(400).json({ error: 'An organization must keep at least one program.' });
  }
  db.prepare(`DELETE FROM programs WHERE id=? AND org_id=?`).run(req.params.id, req.orgId);
  res.json({ success: true });
});

module.exports = router;
