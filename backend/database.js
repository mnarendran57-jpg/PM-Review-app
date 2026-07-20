const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'pm_review.db'));

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
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

  CREATE TABLE IF NOT EXISTS rfis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfi_number TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    submitted_by TEXT,
    submitted_to TEXT,
    date_submitted TEXT,
    date_response_due TEXT,
    date_responded TEXT,
    status TEXT DEFAULT 'Open',
    priority TEXT DEFAULT 'Medium',
    description TEXT,
    response TEXT,
    linked_document TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS submittals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submittal_number TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    spec_section TEXT,
    description TEXT NOT NULL,
    submitted_by TEXT,
    date_received TEXT,
    date_forwarded TEXT,
    date_response_due TEXT,
    date_returned TEXT,
    review_action TEXT DEFAULT 'Pending',
    revision_number INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

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
`);

// Migrations — add columns that may not exist in older databases
const projectCols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
if (!projectCols.includes('project_type_other')) {
  db.exec(`ALTER TABLE projects ADD COLUMN project_type_other TEXT`);
}

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

module.exports = db;
