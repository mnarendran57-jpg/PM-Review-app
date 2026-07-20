import { NavLink, useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon, ArrowRightOnRectangleIcon, DocumentMagnifyingGlassIcon,
  ClipboardDocumentCheckIcon, Squares2X2Icon, ScaleIcon, ArrowLeftIcon,
  Cog6ToothIcon, EnvelopeIcon, FolderIcon, ReceiptPercentIcon,
} from '@heroicons/react/24/outline';
import { authApi } from '../api';
import { useProject } from '../context/ProjectContext';

// The tools that operate on a single project. Their routes are built relative to the
// active project (/project/:id/...) so they always carry the project context with them.
const projectTools = [
  { slug: 'proposal-intake', label: 'Proposal Intake', icon: InboxArrowDownIcon, color: '#fbbf24', glow: 'rgba(245,158,11,0.16)' },
  { slug: 'pay-app-review', label: 'Pay App Review', icon: DocumentMagnifyingGlassIcon, color: '#60a5fa', glow: 'rgba(59,130,246,0.16)' },
  { slug: 'pco-review', label: 'Change Order Review', icon: ScaleIcon, color: '#fb923c', glow: 'rgba(249,115,22,0.16)' },
  { slug: 'invoice-review', label: 'Invoice Review', icon: ReceiptPercentIcon, color: '#2dd4bf', glow: 'rgba(20,184,166,0.16)' },
  { slug: 'precon-review', label: 'Pre-Construction Review', icon: ClipboardDocumentCheckIcon, color: '#34d399', glow: 'rgba(16,185,129,0.16)' },
];

const globalNav = [
  { to: '/projects', label: 'Projects', icon: FolderIcon, color: '#a78bfa', glow: 'rgba(167,139,250,0.18)' },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon, color: '#94a3b8', glow: 'rgba(148,163,184,0.18)' },
  { to: '/contact', label: 'Contact Us', icon: EnvelopeIcon, color: '#f472b6', glow: 'rgba(244,114,182,0.18)' },
];

function navItemStyle({ isActive }, glow) {
  return isActive
    ? { background: glow, color: '#fff', boxShadow: `inset 0 0 0 1px ${glow}` }
    : { color: 'rgba(255,255,255,0.55)' };
}

function NavRow({ to, end, label, Icon, color, glow }) {
  return (
    <NavLink
      to={to}
      end={end}
      className="group flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 relative"
      style={state => navItemStyle(state, glow)}
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
  );
}

export default function Sidebar() {
  const navigate = useNavigate();
  const ctx = useProject();
  const project = ctx?.project;
  const projectId = ctx?.projectId;

  const handleLogout = () => {
    authApi.logout();
    navigate('/login', { replace: true });
  };

  return (
    <aside className="fixed inset-y-0 left-0 w-[220px] flex flex-col z-30"
      style={{ background: 'linear-gradient(180deg, #0d1117 0%, #111827 100%)', boxShadow: '4px 0 24px rgba(0,0,0,0.12)' }}>

      {/* Wordmark */}
      <button onClick={() => navigate('/projects')}
        className="h-[64px] flex items-center px-5 flex-shrink-0 w-full text-left"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 2px 10px rgba(99,102,241,0.5)' }}>
            <span className="text-white font-black text-sm tracking-tight">IQ</span>
          </div>
          <div>
            <p className="text-white font-bold text-[15px] leading-tight tracking-tight">TandemIQ</p>
            <p className="text-[10px] font-medium tracking-widest uppercase"
              style={{ color: 'rgba(255,255,255,0.35)' }}>Project Reviews</p>
          </div>
        </div>
      </button>

      <nav className="flex-1 px-3 overflow-y-auto pb-4">
        {projectId ? (
          <>
            {/* Back to the gallery + which project we're in */}
            <div className="px-2 pt-4 pb-3">
              <button onClick={() => navigate('/projects')}
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-3 transition-colors"
                style={{ color: 'rgba(255,255,255,0.4)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}>
                <ArrowLeftIcon className="w-3.5 h-3.5" /> All Projects
              </button>
              <p className="text-white font-bold text-[14px] leading-snug break-words">
                {project?.project_name || '…'}
              </p>
              {project?.client_name && (
                <p className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{project.client_name}</p>
              )}
            </div>

            <div className="px-2 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: 'rgba(255,255,255,0.25)' }}>Tools</span>
            </div>
            <div className="space-y-1">
              <NavRow to={`/project/${projectId}`} end label="Overview" Icon={Squares2X2Icon}
                color="#a78bfa" glow="rgba(167,139,250,0.18)" />
              {projectTools.map(t => (
                <NavRow key={t.slug} to={`/project/${projectId}/${t.slug}`}
                  label={t.label} Icon={t.icon} color={t.color} glow={t.glow} />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="px-2 pt-6 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: 'rgba(255,255,255,0.25)' }}>Menu</span>
            </div>
            <div className="space-y-1">
              {globalNav.map(n => (
                <NavRow key={n.to} to={n.to} end={n.to === '/projects'}
                  label={n.label} Icon={n.icon} color={n.color} glow={n.glow} />
              ))}
            </div>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
              style={{ background: 'rgba(255,255,255,0.1)' }}>T</div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium truncate" style={{ color: 'rgba(255,255,255,0.6)' }}>TandemIQ</p>
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
