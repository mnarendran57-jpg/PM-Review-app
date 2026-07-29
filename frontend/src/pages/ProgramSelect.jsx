import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RectangleGroupIcon, PlusIcon, ArrowRightIcon, ArrowLeftIcon, ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline';
import { programsApi, authApi, selectedOrg, selectedProgram } from '../api';
import Modal from '../components/Modal';

// Step two: the programs inside the chosen organization. An Org Admin sees every program;
// everyone else sees only the ones holding a project they're actually on — so this list is
// already filtered by the server, not here.
function AddProgramModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Give the program a name first.'); return; }
    setError(''); setSaving(true);
    try {
      const { id } = await programsApi.create({ name: name.trim() });
      onCreated(id);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not add this program.');
      setSaving(false);
    }
  };

  return (
    <Modal title="Add a Program" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Program Name *</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. 2026 Bond Program"
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <p className="text-[11px] text-gray-400 mt-1.5">
            A program groups related projects. If you don't work in programs, one is enough.
          </p>
        </div>
        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Adding…' : 'Add Program'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function ProgramSelect() {
  const navigate = useNavigate();
  const org = selectedOrg.get();
  const [programs, setPrograms] = useState(null);
  const [adding, setAdding] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const user = authApi.user();

  const load = () => programsApi.list().then(setPrograms).catch(() => setPrograms([]));
  useEffect(() => {
    if (!org) { navigate('/organizations', { replace: true }); return; }
    load();
    // Only admins may create programs, so the button is hidden otherwise. The server
    // enforces this regardless.
    authApi.me().then(({ user: u, organizations }) => {
      const mine = (organizations || []).find(o => o.id === org.id);
      setIsAdmin(u?.isPlatformAdmin || !!mine?.is_admin);
    }).catch(() => {});
  }, []);

  const choose = program => {
    selectedProgram.set({ id: program.id, name: program.name });
    navigate('/projects');
  };

  const logout = () => { authApi.logout(); navigate('/login', { replace: true }); };

  return (
    <div className="min-h-screen relative" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="relative max-w-5xl mx-auto px-8 py-12" style={{ zIndex: 1 }}>
        <div className="flex items-start justify-between mb-10 animate-fade-up">
          <div className="flex items-center gap-3">
            <img src="/coaster-logo.svg" alt="Coaster" className="w-11 h-11 rounded-xl" />
            <div>
              <h1 className="text-[26px] font-extrabold tracking-tight text-gray-900 leading-tight">{org?.name}</h1>
              <p className="text-sm text-gray-500">Signed in as {user?.name || user?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => navigate('/organizations')}>
              <ArrowLeftIcon className="w-4 h-4" /> Switch organization
            </button>
            <button className="btn-secondary" onClick={logout}>
              <ArrowRightOnRectangleIcon className="w-4 h-4" /> Sign out
            </button>
          </div>
        </div>

        <div className="flex items-end justify-between mb-6 animate-fade-up">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Select a program</h2>
            <p className="text-sm text-gray-500 mt-0.5">Programs group related projects together.</p>
          </div>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              <PlusIcon className="w-5 h-5" /> Add a Program
            </button>
          )}
        </div>

        {programs == null ? (
          <p className="text-gray-400">Loading programs…</p>
        ) : programs.length === 0 ? (
          <div className="card p-12 text-center animate-fade-up">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3" style={{ background: 'rgba(37,99,235,0.08)' }}>
              <RectangleGroupIcon className="w-7 h-7" style={{ color: '#2563eb' }} />
            </div>
            <p className="text-lg font-bold text-gray-900">Nothing here yet</p>
            <p className="text-sm text-gray-500 mt-1">
              {isAdmin
                ? 'Add a program to start setting up projects.'
                : "You haven't been added to any projects in this organization yet."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6">
            {programs.map((p, i) => (
              <button key={p.id} onClick={() => choose(p)}
                className={`card card-hover group cursor-pointer p-6 flex flex-col text-left animate-fade-up stagger-${(i % 4) + 1}`}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: 'linear-gradient(135deg, #2563eb, #3b82f6)', boxShadow: '0 8px 24px rgba(37,99,235,0.22)' }}>
                  <RectangleGroupIcon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1 leading-snug">{p.name}</h3>
                <p className="text-sm text-gray-500 flex-1">{p.contact_name || ' '}</p>
                <div className="flex items-center justify-between mt-5">
                  <span className="text-[12px] text-gray-400">
                    {p.project_count} project{p.project_count === 1 ? '' : 's'}
                  </span>
                  <span className="flex items-center gap-1 text-sm font-semibold text-blue-600">
                    Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {adding && (
          <AddProgramModal
            onClose={() => setAdding(false)}
            onCreated={async id => {
              setAdding(false);
              const list = await programsApi.list();
              setPrograms(list);
              const created = list.find(p => p.id === id);
              if (created) choose(created);
            }}
          />
        )}
      </div>
    </div>
  );
}
