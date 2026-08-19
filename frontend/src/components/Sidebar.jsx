import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  InboxArrowDownIcon, ArrowRightOnRectangleIcon, DocumentMagnifyingGlassIcon,
  ClipboardDocumentCheckIcon, Squares2X2Icon, ScaleIcon, ArrowLeftIcon,
  Cog6ToothIcon, EnvelopeIcon, FolderIcon, ReceiptPercentIcon, CameraIcon, UserGroupIcon,
  ClipboardDocumentListIcon, QuestionMarkCircleIcon, CheckCircleIcon, FolderOpenIcon,
  ChevronUpDownIcon, BeakerIcon,
} from '@heroicons/react/24/outline';
import { authApi, selectedOrg, selectedProgram, orgsApi, programsApi, projectsApi } from '../api';
import { useProject } from '../context/ProjectContext';
import { usePlanFeatures } from '../hooks/usePlanFeatures';

// Offering "Switch organization" to someone who only belongs to one is a dead end that
// makes the app look bigger than their access is. So the back-link names the highest level
// where they actually have a choice, and disappears entirely when they have none.
function useSwitchTarget(org, program) {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    if (!org) { setTarget(null); return; }
    let cancelled = false;

    (async () => {
      // Both counts are always needed: the program count decides whether the program line
      // below is worth making clickable even when the organization link wins here.
      const [orgs, programs] = await Promise.all([
        orgsApi.mine().catch(() => []),
        programsApi.list().catch(() => []),
      ]);
      if (cancelled) return;
      const counts = { orgs: (orgs || []).length, programs: (programs || []).length };

      if (counts.orgs > 1) {
        setTarget({ label: 'Switch organization', to: '/organizations', level: 'org', counts });
        return;
      }
      if (counts.programs > 1) {
        setTarget({ label: 'Switch program', to: '/programs', level: 'program', counts });
        return;
      }
      // Only worth offering once they are inside a program, since that is what scopes the
      // project list they would be switching within.
      const projects = program
        ? await projectsApi.list({ program_id: program.id }).catch(() => [])
        : [];
      if (cancelled) return;
      setTarget((projects || []).length > 1
        ? { label: 'Switch project', to: '/projects', level: 'project', counts }
        : null);
    })();

    return () => { cancelled = true; };
  }, [org?.id, program?.id]);

  return target;
}

// The tools that operate on a single project. Their routes are built relative to the
// active project (/project/:id/...) so they always carry the project context with them.
const projectTools = [
  { slug: 'proposal-intake', label: 'Proposal Intake', icon: InboxArrowDownIcon, color: '#fbbf24', glow: 'rgba(245,158,11,0.16)' },
  { slug: 'pay-app-review', label: 'Pay App Review', icon: DocumentMagnifyingGlassIcon, color: '#60a5fa', glow: 'rgba(59,130,246,0.16)' },
  // The sandbox. `feature` points at the real module because this is not something Coaster
  // sells — it rides along wherever Pay App Review is enabled and must never become a plan
  // feature of its own. Named and coloured so it cannot be mistaken for the real one.
  { slug: 'pay-app-review-2', label: 'Pay App Reviewer 2', feature: 'pay-app-review',
    icon: BeakerIcon, color: '#f59e0b', glow: 'rgba(245,158,11,0.16)' },
  { slug: 'pco-review', label: 'Change Order Review', icon: ScaleIcon, color: '#fb923c', glow: 'rgba(249,115,22,0.16)' },
  { slug: 'invoice-review', label: 'Invoice Review', icon: ReceiptPercentIcon, color: '#2dd4bf', glow: 'rgba(20,184,166,0.16)' },
  { slug: 'progress-report', label: 'Progress Report', icon: CameraIcon, color: '#fb7185', glow: 'rgba(244,63,94,0.16)' },
  { slug: 'precon-review', label: 'Pre-Construction Review', icon: ClipboardDocumentCheckIcon, color: '#34d399', glow: 'rgba(16,185,129,0.16)' },
  { slug: 'submittal-log', label: 'Submittal Log', icon: ClipboardDocumentListIcon, color: '#a78bfa', glow: 'rgba(139,92,246,0.16)' },
  { slug: 'rfi-log', label: 'RFI Log', icon: QuestionMarkCircleIcon, color: '#38bdf8', glow: 'rgba(14,165,233,0.16)' },
  { slug: 'meeting-actions', label: 'Meeting Actions', icon: CheckCircleIcon, color: '#4ade80', glow: 'rgba(34,197,94,0.16)' },
];

const globalNav = [
  { to: '/projects', label: 'Projects', icon: FolderIcon, color: '#3b82f6', glow: 'rgba(37,99,235,0.2)' },
];

// Everything about the person rather than about the work, reached from their own initials at the
// bottom. These three sat in the same list as Projects, which put "who am I" and "what am I doing"
// on one footing — and on a project page they were competing with the nine tools for the eye.
const accountNav = [
  // Managing who can sign in is an administrator's job, so it is hidden from members.
  { to: '/team', label: 'Team', icon: UserGroupIcon, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon },
  { to: '/contact', label: 'Contact Us', icon: EnvelopeIcon },
];

// Two letters where there are two names to take them from, one otherwise. Falls back to the email,
// which every account has even before anyone has typed a name.
function initialsOf(user) {
  const words = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return String(user?.email || '?').slice(0, 2).toUpperCase();
}

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

// The signed-in person, and everything that belongs to them. Opens upward, because it lives at the
// bottom of a full-height rail and a downward panel would fall off the screen.
function AccountMenu({ isAdmin }) {
  const navigate = useNavigate();
  const user = authApi.user();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  // A menu that stays open behind the page it just navigated to is the usual way this goes wrong,
  // so it closes on a click anywhere outside it and on Escape as well — the pointer is not the
  // only way people leave a menu.
  useEffect(() => {
    if (!open) return undefined;
    const away = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const key = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const signOut = () => {
    authApi.logout();
    navigate('/login', { replace: true });
  };

  const items = accountNav.filter(n => !n.adminOnly || isAdmin);

  return (
    <div ref={wrap} className="relative px-3 py-3 flex-shrink-0"
      style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>

      {open && (
        <div className="absolute left-3 right-3 bottom-full mb-2 rounded-xl overflow-hidden py-1"
          style={{
            background: '#161d29',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}>
          <div className="px-3 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[13px] font-semibold text-white truncate">{user?.name || 'Your account'}</p>
            <p className="text-[11px] truncate" style={{ color: 'rgba(255,255,255,0.4)' }}>{user?.email}</p>
          </div>
          <div className="py-1">
            {items.map(n => (
              <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors"
                style={({ isActive }) => ({
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.6)',
                  background: isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                })}>
                <n.icon className="w-4 h-4 flex-shrink-0" />
                {n.label}
              </NavLink>
            ))}
          </div>
          <button onClick={signOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors"
            style={{ color: 'rgba(255,255,255,0.6)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}>
            <ArrowRightOnRectangleIcon className="w-4 h-4 flex-shrink-0" />
            Sign out
          </button>
        </div>
      )}

      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl transition-colors text-left"
        style={{ background: open ? 'rgba(255,255,255,0.07)' : 'transparent' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = open ? 'rgba(255,255,255,0.07)' : 'transparent'; }}>
        <span className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[12px] font-bold"
          style={{ background: 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)', color: '#0d1117' }}>
          {initialsOf(user)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium truncate" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {user?.name || user?.email || 'Account'}
          </span>
          {/* Not the list of what is inside: at this width it truncated to "Team · Settings · Con…",
              which reads as a rendering fault rather than as a hint. */}
          <span className="block text-[10px] truncate" style={{ color: 'rgba(255,255,255,0.35)' }}>
            Account
          </span>
        </span>
        <ChevronUpDownIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.35)' }} />
      </button>
    </div>
  );
}

export default function Sidebar() {
  const navigate = useNavigate();
  const ctx = useProject();
  const project = ctx?.project;
  const projectId = ctx?.projectId;
  const org = selectedOrg.get();
  const program = selectedProgram.get();
  // Org-level admin rights are recorded on the organization the user picked; a platform
  // admin (the vendor) counts as an admin everywhere.
  const isAdmin = authApi.user()?.isPlatformAdmin || !!org?.is_admin;
  const switchTarget = useSwitchTarget(org, program);
  // Tools the customer's plan doesn't include are not shown at all — a disabled row the user
  // can never use is worse than one that isn't there.
  const { has: hasFeature } = usePlanFeatures();
  // The organization link is one level up, so a second program to switch to is still worth
  // offering underneath it. When the link above already says "Switch program", it is not.
  const canChangeProgram = switchTarget?.level === 'org' && switchTarget.counts.programs > 1;

  // Team spans every organization for the platform owner, so naming one of them in the sidebar
  // while that page lists them all says the page is scoped when it isn't — and invites the
  // reasonable but wrong conclusion that "add member" would land in whichever one is shown.
  // Everyone else has exactly one organization in view here, so the heading still tells the truth.
  const { pathname } = useLocation();
  const orgScoped = !(pathname.startsWith('/team') && authApi.user()?.isPlatformAdmin);

  return (
    <aside className="fixed inset-y-0 left-0 w-[220px] flex flex-col z-30"
      style={{ background: 'linear-gradient(180deg, #0d1117 0%, #111827 100%)', boxShadow: '4px 0 24px rgba(0,0,0,0.12)' }}>

      {/* Wordmark */}
      <button onClick={() => navigate('/projects')}
        className="h-[64px] flex items-center px-5 flex-shrink-0 w-full text-left"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3">
          <img src="/coaster-logo.svg" alt="Coaster" className="w-8 h-8 rounded-lg flex-shrink-0" />
          <div>
            <p className="text-white font-bold text-[15px] leading-tight tracking-tight">Coaster</p>
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
                color="#3b82f6" glow="rgba(37,99,235,0.2)" />
              {/* Deliberately outside the plan filter. Shared Documents is not a tool a
                  customer buys — it is where the contract and drawings live, and every tool
                  below reads from it, so hiding it would strand whatever they did buy. */}
              <NavRow to={`/project/${projectId}/shared-documents`} label="Shared Documents"
                Icon={FolderOpenIcon} color="#facc15" glow="rgba(234,179,8,0.16)" />
              {projectTools.filter(t => hasFeature(t.feature || t.slug)).map(t => (
                <NavRow key={t.slug} to={`/project/${projectId}/${t.slug}`}
                  label={t.label} Icon={t.icon} color={t.color} glow={t.glow} />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Where the user currently is in the hierarchy, and a way back up it. */}
            {org && orgScoped && (
              <div className="px-2 pt-4 pb-3">
                {switchTarget && (
                  <button onClick={() => navigate(switchTarget.to)}
                    className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-2 transition-colors"
                    style={{ color: 'rgba(255,255,255,0.4)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}>
                    <ArrowLeftIcon className="w-3.5 h-3.5" /> {switchTarget.label}
                  </button>
                )}
                <p className="text-white font-bold text-[14px] leading-snug break-words">{org.name}</p>
                {program && (
                  // Only clickable when there is somewhere else to go, and not when the link
                  // above already offers exactly this.
                  canChangeProgram ? (
                    <button onClick={() => navigate('/programs')}
                      className="text-[11px] mt-0.5 text-left transition-colors"
                      style={{ color: 'rgba(255,255,255,0.4)' }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}>
                      {program.name} · change
                    </button>
                  ) : (
                    <p className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{program.name}</p>
                  )
                )}
              </div>
            )}
            {/* No heading: with Team, Settings and Contact moved to the account menu, a "Menu"
                label sits over a single row. */}
            <div className="space-y-1 pt-2">
              {globalNav.filter(n => !n.adminOnly || isAdmin).map(n => (
                <NavRow key={n.to} to={n.to} end={n.to === '/projects'}
                  label={n.label} Icon={n.icon} color={n.color} glow={n.glow} />
              ))}
            </div>
          </>
        )}
      </nav>

      {/* The Coaster mark and version sat here and said nothing the wordmark above does not
          already say. The space belongs to the person signed in. */}
      <AccountMenu isAdmin={isAdmin} />
    </aside>
  );
}
