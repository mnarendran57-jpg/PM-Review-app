const db = require('../database');

// Taking a project off the board — what that costs, and what it takes with it.
//
// TWO DIFFERENT ACTIONS, DELIBERATELY NOT THE SAME BUTTON
//
// ARCHIVING is the everyday one. A job finishes, or was set up twice by mistake, and the PM wants
// it out of the way. It sets a status, hides the project from the program, and destroys nothing.
// It is reversible, and it is what almost everybody actually wants.
//
// DELETING is not reversible and is not symmetrical. Seventeen tables reference a project, and the
// database treats them two ways: some CASCADE, and those rows are gone — including Shared
// Documents, which holds the contract. The rest are SET NULL, so the reviews survive but no longer
// belong to anything. Nobody can hold that distinction in their head while clicking a red button,
// so this module works it out and the confirmation prints it.
//
// The uploaded files are the part that has no foreign key at all. Object storage knows nothing
// about SQLite, so a cascade deletes the row that names the file and leaves the file itself sitting
// in the bucket for ever, still costing money. Their keys are collected BEFORE the delete, because
// afterwards there is nothing left to read them from.

const ARCHIVED = 'Archived';

// What the database does to each table when a project row disappears. Read out of the schema at
// startup rather than written down, because a list written down drifts the moment a table is added
// — and a new table missing from this list would silently under-report what a delete destroys.
function dependents() {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  const out = [];
  for (const table of tables) {
    let fks = [];
    try { fks = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table); } catch { continue; }
    const toProject = fks.find(f => f.table === 'projects');
    if (toProject) out.push({ table, column: toProject.from, onDelete: toProject.on_delete });
  }
  return out;
}

// Labels for the tables a PM would recognise. Anything not named here is still counted and still
// reported, under its own table name — an unnamed table in the confirmation is untidy, but a table
// left out of it entirely is a lie.
const LABELS = {
  project_contracts: 'Shared Documents (contract, drawings, specs, estimates)',
  project_members: 'Project team members',
  submittals: 'Submittals',
  rfis: 'RFIs',
  meetings: 'Meetings',
  action_items: 'Action items',
  pay_applications: 'Pay applications',
  pay_app_reviews: 'Pay app reviews',
  pay_app_reviews_2: 'Pay app reviews (Reviewer 2)',
  cmar_audits: 'Pay app audits (Reviewer 3)',
  invoices: 'Invoices',
  invoice_reviews: 'Invoice reviews',
  pco_reviews: 'Change order reviews',
  preconstruction_reviews: 'Pre-construction reviews',
  progress_reports: 'Progress reports',
  ve_analyses: 'VE analyses',
  ai_chats: 'Coaster AI chats',
};

const countIn = (table, column, projectId) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(projectId).n;
  } catch {
    return 0;
  }
};

// Everything a delete would touch, split by what actually happens to it. Read-only: this is what
// the confirmation dialog is built from, and it must be safe to call at any time.
function deletionPreview(projectId) {
  const destroyed = [];
  const orphaned = [];

  for (const dep of dependents()) {
    const count = countIn(dep.table, dep.column, projectId);
    if (!count) continue;
    const entry = { table: dep.table, label: LABELS[dep.table] || dep.table, count };
    if (dep.onDelete === 'CASCADE') destroyed.push(entry);
    else orphaned.push(entry);
  }

  const sort = rows => rows.sort((a, b) => b.count - a.count);
  const files = storedFileKeys(projectId);

  return {
    destroyed: sort(destroyed),
    orphaned: sort(orphaned),
    fileCount: files.length,
    // A delete that would destroy nothing is worth saying out loud — it turns a frightening
    // confirmation into an easy one.
    destroysNothing: destroyed.length === 0,
  };
}

// The object-storage keys that belong to rows about to be cascaded away.
//
// ONLY the cascading tables. A review that merely loses its project link keeps its file, and
// deleting that file would break a record that still exists and can still be opened.
function storedFileKeys(projectId) {
  const keys = [];
  const add = rows => rows.forEach(r => Object.values(r).forEach(v => { if (v) keys.push(v); }));

  try {
    add(db.prepare(`SELECT file_key FROM project_contracts WHERE project_id = ?`).all(projectId));
  } catch { /* table shape changed; the rows still delete, the files are simply not reaped */ }
  try {
    add(db.prepare(`SELECT file_key FROM meetings WHERE project_id = ?`).all(projectId));
  } catch { /* as above */ }
  // Files hanging off a cascading parent rather than off the project directly.
  for (const [table, parent, parentTable] of [
    ['submittal_files', 'submittal_id', 'submittals'],
    ['rfi_files', 'rfi_id', 'rfis'],
  ]) {
    try {
      add(db.prepare(`
        SELECT f.file_key FROM ${table} f
        JOIN ${parentTable} p ON p.id = f.${parent}
        WHERE p.project_id = ?
      `).all(projectId));
    } catch { /* as above */ }
  }

  return [...new Set(keys.filter(Boolean))];
}

const archive = (projectId, orgId) => db.prepare(
  `UPDATE projects SET status = ? WHERE id = ? AND org_id = ?`,
).run(ARCHIVED, projectId, orgId);

// Restoring puts a project back to Active rather than to whatever it was before. The previous
// status is not kept: a column recording it would be one more thing to migrate, and "Active" is
// right in every case anybody has actually had.
const restore = (projectId, orgId) => db.prepare(
  `UPDATE projects SET status = 'Active' WHERE id = ? AND org_id = ?`,
).run(projectId, orgId);

module.exports = {
  ARCHIVED, deletionPreview, storedFileKeys, dependents, archive, restore, LABELS,
};
