import { useState, useEffect } from 'react';
import {
  ReceiptPercentIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon, DocumentTextIcon,
  ExclamationTriangleIcon, CheckCircleIcon, LightBulbIcon,
} from '@heroicons/react/24/outline';
import { invoiceReviewApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import MultiFileDrop from '../components/MultiFileDrop';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

// Findings grouped the same way the PCO / pay app reports are: what blocks payment,
// what else is wrong, then — visually separated — the AI's advisory reading.
function InvoiceReportView({ report }) {
  const sectionCard = (title, items, tone) => {
    if (items.length === 0) return null;
    const styles = tone === 'critical'
      ? { border: '#fecaca', bg: '#fef2f2', heading: '#b91c1c', Icon: ExclamationTriangleIcon }
      : { border: '#fed7aa', bg: '#fff7ed', heading: '#c2410c', Icon: ExclamationTriangleIcon };
    return (
      <div className="card p-5 space-y-3" style={{ background: styles.bg, border: `1px solid ${styles.border}` }}>
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: styles.heading }}>
          <styles.Icon className="w-4 h-4" /> {title}
        </h3>
        {items.map((r, i) => (
          <div key={i}>
            <p className="text-sm font-medium text-gray-900">{r.description}</p>
            <p className="text-xs text-gray-600 mt-0.5">{r.detail}</p>
          </div>
        ))}
      </div>
    );
  };

  const o = report.observations || {};
  const notes = [
    o.reimbursableBackup && { title: 'Reimbursable costs and their backup', body: o.reimbursableBackup },
    o.unallowable && { title: 'Possible contract conflicts', body: o.unallowable },
    o.pricingSanity && { title: 'Pricing worth double-checking', body: o.pricingSanity },
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900">
            {report.header.vendor}{report.header.invoiceNumber !== 'Not specified' ? ` — Invoice ${report.header.invoiceNumber}` : ''}
          </h3>
          <span className="text-lg font-semibold text-gray-900 tabular-nums">{money(report.header.total)}</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {report.header.invoiceDate}
          {report.header.poNumber ? ` · PO ${report.header.poNumber}` : ''}
        </p>
        <p className="text-sm text-gray-700 mt-3">{report.plainEnglish}</p>
      </div>

      {sectionCard('Issues to Resolve Before Paying', report.critical, 'critical')}
      {sectionCard('Other Problems Found', report.mathErrors, 'warn')}

      {notes.length > 0 && (
        <div className="card p-5 space-y-3" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: '#6d28d9' }}>
            <LightBulbIcon className="w-4 h-4" /> Review Notes — the AI's read, verify before acting
          </h3>
          {notes.map((n, i) => (
            <div key={i}>
              <p className="text-sm font-medium text-gray-900">{n.title}</p>
              <p className="text-xs text-gray-600 mt-0.5">{n.body}</p>
            </div>
          ))}
        </div>
      )}

      {report.cleanBill.length > 0 && (
        <div className="card p-5 space-y-2">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <CheckCircleIcon className="w-4 h-4" style={{ color: '#059669' }} /> Everything Else Checked Out Fine
          </h3>
          {report.cleanBill.map((r, i) => (
            <p key={i} className="text-xs text-gray-500"><span className="font-medium text-gray-700">{r.description}</span> {r.detail}</p>
          ))}
        </div>
      )}

      {report.warnings.length > 0 && (
        <div className="card p-5 space-y-2">
          <h3 className="text-sm font-semibold text-gray-400">Checks We Couldn't Fully Complete</h3>
          {report.warnings.map((r, i) => (
            <p key={i} className="text-xs text-gray-400">{r.description} — {r.detail}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = item.critical_count > 0
    ? { bg: '#fef2f2', color: '#b91c1c', text: `${item.critical_count} critical` }
    : item.fail_count > 0
      ? { bg: '#fff7ed', color: '#c2410c', text: `${item.fail_count} issue${item.fail_count === 1 ? '' : 's'}` }
      : { bg: '#d1fae5', color: '#065f46', text: 'Clean' };
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0" style={{ background: badge.bg, color: badge.color }}>
          {badge.text}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {item.vendor || 'Unknown vendor'}{item.invoice_number ? ` — Invoice ${item.invoice_number}` : ''}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{money(item.total_amount)}{item.invoice_date ? ` · ${item.invoice_date}` : ''}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export default function InvoiceReview() {
  const ctx = useProject();
  const routeProjectId = ctx?.projectId;

  const [files, setFiles] = useState([]);
  // Every contract on the project, and which one this invoice is being checked against. An
  // architect's invoice must be measured against the architect's agreement, not the
  // contractor's, so the reviewer chooses rather than the app guessing.
  const [contracts, setContracts] = useState(null);
  const [contractId, setContractId] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // { id, report }
  const [viewing, setViewing] = useState(null); // { id, report }
  const [history, setHistory] = useState([]);

  const loadHistory = () => invoiceReviewApi.list(routeProjectId ? { project_id: routeProjectId } : undefined).then(setHistory);
  useEffect(() => { loadHistory(); }, [routeProjectId]);

  // The contracts in Shared Documents are what an invoice is checked against for tax,
  // unallowable items, and reimbursable rules.
  const loadContracts = () => {
    if (!routeProjectId) { setContracts(null); return Promise.resolve(); }
    return payAppReviewApi.listDocuments(routeProjectId)
      .then(docs => {
        const onlyContracts = (docs || []).filter(d => GOVERNING_DOCS.includes(d.doc_type));
        setContracts(onlyContracts);
        // Pre-select so a one-contract project needs no click, and so the choice is never
        // left blank when there is an obvious answer.
        setContractId(prev => {
          if (prev && onlyContracts.some(c => String(c.id) === String(prev))) return prev;
          const primary = onlyContracts.find(c => c.is_primary) || onlyContracts[0];
          return primary ? String(primary.id) : '';
        });
      })
      .catch(() => setContracts([]));
  };
  useEffect(() => { loadContracts(); }, [routeProjectId]);

  const handleAnalyze = async () => {
    if (files.length === 0) { setError('Upload the vendor invoice PDF first.'); return; }
    setError(''); setAnalyzing(true); setResult(null); setViewing(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('invoices', f));
      if (routeProjectId) fd.append('project_id', routeProjectId);
      if (contractId) fd.append('contract_id', contractId);
      const data = await invoiceReviewApi.create(fd);
      setResult({ id: data.id, report: data.report });
      loadHistory();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not analyze this invoice.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleView = async id => {
    const record = await invoiceReviewApi.get(id);
    setResult(null);
    setViewing({ id: record.id, report: record.report });
  };

  const handleDelete = async id => {
    await invoiceReviewApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    if (result?.id === id) setResult(null);
    loadHistory();
  };

  const reset = () => { setFiles([]); setResult(null); setError(''); };
  const active = result || viewing;

  return (
    <div className="p-8 space-y-6">
      <PageHeader
        icon={ReceiptPercentIcon}
        accent="teal"
        title="Invoice Review"
        subtitle="Upload a vendor invoice — get math, tax, reimbursable-backup, and contract checks against the project's contract"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #14b8a6, #0891b2)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #14b8a6, #0891b2)' }}>
                  <ReceiptPercentIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Invoice Review</h2>
              </div>
              {(files.length > 0 || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            {/* Which agreement this invoice is measured against. First thing on the form,
                because picking the wrong one invalidates every contract-based finding. */}
            <div className="pt-1">
              {/* No "add a contract" button here. Contracts are uploaded once in Shared
                  Documents and every tool reads them from there; a second way in made it look
                  as though this review kept its own. */}
              <label className="label mb-0">Review against which contract?</label>

              {contracts === null ? (
                <p className="text-xs text-gray-400 mt-1.5">Loading contracts…</p>
              ) : contracts.length === 0 ? (
                <p className="text-xs mt-1.5" style={{ color: '#c2410c' }}>
                  No contract in this project's Shared Documents yet — add one there and it will
                  appear here. You can still review the invoice; the maths is checked either way,
                  but tax and unallowable-cost findings need a contract.
                </p>
              ) : (
                <>
                  <select className="input mt-1.5" value={contractId} onChange={e => setContractId(e.target.value)}>
                    {contracts.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.label || c.file_name}{c.is_primary ? ' — project default' : ''}
                      </option>
                    ))}
                    <option value="">No contract — check the maths only</option>
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {contractId
                      ? "This contract's tax and cost terms are what the invoice is checked against."
                      : 'Nothing to check tax or unallowable costs against — arithmetic findings only.'}
                  </p>
                </>
              )}
            </div>

            <MultiFileDrop files={files} onChange={setFiles}
              accept=".pdf"
              hint="The vendor invoice, plus any backup receipts/invoices for reimbursable costs · PDF"
              label="Invoice(s) (PDF) *" />

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleAnalyze} disabled={analyzing || files.length === 0}>
              {analyzing ? (
                <><SparklesIcon className="w-4 h-4 animate-pulse" /> Reviewing…</>
              ) : (
                <><SparklesIcon className="w-4 h-4" /> Review Invoice</>
              )}
            </button>

            <p className="text-[11px] text-gray-400">
              Include any backup receipts or subcontractor invoices in the same upload — the review checks that
              every reimbursable (pass-through) cost has its backing document.
            </p>
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {active && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">{result ? 'Review Result' : 'Stored Review'}</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => { setResult(null); setViewing(null); }}>Close</button>
                </div>
              </div>
              <InvoiceReportView report={active.report} />
            </>
          )}

          {!active && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Review History</h2>
              {history.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-400">
                  No invoices reviewed yet. Upload one to get started.
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map(item => (
                    <HistoryRow key={item.id} item={item} onView={handleView} onDelete={handleDelete} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
