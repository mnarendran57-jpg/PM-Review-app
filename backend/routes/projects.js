const express = require('express');
const router = express.Router();
const db = require('../database');
const { clientInFirm } = require('../middleware/auth');

const COUNTS = `
  (SELECT COUNT(*) FROM rfis r WHERE r.project_id = p.id AND r.status = 'Open') AS open_rfis,
  (SELECT COUNT(*) FROM submittals s WHERE s.project_id = p.id AND s.review_action = 'Pending') AS pending_submittals,
  (SELECT COUNT(*) FROM pay_applications pa WHERE pa.project_id = p.id AND pa.status = 'Under Review') AS pay_apps_under_review,
  (SELECT COUNT(*) FROM document_reviews dr WHERE dr.project_name = p.project_name) AS ai_reviews
`;

// Always filtered to the caller's firm, and optionally to one client — that's the list
// shown after the user picks which client they're working on.
router.get('/', (req, res) => {
  const params = [req.firmId];
  let sql = `SELECT p.*, c.name AS client, ${COUNTS}
             FROM projects p
             LEFT JOIN clients c ON c.id = p.client_id
             WHERE p.firm_id = ?`;
  if (req.query.client_id) { sql += ' AND p.client_id = ?'; params.push(req.query.client_id); }
  sql += ' ORDER BY p.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.name AS client, ${COUNTS}
    FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = ? AND p.firm_id = ?
  `).get(req.params.id, req.firmId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(project);
});

router.post('/', (req, res) => {
  const {
    project_name, project_number, client_name, project_type, project_type_other,
    contract_value, start_date, projected_end_date, status,
    project_manager, notes
  } = req.body;
  // Only the project name is required. Every other field is optional — coerce any that
  // weren't sent to null/defaults, because node:sqlite rejects `undefined` bindings and
  // the create-project form only sends a name and (optionally) a client.
  if (!project_name || !String(project_name).trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  // The project is created under a client the caller's firm actually owns — checked
  // rather than trusted, so a tampered client_id can't plant a project in another firm.
  const client = clientInFirm(req.body.client_id, req.firmId);
  if (req.body.client_id && !client) return res.status(400).json({ error: 'Unknown client' });

  const result = db.prepare(`
    INSERT INTO projects (firm_id, client_id, project_name, project_number, client_name, project_type, project_type_other,
      contract_value, start_date, projected_end_date, status, project_manager, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.firmId,
    client ? client.id : null,
    String(project_name).trim(),
    project_number ?? null,
    client_name ?? (client ? client.name : null),
    project_type ?? 'MEP',
    project_type_other ?? null,
    contract_value ?? null,
    start_date ?? null,
    projected_end_date ?? null,
    status ?? 'Active',
    project_manager ?? null,
    notes ?? null
  );
  res.json({ id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const {
    project_name, project_number, client_name, project_type, project_type_other,
    contract_value, start_date, projected_end_date, status,
    project_manager, notes
  } = req.body;
  const existing = db.prepare(`SELECT client_id FROM projects WHERE id=? AND firm_id=?`).get(req.params.id, req.firmId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Moving a project to another client is allowed, but only to one this firm owns.
  let clientId = existing.client_id;
  if (req.body.client_id !== undefined) {
    const client = clientInFirm(req.body.client_id, req.firmId);
    if (req.body.client_id && !client) return res.status(400).json({ error: 'Unknown client' });
    clientId = client ? client.id : null;
  }

  db.prepare(`
    UPDATE projects SET client_id=?, project_name=?, project_number=?, client_name=?, project_type=?, project_type_other=?,
      contract_value=?, start_date=?, projected_end_date=?, status=?, project_manager=?, notes=?
    WHERE id=? AND firm_id=?
  `).run(
    clientId,
    project_name ?? null,
    project_number ?? null,
    client_name ?? null,
    project_type ?? 'MEP',
    project_type_other ?? null,
    contract_value ?? null,
    start_date ?? null,
    projected_end_date ?? null,
    status ?? 'Active',
    project_manager ?? null,
    notes ?? null,
    req.params.id,
    req.firmId
  );
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=? AND firm_id=?').run(req.params.id, req.firmId);
  res.json({ success: true });
});

module.exports = router;
