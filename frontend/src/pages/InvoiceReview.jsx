import { useState, useEffect } from 'react';
import {
  ReceiptPercentIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon,
} from '@heroicons/react/24/outline';
import { invoiceReviewApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import MultiFileDrop from '../components/MultiFileDrop';
import {
  money, VerdictBanner, CountTiles, Section, CompareFinding, DeviationFinding, ListFinding,
  CoasterNotes, PassedLine,
} from '../components/ReviewReport';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

// Whether the invoice can be paid, a count of each kind of problem, and each problem with its numbers —
// the same layout as the change order review, from the same pieces.
function InvoiceReportView({ report }) {
  const h = report.header;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-[15px] font-semibold text-gray-900">
            {h.vendor}{h.invoiceNumber ? ` — Invoice ${h.invoiceNumber}` : ''}
          </h3>
          <span className="text-lg font-semibold text-gray-900 tabular-nums">{money(h.total)}</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">{[h.invoiceDate, h.poNumber && `PO ${h.poNumber}`].filter(Boolean).join(' · ')}</p>
        <div className="mt-4"><VerdictBanner verdict={report.verdict} /></div>
        <div className="mt-3"><CountTiles tiles={report.tiles} /></div>
        <p className="text-[11px] text-gray-400 mt-3">Checked against {h.checkedAgainst.join(', ')}.</p>
      </div>

      {report.duplicate && (
        <Section title="Possible duplicate" count={report.duplicate.figures?.rows?.length || 1} tone="red">
          <ListFinding finding={report.duplicate} before="paying" />
        </Section>
      )}

      <Section title="Math errors" count={report.math.issues.length} tone={report.math.issues.length ? 'red' : 'green'}>
        {report.math.issues.length === 0
          ? <p className="text-[12px] text-gray-500">The arithmetic on the invoice checks out.</p>
          : <div className="space-y-4">{report.math.issues.map(f => <CompareFinding key={f.id} finding={f} before="paying" shownLabel="On the invoice" />)}</div>}
      </Section>

      {report.backup && (
        <Section title="Missing receipts" count={report.backup.figures?.rows?.length || 1} tone="red">
          <p className="text-[11px] text-gray-400 mb-2">
            Billed as costs the vendor paid and is passing on, with no receipt or invoice among the uploads.
          </p>
          <ListFinding finding={report.backup} before="paying" showTitle={false} />
        </Section>
      )}

      {report.contract && (
        <Section title={`Contract and PO${report.contract.label ? ` — ${report.contract.label}` : ''}`}
          count={report.contract.count} tone={report.contract.issues.length ? 'red' : 'green'}>
          {report.contract.issues.length === 0 ? (
            <p className="text-[12px] text-gray-500">Nothing on the invoice goes against the agreement terms that were checked.</p>
          ) : (
            <div className="space-y-4">
              {report.contract.issues.map(f => (f.figures?.kind === 'billing'
                ? <ListFinding key={f.id} finding={f} before="paying" />
                : <DeviationFinding key={f.id} finding={f} before="paying" whatLabel="On the invoice" />))}
            </div>
          )}
          {report.contract.billing && <p className="text-[11px] text-gray-500 mt-3">{report.contract.billing}</p>}
        </Section>
      )}

      <CoasterNotes notes={report.notes} />
      <PassedLine passed={report.passed} notChecked={report.notChecked} />
    </div>
  );
}

function HistoryRow({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = item.critical_count > 0
    ? { bg: '#fef2f2', color: '#b91c1c', text: `${item.critical_count} to resolve` }
    : item.fail_count > 0
      ? { bg: '#fff7ed', color: '#c2410c', text: `${item.fail_count} to check` }
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
      // Always sent, empty when "no contract" is chosen, so the server does not fall back to the
      // project's default contract behind the PM's back.
      fd.append('contract_id', contractId || '');
      const data = await invoiceReviewApi.create(fd);
      setResult({ id: data.id, report: data.report });
      loadHistory();
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not analyze this invoice.');
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
        subtitle="Check a vendor invoice's math, its receipts, earlier reviews for a duplicate, and the contract or PO it is billed against"
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
                  No contract or PO in this project's Shared Documents yet — add one there and it will
                  appear here. You can still review the invoice: the math, receipts and duplicates are
                  checked either way.
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
                      ? "Tax, costs it forbids, the PO number, and how much is left on it are checked against this."
                      : 'Nothing to check tax, the PO or forbidden costs against — the math, receipts and duplicates only.'}
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
                  <button className="btn-primary px-3 py-1.5"
                    onClick={() => invoiceReviewApi.downloadPdf(active.id, `Invoice_${active.report.header.invoiceNumber || active.id}_Review.pdf`)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Report PDF
                  </button>
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
