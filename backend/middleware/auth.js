const jwt = require('jsonwebtoken');
const db = require('../database');

// Establishes who is calling and, crucially, which firm they belong to. Routes read
// req.firmId rather than trusting anything in the request body or URL, so one firm can
// never reach another's data by guessing an id.
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
  const user = db.prepare(`SELECT id, firm_id, email, name, role, status FROM users WHERE id=?`).get(claims.uid);
  if (!user || user.status !== 'Active') {
    return res.status(401).json({ error: 'This account is no longer active' });
  }

  req.user = user;
  req.firmId = user.firm_id;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

// Confirms a client belongs to the caller's firm before anything is read or written
// against it. Returns the client row, or null if it isn't theirs.
function clientInFirm(clientId, firmId) {
  if (!clientId) return null;
  return db.prepare(`SELECT * FROM clients WHERE id=? AND firm_id=?`).get(clientId, firmId) || null;
}

// Same for a project.
function projectInFirm(projectId, firmId) {
  if (!projectId) return null;
  return db.prepare(`SELECT * FROM projects WHERE id=? AND firm_id=?`).get(projectId, firmId) || null;
}

module.exports = { requireAuth, requireRole, clientInFirm, projectInFirm };
