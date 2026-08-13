const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const access = require('../lib/access');
const email = require('../lib/email');

const RESET_MINUTES = 60;
// A reset link can take over an account, so a flood of them is worth stopping even though
// each one only reaches the real inbox.
const RESET_MAX_PER_HOUR = 5;

// One account is one person. Deliberately not tied to an organization: the same
// consultant often works for several customers and must not need a second login. Which
// organization they are working in is chosen after sign-in and travels per request.
function issueToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicUser(user) {
  return {
    id: user.id, email: user.email, name: user.name,
    address: user.address ?? null, company: user.company ?? null, phone: user.phone ?? null,
    role: user.role, isPlatformAdmin: user.role === 'superadmin',
  };
}

function userFromToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(claims.uid);
    if (!user || user.status !== 'Active') return null;
    return access.tokenStillValid(user, claims) ? user : null;
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

  // The organizations they can reach come back with the login so the app can go straight
  // to the picker (or skip it when there is only one).
  res.json({
    token: issueToken(user),
    user: publicUser(user),
    organizations: access.orgsForUser(user),
  });
});

// Who am I — the frontend calls this on load to restore the session and decide which
// admin screens to show.
router.get('/me', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  res.json({ user: publicUser(user), organizations: access.orgsForUser(user) });
});

// A person's own details. Everything here belongs to the ACCOUNT rather than to an
// organization, which is why it is edited from a personal settings page and not from the Team
// tab: a consultant working with two customers has one name, one address and one login, and
// neither customer's admin should be reaching into it.
router.patch('/profile', async (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });

  const text = v => (v === undefined ? undefined : (String(v).trim() || null));
  const name = text(req.body.name);
  const address = text(req.body.address);
  const company = text(req.body.company);
  const phone = text(req.body.phone);

  // The email is the sign-in credential, so it is treated as one. Changing it needs the current
  // password — the same protection changing the password itself gets — because an unattended
  // session would otherwise be enough to move somebody's account to an address they control.
  let email;
  if (req.body.email !== undefined) {
    const wanted = String(req.body.email).trim().toLowerCase();
    if (wanted && wanted !== user.email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) {
        return res.status(400).json({ error: 'That does not look like an email address.' });
      }
      if (!(await bcrypt.compare(req.body.current_password || '', user.password_hash || ''))) {
        return res.status(401).json({
          error: 'Enter your current password to change the email you sign in with.',
        });
      }
      const taken = db.prepare(`SELECT 1 FROM users WHERE lower(email)=? AND id<>?`).get(wanted, user.id);
      if (taken) return res.status(409).json({ error: 'Another account already uses that email.' });
      email = wanted;
    }
  }

  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name), address = COALESCE(?, address),
      company = COALESCE(?, company), phone = COALESCE(?, phone),
      email = COALESCE(?, email)
    WHERE id = ?
  `).run(
    name === undefined ? null : name, address === undefined ? null : address,
    company === undefined ? null : company, phone === undefined ? null : phone,
    email ?? null, user.id
  );

  // COALESCE keeps a field that was not sent, but it also keeps one deliberately CLEARED. So a
  // field the caller explicitly set to empty is nulled in a second pass — "" and "not mentioned"
  // are different instructions and the first one has to survive.
  const clear = [];
  if (name === null) clear.push('name');
  if (address === null) clear.push('address');
  if (company === null) clear.push('company');
  if (phone === null) clear.push('phone');
  for (const col of clear) db.prepare(`UPDATE users SET ${col}=NULL WHERE id=?`).run(user.id);

  const fresh = db.prepare(`SELECT * FROM users WHERE id=?`).get(user.id);
  res.json({ user: publicUser(fresh), emailChanged: !!email });
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

// --- Forgot password -------------------------------------------------------------------
// Unlike an invitation, the person asking here has proved nothing, so the link is never
// returned in the response — it only ever goes to the address on the account. That also
// means this flow is unavailable until an email provider is configured, and says so.

function loadReset(token) {
  const row = db.prepare(`
    SELECT r.*, u.email, u.name, u.status
    FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token = ?
  `).get(token);
  if (!row) return { error: 'This reset link is not valid. Ask for a new one.' };
  if (row.used_at) return { error: 'This reset link has already been used. Ask for a new one.' };
  if (new Date(row.expires_at) < new Date()) return { error: 'This reset link has expired. Ask for a new one.' };
  if (row.status !== 'Active') return { error: 'This account is no longer active.' };
  return { reset: row };
}

router.post('/forgot-password', async (req, res) => {
  const address = String(req.body.email || '').trim().toLowerCase();
  if (!address) return res.status(400).json({ error: 'Enter your email address' });

  // Nothing to send with, and no point pretending otherwise — this is a fact about the
  // installation, not about whether this particular address has an account.
  if (!email.isConfigured()) {
    return res.status(503).json({
      error: 'Password reset email is not set up on this site yet. Ask your administrator to set a new password for you.',
      emailConfigured: false,
    });
  }

  const user = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(address);
  if (user && user.status === 'Active') {
    const recent = db.prepare(`
      SELECT COUNT(*) AS c FROM password_resets
      WHERE user_id = ? AND created_at > datetime('now', '-1 hour')
    `).get(user.id).c;

    if (recent < RESET_MAX_PER_HOUR) {
      // Asking again supersedes any earlier link, so a forwarded old email stops working.
      db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(user.id);

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + RESET_MINUTES * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO password_resets (user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?)
      `).run(user.id, token, expires, req.ip || null);

      const base = (process.env.APP_BASE_URL || req.headers.origin || '').replace(/\/$/, '');
      await email.sendPasswordReset({
        to: user.email, name: user.name, minutes: RESET_MINUTES,
        link: `${base}/reset-password/${token}`,
      });
    }
  }

  // Always the same answer, whether or not that address has an account and whether or not
  // the send succeeded. Anything else turns this into a way to discover who has a login.
  res.json({ sent: true });
});

// Lets the reset page show whose account it is before they type a new password.
router.get('/reset-password/:token', (req, res) => {
  const { reset, error } = loadReset(req.params.token);
  if (error) return res.status(400).json({ error });
  res.json({ email: reset.email, name: reset.name });
});

router.post('/reset-password/:token', (req, res) => {
  const { reset, error } = loadReset(req.params.token);
  if (error) return res.status(400).json({ error });

  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  db.prepare(`UPDATE users SET password_hash = ?, sessions_valid_from = datetime('now') WHERE id = ?`)
    .run(bcrypt.hashSync(password, 10), reset.user_id);
  // Single use, and any other outstanding link for this account dies with it.
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`)
    .run(reset.user_id);

  // Signed straight in: they just proved control of the account's inbox.
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(reset.user_id);
  res.json({
    token: issueToken(user),
    user: publicUser(user),
    organizations: access.orgsForUser(user),
  });
});

module.exports = router;
