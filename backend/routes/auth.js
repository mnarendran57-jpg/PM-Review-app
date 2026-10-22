const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const access = require('../lib/access');
const email = require('../lib/email');
const audit = require('../lib/audit');
const { workEmailProblem, passwordProblem, normalise, domainOf } = require('../lib/workEmail');
const { createAttemptLimit, minutesFrom } = require('../lib/attemptLimit');
const { isHuman } = require('../lib/humanCheck');
const { siteAddress } = require('../lib/siteAddress');
const companies = require('../lib/companies');

const RESET_MINUTES = 60;
// A reset link can take over an account, so a flood of them is worth stopping even though
// each one only reaches the real inbox.
const RESET_MAX_PER_HOUR = 5;

// How long an emailed confirmation link works.
const CONFIRM_HOURS = 48;

// The limits on the doors anyone can knock on. See lib/attemptLimit.js.
//   sign-ups   ten an hour from one address — an office of people signing up together still fits
//   resends    three an hour to one email, so Coaster cannot be used to flood someone's inbox
//   sign-ins   five wrong passwords for one account in fifteen minutes, then a pause; and fifty
//              from one address, which is someone trying many accounts rather than forgetting one
const signupsByIp = createAttemptLimit({ max: 10, windowMs: 60 * 60 * 1000 });
const resendsByEmail = createAttemptLimit({ max: 3, windowMs: 60 * 60 * 1000 });
const failedByEmail = createAttemptLimit({ max: 5, windowMs: 15 * 60 * 1000 });
const failedByIp = createAttemptLimit({ max: 50, windowMs: 15 * 60 * 1000 });

const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// One account is one person. Deliberately not tied to an organization: the same
// consultant often works for several customers and must not need a second login. Which
// organization they are working in is chosen after sign-in and travels per request.
function issueToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicUser(user) {
  return {
    id: user.id, email: user.email, name: user.name,
    address: user.address ?? null, company: user.company ?? null, phone: user.phone ?? null,
    role: user.role, isPlatformAdmin: user.role === 'superadmin',
  };
}

function userFromToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(claims.uid);
    if (!user || user.status !== 'Active') return null;
    return access.tokenStillValid(user, claims) ? user : null;
  } catch {
    return null;
  }
}

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  // Too many wrong passwords for this account, or from this address: a pause, said plainly. The
  // same pause whether or not the account exists, so it reveals nothing about who has one.
  const ip = audit.ipOf(req);
  const paused = [failedByEmail.blocked(email), failedByIp.blocked(ip)].find(b => b.blocked);
  if (paused) {
    return res.status(429).json({
      error: `Too many unsuccessful sign-in attempts. Try again in ${minutesFrom(paused.retryAfterMs)} minutes, or reset your password.`,
    });
  }

  const user = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
  // Same message whether the address is unknown or the password is wrong — telling them
  // apart would let anyone probe which people have accounts.
  const ok = user && user.status === 'Active' && await bcrypt.compare(password, user.password_hash || '');
  if (!ok) {
    failedByEmail.hit(email);
    failedByIp.hit(ip);
    audit.record({ action: 'login_failed', req, userId: user?.id ?? null, email });
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  failedByEmail.reset(email);
  audit.record({ action: 'login', req, userId: user.id, email: user.email });

  // The organizations they can reach come back with the login so the app can go straight
  // to the picker (or skip it when there is only one).
  res.json({
    token: issueToken(user),
    user: publicUser(user),
    organizations: access.orgsForUser(user),
  });
});

// Who am I — the frontend calls this on load to restore the session and decide which
// admin screens to show.
router.get('/me', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  res.json({
    user: publicUser(user),
    organizations: access.orgsForUser(user),
    // A person who signed up and is waiting for their company's admin to let them in.
    pendingJoin: companies.pendingJoinFor(user.id),
  });
});

// A person's own details. Everything here belongs to the ACCOUNT rather than to an
// organization, which is why it is edited from a personal settings page and not from the Team
// tab: a consultant working with two customers has one name, one address and one login, and
// neither customer's admin should be reaching into it.
router.patch('/profile', async (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });

  const text = v => (v === undefined ? undefined : (String(v).trim() || null));
  const name = text(req.body.name);
  const address = text(req.body.address);
  const company = text(req.body.company);
  const phone = text(req.body.phone);

  // The email is the sign-in credential, so it is treated as one. Changing it needs the current
  // password — the same protection changing the password itself gets — because an unattended
  // session would otherwise be enough to move somebody's account to an address they control.
  let email;
  if (req.body.email !== undefined) {
    const wanted = String(req.body.email).trim().toLowerCase();
    if (wanted && wanted !== user.email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) {
        return res.status(400).json({ error: 'That does not look like an email address.' });
      }
      if (!(await bcrypt.compare(req.body.current_password || '', user.password_hash || ''))) {
        return res.status(401).json({
          error: 'Enter your current password to change the email you sign in with.',
        });
      }
      const taken = db.prepare(`SELECT 1 FROM users WHERE lower(email)=? AND id<>?`).get(wanted, user.id);
      if (taken) return res.status(409).json({ error: 'Another account already uses that email.' });
      email = wanted;
    }
  }

  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name), address = COALESCE(?, address),
      company = COALESCE(?, company), phone = COALESCE(?, phone),
      email = COALESCE(?, email)
    WHERE id = ?
  `).run(
    name === undefined ? null : name, address === undefined ? null : address,
    company === undefined ? null : company, phone === undefined ? null : phone,
    email ?? null, user.id
  );

  // COALESCE keeps a field that was not sent, but it also keeps one deliberately CLEARED. So a
  // field the caller explicitly set to empty is nulled in a second pass — "" and "not mentioned"
  // are different instructions and the first one has to survive.
  const clear = [];
  if (name === null) clear.push('name');
  if (address === null) clear.push('address');
  if (company === null) clear.push('company');
  if (phone === null) clear.push('phone');
  for (const col of clear) db.prepare(`UPDATE users SET ${col}=NULL WHERE id=?`).run(user.id);

  const fresh = db.prepare(`SELECT * FROM users WHERE id=?`).get(user.id);
  res.json({ user: publicUser(fresh), emailChanged: !!email });
});

// Changing your own password requires proving you know the current one.
router.post('/change-password', async (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Login required' });

  const { current_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (!(await bcrypt.compare(current_password || '', user.password_hash || ''))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`)
    .run(bcrypt.hashSync(String(new_password), 10), user.id);
  res.json({ success: true });
});

// --- Forgot password -------------------------------------------------------------------
// Unlike an invitation, the person asking here has proved nothing, so the link is never
// returned in the response — it only ever goes to the address on the account. That also
// means this flow is unavailable until an email provider is configured, and says so.

function loadReset(token) {
  const row = db.prepare(`
    SELECT r.*, u.email, u.name, u.status
    FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token = ?
  `).get(token);
  if (!row) return { error: 'This reset link is not valid. Ask for a new one.' };
  if (row.used_at) return { error: 'This reset link has already been used. Ask for a new one.' };
  if (new Date(row.expires_at) < new Date()) return { error: 'This reset link has expired. Ask for a new one.' };
  if (row.status !== 'Active') return { error: 'This account is no longer active.' };
  return { reset: row };
}

router.post('/forgot-password', async (req, res) => {
  const address = String(req.body.email || '').trim().toLowerCase();
  if (!address) return res.status(400).json({ error: 'Enter your email address' });

  // Nothing to send with, and no point pretending otherwise — this is a fact about the
  // installation, not about whether this particular address has an account.
  if (!email.isConfigured()) {
    return res.status(503).json({
      error: 'Password reset email is not set up on this site yet. Ask your administrator to set a new password for you.',
      emailConfigured: false,
    });
  }

  const user = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(address);
  if (user && user.status === 'Active') {
    const recent = db.prepare(`
      SELECT COUNT(*) AS c FROM password_resets
      WHERE user_id = ? AND created_at > datetime('now', '-1 hour')
    `).get(user.id).c;

    if (recent < RESET_MAX_PER_HOUR) {
      // Asking again supersedes any earlier link, so a forwarded old email stops working.
      db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(user.id);

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + RESET_MINUTES * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO password_resets (user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?)
      `).run(user.id, token, expires, req.ip || null);

      // The site's own address, never the one the request claims — see lib/siteAddress.js.
      const base = siteAddress(req);
      if (base) {
        await email.sendPasswordReset({
          to: user.email, name: user.name, minutes: RESET_MINUTES,
          link: `${base}/reset-password/${token}`,
        });
      } else {
        console.error('[forgot password] APP_BASE_URL is not set, so no reset link was sent.');
      }
      audit.record({ action: 'password_reset_requested', req, userId: user.id, email: user.email });
    }
  }

  // Always the same answer, whether or not that address has an account and whether or not
  // the send succeeded. Anything else turns this into a way to discover who has a login.
  res.json({ sent: true });
});

// Lets the reset page show whose account it is before they type a new password.
router.get('/reset-password/:token', (req, res) => {
  const { reset, error } = loadReset(req.params.token);
  if (error) return res.status(400).json({ error });
  res.json({ email: reset.email, name: reset.name });
});

router.post('/reset-password/:token', (req, res) => {
  const { reset, error } = loadReset(req.params.token);
  if (error) return res.status(400).json({ error });

  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  db.prepare(`UPDATE users SET password_hash = ?, sessions_valid_from = datetime('now') WHERE id = ?`)
    .run(bcrypt.hashSync(password, 10), reset.user_id);
  audit.record({ action: 'password_reset', req, userId: reset.user_id, email: reset.email });
  // Single use, and any other outstanding link for this account dies with it.
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`)
    .run(reset.user_id);

  // Signed straight in: they just proved control of the account's inbox.
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(reset.user_id);
  res.json({
    token: issueToken(user),
    user: publicUser(user),
    organizations: access.orgsForUser(user),
  });
});

// --- Signing up -------------------------------------------------------------------------
//
// Anyone may sign up, with a work email. The steps:
//   1. POST /signup — name, work email, company. The address is checked (lib/workEmail.js), the
//      person is checked for being a person (lib/humanCheck.js), and a confirmation link is emailed.
//      No password yet, and nothing can be signed into.
//   2. The link opens the confirmation page, which shows whose account it is (GET), and asks them
//      to choose a password (POST). Only then is the account real: confirmed, active, placed in
//      their company (lib/companies.js), and signed straight in.
//
// The password is chosen at step 2, not step 1, on purpose. Chosen at sign-up, a stranger could
// sign up with someone else's address and a password of the stranger's choosing — and if the real
// owner clicked the confirmation email, they would switch on an account the stranger can sign in
// to. Chosen on the confirmation page, it is set by whoever holds the inbox, and nobody else.
//
// Every answer to step 1 is the same "check your email", whether the address was new, already
// confirmed, or waiting for confirmation — so the form cannot be used to find out who has an
// account. The owner of an existing account is told by email instead.

function issueConfirmation(userId) {
  // A new link replaces any earlier one, so a forwarded old email stops working.
  db.prepare(`UPDATE email_verifications SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(userId);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + CONFIRM_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`)
    .run(userId, sha256(token), expires);
  return token;
}

// Whether a confirmation link can actually reach the person signing up. On a real server that
// needs an email service and the site's own address (APP_BASE_URL). On a developer's machine —
// reached at localhost, with no email service — the link is printed to the server's log instead,
// so sign-up can be tried there. Anything else cannot deliver, and sign-up says it is not open
// rather than tell someone to check an inbox nothing will arrive in.
const isLocal = req => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.origin || ''));
const canDeliver = req => (email.isConfigured() ? !!siteAddress(req) : isLocal(req) && !process.env.APP_BASE_URL);

async function deliverConfirmation(req, user, token) {
  const base = siteAddress(req);
  if (!canDeliver(req) || !base) return;
  const link = `${base}/confirm-email/${token}`;
  if (!email.isConfigured()) {
    console.log(`[sign-up] email is not set up; confirmation link for ${user.email}: ${link}`);
    return;
  }
  await email.sendEmailConfirmation({ to: user.email, name: user.name, link, hours: CONFIRM_HOURS });
}

router.get('/signup-open', (req, res) => {
  res.json({ open: canDeliver(req) });
});

router.post('/signup', async (req, res) => {
  const ip = audit.ipOf(req);
  const limit = signupsByIp.hit(ip);
  if (!limit.allowed) {
    return res.status(429).json({ error: `Too many sign-ups from here. Try again in ${minutesFrom(limit.retryAfterMs)} minutes.` });
  }

  const name = String(req.body.name || '').trim().slice(0, 120);
  const company = String(req.body.company || '').trim().slice(0, 160);
  const address = normalise(req.body.email);
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!company) return res.status(400).json({ error: 'Enter your company name.' });

  if (!(await isHuman(req.body.human_token, ip))) {
    return res.status(400).json({ error: 'We could not confirm you are a person. Refresh the page and try again.' });
  }

  const problem = await workEmailProblem(address);
  if (problem) {
    audit.record({ action: 'signup_refused', req, email: address, detail: { reason: problem } });
    return res.status(400).json({ error: problem });
  }

  if (!canDeliver(req)) {
    return res.status(503).json({ error: 'Sign-up is not open yet. Contact Coaster to get an account.' });
  }

  const existing = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(address);
  if (existing && existing.status === 'Unverified') {
    // Waiting for confirmation: send the link again (within the resend limit). The details first
    // given are kept — a second sign-up cannot rename someone else's pending account.
    if (resendsByEmail.hit(address).allowed) await deliverConfirmation(req, existing, issueConfirmation(existing.id));
  } else if (existing) {
    // Already has an account. Tell its owner, by email, and nobody else.
    const base = siteAddress(req);
    if (base && resendsByEmail.hit(address).allowed && email.isConfigured()) {
      await email.sendAlreadyRegistered({ to: existing.email, loginLink: `${base}/login`, resetLink: `${base}/forgot-password` });
    }
    audit.record({ action: 'signup_existing_account', req, userId: existing.id, email: address });
  } else {
    const userId = Number(db.prepare(`
      INSERT INTO users (email, password_hash, name, company, role, status) VALUES (?, '', ?, ?, 'member', 'Unverified')
    `).run(address, name, company).lastInsertRowid);
    resendsByEmail.hit(address);
    await deliverConfirmation(req, { email: address, name }, issueConfirmation(userId));
    audit.record({ action: 'signup', req, userId, email: address, detail: { company, domain: domainOf(address) } });
  }

  res.json({ sent: true, email: address });
});

// "I didn't get the email." The same answer whatever the address, for the same reason as above.
router.post('/resend-confirmation', async (req, res) => {
  const address = normalise(req.body.email);
  const user = address ? db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(address) : null;
  if (user && user.status === 'Unverified' && resendsByEmail.hit(address).allowed) {
    await deliverConfirmation(req, user, issueConfirmation(user.id));
  }
  res.json({ sent: true });
});

function loadConfirmation(token) {
  const row = db.prepare(`
    SELECT v.*, u.email, u.name, u.company, u.status
    FROM email_verifications v JOIN users u ON u.id = v.user_id
    WHERE v.token_hash = ?
  `).get(sha256(token));
  if (!row) return { error: 'This confirmation link is not valid. Sign up again to get a new one.' };
  if (row.used_at) return { error: 'This confirmation link has already been used. Sign in instead.', used: true };
  if (new Date(row.expires_at) < new Date()) return { error: 'This confirmation link has expired. Sign up again to get a new one.' };
  if (row.status !== 'Unverified') return { error: 'This account is already confirmed. Sign in instead.', used: true };
  return { confirmation: row };
}

// What the confirmation page shows before they choose a password. Reading it changes nothing —
// the programs some companies run over incoming mail open every link to check it, and that must
// not confirm anyone's account.
router.get('/confirm-email/:token', (req, res) => {
  const { confirmation, error, used } = loadConfirmation(req.params.token);
  if (error) return res.status(400).json({ error, used: !!used });
  const domain = domainOf(confirmation.email);
  const org = companies.orgForDomain(domain);
  res.json({
    email: confirmation.email, name: confirmation.name, company: confirmation.company,
    // Whether they will be starting their company on Coaster, or asking to join it.
    companyExists: !!org, existingCompanyName: org?.name || null,
  });
});

router.post('/confirm-email/:token', (req, res) => {
  const { confirmation, error } = loadConfirmation(req.params.token);
  if (error) return res.status(400).json({ error });
  const problem = passwordProblem(req.body.password, { email: confirmation.email, company: confirmation.company });
  if (problem) return res.status(400).json({ error: problem });

  db.prepare(`
    UPDATE users SET password_hash = ?, status = 'Active', email_verified_at = datetime('now'),
      sessions_valid_from = datetime('now') WHERE id = ?
  `).run(bcrypt.hashSync(String(req.body.password), 10), confirmation.user_id);
  db.prepare(`UPDATE email_verifications SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`)
    .run(confirmation.user_id);

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(confirmation.user_id);
  const placed = companies.placeConfirmedUser(user, { companyName: confirmation.company });
  audit.record({ action: 'email_confirmed', req, userId: user.id, email: user.email, orgId: placed.org.id });
  if (placed.outcome === 'created') {
    audit.record({
      action: 'company_created', req, userId: user.id, email: user.email, orgId: placed.org.id,
      detail: { name: placed.org.name, domain: placed.org.email_domain, trial: placed.trialGiven ? `${companies.TRIAL_DAYS} days` : 'none — this domain has had one' },
    });
  }
  if (placed.outcome === 'pending') {
    audit.record({ action: 'join_requested', req, userId: user.id, email: user.email, orgId: placed.org.id });
    const base = siteAddress(req);
    const { people, forCoaster } = companies.approversOf(placed.org.id);
    for (const approver of people) {
      email.sendJoinRequest({
        to: approver.email, adminName: approver.name, requesterName: user.name, requesterEmail: user.email,
        orgName: placed.org.name, link: base ? `${base}/team` : null, forCoaster,
      }).catch(() => {});
    }
  }

  // Signed straight in: they have just proved they hold the inbox, and chosen the password.
  res.json({
    token: issueToken(user),
    user: publicUser(user),
    organizations: access.orgsForUser(user),
    outcome: placed.outcome,
    pendingJoin: companies.pendingJoinFor(user.id),
  });
});

module.exports = router;
