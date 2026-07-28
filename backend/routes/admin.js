const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireRole } = require('../middleware/auth');

// Two levels of administration:
//  - superadmin (the vendor) creates firms and their first admin when a firm signs up.
//    There is deliberately no public signup — nobody gets an account unless it is made
//    for them here.
//  - admin (a firm's own administrator) manages users inside their own firm only.

const ROLES = ['admin', 'member'];

// --- Firms (vendor only) --------------------------------------------------------------

router.get('/firms', requireRole('superadmin'), (req, res) => {
  res.json(db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM users u WHERE u.firm_id = f.id) AS user_count,
      (SELECT COUNT(*) FROM clients c WHERE c.firm_id = f.id) AS client_count,
      (SELECT COUNT(*) FROM projects p WHERE p.firm_id = f.id) AS project_count
    FROM firms f ORDER BY f.name ASC
  `).all());
});

// Creates the firm and its first administrator together — a firm with no way to log in
// would be useless, and this is the moment the vendor onboards a new customer.
router.post('/firms', requireRole('superadmin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.admin_email || '').trim().toLowerCase();
  const password = String(req.body.admin_password || '');
  if (!name) return res.status(400).json({ error: 'Firm name is required' });
  if (!email || !password) return res.status(400).json({ error: 'An admin email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(email)) {
    return res.status(400).json({ error: 'That email address is already in use' });
  }

  const firmId = db.prepare(`INSERT INTO firms (name) VALUES (?)`).run(name).lastInsertRowid;
  const userId = db.prepare(`
    INSERT INTO users (firm_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'admin')
  `).run(firmId, email, bcrypt.hashSync(password, 10), req.body.admin_name || null).lastInsertRowid;
  res.json({ id: firmId, admin_user_id: userId });
});

router.put('/firms/:id', requireRole('superadmin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Firm name is required' });
  db.prepare(`UPDATE firms SET name=?, status=? WHERE id=?`)
    .run(name, req.body.status || 'Active', req.params.id);
  res.json({ success: true });
});

// --- Users --------------------------------------------------------------------------

// A firm admin sees only their own firm; the vendor can look at any firm.
function targetFirmId(req) {
  if (req.user.role === 'superadmin' && req.query.firm_id) return Number(req.query.firm_id);
  return req.firmId;
}

router.get('/users', requireRole('superadmin', 'admin'), (req, res) => {
  res.json(db.prepare(`
    SELECT id, firm_id, email, name, role, status, created_at FROM users
    WHERE firm_id = ? ORDER BY name IS NULL, name ASC, email ASC
  `).all(targetFirmId(req)));
});

router.post('/users', requireRole('superadmin', 'admin'), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'member';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(email)) {
    return res.status(400).json({ error: 'That email address is already in use' });
  }

  const result = db.prepare(`
    INSERT INTO users (firm_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)
  `).run(targetFirmId(req), email, bcrypt.hashSync(password, 10), req.body.name || null, role);
  res.json({ id: result.lastInsertRowid });
});

// Used both to rename/redesignate someone and to reset a forgotten password, since there
// is no self-service email reset yet.
router.put('/users/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  // An admin may only touch their own firm's people.
  if (req.user.role !== 'superadmin' && user.firm_id !== req.firmId) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  // Work out the role being moved to, ignoring anything not a real role. A superadmin
  // keeps that rank unless explicitly changed to another valid one — importantly this is
  // resolved *before* the lockout check below, which has to reason about the new value.
  const requested = req.body.role;
  const validRole = requested && [...ROLES, 'superadmin'].includes(requested);
  const nextRole = validRole && req.user.role === 'superadmin' ? requested
    : (requested && ROLES.includes(requested) ? requested : user.role);
  const nextStatus = req.body.status || user.status;

  // Never let the last administrator be demoted or disabled — that would lock the firm
  // out of its own account with no way back in. "Administrator" covers superadmin too,
  // which an earlier version missed, letting the only owner demote themselves.
  const ADMIN_ROLES = ['admin', 'superadmin'];
  const admins = db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE firm_id=? AND role IN ('admin','superadmin') AND status='Active'`
  ).get(user.firm_id).c;
  const wasAdmin = ADMIN_ROLES.includes(user.role) && user.status === 'Active';
  const staysAdmin = ADMIN_ROLES.includes(nextRole) && nextStatus === 'Active';
  if (admins <= 1 && wasAdmin && !staysAdmin) {
    return res.status(400).json({ error: 'This is the firm\'s only administrator — promote someone else first.' });
  }

  db.prepare(`UPDATE users SET name=?, role=?, status=? WHERE id=?`).run(
    req.body.name ?? user.name,
    nextRole,
    nextStatus,
    user.id
  );
  if (req.body.new_password) {
    if (String(req.body.new_password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`)
      .run(bcrypt.hashSync(String(req.body.new_password), 10), user.id);
  }
  res.json({ success: true });
});

router.delete('/users/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'superadmin' && user.firm_id !== req.firmId) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });

  const admins = db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE firm_id=? AND role IN ('admin','superadmin') AND status='Active'`
  ).get(user.firm_id).c;
  if (admins <= 1 && ['admin', 'superadmin'].includes(user.role)) {
    return res.status(400).json({ error: 'This is the firm\'s only administrator — promote someone else first.' });
  }
  db.prepare(`DELETE FROM users WHERE id=?`).run(user.id);
  res.json({ success: true });
});

module.exports = router;
