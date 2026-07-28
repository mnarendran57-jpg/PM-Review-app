import { useState, useEffect } from 'react';
import {
  UserGroupIcon, PlusIcon, PencilIcon, TrashIcon, KeyIcon,
  BuildingOffice2Icon, CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { adminApi, authApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';

const ROLE_LABEL = { superadmin: 'Owner', admin: 'Administrator', member: 'Member' };
const ROLE_HELP = {
  admin: 'Can add and remove people, and reset their passwords.',
  member: 'Can use the tools, but cannot manage people.',
};

function RoleBadge({ role }) {
  const style = role === 'superadmin'
    ? { background: 'rgba(249,115,22,0.1)', color: '#c2410c' }
    : role === 'admin'
      ? { background: 'rgba(37,99,235,0.1)', color: '#1d4ed8' }
      : { background: '#f1f5f9', color: '#64748b' };
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold" style={style}>
      {ROLE_LABEL[role] || role}
    </span>
  );
}

// Adding someone creates their account outright — there is no email invitation yet, so
// the password set here is what they sign in with until they change it themselves.
function PersonModal({ person, onClose, onSaved }) {
  const editing = !!person;
  const [name, setName] = useState(person?.name || '');
  const [email, setEmail] = useState(person?.email || '');
  const [role, setRole] = useState(person?.role === 'superadmin' ? 'admin' : (person?.role || 'member'));
  const [status, setStatus] = useState(person?.status || 'Active');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!editing && (!email.trim() || !password)) { setError('Email and a starting password are required.'); return; }
    if (password && password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSaving(true);
    try {
      if (editing) {
        await adminApi.updateUser(person.id, {
          name: name.trim() || null, role, status,
          ...(password ? { new_password: password } : {}),
        });
      } else {
        await adminApi.createUser({ name: name.trim() || null, email: email.trim(), role, password });
      }
      onSaved();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save this person.');
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? `Edit ${person.name || person.email}` : 'Add a person'} onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Naren Murali" />
        </div>
        <div>
          <label className="label">Email {editing ? '' : '*'}</label>
          <input className="input" type="email" value={email} disabled={editing}
            onChange={e => setEmail(e.target.value)} placeholder="name@company.com"
            style={editing ? { background: '#f9fafb', color: '#6b7280' } : undefined} />
          {editing && <p className="text-[11px] text-gray-400 mt-1">The sign-in email can't be changed here.</p>}
        </div>
        <div>
          <label className="label">Role</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value)}>
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
          <p className="text-[11px] text-gray-400 mt-1">{ROLE_HELP[role]}</p>
        </div>
        {editing && (
          <div>
            <label className="label">Access</label>
            <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="Active">Active — can sign in</option>
              <option value="Disabled">Disabled — cannot sign in</option>
            </select>
          </div>
        )}
        <div>
          <label className="label">{editing ? 'Set a new password (optional)' : 'Starting password *'}</label>
          <input className="input" type="text" value={password} onChange={e => setPassword(e.target.value)}
            placeholder={editing ? 'Leave blank to keep their current password' : 'At least 8 characters'} />
          <p className="text-[11px] text-gray-400 mt-1">
            {editing
              ? 'Use this if they forgot theirs — then tell them the new one.'
              : 'Share this with them; they can change it themselves after signing in.'}
          </p>
        </div>

        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add person'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Vendor-only: onboarding a new customer firm together with the person who will run it.
function FirmModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', admin_name: '', admin_email: '', admin_password: '' });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!form.name.trim() || !form.admin_email.trim() || !form.admin_password) {
      setError('Firm name, admin email and admin password are all required.'); return;
    }
    if (form.admin_password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSaving(true);
    try { await adminApi.createFirm(form); onSaved(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not create this firm.'); setSaving(false); }
  };

  return (
    <Modal title="Add a firm" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Firm Name *</label>
          <input className="input" autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Smith PM Group" />
        </div>
        <p className="text-[11px] text-gray-400 -mt-1">
          Their data is completely separate from every other firm's.
        </p>
        <div style={{ borderTop: '1px solid #f3f4f6' }} className="pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Their administrator</p>
          <div className="space-y-3">
            <input className="input" value={form.admin_name} onChange={set('admin_name')} placeholder="Name" />
            <input className="input" type="email" value={form.admin_email} onChange={set('admin_email')} placeholder="Email *" />
            <input className="input" type="text" value={form.admin_password} onChange={set('admin_password')} placeholder="Starting password *" />
          </div>
        </div>
        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create firm'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ChangeMyPassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  const submit = async () => {
    setMsg(null);
    if (next.length < 8) { setMsg({ ok: false, text: 'New password must be at least 8 characters.' }); return; }
    setSaving(true);
    try {
      await authApi.changePassword({ current_password: current, new_password: next });
      setCurrent(''); setNext('');
      setMsg({ ok: true, text: 'Password changed.' });
    } catch (e) {
      setMsg({ ok: false, text: e?.response?.data?.error || 'Could not change your password.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="card p-5 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
        <KeyIcon className="w-4 h-4 text-gray-400" /> Your password
      </h3>
      <div>
        <label className="label">Current password</label>
        <input className="input" type="password" value={current} onChange={e => setCurrent(e.target.value)} />
      </div>
      <div>
        <label className="label">New password</label>
        <input className="input" type="password" value={next} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters" />
      </div>
      {msg && (
        <p className="text-xs flex items-center gap-1" style={{ color: msg.ok ? '#059669' : '#b91c1c' }}>
          {msg.ok && <CheckCircleIcon className="w-4 h-4" />}{msg.text}
        </p>
      )}
      <button className="btn-primary w-full justify-center" onClick={submit} disabled={saving || !current || !next}>
        {saving ? 'Saving…' : 'Change password'}
      </button>
    </div>
  );
}

export default function Team() {
  const me = authApi.user();
  const isSuperadmin = me?.role === 'superadmin';
  const [people, setPeople] = useState(null);
  const [firms, setFirms] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new
  const [addingFirm, setAddingFirm] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    adminApi.listUsers().then(setPeople).catch(() => setPeople([]));
    if (isSuperadmin) adminApi.listFirms().then(setFirms).catch(() => setFirms([]));
  };
  useEffect(() => { load(); }, []);

  const remove = async person => {
    if (!confirm(`Remove ${person.name || person.email}? They will no longer be able to sign in.`)) return;
    setError('');
    try { await adminApi.deleteUser(person.id); load(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not remove this person.'); }
  };

  return (
    <div className="p-8">
      <PageHeader
        icon={UserGroupIcon}
        accent="blue"
        title="Team"
        subtitle="Everyone here can sign in and work on your firm's clients and projects"
      />

      {error && (
        <div className="mb-4 p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-5 gap-6 items-start">
        <div className="col-span-3 space-y-6">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-900">People with access</h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: '#f1f5f9', color: '#64748b' }}>
                  {people?.length ?? '·'}
                </span>
              </div>
              <button className="btn-primary" onClick={() => setEditing(null)}>
                <PlusIcon className="w-4 h-4" /> Add Person
              </button>
            </div>
            <table className="w-full">
              <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <tr>
                  <th className="table-th">Name</th>
                  <th className="table-th">Email</th>
                  <th className="table-th">Role</th>
                  <th className="table-th"></th>
                </tr>
              </thead>
              <tbody>
                {people == null && (
                  <tr><td colSpan={4} className="table-td text-center text-gray-400 py-8">Loading…</td></tr>
                )}
                {people?.length === 0 && (
                  <tr><td colSpan={4} className="table-td text-center text-gray-400 py-8">Nobody yet — click "Add Person".</td></tr>
                )}
                {people?.map(p => (
                  <tr key={p.id} className="table-tr">
                    <td className="table-td">
                      <span className="font-medium text-gray-900">{p.name || '—'}</span>
                      {p.id === me?.id && <span className="ml-2 text-[11px] text-gray-400">(you)</span>}
                      {p.status !== 'Active' && (
                        <span className="ml-2 text-[11px] font-semibold" style={{ color: '#b91c1c' }}>disabled</span>
                      )}
                    </td>
                    <td className="table-td text-gray-500 text-sm">{p.email}</td>
                    <td className="table-td"><RoleBadge role={p.role} /></td>
                    <td className="table-td">
                      <div className="flex gap-1 justify-end">
                        <button className="btn-secondary px-2 py-1" title="Edit / reset password" onClick={() => setEditing(p)}>
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        {p.id !== me?.id && (
                          <button className="btn-danger" title="Remove" onClick={() => remove(p)}>
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Vendor-only: the list of customer firms. */}
          {isSuperadmin && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <div className="flex items-center gap-2">
                  <BuildingOffice2Icon className="w-4 h-4 text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-900">Firms using Coaster</h2>
                </div>
                <button className="btn-primary" onClick={() => setAddingFirm(true)}>
                  <PlusIcon className="w-4 h-4" /> Add Firm
                </button>
              </div>
              <table className="w-full">
                <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                  <tr>
                    <th className="table-th">Firm</th>
                    <th className="table-th">People</th>
                    <th className="table-th">Clients</th>
                    <th className="table-th">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {firms?.map(f => (
                    <tr key={f.id} className="table-tr">
                      <td className="table-td font-medium text-gray-900">{f.name}</td>
                      <td className="table-td text-gray-500 text-sm">{f.user_count}</td>
                      <td className="table-td text-gray-500 text-sm">{f.client_count}</td>
                      <td className="table-td text-gray-500 text-sm">{f.project_count}</td>
                    </tr>
                  ))}
                  {firms?.length === 0 && (
                    <tr><td colSpan={4} className="table-td text-center text-gray-400 py-8">No firms yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="col-span-2 space-y-4">
          <ChangeMyPassword />
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">How access works</h3>
            <p className="text-xs text-gray-500 leading-relaxed">
              Everyone listed here belongs to <span className="font-medium text-gray-700">{me?.firmName || 'your firm'}</span> and
              sees the same clients and projects. Nobody outside your firm can see any of it.
            </p>
            <p className="text-xs text-gray-500 leading-relaxed mt-2">
              There's no "forgot password" email yet — if someone is locked out, edit them here and set a new password.
            </p>
          </div>
        </div>
      </div>

      {editing !== undefined && (
        <PersonModal
          person={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}
      {addingFirm && (
        <FirmModal onClose={() => setAddingFirm(false)} onSaved={() => { setAddingFirm(false); load(); }} />
      )}
    </div>
  );
}
