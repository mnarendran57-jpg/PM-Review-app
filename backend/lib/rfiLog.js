const {
  parseDay, todayUtc, toIsoDay, dueDateFor,
} = require('./submittalLog');

// Where an RFI stands, derived from its revision history rather than stored — the same rule
// the submittal log follows, so correcting a date can never leave a stale status behind.
// The date arithmetic itself is shared with submittalLog rather than copied: two versions of
// "is this overdue" would eventually disagree, and the log would contradict itself.

// What the A/E can come back with. As with submittals, the distinction that matters is
// whether the answer ends the exchange or sends it round again.
const RESPONSE_ACTIONS = [
  'Answered',
  'Answered with Conditions',
  'Needs More Information',
  'Void / Withdrawn',
];

// "Void / Withdrawn" closes the RFI: the question is no longer live, whether or not it was
// ever answered. Only a request for more information puts the ball back with the contractor.
const CLOSING_ACTIONS = new Set(['Answered', 'Answered with Conditions', 'Void / Withdrawn']);
const REOPENING_ACTIONS = new Set(['Needs More Information']);

const isClosing = action => CLOSING_ACTIONS.has(action);
const isReopening = action => REOPENING_ACTIONS.has(action);

// The trades an RFI can be asking about. The chosen one steers the analysis at the right
// drawings — a mechanical question read against architectural sheets yields a confident,
// useless answer. "Contract" covers commercial questions that no drawing answers.
const DISCIPLINES = [
  'Architectural',
  'Electrical',
  'Mechanical',
  'Plumbing',
  'Contract',
  'Miscellaneous',
];

// Which drawing sheets a discipline lives on. Used to steer the sheet picker rather than to
// filter for it: the prefixes are the common CSI/AIA convention, but sets do vary, so this is
// a hint in the prompt and never a hard exclusion.
const DISCIPLINE_SHEET_HINTS = {
  Architectural: 'A (architectural), and sometimes G (general) or ID (interiors)',
  Electrical: 'E (electrical), and sometimes T/LV for low voltage or telecom',
  Mechanical: 'M (mechanical/HVAC), and sometimes H',
  Plumbing: 'P (plumbing), and sometimes FP for fire protection',
  Contract: 'no drawing prefix — this is answered from the agreement, specifications or general conditions',
  Miscellaneous: 'any prefix — decide from the question itself',
};

const STATUS = {
  DRAFT: { key: 'not_sent', label: 'Not yet sent to A/E', ballInCourt: 'PM' },
  WITH_AE: { key: 'with_ae', label: 'With A/E', ballInCourt: 'A/E' },
  CLARIFY: { key: 'awaiting_clarification', label: 'Awaiting contractor clarification', ballInCourt: 'Contractor' },
  CLOSED: { key: 'closed', label: 'Closed', ballInCourt: null },
};

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from, to) => (from == null || to == null ? null : Math.round((to - from) / DAY));

// The state of one round trip. Mirrors describeRevision() in submittalLog, differing only in
// which answers close the exchange.
function describeRevision(revision, { reviewDays = 10, today = todayUtc() } = {}) {
  const due = dueDateFor(revision, reviewDays);
  const dueTime = parseDay(due);
  const forwarded = parseDay(revision.date_forwarded);
  const returned = parseDay(revision.date_returned);
  const open = !revision.response_action;

  const daysWithReviewer = forwarded == null ? null
    : daysBetween(forwarded, open ? today : (returned ?? today));
  const daysOverdue = open && dueTime != null && today > dueTime ? daysBetween(dueTime, today) : null;

  let status;
  if (open) status = forwarded == null ? STATUS.DRAFT : STATUS.WITH_AE;
  else status = isReopening(revision.response_action) ? STATUS.CLARIFY : STATUS.CLOSED;

  return {
    ...revision,
    dueDate: due,
    isOpen: open,
    daysWithReviewer,
    daysOverdue,
    isOverdue: daysOverdue != null && daysOverdue > 0,
    status: status.key,
    statusLabel: status.label,
    ballInCourt: status.ballInCourt,
  };
}

const sortRevisions = revisions =>
  [...revisions].sort((a, b) => (a.revision_number ?? 0) - (b.revision_number ?? 0));

function buildLogRow(rfi, revisions, options = {}) {
  const ordered = sortRevisions(revisions).map(r => describeRevision(r, options));
  const current = ordered[ordered.length - 1] || null;

  return {
    ...rfi,
    revisions: ordered,
    revisionCount: ordered.length,
    currentRevision: current ? (current.revision_number ?? 0) : null,
    status: current ? current.status : STATUS.DRAFT.key,
    statusLabel: current ? current.statusLabel : STATUS.DRAFT.label,
    ballInCourt: current ? current.ballInCourt : STATUS.DRAFT.ballInCourt,
    isOpen: current ? current.isOpen : true,
    isOverdue: current ? current.isOverdue : false,
    daysOverdue: current ? current.daysOverdue : null,
    daysWithReviewer: current ? current.daysWithReviewer : null,
    dueDate: current ? current.dueDate : null,
    responseAction: current ? current.response_action : null,
    dateReceived: ordered[0]?.date_received || null,
    dateForwarded: current ? current.date_forwarded : null,
    dateReturned: current ? current.date_returned : null,
    responseNotes: current ? current.response_notes : null,
    respondedBy: current ? current.responded_by : null,
  };
}

// Overdue is a subset of outstanding, not a separate bucket — adding the two would
// double-count an RFI the A/E is late on.
function summarize(rows) {
  return {
    total: rows.length,
    open: rows.filter(r => r.isOpen).length,
    withReviewer: rows.filter(r => r.status === STATUS.WITH_AE.key).length,
    overdue: rows.filter(r => r.isOverdue).length,
    awaitingClarification: rows.filter(r => r.status === STATUS.CLARIFY.key).length,
    notSent: rows.filter(r => r.status === STATUS.DRAFT.key).length,
    closed: rows.filter(r => r.status === STATUS.CLOSED.key).length,
  };
}

module.exports = {
  RESPONSE_ACTIONS, CLOSING_ACTIONS, REOPENING_ACTIONS, isClosing, isReopening,
  DISCIPLINES, DISCIPLINE_SHEET_HINTS, STATUS,
  describeRevision, buildLogRow, summarize, dueDateFor, todayUtc, toIsoDay, parseDay,
};
