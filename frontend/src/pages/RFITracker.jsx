import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import * as XLSX from 'xlsx';
import { rfisApi, projectsApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';

const STATUSES = ['Open', 'Answered', 'Closed', 'On Hold'];
const PRIORITIES = ['High', 'Medium', 'Low'];

const EMPTY = {
  rfi_number: '', project_id: '', title: '', submitted_by: '', submitted_to: '',
  date_submitted: '', date_response_due: '', date_responded: '',
  status: 'Open', priority: 'Medium', description: '', response: '', linked_document: ''
};

function isOverdue(rfi) {
  if (rfi.status !== 'Open') return false;
  if (!rfi.date_response_due) return false;
  return new Date(rfi.date_response_due) < new Date();
}

function RFIForm({ initial, projects, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleDateChange = e => {
    const date = e.target.value;
    setForm(f => {
      const next = { ...f, date_submitted: date };
      if (date && !f.date_response_due) {
        const d = new Date(date);
        d.setDate(d.getDate() + 10);
        next.date_response_due = d.toISOString().slice(0, 10);
      }
      return next;
    });
  };

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">RFI Number *</label>
          <input className="input" required value={form.rfi_number} onChange={set('rfi_number')} placeholder="RFI-001" />
        </div>
        <div>
          <label className="label">Project</label>
          <select className="input" value={form.project_id} onChange={set('project_id')}>
            <option value="">— Select —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Title / Subject *</label>
          <input className="input" required value={form.title} onChange={set('title')} />
        </div>
        <div>
          <label className="label">Submitted By</label>
          <input className="input" value={form.submitted_by} onChange={set('submitted_by')} />
        </div>
        <div>
          <label className="label">Submitted To</label>
          <input className="input" value={form.submitted_to} onChange={set('submitted_to')} />
        </div>
        <div>
          <label className="label">Date Submitted</label>
          <input className="input" type="date" value={form.date_submitted} onChange={handleDateChange} />
        </div>
        <div>
          <label className="label">Response Due</label>
          <input className="input" type="date" value={form.date_response_due} onChange={set('date_response_due')} />
        </div>
        <div>
          <label className="label">Date Responded</label>
          <input className="input" type="date" value={form.date_responded} onChange={set('date_responded')} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={set('status')}>
            {STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Priority</label>
          <select className="input" value={form.priority} onChange={set('priority')}>
            {PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Linked Document / Note</label>
          <input className="input" value={form.linked_document} onChange={set('linked_document')} placeholder="eBuilder ref, filename, etc." />
        </div>
        <div className="col-span-2">
          <label className="label">Description</label>
          <textarea className="input" rows={3} value={form.description} onChange={set('description')} />
        </div>
        <div className="col-span-2">
          <label className="label">Response</label>
          <textarea className="input" rows={3} value={form.response} onChange={set('response')} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save RFI</button>
      </div>
    </form>
  );
}

export default function RFITracker() {
  const [rfis, setRfis] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [filters, setFilters] = useState({ project_id: '', status: '', priority: '' });

  const load = () => rfisApi.list(filters).then(setRfis);
  useEffect(() => { load(); }, [filters]);
  useEffect(() => { projectsApi.list().then(setProjects); }, []);

  const handleSave = async form => {
    if (editTarget) await rfisApi.update(editTarget.id, form);
    else await rfisApi.create(form);
    setModal(null); setEditTarget(null); load();
  };

  const handleDelete = async id => {
    if (!confirm('Delete this RFI?')) return;
    await rfisApi.delete(id); load();
  };

  const openEdit = r => { setEditTarget(r); setModal('form'); };
  const openNew = () => { setEditTarget(null); setModal('form'); };

  const exportXLSX = () => {
    const rows = rfis.map(r => ({
      'RFI #': r.rfi_number,
      'Project': r.project_name || '',
      'Title': r.title,
      'Submitted By': r.submitted_by || '',
      'Submitted To': r.submitted_to || '',
      'Date Submitted': r.date_submitted || '',
      'Response Due': r.date_response_due || '',
      'Date Responded': r.date_responded || '',
      'Status': r.status,
      'Priority': r.priority,
      'Description': r.description || '',
      'Response': r.response || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'RFIs');
    XLSX.writeFile(wb, 'RFI_Tracker.xlsx');
  };

  const setFilter = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));

  const openCount = rfis.filter(r => r.status === 'Open').length;
  const overdueCount = rfis.filter(isOverdue).length;

  return (
    <div className="p-8">
      <PageHeader
        title="RFI Tracker"
        subtitle={`${openCount} open · ${overdueCount > 0 ? `${overdueCount} overdue` : 'none overdue'}`}
        actions={
          <>
            <button className="btn-secondary" onClick={exportXLSX}>
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button className="btn-primary" onClick={openNew}>
              <PlusIcon className="w-4 h-4" /> New RFI
            </button>
          </>
        }
      />

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <select className="input py-1.5 text-sm w-52" value={filters.project_id} onChange={setFilter('project_id')}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
        </select>
        <select className="input py-1.5 text-sm w-36" value={filters.status} onChange={setFilter('status')}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
        <select className="input py-1.5 text-sm w-36" value={filters.priority} onChange={setFilter('priority')}>
          <option value="">All Priorities</option>
          {PRIORITIES.map(p => <option key={p}>{p}</option>)}
        </select>
        {Object.values(filters).some(Boolean) && (
          <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setFilters({ project_id: '', status: '', priority: '' })}>
            Clear filters
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <tr>
                <th className="table-th">RFI #</th>
                <th className="table-th">Project</th>
                <th className="table-th">Title</th>
                <th className="table-th">Submitted By</th>
                <th className="table-th">Due Date</th>
                <th className="table-th">Status</th>
                <th className="table-th">Priority</th>
                <th className="table-th"></th>
              </tr>
            </thead>
            <tbody>
              {rfis.length === 0 && (
                <tr><td colSpan={8} className="table-td text-center text-gray-400 py-12">No RFIs found.</td></tr>
              )}
              {rfis.map(r => (
                <tr key={r.id} className={`table-tr ${isOverdue(r) ? 'bg-red-50 hover:bg-red-100' : ''}`}>
                  <td className="table-td font-mono text-xs font-semibold text-gray-700">{r.rfi_number}</td>
                  <td className="table-td text-gray-500 text-xs">{r.project_name || '—'}</td>
                  <td className="table-td font-medium max-w-xs">
                    <span className="truncate block" title={r.title}>{r.title}</span>
                    {isOverdue(r) && <span className="text-xs text-red-600 font-semibold">OVERDUE</span>}
                  </td>
                  <td className="table-td text-gray-500">{r.submitted_by || '—'}</td>
                  <td className={`table-td text-xs ${isOverdue(r) ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                    {r.date_response_due || '—'}
                  </td>
                  <td className="table-td"><StatusBadge status={r.status} /></td>
                  <td className="table-td"><StatusBadge status={r.priority} /></td>
                  <td className="table-td">
                    <div className="flex items-center gap-1">
                      <button className="btn-secondary px-2 py-1" onClick={() => openEdit(r)}>
                        <PencilIcon className="w-4 h-4" />
                      </button>
                      <button className="btn-danger" onClick={() => handleDelete(r.id)}>
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
          title={editTarget ? 'Edit RFI' : 'New RFI'}
          onClose={() => { setModal(null); setEditTarget(null); }}
          size="xl"
        >
          <RFIForm
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
