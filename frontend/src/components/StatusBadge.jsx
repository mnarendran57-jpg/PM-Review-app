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
  Pending:              { bg: '#f9fafb', color: '#6b7280', dot: '#d1d5db' },
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
