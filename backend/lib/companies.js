const db = require('../database');
const { domainOf } = require('./workEmail');

// The free trial is for one person, with their work email.
//
// Each person who signs up gets a workspace of their own, named for the company they gave, with a
// free trial on it. Two people from the same firm get two separate workspaces — sharing one between
// colleagues is not part of the trial (Naren, 22 October 2026). The work email is what qualifies
// someone for a trial at all: personal and throwaway addresses are refused at sign-up
// (lib/workEmail.js).
//
// The person is made a Contributor of their workspace, not its Admin: they can do everything with
// the work — programs, projects, every review — but there are no people in it to manage, and who
// manages a customer's people is Coaster's to decide when a trial becomes a subscription.
//
// One free trial per email address, ever. trial_accounts remembers every address that has had one,
// apart from the organizations table, so deleting a workspace and signing up again does not start
// the clock over.
//
// (Grouping colleagues into one company by email domain was built first, and its join requests are
// still in the schema and the Team page. Nothing creates one now.)

const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS) || 14);

// Starts a person's trial: their own workspace, with every tool, the clock running unless this
// address has had a trial before. Returns { org, trialGiven }. Calling it again for someone who
// already has a workspace returns that one rather than making a second.
function startTrial(user, { companyName } = {}) {
  const own = db.prepare(`
    SELECT o.* FROM organizations o JOIN org_members m ON m.org_id = o.id
    WHERE m.user_id = ? AND o.subscription_status IS NOT NULL ORDER BY o.id LIMIT 1
  `).get(user.id);
  if (own) return { org: own, trialGiven: false };

  const email = String(user.email).toLowerCase();
  const hadTrial = !!db.prepare(`SELECT 1 FROM trial_accounts WHERE email=?`).get(email);
  const name = String(companyName || '').trim() || domainOf(email);
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const orgId = Number(db.prepare(`
    INSERT INTO organizations (name, plan, subscription_status, trial_ends_at) VALUES (?, 'pro', ?, ?)
  `).run(name, hadTrial ? 'ended' : 'trial', hadTrial ? null : trialEnds).lastInsertRowid);
  if (!hadTrial) db.prepare(`INSERT OR IGNORE INTO trial_accounts (email) VALUES (?)`).run(email);
  db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Contributor')`).run(orgId, user.id);
  return { org: db.prepare(`SELECT * FROM organizations WHERE id=?`).get(orgId), trialGiven: !hadTrial };
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
  TRIAL_DAYS, startTrial, subscriptionOf, subscriptionOfOrg, pendingJoinFor, approversOf,
};
