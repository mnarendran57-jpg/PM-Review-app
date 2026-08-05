// Where a submittal actually stands, worked out from its revision history rather than
// stored on the record. Status is a consequence of the dates and the A/E's answer, so
// deriving it means correcting a date can never leave a stale status behind it.

// What the A/E can come back with. The distinction that drives everything downstream is
// whether the answer ends the exchange or sends it round again.
const REVIEW_ACTIONS = [
  'Approved',
  'Approved as Noted',
  'Revise and Resubmit',
  'Rejected',
  'For Record Only',
];

// "Approved as Noted" closes the submittal: the contractor may build to it, with the A/E's
// marks incorporated. Only the two answers that demand a new package reopen it.
const CLOSING_ACTIONS = new Set(['Approved', 'Approved as Noted', 'For Record Only']);
const REOPENING_ACTIONS = new Set(['Revise and Resubmit', 'Rejected']);

const isClosing = action => CLOSING_ACTIONS.has(action);
const isReopening = action => REOPENING_ACTIONS.has(action);

// Every status the log can show, and who is holding the submittal up in each. "Ball in
// court" is the number a PM actually chases by, so it is computed here beside the status
// rather than being left for each screen to infer.
const STATUS = {
  DRAFT: { key: 'not_sent', label: 'Not yet sent to A/E', ballInCourt: 'PM' },
  WITH_AE: { key: 'with_ae', label: 'With A/E', ballInCourt: 'A/E' },
  RESUBMIT: { key: 'awaiting_resubmittal', label: 'Awaiting resubmittal', ballInCourt: 'Contractor' },
  CLOSED: { key: 'closed', label: 'Closed', ballInCourt: null },
};

const DAY = 24 * 60 * 60 * 1000;

// Dates are stored as plain YYYY-MM-DD, with no time and no zone, because that is what a
// transmittal actually records. Parsing them as UTC midnight keeps the arithmetic below
// from sliding a day either way depending on where the server happens to run.
function parseDay(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(time) ? null : time;
}

const todayUtc = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

const toIsoDay = time => new Date(time).toISOString().slice(0, 10);

// Calendar days between two dates. Whole days only — a submittal is never "3.4 days late".
const daysBetween = (from, to) => (from == null || to == null ? null : Math.round((to - from) / DAY));

// The response deadline: whatever was set explicitly, else the review window counted from
// the day it went to the A/E. Returns null when it hasn't been forwarded, since nothing is
// owed until then.
function dueDateFor(revision, reviewDays) {
  if (revision?.date_response_due) return revision.date_response_due;
  const forwarded = parseDay(revision?.date_forwarded);
  if (forwarded == null) return null;
  return toIsoDay(forwarded + reviewDays * DAY);
}

// The state of one revision. Only the newest revision decides the submittal's status, but
// every revision is summarised the same way so the history reads consistently.
function describeRevision(revision, { reviewDays = 14, today = todayUtc() } = {}) {
  const due = dueDateFor(revision, reviewDays);
  const dueTime = parseDay(due);
  const forwarded = parseDay(revision.date_forwarded);
  const returned = parseDay(revision.date_returned);
  const open = !revision.review_action;

  // How long the A/E has held it: still counting while open, frozen at the turnaround once
  // answered. Left null before it was ever sent, because zero would read as "sent today".
  const daysWithReviewer = forwarded == null ? null
    : daysBetween(forwarded, open ? today : (returned ?? today));

  // Only an unanswered revision can be overdue. Once the A/E has responded the deadline is
  // history, however late the answer was — that is what turnaround days record instead.
  const daysOverdue = open && dueTime != null && today > dueTime ? daysBetween(dueTime, today) : null;

  let status;
  if (open) status = forwarded == null ? STATUS.DRAFT : STATUS.WITH_AE;
  else status = isReopening(revision.review_action) ? STATUS.RESUBMIT : STATUS.CLOSED;

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

// Newest revision last, so the history reads top to bottom and `at(-1)` is current.
const sortRevisions = revisions =>
  [...revisions].sort((a, b) => (a.revision_number ?? 0) - (b.revision_number ?? 0));

// One log line: the submittal's identity plus the state of its newest revision. This is the
// shape the log table and the export both render, so they cannot disagree about status.
function buildLogRow(submittal, revisions, options = {}) {
  const ordered = sortRevisions(revisions).map(r => describeRevision(r, options));
  const current = ordered[ordered.length - 1] || null;

  return {
    ...submittal,
    revisions: ordered,
    revisionCount: ordered.length,
    currentRevision: current ? (current.revision_number ?? 0) : null,
    // A submittal with no revision row cannot happen through the app — one is always created
    // with it — but the log still has to render rather than crash if it ever did.
    status: current ? current.status : STATUS.DRAFT.key,
    statusLabel: current ? current.statusLabel : STATUS.DRAFT.label,
    ballInCourt: current ? current.ballInCourt : STATUS.DRAFT.ballInCourt,
    isOpen: current ? current.isOpen : true,
    isOverdue: current ? current.isOverdue : false,
    daysOverdue: current ? current.daysOverdue : null,
    daysWithReviewer: current ? current.daysWithReviewer : null,
    dueDate: current ? current.dueDate : null,
    reviewAction: current ? current.review_action : null,
    dateReceived: ordered[0]?.date_received || null,
    dateForwarded: current ? current.date_forwarded : null,
    dateReturned: current ? current.date_returned : null,
    responseNotes: current ? current.response_notes : null,
    reviewedBy: current ? current.reviewed_by : null,
  };
}

// Counts for the header. Overdue is a subset of outstanding, not a separate bucket — an
// overdue submittal is still waiting on the A/E, and adding the two would double-count it.
function summarize(rows) {
  return {
    total: rows.length,
    open: rows.filter(r => r.isOpen).length,
    withReviewer: rows.filter(r => r.status === STATUS.WITH_AE.key).length,
    overdue: rows.filter(r => r.isOverdue).length,
    awaitingResubmittal: rows.filter(r => r.status === STATUS.RESUBMIT.key).length,
    notSent: rows.filter(r => r.status === STATUS.DRAFT.key).length,
    closed: rows.filter(r => r.status === STATUS.CLOSED.key).length,
  };
}

module.exports = {
  REVIEW_ACTIONS, CLOSING_ACTIONS, REOPENING_ACTIONS, isClosing, isReopening,
  STATUS, dueDateFor, describeRevision, buildLogRow, summarize, parseDay, todayUtc, toIsoDay,
};
