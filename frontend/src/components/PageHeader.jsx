const ACCENTS = {
  amber: { bg: 'linear-gradient(135deg, #f59e0b, #f97316)', glow: 'rgba(245,158,11,0.4)', text: 'linear-gradient(135deg, #d97706, #ea580c)' },
  blue: { bg: 'linear-gradient(135deg, #3b82f6, #6366f1)', glow: 'rgba(59,130,246,0.4)', text: 'linear-gradient(135deg, #2563eb, #4f46e5)' },
  emerald: { bg: 'linear-gradient(135deg, #10b981, #059669)', glow: 'rgba(16,185,129,0.4)', text: 'linear-gradient(135deg, #059669, #047857)' },
  teal: { bg: 'linear-gradient(135deg, #14b8a6, #0891b2)', glow: 'rgba(20,184,166,0.4)', text: 'linear-gradient(135deg, #0d9488, #0e7490)' },
};

export default function PageHeader({ title, subtitle, actions, icon: Icon, accent = 'amber' }) {
  const colors = ACCENTS[accent] || ACCENTS.amber;
  return (
    <div className="flex items-start justify-between mb-8 animate-fade-up">
      <div className="flex items-center gap-4">
        {Icon && (
          <div
            className="icon-badge w-12 h-12"
            style={{ '--icon-bg': colors.bg, '--icon-glow': colors.glow }}
          >
            <Icon className="w-6 h-6" />
          </div>
        )}
        <div>
          <h1
            className="text-[26px] font-extrabold tracking-tight text-gradient"
            style={{ '--text-gradient': colors.text }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-gray-500 mt-1 font-medium">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-shrink-0 ml-4">{actions}</div>
      )}
    </div>
  );
}
