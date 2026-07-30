const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const access = require('../lib/access');

// Accepting an invitation happens before the person has an account, so these routes are
// deliberately public. The token in the URL is the only credential, which is why it is
// long, random, single-use and time-limited.

function loadInvite(token) {
  const invite = db.prepare(`
    SELECT i.*, o.name AS org_name, u.name AS inviter_name
    FROM invitations i
    JOIN organizations o ON o.id = i.org_id
    LEFT JOIN users u ON u.id = i.invited_by
    WHERE i.token = ?
  `).get(token);
  if (!invite) return { error: 'This invitation link is not valid.' };
  if (invite.revoked_at) return { error: 'This invitation has been cancelled.' };
  if (invite.accepted_at) return { error: 'This invitation has already been used. Try signing in instead.' };
  if (new Date(invite.expires_at) < new Date()) return { error: 'This invitation has expired. Ask for a new one.' };
  return { invite };
}

// Shown on the "set your password" page so the invitee can see who invited them and where.
router.get('/:token', (req, res) => {
  const { invite, error } = loadInvite(req.params.token);
  if (error) return res.status(400).json({ error });
  const existing = db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(invite.email);
  res.json({
    email: invite.email,
    role: invite.role,
    orgName: invite.org_name,
    inviterName: invite.inviter_name,
    // An existing account keeps its own password — see the accept handler.
    hasAccount: !!existing,
  });
});

router.post('/:token/accept', async (req, res) => {
  const { invite, error } = loadInvite(req.params.token);
  if (error) return res.status(400).json({ error });

  const existing = db.prepare(`SELECT * FROM users WHERE lower(email)=?`).get(invite.email);

  // Someone already has this email — most likely a consultant already working with another
  // organization. Joining must NOT set a new password: whoever holds the link would
  // otherwise be able to take over an existing account. They gain the membership and sign
  // in with the password they already have.
  if (existing) {
    db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`)
      .run(invite.org_id, existing.id, invite.role);
    db.prepare(`UPDATE invitations SET accepted_at = datetime('now') WHERE id=?`).run(invite.id);
    return res.json({ joined: true, existingAccount: true, email: existing.email, orgName: invite.org_name });
  }

  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const userId = db.prepare(`
    INSERT INTO users (email, password_hash, name, role, status) VALUES (?, ?, ?, 'user', 'Active')
  `).run(invite.email, bcrypt.hashSync(password, 10), (req.body.name || '').trim() || null).lastInsertRowid;

  db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`)
    .run(invite.org_id, userId, invite.role);
  db.prepare(`UPDATE invitations SET accepted_at = datetime('now') WHERE id=?`).run(invite.id);

  // Signed straight in — they just proved control of the invited address by using the link.
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
  res.json({
    joined: true,
    existingAccount: false,
    token: jwt.sign({ uid: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' }),
    user: { id: user.id, email: user.email, name: user.name, role: user.role, isPlatformAdmin: false },
    organizations: access.orgsForUser(user),
  });
});

module.exports = router;
