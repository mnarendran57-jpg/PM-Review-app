const FIELD_CLASSES =
  "h-11 w-full rounded-control border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none";

function FieldWrapper({ label, error, children, hint }) {
  return (
    <label className="flex flex-col gap-1.5">
      {label && <span className="text-sm font-medium text-ink-soft">{label}</span>}
      {children}
      {hint && !error && <span className="text-xs text-ink-faint">{hint}</span>}
      {error && <span className="text-xs font-medium text-bad">{error}</span>}
    </label>
  );
}

export function TextField({ label, error, hint, className = "", ...props }) {
  return (
    <FieldWrapper label={label} error={error} hint={hint}>
      <input
        className={`${FIELD_CLASSES} ${error ? "border-bad" : ""} ${className}`}
        {...props}
      />
    </FieldWrapper>
  );
}

export function AmountField({ label, error, hint, className = "", ...props }) {
  return (
    <FieldWrapper label={label} error={error} hint={hint}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-ink-faint">
          $
        </span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          className={`${FIELD_CLASSES} pl-7 ${error ? "border-bad" : ""} ${className}`}
          {...props}
        />
      </div>
    </FieldWrapper>
  );
}

export function SelectField({ label, error, hint, className = "", children, ...props }) {
  return (
    <FieldWrapper label={label} error={error} hint={hint}>
      <select className={`${FIELD_CLASSES} ${error ? "border-bad" : ""} ${className}`} {...props}>
        {children}
      </select>
    </FieldWrapper>
  );
}

export function TextAreaField({ label, error, hint, className = "", ...props }) {
  return (
    <FieldWrapper label={label} error={error} hint={hint}>
      <textarea
        rows={2}
        className={`${FIELD_CLASSES} h-auto resize-none py-2.5 ${error ? "border-bad" : ""} ${className}`}
        {...props}
      />
    </FieldWrapper>
  );
}
