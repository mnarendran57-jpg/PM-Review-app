// A tick list of the project's Shared Documents — the agreements, RFIs and ASIs a review is checked
// against. `type="radio"` when only one may be chosen.
export default function DocList({ docs, selectedIds, onToggle, type = 'checkbox' }) {
  if (docs === null) return <p className="text-xs text-gray-400">Loading shared documents…</p>;
  // Nothing filed: nothing to show. The upload beneath is the way in, and saying "nothing is filed —
  // upload one below" above an "or upload one" said it twice.
  if (docs.length === 0) return null;
  return (
    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
      {docs.map(d => (
        <label key={d.id} className="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors"
          style={{ background: selectedIds.includes(String(d.id)) ? '#eff6ff' : '#fafbfc' }}>
          <input type={type} className="mt-0.5" checked={selectedIds.includes(String(d.id))} onChange={() => onToggle(String(d.id))} />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-gray-800 truncate">{d.label || d.file_name}</span>
            <span className="block text-[10px] text-gray-400">
              {d.is_primary ? 'Project default · ' : ''}{d.file_name}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
