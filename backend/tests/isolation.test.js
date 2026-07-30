// Acceptance checks for tenant isolation, run against the HTTP API rather than the UI —
// the point is that no endpoint returns another organization's data even when called
// directly with a forged organization header or a guessed record id.
//
//   node tests/isolation.test.js          (backend must be running on :3001)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const bcrypt = require('bcryptjs');
const db = require('../database');

const B = process.env.TEST_API || 'http://localhost:3001/api';
const call = async (method, path, { body, token, org } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (org) headers['X-Org-Id'] = String(org);
  const res = await fetch(B + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const rows = r => (Array.isArray(r.body) ? r.body.length : 0);

const TOOLS = ['/pay-app-review', '/progress-report', '/proposal-intake',
               '/precon-review', '/invoice-review', '/pco-review'];

async function main() {
  // A throwaway organization with its own admin, entirely unrelated to the real data.
  db.prepare("DELETE FROM users WHERE email='iso-outsider@test.invalid'").run();
  db.prepare("DELETE FROM organizations WHERE name='Isolation Test Co'").run();
  const orgB = db.prepare("INSERT INTO organizations (name) VALUES ('Isolation Test Co')").run().lastInsertRowid;
  db.prepare("INSERT INTO programs (org_id, name) VALUES (?, 'Test Program')").run(orgB);
  const userB = db.prepare(
    "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Outsider', 'user')"
  ).run('iso-outsider@test.invalid', bcrypt.hashSync('outsider-pass-123', 10)).lastInsertRowid;
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Admin')").run(orgB, userB);

  const outsider = (await call('POST', '/auth/login',
    { body: { email: 'iso-outsider@test.invalid', password: 'outsider-pass-123' } })).body;
  check('outsider can sign in', !!outsider.token);

  const orgA = db.prepare('SELECT id FROM organizations WHERE id <> ? ORDER BY id LIMIT 1').get(orgB);
  const review = db.prepare('SELECT id FROM pay_app_reviews LIMIT 1').get();
  const project = db.prepare('SELECT id FROM projects WHERE org_id = ? LIMIT 1').get(orgA?.id);

  console.log('\nOutsider must see nothing of another organization:');
  for (const ep of TOOLS) {
    const own = await call('GET', ep, { token: outsider.token, org: orgB });
    const forged = await call('GET', ep, { token: outsider.token, org: orgA?.id });
    check(`GET ${ep}`, rows(own) === 0 && rows(forged) === 0,
      `own ${own.status}/${rows(own)}, forged ${forged.status}/${rows(forged)}`);
  }
  if (review) {
    const direct = await call('GET', `/pay-app-review/${review.id}`, { token: outsider.token, org: orgB });
    check('direct record id returns 404, not 403', direct.status === 404, String(direct.status));
  }
  if (project) {
    for (const [name, path] of [
      ['project history', `/pay-app-review/project/${project.id}/history`],
      ['project contract', `/pay-app-review/project/${project.id}/contract`],
    ]) {
      const r = await call('GET', path, { token: outsider.token, org: orgB });
      check(`${name} returns 404`, r.status === 404, String(r.status));
    }
  }

  console.log('\nUnauthenticated access is refused:');
  for (const ep of TOOLS) {
    const r = await call('GET', ep);
    check(`GET ${ep} without a token`, r.status === 401, String(r.status));
  }

  console.log('\nA disabled account loses access immediately:');
  db.prepare("UPDATE users SET status='Disabled' WHERE id=?").run(userB);
  const afterDisable = await call('GET', '/pay-app-review', { token: outsider.token, org: orgB });
  check('disabled user is rejected on the next request', afterDisable.status === 401, String(afterDisable.status));

  db.prepare("DELETE FROM users WHERE id=?").run(userB);
  db.prepare("DELETE FROM organizations WHERE id=?").run(orgB);

  console.log(failures === 0 ? '\nAll isolation checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
