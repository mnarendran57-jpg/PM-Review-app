const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

router.post('/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });
  const ok = await bcrypt.compare(password, process.env.APP_PASSWORD_HASH || '');
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'team' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

module.exports = router;
