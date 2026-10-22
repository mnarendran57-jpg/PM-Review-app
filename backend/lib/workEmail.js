const dns = require('dns').promises;

// Whether an email address belongs to a company.
//
// Coaster is sold to companies, and a company is recognised by its email domain: everyone at
// "olivier-inc.com" belongs to the same organization. That only means something if the domain is
// a company's — so an address at a provider anyone can sign up to (Gmail, Outlook.com, Yahoo, a
// ten-minute throwaway inbox) is turned away, and so is one at a domain that receives no email.
//
// Neither check proves the person owns the address; the emailed confirmation link does that. What
// they do is make sure the address could be a company's before a link is sent to it.
//
// The list of personal and throwaway providers is the free-email-domains project's (MIT, see
// data/personal-email-domains.LICENSE.md), copied in rather than installed: the package fetches a
// fresh list from three other sites every time it is installed, so each deploy would have run on
// a list nobody had looked at. This one changes when someone updates it on purpose.

const PERSONAL = new Set(require('./data/personal-email-domains.json'));

// Every part after the @ counts: "mail.yahoo.co.uk" is Yahoo's as much as "yahoo.co.uk" is.
function isPersonalDomain(domain) {
  const parts = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (PERSONAL.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// "Name <x@y.com>", stray spaces and capitals are all common in a pasted address.
function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

function domainOf(email) {
  const at = normalise(email).lastIndexOf('@');
  return at > 0 ? normalise(email).slice(at + 1) : '';
}

const looksLikeEmail = email => /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalise(email));

// Whether the domain takes email at all: a mail server (MX) on record, or — as the mail standard
// allows — an address the domain itself answers on. Bounded by a timeout, because a slow name
// server must not hold a sign-up open; one that cannot answer in time is given the benefit of the
// doubt, since the confirmation email is the real test and a company with slow DNS is still a
// company.
//
// SKIP_EMAIL_DNS_CHECK=1 turns the lookup off — for the automated tests, which must not depend on
// the network. Never set it on a real server.
async function receivesEmail(domain, { timeoutMs = 4000 } = {}) {
  if (process.env.SKIP_EMAIL_DNS_CHECK === '1') return true;
  const lookup = (async () => {
    try {
      const mx = await dns.resolveMx(domain);
      if (mx.some(r => r.exchange && r.exchange !== '.')) return true;
    } catch (err) {
      if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err;
      if (err.code === 'ENOTFOUND') return false;
    }
    try {
      return (await dns.resolve4(domain)).length > 0;
    } catch {
      return false;
    }
  })();
  const timeout = new Promise(resolve => setTimeout(() => resolve('unknown'), timeoutMs).unref());
  try {
    const answer = await Promise.race([lookup, timeout]);
    return answer === 'unknown' ? true : answer;
  } catch {
    return true;
  }
}

// Why this address cannot be used to sign up, in words for the person typing it, or null when it
// can. `resolve` is the DNS check, passed in so tests need no network.
async function workEmailProblem(email, { resolve = receivesEmail } = {}) {
  if (!looksLikeEmail(email)) return 'That does not look like an email address.';
  const domain = domainOf(email);
  if (isPersonalDomain(domain)) {
    return `Coaster is for companies — please sign up with your work email address, not a ${domain} one.`;
  }
  if (!(await resolve(domain))) {
    return `We could not find an email service for ${domain}. Check the address, or use your work email.`;
  }
  return null;
}

// A password that is long enough and is not one of the passwords people try first. Twelve
// characters is the length the guidance for public sign-up settled on; the short list below is
// what an attacker tries before anything else.
const COMMON = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop', '1q2w3e4r5t6y',
  'iloveyou', 'welcome123', 'letmein', 'administrator', 'construction', 'coaster', 'coasterai',
]);
function passwordProblem(password, { email = '', company = '' } = {}) {
  const p = String(password || '');
  if (p.length < 12) return 'Use at least 12 characters for your password.';
  if (p.length > 200) return 'That password is too long.';
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z]/g, ''))) return 'That password is too easy to guess. Choose another.';
  if (/^(.)\1+$/.test(p)) return 'That password is too easy to guess. Choose another.';
  const name = normalise(email).split('@')[0];
  if (name.length >= 4 && lower.includes(name)) return 'Your password should not contain your email address.';
  const firm = String(company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (firm.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(firm)) return 'Your password should not contain your company name.';
  return null;
}

module.exports = {
  isPersonalDomain, domainOf, normalise, looksLikeEmail, receivesEmail, workEmailProblem, passwordProblem,
};
