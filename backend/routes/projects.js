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
  const result = db.prepare(`
    INSERT INTO projects (project_name, project_number, client_name, project_type, project_type_other,
      contract_value, start_date, projected_end_date, status, project_manager, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_name, project_number, client_name, project_type, project_type_other || null,
    contract_value, start_date, projected_end_date, status, project_manager, notes);
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
  `).run(project_name, project_number, client_name, project_type, project_type_other || null,
    contract_value, start_date, projected_end_date, status, project_manager, notes, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
