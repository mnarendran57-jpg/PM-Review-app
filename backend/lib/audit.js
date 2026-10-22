const db = require('../database');

// The audit record: who did what with an account, and when.
//
// Written here and nowhere else, and never changed afterwards — the table refuses an update or a
// delete (see the triggers in database.js), so the answer to "who did this?" cannot be tidied away
// later, by a person or by this application.
//
// A failure to write one must never fail what it records: a sign-in is not refused because the
// log could not be written. It is reported loudly instead, because a gap in an audit trail is
// itself worth knowing about.

// The address a request came from, used for the attempt limits and kept in the record.
//
// Render serves through Cloudflare, which puts the visitor's address in CF-Connecting-IP (and
// True-Client-IP) and overwrites any value a caller sends — so those are trusted first. X-Forwarded-
// For is not: Render appends to whatever the caller sent rather than replacing it, so its first
// entry can be anything the caller likes, and its last is an edge server's own address. Where only
// that header is present, the entry before the last is the visitor's, the one the edge added.
// Choosing wrongly matters both ways: a forgeable entry lets anyone dodge the limits with a new
// address per attempt, and an edge server's entry would put every visitor under one shared limit.
// Without a proxy (a developer's machine) it is the socket's own.
//
// Checked on the live service by looking at the addresses in the audit record: if every entry
// shows the same address, this is reading the wrong header.
function ipOf(req) {
  const h = req?.headers || {};
  const direct = String(h['cf-connecting-ip'] || h['true-client-ip'] || '').trim();
  if (direct) return direct;
  const hops = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  if (hops.length >= 2) return hops[hops.length - 2];
  return hops[0] || req?.socket?.remoteAddress || null;
}

// action: a short fixed name — 'signup', 'login', 'login_failed', 'email_verified', … — so the
// record can be read and filtered. detail: anything worth keeping beside it, as an object.
function record({ action, req = null, userId = null, email = null, orgId = null, detail = null }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (org_id, user_id, email, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      orgId, userId, email ? String(email).toLowerCase() : null, action,
      detail ? JSON.stringify(detail) : null, ipOf(req),
    );
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err.message);
  }
}

// What an organization's admin may read: everything recorded against their organization, and
// everything recorded against its members' accounts (their sign-ins), newest first.
function forOrg(orgId, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT a.id, a.at, a.action, a.email, a.detail, a.ip, u.name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ?
       OR a.user_id IN (SELECT user_id FROM org_members WHERE org_id = ?)
    ORDER BY a.id DESC LIMIT ?
  `).all(orgId, orgId, limit).map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

module.exports = { record, forOrg, ipOf };
