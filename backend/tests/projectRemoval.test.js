const assert = require('assert');
const db = require('../database');
const removal = require('../lib/projectRemoval');
const access = require('../lib/access');

// Archiving and deleting a project, checked against throwaway rows.
//
// Deleting a project is the only irreversible action in this application, and what it destroys is
// not obvious: seventeen tables reference a project and the database treats them two ways. The
// confirmation dialog is built from deletionPreview, so if that under-reports, somebody loses a
// contract they were never warned about. That is what these tests are for.
//
// Everything here is created and removed inside the test. Nothing touches real project data.

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

const TAG = 'removal-test.invalid';

function cleanup() {
  const ids = db.prepare(`SELECT id FROM projects WHERE project_name LIKE ?`).all(`%${TAG}%`).map(r => r.id);
  for (const id of ids) db.prepare(`DELETE FROM projects WHERE id=?`).run(id);
  db.prepare(`DELETE FROM organizations WHERE name = ?`).run(TAG);
}

cleanup();

const orgId = db.prepare(`INSERT INTO organizations (name) VALUES (?)`).run(TAG).lastInsertRowid;
const programId = db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, 'P')`).run(orgId).lastInsertRowid;

// file_blob is NOT NULL on this table, so every document row carries one even when the real
// content lives in object storage and the blob is empty.
const addDoc = (projectId, fileName, docType, fileKey = null) => db.prepare(
  `INSERT INTO project_contracts (project_id, file_name, doc_type, file_key, file_blob, terms)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(projectId, fileName, docType, fileKey, Buffer.alloc(0), '{}');

const makeProject = name => db.prepare(
  `INSERT INTO projects (project_name, org_id, program_id, status) VALUES (?, ?, ?, 'Active')`,
).run(`${name} ${TAG}`, orgId, programId).lastInsertRowid;

// An org admin, so the visibility helper takes the admin path rather than the membership one.
const admin = { id: -1, role: 'superadmin' };

console.log('\nArchiving hides a project without destroying anything:');

check('an archived project drops out of the program list', () => {
  const id = makeProject('Archive me');
  const before = access.projectsForUser(admin, orgId, programId).map(p => p.id);
  assert.ok(before.includes(id), 'should be listed while active');

  removal.archive(id, orgId);
  const after = access.projectsForUser(admin, orgId, programId).map(p => p.id);
  assert.ok(!after.includes(id), 'should be hidden once archived');
});

check('it comes back when archived ones are asked for', () => {
  const id = makeProject('Findable');
  removal.archive(id, orgId);
  const shown = access.projectsForUser(admin, orgId, programId, { includeArchived: true }).map(p => p.id);
  assert.ok(shown.includes(id));
});

check('the project row and its records survive archiving', () => {
  const id = makeProject('Still here');
  addDoc(id, 'c.pdf', 'contract');
  removal.archive(id, orgId);

  assert.ok(db.prepare(`SELECT 1 FROM projects WHERE id=?`).get(id), 'the project must still exist');
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) AS n FROM project_contracts WHERE project_id=?`).get(id).n, 1,
    'its documents must be untouched',
  );
});

check('restoring puts it back on the list', () => {
  const id = makeProject('Back again');
  removal.archive(id, orgId);
  removal.restore(id, orgId);
  const shown = access.projectsForUser(admin, orgId, programId).map(p => p.id);
  assert.ok(shown.includes(id));
  assert.strictEqual(db.prepare(`SELECT status FROM projects WHERE id=?`).get(id).status, 'Active');
});

check('a direct link to an archived project still resolves', () => {
  // Archiving hides a project from the grid. It must not make it unreachable — every review
  // already filed against it still links there.
  const id = makeProject('Direct link');
  removal.archive(id, orgId);
  assert.ok(access.projectForUser(admin, id), 'projectForUser must still find it');
});

console.log('\nThe deletion preview tells the truth about what goes:');

check('cascading records are reported as destroyed', () => {
  const id = makeProject('Has documents');
  addDoc(id, 'a.pdf', 'contract');
  addDoc(id, 'b.pdf', 'drawings');

  const preview = removal.deletionPreview(id);
  const docs = preview.destroyed.find(d => d.table === 'project_contracts');
  assert.ok(docs, 'Shared Documents must appear in the destroyed list');
  assert.strictEqual(docs.count, 2);
  assert.ok(/Shared Documents/.test(docs.label), 'it must be named in words a PM recognises');
  assert.strictEqual(preview.destroysNothing, false);
});

check('set-null records are reported as kept, not destroyed', () => {
  const id = makeProject('Has a review');
  db.prepare(`
    INSERT INTO ve_analyses (org_id, project_id, extracted_data, entries_json)
    VALUES (?, ?, '{}', '[]')
  `).run(orgId, id);

  const preview = removal.deletionPreview(id);
  assert.ok(preview.orphaned.find(d => d.table === 've_analyses'),
    'a VE analysis survives a project delete and must be listed as orphaned');
  assert.ok(!preview.destroyed.find(d => d.table === 've_analyses'),
    'it must NOT be reported as destroyed — that would be a lie in the other direction');
});

check('a project with nothing attached says so', () => {
  const preview = removal.deletionPreview(makeProject('Empty'));
  assert.strictEqual(preview.destroysNothing, true);
  assert.strictEqual(preview.destroyed.length, 0);
});

check('the dependent list is read from the schema, so a new table cannot be missed', () => {
  const tables = removal.dependents().map(d => d.table);
  // These four are the ones whose loss would actually hurt. If the schema stops listing them the
  // preview would go quiet about them, which is the failure this guards.
  for (const t of ['project_contracts', 'submittals', 'rfis', 've_analyses']) {
    assert.ok(tables.includes(t), `${t} should be discovered as a dependent of projects`);
  }
  assert.ok(tables.length >= 15, `expected the full dependent set, found ${tables.length}`);
});

console.log('\nStored files are collected before the rows go:');

check('files on cascading tables are collected for removal', () => {
  const id = makeProject('Has files');
  addDoc(id, 'a.pdf', 'contract', 'key-aaa');
  addDoc(id, 'b.pdf', 'drawings', 'key-bbb');

  const keys = removal.storedFileKeys(id);
  assert.ok(keys.includes('key-aaa') && keys.includes('key-bbb'),
    `expected both document keys, got ${JSON.stringify(keys)}`);
});

check('files belonging to records that SURVIVE are not collected', () => {
  // A VE analysis outlives the project. Deleting its file would break a record that still exists
  // and can still be opened — the opposite error, and a worse one.
  const id = makeProject('Survivor files');
  db.prepare(`
    INSERT INTO ve_analyses (org_id, project_id, extracted_data, entries_json, estimate_file_key)
    VALUES (?, ?, '{}', '[]', 'key-must-survive')
  `).run(orgId, id);

  assert.ok(!removal.storedFileKeys(id).includes('key-must-survive'),
    'a surviving record\'s file must never be reaped');
});

console.log('\nDeleting actually does what the preview said:');

check('cascading rows go and surviving rows are unassigned', () => {
  const id = makeProject('Delete me');
  addDoc(id, 'a.pdf', 'contract');
  const ve = db.prepare(`
    INSERT INTO ve_analyses (org_id, project_id, extracted_data, entries_json) VALUES (?, ?, '{}', '[]')
  `).run(orgId, id).lastInsertRowid;

  db.prepare(`DELETE FROM projects WHERE id=? AND org_id=?`).run(id, orgId);

  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM project_contracts WHERE project_id=?`).get(id).n, 0,
    'Shared Documents must be gone');
  const survivor = db.prepare(`SELECT project_id FROM ve_analyses WHERE id=?`).get(ve);
  assert.ok(survivor, 'the VE analysis must still exist');
  assert.strictEqual(survivor.project_id, null, 'and must no longer point at a project');
});

check('deleting one project leaves its neighbours alone', () => {
  const doomed = makeProject('Doomed');
  const keeper = makeProject('Keeper');
  addDoc(keeper, 'k.pdf', 'contract');

  db.prepare(`DELETE FROM projects WHERE id=? AND org_id=?`).run(doomed, orgId);

  assert.ok(db.prepare(`SELECT 1 FROM projects WHERE id=?`).get(keeper), 'the other project must survive');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM project_contracts WHERE project_id=?`).get(keeper).n, 1,
    'and keep its documents');
});

cleanup();

// Nothing may be left behind, or the next run starts from a dirty database.
const leftovers = db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE project_name LIKE ?`).get(`%${TAG}%`).n;
check('the test cleans up after itself', () => assert.strictEqual(leftovers, 0));

console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
  + `${failed ? `, ${failed} FAILED` : '.'}`);
process.exit(failed === 0 ? 0 : 1);
