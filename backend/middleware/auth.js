const jwt = require('jsonwebtoken');
const db = require('../database');
const access = require('../lib/access');

// Establishes who is calling. Users are not tied to an organization, so the token only
// identifies the person — which organization they are working in arrives per request.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }

  // Re-read the user each request so deactivating an account takes effect immediately
  // rather than whenever their 30-day token happens to expire.
  const user = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id=?`).get(claims.uid);
  if (!user || user.status !== 'Active') {
    return res.status(401).json({ error: 'This account is no longer active' });
  }

  req.user = user;

  // The active organization comes from a header the app sets after the user picks one.
  // It is always checked against real membership, so supplying someone else's id gets
  // you nothing — this is what keeps one customer's data away from another's.
  const raw = req.headers['x-org-id'] || req.query.org_id;
  if (raw) {
    const orgId = Number(raw);
    if (Number.isFinite(orgId) && access.isInOrg(user, orgId)) {
      req.orgId = orgId;
      req.isOrgAdmin = access.isOrgAdmin(user, orgId);
    }
  }
  next();
}

// For routes that operate inside one organization and are meaningless without it.
function requireOrg(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({ error: 'No organization selected — choose one and try again.' });
  }
  next();
}

// Administration of an organization (managing its people, programs) is admin-only.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({ error: 'No organization selected — choose one and try again.' });
  }
  if (!req.isOrgAdmin) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  next();
}

// Vendor-only areas (creating customer organizations).
function requirePlatformAdmin(req, res, next) {
  if (!access.isPlatformAdmin(req.user)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  next();
}

// Confirms a program belongs to the active organization.
function programInOrg(programId, orgId) {
  if (!programId) return null;
  return db.prepare(`SELECT * FROM programs WHERE id=? AND org_id=?`).get(programId, orgId) || null;
}

module.exports = {
  requireAuth, requireOrg, requireOrgAdmin, requirePlatformAdmin, programInOrg,
};
