import { useState, useEffect } from 'react';
import {
  CloudArrowUpIcon, SparklesIcon, DocumentMagnifyingGlassIcon, ArrowDownTrayIcon,
  TrashIcon, ClockIcon, DocumentTextIcon, CodeBracketIcon, PencilSquareIcon,
} from '@heroicons/react/24/outline';
import { payAppReviewApi } from '../api';
import PageHeader from '../components/PageHeader';
import FileDrop from '../components/FileDrop';
import PayAppReportView from '../components/PayAppReportView';

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

function SummaryField({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" type={type} value={value ?? ''} onChange={e => onChange(type === 'number' ? parseFloat(e.target.value) || null : e.target.value)} />
    </div>
  );
}

function LineItemsTable({ items, onChange }) {
  const cols = ['itemNo', 'description', 'c', 'd', 'e', 'f', 'g', 'pctComplete', 'h'];
  const labels = ['Item', 'Description', 'C (Sched)', 'D (Prev)', 'E (Period)', 'F (Stored)', 'G (Total)', '%G/C', 'H (Balance)'];
  const update = (idx, key, val) => {
    const next = [...items];
    next[idx] = { ...next[idx], [key]: (key === 'itemNo' || key === 'description') ? val : (val === '' ? null : parseFloat(val)) };
    onChange(next);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>{labels.map(l => <th key={l} className="table-th whitespace-nowrap">{l}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((li, i) => (
            <tr key={i} className="table-tr">
              {cols.map(col => (
                <td key={col} className="table-td p-1">
                  <input
                    className="input py-1 px-1.5 text-xs w-full"
                    style={{ minWidth: col === 'description' ? 140 : 60 }}
                    value={li[col] ?? ''}
                    onChange={e => update(i, col, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryItem({ item, onView, onDelete }) {
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
          <p className="text-sm font-medium text-gray-900 truncate">{item.project_name || 'Untitled'} — App #{item.application_number ?? '—'}</p>
          <p className="text-xs text-gray-400 mt-0.5">{money(item.current_payment_due)} due · {item.period_to || '—'}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export default function PayAppReview() {
  const [currentFile, setCurrentFile] = useState(null);
  const [previousFile, setPreviousFile] = useState(null);
  const [historyMatch, setHistoryMatch] = useState(null);
  const [usePreviousFromHistory, setUsePreviousFromHistory] = useState(false);

  const [contractSum, setContractSum] = useState('');
  const [coLogCsv, setCoLogCsv] = useState('');
  const [retainageRate, setRetainageRate] = useState('');
  const [retainageMilestonePct, setRetainageMilestonePct] = useState('');
  const [retainageReducedRate, setRetainageReducedRate] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { id, report, extracted: { current, previous } }
  const [editing, setEditing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const [history, setHistory] = useState([]);
  const [viewing, setViewing] = useState(null); // { id, report }

  const loadHistory = () => payAppReviewApi.list().then(setHistory);
  useEffect(() => { loadHistory(); }, []);

  const runAnalysis = async (current, previous, currentFileForUpload, previousReviewId) => {
    const fd = new FormData();
    fd.append('current_file', currentFileForUpload);
    fd.append('current', JSON.stringify(current));
    if (previous) fd.append('previous', JSON.stringify(previous));
    if (previousReviewId) fd.append('previous_review_id', previousReviewId);
    if (contractSum) fd.append('original_contract_sum', contractSum);
    if (coLogCsv) fd.append('co_log_csv', coLogCsv);
    if (retainageRate) {
      fd.append('retainage_rate', parseFloat(retainageRate) / 100);
      if (retainageMilestonePct) fd.append('retainage_milestone_pct', retainageMilestonePct);
      if (retainageReducedRate) fd.append('retainage_reduced_rate', parseFloat(retainageReducedRate) / 100);
    }
    const data = await payAppReviewApi.create(fd);
    setResult({ id: data.id, report: data.report, extracted: { current, previous }, previousReviewId });
    loadHistory();
  };

  const handleAnalyze = async () => {
    if (!currentFile) { setError('Upload the current pay application PDF first.'); return; }
    setError(''); setAnalyzing(true); setResult(null); setViewing(null); setEditing(false);
    try {
      const fd = new FormData();
      fd.append('current_file', currentFile);
      if (previousFile) fd.append('previous_file', previousFile);
      const extracted = await payAppReviewApi.extract(fd);

      let previousData = extracted.previous;
      let previousReviewId = null;
      if (!previousFile && extracted.current.summary.projectName) {
        const match = await payAppReviewApi.latestForProject(extracted.current.summary.projectName);
        if (match) {
          setHistoryMatch(match);
          setUsePreviousFromHistory(true);
          previousData = match.current;
          previousReviewId = match.id;
        }
      }

      await runAnalysis(extracted.current, previousData, currentFile, previousReviewId);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not analyze these pay applications.');
    } finally {
      setAnalyzing(false);
    }
  };

  const setSummaryField = key => val => setResult(r => ({ ...r, extracted: { ...r.extracted, current: { ...r.extracted.current, summary: { ...r.extracted.current.summary, [key]: val } } } }));
  const setLineItems = items => setResult(r => ({ ...r, extracted: { ...r.extracted, current: { ...r.extracted.current, lineItems: items } } }));

  const handleRecompute = async () => {
    setError(''); setRecomputing(true);
    try {
      await runAnalysis(result.extracted.current, result.extracted.previous, currentFile, result.previousReviewId);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not recompute the review.');
    } finally {
      setRecomputing(false);
    }
  };

  const handleView = async id => {
    const record = await payAppReviewApi.get(id);
    const s = record.extracted_data.current.summary;
    const critical = record.checks_result.filter(r => r.critical && r.status === 'FAIL');
    const mathErrors = record.checks_result.filter(r => !r.critical && r.status === 'FAIL');
    const warnings = record.checks_result.filter(r => r.status === 'SKIPPED');
    const cleanBill = record.checks_result.filter(r => r.status === 'PASS');
    const billedPct = s.line3 ? (s.line4 / s.line3) * 100 : null;
    const retainedPct = s.line4 ? (s.line5 / s.line4) * 100 : null;
    let plainEnglish;
    if (critical.length === 0 && mathErrors.length === 0) {
      plainEnglish = `This application requests ${money(s.line8)}. Math checks out — no issues found.`;
    } else {
      const total = critical.length + mathErrors.length;
      plainEnglish = `This application requests ${money(s.line8)}. ${total} issue${total === 1 ? '' : 's'} found${critical.length ? ` (${critical.length} critical).` : '.'}`;
    }
    if (billedPct != null) plainEnglish += ` Overall billing is at ${billedPct.toFixed(1)}% of contract sum${retainedPct != null ? `, ${retainedPct.toFixed(1)}% retained.` : '.'}`;
    setViewing({
      id,
      report: {
        header: {
          projectName: s.projectName || 'Not specified', applicationNumber: s.applicationNumber ?? 'Not specified',
          periodTo: s.periodTo || 'Not specified', currentPaymentDue: s.line8, totalCompletedToDate: s.line4,
          balanceToFinish: s.line9, contractSumToDate: s.line3, billedPct, retainedPct,
        },
        plainEnglish, critical, mathErrors, warnings, cleanBill, checklist: record.checklist || [],
      },
    });
    setResult(null);
  };

  const handleDelete = async id => {
    if (!confirm('Delete this pay app review from history?')) return;
    await payAppReviewApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    loadHistory();
  };

  const reset = () => {
    setCurrentFile(null); setPreviousFile(null); setHistoryMatch(null);
    setUsePreviousFromHistory(false); setResult(null); setViewing(null); setError(''); setEditing(false);
    setContractSum(''); setCoLogCsv(''); setRetainageRate(''); setRetainageMilestonePct(''); setRetainageReducedRate('');
  };

  return (
    <div className="p-8">
      <PageHeader
        title="Pay Application Review"
        subtitle="Upload the previous and current pay application — get math checks and a site verification checklist in one step"
        icon={DocumentMagnifyingGlassIcon}
        accent="blue"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #3b82f6, #6366f1)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)' }}>
                  <DocumentMagnifyingGlassIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Pay App Review</h2>
              </div>
              {(currentFile || previousFile || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <FileDrop file={currentFile} onChange={setCurrentFile} label="Current Pay Application (PDF) *" />
            <FileDrop file={previousFile} onChange={setPreviousFile} label="Previous Pay Application (PDF)" />

            <button type="button" className="text-xs font-medium text-gray-500 underline" onClick={() => setShowOptional(o => !o)}>
              {showOptional ? 'Hide' : 'Show'} optional contract-level inputs
            </button>
            {showOptional && (
              <div className="space-y-3 p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
                <SummaryField label="Known Original Contract Sum" value={contractSum} onChange={setContractSum} type="number" />
                <div>
                  <label className="label">Change Order Log (CSV, header row + co_number,amount)</label>
                  <textarea className="input text-xs" rows={3} placeholder={'co_number,amount\nCO-001,5000\nCO-002,-1200'} value={coLogCsv} onChange={e => setCoLogCsv(e.target.value)} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="label">Retainage Rate %</label>
                    <input className="input" value={retainageRate} onChange={e => setRetainageRate(e.target.value)} placeholder="10" />
                  </div>
                  <div>
                    <label className="label">Reduction at %</label>
                    <input className="input" value={retainageMilestonePct} onChange={e => setRetainageMilestonePct(e.target.value)} placeholder="50" />
                  </div>
                  <div>
                    <label className="label">Reduced Rate %</label>
                    <input className="input" value={retainageReducedRate} onChange={e => setRetainageReducedRate(e.target.value)} placeholder="5" />
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleAnalyze} disabled={analyzing || !currentFile}>
              {analyzing ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Analyzing pay applications…
                </span>
              ) : (
                <span className="flex items-center gap-2"><SparklesIcon className="w-4 h-4" /> Analyze Pay Applications</span>
              )}
            </button>

            {!previousFile && !historyMatch && !result && (
              <p className="text-[11px] text-gray-400">
                No previous application uploaded — only single-period checks will run. Upload one for full cross-application checks.
              </p>
            )}

            {result && (
              <div className="pt-2" style={{ borderTop: '1px solid #f3f4f6' }}>
                <button
                  type="button"
                  className="btn-secondary w-full justify-center"
                  onClick={() => setEditing(e => !e)}
                >
                  <PencilSquareIcon className="w-4 h-4" /> {editing ? 'Hide editor' : 'Correct a misread value'}
                </button>
              </div>
            )}

            {editing && result && (
              <div className="space-y-3 pt-2">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Edit extracted values &amp; recompute</p>
                <div className="grid grid-cols-2 gap-3">
                  <SummaryField label="Application #" value={result.extracted.current.summary.applicationNumber} onChange={setSummaryField('applicationNumber')} type="number" />
                  <SummaryField label="Period To" value={result.extracted.current.summary.periodTo} onChange={setSummaryField('periodTo')} />
                </div>
                <SummaryField label="Project Name" value={result.extracted.current.summary.projectName} onChange={setSummaryField('projectName')} />
                <div className="grid grid-cols-2 gap-3">
                  <SummaryField label="Line 1 — Original Contract Sum" value={result.extracted.current.summary.line1} onChange={setSummaryField('line1')} type="number" />
                  <SummaryField label="Line 2 — Net Change Orders" value={result.extracted.current.summary.line2} onChange={setSummaryField('line2')} type="number" />
                  <SummaryField label="Line 3 — Contract Sum to Date" value={result.extracted.current.summary.line3} onChange={setSummaryField('line3')} type="number" />
                  <SummaryField label="Line 4 — Completed & Stored to Date" value={result.extracted.current.summary.line4} onChange={setSummaryField('line4')} type="number" />
                  <SummaryField label="Line 5 — Total Retainage" value={result.extracted.current.summary.line5} onChange={setSummaryField('line5')} type="number" />
                  <SummaryField label="Line 6 — Earned Less Retainage" value={result.extracted.current.summary.line6} onChange={setSummaryField('line6')} type="number" />
                  <SummaryField label="Line 7 — Previous Certificates" value={result.extracted.current.summary.line7} onChange={setSummaryField('line7')} type="number" />
                  <SummaryField label="Line 8 — Current Payment Due" value={result.extracted.current.summary.line8} onChange={setSummaryField('line8')} type="number" />
                  <SummaryField label="Line 9 — Balance to Finish" value={result.extracted.current.summary.line9} onChange={setSummaryField('line9')} type="number" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Line Items</p>
                  <LineItemsTable items={result.extracted.current.lineItems} onChange={setLineItems} />
                </div>
                <button type="button" className="btn-primary w-full justify-center" onClick={handleRecompute} disabled={recomputing}>
                  {recomputing ? 'Recomputing…' : 'Recompute Checks'}
                </button>
                <p className="text-[11px] text-gray-400">Recomputing saves a new entry to history reflecting your corrections — no AI call is used.</p>
              </div>
            )}
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Review Result</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReviewApi.downloadMarkdown(result.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReviewApi.downloadJson(result.id)}>
                    <CodeBracketIcon className="w-4 h-4" /> .json
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={reset}>New</button>
                </div>
              </div>
              <PayAppReportView report={result.report} />
            </>
          )}

          {viewing && !result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Stored Review</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReviewApi.downloadMarkdown(viewing.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReviewApi.downloadJson(viewing.id)}>
                    <CodeBracketIcon className="w-4 h-4" /> .json
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReviewApi.downloadOriginal(viewing.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Original PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => setViewing(null)}>Close</button>
                </div>
              </div>
              <PayAppReportView report={viewing.report} />
            </>
          )}

          {!result && !viewing && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Review History</h2>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="card px-5 py-12 text-center">
                    <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    <p className="text-sm text-gray-400">No pay applications reviewed yet.</p>
                  </div>
                ) : (
                  history.map(h => <HistoryItem key={h.id} item={h} onView={handleView} onDelete={handleDelete} />)
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
