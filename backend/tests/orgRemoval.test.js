const assert = require('assert');

// Deleting an organization, through the real routes: only Coaster may, only with the name typed,
// never one Coaster itself belongs to; everything the organization owns goes, down to the files
// hanging off its RFIs and reviews; accounts that belong nowhere else go when asked; nobody else's
// rows are touched; the audit record keeps the deletion.
//
//   DB_PATH=<scratch>/orgdel.db node tests/orgRemoval.test.js      (use a fresh database file)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const orgRemoval = require('../lib/orgRemoval');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

const PASSWORD = 'harbour lantern 4417 copper';
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api', requireAuth);
  app.use('/api/admin', require('../routes/admin'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const user = (email, role = 'member') => db.prepare(
    `INSERT INTO users (email, password_hash, name, role, status, email_verified_at) VALUES (?, ?, ?, ?, 'Active', datetime('now'))`,
  ).run(email, bcrypt.hashSync(PASSWORD, 4), email.split('@')[0], role).lastInsertRowid;
  const org = name => db.prepare(`INSERT INTO organizations (name) VALUES (?)`).run(name).lastInsertRowid;
  const member = (orgId, userId, role = 'Admin') =>
    db.prepare(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`).run(orgId, userId, role);
  const login = async email => (await call('POST', '/auth/login', { body: { email, password: PASSWORD } })).body.token;

  // Coaster, with its own organization; a fake one with a lone person, and a person who is also in
  // a real customer; and that real customer, with a project of its own that must survive.
  const owner = user('owner@coaster.app', 'superadmin');
  const coasterOrg = org('Coaster');
  member(coasterOrg, owner);
  const fake = org('Fake Co');
  const lone = user('lone@fake-co.com');
  const shared = user('shared@realbuild.com');
  member(fake, lone);
  member(fake, shared, 'Member');
  const real = org('Realbuild');
  member(real, shared);
  db.prepare(`INSERT INTO trial_accounts (email) VALUES ('lone@fake-co.com')`).run();

  const fill = orgId => {
    const program = db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, 'Main')`).run(orgId).lastInsertRowid;
    const project = db.prepare(`INSERT INTO projects (org_id, program_id, project_name) VALUES (?, ?, 'Job')`).run(orgId, program).lastInsertRowid;
    db.prepare(`INSERT INTO project_contracts (project_id, file_name, file_blob, terms, file_key) VALUES (?, 'c.pdf', x'00', '{}', ?)`)
      .run(project, `contract-${orgId}`);
    const review = db.prepare(`INSERT INTO invoice_reviews (org_id, project_id, extracted_data, checks_result, report_markdown) VALUES (?, ?, '{}', '{}', '')`)
      .run(orgId, project).lastInsertRowid;
    db.prepare(`INSERT INTO invoice_review_files (review_id, file_name, file_blob, file_key) VALUES (?, 'i.pdf', x'00', ?)`).run(review, `invoice-${orgId}`);
    const rfi = db.prepare(`INSERT INTO rfis (org_id, project_id, rfi_number, subject) VALUES (?, ?, '001', 'Duct')`).run(orgId, project).lastInsertRowid;
    const revision = db.prepare(`INSERT INTO rfi_revisions (rfi_id) VALUES (?)`).run(rfi).lastInsertRowid;
    db.prepare(`INSERT INTO rfi_files (rfi_id, revision_id, file_name, file_key) VALUES (?, ?, 'r.pdf', ?)`).run(rfi, revision, `rfi-${orgId}`);
  };
  fill(fake);
  fill(real);
  db.prepare(`UPDATE organizations SET logo_key = 'logo-fake' WHERE id = ?`).run(fake);

  const ownerToken = await login('owner@coaster.app');
  const loneToken = await login('lone@fake-co.com');

  await check('the preview says what goes, including files hanging off RFIs and reviews', async () => {
    const r = await call('GET', `/admin/organizations/${fake}/deletion`, { token: ownerToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.people, 2);
    const counts = Object.fromEntries(r.body.records.map(x => [x.table, x.count]));
    assert.deepStrictEqual([counts.projects, counts.project_contracts, counts.invoice_reviews, counts.rfis], [1, 1, 1, 1]);
    assert.deepStrictEqual(r.body.accounts.map(a => a.email), ['lone@fake-co.com'], 'only the person in nothing else');
    assert.deepStrictEqual(orgRemoval.storedFileKeys(fake).sort(), ['contract-' + fake, 'invoice-' + fake, 'logo-fake', 'rfi-' + fake].sort());
  });

  await check('only Coaster may delete an organization', async () => {
    assert.strictEqual((await call('GET', `/admin/organizations/${fake}/deletion`, { token: loneToken })).status, 403);
    assert.strictEqual((await call('DELETE', `/admin/organizations/${fake}`, { token: loneToken, body: { confirm_name: 'Fake Co' } })).status, 403);
  });

  await check('the name must be typed exactly', async () => {
    const r = await call('DELETE', `/admin/organizations/${fake}`, { token: ownerToken, body: { confirm_name: 'Fake' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM organizations WHERE id = ?`, fake), 1);
  });

  await check('not one Coaster itself belongs to', async () => {
    const r = await call('DELETE', `/admin/organizations/${coasterOrg}`, { token: ownerToken, body: { confirm_name: 'Coaster' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /belong/);
  });

  await check('deleting takes everything the organization owns, and nothing of anyone else', async () => {
    const r = await call('DELETE', `/admin/organizations/${fake}`, { token: ownerToken, body: { confirm_name: 'Fake Co', with_accounts: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.accountsDeleted, 1);
    for (const t of ['organizations WHERE id', 'programs WHERE org_id', 'projects WHERE org_id', 'invoice_reviews WHERE org_id', 'rfis WHERE org_id', 'org_members WHERE org_id']) {
      assert.strictEqual(count(`SELECT COUNT(*) n FROM ${t} = ?`, fake), 0, t);
    }
    // The child rows, found by what is left of them.
    assert.strictEqual(count(`SELECT COUNT(*) n FROM project_contracts WHERE file_key = ?`, `contract-${fake}`), 0);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM invoice_review_files WHERE file_key = ?`, `invoice-${fake}`), 0);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM rfi_files WHERE file_key = ?`, `rfi-${fake}`), 0);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM rfi_revisions`), 1, 'only Realbuild\'s revision is left');
    // Realbuild is untouched.
    assert.strictEqual(count(`SELECT COUNT(*) n FROM projects WHERE org_id = ?`, real), 1);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM invoice_review_files WHERE file_key = ?`, `invoice-${real}`), 1);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM rfi_files WHERE file_key = ?`, `rfi-${real}`), 1);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM project_contracts WHERE file_key = ?`, `contract-${real}`), 1);
    assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'no broken links');
  });

  await check('the lone account goes; the person in another company and Coaster stay', async () => {
    assert.strictEqual(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, lone), 0);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, shared), 1);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM org_members WHERE user_id = ? AND org_id = ?`, shared, real), 1);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, owner), 1);
  });

  await check('the trial list and the audit record are kept', async () => {
    assert.strictEqual(count(`SELECT COUNT(*) n FROM trial_accounts WHERE email = 'lone@fake-co.com'`), 1, 'no fresh trial for a fake sign-up');
    const entry = db.prepare(`SELECT * FROM audit_log WHERE action = 'org_deleted'`).get();
    assert.ok(entry, 'deletion recorded');
    assert.strictEqual(entry.org_id, fake);
    const detail = JSON.parse(entry.detail);
    assert.strictEqual(detail.name, 'Fake Co');
    assert.deepStrictEqual(detail.accountsDeleted, ['lone@fake-co.com']);
  });

  await check('left unticked, accounts are kept', async () => {
    const spare = org('Spare Co');
    const person = user('person@spare-co.com');
    member(spare, person);
    const r = await call('DELETE', `/admin/organizations/${spare}`, { token: ownerToken, body: { confirm_name: 'Spare Co' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.accountsDeleted, 0);
    assert.strictEqual(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, person), 1);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
