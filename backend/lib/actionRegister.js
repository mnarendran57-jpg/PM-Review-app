const { parseDay, todayUtc, toIsoDay } = require('./submittalLog');

// Shapes the running register: how old each item is, how urgent, and who owes it. The date
// arithmetic is shared with the submittal and RFI logs rather than rewritten, so "overdue"
// means the same thing everywhere in the app.

const STATUSES = ['Open', 'In Progress', 'Done', 'Cancelled'];
const PRIORITIES = ['High', 'Medium', 'Low'];

// Done and Cancelled both take an item off the register — one was finished, the other was
// dropped, and neither is owed by anyone any more.
const CLOSED_STATUSES = new Set(['Done', 'Cancelled']);
const isClosed = status => CLOSED_STATUSES.has(status);

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from, to) => (from == null || to == null ? null : Math.round((to - from) / DAY));

// Anything falling due within this window is called out before it slips, rather than only
// once it already has.
const DUE_SOON_DAYS = 3;

// What the register leads with. Ranked, because the sort below turns this into the order the
// PM reads: what is late, then what is about to be, then what has been hanging around.
const URGENCY = {
  overdue: { key: 'overdue', label: 'Overdue', rank: 0 },
  due_soon: { key: 'due_soon', label: 'Due soon', rank: 1 },
  stale: { key: 'stale', label: 'No date, going stale', rank: 2 },
  open: { key: 'open', label: 'Open', rank: 3 },
  closed: { key: 'closed', label: 'Closed', rank: 4 },
};

// An item with no due date can still be a problem — most action items never get a date, and
// left alone they are the ones that quietly rot. After this long an undated open item is
// surfaced on its own merits.
const STALE_AFTER_DAYS = 14;

// The state of one action item. Everything here is derived, so editing a due date or ticking
// something done cannot leave a stale flag behind it.
function describeItem(item, { today = todayUtc() } = {}) {
  const due = parseDay(item.due_date);
  const raised = parseDay(item.raised_on || item.created_at);
  const closed = isClosed(item.status);

  const ageDays = raised == null ? null : daysBetween(raised, today);
  const daysUntilDue = due == null ? null : daysBetween(today, due);
  const daysOverdue = !closed && due != null && today > due ? daysBetween(due, today) : null;

  let urgency = URGENCY.open;
  if (closed) urgency = URGENCY.closed;
  else if (daysOverdue != null && daysOverdue > 0) urgency = URGENCY.overdue;
  else if (daysUntilDue != null && daysUntilDue <= DUE_SOON_DAYS) urgency = URGENCY.due_soon;
  else if (due == null && ageDays != null && ageDays >= STALE_AFTER_DAYS) urgency = URGENCY.stale;

  return {
    ...item,
    isClosed: closed,
    ageDays,
    daysUntilDue,
    daysOverdue,
    isOverdue: daysOverdue != null && daysOverdue > 0,
    urgency: urgency.key,
    urgencyLabel: urgency.label,
    urgencyRank: urgency.rank,
    // Having to ask twice is the clearest evidence an item is stuck, so it is surfaced
    // rather than left buried in the mention history.
    timesChased: Math.max(0, (item.mentionCount || 1) - 1),
  };
}

// Worst first: overdue before due-soon before stale, then by due date, then oldest first.
// High priority breaks ties, because two equally late items are not equally important.
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
function compareItems(a, b) {
  if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  if (a.due_date && !b.due_date) return -1;
  if (!a.due_date && b.due_date) return 1;
  return (b.ageDays ?? 0) - (a.ageDays ?? 0);
}

// The name as the minutes wrote it, reduced to something comparable. Most of the room is
// outside the organisation and will never be a Coaster record, so the name IS the identity
// here — there is no account to reconcile it against.
const personKey = name => String(name || '')
  .toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();

// The register's main view: one card per person named in the minutes, ordered by who is
// holding up the most. Grouping is by name, full stop — asking a PM to fill in a contact
// record for the architect and every sub before their actions show up is the data entry this
// tool exists to remove. An email can be attached later if one is wanted for chasing, but
// nothing waits on it.
function groupByPerson(items) {
  const groups = new Map();

  for (const item of items) {
    const key = personKey(item.assignee_name) || 'unassigned';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: item.assignee_name || 'Unassigned',
        // Enrichment only. Present when an email has been added against this name, absent
        // otherwise, and the card renders either way.
        contactId: item.contact_id || null,
        email: item.contact_email || null,
        company: item.contact_company || null,
        role: item.contact_role || null,
        items: [],
      });
    }
    const group = groups.get(key);
    // Any item carrying contact details lends them to the whole card, so adding an email once
    // lights up the person rather than the single item it was typed against.
    if (!group.email && item.contact_email) {
      group.email = item.contact_email;
      group.contactId = item.contact_id;
      group.company = group.company || item.contact_company;
      group.role = group.role || item.contact_role;
    }
    group.items.push(item);
  }

  const cards = [...groups.values()].map(group => {
    const open = group.items.filter(i => !i.isClosed);
    return {
      ...group,
      items: [...group.items].sort(compareItems),
      openCount: open.length,
      doneCount: group.items.length - open.length,
      overdueCount: open.filter(i => i.isOverdue).length,
      dueSoonCount: open.filter(i => i.urgency === 'due_soon').length,
      // What the card is ranked and coloured by.
      worstUrgency: open.length ? Math.min(...open.map(i => i.urgencyRank)) : URGENCY.closed.rank,
      oldestOpenDays: open.length ? Math.max(...open.map(i => i.ageDays ?? 0)) : null,
    };
  });

  // People with something late come first; a person with nothing outstanding sinks to the
  // bottom rather than disappearing, so the PM can still see they were assigned things.
  cards.sort((a, b) => {
    if (a.worstUrgency !== b.worstUrgency) return a.worstUrgency - b.worstUrgency;
    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return String(a.name).localeCompare(String(b.name));
  });
  return cards;
}

function summarize(items) {
  const open = items.filter(i => !i.isClosed);
  return {
    total: items.length,
    open: open.length,
    overdue: open.filter(i => i.isOverdue).length,
    dueSoon: open.filter(i => i.urgency === 'due_soon').length,
    stale: open.filter(i => i.urgency === 'stale').length,
    done: items.filter(i => i.status === 'Done').length,
    // Genuinely nobody's name against it — a real gap in the minutes worth chasing. This used
    // to mean "no contact record", which flagged almost everyone and told the PM nothing.
    unassigned: open.filter(i => !personKey(i.assignee_name)).length,
    people: new Set(open.map(i => personKey(i.assignee_name) || 'unassigned')).size,
  };
}

// A plain-text list of what one person owes, ready to paste into an email. Built here rather
// than in the page so the wording is identical whether it is copied by hand today or sent by
// the app once a mail provider is configured.
function digestFor(card, { projectName } = {}) {
  const open = card.items.filter(i => !i.isClosed);
  if (open.length === 0) return null;

  const lines = [];
  lines.push(`Hi ${String(card.name).split(' ')[0]},`);
  lines.push('');
  lines.push(
    `Here's what's currently open against your name${projectName ? ` on ${projectName}` : ''}, from our recent meetings:`
  );
  lines.push('');
  for (const item of open) {
    const bits = [];
    if (item.due_date) bits.push(`due ${item.due_date}`);
    if (item.isOverdue) bits.push(`${item.daysOverdue} day${item.daysOverdue === 1 ? '' : 's'} overdue`);
    if (item.priority === 'High') bits.push('high priority');
    if (item.timesChased > 0) bits.push(`raised again ${item.timesChased} time${item.timesChased === 1 ? '' : 's'}`);
    lines.push(`- ${item.task}${bits.length ? ` (${bits.join(', ')})` : ''}`);
    if (item.detail) lines.push(`  ${item.detail}`);
  }
  lines.push('');
  lines.push('Let me know if any of these have moved on or should come off the list.');
  return lines.join('\n');
}

module.exports = {
  STATUSES, PRIORITIES, isClosed, describeItem, compareItems, groupByPerson, summarize, personKey,
  digestFor, URGENCY, DUE_SOON_DAYS, STALE_AFTER_DAYS, todayUtc, toIsoDay,
};
