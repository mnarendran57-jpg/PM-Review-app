const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const access = require('../lib/access');
const email = require('../lib/email');
const { requireOrgAdmin, requirePlatformAdmin } = require('../middleware/auth');

// Two levels of administration:
//  - platform admin (the vendor) creates customer Organizations and their first Admin.
//    There is deliberately no public signup.
//  - Org Admin manages the people inside their own organization.
//
// Because a user account is not owned by any organization, "adding someone" means either
// creating the account (if this is the first time anyone has invited that email) and then
// attaching a membership, or simply attaching a membership to the account that exists.

const ORG_ROLES = ['Admin', 'Member'];

// --- Organizations (vendor only) ------------------------------------------------------

router.get('/organizations', requirePlatformAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count,
      (SELECT COUNT(*) FROM programs p WHERE p.org_id = o.id) AS program_count,
      (SELECT COUNT(*) FROM projects pr WHERE pr.org_id = o.id) AS project_count
    FROM organizations o ORDER BY o.name ASC
  `).all());
});

// Creates the organization, its first program (every organization always has at least
// one), and its first administrator — an organization nobody can sign into is useless.
router.post('/organizations', requirePlatformAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.admin_email || '').trim().toLowerCase();
  const password = String(req.body.admin_password || '');
  if (!name) return res.status(400).json({ error: 'Organization name is required' });
  if (!email) return res.status(400).json({ error: 'An administrator email is required' });

  const existingUser = db.prepare(`SELECT * FROM users WHERE lower(email)=?`).get(email);
  if (!existingUser && password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const orgId = db.prepare(`INSERT INTO organizations (name) VALUES (?)`).run(name).lastInsertRowid;
  db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, ?)`)
    .run(orgId, String(req.body.program_name || 'Default Program').trim() || 'Default Program');

  // An existing person can administer another organization on the same account.
  const userId = existingUser
    ? existingUser.id
    : db.prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)`)
        .run(email, bcrypt.hashSync(password, 10), req.body.admin_name || null).lastInsertRowid;

  db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Admin')`)
    .run(orgId, userId);
  res.json({ id: orgId, admin_user_id: userId, reused_existing_account: !!existingUser });
});

router.put('/organizations/:id', requirePlatformAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required' });
  db.prepare(`UPDATE organizations SET name=?, status=? WHERE id=?`)
    .run(name, req.body.status || 'Active', req.params.id);
  res.json({ success: true });
});

// --- People in the active organization ------------------------------------------------

router.get('/members', requireOrgAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name, u.status,
      (u.role = 'superadmin') AS is_platform_admin,
      (SELECT COUNT(*) FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
        WHERE pm.user_id = u.id AND p.org_id = m.org_id) AS project_count
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY u.name IS NULL, u.name ASC, u.email ASC
  `).all(req.orgId));
});

// Everyone who can reach this organization, including people who are only on a project
// within it — those have no org_members row, so the members list alone would miss them.
router.get('/people', requireOrgAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT DISTINCT u.id, u.email, u.name, u.status,
      (SELECT role FROM org_members m WHERE m.org_id=? AND m.user_id=u.id LIMIT 1) AS org_role
    FROM users u
    WHERE EXISTS (SELECT 1 FROM org_members m WHERE m.org_id=? AND m.user_id=u.id)
       OR EXISTS (SELECT 1 FROM project_members pm JOIN projects p ON p.id=pm.project_id
                  WHERE pm.user_id=u.id AND p.org_id=?)
    ORDER BY u.name IS NULL, u.name ASC, u.email ASC
  `).all(req.orgId, req.orgId, req.orgId));
});

// Adds someone to this organization. If no account exists for that email one is created,
// which is how a brand-new person is onboarded; if it does, the same single account gains
// another membership rather than a duplicate login.
router.post('/members', requireOrgAdmin, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = ORG_ROLES.includes(req.body.role) ? req.body.role : 'Member';
  if (!email) return res.status(400).json({ error: 'Email is required' });

  let user = db.prepare(`SELECT * FROM users WHERE lower(email)=?`).get(email);
  if (!user) {
    const password = String(req.body.password || '');
    if (password.length < 8) {
      return res.status(400).json({ error: 'This is a new person — set a starting password of at least 8 characters.' });
    }
    const id = db.prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)`)
      .run(email, bcrypt.hashSync(password, 10), req.body.name || null).lastInsertRowid;
    user = db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
  } else if (req.body.name && !user.name) {
    db.prepare(`UPDATE users SET name=? WHERE id=?`).run(req.body.name, user.id);
  }

  db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`)
    .run(req.orgId, user.id, role);
  res.json({ user_id: user.id, existed: !!user });
});

// Changes someone's role in this organization, or resets their password. Guards against
// an organization being left with nobody able to administer it.
router.put('/members/:userId', requireOrgAdmin, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const membership = db.prepare(`SELECT * FROM org_members WHERE org_id=? AND user_id=?`)
    .get(req.orgId, user.id);
  if (!membership) return res.status(404).json({ error: 'They are not a member of this organization' });

  if (req.body.role && ORG_ROLES.includes(req.body.role) && req.body.role !== membership.role) {
    const admins = db.prepare(`
      SELECT COUNT(*) AS c FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id=? AND m.role='Admin' AND u.status='Active'
    `).get(req.orgId).c;
    if (admins <= 1 && membership.role === 'Admin' && req.body.role !== 'Admin') {
      return res.status(400).json({ error: 'This is the organization\'s only administrator — promote someone else first.' });
    }
    db.prepare(`UPDATE org_members SET role=? WHERE id=?`).run(req.body.role, membership.id);
  }

  if (req.body.name !== undefined) {
    db.prepare(`UPDATE users SET name=? WHERE id=?`).run(req.body.name || null, user.id);
  }
  if (req.body.status) {
    db.prepare(`UPDATE users SET status=? WHERE id=?`).run(req.body.status, user.id);
  }
  if (req.body.new_password) {
    if (String(req.body.new_password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`)
      .run(bcrypt.hashSync(String(req.body.new_password), 10), user.id);
  }
  res.json({ success: true });
});

// Removes someone from this organization only — their account and any work with other
// organizations is untouched, which is the point of accounts not belonging to one.
router.delete('/members/:userId', requireOrgAdmin, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own access' });

  const membership = db.prepare(`SELECT * FROM org_members WHERE org_id=? AND user_id=?`).get(req.orgId, user.id);
  if (membership?.role === 'Admin') {
    const admins = db.prepare(`
      SELECT COUNT(*) AS c FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id=? AND m.role='Admin' AND u.status='Active'
    `).get(req.orgId).c;
    if (admins <= 1) {
      return res.status(400).json({ error: 'This is the organization\'s only administrator — promote someone else first.' });
    }
  }

  db.prepare(`DELETE FROM org_members WHERE org_id=? AND user_id=?`).run(req.orgId, user.id);
  db.prepare(`
    DELETE FROM project_members WHERE user_id=? AND project_id IN (SELECT id FROM projects WHERE org_id=?)
  `).run(user.id, req.orgId);
  res.json({ success: true });
});

// --- Invitations ----------------------------------------------------------------------
// Inviting is preferred over creating someone's account for them: the invitee sets their
// own password, so nobody else ever knows it. The link is returned to the admin as well as
// emailed, so this works whether or not an email provider is configured.

const INVITE_DAYS = 7;

router.get('/invitations', requireOrgAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT i.id, i.email, i.role, i.token, i.expires_at, i.created_at, u.name AS invited_by_name
    FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
    WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at > datetime('now')
    ORDER BY i.created_at DESC
  `).all(req.orgId));
});

router.post('/invitations', requireOrgAdmin, async (req, res) => {
  const address = String(req.body.email || '').trim().toLowerCase();
  const role = ORG_ROLES.includes(req.body.role) ? req.body.role : 'Member';
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  // Already a member here? Nothing to invite them to.
  const already = db.prepare(`
    SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id=? AND lower(u.email)=?
  `).get(req.orgId, address);
  if (already) return res.status(400).json({ error: 'That person is already in this organization' });

  // Re-inviting replaces any outstanding invitation rather than piling them up.
  db.prepare(`
    UPDATE invitations SET revoked_at = datetime('now')
    WHERE org_id=? AND lower(email)=? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(req.orgId, address);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const id = db.prepare(`
    INSERT INTO invitations (org_id, email, role, token, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.orgId, address, role, token, req.user.id, expires).lastInsertRowid;

  const base = (process.env.APP_BASE_URL || req.headers.origin || '').replace(/\/$/, '');
  const link = `${base}/invite/${token}`;
  const org = db.prepare(`SELECT name FROM organizations WHERE id=?`).get(req.orgId);

  const delivery = await email.sendInvitation({
    to: address, orgName: org?.name || 'your organization',
    inviterName: req.user.name, role, link,
  });

  res.json({
    id, email: address, role, link, expires_at: expires,
    emailed: delivery.sent,
    // Distinguishes "no email provider set up" from "it was set up and failed", so a
    // broken SMTP password doesn't look like an intentional copy-the-link flow.
    emailConfigured: email.isConfigured(),
    emailError: delivery.sent ? null : delivery.reason,
  });
});

router.delete('/invitations/:id', requireOrgAdmin, (req, res) => {
  const invite = db.prepare(`SELECT * FROM invitations WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!invite) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE invitations SET revoked_at = datetime('now') WHERE id=?`).run(invite.id);
  res.json({ success: true });
});

module.exports = router;
