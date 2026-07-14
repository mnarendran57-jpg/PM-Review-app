import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import { financeApi, projectsApi } from '../api';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';

const PA_STATUSES = ['Received', 'Under Review', 'Approved', 'Sent to Client', 'Paid'];
const INV_STATUSES = ['Received', 'Approved', 'Submitted', 'Paid'];

const EMPTY_PA = {
  project_id: '', subcontractor: '', application_number: '', period_start: '', period_end: '',
  scheduled_value: '', previously_billed: '', current_billing: '', retainage_pct: '10',
  net_amount_due: '', status: 'Received', notes: ''
};

const EMPTY_INV = {
  project_id: '', vendor: '', invoice_number: '', invoice_date: '',
  amount: '', po_number: '', status: 'Received', notes: ''
};

function fmt$(n) {
  if (n === null || n === undefined || n === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(Number(n));
}

function SummaryCard({ label, value, sub }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{fmt$(value)}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function PayAppForm({ initial, projects, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const calcNet = (f) => {
    const curr = parseFloat(f.current_billing) || 0;
    const ret = parseFloat(f.retainage_pct) || 0;
    return (curr * (1 - ret / 100)).toFixed(2);
  };

  const handleNumChange = k => e => {
    setForm(f => {
      const next = { ...f, [k]: e.target.value };
      next.net_amount_due = calcNet(next);
      return next;
    });
  };

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Project</label>
          <select className="input" value={form.project_id} onChange={set('project_id')}>
            <option value="">— Select —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Subcontractor / Vendor *</label>
          <input className="input" required value={form.subcontractor} onChange={set('subcontractor')} />
        </div>
        <div>
          <label className="label">Application Number</label>
          <input className="input" value={form.application_number} onChange={set('application_number')} placeholder="PA-01" />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={set('status')}>
            {PA_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Period Start</label>
          <input className="input" type="date" value={form.period_start} onChange={set('period_start')} />
        </div>
        <div>
          <label className="label">Period End</label>
          <input className="input" type="date" value={form.period_end} onChange={set('period_end')} />
        </div>
        <div>
          <label className="label">Scheduled Value ($)</label>
          <input className="input" type="number" step="0.01" value={form.scheduled_value} onChange={handleNumChange('scheduled_value')} />
        </div>
        <div>
          <label className="label">Previously Billed ($)</label>
          <input className="input" type="number" step="0.01" value={form.previously_billed} onChange={handleNumChange('previously_billed')} />
        </div>
        <div>
          <label className="label">Current Billing ($)</label>
          <input className="input" type="number" step="0.01" value={form.current_billing} onChange={handleNumChange('current_billing')} />
        </div>
        <div>
          <label className="label">Retainage (%)</label>
          <input className="input" type="number" step="0.1" value={form.retainage_pct} onChange={handleNumChange('retainage_pct')} />
        </div>
        <div>
          <label className="label">Net Amount Due ($) <span className="text-amber-600 font-normal">(auto)</span></label>
          <input className="input bg-gray-50" readOnly value={form.net_amount_due} />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save Pay Application</button>
      </div>
    </form>
  );
}

function InvoiceForm({ initial, projects, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Project</label>
          <select className="input" value={form.project_id} onChange={set('project_id')}>
            <option value="">— Select —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Vendor *</label>
          <input className="input" required value={form.vendor} onChange={set('vendor')} />
        </div>
        <div>
          <label className="label">Invoice Number</label>
          <input className="input" value={form.invoice_number} onChange={set('invoice_number')} />
        </div>
        <div>
          <label className="label">Invoice Date</label>
          <input className="input" type="date" value={form.invoice_date} onChange={set('invoice_date')} />
        </div>
        <div>
          <label className="label">Amount ($)</label>
          <input className="input" type="number" step="0.01" value={form.amount} onChange={set('amount')} />
        </div>
        <div>
          <label className="label">PO Number</label>
          <input className="input" value={form.po_number} onChange={set('po_number')} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={set('status')}>
            {INV_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary">Save Invoice</button>
      </div>
    </form>
  );
}

export default function Finance() {
  const [tab, setTab] = useState('payapps');
  const [payapps, setPayapps] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [projects, setProjects] = useState([]);
  const [summary, setSummary] = useState(null);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [filterProject, setFilterProject] = useState('');

  const load = () => {
    financeApi.payapps(filterProject ? { project_id: filterProject } : {}).then(setPayapps);
    financeApi.invoices(filterProject ? { project_id: filterProject } : {}).then(setInvoices);
    financeApi.summary().then(setSummary);
  };

  useEffect(() => { load(); projectsApi.list().then(setProjects); }, [filterProject]);

  const handleSavePA = async form => {
    if (editTarget) await financeApi.updatePayapp(editTarget.id, form);
    else await financeApi.createPayapp(form);
    setModal(null); setEditTarget(null); load();
  };

  const handleSaveInv = async form => {
    if (editTarget) await financeApi.updateInvoice(editTarget.id, form);
    else await financeApi.createInvoice(form);
    setModal(null); setEditTarget(null); load();
  };

  const deletePA = async id => {
    if (!confirm('Delete this pay application?')) return;
    await financeApi.deletePayapp(id); load();
  };

  const deleteInv = async id => {
    if (!confirm('Delete this invoice?')) return;
    await financeApi.deleteInvoice(id); load();
  };

  return (
    <div className="p-8">
      <PageHeader title="Pay Apps & Invoices" subtitle="Financial tracking for all projects" />

      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Billed This Month', value: summary.billed_this_month, bg: '#eff6ff', num: '#1d4ed8', sub: '#93c5fd' },
            { label: 'Pending Approval',  value: summary.pending_approval,  bg: '#fffbeb', num: '#b45309', sub: '#fcd34d' },
            { label: 'Paid YTD',          value: summary.paid_ytd,          bg: '#f0fdf4', num: '#15803d', sub: '#86efac' },
          ].map(({ label, value, bg, num }) => (
            <div key={label} className="card px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-2">{label}</p>
              <p className="text-2xl font-bold tracking-tight" style={{ color: num }}>{fmt$(value)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Project breakdown */}
      {summary?.by_project?.length > 0 && (
        <div className="card p-5 mb-6 overflow-x-auto">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-4">Breakdown by Project</p>
          <table className="w-full min-w-[500px]">
            <thead>
              <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                <th className="table-th">Project</th>
                <th className="table-th text-right">Billed</th>
                <th className="table-th text-right">Pending</th>
                <th className="table-th text-right">Paid</th>
              </tr>
            </thead>
            <tbody>
              {summary.by_project.map(p => (
                <tr key={p.project_name} className="table-tr">
                  <td className="table-td font-medium">{p.project_name}</td>
                  <td className="table-td text-right text-gray-600">{fmt$(p.billed)}</td>
                  <td className="table-td text-right font-medium" style={{ color: '#b45309' }}>{fmt$(p.pending)}</td>
                  <td className="table-td text-right font-medium" style={{ color: '#15803d' }}>{fmt$(p.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-5 p-1 rounded-xl w-fit"
        style={{ background: '#edf0f4' }}>
        {[
          { key: 'payapps', label: `Pay Applications`, count: payapps.length },
          { key: 'invoices', label: `Invoices`, count: invoices.length },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className="px-4 py-1.5 text-sm font-semibold rounded-lg transition-all duration-150"
            style={tab === t.key
              ? { background: '#fff', color: '#111827', boxShadow: '0 1px 4px rgba(0,0,0,0.1)' }
              : { background: 'transparent', color: '#6b7280' }}>
            {t.label} <span className="ml-1 text-xs opacity-60">({t.count})</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-5">
        <div className="flex-1" />
        <select className="input py-1.5 text-sm w-48" value={filterProject} onChange={e => setFilterProject(e.target.value)}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
        </select>
        <button className="btn-primary" onClick={() => { setEditTarget(null); setModal(tab === 'payapps' ? 'pa' : 'inv'); }}>
          <PlusIcon className="w-4 h-4" /> {tab === 'payapps' ? 'New Pay App' : 'New Invoice'}
        </button>
      </div>

      {/* Pay Apps table */}
      {tab === 'payapps' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
              <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <tr>
                  <th className="table-th">Project</th>
                  <th className="table-th">Subcontractor</th>
                  <th className="table-th">App #</th>
                  <th className="table-th">Period</th>
                  <th className="table-th text-right">Sched. Value</th>
                  <th className="table-th text-right">Curr. Billing</th>
                  <th className="table-th text-right">Ret. %</th>
                  <th className="table-th text-right">Net Due</th>
                  <th className="table-th">Status</th>
                  <th className="table-th"></th>
                </tr>
              </thead>
              <tbody>
                {payapps.length === 0 && (
                  <tr><td colSpan={10} className="table-td text-center text-gray-400 py-12">No pay applications found.</td></tr>
                )}
                {payapps.map(pa => (
                  <tr key={pa.id} className="table-tr">
                    <td className="table-td text-xs text-gray-500">{pa.project_name || '—'}</td>
                    <td className="table-td font-medium">{pa.subcontractor}</td>
                    <td className="table-td font-mono text-xs">{pa.application_number || '—'}</td>
                    <td className="table-td text-xs text-gray-500">
                      {pa.period_start && pa.period_end ? `${pa.period_start} – ${pa.period_end}` : '—'}
                    </td>
                    <td className="table-td text-right text-sm">{fmt$(pa.scheduled_value)}</td>
                    <td className="table-td text-right text-sm">{fmt$(pa.current_billing)}</td>
                    <td className="table-td text-right text-sm">{pa.retainage_pct}%</td>
                    <td className="table-td text-right font-semibold text-gray-900">{fmt$(pa.net_amount_due)}</td>
                    <td className="table-td"><StatusBadge status={pa.status} /></td>
                    <td className="table-td">
                      <div className="flex gap-1">
                        <button className="btn-secondary px-2 py-1" onClick={() => { setEditTarget(pa); setModal('pa'); }}>
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        <button className="btn-danger" onClick={() => deletePA(pa.id)}>
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
      )}

      {/* Invoices table */}
      {tab === 'invoices' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
                <tr>
                  <th className="table-th">Project</th>
                  <th className="table-th">Vendor</th>
                  <th className="table-th">Invoice #</th>
                  <th className="table-th">Date</th>
                  <th className="table-th text-right">Amount</th>
                  <th className="table-th">PO #</th>
                  <th className="table-th">Status</th>
                  <th className="table-th"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 && (
                  <tr><td colSpan={8} className="table-td text-center text-gray-400 py-12">No invoices found.</td></tr>
                )}
                {invoices.map(inv => (
                  <tr key={inv.id} className="table-tr">
                    <td className="table-td text-xs text-gray-500">{inv.project_name || '—'}</td>
                    <td className="table-td font-medium">{inv.vendor}</td>
                    <td className="table-td font-mono text-xs">{inv.invoice_number || '—'}</td>
                    <td className="table-td text-sm text-gray-500">{inv.invoice_date || '—'}</td>
                    <td className="table-td text-right font-semibold">{fmt$(inv.amount)}</td>
                    <td className="table-td text-xs text-gray-500">{inv.po_number || '—'}</td>
                    <td className="table-td"><StatusBadge status={inv.status} /></td>
                    <td className="table-td">
                      <div className="flex gap-1">
                        <button className="btn-secondary px-2 py-1" onClick={() => { setEditTarget(inv); setModal('inv'); }}>
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        <button className="btn-danger" onClick={() => deleteInv(inv.id)}>
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
      )}

      {modal === 'pa' && (
        <Modal title={editTarget ? 'Edit Pay Application' : 'New Pay Application'} onClose={() => { setModal(null); setEditTarget(null); }} size="xl">
          <PayAppForm
            initial={editTarget ? { ...editTarget, project_id: editTarget.project_id || '' } : { ...EMPTY_PA }}
            projects={projects}
            onSave={handleSavePA}
            onCancel={() => { setModal(null); setEditTarget(null); }}
          />
        </Modal>
      )}
      {modal === 'inv' && (
        <Modal title={editTarget ? 'Edit Invoice' : 'New Invoice'} onClose={() => { setModal(null); setEditTarget(null); }} size="lg">
          <InvoiceForm
            initial={editTarget ? { ...editTarget, project_id: editTarget.project_id || '' } : { ...EMPTY_INV }}
            projects={projects}
            onSave={handleSaveInv}
            onCancel={() => { setModal(null); setEditTarget(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
