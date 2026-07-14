import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, CheckIcon, Cog6ToothIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { teamApi, settingsApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import MemoTemplateEditor from '../components/MemoTemplateEditor';

function MemberAvatar({ name }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const colors = [
    ['#eff6ff', '#1d4ed8'], ['#f0fdf4', '#15803d'], ['#faf5ff', '#7e22ce'],
    ['#fff7ed', '#c2410c'], ['#fef2f2', '#b91c1c'], ['#fefce8', '#a16207'],
  ];
  const idx = name.charCodeAt(0) % colors.length;
  const [bg, color] = colors[idx];
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
      style={{ background: bg, color }}>
      {initials}
    </div>
  );
}

function TeamMemberForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial || { name: '', role: '', email: '' });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div>
        <label className="label">Name *</label>
        <input className="input" required value={form.name} onChange={set('name')} />
      </div>
      <div>
        <label className="label">Role / Title</label>
        <input className="input" value={form.role} onChange={set('role')} placeholder="Project Engineer, PM, etc." />
      </div>
      <div>
        <label className="label">Email</label>
        <input className="input" type="email" value={form.email} onChange={set('email')} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save Member</button>
      </div>
    </form>
  );
}

export default function Settings() {
  const [team, setTeam] = useState([]);
  const [settings, setSettings] = useState({ rfi_response_days: '10', submittal_review_days: '14' });
  const [saved, setSaved] = useState(false);
  const [modal, setModal] = useState(null);
  const [editMember, setEditMember] = useState(null);

  const loadTeam = () => teamApi.list().then(setTeam);
  useEffect(() => {
    loadTeam();
    settingsApi.get().then(setSettings);
  }, []);

  const saveMember = async form => {
    if (editMember) await teamApi.update(editMember.id, form);
    else await teamApi.create(form);
    setModal(null); setEditMember(null); loadTeam();
  };

  const deleteMember = async id => {
    if (!confirm('Remove this team member?')) return;
    await teamApi.delete(id); loadTeam();
  };

  const saveSettings = async () => {
    await settingsApi.update(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="p-8">
      <PageHeader title="Team &amp; Settings" subtitle="Manage team members and default configuration" />

      <div className="grid grid-cols-5 gap-6">
        {/* Team members */}
        <div className="col-span-3">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between"
              style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <div className="flex items-center gap-2">
                <UserGroupIcon className="w-4 h-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-900">Team Members</h2>
                <span className="ml-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{ background: '#f1f5f9', color: '#64748b' }}>
                  {team.length}
                </span>
              </div>
              <button className="btn-primary" onClick={() => { setEditMember(null); setModal('member'); }}>
                <PlusIcon className="w-4 h-4" /> Add Member
              </button>
            </div>
            <table className="w-full">
              <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <tr>
                  <th className="table-th">Name</th>
                  <th className="table-th">Role</th>
                  <th className="table-th">Email</th>
                  <th className="table-th"></th>
                </tr>
              </thead>
              <tbody>
                {team.length === 0 && (
                  <tr>
                    <td colSpan={4} className="table-td text-center text-gray-400 py-10">
                      No team members yet. Click "Add Member" to get started.
                    </td>
                  </tr>
                )}
                {team.map(m => (
                  <tr key={m.id} className="table-tr">
                    <td className="table-td">
                      <div className="flex items-center gap-3">
                        <MemberAvatar name={m.name} />
                        <span className="font-medium text-gray-900">{m.name}</span>
                      </div>
                    </td>
                    <td className="table-td text-gray-500 text-sm">{m.role || '—'}</td>
                    <td className="table-td text-gray-400 text-xs">{m.email || '—'}</td>
                    <td className="table-td">
                      <div className="flex gap-1">
                        <button className="btn-secondary px-2 py-1" onClick={() => { setEditMember(m); setModal('member'); }}>
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        <button className="btn-danger" onClick={() => deleteMember(m.id)}>
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Settings panel */}
        <div className="col-span-2 space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 flex items-center gap-2"
              style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <Cog6ToothIcon className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Default Due Date Rules</h2>
            </div>
            <div className="p-5 space-y-5">
              <div>
                <label className="label">RFI Response Days</label>
                <div className="flex items-center gap-3">
                  <input
                    className="input w-24"
                    type="number"
                    min="1"
                    value={settings.rfi_response_days}
                    onChange={e => setSettings(s => ({ ...s, rfi_response_days: e.target.value }))}
                  />
                  <span className="text-sm text-gray-500">days from submission</span>
                </div>
              </div>
              <div>
                <label className="label">Submittal Review Days</label>
                <div className="flex items-center gap-3">
                  <input
                    className="input w-24"
                    type="number"
                    min="1"
                    value={settings.submittal_review_days}
                    onChange={e => setSettings(s => ({ ...s, submittal_review_days: e.target.value }))}
                  />
                  <span className="text-sm text-gray-500">days from forwarded date</span>
                </div>
              </div>
              <button
                className="btn-primary w-full justify-center"
                onClick={saveSettings}
                style={saved ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
              >
                {saved ? (
                  <span className="flex items-center gap-2">
                    <CheckIcon className="w-4 h-4" /> Saved
                  </span>
                ) : 'Save Settings'}
              </button>
            </div>
          </div>

          {/* About card */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4"
              style={{ background: 'linear-gradient(135deg, #0d1117 0%, #1e293b 100%)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  PM Review
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
                  v1.0
                </span>
              </div>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>Olivier Inc. · MEP Construction Management</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-gray-500 leading-relaxed">
                Internal project management tool for Olivier Inc. Data stored locally in SQLite.
                AI document reviews powered by the Anthropic Claude API.
              </p>
              <p className="text-xs text-gray-400 mt-3 pt-3" style={{ borderTop: '1px solid #f3f4f6' }}>
                Internal Use Only
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <MemoTemplateEditor />
      </div>

      {modal === 'member' && (
        <Modal
          title={editMember ? 'Edit Team Member' : 'Add Team Member'}
          onClose={() => { setModal(null); setEditMember(null); }}
          size="sm"
        >
          <TeamMemberForm
            initial={editMember || { name: '', role: '', email: '' }}
            onSave={saveMember}
            onCancel={() => { setModal(null); setEditMember(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
