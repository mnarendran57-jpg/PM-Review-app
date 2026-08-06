const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// DB_PATH lets a deployment point the database at a persistent disk (e.g. Render's
// mounted volume) instead of the app directory, which is ephemeral on most hosts and
// would wipe all data on every redeploy. Falls back to the local file for dev.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'pm_review.db');
const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

// --- Organization / Program / Project access model ------------------------------------
// The hierarchy is always three levels, with no null cases:
//   Organization -> Program -> Project
// An Organization is a customer (an ISD, a PM firm — whoever signs up). A Program groups
// related projects; organizations that don't think in programs still get a default one, so
// a Project always has a Program and a Program always has an Organization.
//
// Users sit OUTSIDE the hierarchy: one account is one person, not tied to any organization,
// because the same consultant often works for several customers and must not need a second
// login. Access is granted by two many-to-many membership tables instead:
//   org_members     — a user on an Organization (role Admin) sees every Program and
//                     Project underneath it automatically.
//   project_members — a user on an individual Project (Owner, GC, Sub, PM, ...). This is
//                     how most day-to-day access works, and those projects may span
//                     different Programs or even different Organizations.
// There is deliberately no Program-level access tier: broad access is Org Admin, otherwise
// people are added per project. A user may hold several roles on the same project, so the
// membership tables allow multiple rows per user/target.
const tableExists = name =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const columnsOf = table =>
  db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// Earlier versions modelled this as firm -> client -> project. Rename in place so the
// existing rows (and their foreign keys) carry over rather than being rebuilt.
if (tableExists('firms') && !tableExists('organizations')) {
  db.exec(`ALTER TABLE firms RENAME TO organizations`);
}
if (tableExists('clients') && !tableExists('programs')) {
  db.exec(`ALTER TABLE clients RENAME TO programs`);
}
// Renaming a column has to cope with a half-applied migration (an earlier crash, or a
// server that restarted mid-run), where both the old and new column already exist. In
// that case the values are carried across and the stale column dropped, so running this
// twice is always safe.
function renameColumn(table, from, to) {
  if (!tableExists(table)) return;
  const cols = columnsOf(table);
  if (!cols.includes(from)) return;
  if (cols.includes(to)) {
    db.exec(`UPDATE ${table} SET ${to} = ${from} WHERE ${to} IS NULL AND ${from} IS NOT NULL`);
    try { db.exec(`ALTER TABLE ${table} DROP COLUMN ${from}`); } catch { /* left in place, unused */ }
  } else {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}

renameColumn('programs', 'firm_id', 'org_id');
renameColumn('projects', 'client_id', 'program_id');

db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT,
    notes TEXT,
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS org_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'Admin',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (org_id, user_id, role)
  );

  CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'PM',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (project_id, user_id, role)
  );

  -- A grant on a whole program: everything in it, including projects added later. Without
  -- it, giving someone a program meant adding them to each of its projects by hand and
  -- remembering to repeat that every time a project was created.
  CREATE TABLE IF NOT EXISTS program_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'Member',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (program_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    project_number TEXT,
    client_name TEXT,
    project_type TEXT DEFAULT 'MEP',
    project_type_other TEXT,
    contract_value REAL,
    start_date TEXT,
    projected_end_date TEXT,
    status TEXT DEFAULT 'Active',
    project_manager TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- The RFI log's tables are defined further down, once projects exists and the tenancy
  -- migration has run — see "RFI log".

  -- The submittal log's tables are defined further down, once projects exists and the
  -- tenancy migration has run — see "Submittal log".

  CREATE TABLE IF NOT EXISTS pay_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    subcontractor TEXT NOT NULL,
    application_number TEXT,
    period_start TEXT,
    period_end TEXT,
    scheduled_value REAL DEFAULT 0,
    previously_billed REAL DEFAULT 0,
    current_billing REAL DEFAULT 0,
    retainage_pct REAL DEFAULT 10,
    net_amount_due REAL DEFAULT 0,
    status TEXT DEFAULT 'Received',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    vendor TEXT NOT NULL,
    invoice_number TEXT,
    invoice_date TEXT,
    amount REAL DEFAULT 0,
    po_number TEXT,
    status TEXT DEFAULT 'Received',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT,
    document_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    context_notes TEXT,
    ai_review TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memo_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    company_name TEXT DEFAULT 'Olivier Inc.',
    header_title TEXT DEFAULT 'MEMORANDUM',
    sections TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proposal_intakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intake_type TEXT NOT NULL,
    vendor_name TEXT,
    project_name TEXT,
    po_number TEXT,
    proposal_date TEXT,
    scope_of_work TEXT,
    total_price TEXT,
    memo_template_id INTEGER REFERENCES memo_templates(id) ON DELETE SET NULL,
    proposal_file_name TEXT,
    proposal_file BLOB,
    po_file_name TEXT,
    po_file BLOB,
    merged_file_name TEXT NOT NULL,
    merged_pdf BLOB NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pay_app_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT,
    application_number INTEGER,
    period_to TEXT,
    contract_sum_to_date REAL,
    total_completed_to_date REAL,
    current_payment_due REAL,
    balance_to_finish REAL,
    extracted_data TEXT NOT NULL,
    checks_result TEXT NOT NULL,
    report_markdown TEXT NOT NULL,
    current_file_name TEXT,
    current_file BLOB,
    previous_review_id INTEGER REFERENCES pay_app_reviews(id) ON DELETE SET NULL,
    contract_sum REAL,
    co_log TEXT,
    critical_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- The executed contract is signed once per project, so it is stored against the
  -- project and its terms extracted once. Pay app reviews read the stored terms
  -- rather than re-sending the contract PDF to the model every period.
  CREATE TABLE IF NOT EXISTS project_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_blob BLOB NOT NULL,
    -- Model-extracted terms, then user-corrected. Shape:
    --   { taxExempt, taxExemptBasis, unallowableItems[], originalContractSum,
    --     retainageRate, notes }
    terms TEXT NOT NULL,
    terms_edited INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pco_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    pco_number TEXT,
    title TEXT,
    contractor TEXT,
    total_amount REAL,
    is_allowance INTEGER DEFAULT 0,
    extracted_data TEXT NOT NULL,
    checks_result TEXT NOT NULL,
    ai_observations TEXT,
    report_markdown TEXT NOT NULL,
    pco_file_name TEXT,
    pco_file BLOB,
    reference_file_name TEXT,
    reference_file BLOB,
    critical_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS preconstruction_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT,
    review_focus TEXT,
    file_names TEXT,
    report_json TEXT NOT NULL,
    report_markdown TEXT NOT NULL,
    insufficient_info INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS preconstruction_review_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES preconstruction_reviews(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_blob BLOB NOT NULL
  );

  -- Vendor invoice reviews. The project's stored contract terms are the reference the
  -- invoice is checked against (tax status, unallowable/reimbursable cost rules), so the
  -- contract PDF is never re-sent. The uploaded invoice(s) — one primary invoice plus any
  -- backup receipts/invoices for reimbursable costs — are kept in invoice_review_files.
  CREATE TABLE IF NOT EXISTS invoice_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    vendor TEXT,
    invoice_number TEXT,
    invoice_date TEXT,
    total_amount REAL,
    extracted_data TEXT NOT NULL,
    checks_result TEXT NOT NULL,
    ai_observations TEXT,
    report_markdown TEXT NOT NULL,
    critical_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoice_review_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES invoice_reviews(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_blob BLOB NOT NULL
  );

  -- Site-visit progress reports. A PM uploads a batch of site photos (with captions) at a
  -- set visit frequency; Claude writes a narrative progress report from the images. The
  -- photos and their captions are kept in progress_report_files so the report can be
  -- reopened with its photo log intact.
  CREATE TABLE IF NOT EXISTS progress_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    report_number INTEGER,
    frequency TEXT,
    period_label TEXT,
    visit_date TEXT,
    visit_time TEXT,
    weather TEXT,
    submitted_by TEXT,
    contractor TEXT,
    notes TEXT,
    image_count INTEGER DEFAULT 0,
    report_json TEXT NOT NULL,
    report_markdown TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS progress_report_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES progress_reports(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    caption TEXT,
    file_blob BLOB NOT NULL
  );
`);

// Migrations — add columns that may not exist in older databases
const projectCols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
if (!projectCols.includes('project_type_other')) {
  db.exec(`ALTER TABLE projects ADD COLUMN project_type_other TEXT`);
}

// Progress reports gained template header fields (report number, time, weather,
// submitted-by, contractor) after the table first shipped.
const prCols = db.prepare(`PRAGMA table_info(progress_reports)`).all().map(c => c.name);
for (const [col, type] of [
  ['report_number', 'INTEGER'], ['visit_time', 'TEXT'], ['weather', 'TEXT'],
  ['submitted_by', 'TEXT'], ['contractor', 'TEXT'],
]) {
  if (!prCols.includes(col)) db.exec(`ALTER TABLE progress_reports ADD COLUMN ${col} ${type}`);
}

// Object-storage keys. When Cloudflare R2 is configured, the file bytes live in R2 and
// these columns hold the object key ("claim ticket"); the matching blob column is left
// empty. When R2 is off, the key is null and the blob holds the bytes (original behavior).
const addKeyCols = (table, cols) => {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const col of cols) {
    if (!existing.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }
};
addKeyCols('proposal_intakes', ['proposal_file_key', 'po_file_key', 'merged_pdf_key']);
addKeyCols('pay_app_reviews', ['current_file_key']);
addKeyCols('project_contracts', ['file_key']);
addKeyCols('pco_reviews', ['pco_file_key', 'reference_file_key']);
addKeyCols('preconstruction_review_files', ['file_key']);
addKeyCols('invoice_review_files', ['file_key']);
addKeyCols('progress_report_files', ['file_key']);

const intakeCols = db.prepare(`PRAGMA table_info(proposal_intakes)`).all().map(c => c.name);
if (!intakeCols.includes('change_order_price')) {
  db.exec(`ALTER TABLE proposal_intakes ADD COLUMN change_order_price TEXT`);
}
if (!intakeCols.includes('original_po_amount')) {
  db.exec(`ALTER TABLE proposal_intakes ADD COLUMN original_po_amount TEXT`);
}
if (!intakeCols.includes('new_total_amount')) {
  db.exec(`ALTER TABLE proposal_intakes ADD COLUMN new_total_amount TEXT`);
}

// Pay app reviews used to be tied to a project by the project-name text read off the
// PDF, which silently failed whenever a vendor spelled the name differently between
// applications. Link them to projects.id instead, and backfill existing rows by
// creating a project for each distinct name already on file.
const payAppCols = db.prepare(`PRAGMA table_info(pay_app_reviews)`).all().map(c => c.name);
if (!payAppCols.includes('project_id')) {
  db.exec(`ALTER TABLE pay_app_reviews ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);

  const orphanNames = db.prepare(`
    SELECT DISTINCT project_name FROM pay_app_reviews
    WHERE project_name IS NOT NULL AND TRIM(project_name) <> ''
  `).all();

  const findProject = db.prepare(`SELECT id FROM projects WHERE project_name = ?`);
  const createProject = db.prepare(`INSERT INTO projects (project_name, status) VALUES (?, 'Active')`);
  const linkReviews = db.prepare(`UPDATE pay_app_reviews SET project_id = ? WHERE project_name = ?`);

  for (const { project_name } of orphanNames) {
    const existingProject = findProject.get(project_name);
    const id = existingProject ? existingProject.id : createProject.run(project_name).lastInsertRowid;
    linkReviews.run(id, project_name);
  }
}

// Contract-compliance findings are stored alongside the math results so a stored
// review reopens exactly as it was first produced, without re-running the AI scan.
if (!db.prepare(`PRAGMA table_info(pay_app_reviews)`).all().map(c => c.name).includes('compliance_findings')) {
  db.exec(`ALTER TABLE pay_app_reviews ADD COLUMN compliance_findings TEXT`);
}

// Default settings
const existing = db.prepare(`SELECT key FROM settings WHERE key IN ('rfi_response_days','submittal_review_days')`).all();
const existingKeys = new Set(existing.map(r => r.key));
const insertSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
if (!existingKeys.has('rfi_response_days')) insertSetting.run('rfi_response_days', '10');
if (!existingKeys.has('submittal_review_days')) insertSetting.run('submittal_review_days', '14');

// Migrate the seeded default template's letterhead if it still has the old placeholder values
db.prepare(`
  UPDATE memo_templates
  SET company_name = ?, header_title = ''
  WHERE name = 'Standard Proposal Memo' AND header_title = 'MEMORANDUM'
`).run('Olivier Inc\n3934 Cypress Creek Pkwy, Suite 355\nHouston, Texas 77068\nwww.olivier-inc.com');

// Migrate any template still using the old static Request wording to the
// backend-computed {{request_sentence}} placeholder (differs for New Vendor vs Change Order).
const OLD_REQUEST_TEXT = 'Kindly initiate a requisition in the amount of {{total_price}}.';
for (const row of db.prepare(`SELECT id, sections FROM memo_templates`).all()) {
  const sections = JSON.parse(row.sections);
  let changed = false;
  for (const s of sections) {
    if (s.content === OLD_REQUEST_TEXT) {
      s.content = '{{request_sentence}}';
      changed = true;
    }
  }
  if (changed) {
    db.prepare(`UPDATE memo_templates SET sections=? WHERE id=?`).run(JSON.stringify(sections), row.id);
  }
}

// Migrate the approver's job title in existing templates. Applied as a targeted string
// replacement so any other edits the user has made to their template are preserved.
const OLD_APPROVER_TITLE = 'Chief Facilities Officer';
const NEW_APPROVER_TITLE = 'Associate Vice Chancellor (AVC), Facilities Management';
for (const row of db.prepare(`SELECT id, sections FROM memo_templates`).all()) {
  const sections = JSON.parse(row.sections);
  let changed = false;
  for (const s of sections) {
    if (s.content && s.content.includes(OLD_APPROVER_TITLE)) {
      s.content = s.content.split(OLD_APPROVER_TITLE).join(NEW_APPROVER_TITLE);
      changed = true;
    }
  }
  if (changed) {
    db.prepare(`UPDATE memo_templates SET sections=? WHERE id=?`).run(JSON.stringify(sections), row.id);
  }
}

// Default memo template
const templateCount = db.prepare(`SELECT COUNT(*) AS c FROM memo_templates`).get().c;
if (templateCount === 0) {
  const defaultSections = JSON.stringify([
    {
      label: 'Header Info',
      content: 'Date: {{date}}\n\nTo: {{to_name}}\nFrom: {{from_name}}\nProject: {{project_name}}',
      divider_after: true
    },
    {
      label: 'Re',
      content: 'Re: {{project_name}} — {{vendor_name}} {{memo_type}}{{po_reference}}'
    },
    {
      label: 'Scope of Work',
      content: '{{scope_of_work}}'
    },
    {
      label: 'Request',
      content: '{{request_sentence}}'
    },
    {
      label: 'Signatures',
      content: '\n\n\n_________________________\n{{from_name}}, Senior Project Manager\n\n\n\n_________________________\n{{to_name}}, Associate Vice Chancellor (AVC), Facilities Management'
    }
  ]);
  db.prepare(`
    INSERT INTO memo_templates (name, is_default, company_name, header_title, sections)
    VALUES (?, 1, ?, ?, ?)
  `).run(
    'Standard Proposal Memo',
    'Olivier Inc\n3934 Cypress Creek Pkwy, Suite 355\nHouston, Texas 77068\nwww.olivier-inc.com',
    '',
    defaultSections
  );
}

// --- Tenancy migration ---------------------------------------------------------------
// Every record a user can reach carries an org_id, so a query can be constrained to one
// organization with a single WHERE clause rather than a chain of joins that a newly added
// route might forget to write.
const TENANT_TABLES = [
  'projects', 'proposal_intakes', 'pay_app_reviews', 'pco_reviews', 'invoice_reviews',
  'progress_reports', 'preconstruction_reviews', 'memo_templates', 'team_members',
  'document_reviews', 'rfis', 'submittals', 'pay_applications', 'invoices',
];
for (const table of TENANT_TABLES) {
  if (!columnsOf(table).length) continue;
  renameColumn(table, 'firm_id', 'org_id');
  if (!columnsOf(table).includes('org_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE`);
  }
}
// A project always belongs to a program; the column may predate that rule.
if (!columnsOf('projects').includes('program_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL`);
}

// One-time bootstrap for a database that predates organizations entirely.
if (db.prepare(`SELECT COUNT(*) AS c FROM organizations`).get().c === 0) {
  const orgName = process.env.DEFAULT_ORG_NAME || process.env.DEFAULT_FIRM_NAME || 'Coaster';
  const orgId = db.prepare(`INSERT INTO organizations (name) VALUES (?)`).run(orgName).lastInsertRowid;

  for (const table of TENANT_TABLES) {
    if (columnsOf(table).includes('org_id')) {
      db.exec(`UPDATE ${table} SET org_id = ${orgId} WHERE org_id IS NULL`);
    }
  }
  // Programs are derived from the client names already typed onto projects.
  const names = db.prepare(`
    SELECT DISTINCT TRIM(client_name) AS name FROM projects
    WHERE client_name IS NOT NULL AND TRIM(client_name) <> ''
  `).all().map(r => r.name);
  const insertProgram = db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, ?)`);
  for (const name of names) {
    const programId = insertProgram.run(orgId, name).lastInsertRowid;
    db.prepare(`UPDATE projects SET program_id=? WHERE TRIM(client_name)=? AND program_id IS NULL`).run(programId, name);
  }
  console.log(`[access] created organization "${orgName}" and moved existing data into it (${names.length} program(s) derived)`);
}

// Users used to belong to exactly one firm. That column is replaced by org_members, so
// each existing user becomes a member of the organization they were tied to — an Admin if
// they administered it, otherwise an ordinary member.
if (columnsOf('users').includes('firm_id')) {
  const legacy = db.prepare(`SELECT id, firm_id, role FROM users WHERE firm_id IS NOT NULL`).all();
  const addMember = db.prepare(`
    INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
  `);
  for (const u of legacy) {
    addMember.run(u.firm_id, u.id, ['admin', 'superadmin'].includes(u.role) ? 'Admin' : 'Member');
  }
  try {
    db.exec(`ALTER TABLE users DROP COLUMN firm_id`);
  } catch {
    // Older SQLite without DROP COLUMN — harmless, the column is simply ignored from here.
  }
  // Anyone left with no membership at all (e.g. a user whose firm was already gone) still
  // needs a way in, so attach them to the first organization.
  const firstOrg = db.prepare(`SELECT id FROM organizations ORDER BY id ASC LIMIT 1`).get();
  if (firstOrg) {
    for (const u of db.prepare(`
      SELECT id, role FROM users WHERE id NOT IN (SELECT user_id FROM org_members)
    `).all()) {
      addMember.run(firstOrg.id, u.id, ['admin', 'superadmin'].includes(u.role) ? 'Admin' : 'Member');
    }
  }
  if (legacy.length) console.log(`[access] converted ${legacy.length} user(s) to organization memberships`);
}

// Every organization is guaranteed at least one program, and every project is guaranteed
// to sit in one, so nothing downstream has to cope with a missing level.
for (const org of db.prepare(`SELECT id FROM organizations`).all()) {
  const has = db.prepare(`SELECT COUNT(*) AS c FROM programs WHERE org_id=?`).get(org.id).c;
  if (has === 0) db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, 'Default Program')`).run(org.id);
}
const strays = db.prepare(`SELECT id, org_id FROM projects WHERE program_id IS NULL AND org_id IS NOT NULL`).all();
for (const p of strays) {
  const program = db.prepare(`SELECT id FROM programs WHERE org_id=? ORDER BY id ASC LIMIT 1`).get(p.org_id);
  if (program) db.prepare(`UPDATE projects SET program_id=? WHERE id=?`).run(program.id, p.id);
}

// Invitations. An admin invites someone by email rather than choosing a password on their
// behalf: the invitee follows a one-time link and sets their own. The token is the secret,
// so it is random and expires; accepting it is what creates the account.
db.exec(`
  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Member',
    token TEXT NOT NULL UNIQUE,
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
`);

// Password resets. Same shape as an invitation and for the same reason — the emailed token
// is the only credential, so it is random, single-use and short-lived (an hour, against an
// invitation's week, because this one can take over an existing account).
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    requested_ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
`);

// Sign-in tokens last 30 days and are stateless, so changing a password would otherwise
// leave anyone already signed in as that user signed in — exactly the person a reset is
// usually meant to lock out. Tokens issued before this moment are refused.
if (!columnsOf('users').includes('sessions_valid_from')) {
  db.exec(`ALTER TABLE users ADD COLUMN sessions_valid_from TEXT`);
}

// Which Coaster plan a customer is on, and — for a negotiated "custom" deal — the exact
// features they bought. Deliberately left NULL on existing organizations: a null plan means
// everything is included, so introducing pricing never takes a tool away from a customer who
// already had it. See lib/plans.js.
if (!columnsOf('organizations').includes('plan')) {
  db.exec(`ALTER TABLE organizations ADD COLUMN plan TEXT`);
}
if (!columnsOf('organizations').includes('plan_features')) {
  db.exec(`ALTER TABLE organizations ADD COLUMN plan_features TEXT`);
}

// A project has more than one agreement — the architect's, the general contractor's, often an
// engineer's — and an invoice must be checked against the right one. Shared Documents also
// holds files that are not agreements at all (schedule, estimate), so each row records what
// it is: only a 'contract' has terms extracted and appears where a contract is chosen.
if (!columnsOf('project_contracts').includes('label')) {
  db.exec(`ALTER TABLE project_contracts ADD COLUMN label TEXT`);
}
if (!columnsOf('project_contracts').includes('doc_type')) {
  db.exec(`ALTER TABLE project_contracts ADD COLUMN doc_type TEXT DEFAULT 'contract'`);
}
// Pay App and Change Order Review still read a single contract per project. Marking one
// keeps that deterministic now that several can exist — without it they would follow whatever
// was uploaded most recently, which could be the architect's contract on a GC pay app.
if (!columnsOf('project_contracts').includes('is_primary')) {
  db.exec(`ALTER TABLE project_contracts ADD COLUMN is_primary INTEGER DEFAULT 0`);
  // Everything already on file predates multiple contracts, so it is that project's primary.
  db.exec(`UPDATE project_contracts SET is_primary = 1`);
}
db.exec(`UPDATE project_contracts SET doc_type = 'contract' WHERE doc_type IS NULL`);

// --- Submittal log ---------------------------------------------------------------------
// A submittal is not one event, it is a conversation: the contractor sends it, the A/E
// answers days or weeks later, and a "Revise and Resubmit" starts the whole exchange again.
// So the record is split in two. `submittals` holds what the submittal IS — the vendor, the
// number, the spec section — which never changes across revisions. `submittal_revisions`
// holds each round trip, one row per time the package went out and came back.
//
// Nothing stores the current status. It is derived from the newest revision every time it is
// asked for (see lib/submittalLog.js), because a stored status is a second copy of the truth
// and the two drift apart the first time a date is corrected.
//
// The original table was a single flat row per submittal with the dates and the A/E's action
// on it, which could not represent a resubmittal at all — Rev 1 simply overwrote Rev 0 and
// the history was gone. It was never reachable from the app and never held a row, so it is
// replaced rather than migrated. The row check is what makes that safe: if a deployment
// somehow did put data in it, the old table is left exactly where it is and the new tables
// are created alongside under different names, so nothing is ever destroyed silently.
const legacySubmittals = tableExists('submittals')
  && columnsOf('submittals').includes('review_action')
  && db.prepare(`SELECT COUNT(*) AS c FROM submittals`).get().c === 0;
if (legacySubmittals) {
  db.exec(`DROP TABLE submittals`);
  console.log('[submittals] replaced the unused flat submittal table with the revision-aware log');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS submittals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    submittal_number TEXT NOT NULL,
    spec_section TEXT,
    description TEXT NOT NULL,
    vendor TEXT,
    submittal_type TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- One row per trip to the A/E and back. revision_number 0 is the first submission; a
  -- "Revise and Resubmit" answer is what causes revision 1 to be added, and so on. A null
  -- review_action means this revision is still open — that is the only "pending" flag there
  -- is, so a revision cannot be both answered and outstanding.
  CREATE TABLE IF NOT EXISTS submittal_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submittal_id INTEGER NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL DEFAULT 0,
    date_received TEXT,
    date_forwarded TEXT,
    date_response_due TEXT,
    date_returned TEXT,
    review_action TEXT,
    reviewed_by TEXT,
    response_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE (submittal_id, revision_number)
  );

  -- Both halves of the exchange: 'submittal' is what the contractor sent, 'response' is what
  -- the A/E returned (usually the same drawing back with a stamp on it). Attached to the
  -- revision rather than the submittal so Rev 0 and Rev 1 keep their own paperwork.
  CREATE TABLE IF NOT EXISTS submittal_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submittal_id INTEGER NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
    revision_id INTEGER REFERENCES submittal_revisions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'submittal',
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_key TEXT,
    file_blob BLOB,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_submittals_project ON submittals(project_id);
  CREATE INDEX IF NOT EXISTS idx_submittal_revisions_submittal ON submittal_revisions(submittal_id);
  CREATE INDEX IF NOT EXISTS idx_submittal_files_submittal ON submittal_files(submittal_id);
`);

// --- RFI log ---------------------------------------------------------------------------
// Same two-part shape as the submittal log, and for the same reason: an RFI is a question
// that may be asked more than once. `rfis` holds the question itself; `rfi_revisions` holds
// each trip to the A/E and back, so an answer that doesn't resolve it can be pushed back
// without opening a second RFI. Status is derived from the newest revision, never stored.
//
// The old flat table had one row per RFI with the answer written onto it, so a re-ask
// overwrote the previous answer. It was never reachable from the app; it is replaced only
// when it holds no rows, so no deployment can lose data to this.
const legacyRfis = tableExists('rfis')
  && columnsOf('rfis').includes('response')
  && db.prepare(`SELECT COUNT(*) AS c FROM rfis`).get().c === 0;
if (legacyRfis) {
  db.exec(`DROP TABLE rfis`);
  console.log('[rfis] replaced the unused flat RFI table with the revision-aware log');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS rfis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rfi_number TEXT NOT NULL,
    subject TEXT NOT NULL,
    question TEXT,
    -- Which trade the RFI is really asking about. Chosen by the PM, and it is what steers
    -- the analysis to the right drawings — a mechanical question read against the
    -- architectural sheets produces a confident, useless answer.
    discipline TEXT,
    submitted_by TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rfi_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfi_id INTEGER NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL DEFAULT 0,
    date_received TEXT,
    date_forwarded TEXT,
    date_response_due TEXT,
    date_returned TEXT,
    response_action TEXT,
    responded_by TEXT,
    response_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE (rfi_id, revision_number)
  );

  -- 'rfi' is what the contractor asked, 'response' is what the A/E returned, 'reference' is
  -- an extra document attached for this one RFI (a photo, a sketch, a spec page) that is not
  -- part of the project's Shared Documents.
  CREATE TABLE IF NOT EXISTS rfi_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfi_id INTEGER NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
    revision_id INTEGER REFERENCES rfi_revisions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'rfi',
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_key TEXT,
    file_blob BLOB,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Which of the project's Shared Documents this RFI should be read against. A join table
  -- rather than a list of ids on the RFI, so removing a shared document cannot leave an RFI
  -- pointing at one that no longer exists.
  CREATE TABLE IF NOT EXISTS rfi_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfi_id INTEGER NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
    contract_id INTEGER NOT NULL REFERENCES project_contracts(id) ON DELETE CASCADE,
    UNIQUE (rfi_id, contract_id)
  );

  -- The predicted answer. Advisory only and deliberately kept out of the log's status: it
  -- exists so the PM understands the question before the A/E replies, and it must never be
  -- mistaken for the A/E's actual answer. Stored so it is not re-run (and re-charged) every
  -- time the RFI is opened, and so the prediction can be read back against what the A/E
  -- eventually said.
  CREATE TABLE IF NOT EXISTS rfi_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfi_id INTEGER NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
    revision_id INTEGER REFERENCES rfi_revisions(id) ON DELETE SET NULL,
    discipline TEXT,
    -- What was actually read: which documents, which sheets, which PDF pages. Recorded so
    -- the PM can judge the answer, and correct the selection if it read the wrong sheets.
    sources_json TEXT,
    analysis_json TEXT NOT NULL,
    analysis_markdown TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rfis_project ON rfis(project_id);
  CREATE INDEX IF NOT EXISTS idx_rfi_revisions_rfi ON rfi_revisions(rfi_id);
  CREATE INDEX IF NOT EXISTS idx_rfi_files_rfi ON rfi_files(rfi_id);
  CREATE INDEX IF NOT EXISTS idx_rfi_analyses_rfi ON rfi_analyses(rfi_id);
`);

// Which contract an invoice was reviewed against, recorded on the review itself. Without it
// a saved review cannot say whose terms it applied, and re-reading history would be guesswork
// once a project carries several agreements. The label is copied rather than joined so the
// record still reads correctly if the contract is later renamed or removed.
if (!columnsOf('invoice_reviews').includes('contract_id')) {
  db.exec(`ALTER TABLE invoice_reviews ADD COLUMN contract_id INTEGER`);
}
if (!columnsOf('invoice_reviews').includes('contract_label')) {
  db.exec(`ALTER TABLE invoice_reviews ADD COLUMN contract_label TEXT`);
}

// First login: seed a platform administrator from the environment, and make them an Admin
// of the first organization so there is a way in. Falls back to the old shared password
// hash so an existing deployment can still be signed into after upgrading.
if (db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c === 0) {
  const email = (process.env.SUPERADMIN_EMAIL || 'admin@coaster.app').toLowerCase();
  const hash = process.env.SUPERADMIN_PASSWORD_HASH || process.env.APP_PASSWORD_HASH;
  if (hash) {
    const userId = db.prepare(`
      INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'superadmin')
    `).run(email, hash, 'Administrator').lastInsertRowid;
    const firstOrg = db.prepare(`SELECT id FROM organizations ORDER BY id ASC LIMIT 1`).get();
    if (firstOrg) {
      db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Admin')`)
        .run(firstOrg.id, userId);
    }
    console.log(`[access] seeded platform admin "${email}" (use your existing password)`);
  } else {
    console.warn('[access] no users exist and no SUPERADMIN_PASSWORD_HASH/APP_PASSWORD_HASH set — nobody can sign in');
  }
}

// --- Break-glass administrator recovery ------------------------------------------------
// Setting ADMIN_RESET_EMAIL and ADMIN_RESET_PASSWORD creates that account, or resets its
// password if it already exists, and makes it a platform administrator with Admin rights
// on the first organization. It runs on boot, so the way to use it is: set the two
// variables, let the service restart, sign in, then DELETE them and let it restart again.
//
// This exists because there is no password-reset email yet, and losing the only
// administrator would otherwise mean losing the deployment. It is not a backdoor: anyone
// who can set environment variables on the server already controls it completely.
const resetEmail = (process.env.ADMIN_RESET_EMAIL || '').trim().toLowerCase();
const resetPassword = process.env.ADMIN_RESET_PASSWORD || '';
if (resetEmail && resetPassword) {
  if (resetPassword.length < 8) {
    console.warn('[access] ADMIN_RESET_PASSWORD must be at least 8 characters — ignored');
  } else {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(resetPassword, 10);
    const existing = db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(resetEmail);
    const userId = existing
      ? (db.prepare(`UPDATE users SET password_hash=?, role='superadmin', status='Active' WHERE id=?`)
           .run(hash, existing.id), existing.id)
      : db.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'superadmin')`)
          .run(resetEmail, hash, 'Administrator').lastInsertRowid;

    // Guarantee somewhere to land: an organization, a program in it, and Admin rights.
    let org = db.prepare(`SELECT id FROM organizations ORDER BY id ASC LIMIT 1`).get();
    if (!org) {
      const name = process.env.DEFAULT_ORG_NAME || 'Coaster';
      org = { id: db.prepare(`INSERT INTO organizations (name) VALUES (?)`).run(name).lastInsertRowid };
      db.prepare(`INSERT INTO programs (org_id, name) VALUES (?, 'Default Program')`).run(org.id);
    }
    db.prepare(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'Admin')`)
      .run(org.id, userId);

    console.warn(
      `[access] ADMIN RESET APPLIED for "${resetEmail}" (${existing ? 'password reset' : 'account created'}). ` +
      'Remove ADMIN_RESET_EMAIL and ADMIN_RESET_PASSWORD now.'
    );
  }
}

module.exports = db;
