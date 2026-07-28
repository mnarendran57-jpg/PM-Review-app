const express = require('express');
const router = express.Router();
const db = require('../database');

// Clients belong to the caller's firm. Every query filters on req.firmId, which comes
// from the verified token — never from the request — so one firm cannot read or modify
// another's clients by guessing an id.

router.get('/', (req, res) => {
  res.json(db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS project_count
    FROM clients c
    WHERE c.firm_id = ?
    ORDER BY c.name ASC
  `).all(req.firmId));
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM clients WHERE id=? AND firm_id=?`).get(req.params.id, req.firmId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const existing = db.prepare(`SELECT id FROM clients WHERE firm_id=? AND lower(name)=lower(?)`).get(req.firmId, name);
  if (existing) return res.json({ id: existing.id, existed: true });

  const result = db.prepare(`
    INSERT INTO clients (firm_id, name, contact_name, contact_email, notes) VALUES (?, ?, ?, ?, ?)
  `).run(req.firmId, name, req.body.contact_name ?? null, req.body.contact_email ?? null, req.body.notes ?? null);
  res.json({ id: result.lastInsertRowid, existed: false });
});

router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM clients WHERE id=? AND firm_id=?`).get(req.params.id, req.firmId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  db.prepare(`
    UPDATE clients SET name=?, contact_name=?, contact_email=?, notes=?, status=? WHERE id=? AND firm_id=?
  `).run(
    name, req.body.contact_name ?? null, req.body.contact_email ?? null,
    req.body.notes ?? null, req.body.status ?? 'Active', req.params.id, req.firmId
  );
  res.json({ success: true });
});

// Deleting a client would orphan its projects, so it is refused while any remain —
// safer than silently cascading away a year of reviews.
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM clients WHERE id=? AND firm_id=?`).get(req.params.id, req.firmId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const projects = db.prepare(`SELECT COUNT(*) AS c FROM projects WHERE client_id=?`).get(req.params.id).c;
  if (projects > 0) {
    return res.status(400).json({
      error: `This client still has ${projects} project${projects === 1 ? '' : 's'}. Move or delete them first.`,
    });
  }
  db.prepare(`DELETE FROM clients WHERE id=? AND firm_id=?`).run(req.params.id, req.firmId);
  res.json({ success: true });
});

module.exports = router;
