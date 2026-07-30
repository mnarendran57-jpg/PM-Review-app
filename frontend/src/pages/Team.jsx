import { useState, useEffect } from 'react';
import {
  UserGroupIcon, PlusIcon, PencilIcon, TrashIcon, KeyIcon,
  BuildingOffice2Icon, CheckCircleIcon, EnvelopeIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { adminApi, authApi, selectedOrg } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { useConfirm } from '../components/ConfirmDialog';

const ROLE_LABEL = { Admin: 'Administrator', Member: 'Member' };
const ROLE_HELP = {
  Admin: 'Sees every program and project in this organization, and manages its people.',
  Member: 'Sees only the projects they are added to individually.',
};

function RoleBadge({ role }) {
  const style = role === 'Admin'
    ? { background: 'rgba(37,99,235,0.1)', color: '#1d4ed8' }
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
  const [role, setRole] = useState(person?.role === 'Admin' ? 'Admin' : 'Member');
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
        await adminApi.updateMember(person.user_id, {
          name: name.trim() || null, role, status,
          ...(password ? { new_password: password } : {}),
        });
      } else {
        await adminApi.addMember({ name: name.trim() || null, email: email.trim(), role, password });
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
            <option value="Member">Member</option>
            <option value="Admin">Administrator</option>
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

// Inviting is the preferred route: the invitee sets their own password, so it is never
// known to the admin or sent anywhere in plain text. The link is always shown here so the
// invitation works whether or not outbound email is configured.
function InviteModal({ onClose, onSent }) {
  const [address, setAddress] = useState('');
  const [role, setRole] = useState('Member');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setError('');
    if (!address.trim()) { setError('Enter an email address.'); return; }
    setSaving(true);
    try { setResult(await adminApi.invite({ email: address.trim(), role })); onSent(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not send this invitation.'); }
    finally { setSaving(false); }
  };

  const copy = () => {
    navigator.clipboard.writeText(result.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  if (result) {
    return (
      <Modal title="Invitation created" onClose={onClose}>
        <div className="space-y-4">
          <div className="p-3 rounded-xl flex items-start gap-2"
            style={{ background: result.emailed ? '#f6faf7' : '#fff7ed', border: `1px solid ${result.emailed ? '#dcf0e2' : '#fed7aa'}` }}>
            <CheckCircleIcon className="w-5 h-5 flex-shrink-0" style={{ color: result.emailed ? '#059669' : '#c2410c' }} />
            <p className="text-sm text-gray-700">
              {result.emailed
                ? <>An invitation email has been sent to <strong>{result.email}</strong>.</>
                : result.emailConfigured
                  ? <>The invitation was created, but the email <strong>could not be sent</strong> ({result.emailError}). Send this link to {result.email} yourself, and check the email settings.</>
                  : <>Email sending isn't set up, so <strong>send this link to {result.email} yourself</strong>. They'll set their own password.</>}
            </p>
          </div>
          <div>
            <label className="label">Invitation link</label>
            <textarea className="input text-xs" rows={3} readOnly value={result.link}
              onFocus={e => e.target.select()} style={{ background: '#f9fafb' }} />
            <button className="btn-secondary w-full justify-center mt-2" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <p className="text-[11px] text-gray-400 mt-2">
              Valid for 7 days and usable once. Anyone with this link can join as {result.role} — treat it like a password.
            </p>
          </div>
          <div className="flex justify-end pt-1">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Invite a person" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Email address *</label>
          <input className="input" type="email" autoFocus value={address}
            onChange={e => setAddress(e.target.value)} placeholder="name@company.com"
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <p className="text-[11px] text-gray-400 mt-1">They'll choose their own password — you never see it.</p>
        </div>
        <div>
          <label className="label">Role</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value)}>
            <option value="Member">Member</option>
            <option value="Admin">Administrator</option>
          </select>
          <p className="text-[11px] text-gray-400 mt-1">{ROLE_HELP[role]}</p>
        </div>
        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Inviting…' : 'Send invitation'}</button>
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
      setError('Organization name, admin email and admin password are all required.'); return;
    }
    if (form.admin_password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSaving(true);
    try { await adminApi.createOrganization(form); onSaved(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not create this organization.'); setSaving(false); }
  };

  return (
    <Modal title="Add an organization" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Organization Name *</label>
          <input className="input" autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Smith PM Group" />
        </div>
        <p className="text-[11px] text-gray-400 -mt-1">
          Their data is completely separate from every other organization's.
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
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create organization'}</button>
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
  const isSuperadmin = me?.isPlatformAdmin;
  const [people, setPeople] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [invites, setInvites] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new
  const [inviting, setInviting] = useState(false);
  const [addingOrg, setAddingOrg] = useState(false);
  const [error, setError] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const load = () => {
    adminApi.listMembers().then(setPeople).catch(() => setPeople([]));
    adminApi.listInvitations().then(setInvites).catch(() => setInvites([]));
    if (isSuperadmin) adminApi.listOrganizations().then(setOrgs).catch(() => setOrgs([]));
  };
  useEffect(() => { load(); }, []);

  const revokeInvite = async inv => {
    const ok = await confirm({
      title: 'Cancel invitation',
      message: `Cancel the invitation to ${inv.email}? Their link will stop working immediately.`,
      confirmLabel: 'Cancel invitation',
    });
    if (!ok) return;
    setError('');
    try { await adminApi.revokeInvitation(inv.id); load(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not cancel this invitation.'); }
  };

  const remove = async person => {
    const ok = await confirm({
      title: 'Remove person',
      message: `Remove ${person.name || person.email} from this organization? They keep their account and any access to other organizations.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setError('');
    try { await adminApi.removeMember(person.user_id); load(); }
    catch (e) { setError(e?.response?.data?.error || 'Could not remove this person.'); }
  };

  return (
    <div className="p-8">
      <PageHeader
        icon={UserGroupIcon}
        accent="blue"
        title="Team"
        subtitle="People who can reach this organization, and what they can see"
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
              <div className="flex items-center gap-2">
                <button className="btn-secondary" onClick={() => setEditing(null)} title="Create the account yourself with a password you choose">
                  <PlusIcon className="w-4 h-4" /> Add directly
                </button>
                <button className="btn-primary" onClick={() => setInviting(true)}>
                  <EnvelopeIcon className="w-4 h-4" /> Invite
                </button>
              </div>
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
                      {p.user_id === me?.id && <span className="ml-2 text-[11px] text-gray-400">(you)</span>}
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
                        {p.user_id !== me?.id && (
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

          {/* Invitations that haven't been accepted yet. */}
          {invites?.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <EnvelopeIcon className="w-4 h-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-900">Pending invitations</h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: '#fff7ed', color: '#c2410c' }}>
                  {invites.length}
                </span>
              </div>
              <div className="divide-y" style={{ borderColor: '#f3f4f6' }}>
                {invites.map(inv => (
                  <div key={inv.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{inv.email}</p>
                      <p className="text-xs text-gray-400">
                        Invited as {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button className="btn-secondary px-2.5 py-1 text-xs"
                        onClick={() => navigator.clipboard.writeText(`${window.location.origin}/invite/${inv.token}`)}>
                        Copy link
                      </button>
                      <button className="btn-danger" title="Cancel invitation" onClick={() => revokeInvite(inv)}>
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Vendor-only: the list of customer firms. */}
          {isSuperadmin && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <div className="flex items-center gap-2">
                  <BuildingOffice2Icon className="w-4 h-4 text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-900">Organizations using Coaster</h2>
                </div>
                <button className="btn-primary" onClick={() => setAddingOrg(true)}>
                  <PlusIcon className="w-4 h-4" /> Add Organization
                </button>
              </div>
              <table className="w-full">
                <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                  <tr>
                    <th className="table-th">Organization</th>
                    <th className="table-th">People</th>
                    <th className="table-th">Programs</th>
                    <th className="table-th">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs?.map(f => (
                    <tr key={f.id} className="table-tr">
                      <td className="table-td font-medium text-gray-900">{f.name}</td>
                      <td className="table-td text-gray-500 text-sm">{f.member_count}</td>
                      <td className="table-td text-gray-500 text-sm">{f.program_count}</td>
                      <td className="table-td text-gray-500 text-sm">{f.project_count}</td>
                    </tr>
                  ))}
                  {orgs?.length === 0 && (
                    <tr><td colSpan={4} className="table-td text-center text-gray-400 py-8">No organizations yet.</td></tr>
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
              Everyone listed here belongs to <span className="font-medium text-gray-700">{selectedOrg.get()?.name || 'this organization'}</span> and
              Administrators see everything in it; members see only the projects they're added to.
            </p>
            <p className="text-xs text-gray-500 leading-relaxed mt-2">
              Locked out? They can reset it themselves from "Forgot your password?" on the sign-in page, once
              email sending is set up. Until then, edit them here and set a new password.
            </p>
          </div>
        </div>
      </div>

      {confirmDialog}
      {inviting && (
        <InviteModal onClose={() => setInviting(false)} onSent={load} />
      )}
      {editing !== undefined && (
        <PersonModal
          person={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}
      {addingOrg && (
        <FirmModal onClose={() => setAddingOrg(false)} onSaved={() => { setAddingOrg(false); load(); }} />
      )}
    </div>
  );
}
