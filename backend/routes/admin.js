const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const access = require('../lib/access');
const email = require('../lib/email');
const plans = require('../lib/plans');
const { requireOrg, requireOrgAdmin, requirePlatformAdmin } = require('../middleware/auth');

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
  const rows = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count,
      (SELECT COUNT(*) FROM programs p WHERE p.org_id = o.id) AS program_count,
      (SELECT COUNT(*) FROM projects pr WHERE pr.org_id = o.id) AS project_count
    FROM organizations o ORDER BY o.name ASC
  `).all();
  // Each organization's administrators travel with it. The owner's job on this page is to see
  // who runs each customer and to change that; fetching them one organization at a time meant
  // switching organization context to answer a question about all of them at once.
  const adminsOf = db.prepare(`
    SELECT u.id AS user_id, u.name, u.email, u.status, m.role, m.created_at,
      (u.role = 'superadmin') AS is_platform_admin
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND m.role = 'Admin'
    ORDER BY u.name IS NULL, u.name ASC, u.email ASC
  `);

  // The resolved feature list travels with each row so the owner sees what a customer can
  // actually reach, not just the plan name — the two differ for a custom deal. `featureTotal`
  // comes from the catalogue rather than being written into the page: the count was hard-coded
  // as 6 and the catalogue has grown to 9, so every customer was shown "9 of 6 tools".
  res.json(rows.map((o) => {
    const admins = adminsOf.all(o.id);
    return {
      ...o,
      planName: o.plan ? (plans.planByKey(o.plan)?.name || o.plan) : 'All features',
      features: plans.featuresForOrg(o.id),
      featureTotal: plans.FEATURE_KEYS.length,
      admins,
      // Members who are not administrators. A count rather than a list: the owner's page is
      // about who runs each customer, and the roll of everyone inside it is the admin's business.
      member_count_non_admin: Math.max(0, o.member_count - admins.length),
    };
  }));
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

// --- Plans (vendor only) ---------------------------------------------------------------
// Which Coaster plan each customer is on. Owner-only: a customer administrator can see what
// their own organization includes (below) but cannot change what they are paying for.

router.get('/plans', requirePlatformAdmin, (req, res) => {
  res.json({ plans: plans.PLANS, features: plans.FEATURES });
});

router.put('/organizations/:id/plan', requirePlatformAdmin, (req, res) => {
  const org = db.prepare(`SELECT * FROM organizations WHERE id=?`).get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Not found' });

  const plan = String(req.body.plan || '');
  if (!plans.PLAN_KEYS.includes(plan)) {
    return res.status(400).json({ error: `Unknown plan. Choose one of: ${plans.PLAN_KEYS.join(', ')}` });
  }

  // Only a custom deal stores its own feature list; the named tiers read from lib/plans.js so
  // that editing a tier updates every customer on it.
  let features = null;
  if (plan === 'custom') {
    const wanted = Array.isArray(req.body.features) ? req.body.features.map(String) : [];
    const unknown = wanted.filter(k => !plans.FEATURE_KEYS.includes(k));
    if (unknown.length) return res.status(400).json({ error: `Unknown feature: ${unknown.join(', ')}` });
    features = JSON.stringify([...new Set(wanted)]);
  }

  db.prepare(`UPDATE organizations SET plan=?, plan_features=? WHERE id=?`).run(plan, features, org.id);
  res.json({ plan, features: plans.featuresForOrg(org.id) });
});

// What the signed-in user's own organization includes. Available to anyone in it — the app
// uses this to hide tools the customer has not bought, and it is not sensitive.
router.get('/my-plan', requireOrg, (req, res) => {
  const org = db.prepare(`SELECT plan FROM organizations WHERE id=?`).get(req.orgId);
  res.json({
    plan: org?.plan || null,
    planName: org?.plan ? (plans.planByKey(org.plan)?.name || org.plan) : 'All features',
    features: plans.featuresForOrg(req.orgId),
  });
});

// --- People in the active organization ------------------------------------------------

router.get('/members', requireOrgAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name, u.status,
      (u.role = 'superadmin') AS is_platform_admin,
      -- Also works with another customer, so their account details are the owner's to change.
      EXISTS (SELECT 1 FROM org_members o WHERE o.user_id = u.id AND o.org_id <> m.org_id) AS shared_account,
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
// One person has one account, so a consultant working for two customers is one login. Their
// name, password and active/disabled state therefore belong to the account, not to either
// organization — an org admin changing them would reach into a customer they have no
// relationship with. Those fields are reserved to the platform owner once an account is
// shared. What an org admin always keeps is control of that person *inside their own
// organization*: their role, their projects, and removing them entirely.
function accountIsShared(userId, orgId) {
  return !!db.prepare(`SELECT 1 FROM org_members WHERE user_id=? AND org_id<>?`).get(userId, orgId);
}

router.put('/members/:userId', requireOrgAdmin, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const membership = db.prepare(`SELECT * FROM org_members WHERE org_id=? AND user_id=?`)
    .get(req.orgId, user.id);
  if (!membership) return res.status(404).json({ error: 'They are not a member of this organization' });

  const touchesAccount = req.body.new_password !== undefined
    || req.body.status !== undefined
    || req.body.name !== undefined;
  if (touchesAccount
      && !access.isPlatformAdmin(req.user)
      && accountIsShared(user.id, req.orgId)) {
    return res.status(403).json({
      error: 'This person also works with another organization on Coaster, so their name, password '
        + 'and access are managed centrally. You can still change their role here, set which programs '
        + 'and projects they see, or remove them from this organization.',
    });
  }

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

  // Not in this organization is not this administrator's business — answer exactly as if the
  // account did not exist, matching the edit route, so an id cannot be probed by watching
  // which ones come back as success.
  const membership = db.prepare(`SELECT * FROM org_members WHERE org_id=? AND user_id=?`).get(req.orgId, user.id);
  if (!membership) return res.status(404).json({ error: 'Not found' });

  if (membership.role === 'Admin') {
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

// --- One person's programs and projects ------------------------------------------------
// Read and rewrite what a single member can reach inside the active organization. Org
// Admins already reach everything, so these routes describe and change grants for everyone
// else; the UI says as much rather than showing an admin a set of boxes that do nothing.

// The person must belong to this organization, else an admin of one customer could read or
// write grants for a stranger by guessing a user id.
function memberInOrg(userId, orgId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, m.role
    FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = ?
    WHERE u.id = ?
  `).get(orgId, userId) || null;
}

router.get('/members/:userId/access', requireOrgAdmin, (req, res) => {
  const person = memberInOrg(Number(req.params.userId), req.orgId);
  if (!person) return res.status(404).json({ error: 'Not found' });

  const programs = db.prepare(`
    SELECT g.id, g.name,
      EXISTS (SELECT 1 FROM program_members gm WHERE gm.program_id = g.id AND gm.user_id = ?) AS granted
    FROM programs g WHERE g.org_id = ? ORDER BY g.name ASC
  `).all(person.id, req.orgId);

  const projects = db.prepare(`
    SELECT p.id, p.project_name AS name, p.program_id,
      EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) AS granted
    FROM projects p WHERE p.org_id = ? ORDER BY p.project_name ASC
  `).all(person.id, req.orgId);

  res.json({
    user: { id: person.id, name: person.name, email: person.email, role: person.role },
    // An admin's access does not come from these rows, so the UI must not imply it does.
    isOrgAdmin: person.role === 'Admin',
    programs, projects,
  });
});

router.put('/members/:userId/access', requireOrgAdmin, (req, res) => {
  const person = memberInOrg(Number(req.params.userId), req.orgId);
  if (!person) return res.status(404).json({ error: 'Not found' });

  const wantPrograms = Array.isArray(req.body.program_ids) ? req.body.program_ids.map(Number) : [];
  const wantProjects = Array.isArray(req.body.project_ids) ? req.body.project_ids.map(Number) : [];

  // Only ids inside this organization survive, so a tampered request cannot grant access to
  // another customer's program or project.
  const okPrograms = db.prepare(`SELECT id FROM programs WHERE org_id = ?`).all(req.orgId).map(r => r.id);
  const okProjects = db.prepare(`SELECT id FROM projects WHERE org_id = ?`).all(req.orgId).map(r => r.id);
  const programIds = wantPrograms.filter(id => okPrograms.includes(id));
  const projectIds = wantProjects.filter(id => okProjects.includes(id));
  if (programIds.length !== wantPrograms.length || projectIds.length !== wantProjects.length) {
    return res.status(400).json({ error: 'That program or project is not in this organization' });
  }

  // Rewrite rather than merge: the form shows the complete picture, so what comes back is
  // the complete picture. Scoped to this organization so grants elsewhere are untouched.
  db.prepare(`
    DELETE FROM program_members WHERE user_id = ?
      AND program_id IN (SELECT id FROM programs WHERE org_id = ?)
  `).run(person.id, req.orgId);
  db.prepare(`
    DELETE FROM project_members WHERE user_id = ?
      AND project_id IN (SELECT id FROM projects WHERE org_id = ?)
  `).run(person.id, req.orgId);

  const addProgram = db.prepare(`INSERT OR IGNORE INTO program_members (program_id, user_id, role) VALUES (?, ?, 'Member')`);
  for (const id of programIds) addProgram.run(id, person.id);
  const addProject = db.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'PM')`);
  for (const id of projectIds) addProject.run(id, person.id);

  res.json({ success: true, programs: programIds.length, projects: projectIds.length });
});

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
