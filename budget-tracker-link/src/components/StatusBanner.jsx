import { AlertTriangle, CheckCircle2, TrendingUp } from "lucide-react";
import { formatCurrency } from "../utils/calculations";
import Card from "./Card";

const CONFIG = {
  overspending: {
    icon: AlertTriangle,
    tone: "bad",
    title: "Overspending",
    message: (remaining) =>
      `You're currently spending ${formatCurrency(Math.abs(remaining))} more than you're earning this month.`,
  },
  balanced: {
    icon: CheckCircle2,
    tone: "warn",
    title: "Balanced",
    message: () => "Your budget is balanced.",
  },
  surplus: {
    icon: TrendingUp,
    tone: "good",
    title: "Surplus",
    message: (remaining) => `You have ${formatCurrency(remaining)} remaining this month.`,
  },
};

const TONE_CLASSES = {
  bad: { bg: "bg-bad-soft", text: "text-bad", icon: "bg-bad/15 text-bad" },
  warn: { bg: "bg-warn-soft", text: "text-warn", icon: "bg-warn/15 text-warn" },
  good: { bg: "bg-good-soft", text: "text-good", icon: "bg-good/15 text-good" },
};

const SUGGESTIONS = ["Add to savings", "Pay down debt", "Keep as emergency buffer"];

export default function StatusBanner({ status, remaining }) {
  const config = CONFIG[status];
  const tone = TONE_CLASSES[config.tone];
  const Icon = config.icon;

  return (
    <Card className={`${tone.bg} border-none`}>
      <div className="flex items-start gap-4">
        <span className={`grid size-11 shrink-0 place-items-center rounded-full ${tone.icon}`}>
          <Icon size={22} strokeWidth={2} />
        </span>
        <div className="flex-1 space-y-1">
          <p className={`text-lg font-semibold ${tone.text}`}>{config.title}</p>
          <p className="text-sm text-ink-soft">{config.message(remaining)}</p>
          {status === "surplus" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <span
                  key={suggestion}
                  className="rounded-full bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft"
                >
                  {suggestion}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
