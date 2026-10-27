import { useState, useEffect, useRef } from 'react';
import {
  ReceiptPercentIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon, CheckIcon,
} from '@heroicons/react/24/outline';
import { invoiceReviewApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import MultiFileDrop from '../components/MultiFileDrop';
import DocList from '../components/DocList';
import AddedDocuments, { useAddedDocuments, CONTRACT_CATEGORIES } from '../components/AddedDocuments';
import {
  money, VerdictBanner, CountTiles, Section, CompareFinding, DeviationFinding, ListFinding,
  CoasterNotes, PassedLine,
} from '../components/ReviewReport';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

// What an invoice can be checked against. One at a time: an invoice is billed under one agreement, and
// an architect's invoice measured against the contractor's terms reports problems that are not there.
// The math, receipts and earlier reviews are checked whichever is chosen.
const CHECK_OPTIONS = [
  { key: 'architect', label: "Architect's contract / PO", hint: 'Tax, costs it forbids, rates, the PO number, how much is left on it' },
  { key: 'contractor', label: "Contractor's contract / PO", hint: 'Tax, costs it forbids, the PO number, how much is left on it' },
  { key: 'basic', label: 'Math checks', hint: 'The arithmetic, receipts and duplicates only' },
];

// A filed agreement that reads as the architect's: named for the architect or the design team, or an
// AIA owner-architect form. Used only to suggest which one to tick; the PM can tick another.
const looksArchitect = d => /architect|\ba\/e\b|design|engineer|b10[1-9]|b1\d\d/i
  .test([d.label, d.file_name, d.party].filter(Boolean).join(' '));

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
        <Section title={`${report.contract.title || 'Contract and PO'}${report.contract.label ? ` — ${report.contract.label}` : ''}`}
          count={report.contract.count} tone={report.contract.issues.length ? 'red' : 'green'}>
          {report.contract.issues.length === 0 ? (
            <p className="text-[12px] text-gray-500">Nothing on the invoice goes against the agreement terms that were checked.</p>
          ) : (
            <div className="space-y-4">
              {report.contract.issues.map(f => (f.figures?.kind === 'billing'
                ? (
                  <div key={f.id}>
                    <ListFinding finding={f} before="paying" />
                    {f.figures.summary && <p className="text-[12px] text-gray-600 leading-relaxed mt-2">{f.figures.summary}</p>}
                  </div>
                )
                : <DeviationFinding key={f.id} finding={f} before="paying" whatLabel="On the invoice" />))}
            </div>
          )}
          {report.contract.billing && <p className="text-[11px] text-gray-500 mt-3">{report.contract.billing}</p>}
        </Section>
      )}

      {report.secondLook?.length > 0 && (
        <Section title="Worth a second look" count={report.secondLook.length} tone="amber">
          <p className="text-[11px] text-gray-400 mb-2">
            Coaster's reading of entries that may not be right — check them before paying.
          </p>
          <ListFinding finding={{ figures: { rows: report.secondLook } }} showTitle={false} />
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
  // What it is checked against — one of CHECK_OPTIONS' keys, or '' until the PM says.
  const [check, setCheck] = useState('');
  // Every contract and PO on the project, and which one this invoice is being checked against.
  const [contracts, setContracts] = useState(null);
  // As many as the invoice is billed under — a contract for its terms and a PO for its amount, say.
  const [contractIds, setContractIds] = useState([]);
  // What an earlier, expired PO already covered, when this one carried its balance over. Optional:
  // Coaster works it out itself when the PO says it continues an earlier one.
  const [earlierPaid, setEarlierPaid] = useState('');
  const contractAdd = useAddedDocuments(routeProjectId, contractIds.map(Number), ids => setContractIds(ids.map(String)));
  // Which choice the suggestion below was last made for, so it is made once and an untick sticks.
  const suggestedFor = useRef('');
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
        setContracts((docs || []).filter(d => GOVERNING_DOCS.includes(d.doc_type)));
      })
      .catch(() => setContracts([]));
  };
  useEffect(() => { loadContracts(); }, [routeProjectId, contractAdd.listVersion]);

  // The agreement suggested for the choice made: the architect's-looking one for the architect, the
  // project default (or the first that is not the architect's) for the contractor. Made once per
  // choice, so whatever the PM ticks or unticks after it stays as they left it.
  useEffect(() => {
    if (!contracts || !['architect', 'contractor'].includes(check) || suggestedFor.current === check) return;
    suggestedFor.current = check;
    const pick = check === 'architect'
      ? contracts.find(looksArchitect)
      : (contracts.find(c => c.is_primary && !looksArchitect(c)) || contracts.find(c => !looksArchitect(c)));
    setContractIds(pick ? [String(pick.id)] : []);
  }, [contracts, check]);

  const choose = key => {
    // Switching whose agreement it is clears the ones ticked for the other.
    if (key !== check) { setContractIds([]); suggestedFor.current = ''; }
    setCheck(prev => (prev === key ? '' : key));
  };
  const toggleContract = id => setContractIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const wantsAgreement = check === 'architect' || check === 'contractor';
  const chosenCount = contractIds.length + contractAdd.added.length;
  const whose = check === 'architect' ? "architect's" : "contractor's";
  const missing = files.length === 0 ? 'Upload the vendor invoice PDF first.'
    : !check ? 'Choose what to check it against.'
      : wantsAgreement && chosenCount === 0 ? `Choose the ${whose} contract or PO, or upload it.`
        : null;

  const handleAnalyze = async () => {
    if (missing) { setError(missing); return; }
    setError(''); setAnalyzing(true); setResult(null); setViewing(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('invoices', f));
      if (routeProjectId) fd.append('project_id', routeProjectId);
      fd.append('checks', JSON.stringify(wantsAgreement ? [check] : []));
      if (wantsAgreement) {
        // Every one ticked, plus every one uploaded: those saved to Shared Documents are filed first
        // and checked against like any filed agreement, the rest are read for this review alone.
        fd.append('contract_ids', JSON.stringify(await contractAdd.fileShared()));
        for (const once of contractAdd.onceFiles) fd.append('contract_files', once);
        if (earlierPaid.trim()) fd.append('earlier_po_paid', earlierPaid.trim());
      } else {
        // Sent empty, so the server does not fall back to the project's default contract.
        fd.append('contract_id', '');
      }
      const data = await invoiceReviewApi.create(fd);
      setResult({ id: data.id, report: data.report });
      contractAdd.setAdded([]);
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

  const reset = () => {
    setFiles([]); setCheck(''); setContractIds([]); setEarlierPaid(''); suggestedFor.current = '';
    contractAdd.setAdded([]); setResult(null); setError('');
  };
  const active = result || viewing;
  const busy = analyzing || contractAdd.filing;

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
              {(files.length > 0 || check || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <MultiFileDrop files={files} onChange={setFiles}
              accept=".pdf"
              hint="The vendor invoice, plus any backup receipts/invoices for reimbursable costs · PDF"
              label="Invoice(s) (PDF) *" />

            <div>
              <label className="label">What should it be checked against?</label>
              <p className="text-[11px] text-gray-400 -mt-0.5 mb-2">
                The math, receipts and earlier reviews are checked whichever you choose.
              </p>
              <div className="space-y-1.5">
                {CHECK_OPTIONS.map(o => {
                  const on = check === o.key;
                  return (
                    <button key={o.key} type="button" onClick={() => choose(o.key)} aria-pressed={on}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors"
                      style={{ background: on ? '#eff6ff' : '#fafbfc', border: `1px solid ${on ? '#bfdbfe' : '#eef1f4'}` }}>
                      <span className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: on ? '#2563eb' : '#fff', border: `1px solid ${on ? '#2563eb' : '#cbd5e1'}` }}>
                        {on && <CheckIcon className="w-3 h-3 text-white" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-gray-900">{o.label}</span>
                        <span className="block text-[11px] text-gray-400">{o.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {wantsAgreement && (
              <div className="p-4 rounded-xl space-y-3" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[12px] font-bold text-gray-900">The {whose} contract or PO</p>
                  {chosenCount > 0 && <span className="text-[11px] font-semibold" style={{ color: '#1d4ed8' }}>{chosenCount} chosen</span>}
                </div>
                <p className="text-[11px] text-gray-400 -mt-1.5">
                  Choose as many as it is billed under — the contract for its terms, the PO for its amount.
                </p>
                {routeProjectId && contracts?.length !== 0 && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1.5">From the project's Shared Documents:</p>
                    <DocList docs={contracts} selectedIds={contractIds} onToggle={toggleContract} />
                  </div>
                )}
                <AddedDocuments items={contractAdd.added} onChange={contractAdd.setAdded}
                  noun="invoice" label={contracts?.length ? 'And upload more' : 'Upload them'}
                  hint={`the ${whose} contract, purchase order, or both`}
                  categories={routeProjectId ? CONTRACT_CATEGORIES : []} disabled={busy} />
                <div className="pt-1">
                  <label className="label">Already paid under an earlier PO <span className="normal-case font-normal text-gray-400">(optional)</span></label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
                    <input className="input pl-6" inputMode="decimal" placeholder="e.g. 33,200"
                      value={earlierPaid} onChange={e => setEarlierPaid(e.target.value)} />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">
                    If this PO replaced an expired one, what the old PO covered. Only billing after that is counted
                    against this PO. Coaster works it out itself when the PO says it continues an earlier one.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleAnalyze} disabled={busy || !!missing}>
              {busy ? (
                <><SparklesIcon className="w-4 h-4 animate-pulse" /> Reviewing…</>
              ) : (
                <><SparklesIcon className="w-4 h-4" /> Review Invoice</>
              )}
            </button>
            {missing && !busy && <p className="text-[11px] text-gray-400 -mt-2 text-center">{missing}</p>}

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
