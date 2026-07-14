const TONE_BAR = {
  brand: "bg-brand",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
};

export default function ProgressBar({ ratio, tone = "brand", trackClassName = "" }) {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return (
    <div
      className={`h-2.5 w-full overflow-hidden rounded-full bg-surface-muted ${trackClassName}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ease-out ${TONE_BAR[tone] ?? TONE_BAR.brand}`}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}
