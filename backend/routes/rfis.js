const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  const { project_id, status, priority } = req.query;
  let sql = `
    SELECT r.*, p.project_name
    FROM rfis r
    LEFT JOIN projects p ON r.project_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (project_id) { sql += ' AND r.project_id = ?'; params.push(project_id); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (priority) { sql += ' AND r.priority = ?'; params.push(priority); }
  sql += ' ORDER BY r.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', (req, res) => {
  const {
    rfi_number, project_id, title, submitted_by, submitted_to,
    date_submitted, date_response_due, date_responded, status,
    priority, description, response, linked_document
  } = req.body;

  // Auto-calc due date if not provided
  let due = date_response_due;
  if (!due && date_submitted) {
    const settingRow = db.prepare(`SELECT value FROM settings WHERE key='rfi_response_days'`).get();
    const days = parseInt(settingRow?.value || '10');
    const d = new Date(date_submitted);
    d.setDate(d.getDate() + days);
    due = d.toISOString().slice(0, 10);
  }

  const result = db.prepare(`
    INSERT INTO rfis (rfi_number, project_id, title, submitted_by, submitted_to,
      date_submitted, date_response_due, date_responded, status, priority,
      description, response, linked_document)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rfi_number, project_id || null, title, submitted_by, submitted_to,
    date_submitted, due, date_responded, status, priority,
    description, response, linked_document);
  res.json({ id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const {
    rfi_number, project_id, title, submitted_by, submitted_to,
    date_submitted, date_response_due, date_responded, status,
    priority, description, response, linked_document
  } = req.body;
  db.prepare(`
    UPDATE rfis SET rfi_number=?, project_id=?, title=?, submitted_by=?, submitted_to=?,
      date_submitted=?, date_response_due=?, date_responded=?, status=?, priority=?,
      description=?, response=?, linked_document=?, updated_at=datetime('now')
    WHERE id=?
  `).run(rfi_number, project_id || null, title, submitted_by, submitted_to,
    date_submitted, date_response_due, date_responded, status, priority,
    description, response, linked_document, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM rfis WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Next available RFI number for a project
router.get('/next-number/:project_id', (req, res) => {
  const row = db.prepare(`
    SELECT rfi_number FROM rfis WHERE project_id=? ORDER BY id DESC LIMIT 1
  `).get(req.params.project_id);
  let next = 'RFI-001';
  if (row) {
    const match = row.rfi_number.match(/(\d+)$/);
    if (match) next = `RFI-${String(parseInt(match[1]) + 1).padStart(3, '0')}`;
  }
  res.json({ next });
});

module.exports = router;
