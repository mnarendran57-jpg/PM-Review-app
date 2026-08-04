const db = require('../database');

// Answers "what can this user see?" for the Organization -> Program -> Project model.
//
// Three grants, and only three:
//   - Org Admin      : blanket access to every Program and Project in that Organization.
//   - Program Member : every Project in that Program, including ones added later.
//   - Project Member : access to that one Project, wherever it sits.
// Only an Org Admin can hand out the latter two; nobody grants themselves anything.
//
// A platform admin (the vendor) is treated as an admin everywhere so support and
// onboarding work without inventing a membership row for every customer.

const isPlatformAdmin = user => user?.role === 'superadmin';

// The one definition of "projects this non-admin can reach": added to the project itself,
// or granted the program holding it. Every visibility check builds on this single fragment
// so they cannot drift apart — a second, subtly different copy is how leaks start. Takes
// the user id twice.
const VISIBLE_PROJECT_IDS = `
  SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?
  UNION
  SELECT pr.id FROM projects pr
  JOIN program_members gm ON gm.program_id = pr.program_id AND gm.user_id = ?
`;

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
       OR EXISTS (
            SELECT 1 FROM program_members gm
            JOIN programs g ON g.id = gm.program_id
            WHERE gm.user_id = ? AND g.org_id = o.id
          )
    ORDER BY o.name ASC
  `).all(user.id, user.id, user.id, user.id);
}

// A platform admin counts as an admin of any organization that exists — but the existence
// check matters: without it a stale id (a deleted organization still selected in someone's
// browser) would be accepted, and they would sit in an empty shell the app never corrects.
const orgExists = orgId => !!db.prepare(`SELECT 1 FROM organizations WHERE id=?`).get(orgId);

function isOrgAdmin(user, orgId) {
  if (isPlatformAdmin(user)) return orgExists(orgId);
  return !!db.prepare(`
    SELECT 1 FROM org_members WHERE org_id=? AND user_id=? AND role='Admin'
  `).get(orgId, user.id);
}

// Any membership at all in the organization — enough to select it and look around.
function isInOrg(user, orgId) {
  if (isPlatformAdmin(user)) return orgExists(orgId);
  const direct = db.prepare(`SELECT 1 FROM org_members WHERE org_id=? AND user_id=?`).get(orgId, user.id);
  if (direct) return true;
  const viaProject = db.prepare(`
    SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
    WHERE pm.user_id=? AND p.org_id=?
  `).get(user.id, orgId);
  if (viaProject) return true;
  return !!db.prepare(`
    SELECT 1 FROM program_members gm JOIN programs g ON g.id = gm.program_id
    WHERE gm.user_id=? AND g.org_id=?
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
  // Reachable either by a grant on the program itself, or by being on a project inside it.
  // The count is of projects they can actually open, which is the whole program when the
  // grant is program-level.
  return db.prepare(`
    SELECT p.*, (
      SELECT COUNT(*) FROM projects pr
      WHERE pr.program_id = p.id AND pr.id IN (${VISIBLE_PROJECT_IDS})
    ) AS project_count
    FROM programs p
    WHERE p.org_id = ?
      AND (
        EXISTS (SELECT 1 FROM program_members gm WHERE gm.program_id = p.id AND gm.user_id = ?)
        OR EXISTS (
          SELECT 1 FROM projects pr
          JOIN project_members pm ON pm.project_id = pr.id
          WHERE pr.program_id = p.id AND pm.user_id = ?
        )
      )
    ORDER BY p.name ASC
  `).all(user.id, user.id, orgId, user.id, user.id);
}

// Same rule one level down.
function projectsForUser(user, orgId, programId = null) {
  const admin = isOrgAdmin(user, orgId);
  const params = [orgId];
  let sql = `SELECT p.* FROM projects p WHERE p.org_id = ?`;
  if (programId) { sql += ` AND p.program_id = ?`; params.push(programId); }
  if (!admin) {
    sql += ` AND p.id IN (${VISIBLE_PROJECT_IDS})`;
    params.push(user.id, user.id);
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
  const member = db.prepare(
    `SELECT 1 WHERE ? IN (${VISIBLE_PROJECT_IDS})`
  ).get(project.id, user.id, user.id);
  return member ? project : null;
}

// Every role a user holds on a project — a person can be both Admin and PM, so this is a
// list rather than a single value.
function rolesOnProject(user, projectId) {
  const roles = db.prepare(`
    SELECT role FROM project_members WHERE project_id=? AND user_id=?
  `).all(projectId, user.id).map(r => r.role);
  const project = db.prepare(`SELECT org_id, program_id FROM projects WHERE id=?`).get(projectId);
  // Reaching the project through its program is a real role here, otherwise someone granted
  // a whole program would show up on its projects with no role at all.
  if (project?.program_id && db.prepare(
    `SELECT 1 FROM program_members WHERE program_id=? AND user_id=?`
  ).get(project.program_id, user.id)) {
    roles.unshift('Program Member');
  }
  if (project && isOrgAdmin(user, project.org_id)) roles.unshift('Admin');
  return roles;
}

// --- Record-level scoping for the document tools ---------------------------------------
// Every tool table carries org_id, and most also carry project_id. These two helpers are
// what those routes use so the rule lives in one place rather than being restated (and
// eventually mis-stated) in each of them.

// A WHERE fragment limiting rows to what this user may see inside one organization.
// Admins see the whole organization; everyone else sees only rows belonging to a project
// they are a member of. Rows with no project are administrative, so members never see them.
function visibilityClause(user, orgId, { alias = '', projectColumn = 'project_id' } = {}) {
  const p = alias ? `${alias}.` : '';
  if (isOrgAdmin(user, orgId)) {
    return { sql: `${p}org_id = ?`, params: [orgId] };
  }
  if (!projectColumn) {
    // No project to scope by and not an admin — nothing is visible.
    return { sql: '1 = 0', params: [] };
  }
  return {
    sql: `${p}org_id = ? AND ${p}${projectColumn} IN (${VISIBLE_PROJECT_IDS})`,
    params: [orgId, user.id, user.id],
  };
}

// The same rule for a single already-loaded row. Callers turn false into a 404 rather than
// a 403 so record ids cannot be probed for existence.
function recordVisible(user, row, { projectColumn = 'project_id' } = {}) {
  if (!row) return false;
  // Rows predating organizations belong to nobody; only the vendor can reach them.
  if (row.org_id == null) return isPlatformAdmin(user);
  if (!isInOrg(user, row.org_id)) return false;
  if (isOrgAdmin(user, row.org_id)) return true;
  const projectId = projectColumn ? row[projectColumn] : null;
  if (!projectId) return false;
  return !!db.prepare(
    `SELECT 1 WHERE ? IN (${VISIBLE_PROJECT_IDS})`
  ).get(projectId, user.id, user.id);
}

// Sign-in tokens are stateless and last 30 days, so resetting a password has to reject the
// ones handed out before it — otherwise whoever prompted the reset stays signed in. Both
// sides are whole seconds (a JWT's iat is, and so is SQLite's datetime('now')), so a token
// minted in the same second as the reset — the one we hand back to the person resetting —
// compares equal and survives.
function tokenStillValid(user, claims) {
  if (!user?.sessions_valid_from || !claims?.iat) return true;
  return claims.iat * 1000 >= Date.parse(`${user.sessions_valid_from.replace(' ', 'T')}Z`);
}

module.exports = {
  isPlatformAdmin, orgsForUser, isOrgAdmin, isInOrg,
  programsForUser, projectsForUser, projectForUser, rolesOnProject,
  visibilityClause, recordVisible, tokenStillValid,
};
