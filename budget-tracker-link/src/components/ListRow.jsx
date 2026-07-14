import { Pencil, Trash2 } from "lucide-react";

export default function ListRow({ title, subtitle, amount, meta, onEdit, onDelete }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-control px-4 py-3.5 hover:bg-surface-muted">
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{title}</p>
        {subtitle && <p className="truncate text-sm text-ink-faint">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <div className="text-right">
          <p className="font-semibold text-ink">{amount}</p>
          {meta && <p className="text-xs text-ink-faint">{meta}</p>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit"
            className="grid size-8 place-items-center rounded-full text-ink-faint hover:bg-line/60 hover:text-ink"
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete"
            className="grid size-8 place-items-center rounded-full text-ink-faint hover:bg-bad-soft hover:text-bad"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
