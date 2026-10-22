// The site's own address, for links in emails that anyone can make Coaster send — confirm your
// email, reset your password.
//
// Never the address the request says it came from. That header is written by whoever sends the
// request, so trusting it would let a stranger ask Coaster to email a real person a genuine,
// working reset or confirmation link pointing at a site of the stranger's choosing — and collect
// the token when it is clicked. The address comes from APP_BASE_URL on the server instead.
//
// A copy running on a developer's machine has no APP_BASE_URL and is reached at localhost, which is
// accepted there and only there. Anything else gets null, and the caller declines to send rather
// than send a link it cannot vouch for.
//
// (An invitation is different: only an admin can make one, and the link is shown to that admin as
// well as emailed, so it keeps using the address the admin's own browser is on.)
function siteAddress(req) {
  const configured = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const origin = String(req?.headers?.origin || '').replace(/\/$/, '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}

module.exports = { siteAddress };
