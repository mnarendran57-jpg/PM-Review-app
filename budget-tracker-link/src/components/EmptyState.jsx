export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line py-14 text-center">
      {Icon && (
        <span className="grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
          <Icon size={22} strokeWidth={2} />
        </span>
      )}
      <div className="space-y-1">
        <p className="font-medium text-ink">{title}</p>
        {description && <p className="text-sm text-ink-faint">{description}</p>}
      </div>
      {action}
    </div>
  );
}
