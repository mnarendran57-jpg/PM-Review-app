import { useState, useEffect } from 'react';
import {
  CloudArrowUpIcon, SparklesIcon, DocumentTextIcon, ArrowDownTrayIcon,
  TrashIcon, ClockIcon, CheckCircleIcon, BuildingOfficeIcon, ArrowPathRoundedSquareIcon,
  Cog6ToothIcon, InboxArrowDownIcon,
} from '@heroicons/react/24/outline';
import { proposalIntakeApi, memoTemplatesApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import MemoTemplateEditor from '../components/MemoTemplateEditor';
import FileDrop from '../components/FileDrop';

const TYPE_INFO = {
  'New Vendor': { bg: '#eff6ff', color: '#1d4ed8' },
  'Change Order': { bg: '#fef2f2', color: '#b91c1c' },
};

function parseMoney(str) {
  const n = parseFloat(String(str ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function HistoryItem({ item, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const tc = TYPE_INFO[item.intake_type] || TYPE_INFO['New Vendor'];
  const priceLine = item.intake_type === 'Change Order'
    ? `CO ${item.change_order_price || '—'} + PO ${item.original_po_amount || '—'} = ${item.new_total_amount || '—'}`
    : item.total_price;
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between" style={{ borderLeft: `3px solid ${tc.color}` }}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide flex-shrink-0"
          style={{ background: tc.bg, color: tc.color }}>
          {item.intake_type}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{item.vendor_name} — {item.project_name}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {priceLine}{item.po_number ? ` · PO #${item.po_number}` : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-secondary px-2 py-1" title="Download merged PDF" onClick={() => proposalIntakeApi.download(item.id, item.merged_file_name)}>
          <ArrowDownTrayIcon className="w-4 h-4" />
        </button>
        <button className="btn-danger" onClick={() => onDelete(item.id)}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export default function ProposalIntake() {
  const ctx = useProject();
  const routeProjectName = ctx?.project?.project_name;
  const [tab, setTab] = useState('intake');
  const [intakeType, setIntakeType] = useState('New Vendor');
  const [proposalFile, setProposalFile] = useState(null);
  const [poFile, setPoFile] = useState(null);
  const [poNumber, setPoNumber] = useState('');
  const [fields, setFields] = useState(null);
  const [toName, setToName] = useState('James Walker');
  const [fromName, setFromName] = useState('Devin Roy');
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const loadHistory = () => proposalIntakeApi.list().then(setHistory);
  useEffect(() => {
    loadHistory();
    memoTemplatesApi.list().then(list => {
      setTemplates(list);
      const def = list.find(t => t.is_default) || list[0];
      if (def) setTemplateId(String(def.id));
    });
  }, []);

  const setField = k => e => setFields(f => ({ ...f, [k]: e.target.value }));

  const handleExtract = async () => {
    if (!proposalFile) { setError('Upload the incoming proposal PDF first.'); return; }
    if (intakeType === 'Change Order' && !poFile) { setError('Upload the existing PO PDF first.'); return; }
    setError(''); setExtracting(true); setResult(null);
    try {
      const proposalFd = new FormData();
      proposalFd.append('file', proposalFile);
      const proposalData = await proposalIntakeApi.extract(proposalFd);

      if (intakeType === 'Change Order') {
        const poFd = new FormData();
        poFd.append('file', poFile);
        const poData = await proposalIntakeApi.extract(poFd);
        setFields({
          ...proposalData,
          change_order_price: proposalData.total_price,
          original_po_amount: poData.total_price,
        });
      } else {
        setFields(proposalData);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not extract fields from this PDF.');
    } finally {
      setExtracting(false);
    }
  };

  const newTotalAmount = intakeType === 'Change Order' && fields
    ? formatMoney(parseMoney(fields.change_order_price) + parseMoney(fields.original_po_amount))
    : null;

  const handleGenerate = async () => {
    if (!proposalFile) { setError('Upload the incoming proposal PDF first.'); return; }
    if (intakeType === 'Change Order' && !poFile) { setError('Upload the existing PO PDF for a change order.'); return; }
    if (!fields) { setError('Extract (or fill in) the memo fields first.'); return; }
    if (intakeType === 'Change Order' && (!fields.change_order_price || !fields.original_po_amount)) {
      setError('Enter both the change order amount and the original PO amount.'); return;
    }
    setError(''); setGenerating(true);
    try {
      const fd = new FormData();
      fd.append('intake_type', intakeType);
      fd.append('vendor_name', fields.vendor_name || '');
      fd.append('project_name', routeProjectName || fields.project_name || '');
      fd.append('proposal_date', fields.proposal_date || '');
      fd.append('scope_of_work', fields.scope_of_work || '');
      if (intakeType === 'Change Order') {
        fd.append('change_order_price', fields.change_order_price || '');
        fd.append('original_po_amount', fields.original_po_amount || '');
      } else {
        fd.append('total_price', fields.total_price || '');
      }
      fd.append('po_number', poNumber || '');
      fd.append('to_name', toName);
      fd.append('from_name', fromName);
      if (templateId) fd.append('memo_template_id', templateId);
      fd.append('proposal_file', proposalFile);
      if (poFile) fd.append('po_file', poFile);
      const data = await proposalIntakeApi.create(fd);
      setResult(data);
      loadHistory();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate the memo.');
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async id => {
    if (!confirm('Remove this processed memo from history? This does not affect the original files.')) return;
    await proposalIntakeApi.delete(id);
    loadHistory();
  };

  const reset = () => {
    setProposalFile(null); setPoFile(null); setPoNumber('');
    setFields(null); setResult(null); setError('');
  };

  return (
    <div className="p-8">
      <PageHeader
        title="Proposal Intake"
        subtitle="Turn an incoming vendor proposal into a signed-ready memo package"
        icon={InboxArrowDownIcon}
        accent="amber"
      />

      <div className="flex items-center gap-2 mb-6">
        {[
          { key: 'intake', label: 'Process Proposals', icon: SparklesIcon },
          { key: 'template', label: 'Memo Template', icon: Cog6ToothIcon },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors"
            style={tab === key
              ? { background: '#111827', color: '#fff' }
              : { background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb' }}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'template' ? (
        <MemoTemplateEditor />
      ) : (
      <div className="grid grid-cols-5 gap-6">
        {/* Wizard panel */}
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #f59e0b, #f97316)' }}>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)' }}>
                <SparklesIcon className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">New Proposal Intake</h2>
            </div>

            {/* Step 1: type */}
            <div>
              <label className="label">Is this a new vendor or a change order?</label>
              <div className="grid grid-cols-2 gap-2">
                {['New Vendor', 'Change Order'].map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setIntakeType(t)}
                    className="px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors"
                    style={intakeType === t
                      ? { background: TYPE_INFO[t].bg, color: TYPE_INFO[t].color, borderColor: TYPE_INFO[t].color }
                      : { background: '#fff', color: '#6b7280', borderColor: '#e5e7eb' }}
                  >
                    {t === 'Change Order' ? <ArrowPathRoundedSquareIcon className="w-4 h-4 inline mr-1.5 -mt-0.5" /> : <BuildingOfficeIcon className="w-4 h-4 inline mr-1.5 -mt-0.5" />}
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: files */}
            <FileDrop file={proposalFile} onChange={setProposalFile} label="Incoming Proposal (PDF) *" />

            {intakeType === 'Change Order' && (
              <>
                <div>
                  <label className="label">Existing PO Number</label>
                  <input className="input" placeholder="e.g. 138670" value={poNumber} onChange={e => setPoNumber(e.target.value)} />
                </div>
                <FileDrop file={poFile} onChange={setPoFile} label="Existing PO (PDF) *" />
              </>
            )}

            <button type="button" className="btn-secondary w-full justify-center" onClick={handleExtract} disabled={extracting || !proposalFile}>
              {extracting ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Reading proposal…
                </span>
              ) : (
                <span className="flex items-center gap-2"><SparklesIcon className="w-4 h-4" /> Extract Details with AI</span>
              )}
            </button>

            {/* Step 3: review extracted fields */}
            {fields && (
              <div className="space-y-3 pt-2" style={{ borderTop: '1px solid #f3f4f6' }}>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 pt-2">Review &amp; edit before generating</p>
                <div>
                  <label className="label">Vendor Name</label>
                  <input className="input" value={fields.vendor_name || ''} onChange={setField('vendor_name')} />
                </div>
                <div>
                  <label className="label">Project Name</label>
                  <input className="input" value={routeProjectName || fields.project_name || ''}
                    onChange={setField('project_name')} readOnly={!!routeProjectName}
                    style={routeProjectName ? { background: '#f8fafc', color: '#64748b' } : undefined} />
                  {routeProjectName && <p className="text-[11px] text-gray-400 mt-1">Set by the project — memos file under this project automatically.</p>}
                </div>
                <div>
                  <label className="label">Proposal Date</label>
                  <input className="input" value={fields.proposal_date || ''} onChange={setField('proposal_date')} />
                </div>
                {intakeType === 'Change Order' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Change Order Amount</label>
                      <input className="input" value={fields.change_order_price || ''} onChange={setField('change_order_price')} />
                    </div>
                    <div>
                      <label className="label">Original PO Amount</label>
                      <input className="input" value={fields.original_po_amount || ''} onChange={setField('original_po_amount')} />
                    </div>
                    <div className="col-span-2 p-2.5 rounded-lg text-sm font-medium flex items-center justify-between"
                      style={{ background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155' }}>
                      <span>New PO Total</span>
                      <span className="font-semibold">{newTotalAmount}</span>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="label">Total Quoted Price</label>
                    <input className="input" value={fields.total_price || ''} onChange={setField('total_price')} />
                  </div>
                )}
                <div>
                  <label className="label">Scope of Work</label>
                  <textarea className="input" rows={3} value={fields.scope_of_work || ''} onChange={setField('scope_of_work')} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Memo From</label>
                    <input className="input" value={fromName} onChange={e => setFromName(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Memo To</label>
                    <input className="input" value={toName} onChange={e => setToName(e.target.value)} />
                  </div>
                </div>
                {templates.length > 0 && (
                  <div>
                    <label className="label">Memo Template</label>
                    <select className="input" value={templateId} onChange={e => setTemplateId(e.target.value)}>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            {fields && (
              <button type="button" className="btn-primary w-full justify-center" onClick={handleGenerate} disabled={generating}>
                {generating ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Building memo package…
                  </span>
                ) : (
                  <span className="flex items-center gap-2"><DocumentTextIcon className="w-4 h-4" /> Generate Memo Package</span>
                )}
              </button>
            )}

            {result && (
              <div className="p-4 rounded-xl flex items-center justify-between gap-3" style={{ background: '#d1fae5', border: '1px solid #6ee7b7' }}>
                <div className="flex items-center gap-2">
                  <CheckCircleIcon className="w-5 h-5" style={{ color: '#059669' }} />
                  <p className="text-sm font-semibold" style={{ color: '#065f46' }}>Memo package ready</p>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => proposalIntakeApi.download(result.id, result.merged_file_name)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Download
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={reset}>New</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* History panel */}
        <div className="col-span-3 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Processed Memos</h2>
          <div className="space-y-2">
            {history.length === 0 ? (
              <div className="card px-5 py-12 text-center">
                <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                <p className="text-sm text-gray-400">No proposals processed yet. Use the form to process your first one.</p>
              </div>
            ) : (
              history.map(h => <HistoryItem key={h.id} item={h} onDelete={handleDelete} />)
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
