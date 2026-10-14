import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MagnifyingGlassIcon, RectangleGroupIcon, FolderIcon } from '@heroicons/react/24/outline';
import { programsApi, projectsApi, selectedOrg, selectedProgram } from '../api';
import { useProject } from '../context/ProjectContext';

// One box at the top of every page that goes to a program or a project.
//
// What it searches is deliberately the things a person navigates between, not the contents of
// them. "Where is the Fine Arts project" is the question asked twenty times a day; finding a
// sentence inside a submittal is a different feature with a different cost. A project's tools are
// not in it: they are already listed down the side of every project page, one click away.
//
// Scoped to the organization that is open, because that is the boundary everything else in
// Coaster respects. Projects come from every program the user can see, so a project can be reached
// without first remembering which program it sits in.

// How many of each kind are shown at once. A list longer than this is a sign the search should be
// narrower, not that the list should scroll.
const PER_GROUP = 6;
// How long a fetched list is trusted before the box asks again. Long enough that typing never waits
// on the network, short enough that a project added a minute ago can be found.
const FRESH_MS = 60 * 1000;

const norm = s => String(s || '').toLowerCase();

// Lower is better; null means no match. Every word typed has to appear somewhere — the name first,
// then the supporting text — and a name that begins with what was typed ranks above one that merely
// contains it.
function score(query, name, extra = '') {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const n = norm(name);
  const all = `${n} ${norm(extra)}`;
  if (!words.every(w => all.includes(w))) return null;
  const q = norm(query).trim();
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s\-–—·,]+/).some(part => part.startsWith(words[0]))) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

const ranked = (items, query, nameOf, extraOf) => items
  .map(item => ({ item, s: score(query, nameOf(item), extraOf(item)) }))
  .filter(x => x.s !== null)
  .sort((a, b) => a.s - b.s || norm(nameOf(a.item)).localeCompare(norm(nameOf(b.item))))
  .slice(0, PER_GROUP)
  .map(x => x.item);

export default function GlobalSearch() {
  const navigate = useNavigate();
  const ctx = useProject();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [programs, setPrograms] = useState([]);
  const [projects, setProjects] = useState([]);
  const loadedAt = useRef(0);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  const orgId = selectedOrg.get()?.id ?? null;
  // Inside a project, its own program — the one last chosen can be a different one when the
  // project was reached by a link or from this box.
  const currentProgramId = ctx?.project?.program_id ?? selectedProgram.get()?.id ?? null;

  // Fetched when the box is first used rather than on every page, so pages that nobody searches
  // from cost nothing.
  const load = useCallback(() => {
    if (!orgId || Date.now() - loadedAt.current < FRESH_MS) return;
    loadedAt.current = Date.now();
    programsApi.list().then(setPrograms).catch(() => setPrograms([]));
    projectsApi.list().then(setProjects).catch(() => setProjects([]));
  }, [orgId]);

  // ⌘K / Ctrl+K from anywhere, the shortcut most people already reach for.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Closes on a click anywhere else.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Projects first, because there are more of them and they are where the work is; programs last,
  // because there are few.
  const groups = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Nothing typed yet: offer the projects in the program that is open, rather than an empty box.
      const here = projects.filter(p => !currentProgramId || p.program_id === currentProgramId).slice(0, PER_GROUP);
      return here.length ? [{ key: 'projects', title: 'Projects', items: here.map(p => ({ kind: 'project', project: p })) }] : [];
    }
    const out = [];
    const p = ranked(projects, q, x => x.project_name, x => `${x.client_name || ''} ${x.program || ''}`);
    if (p.length) out.push({ key: 'projects', title: 'Projects', items: p.map(x => ({ kind: 'project', project: x })) });
    const g = ranked(programs, q, x => x.name, () => '');
    if (g.length) out.push({ key: 'programs', title: 'Programs', items: g.map(x => ({ kind: 'program', program: x })) });
    return out;
  }, [query, projects, programs, currentProgramId]);

  const flat = useMemo(() => groups.flatMap(g => g.items), [groups]);
  useEffect(() => { setActive(0); }, [query]);

  const go = (item) => {
    if (!item) return;
    if (item.kind === 'project') {
      const p = item.project;
      // The path at the top of the page names the program, so it has to be the project's own.
      if (p.program_id) selectedProgram.set({ id: p.program_id, name: p.program });
      navigate(`/project/${p.id}`);
    } else if (item.kind === 'program') {
      selectedProgram.set({ id: item.program.id, name: item.program.name });
      navigate('/projects');
    }
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
  };

  if (!orgId) return null;

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  let index = -1;

  return (
    <div ref={boxRef} className="relative w-full max-w-[340px]">
      <div className="flex items-center gap-2 h-9 px-3 rounded-xl transition-all"
        style={{
          background: open ? '#fff' : 'rgba(255,255,255,0.7)',
          border: `1px solid ${open ? '#c7d2fe' : '#e5e7eb'}`,
          boxShadow: open ? '0 0 0 3px rgba(99,102,241,0.08)' : 'none',
        }}>
        <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { load(); setOpen(true); }}
          onKeyDown={onKeyDown}
          placeholder="Search projects and programs"
          aria-label="Search Coaster"
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-results"
          className="flex-1 min-w-0 bg-transparent text-[13px] text-gray-800 placeholder-gray-400"
          // The box around it already shows focus; the app-wide focus ring on top of that drew a
          // second rectangle inside the first.
          style={{ outline: 'none', boxShadow: 'none', border: 0 }}
        />
        {!open && (
          <kbd className="text-[10px] font-medium text-gray-400 px-1.5 py-0.5 rounded-md flex-shrink-0"
            style={{ background: '#f3f4f6', border: '1px solid #e5e7eb' }}>
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        )}
      </div>

      {open && (
        <div id="global-search-results" role="listbox"
          // Exactly as wide as the box, so it can never reach across under the sidebar.
          className="absolute left-0 right-0 mt-2 rounded-xl bg-white overflow-hidden"
          style={{ border: '1px solid #e5e7eb', boxShadow: '0 12px 32px rgba(15,23,42,0.12)', zIndex: 50 }}>
          {groups.length === 0 ? (
            <p className="px-4 py-5 text-[13px] text-gray-400 text-center">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Type the name of a project or program.'}
            </p>
          ) : (
            <div className="py-1.5 max-h-[60vh] overflow-y-auto">
              {groups.map(group => (
                <div key={group.key} className="py-1">
                  <p className="px-4 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 truncate">
                    {group.title}
                  </p>
                  {group.items.map((item) => {
                    index += 1;
                    const i = index;
                    const selected = i === active;
                    const { Icon, label, detail } = describe(item);
                    return (
                      <button key={`${item.kind}-${item.project?.id ?? item.program?.id}`}
                        type="button" role="option" aria-selected={selected}
                        // Mouse down rather than click, so the box does not close before the choice lands.
                        onMouseDown={e => { e.preventDefault(); go(item); }}
                        onMouseEnter={() => setActive(i)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left"
                        style={{ background: selected ? '#f5f7ff' : 'transparent' }}>
                        <span className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: selected ? '#e0e7ff' : '#f3f4f6', color: selected ? '#4338ca' : '#6b7280' }}>
                          <Icon className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-gray-900 truncate">{label}</span>
                          {detail && <span className="block text-[11px] text-gray-400 truncate">{detail}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function describe(item) {
  if (item.kind === 'project') {
    const p = item.project;
    return { Icon: FolderIcon, label: p.project_name, detail: [p.program, p.client_name].filter(Boolean).join(' · ') || null };
  }
  const g = item.program;
  const count = typeof g.project_count === 'number' ? `${g.project_count} project${g.project_count === 1 ? '' : 's'}` : null;
  return { Icon: RectangleGroupIcon, label: g.name, detail: count };
}
