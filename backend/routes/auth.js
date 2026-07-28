const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

// Individual accounts, one per person, each belonging to exactly one firm. The token
// carries the firm so every later request can be filtered to it — see middleware/auth.js.
function issueToken(user) {
  return jwt.sign(
    { uid: user.id, firmId: user.firm_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicUser(user, firmName) {
  return {
    id: user.id, email: user.email, name: user.name,
    role: user.role, firmId: user.firm_id, firmName: firmName || null,
  };
}

function userFromToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(claims.uid);
    return user && user.status === 'Active' ? user : null;
  } catch {
    return null;
  }
}

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
  // Same message whether the address is unknown or the password is wrong — telling them
  // apart would let anyone probe which people have accounts.
  const ok = user && user.status === 'Active' && await bcrypt.compare(password, user.password_hash || '');
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });

  const firm = user.firm_id ? db.prepare(`SELECT name FROM firms WHERE id=?`).get(user.firm_id) : null;
  res.json({ token: issueToken(user), user: publicUser(user, firm?.name) });
});

// Who am I — the frontend calls this on load to restore the session and decide which
// admin screens to show.
router.get('/me', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const firm = user.firm_id ? db.prepare(`SELECT name FROM firms WHERE id=?`).get(user.firm_id) : null;
  res.json({ user: publicUser(user, firm?.name) });
});

// Changing your own password requires proving you know the current one.
router.post('/change-password', async (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });

  const { current_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (!(await bcrypt.compare(current_password || '', user.password_hash || ''))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`)
    .run(bcrypt.hashSync(String(new_password), 10), user.id);
  res.json({ success: true });
});

module.exports = router;
