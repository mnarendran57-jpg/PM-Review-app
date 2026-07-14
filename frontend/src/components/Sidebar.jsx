import { NavLink, useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon, ArrowRightOnRectangleIcon, DocumentMagnifyingGlassIcon,
  ClipboardDocumentCheckIcon, Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { authApi } from '../api';

// Other modules (Projects, Document Review, RFI Tracker, Submittals, Pay Apps & Invoices,
// Team & Settings) are intentionally hidden from navigation — only Home, Proposal Intake,
// Pay App Review, and Pre-Construction Document Review are live for now. Their page/route
// files are left untouched on disk for reuse later.
const nav = [
  { to: '/home', label: 'Home', icon: Squares2X2Icon, color: '#a78bfa', glow: 'rgba(167,139,250,0.18)' },
  { to: '/proposal-intake', label: 'Proposal Intake', icon: InboxArrowDownIcon, color: '#fbbf24', glow: 'rgba(245,158,11,0.16)' },
  { to: '/pay-app-review', label: 'Pay App Review', icon: DocumentMagnifyingGlassIcon, color: '#60a5fa', glow: 'rgba(59,130,246,0.16)' },
  { to: '/precon-review', label: 'Pre-Construction Review', icon: ClipboardDocumentCheckIcon, color: '#34d399', glow: 'rgba(16,185,129,0.16)' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const handleLogout = () => {
    authApi.logout();
    navigate('/login', { replace: true });
  };
  return (
    <aside className="fixed inset-y-0 left-0 w-[220px] flex flex-col z-30"
      style={{ background: 'linear-gradient(180deg, #0d1117 0%, #111827 100%)', boxShadow: '4px 0 24px rgba(0,0,0,0.12)' }}>

      {/* Wordmark */}
      <div className="h-[64px] flex items-center px-5 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)', boxShadow: '0 2px 10px rgba(245,158,11,0.5)' }}>
            <span className="text-white font-black text-sm tracking-tight">O</span>
          </div>
          <div>
            <p className="text-white font-bold text-[13px] leading-tight tracking-tight">Olivier Inc.</p>
            <p className="text-[10px] font-medium tracking-widest uppercase"
              style={{ color: 'rgba(255,255,255,0.35)' }}>PM Review</p>
          </div>
        </div>
      </div>

      {/* Nav label */}
      <div className="px-5 pt-6 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: 'rgba(255,255,255,0.25)' }}>Navigation</span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto pb-4">
        {nav.map(({ to, label, icon: Icon, color, glow }) => (
          <NavLink
            key={to}
            to={to}
            className="group flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium
               transition-all duration-200 relative"
            style={({ isActive }) => isActive ? {
              background: glow,
              color: '#fff',
              boxShadow: `inset 0 0 0 1px ${glow}`,
            } : {
              color: 'rgba(255,255,255,0.55)',
            }}
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full"
                    style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
                )}
                <span
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform duration-200 group-hover:scale-110"
                  style={{ background: isActive ? color : 'rgba(255,255,255,0.06)', color: isActive ? '#0d1117' : 'rgba(255,255,255,0.6)' }}
                >
                  <Icon className="w-4 h-4" strokeWidth={isActive ? 2.25 : 1.75} />
                </span>
                <span className="leading-none">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 flex-shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
              style={{ background: 'rgba(255,255,255,0.1)' }}>M</div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium truncate" style={{ color: 'rgba(255,255,255,0.6)' }}>MEP Construction</p>
              <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>Internal · v1.0</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            title="Log out"
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
            style={{ color: 'rgba(255,255,255,0.4)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
          >
            <ArrowRightOnRectangleIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
