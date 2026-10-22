// The check that a sign-up came from a person and not a script: Cloudflare Turnstile.
//
// The sign-up page shows Cloudflare's widget, which usually decides without asking the person to
// do anything, and hands the page a token. The token is checked here, with Cloudflare, before an
// account is made. Free, and run from the same Cloudflare account that holds Coaster's files.
//
// Switched on by TURNSTILE_SECRET_KEY on the server (and VITE_TURNSTILE_SITE_KEY on the site).
// Without it the check is skipped — so a copy running on a laptop works — and the server says so
// once at start-up rather than silently.

const SECRET = process.env.TURNSTILE_SECRET_KEY;
const isConfigured = () => !!SECRET;

if (!isConfigured()) {
  console.warn('[human check] TURNSTILE_SECRET_KEY is not set — sign-up is not checked for bots.');
}

// True when the token is good, or when the check is not configured. `ip` is passed on to
// Cloudflare, which uses it as one more signal.
async function isHuman(token, ip) {
  if (!isConfigured()) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: SECRET, response: String(token) });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    // Cloudflare unreachable. Refusing every sign-up while it is down would close the door to
    // everyone; letting this one through costs one possibly-automated account, which the
    // confirmation email and the attempt limits still stand in front of.
    console.error('[human check] could not reach Cloudflare:', err.message);
    return true;
  }
}

module.exports = { isHuman, isConfigured };
