const express = require('express');
const router = express.Router();
const db = require('../database');
const access = require('../lib/access');
const { requireOrg, requireOrgAdmin, programInOrg } = require('../middleware/auth');

// Extra columns the project cards show. Kept separate so the two queries below stay
// readable rather than repeating the sub-selects.
function decorate(project) {
  if (!project) return project;
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM rfis r WHERE r.project_id = ? AND r.status = 'Open') AS open_rfis,
      (SELECT COUNT(*) FROM submittals s WHERE s.project_id = ? AND s.review_action = 'Pending') AS pending_submittals,
      (SELECT COUNT(*) FROM pay_applications pa WHERE pa.project_id = ? AND pa.status = 'Under Review') AS pay_apps_under_review,
      (SELECT COUNT(*) FROM document_reviews dr WHERE dr.project_name = ?) AS ai_reviews
  `).get(project.id, project.id, project.id, project.project_name);
  const program = project.program_id
    ? db.prepare(`SELECT name FROM programs WHERE id=?`).get(project.program_id)
    : null;
  return { ...project, ...counts, program: program?.name || null };
}

// The projects this user may actually see in the active organization: everything for an
// Org Admin, otherwise only those they hold a Project Member row for.
router.get('/', requireOrg, (req, res) => {
  const programId = req.query.program_id ? Number(req.query.program_id) : null;
  res.json(access.projectsForUser(req.user, req.orgId, programId).map(decorate));
});

// Answering 404 rather than 403 for a project they cannot reach keeps ids unprobeable.
router.get('/:id', (req, res) => {
  const project = access.projectForUser(req.user, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json({ ...decorate(project), myRoles: access.rolesOnProject(req.user, project.id) });
});

// Creating a project is an organization-admin action: it decides what work exists, and
// members are then added to it individually.
router.post('/', requireOrgAdmin, (req, res) => {
  const {
    project_name, project_number, client_name, project_type, project_type_other,
    contract_value, start_date, projected_end_date, status,
    project_manager, notes
  } = req.body;
  // Only the project name is required. Every other field is optional — coerce any that
  // weren't sent to null/defaults, because node:sqlite rejects `undefined` bindings.
  if (!project_name || !String(project_name).trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  // A project always belongs to a program, and the program must belong to the active
  // organization — verified rather than trusted, so a tampered id can't plant a project
  // inside someone else's organization. Falls back to the organization's first program.
  let program = programInOrg(req.body.program_id, req.orgId);
  if (req.body.program_id && !program) return res.status(400).json({ error: 'Unknown program' });
  if (!program) {
    program = db.prepare(`SELECT * FROM programs WHERE org_id=? ORDER BY id ASC LIMIT 1`).get(req.orgId);
  }
  if (!program) return res.status(400).json({ error: 'This organization has no program to add the project to.' });

  const result = db.prepare(`
    INSERT INTO projects (org_id, program_id, project_name, project_number, client_name, project_type, project_type_other,
      contract_value, start_date, projected_end_date, status, project_manager, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId,
    program.id,
    String(project_name).trim(),
    project_number ?? null,
    client_name ?? null,
    project_type ?? 'MEP',
    project_type_other ?? null,
    contract_value ?? null,
    start_date ?? null,
    projected_end_date ?? null,
    status ?? 'Active',
    project_manager ?? null,
    notes ?? null
  );
  res.json({ id: result.lastInsertRowid, program_id: program.id });
});

router.put('/:id', requireOrgAdmin, (req, res) => {
  const {
    project_name, project_number, client_name, project_type, project_type_other,
    contract_value, start_date, projected_end_date, status,
    project_manager, notes
  } = req.body;
  const existing = db.prepare(`SELECT program_id FROM projects WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Moving a project to another program is allowed, but only within this organization.
  let programId = existing.program_id;
  if (req.body.program_id !== undefined && req.body.program_id !== null) {
    const program = programInOrg(req.body.program_id, req.orgId);
    if (!program) return res.status(400).json({ error: 'Unknown program' });
    programId = program.id;
  }

  db.prepare(`
    UPDATE projects SET program_id=?, project_name=?, project_number=?, client_name=?, project_type=?, project_type_other=?,
      contract_value=?, start_date=?, projected_end_date=?, status=?, project_manager=?, notes=?
    WHERE id=? AND org_id=?
  `).run(
    programId,
    project_name ?? null,
    project_number ?? null,
    client_name ?? null,
    project_type ?? 'MEP',
    project_type_other ?? null,
    contract_value ?? null,
    start_date ?? null,
    projected_end_date ?? null,
    status ?? 'Active',
    project_manager ?? null,
    notes ?? null,
    req.params.id,
    req.orgId
  );
  res.json({ success: true });
});

router.delete('/:id', requireOrgAdmin, (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=? AND org_id=?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

// --- Project membership --------------------------------------------------------------
// Who is on this project, and in what role. A person may hold several roles at once, so
// these are rows rather than a single value per user.

router.get('/:id/members', (req, res) => {
  const project = access.projectForUser(req.user, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(db.prepare(`
    SELECT pm.id, pm.role, pm.created_at, u.id AS user_id, u.name, u.email
    FROM project_members pm JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ? ORDER BY u.name IS NULL, u.name ASC, pm.role ASC
  `).all(project.id));
});

router.post('/:id/members', requireOrgAdmin, (req, res) => {
  const project = db.prepare(`SELECT * FROM projects WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || 'PM').trim() || 'PM';
  const user = req.body.user_id
    ? db.prepare(`SELECT * FROM users WHERE id=?`).get(req.body.user_id)
    : db.prepare(`SELECT * FROM users WHERE lower(email)=?`).get(email);
  if (!user) {
    return res.status(404).json({ error: 'No account with that email. Add them to the organization first.' });
  }
  db.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`)
    .run(project.id, user.id, role);
  res.json({ success: true });
});

router.delete('/:id/members/:memberId', requireOrgAdmin, (req, res) => {
  const project = db.prepare(`SELECT id FROM projects WHERE id=? AND org_id=?`).get(req.params.id, req.orgId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM project_members WHERE id=? AND project_id=?`).run(req.params.memberId, project.id);
  res.json({ success: true });
});

module.exports = router;
