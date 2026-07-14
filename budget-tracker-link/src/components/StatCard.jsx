import Card from "./Card";

const TONE_STYLES = {
  neutral: { icon: "bg-brand-soft text-brand" },
  good: { icon: "bg-good-soft text-good" },
  warn: { icon: "bg-warn-soft text-warn" },
  bad: { icon: "bg-bad-soft text-bad" },
};

export default function StatCard({ label, value, subtext, icon: Icon, tone = "neutral" }) {
  const toneStyle = TONE_STYLES[tone] ?? TONE_STYLES.neutral;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-soft">{label}</span>
        {Icon && (
          <span className={`grid size-9 place-items-center rounded-full ${toneStyle.icon}`}>
            <Icon size={18} strokeWidth={2} />
          </span>
        )}
      </div>
      <div className="text-3xl font-semibold tracking-tight text-ink">{value}</div>
      {subtext && <div className="text-sm text-ink-faint">{subtext}</div>}
    </Card>
  );
}
