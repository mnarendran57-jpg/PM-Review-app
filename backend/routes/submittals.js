const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  const { project_id, review_action, spec_section } = req.query;
  let sql = `
    SELECT s.*, p.project_name
    FROM submittals s
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (project_id) { sql += ' AND s.project_id = ?'; params.push(project_id); }
  if (review_action) { sql += ' AND s.review_action = ?'; params.push(review_action); }
  if (spec_section) { sql += ' AND s.spec_section LIKE ?'; params.push(`%${spec_section}%`); }
  sql += ' ORDER BY s.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', (req, res) => {
  const {
    submittal_number, project_id, spec_section, description,
    submitted_by, date_received, date_forwarded, date_response_due,
    date_returned, review_action, revision_number, notes
  } = req.body;

  let due = date_response_due;
  if (!due && date_forwarded) {
    const settingRow = db.prepare(`SELECT value FROM settings WHERE key='submittal_review_days'`).get();
    const days = parseInt(settingRow?.value || '14');
    const d = new Date(date_forwarded);
    d.setDate(d.getDate() + days);
    due = d.toISOString().slice(0, 10);
  }

  const result = db.prepare(`
    INSERT INTO submittals (submittal_number, project_id, spec_section, description,
      submitted_by, date_received, date_forwarded, date_response_due,
      date_returned, review_action, revision_number, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(submittal_number, project_id || null, spec_section, description,
    submitted_by, date_received, date_forwarded, due,
    date_returned, review_action || 'Pending', revision_number || 0, notes);
  res.json({ id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const {
    submittal_number, project_id, spec_section, description,
    submitted_by, date_received, date_forwarded, date_response_due,
    date_returned, review_action, revision_number, notes
  } = req.body;
  db.prepare(`
    UPDATE submittals SET submittal_number=?, project_id=?, spec_section=?, description=?,
      submitted_by=?, date_received=?, date_forwarded=?, date_response_due=?,
      date_returned=?, review_action=?, revision_number=?, notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(submittal_number, project_id || null, spec_section, description,
    submitted_by, date_received, date_forwarded, date_response_due,
    date_returned, review_action, revision_number, notes, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM submittals WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
