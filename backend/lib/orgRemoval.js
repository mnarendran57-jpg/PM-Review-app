const db = require('../database');

// Deleting an organization outright — for the fake and abandoned ones sign-up leaves behind.
//
// Everything the organization owns goes with it: its programs, projects, Shared Documents, every
// review, meeting, RFI and submittal, its team list and templates, and its people's places in it.
// Nothing about an organization is worth keeping once the organization is gone, so unlike deleting
// one project (lib/projectRemoval.js), nothing is left behind unassigned.
//
// Two things are kept on purpose:
//   - the audit record. It refuses deletes by design, and it is the record of who did this.
//   - the trial list (trial_accounts, trial_domains). It is how one email gets one free trial;
//     clearing it would hand a fake sign-up a fresh trial on its next attempt.
//
// The accounts of people who belong to no other organization can go too, when asked — a fake
// organization usually comes with a fake person. Coaster's own accounts never do.
//
// Like a project delete, the uploaded files are collected BEFORE the rows go: object storage has
// no foreign keys, and afterwards there is nothing left to read their names from.

const KEEP = new Set(['audit_log', 'organizations', 'trial_accounts', 'trial_domains', 'sqlite_sequence']);

const tables = () => db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
const columnsOf = t => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map(c => c.name);
const linksOf = t => db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(t);

// How to find each table's rows that belong to an organization, as SQL taking the org id once.
// Read from the schema, not written down, so a table added later is not quietly left out:
//   - it has an org_id                       → its own rows
//   - it hangs off a table that has one      → through that parent (rfi_files → rfis)
//   - it hangs off one of those              → two steps (rfi_files → rfi_revisions → rfis)
//   - it has a project_id                    → through the project
function ownership() {
  const cols = Object.fromEntries(tables().map(t => [t, columnsOf(t)]));
  const where = {};
  for (const [t, c] of Object.entries(cols)) {
    if (c.includes('org_id')) where[t] = `SELECT rowid FROM ${t} WHERE org_id = ?`;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const t of Object.keys(cols)) {
      if (where[t] || KEEP.has(t)) continue;
      const via = linksOf(t).find(f => where[f.table] && f.on_delete === 'CASCADE');
      if (via) {
        where[t] = `SELECT rowid FROM ${t} WHERE ${via.from} IN (SELECT ${via.to || 'id'} FROM ${via.table} WHERE rowid IN (${where[via.table]}))`;
      } else if (cols[t].includes('project_id') && where.projects) {
        where[t] = `SELECT rowid FROM ${t} WHERE project_id IN (SELECT id FROM projects WHERE org_id = ?)`;
      }
    }
  }
  return { cols, where };
}

// The org id, as many times as the query asks for it.
const run = (sql, orgId, method = 'all') => {
  const n = (sql.match(/\?/g) || []).length;
  return db.prepare(sql)[method](...Array(n).fill(orgId));
};

// What a person would recognise in the confirmation; the rest are counted and not listed.
const LABELS = {
  programs: 'Programs',
  projects: 'Projects',
  project_contracts: 'Shared Documents',
  invoice_reviews: 'Invoice reviews',
  pco_reviews: 'Change order reviews',
  cmar_audits: 'Pay app audits',
  pay_app_reviews: 'Pay app reviews',
  pay_app_reviews_2: 'Pay app reviews (Reviewer 2)',
  preconstruction_reviews: 'Pre-construction reviews',
  proposal_intakes: 'Proposal intakes',
  progress_reports: 'Progress reports',
  ve_analyses: 'VE analyses',
  submittals: 'Submittals',
  rfis: 'RFIs',
  meetings: 'Meetings',
  action_items: 'Action items',
  team_members: 'Team list contacts',
  ai_chats: 'Coaster AI chats',
  invitations: 'Open invitations',
};

// The people whose only organization this is — the accounts that would be left belonging to
// nothing. Coaster's own accounts are never among them.
function loneAccounts(orgId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND u.role != 'superadmin'
      AND NOT EXISTS (SELECT 1 FROM org_members o WHERE o.user_id = u.id AND o.org_id != ?)
    ORDER BY u.email
  `).all(orgId, orgId);
}

// Every stored file named by a row that is about to go: every *_key column of every owned table.
function storedFileKeys(orgId) {
  const { cols, where } = ownership();
  const keys = [];
  for (const [t, sql] of Object.entries(where)) {
    const keyCols = cols[t].filter(c => /_key$/.test(c));
    if (!keyCols.length) continue;
    try {
      for (const r of run(`SELECT ${keyCols.join(', ')} FROM ${t} WHERE rowid IN (${sql})`, orgId)) {
        keyCols.forEach(c => { if (r[c]) keys.push(r[c]); });
      }
    } catch { /* a table in an odd shape still deletes; its files are simply not reaped */ }
  }
  const org = db.prepare(`SELECT logo_key FROM organizations WHERE id = ?`).get(orgId);
  if (org?.logo_key) keys.push(org.logo_key);
  return [...new Set(keys)];
}

// What deleting would take, for the confirmation. Read-only.
function deletionPreview(orgId) {
  const org = db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).get(orgId);
  if (!org) return null;
  const { where } = ownership();
  const records = [];
  for (const [table, label] of Object.entries(LABELS)) {
    if (!where[table]) continue;
    const count = run(`SELECT COUNT(*) AS n FROM (${where[table]})`, orgId, 'get').n;
    if (count) records.push({ table, label, count });
  }
  const people = db.prepare(`SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?`).get(orgId).n;
  return {
    org,
    people,
    records,
    accounts: loneAccounts(orgId),
    fileCount: storedFileKeys(orgId).length,
  };
}

// Deletes the organization and everything it owns, in one transaction — all of it or none of it.
// Returns the stored file keys to remove once the rows are gone, and which accounts were deleted.
function deleteOrganization(orgId, { withAccounts = false } = {}) {
  const { where } = ownership();
  const keys = storedFileKeys(orgId);
  const accounts = withAccounts ? loneAccounts(orgId) : [];

  db.exec('BEGIN');
  try {
    // Checked at commit rather than per statement, so the order the tables go in does not matter.
    db.exec('PRAGMA defer_foreign_keys = ON');
    // Children before parents: a row is found through its parent, so the parent must still be there.
    const order = Object.keys(where).filter(t => !KEEP.has(t))
      .sort((a, b) => (where[b].match(/SELECT/g) || []).length - (where[a].match(/SELECT/g) || []).length);
    for (const t of order) run(`DELETE FROM ${t} WHERE rowid IN (${where[t]})`, orgId, 'run');
    db.prepare(`DELETE FROM organizations WHERE id = ?`).run(orgId);

    for (const a of accounts) {
      // A join request this person decided elsewhere keeps its decision, not their name.
      db.prepare(`UPDATE join_requests SET decided_by = NULL WHERE decided_by = ?`).run(a.id);
      db.prepare(`DELETE FROM users WHERE id = ? AND role != 'superadmin'`).run(a.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { keys, accounts };
}

module.exports = { deletionPreview, deleteOrganization, storedFileKeys, ownership };
