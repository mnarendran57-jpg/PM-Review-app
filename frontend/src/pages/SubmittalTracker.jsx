import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import * as XLSX from 'xlsx';
import { submittalsApi, projectsApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';

const ACTIONS = ['Pending', 'Approved', 'Approved as Noted', 'Revise and Resubmit', 'Rejected'];

const EMPTY = {
  submittal_number: '', project_id: '', spec_section: '', description: '',
  submitted_by: '', date_received: '', date_forwarded: '', date_response_due: '',
  date_returned: '', review_action: 'Pending', revision_number: 0, notes: ''
};

function isOverdue(s) {
  if (s.review_action !== 'Pending') return false;
  if (!s.date_response_due) return false;
  return new Date(s.date_response_due) < new Date();
}

function SubmittalForm({ initial, projects, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleForwardedChange = e => {
    const date = e.target.value;
    setForm(f => {
      const next = { ...f, date_forwarded: date };
      if (date && !f.date_response_due) {
        const d = new Date(date);
        d.setDate(d.getDate() + 14);
        next.date_response_due = d.toISOString().slice(0, 10);
      }
      return next;
    });
  };

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Submittal Number *</label>
          <input className="input" required value={form.submittal_number} onChange={set('submittal_number')} placeholder="S-001" />
        </div>
        <div>
          <label className="label">Project</label>
          <select className="input" value={form.project_id} onChange={set('project_id')}>
            <option value="">— Select —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Spec Section</label>
          <input className="input" value={form.spec_section} onChange={set('spec_section')} placeholder="23 05 00 — HVAC" />
        </div>
        <div>
          <label className="label">Revision Number</label>
          <input className="input" type="number" min="0" value={form.revision_number} onChange={set('revision_number')} />
        </div>
        <div className="col-span-2">
          <label className="label">Description / Title *</label>
          <input className="input" required value={form.description} onChange={set('description')} />
        </div>
        <div>
          <label className="label">Submitted By (Subcontractor)</label>
          <input className="input" value={form.submitted_by} onChange={set('submitted_by')} />
        </div>
        <div>
          <label className="label">Review Action</label>
          <select className="input" value={form.review_action} onChange={set('review_action')}>
            {ACTIONS.map(a => <option key={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Date Received</label>
          <input className="input" type="date" value={form.date_received} onChange={set('date_received')} />
        </div>
        <div>
          <label className="label">Date Forwarded to EOR</label>
          <input className="input" type="date" value={form.date_forwarded} onChange={handleForwardedChange} />
        </div>
        <div>
          <label className="label">Response Due</label>
          <input className="input" type="date" value={form.date_response_due} onChange={set('date_response_due')} />
        </div>
        <div>
          <label className="label">Date Returned</label>
          <input className="input" type="date" value={form.date_returned} onChange={set('date_returned')} />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save Submittal</button>
      </div>
    </form>
  );
}

export default function SubmittalTracker() {
  const [submittals, setSubmittals] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [filters, setFilters] = useState({ project_id: '', review_action: '', spec_section: '' });

  const load = () => submittalsApi.list(filters).then(setSubmittals);
  useEffect(() => { load(); }, [filters]);
  useEffect(() => { projectsApi.list().then(setProjects); }, []);

  const handleSave = async form => {
    if (editTarget) await submittalsApi.update(editTarget.id, form);
    else await submittalsApi.create(form);
    setModal(null); setEditTarget(null); load();
  };

  const handleDelete = async id => {
    if (!confirm('Delete this submittal?')) return;
    await submittalsApi.delete(id); load();
  };

  const exportXLSX = () => {
    const rows = submittals.map(s => ({
      'Submittal #': s.submittal_number,
      'Project': s.project_name || '',
      'Spec Section': s.spec_section || '',
      'Description': s.description,
      'Submitted By': s.submitted_by || '',
      'Date Received': s.date_received || '',
      'Date Forwarded': s.date_forwarded || '',
      'Response Due': s.date_response_due || '',
      'Date Returned': s.date_returned || '',
      'Review Action': s.review_action,
      'Revision': s.revision_number,
      'Notes': s.notes || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Submittals');
    XLSX.writeFile(wb, 'Submittal_Tracker.xlsx');
  };

  const setFilter = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));
  const pendingCount = submittals.filter(s => s.review_action === 'Pending').length;
  const overdueCount = submittals.filter(isOverdue).length;

  return (
    <div className="p-8">
      <PageHeader
        title="Submittal Tracker"
        subtitle={`${pendingCount} pending · ${overdueCount > 0 ? `${overdueCount} overdue` : 'none overdue'}`}
        actions={
          <>
            <button className="btn-secondary" onClick={exportXLSX}>
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button className="btn-primary" onClick={() => { setEditTarget(null); setModal('form'); }}>
              <PlusIcon className="w-4 h-4" /> New Submittal
            </button>
          </>
        }
      />

      <div className="flex items-center gap-3 mb-5">
        <select className="input py-1.5 text-sm w-52" value={filters.project_id} onChange={setFilter('project_id')}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
        </select>
        <select className="input py-1.5 text-sm w-44" value={filters.review_action} onChange={setFilter('review_action')}>
          <option value="">All Actions</option>
          {ACTIONS.map(a => <option key={a}>{a}</option>)}
        </select>
        <input
          className="input py-1.5 text-sm w-44"
          placeholder="Filter by spec section…"
          value={filters.spec_section}
          onChange={setFilter('spec_section')}
        />
        {Object.values(filters).some(Boolean) && (
          <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setFilters({ project_id: '', review_action: '', spec_section: '' })}>
            Clear
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[950px]">
            <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <tr>
                <th className="table-th">Sub #</th>
                <th className="table-th">Project</th>
                <th className="table-th">Spec Section</th>
                <th className="table-th">Description</th>
                <th className="table-th">Submitted By</th>
                <th className="table-th">Response Due</th>
                <th className="table-th">Rev.</th>
                <th className="table-th">Action</th>
                <th className="table-th"></th>
              </tr>
            </thead>
            <tbody>
              {submittals.length === 0 && (
                <tr><td colSpan={9} className="table-td text-center text-gray-400 py-12">No submittals found.</td></tr>
              )}
              {submittals.map(s => (
                <tr key={s.id} className={`table-tr ${isOverdue(s) ? 'bg-red-50 hover:bg-red-100' : ''}`}>
                  <td className="table-td font-mono text-xs font-semibold text-gray-700">{s.submittal_number}</td>
                  <td className="table-td text-gray-500 text-xs">{s.project_name || '—'}</td>
                  <td className="table-td text-xs text-gray-500">{s.spec_section || '—'}</td>
                  <td className="table-td font-medium max-w-xs">
                    <span className="truncate block" title={s.description}>{s.description}</span>
                    {isOverdue(s) && <span className="text-xs text-red-600 font-semibold">OVERDUE</span>}
                  </td>
                  <td className="table-td text-gray-500 text-xs">{s.submitted_by || '—'}</td>
                  <td className={`table-td text-xs ${isOverdue(s) ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                    {s.date_response_due || '—'}
                  </td>
                  <td className="table-td text-center text-sm">{s.revision_number ?? 0}</td>
                  <td className="table-td"><StatusBadge status={s.review_action} /></td>
                  <td className="table-td">
                    <div className="flex items-center gap-1">
                      <button className="btn-secondary px-2 py-1" onClick={() => { setEditTarget(s); setModal('form'); }}>
                        <PencilIcon className="w-4 h-4" />
                      </button>
                      <button className="btn-danger" onClick={() => handleDelete(s.id)}>
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

      {modal === 'form' && (
        <Modal
          title={editTarget ? 'Edit Submittal' : 'New Submittal'}
          onClose={() => { setModal(null); setEditTarget(null); }}
          size="xl"
        >
          <SubmittalForm
            initial={editTarget ? { ...editTarget, project_id: editTarget.project_id || '' } : { ...EMPTY }}
            projects={projects}
            onSave={handleSave}
            onCancel={() => { setModal(null); setEditTarget(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
