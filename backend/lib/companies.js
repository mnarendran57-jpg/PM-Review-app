const db = require('../database');
const { domainOf } = require('./workEmail');

// Companies are recognised by their email domain.
//
// The first person from "olivier-inc.com" to confirm their email creates the Olivier Inc.
// organization, and the company's free trial starts. They are made a Contributor, not an Admin:
// they can start work at once — programs, projects, every review — but managing the company's
// people is not something signing up first entitles anyone to. Coaster decides who a company's
// Admin is, and appoints them once the company is using Coaster (October 2026).
//
// Anyone from that domain afterwards does not get a second organization: they ask to join this one,
// and are let in by its Admin — or by Coaster, while it has none. That is what stops a stranger who
// happens to know a company's name from walking into its projects: a person, not the email address
// alone, decides who is inside.
//
// A domain gets one free trial, ever. trial_domains remembers every domain that has had one, apart
// from the organizations table, so deleting a company and signing it up again does not start the
// clock over.

const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS) || 14);

const orgForDomain = domain => (domain
  ? db.prepare(`SELECT * FROM organizations WHERE email_domain = ?`).get(domain)
  : null);

// What happens to a person the moment their address is confirmed. Returns one of
//   { outcome: 'created', org }   — first from their company: organization made, they are its admin
//   { outcome: 'pending', org }   — their company is here already: a request to join is waiting
//   { outcome: 'member', org }    — already inside (confirmed twice, or invited earlier)
function placeConfirmedUser(user, { companyName } = {}) {
  const domain = domainOf(user.email);
  const existing = orgForDomain(domain);

  if (existing) {
    const member = db.prepare(`SELECT 1 FROM org_members WHERE org_id=? AND user_id=?`).get(existing.id, user.id);
    if (member) return { outcome: 'member', org: existing };
    const open = db.prepare(`SELECT id FROM join_requests WHERE org_id=? AND user_id=? AND status='pending'`).get(existing.id, user.id);
    if (!open) {
      db.prepare(`INSERT INTO join_requests (org_id, user_id) VALUES (?, ?)`).run(existing.id, user.id);
    }
    return { outcome: 'pending', org: existing };
  }

  // A company's first person. The organization gets every tool during its trial — the trial is for
  // finding out what Coaster does — and the trial clock starts unless this domain has had one.
  const hadTrial = !!db.prepare(`SELECT 1 FROM trial_domains WHERE domain=?`).get(domain);
  const name = String(companyName || '').trim() || domain;
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const create = db.prepare(`
    INSERT INTO organizations (name, email_domain, plan, subscription_status, trial_ends_at)
    VALUES (?, ?, 'pro', ?, ?)
  `);
  const orgId = Number(create.run(name, domain, hadTrial ? 'ended' : 'trial', hadTrial ? null : trialEnds).lastInsertRowid);
  if (!hadTrial) db.prepare(`INSERT OR IGNORE INTO trial_domains (domain) VALUES (?)`).run(domain);
  db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Contributor')`).run(orgId, user.id);
  return { outcome: 'created', org: db.prepare(`SELECT * FROM organizations WHERE id=?`).get(orgId), trialGiven: !hadTrial };
}

// Where an organization stands, for the banner in the app and the gate on the tools. An
// organization made before sign-up existed has no subscription status, and is never stopped.
function subscriptionOf(org) {
  if (!org || !org.subscription_status) return { status: null, active: true };
  if (org.subscription_status === 'active') return { status: 'active', active: true };
  if (org.subscription_status === 'trial') {
    const endsAt = org.trial_ends_at ? Date.parse(org.trial_ends_at) : NaN;
    const msLeft = endsAt - Date.now();
    if (Number.isFinite(msLeft) && msLeft > 0) {
      return { status: 'trial', active: true, trialEndsAt: org.trial_ends_at, daysLeft: Math.ceil(msLeft / 86400000) };
    }
    return { status: 'trial-ended', active: false, trialEndsAt: org.trial_ends_at };
  }
  return { status: 'ended', active: false };
}

const subscriptionOfOrg = orgId => subscriptionOf(db.prepare(`SELECT * FROM organizations WHERE id=?`).get(orgId));

// The pending request to join a company that a person is waiting on, if any — so the app can say
// "waiting for approval" rather than show them an empty list of organizations.
function pendingJoinFor(userId) {
  return db.prepare(`
    SELECT j.id, j.created_at, o.name AS org_name
    FROM join_requests j JOIN organizations o ON o.id = j.org_id
    WHERE j.user_id = ? AND j.status = 'pending'
    ORDER BY j.id DESC LIMIT 1
  `).get(userId) || null;
}

// Who to tell when someone asks to join: the company's Admins, or — while Coaster has appointed
// none — Coaster's own platform admins, who answer for it until then. `forCoaster` says which.
function approversOf(orgId) {
  const admins = db.prepare(`
    SELECT u.id, u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND m.role = 'Admin' AND u.status = 'Active'
  `).all(orgId);
  if (admins.length) return { people: admins, forCoaster: false };
  return {
    people: db.prepare(`SELECT id, email, name FROM users WHERE role = 'superadmin' AND status = 'Active'`).all(),
    forCoaster: true,
  };
}

module.exports = {
  TRIAL_DAYS, orgForDomain, placeConfirmedUser, subscriptionOf, subscriptionOfOrg, pendingJoinFor, approversOf,
};
