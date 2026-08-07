const styles = {
  // Status
  Open:                 { bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
  Answered:             { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  Closed:               { bg: '#f9fafb', color: '#6b7280', dot: '#d1d5db' },
  'On Hold':            { bg: '#fefce8', color: '#a16207', dot: '#eab308' },
  // Submittal actions
  Approved:             { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  'Approved as Noted':  { bg: '#f0fdfa', color: '#0f766e', dot: '#14b8a6' },
  'Revise and Resubmit':{ bg: '#fff7ed', color: '#c2410c', dot: '#f97316' },
  Rejected:             { bg: '#fef2f2', color: '#b91c1c', dot: '#ef4444' },
  'For Record Only':    { bg: '#f9fafb', color: '#6b7280', dot: '#9ca3af' },
  Pending:              { bg: '#f9fafb', color: '#6b7280', dot: '#d1d5db' },
  // Submittal log status — where the submittal stands, as opposed to what the A/E said.
  // Coloured by who is holding it up: grey for us, blue for the A/E, amber for the
  // contractor, red once the A/E is past the deadline.
  'Not yet sent to A/E':  { bg: '#f9fafb', color: '#6b7280', dot: '#9ca3af' },
  'With A/E':             { bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
  Overdue:                { bg: '#fef2f2', color: '#b91c1c', dot: '#ef4444' },
  'Awaiting resubmittal': { bg: '#fff7ed', color: '#c2410c', dot: '#f97316' },
  // RFI dispositions and the one status the RFI log adds. Same colour language: green
  // closes it, amber puts the ball back with the contractor, grey is inert.
  // ("Answered" itself is already defined above, under Status.)
  'Answered with Conditions': { bg: '#f0fdfa', color: '#0f766e', dot: '#14b8a6' },
  'Needs More Information': { bg: '#fff7ed', color: '#c2410c', dot: '#f97316' },
  'Void / Withdrawn':       { bg: '#f9fafb', color: '#6b7280', dot: '#9ca3af' },
  'Awaiting contractor clarification': { bg: '#fff7ed', color: '#c2410c', dot: '#f97316' },
  // Finance
  Received:             { bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
  'Under Review':       { bg: '#fefce8', color: '#a16207', dot: '#eab308' },
  'Sent to Client':     { bg: '#faf5ff', color: '#7e22ce', dot: '#a855f7' },
  Paid:                 { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  Submitted:            { bg: '#faf5ff', color: '#7e22ce', dot: '#a855f7' },
  // Project
  Active:               { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  // Priority
  High:                 { bg: '#fef2f2', color: '#b91c1c', dot: '#ef4444' },
  Medium:               { bg: '#fff7ed', color: '#c2410c', dot: '#f97316' },
  Low:                  { bg: '#f9fafb', color: '#6b7280', dot: '#d1d5db' },
};

const fallback = { bg: '#f9fafb', color: '#6b7280', dot: '#d1d5db' };

export default function StatusBadge({ status }) {
  const s = styles[status] || fallback;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.dot }} />
      {status}
    </span>
  );
}
