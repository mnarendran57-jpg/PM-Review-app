import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuildingOffice2Icon, PlusIcon, ArrowRightIcon, ArrowRightOnRectangleIcon } from '@heroicons/react/24/outline';
import { clientsApi, authApi, selectedClient } from '../api';
import Modal from '../components/Modal';

// The step between signing in and working: a firm serves several clients, so the user
// picks which one they're on. The choice is remembered, and the whole app below is
// filtered to it until they switch.
function AddClientModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Give the client a name first.'); return; }
    setError(''); setSaving(true);
    try {
      const { id } = await clientsApi.create({ name: name.trim(), contact_name: contact.trim() || null });
      onCreated(id);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not add this client.');
      setSaving(false);
    }
  };

  return (
    <Modal title="Add a Client" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Client Name *</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Houston Community College"
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        </div>
        <div>
          <label className="label">Main Contact (optional)</label>
          <input className="input" value={contact} onChange={e => setContact(e.target.value)} placeholder="e.g. James Walker" />
        </div>
        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Adding…' : 'Add Client'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function ClientSelect() {
  const navigate = useNavigate();
  const [clients, setClients] = useState(null);
  const [adding, setAdding] = useState(false);
  // Start from the cached user so the header renders immediately, then re-read it from
  // the server — the firm may have been renamed, or the account's role changed, since
  // this browser last signed in.
  const [user, setUser] = useState(authApi.user());

  const load = () => clientsApi.list().then(setClients).catch(() => setClients([]));
  useEffect(() => {
    load();
    authApi.me().then(setUser).catch(() => {});
  }, []);

  const choose = client => {
    selectedClient.set({ id: client.id, name: client.name });
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
              <h1 className="text-[26px] font-extrabold tracking-tight text-gray-900 leading-tight">
                {user?.firmName || 'Your firm'}
              </h1>
              <p className="text-sm text-gray-500">Signed in as {user?.name || user?.email}</p>
            </div>
          </div>
          <button className="btn-secondary" onClick={logout}>
            <ArrowRightOnRectangleIcon className="w-4 h-4" /> Sign out
          </button>
        </div>

        <div className="flex items-end justify-between mb-6 animate-fade-up">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Select a client</h2>
            <p className="text-sm text-gray-500 mt-0.5">Choose which client you're working on to see their projects.</p>
          </div>
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <PlusIcon className="w-5 h-5" /> Add a Client
          </button>
        </div>

        {clients == null ? (
          <p className="text-gray-400">Loading clients…</p>
        ) : clients.length === 0 ? (
          <button onClick={() => setAdding(true)}
            className="w-full card p-12 flex flex-col items-center justify-center gap-3 cursor-pointer animate-fade-up"
            style={{ borderStyle: 'dashed', borderColor: '#d1d5db' }}>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(37,99,235,0.08)' }}>
              <BuildingOffice2Icon className="w-7 h-7" style={{ color: '#2563eb' }} />
            </div>
            <p className="text-lg font-bold text-gray-900">No clients yet</p>
            <p className="text-sm text-gray-500">Add your first client to start setting up their projects.</p>
          </button>
        ) : (
          <div className="grid grid-cols-3 gap-6">
            {clients.map((c, i) => (
              <button key={c.id} onClick={() => choose(c)}
                className={`card card-hover group cursor-pointer p-6 flex flex-col text-left animate-fade-up stagger-${(i % 4) + 1}`}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: 'linear-gradient(135deg, #f97316, #2563eb)', boxShadow: '0 8px 24px rgba(37,99,235,0.22)' }}>
                  <BuildingOffice2Icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1 leading-snug">{c.name}</h3>
                <p className="text-sm text-gray-500 flex-1">{c.contact_name || 'No contact set'}</p>
                <div className="flex items-center justify-between mt-5">
                  <span className="text-[12px] text-gray-400">
                    {c.project_count} project{c.project_count === 1 ? '' : 's'}
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
          <AddClientModal
            onClose={() => setAdding(false)}
            onCreated={async id => {
              setAdding(false);
              const list = await clientsApi.list();
              setClients(list);
              const created = list.find(c => c.id === id);
              if (created) choose(created);
            }}
          />
        )}
      </div>
    </div>
  );
}
