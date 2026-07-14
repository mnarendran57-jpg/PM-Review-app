const express = require('express');
const router = express.Router();
const db = require('../database');

function serialize(row) {
  return { ...row, sections: JSON.parse(row.sections) };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM memo_templates ORDER BY is_default DESC, name ASC').all();
  res.json(rows.map(serialize));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM memo_templates WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Template not found' });
  res.json(serialize(row));
});

router.post('/', (req, res) => {
  const { name, company_name, header_title, sections } = req.body;
  if (!name || !Array.isArray(sections)) {
    return res.status(400).json({ error: 'name and sections[] are required' });
  }
  const result = db.prepare(`
    INSERT INTO memo_templates (name, company_name, header_title, sections, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(name, company_name || 'Olivier Inc.', header_title || 'MEMORANDUM', JSON.stringify(sections));
  res.json(serialize(db.prepare('SELECT * FROM memo_templates WHERE id=?').get(result.lastInsertRowid)));
});

router.put('/:id', (req, res) => {
  const { name, company_name, header_title, sections } = req.body;
  const existing = db.prepare('SELECT * FROM memo_templates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  db.prepare(`
    UPDATE memo_templates
    SET name=?, company_name=?, header_title=?, sections=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    name ?? existing.name,
    company_name ?? existing.company_name,
    header_title ?? existing.header_title,
    sections ? JSON.stringify(sections) : existing.sections,
    req.params.id
  );
  res.json(serialize(db.prepare('SELECT * FROM memo_templates WHERE id=?').get(req.params.id)));
});

router.post('/:id/set-default', (req, res) => {
  db.exec('UPDATE memo_templates SET is_default=0');
  db.prepare('UPDATE memo_templates SET is_default=1 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM memo_templates WHERE id=?').get(req.params.id);
  if (row && row.is_default) {
    return res.status(400).json({ error: 'Cannot delete the default template. Set another template as default first.' });
  }
  db.prepare('DELETE FROM memo_templates WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
