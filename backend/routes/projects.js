const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM rfis r WHERE r.project_id = p.id AND r.status = 'Open') AS open_rfis,
      (SELECT COUNT(*) FROM submittals s WHERE s.project_id = p.id AND s.review_action = 'Pending') AS pending_submittals,
      (SELECT COUNT(*) FROM pay_applications pa WHERE pa.project_id = p.id AND pa.status = 'Under Review') AS pay_apps_under_review,
      (SELECT COUNT(*) FROM document_reviews dr WHERE dr.project_name = p.project_name) AS ai_reviews
    FROM projects p
    ORDER BY p.created_at DESC
  `).all();
  res.json(projects);
});

router.get('/:id', (req, res) => {
  const project = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM rfis r WHERE r.project_id = p.id AND r.status = 'Open') AS open_rfis,
      (SELECT COUNT(*) FROM submittals s WHERE s.project_id = p.id AND s.review_action = 'Pending') AS pending_submittals,
      (SELECT COUNT(*) FROM pay_applications pa WHERE pa.project_id = p.id AND pa.status = 'Under Review') AS pay_apps_under_review,
      (SELECT COUNT(*) FROM document_reviews dr WHERE dr.project_name = p.project_name) AS ai_reviews
    FROM projects p WHERE p.id = ?
  `).get(req.params.id);
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
  const result = db.prepare(`
    INSERT INTO projects (project_name, project_number, client_name, project_type, project_type_other,
      contract_value, start_date, projected_end_date, status, project_manager, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(project_name).trim(),
    project_number ?? null,
    client_name ?? null,
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
  db.prepare(`
    UPDATE projects SET project_name=?, project_number=?, client_name=?, project_type=?, project_type_other=?,
      contract_value=?, start_date=?, projected_end_date=?, status=?, project_manager=?, notes=?
    WHERE id=?
  `).run(
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
    req.params.id
  );
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
