const assert = require('assert');

// Public sign-up from end to end, through the real routes: work-email checks, the confirmation
// link, companies recognised by domain, joining with an admin's approval, the free trial and its
// end, the limits on attempts, and the audit record. No email is sent and no DNS is looked up.
//
//   DB_PATH=<scratch>/signup.db node tests/signup.test.js      (use a fresh database file)

process.env.SKIP_EMAIL_DNS_CHECK = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.APP_BASE_URL;
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.TURNSTILE_SECRET_KEY;

const express = require('express');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const { workEmailProblem, isPersonalDomain, passwordProblem } = require('../lib/workEmail');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

// The confirmation link is printed when no email is set up. Caught here to follow it.
const printed = [];
const log = console.log;
console.log = (...a) => { const t = a.join(' '); if (t.includes('[sign-up]')) printed.push(t); else log(...a); };
const lastLink = address => {
  const line = [...printed].reverse().find(l => l.includes(address));
  return line ? line.slice(line.lastIndexOf('/confirm-email/') + '/confirm-email/'.length).trim() : null;
};

const STRONG = 'harbour lantern 4417 copper';
const LOCAL = { Origin: 'http://localhost:3000' };

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/invitations', require('../routes/invitations'));
  app.use('/api', requireAuth);
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/programs', require('../routes/programs'));
  app.use('/api/invoice-review', require('../routes/invoiceReview'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, { body, token, org, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json', ...LOCAL, ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(org ? { 'X-Org-Id': String(org) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  // Each from its own address, as real sign-ups are, so the per-address limit is tested on its own.
  let n = 0;
  const signup = (email, extra = {}) => call('POST', '/auth/signup', {
    body: { name: 'Pat Lee', email, company: 'Brightline MEP', ...extra },
    headers: { 'CF-Connecting-IP': `203.0.113.${(n++ % 250) + 1}` },
  });

  await check('personal, throwaway and malformed addresses are turned away', async () => {
    assert.ok(isPersonalDomain('gmail.com') && isPersonalDomain('mailinator.com') && isPersonalDomain('mail.yahoo.co.uk'));
    assert.ok(!isPersonalDomain('olivier-inc.com'));
    for (const bad of ['pat@gmail.com', 'pat@outlook.com', 'pat@mailinator.com', 'not-an-email']) {
      const r = await signup(bad);
      assert.strictEqual(r.status, 400, bad);
    }
    assert.match((await signup('pat@gmail.com')).body.error, /work email/);
  });

  await check('a domain that takes no email is turned away', async () => {
    assert.match(await workEmailProblem('pat@nowhere-real.example', { resolve: async () => false }), /could not find an email service/);
    assert.strictEqual(await workEmailProblem('pat@brightline-mep.com', { resolve: async () => true }), null);
  });

  let patToken;
  let orgId;
  await check('signing up makes an account that cannot be used until confirmed', async () => {
    const r = await signup('pat@brightline-mep.com');
    assert.deepStrictEqual([r.status, r.body.sent, r.body.mode], [200, true, 'email']);
    const user = db.prepare(`SELECT * FROM users WHERE email='pat@brightline-mep.com'`).get();
    assert.strictEqual(user.status, 'Unverified');
    const login = await call('POST', '/auth/login', { body: { email: 'pat@brightline-mep.com', password: STRONG } });
    assert.strictEqual(login.status, 401);
  });

  await check('opening the link changes nothing; choosing a password confirms, and starts their own trial', async () => {
    const token = lastLink('pat@brightline-mep.com');
    assert.ok(token, 'no link was printed');
    const look = await call('GET', `/auth/confirm-email/${token}`);
    assert.deepStrictEqual([look.body.email, look.body.company, look.body.trialDays], ['pat@brightline-mep.com', 'Brightline MEP', 14]);
    assert.strictEqual(db.prepare(`SELECT status FROM users WHERE email='pat@brightline-mep.com'`).get().status, 'Unverified');

    assert.strictEqual((await call('POST', `/auth/confirm-email/${token}`, { body: { password: 'short' } })).status, 400);
    assert.match((await call('POST', `/auth/confirm-email/${token}`, { body: { password: 'brightlinemep2026!' } })).body.error, /company name/);

    const done = await call('POST', `/auth/confirm-email/${token}`, { body: { password: STRONG } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    patToken = done.body.token;
    assert.strictEqual(done.body.organizations.length, 1);
    orgId = done.body.organizations[0].id;
    const org = db.prepare(`SELECT * FROM organizations WHERE id=?`).get(orgId);
    assert.deepStrictEqual([org.name, org.subscription_status, org.email_domain], ['Brightline MEP', 'trial', null]);
    const days = (Date.parse(org.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days <= 14, `trial of ${days} days`);
    // Not an Admin: there are no people in a trial workspace to manage.
    assert.strictEqual(db.prepare(`SELECT role FROM org_members WHERE org_id=?`).get(orgId).role, 'Contributor');
    assert.strictEqual((await call('POST', `/auth/confirm-email/${token}`, { body: { password: STRONG } })).status, 400, 'the link works once');
  });

  await check('signing up again with a confirmed address reveals nothing and changes nothing', async () => {
    const r = await signup('pat@brightline-mep.com', { name: 'Someone Else' });
    assert.deepStrictEqual([r.status, r.body.sent], [200, true]);
    assert.strictEqual(db.prepare(`SELECT name FROM users WHERE email='pat@brightline-mep.com'`).get().name, 'Pat Lee');
  });

  await check('a colleague from the same company gets a trial of their own, not a seat in the first one', async () => {
    await signup('sam@brightline-mep.com', { name: 'Sam Ortiz' });
    // A second sign-up for the same unconfirmed address cannot rename it.
    await signup('sam@brightline-mep.com', { name: 'Intruder' });
    assert.strictEqual(db.prepare(`SELECT name FROM users WHERE email='sam@brightline-mep.com'`).get().name, 'Sam Ortiz');
    const done = await call('POST', `/auth/confirm-email/${lastLink('sam@brightline-mep.com')}`, { body: { password: STRONG } });
    assert.strictEqual(done.body.organizations.length, 1);
    assert.notStrictEqual(done.body.organizations[0].id, orgId, 'put in the first person\'s workspace');
    const pats = await call('GET', '/programs', { token: done.body.token, org: orgId });
    assert.notStrictEqual(pats.status, 200, 'can reach the first person\'s workspace');
  });

  await check('they can set up programs, but not manage people', async () => {
    const program = await call('POST', '/programs', { token: patToken, org: orgId, body: { name: 'Campus Renovation' } });
    assert.strictEqual(program.status, 200, JSON.stringify(program.body));
    assert.strictEqual((await call('GET', '/admin/members', { token: patToken, org: orgId })).status, 403);
    const me = await call('GET', '/auth/me', { token: patToken });
    const mine = me.body.organizations.find(o => o.id === orgId);
    assert.deepStrictEqual([!!mine.is_admin, !!mine.can_create], [false, true]);
  });

  // --- Approved by Coaster: no email service, and not a developer's machine -----------------------
  const LIVE = { Origin: 'https://coasterai.com' };
  const signupLive = (email, extra = {}) => call('POST', '/auth/signup', {
    body: { name: 'Ana Ruiz', email, company: 'Northgate Builders', ...extra },
    headers: { ...LIVE, 'CF-Connecting-IP': `198.18.0.${(n++ % 250) + 1}` },
  });
  let coasterToken;

  await check('without an email service, sign-up is open, and Coaster approves the work email', async () => {
    const open = await call('GET', '/auth/signup-open', { headers: LIVE });
    assert.deepStrictEqual([open.body.open, open.body.mode], [true, 'approval']);
    assert.match((await signupLive('ana@northgate-builders.com')).body.error, /12 characters/, 'a password is needed');
    assert.strictEqual((await signupLive('ana@gmail.com', { password: STRONG })).status, 400, 'still a work email');
    const r = await signupLive('ana@northgate-builders.com', { password: STRONG });
    assert.deepStrictEqual([r.status, r.body.mode], [200, 'approval']);
    assert.strictEqual(db.prepare(`SELECT status FROM users WHERE email='ana@northgate-builders.com'`).get().status, 'Pending');
  });

  await check('waiting: signing in says so, but only to someone with the right password', async () => {
    const right = await call('POST', '/auth/login', { body: { email: 'ana@northgate-builders.com', password: STRONG } });
    assert.strictEqual(right.status, 403);
    assert.match(right.body.error, /being reviewed/);
    const wrong = await call('POST', '/auth/login', { body: { email: 'ana@northgate-builders.com', password: 'not-the-password' } });
    assert.deepStrictEqual([wrong.status, wrong.body.error], [401, 'Incorrect email or password']);
  });

  await check('Coaster sees the request and approves it; then they sign in to their own trial', async () => {
    const bcrypt = require('bcryptjs');
    db.prepare(`INSERT INTO users (email, password_hash, name, role, status) VALUES ('owner@coaster.app', ?, 'Coaster', 'superadmin', 'Active')`)
      .run(bcrypt.hashSync(STRONG, 4));
    coasterToken = (await call('POST', '/auth/login', { body: { email: 'owner@coaster.app', password: STRONG } })).body.token;
    const list = await call('GET', '/admin/trial-requests', { token: coasterToken });
    assert.deepStrictEqual(list.body.map(r => [r.email, r.company]), [['ana@northgate-builders.com', 'Northgate Builders']]);
    assert.strictEqual((await call('GET', '/admin/trial-requests', { token: patToken })).status, 403, 'only Coaster');
    const ok = await call('POST', `/admin/trial-requests/${list.body[0].user_id}/approve`, { token: coasterToken });
    assert.strictEqual(ok.status, 200);
    const login = await call('POST', '/auth/login', { body: { email: 'ana@northgate-builders.com', password: STRONG } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const ws = login.body.organizations[0];
    assert.deepStrictEqual([ws.name, ws.subscription_status, !!ws.can_create], ['Northgate Builders', 'trial', true]);
  });

  await check('a declined request cannot sign in, and is told so', async () => {
    await signupLive('raj@northgate-builders.com', { name: 'Raj', password: STRONG });
    const id = db.prepare(`SELECT id FROM users WHERE email='raj@northgate-builders.com'`).get().id;
    assert.strictEqual((await call('POST', `/admin/trial-requests/${id}/decline`, { token: coasterToken })).status, 200);
    const login = await call('POST', '/auth/login', { body: { email: 'raj@northgate-builders.com', password: STRONG } });
    assert.strictEqual(login.status, 403);
    assert.match(login.body.error, /wasn't approved/);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM org_members WHERE user_id=?`).get(id).c, 0);
  });

  await check('signing up again over an existing account leaves it exactly as it was', async () => {
    const before = db.prepare(`SELECT password_hash, name, status FROM users WHERE email='ana@northgate-builders.com'`).get();
    const r = await signupLive('ana@northgate-builders.com', { name: 'Someone Else', password: 'a different long password' });
    assert.deepStrictEqual([r.status, r.body.mode], [200, 'approval']);
    assert.deepStrictEqual(db.prepare(`SELECT password_hash, name, status FROM users WHERE email='ana@northgate-builders.com'`).get(), before);
  });

  await check('the trial shows how long is left; once ended, new work stops and viewing does not', async () => {
    const plan = await call('GET', '/admin/my-plan', { token: patToken, org: orgId });
    assert.deepStrictEqual([plan.body.subscription.status, plan.body.subscription.daysLeft], ['trial', 14]);
    db.prepare(`UPDATE organizations SET trial_ends_at=? WHERE id=?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
    const ended = await call('GET', '/admin/my-plan', { token: patToken, org: orgId });
    assert.strictEqual(ended.body.subscription.status, 'trial-ended');
    const start = await call('POST', '/invoice-review', { token: patToken, org: orgId, body: {} });
    assert.strictEqual(start.status, 402);
    assert.match(start.body.error, /free trial has ended/);
    const view = await call('GET', '/invoice-review', { token: patToken, org: orgId });
    assert.strictEqual(view.status, 200);
  });

  await check('a company from before sign-up has no trial and is never stopped', async () => {
    const legacy = Number(db.prepare(`INSERT INTO organizations (name) VALUES ('Olivier Inc.')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, (SELECT id FROM users WHERE email='pat@brightline-mep.com'), 'Admin')`).run(legacy);
    const start = await call('POST', '/invoice-review', { token: patToken, org: legacy, body: {} });
    assert.notStrictEqual(start.status, 402);
    const plan = await call('GET', '/admin/my-plan', { token: patToken, org: legacy });
    assert.strictEqual(plan.body.subscription.status, null);
  });

  await check('one free trial per email address, even after the account and workspace are deleted', async () => {
    const sam = db.prepare(`SELECT id FROM users WHERE email='sam@brightline-mep.com'`).get().id;
    const samOrg = db.prepare(`SELECT org_id FROM org_members WHERE user_id=?`).get(sam).org_id;
    db.prepare(`DELETE FROM organizations WHERE id=?`).run(samOrg);
    db.prepare(`DELETE FROM users WHERE id=?`).run(sam);
    await signup('sam@brightline-mep.com', { name: 'Sam Ortiz' });
    const done = await call('POST', `/auth/confirm-email/${lastLink('sam@brightline-mep.com')}`, { body: { password: STRONG } });
    assert.strictEqual(done.body.organizations[0].subscription_status, 'ended');
  });

  await check('five wrong passwords pause sign-in for that account', async () => {
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await call('POST', '/auth/login', { body: { email: 'sam@brightline-mep.com', password: 'wrong-password-x' } })).status, 401);
    }
    const sixth = await call('POST', '/auth/login', { body: { email: 'sam@brightline-mep.com', password: STRONG } });
    assert.strictEqual(sixth.status, 429);
    assert.match(sixth.body.error, /Try again in \d+ minutes/);
  });

  await check('ten sign-ups an hour from one address, however the caller labels itself', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await call('POST', '/auth/signup', {
        body: { name: 'Bot', email: `bot${i}@spam-factory.com`, company: 'Spam' },
        // An invented address in X-Forwarded-For changes nothing: Cloudflare's header is the one counted.
        headers: { 'X-Forwarded-For': `10.9.9.${i}`, 'CF-Connecting-IP': '198.51.100.7' },
      })).status);
    }
    assert.deepStrictEqual(codes.slice(9), [200, 429, 429]);
  });

  await check('where only X-Forwarded-For arrives, the entry the edge added is the visitor', () => {
    const { ipOf } = require('../lib/audit');
    assert.strictEqual(ipOf({ headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.9, 10.0.0.1' } }), '198.51.100.9');
    assert.strictEqual(ipOf({ headers: { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '198.51.100.3' } }), '198.51.100.3');
    assert.strictEqual(ipOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  });

  await check('a reset or confirmation link is never built from a forged address', async () => {
    printed.length = 0;
    await call('POST', '/auth/signup', { body: { name: 'Eve', email: 'eve@forged-origin.com', company: 'Forged', password: STRONG }, headers: { Origin: 'https://evil.example' } });
    await call('POST', '/auth/forgot-password', { body: { email: 'pat@brightline-mep.com' }, headers: { Origin: 'https://evil.example' } });
    assert.ok(!printed.some(l => l.includes('evil.example')), 'a link to the forged address was made');
    assert.strictEqual(printed.length, 0);
  });

  await check('an invitation finishes an unconfirmed sign-up', async () => {
    await signup('kim@brightline-mep.com', { name: 'Kim' });
    const legacy = db.prepare(`SELECT id FROM organizations WHERE name='Olivier Inc.'`).get().id;
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO invitations (org_id, email, role, token, expires_at) VALUES (?, 'kim@brightline-mep.com', 'Member', ?, ?)`)
      .run(legacy, token, new Date(Date.now() + 86400000).toISOString());
    const look = await call('GET', `/invitations/${token}`);
    assert.strictEqual(look.body.hasAccount, false);
    const accepted = await call('POST', `/invitations/${token}/accept`, { body: { password: STRONG } });
    assert.ok(accepted.body.token, `${accepted.status} ${JSON.stringify(accepted.body)}`);
    const kim = db.prepare(`SELECT status, email_verified_at FROM users WHERE email='kim@brightline-mep.com'`).get();
    assert.ok(kim.status === 'Active' && kim.email_verified_at);
  });

  await check('everything is in the audit record, which cannot be changed or deleted', async () => {
    const actions = db.prepare(`SELECT DISTINCT action FROM audit_log`).all().map(r => r.action);
    for (const a of ['signup', 'signup_refused', 'email_confirmed', 'trial_started', 'trial_approved', 'trial_declined', 'login_failed']) {
      assert.ok(actions.includes(a), `${a} was not recorded`);
    }
    assert.throws(() => db.prepare(`UPDATE audit_log SET action='x'`).run(), /cannot be changed/);
    assert.throws(() => db.prepare(`DELETE FROM audit_log`).run(), /cannot be deleted/);
  });

  await check('passwords: long enough, not common, not the email or company', () => {
    assert.match(passwordProblem('short1'), /12 characters/);
    assert.match(passwordProblem('password123!'.padEnd(12, '!')) || '', /12 characters|guess/);
    assert.match(passwordProblem('aaaaaaaaaaaaaa'), /guess/);
    assert.match(passwordProblem('patlee-secret-99', { email: 'patlee@x.com' }), /email/);
    assert.strictEqual(passwordProblem(STRONG, { email: 'pat@x.com', company: 'Brightline' }), null);
  });

  server.close();
  console.log = log;
  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
