const VARIANTS = {
  primary: "bg-brand text-white hover:bg-brand/90 shadow-sm",
  secondary: "bg-surface-muted text-ink hover:bg-line/60",
  danger: "bg-bad-soft text-bad hover:bg-bad/15",
  ghost: "text-ink-soft hover:bg-surface-muted",
};

const SIZES = {
  md: "h-11 px-5 text-sm",
  sm: "h-9 px-4 text-sm",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
