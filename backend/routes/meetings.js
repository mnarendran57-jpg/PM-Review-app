const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const access = require('../lib/access');
const storage = require('../lib/storage');
const email = require('../lib/email');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { extractMeeting } = require('../lib/meetingExtract');
const {
  STATUSES, PRIORITIES, isClosed, describeItem, compareItems, groupByPerson, summarize,
  digestFor, todayUtc, toIsoDay,
} = require('../lib/actionRegister');

router.use(requireOrg);
router.use(requireFeature('meeting-actions'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

const nullable = value => {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text === '' ? null : text;
};

function projectInScope(req, projectId) {
  if (!projectId) return null;
  const project = access.projectForUser(req.user, Number(projectId));
  if (!project || project.org_id !== req.orgId) return null;
  return project;
}

const visibleMeeting = req => {
  const row = db.prepare(`SELECT * FROM meetings WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row) ? row : null;
};

const visibleItem = (req, id = req.params.itemId) => {
  const row = db.prepare(`SELECT * FROM action_items WHERE id=?`).get(id);
  return access.recordVisible(req.user, row) ? row : null;
};

// Items joined to whoever they are assigned to, with the count of meetings that have raised
// each one. The mention count is what tells the register an item has had to be chased.
const ITEM_SELECT = `
  SELECT ai.*,
    tm.name AS contact_name, tm.email AS contact_email,
    tm.company AS contact_company, tm.role AS contact_role,
    m.title AS meeting_title, m.meeting_date AS raised_on,
    (SELECT COUNT(*) FROM action_item_mentions am WHERE am.action_item_id = ai.id) AS mentionCount
  FROM action_items ai
  LEFT JOIN team_members tm ON tm.id = ai.contact_id
  LEFT JOIN meetings m ON m.id = ai.meeting_id
`;

function loadItems(req, { projectId, meetingId } = {}) {
  const scope = access.visibilityClause(req.user, req.orgId, { alias: 'ai' });
  let sql = `${ITEM_SELECT} WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (projectId) { sql += ' AND ai.project_id = ?'; params.push(projectId); }
  if (meetingId) {
    // Items this meeting raised OR chased, which is what "the actions from this meeting"
    // means to a PM — not only the ones that happened to originate there.
    sql += ' AND (ai.meeting_id = ? OR EXISTS (SELECT 1 FROM action_item_mentions am WHERE am.action_item_id = ai.id AND am.meeting_id = ?))';
    params.push(meetingId, meetingId);
  }
  const today = todayUtc();
  return db.prepare(sql).all(...params).map(row => describeItem(row, { today }));
}

// --- Contacts -------------------------------------------------------------------------------
// The people actions get assigned to. Deliberately not app users: the architect and the GC's
// superintendent are the ones being chased, and they will never sign in here.

router.get('/contacts', (req, res) => {
  const contacts = db.prepare(
    `SELECT id, name, role, email, company FROM team_members WHERE org_id=? ORDER BY name ASC`
  ).all(req.orgId);
  const aliases = db.prepare(`SELECT alias, contact_id FROM contact_aliases WHERE org_id=?`).all(req.orgId);
  res.json({ contacts, aliases });
});

router.post('/contacts', (req, res) => {
  const name = nullable(req.body.name);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const result = db.prepare(
    `INSERT INTO team_members (org_id, name, role, email, company) VALUES (?, ?, ?, ?, ?)`
  ).run(req.orgId, name, nullable(req.body.role), nullable(req.body.email), nullable(req.body.company));
  res.json(db.prepare(`SELECT id, name, role, email, company FROM team_members WHERE id=?`).get(result.lastInsertRowid));
});

router.patch('/contacts/:contactId', (req, res) => {
  const row = db.prepare(`SELECT * FROM team_members WHERE id=? AND org_id=?`).get(req.params.contactId, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const keep = (key, current) => (key in req.body ? nullable(req.body[key]) : current);
  db.prepare(`UPDATE team_members SET name=?, role=?, email=?, company=? WHERE id=?`).run(
    nullable(req.body.name) ?? row.name, keep('role', row.role),
    keep('email', row.email), keep('company', row.company), row.id
  );
  res.json(db.prepare(`SELECT id, name, role, email, company FROM team_members WHERE id=?`).get(row.id));
});

// Teaches the register that a name in the minutes is a particular person, and applies it to
// everything already logged under that name. Doing both at once is the point: matching a name
// should fix the history, not only future meetings.
function linkAlias({ orgId, alias, contactId }) {
  const key = String(alias || '').trim().toLowerCase();
  if (!key) return 0;
  db.prepare(
    `INSERT INTO contact_aliases (org_id, alias, contact_id) VALUES (?, ?, ?)
     ON CONFLICT (org_id, alias) DO UPDATE SET contact_id = excluded.contact_id`
  ).run(orgId, key, contactId);
  return db.prepare(
    `UPDATE action_items SET contact_id=?, updated_at=datetime('now')
     WHERE org_id=? AND lower(trim(assignee_name))=?`
  ).run(contactId, orgId, key).changes;
}

// Attaches an email to a name from the minutes, so that person can be chased. This is the
// whole of "contacts" as far as the PM is concerned: one field, typed once, optional.
// Everything underneath — finding or creating the record, recording the alias, relinking the
// items already logged under that name — happens here rather than being asked about.
router.post('/register/person-email', (req, res) => {
  const name = nullable(req.body.name);
  const address = nullable(req.body.email);
  if (!name) return res.status(400).json({ error: 'Which person?' });

  const existing = db.prepare(
    `SELECT * FROM team_members WHERE org_id=? AND lower(trim(name))=lower(trim(?))`
  ).get(req.orgId, name);

  const contactId = existing
    ? (db.prepare(`UPDATE team_members SET email=?, company=COALESCE(?, company) WHERE id=?`)
        .run(address, nullable(req.body.company), existing.id), existing.id)
    : db.prepare(`INSERT INTO team_members (org_id, name, email, company) VALUES (?, ?, ?, ?)`)
        .run(req.orgId, name, address, nullable(req.body.company)).lastInsertRowid;

  const relinked = linkAlias({ orgId: req.orgId, alias: name, contactId });
  res.json({ success: true, contactId, email: address, itemsLinked: relinked });
});

router.post('/contacts/:contactId/aliases', (req, res) => {
  const contact = db.prepare(`SELECT id FROM team_members WHERE id=? AND org_id=?`).get(req.params.contactId, req.orgId);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const alias = nullable(req.body.alias);
  if (!alias) return res.status(400).json({ error: 'A name is required.' });
  const updated = linkAlias({ orgId: req.orgId, alias, contactId: contact.id });
  res.json({ success: true, itemsRelinked: updated });
});

const aliasLookup = orgId => {
  const map = new Map();
  for (const row of db.prepare(`SELECT alias, contact_id FROM contact_aliases WHERE org_id=?`).all(orgId)) {
    map.set(row.alias, row.contact_id);
  }
  // A contact's own name always resolves, without the PM having to record it as an alias.
  for (const row of db.prepare(`SELECT id, name FROM team_members WHERE org_id=?`).all(orgId)) {
    const key = String(row.name || '').trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, row.id);
  }
  return map;
};

// --- The register -----------------------------------------------------------------------------

router.get('/register', (req, res) => {
  const items = loadItems(req, { projectId: req.query.project_id, meetingId: req.query.meeting_id });
  // Carries everything both the meeting filter and the meetings table need. They are fed from
  // one query rather than two so the table cannot end up showing blanks for columns the
  // filter never asked for.
  const meetings = req.query.project_id
    ? db.prepare(`
        SELECT id, title, meeting_date, created_by, created_at,
          (SELECT COUNT(*) FROM action_item_mentions am WHERE am.meeting_id = meetings.id) AS action_count
        FROM meetings WHERE project_id=? ORDER BY COALESCE(meeting_date, created_at) DESC
      `).all(req.query.project_id)
    : [];
  res.json({
    people: groupByPerson(items),
    items: [...items].sort(compareItems),
    summary: summarize(items),
    meetings,
    statuses: STATUSES,
    priorities: PRIORITIES,
    // The page shows a "copy this and send it" button rather than a send button until a mail
    // provider is configured, so it says plainly which one it is offering.
    emailConfigured: email.isConfigured(),
  });
});

// What to send one person, built on the server so the wording is the same whether it is
// copied by hand today or sent by the app once email is configured.
router.get('/register/digest', (req, res) => {
  const items = loadItems(req, { projectId: req.query.project_id });
  const project = req.query.project_id
    ? db.prepare(`SELECT project_name FROM projects WHERE id=?`).get(req.query.project_id)
    : null;
  const cards = groupByPerson(items)
    .map(card => ({
      key: card.key, name: card.name, email: card.email, openCount: card.openCount,
      overdueCount: card.overdueCount,
      digest: digestFor(card, { projectName: project?.project_name }),
    }))
    .filter(c => c.digest);
  res.json({ digests: cards, emailConfigured: email.isConfigured() });
});

const CSV_COLUMNS = [
  ['Assigned To', i => i.contact_name || i.assignee_name],
  ['Company', i => i.contact_company],
  ['Email', i => i.contact_email],
  ['Task', i => i.task],
  ['Detail', i => i.detail],
  ['Status', i => i.status],
  ['Priority', i => i.priority],
  ['Due', i => i.due_date],
  ['Days Overdue', i => i.daysOverdue],
  ['Raised In', i => i.meeting_title],
  ['Raised On', i => i.raised_on],
  ['Days Open', i => i.ageDays],
  ['Times Chased', i => i.timesChased],
];

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

router.get('/register/export.csv', (req, res) => {
  const items = loadItems(req, { projectId: req.query.project_id }).sort(compareItems);
  const lines = [CSV_COLUMNS.map(([label]) => csvCell(label)).join(',')];
  for (const item of items) lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(item))).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Action_Items.csv"');
  res.send(`﻿${lines.join('\r\n')}`);
});

// --- Reading a set of minutes -------------------------------------------------------------------

// Reads the minutes and returns a draft for the PM to confirm. Nothing is saved: the register
// is the project's record of who owes what, and a model's first pass should not write to it
// unreviewed.
router.post('/extract', upload.single('file'), async (req, res) => {
  try {
    const project = projectInScope(req, req.body.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const text = nullable(req.body.text);
    if (!req.file && !text) {
      return res.status(400).json({ error: 'Upload the minutes or paste them in.' });
    }

    const openItems = db.prepare(
      `SELECT id, task, assignee_name, due_date FROM action_items
       WHERE project_id=? AND status NOT IN ('Done', 'Cancelled') ORDER BY created_at ASC`
    ).all(project.id);

    // Everyone already named on this project. Sent with the extraction so a person written
    // two ways across meetings lands on one card, without the PM reconciling anything.
    const knownNames = db.prepare(
      `SELECT DISTINCT assignee_name FROM action_items
       WHERE project_id=? AND assignee_name IS NOT NULL AND TRIM(assignee_name) <> ''
       ORDER BY assignee_name ASC`
    ).all(project.id).map(r => r.assignee_name);

    const draft = await extractMeeting({
      buffer: req.file?.buffer,
      mimeType: req.file?.mimetype,
      text,
      openItems,
      knownNames,
      today: toIsoDay(todayUtc()),
      projectName: project.project_name,
    });

    // An email already recorded against a name carries over silently. Nothing is required —
    // the name alone is enough for the item to appear on the register.
    const known = aliasLookup(req.orgId);
    const items = draft.actionItems.map(item => ({
      ...item,
      contactId: known.get(String(item.assigneeName || '').trim().toLowerCase()) || null,
    }));

    res.json({ ...draft, actionItems: items, knownNames });
  } catch (err) {
    console.error('Meeting extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// Saves the confirmed minutes and folds their action items into the register. Items the PM
// marked as follow-ups attach to the existing entry as a mention rather than creating a
// second copy of the same job.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const project = projectInScope(req, req.body.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let payload = req.body.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Nothing to save — the confirmed minutes were missing.' });
    }

    const meeting = db.prepare(`
      INSERT INTO meetings (org_id, project_id, title, meeting_date, attendees, summary,
        decisions, file_name, mime_type, file_key, file_blob, source_text, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let key = null;
    if (req.file) {
      ({ key } = await storage.storeFile('meetings', req.file.buffer, req.file.mimetype, req.file.originalname));
    }

    const meetingId = meeting.run(
      req.orgId, project.id,
      nullable(payload.title) || 'Project Meeting',
      nullable(payload.meetingDate),
      JSON.stringify(payload.attendees || []),
      nullable(payload.summary),
      JSON.stringify(payload.decisions || []),
      req.file?.originalname || null,
      req.file?.mimetype || null,
      key,
      req.file && !key ? req.file.buffer : null,
      nullable(req.body.text),
      req.user.name || req.user.email
    ).lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO action_items (org_id, project_id, meeting_id, assignee_name, contact_id,
        task, detail, due_date, priority, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const mention = db.prepare(
      `INSERT OR IGNORE INTO action_item_mentions (action_item_id, meeting_id, note) VALUES (?, ?, ?)`
    );

    const aliases = aliasLookup(req.orgId);
    let created = 0, chased = 0, closed = 0;

    for (const raw of Array.isArray(payload.actionItems) ? payload.actionItems : []) {
      const task = nullable(raw.task);
      if (!task) continue;

      const assigneeName = nullable(raw.assigneeName);
      const contactId = Number(raw.contactId) || aliases.get(String(assigneeName || '').toLowerCase()) || null;
      const priority = PRIORITIES.includes(raw.priority) ? raw.priority : 'Medium';

      // A follow-up updates the item already on the register and records that this meeting
      // had to raise it again — the count of those is what exposes a stuck item.
      const followUpId = Number(raw.followUpOfId) || null;
      const existing = followUpId
        ? db.prepare(`SELECT * FROM action_items WHERE id=? AND project_id=?`).get(followUpId, project.id)
        : null;

      if (existing) {
        mention.run(existing.id, meetingId, task);
        chased++;
        if (raw.isNowComplete) {
          db.prepare(
            `UPDATE action_items SET status='Done', completed_at=?, updated_at=datetime('now') WHERE id=?`
          ).run(nullable(payload.meetingDate) || toIsoDay(todayUtc()), existing.id);
          closed++;
        } else {
          // A chase can move the deadline or the owner, but never blanks what is on file.
          db.prepare(`
            UPDATE action_items SET due_date=COALESCE(?, due_date), priority=?,
              contact_id=COALESCE(?, contact_id), updated_at=datetime('now')
            WHERE id=?
          `).run(nullable(raw.dueDate), priority, contactId, existing.id);
        }
        continue;
      }

      const status = raw.isNowComplete ? 'Done' : (STATUSES.includes(raw.status) ? raw.status : 'Open');
      const itemId = insertItem.run(
        req.orgId, project.id, meetingId, assigneeName, contactId, task,
        nullable(raw.detail), nullable(raw.dueDate), priority, status,
        req.user.name || req.user.email
      ).lastInsertRowid;
      mention.run(itemId, meetingId, null);
      created++;
      if (status === 'Done') closed++;
    }

    res.json({
      id: meetingId, created, chased, closed,
      register: {
        people: groupByPerson(loadItems(req, { projectId: project.id })),
        summary: summarize(loadItems(req, { projectId: project.id })),
      },
    });
  } catch (err) {
    console.error('Meeting save error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const scope = access.visibilityClause(req.user, req.orgId);
  let sql = `
    SELECT id, project_id, title, meeting_date, summary, file_name, created_by, created_at,
      (SELECT COUNT(*) FROM action_item_mentions am WHERE am.meeting_id = meetings.id) AS action_count
    FROM meetings WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (req.query.project_id) { sql += ' AND project_id = ?'; params.push(req.query.project_id); }
  sql += ` ORDER BY COALESCE(meeting_date, created_at) DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const row = visibleMeeting(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    file_blob: undefined,
    attendees: JSON.parse(row.attendees || '[]'),
    decisions: JSON.parse(row.decisions || '[]'),
    items: loadItems(req, { meetingId: row.id }).sort(compareItems),
  });
});

router.get('/:id/file', async (req, res) => {
  const row = visibleMeeting(req);
  if (!row || !(row.file_key || row.file_blob)) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
  res.send(bytes);
});

// Removing a meeting keeps its action items: the work was still agreed, and deleting a badly
// scanned upload should not quietly wipe the register. They lose their "raised in" link only.
router.delete('/:id', async (req, res) => {
  const row = visibleMeeting(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM meetings WHERE id=?`).run(row.id);
  if (row.file_key) await storage.remove([row.file_key]);
  res.json({ success: true });
});

// --- Individual action items ----------------------------------------------------------------

router.post('/items', (req, res) => {
  const project = projectInScope(req, req.body.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const task = nullable(req.body.task);
  if (!task) return res.status(400).json({ error: 'Describe what needs doing.' });

  const assigneeName = nullable(req.body.assignee_name);
  const contactId = Number(req.body.contact_id)
    || aliasLookup(req.orgId).get(String(assigneeName || '').toLowerCase()) || null;

  const id = db.prepare(`
    INSERT INTO action_items (org_id, project_id, assignee_name, contact_id, task, detail,
      due_date, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?)
  `).run(
    req.orgId, project.id, assigneeName, contactId, task, nullable(req.body.detail),
    nullable(req.body.due_date),
    PRIORITIES.includes(req.body.priority) ? req.body.priority : 'Medium',
    req.user.name || req.user.email
  ).lastInsertRowid;

  res.json(describeItem(db.prepare(`${ITEM_SELECT} WHERE ai.id=?`).get(id), { today: todayUtc() }));
});

router.patch('/items/:itemId', (req, res) => {
  const row = visibleItem(req);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const keep = (key, current) => (key in req.body ? nullable(req.body[key]) : current);
  const status = STATUSES.includes(req.body.status) ? req.body.status : row.status;
  // Completion is stamped when an item first closes and cleared if it is reopened, so the
  // date always reflects the state it sits in.
  const completedAt = isClosed(status)
    ? (row.completed_at || toIsoDay(todayUtc()))
    : null;

  db.prepare(`
    UPDATE action_items SET assignee_name=?, contact_id=?, task=?, detail=?, due_date=?,
      priority=?, status=?, completed_at=?, notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    keep('assignee_name', row.assignee_name),
    'contact_id' in req.body ? (Number(req.body.contact_id) || null) : row.contact_id,
    nullable(req.body.task) ?? row.task,
    keep('detail', row.detail),
    keep('due_date', row.due_date),
    PRIORITIES.includes(req.body.priority) ? req.body.priority : row.priority,
    status, completedAt, keep('notes', row.notes), row.id
  );

  res.json(describeItem(db.prepare(`${ITEM_SELECT} WHERE ai.id=?`).get(row.id), { today: todayUtc() }));
});

router.delete('/items/:itemId', (req, res) => {
  const row = visibleItem(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM action_items WHERE id=?`).run(row.id);
  res.json({ success: true });
});

module.exports = router;
