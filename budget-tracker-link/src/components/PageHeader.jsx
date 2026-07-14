import { Plus } from "lucide-react";
import Button from "./Button";

export default function PageHeader({ title, subtitle, onAdd, addLabel = "Add" }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {onAdd && (
        <Button onClick={onAdd} size="sm">
          <Plus size={16} /> {addLabel}
        </Button>
      )}
    </div>
  );
}
