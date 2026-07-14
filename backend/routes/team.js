const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM team_members ORDER BY name').all());
});

router.post('/', (req, res) => {
  const { name, role, email } = req.body;
  const result = db.prepare(
    'INSERT INTO team_members (name, role, email) VALUES (?, ?, ?)'
  ).run(name, role, email);
  res.json({ id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { name, role, email } = req.body;
  db.prepare('UPDATE team_members SET name=?, role=?, email=? WHERE id=?')
    .run(name, role, email, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM team_members WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
