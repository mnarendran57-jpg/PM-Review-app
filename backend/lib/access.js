const db = require('../database');

// Answers "what can this user see?" for the Organization -> Program -> Project model.
//
// Two grants, and only two:
//   - Org Admin      : blanket access to every Program and Project in that Organization.
//   - Project Member : access to that one Project, wherever it sits.
// There is intentionally no Program-level grant — someone who needs several projects in a
// Program is added to each of them.
//
// A platform admin (the vendor) is treated as an admin everywhere so support and
// onboarding work without inventing a membership row for every customer.

const isPlatformAdmin = user => user?.role === 'superadmin';

// Organizations the user can reach at all: either they are a member of the organization,
// or they are on a project that belongs to it.
function orgsForUser(user) {
  // is_admin travels with each row so the app can hide administrative controls without a
  // second round trip. The server still re-checks on every write.
  if (isPlatformAdmin(user)) {
    return db.prepare(`SELECT *, 1 AS is_admin FROM organizations ORDER BY name ASC`).all();
  }
  return db.prepare(`
    SELECT DISTINCT o.*,
      EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.user_id = ? AND m.role='Admin') AS is_admin
    FROM organizations o
    WHERE EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.user_id = ?)
       OR EXISTS (
            SELECT 1 FROM project_members pm
            JOIN projects p ON p.id = pm.project_id
            WHERE pm.user_id = ? AND p.org_id = o.id
          )
    ORDER BY o.name ASC
  `).all(user.id, user.id, user.id);
}

function isOrgAdmin(user, orgId) {
  if (isPlatformAdmin(user)) return true;
  return !!db.prepare(`
    SELECT 1 FROM org_members WHERE org_id=? AND user_id=? AND role='Admin'
  `).get(orgId, user.id);
}

// Any membership at all in the organization — enough to select it and look around.
function isInOrg(user, orgId) {
  if (isPlatformAdmin(user)) return true;
  const direct = db.prepare(`SELECT 1 FROM org_members WHERE org_id=? AND user_id=?`).get(orgId, user.id);
  if (direct) return true;
  return !!db.prepare(`
    SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
    WHERE pm.user_id=? AND p.org_id=?
  `).get(user.id, orgId);
}

// Admins see every Program in the organization; everyone else sees only those containing
// a project they are actually on.
function programsForUser(user, orgId) {
  if (isOrgAdmin(user, orgId)) {
    return db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM projects pr WHERE pr.program_id = p.id) AS project_count
      FROM programs p WHERE p.org_id = ? ORDER BY p.name ASC
    `).all(orgId);
  }
  return db.prepare(`
    SELECT p.*, (
      SELECT COUNT(*) FROM projects pr
      JOIN project_members pm ON pm.project_id = pr.id AND pm.user_id = ?
      WHERE pr.program_id = p.id
    ) AS project_count
    FROM programs p
    WHERE p.org_id = ?
      AND EXISTS (
        SELECT 1 FROM projects pr
        JOIN project_members pm ON pm.project_id = pr.id
        WHERE pr.program_id = p.id AND pm.user_id = ?
      )
    ORDER BY p.name ASC
  `).all(user.id, orgId, user.id);
}

// Same rule one level down.
function projectsForUser(user, orgId, programId = null) {
  const admin = isOrgAdmin(user, orgId);
  const params = [orgId];
  let sql = `SELECT p.* FROM projects p WHERE p.org_id = ?`;
  if (programId) { sql += ` AND p.program_id = ?`; params.push(programId); }
  if (!admin) {
    sql += ` AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?)`;
    params.push(user.id);
  }
  sql += ` ORDER BY p.created_at DESC`;
  return db.prepare(sql).all(...params);
}

// The gate every project-scoped route uses. Returns the project row when the user may
// touch it, otherwise null — callers turn that into a 404 so ids can't be probed.
function projectForUser(user, projectId) {
  const project = db.prepare(`SELECT * FROM projects WHERE id=?`).get(projectId);
  if (!project) return null;
  if (isOrgAdmin(user, project.org_id)) return project;
  const member = db.prepare(`
    SELECT 1 FROM project_members WHERE project_id=? AND user_id=?
  `).get(projectId, user.id);
  return member ? project : null;
}

// Every role a user holds on a project — a person can be both Admin and PM, so this is a
// list rather than a single value.
function rolesOnProject(user, projectId) {
  const roles = db.prepare(`
    SELECT role FROM project_members WHERE project_id=? AND user_id=?
  `).all(projectId, user.id).map(r => r.role);
  const project = db.prepare(`SELECT org_id FROM projects WHERE id=?`).get(projectId);
  if (project && isOrgAdmin(user, project.org_id)) roles.unshift('Admin');
  return roles;
}

module.exports = {
  isPlatformAdmin, orgsForUser, isOrgAdmin, isInOrg,
  programsForUser, projectsForUser, projectForUser, rolesOnProject,
};
