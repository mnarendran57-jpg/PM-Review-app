import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { projectsApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';

const EMPTY = {
  project_name: '', project_number: '', client_name: '',
  project_type: 'MEP', project_type_other: '', contract_value: '', start_date: '',
  projected_end_date: '', status: 'Active', project_manager: '', notes: ''
};

const PROJECT_TYPES = ['MEP', 'Electrical', 'Mechanical', 'Plumbing', 'General'];
const STATUSES = ['Active', 'On Hold', 'Closed'];

function fmt$(n) {
  if (!n) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(n);
}

function ProjectForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">Project Name *</label>
          <input className="input" required value={form.project_name} onChange={set('project_name')} />
        </div>
        <div>
          <label className="label">Project Number</label>
          <input className="input" value={form.project_number} onChange={set('project_number')} />
        </div>
        <div>
          <label className="label">Client Name</label>
          <input className="input" value={form.client_name} onChange={set('client_name')} />
        </div>
        <div>
          <label className="label">Project Type</label>
          <select className="input" value={form.project_type} onChange={e => setForm(f => ({ ...f, project_type: e.target.value, project_type_other: '' }))}>
            {PROJECT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        {form.project_type === 'General' && (
          <div>
            <label className="label">Specify Type</label>
            <input
              className="input"
              placeholder="e.g. Civil, Structural, Commissioning…"
              value={form.project_type_other || ''}
              onChange={e => setForm(f => ({ ...f, project_type_other: e.target.value }))}
            />
          </div>
        )}
        <div>
          <label className="label">Contract Value ($)</label>
          <input className="input" type="number" step="0.01" value={form.contract_value} onChange={set('contract_value')} />
        </div>
        <div>
          <label className="label">Start Date</label>
          <input className="input" type="date" value={form.start_date} onChange={set('start_date')} />
        </div>
        <div>
          <label className="label">Projected End Date</label>
          <input className="input" type="date" value={form.projected_end_date} onChange={set('projected_end_date')} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={set('status')}>
            {STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Project Manager</label>
          <input className="input" value={form.project_manager} onChange={set('project_manager')} />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save Project</button>
      </div>
    </form>
  );
}

function StatPill({ label, value, color }) {
  const styles = {
    blue:   { bg: '#eff6ff', num: '#1d4ed8', txt: '#3b82f6' },
    amber:  { bg: '#fffbeb', num: '#b45309', txt: '#d97706' },
    purple: { bg: '#faf5ff', num: '#6d28d9', txt: '#8b5cf6' },
    green:  { bg: '#f0fdf4', num: '#15803d', txt: '#16a34a' },
  };
  const s = styles[color] || styles.blue;
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold"
      style={{ background: s.bg }}>
      <span className="text-xl font-bold" style={{ color: s.num }}>{value}</span>
      <span style={{ color: s.txt }}>{label}</span>
    </div>
  );
}

function ProjectRow({ project, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="table-tr cursor-pointer" onClick={() => setExpanded(x => !x)}>
        <td className="table-td font-medium text-gray-900">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronUpIcon className="w-4 h-4 text-gray-400" /> : <ChevronDownIcon className="w-4 h-4 text-gray-400" />}
            {project.project_name}
          </div>
        </td>
        <td className="table-td text-gray-500">{project.project_number || '—'}</td>
        <td className="table-td">{project.client_name || '—'}</td>
        <td className="table-td">
          <span className="badge bg-slate-100 text-slate-700">
            {project.project_type === 'General' && project.project_type_other
              ? project.project_type_other
              : project.project_type}
          </span>
        </td>
        <td className="table-td font-medium">{fmt$(project.contract_value)}</td>
        <td className="table-td">{project.project_manager || '—'}</td>
        <td className="table-td"><StatusBadge status={project.status} /></td>
        <td className="table-td" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <button className="btn-secondary px-2 py-1" onClick={() => onEdit(project)}>
              <PencilIcon className="w-4 h-4" />
            </button>
            <button className="btn-danger" onClick={() => onDelete(project.id)}>
              <TrashIcon className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50">
          <td colSpan={8} className="px-8 py-4">
            <div className="flex items-center gap-3 flex-wrap">
              <StatPill label="Open RFIs" value={project.open_rfis ?? 0} color="blue" />
              <StatPill label="Pending Submittals" value={project.pending_submittals ?? 0} color="amber" />
              <StatPill label="Pay Apps Under Review" value={project.pay_apps_under_review ?? 0} color="purple" />
              <StatPill label="AI Reviews" value={project.ai_reviews ?? 0} color="green" />
              {project.notes && (
                <p className="text-sm text-gray-500 mt-2 w-full">{project.notes}</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [filter, setFilter] = useState('');
  const [saveError, setSaveError] = useState('');

  const load = () => projectsApi.list().then(setProjects);
  useEffect(() => { load(); }, []);

  const handleSave = async form => {
    setSaveError('');
    try {
      if (editTarget) {
        await projectsApi.update(editTarget.id, form);
      } else {
        await projectsApi.create(form);
      }
      setModal(null);
      setEditTarget(null);
      load();
    } catch (err) {
      setSaveError(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    }
  };

  const handleDelete = async id => {
    if (!confirm('Delete this project? Associated records will not be deleted.')) return;
    await projectsApi.delete(id);
    load();
  };

  const openEdit = p => { setEditTarget(p); setModal('form'); };
  const openNew = () => { setEditTarget(null); setModal('form'); };

  const filtered = projects.filter(p =>
    !filter || p.project_name.toLowerCase().includes(filter.toLowerCase()) ||
    (p.client_name || '').toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="p-8">
      <PageHeader
        title="Projects"
        subtitle={`${projects.filter(p => p.status === 'Active').length} active projects`}
        actions={
          <>
            <input
              className="input w-56 py-1.5"
              placeholder="Search projects…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <button className="btn-primary" onClick={openNew}>
              <PlusIcon className="w-4 h-4" /> New Project
            </button>
          </>
        }
      />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Active', color: '#15803d', bg: '#f0fdf4', num: '#166534' },
          { label: 'On Hold', color: '#a16207', bg: '#fefce8', num: '#854d0e' },
          { label: 'Closed', color: '#6b7280', bg: '#f9fafb', num: '#374151' },
        ].map(({ label, color, bg, num }) => (
          <div key={label} className="card px-5 py-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: bg }}>
              <span className="text-lg font-black" style={{ color: num }}>
                {projects.filter(p => p.status === label).length}
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">{label}</p>
              <p className="text-xs text-gray-400">Projects</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
            <tr>
              <th className="table-th">Project Name</th>
              <th className="table-th">Number</th>
              <th className="table-th">Client</th>
              <th className="table-th">Type</th>
              <th className="table-th">Contract Value</th>
              <th className="table-th">PM</th>
              <th className="table-th">Status</th>
              <th className="table-th"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="table-td text-center text-gray-400 py-12">
                  No projects yet. Click "New Project" to add one.
                </td>
              </tr>
            )}
            {filtered.map(p => (
              <ProjectRow key={p.id} project={p} onEdit={openEdit} onDelete={handleDelete} />
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'form' && (
        <Modal
          title={editTarget ? 'Edit Project' : 'New Project'}
          onClose={() => { setSaveError(''); setModal(null); setEditTarget(null); }}
          size="lg"
        >
          {saveError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{saveError}</div>
          )}
          <ProjectForm
            initial={editTarget ? { ...editTarget, project_type_other: editTarget.project_type_other || '' } : { ...EMPTY }}
            onSave={handleSave}
            onCancel={() => { setSaveError(''); setModal(null); setEditTarget(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
