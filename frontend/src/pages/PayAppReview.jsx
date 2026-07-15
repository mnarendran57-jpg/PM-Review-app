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

// The executed contract, uploaded once per project. Its terms drive the contract-compliance
// checks on every later pay app, so they are shown plainly and left editable — the model is
// reading a legal document and can be wrong, and a bad term would otherwise mis-flag every
// application from here on.
function ContractPanel({ projectId, contract, onChange }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async () => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('contract_file', file);
      await payAppReviewApi.uploadContract(projectId, fd);
      setFile(null);
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read this contract.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try { await payAppReviewApi.deleteContract(projectId); onChange(); }
    finally { setBusy(false); }
  };

  if (!contract) {
    return (
      <div className="space-y-2">
        <FileDrop file={file} onChange={setFile} label="Executed Contract (PDF)" />
        <p className="text-[11px] text-gray-400">
          Uploaded once per project. Its terms are read once and reused on every future pay app —
          you never upload it again.
        </p>
        {error && <p className="text-[11px]" style={{ color: '#b91c1c' }}>{error}</p>}
        {file && (
          <button type="button" className="btn-secondary w-full justify-center py-1.5 text-xs" onClick={upload} disabled={busy}>
            {busy ? 'Reading contract…' : 'Read contract terms'}
          </button>
        )}
      </div>
    );
  }

  const t = contract.terms || {};
  const taxLabel = t.taxExempt === true ? 'Tax exempt' : t.taxExempt === false ? 'Not tax exempt' : 'Tax status not stated';
  const taxStyle = t.taxExempt === true
    ? { background: '#d1fae5', color: '#065f46' }
    : t.taxExempt === false
      ? { background: '#f1f5f9', color: '#475569' }
      : { background: '#fff7ed', color: '#c2410c' };

  return (
    <div className="p-3 rounded-xl space-y-2.5" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <DocumentTextIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <span className="text-xs font-medium text-gray-900 truncate">{contract.file_name}</span>
        </div>
        <button type="button" className="btn-danger flex-shrink-0" onClick={remove} disabled={busy}>
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold" style={taxStyle}>
          {taxLabel}
        </span>
        {contract.terms_edited ? (
          <span className="text-[10px] text-gray-400">terms corrected by you</span>
        ) : (
          <span className="text-[10px] text-gray-400">read from the contract — check before relying on it</span>
        )}
      </div>

      {t.taxExemptBasis && <p className="text-[11px] text-gray-500 italic">“{t.taxExemptBasis}”</p>}

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
          Unallowable items ({(t.unallowableItems || []).length})
        </p>
        {(t.unallowableItems || []).length === 0 ? (
          <p className="text-[11px] text-gray-400">None found in this contract.</p>
        ) : (
          <ul className="space-y-1">
            {t.unallowableItems.map((u, i) => (
              <li key={i} className="text-[11px] text-gray-600">
                <span className="font-medium text-gray-900">{u.item}</span>
                {u.basis && <span className="text-gray-400"> — {u.basis}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Where the job stands overall, before looking at any single application. Headline
// numbers first (the view a PM would turn toward a client), then the application-by-
// application movement underneath.
function BudgetSummary({ budget }) {
  const s = budget.summary;
  if (!s) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-900">{budget.project.project_name}</h2>
        <p className="text-xs text-gray-400 mt-1">
          No pay applications reviewed on this project yet. Upload one and the budget history will build from there.
        </p>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, s.pctComplete ?? 0));
  const stat = (label, value, sub) => (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="text-lg font-semibold text-gray-900 mt-0.5 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="card card-accent p-5 space-y-4" style={{ '--card-accent': 'linear-gradient(90deg, #10b981, #3b82f6)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900 truncate">{budget.project.project_name}</h2>
        <span className="text-xs text-gray-400 flex-shrink-0">
          {s.applicationsReviewed} application{s.applicationsReviewed === 1 ? '' : 's'} reviewed
        </span>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Work completed</span>
          <span className="text-sm font-semibold text-gray-900 tabular-nums">{pct.toFixed(1)}%</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: '#eef2f7' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #10b981, #3b82f6)' }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {stat('Paid to date', money(s.totalPaidToDate))}
        {stat('Balance to finish', money(s.balanceToFinish))}
        {stat('Completed & stored', money(s.totalCompletedToDate), `of ${money(s.contractSumToDate)} contract`)}
        {stat(
          'Issues flagged',
          String(s.totalIssuesFlagged),
          s.totalIssuesFlagged === 0 ? 'across all applications' : 'across all applications to date'
        )}
      </div>

      {budget.applications.length > 1 && (
        <div className="pt-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Application history</p>
          <div className="space-y-1">
            {budget.applications.map(a => (
              <div key={a.id} className="flex items-center justify-between text-xs py-1 border-b last:border-0" style={{ borderColor: '#f1f5f9' }}>
                <span className="text-gray-500">App #{a.application_number ?? '—'} · {a.period_to || '—'}</span>
                <span className="tabular-nums text-gray-900">
                  {money(a.billed_this_period)}
                  <span className="text-gray-400"> · {a.pct_complete != null ? `${a.pct_complete.toFixed(1)}%` : '—'}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
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

  // Projects populate themselves as pay apps are reviewed — there is no separate
  // "create a project" step, so this list fills in on its own.
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [budget, setBudget] = useState(null); // { project, applications, summary }

  const loadHistory = () => payAppReviewApi.list().then(setHistory);
  const loadProjects = () => payAppReviewApi.projects().then(setProjects);
  useEffect(() => { loadHistory(); loadProjects(); }, []);

  const [contract, setContract] = useState(null);

  const loadContract = () => {
    if (!projectId) { setContract(null); return Promise.resolve(); }
    return payAppReviewApi.getContract(projectId).then(setContract).catch(() => setContract(null));
  };

  // Pull the selected project's billing history and executed contract so the PM sees
  // where the job stands, and what the contract allows, before uploading anything.
  useEffect(() => {
    if (!projectId) { setBudget(null); setContract(null); return; }
    let cancelled = false;
    payAppReviewApi.projectHistory(projectId)
      .then(d => { if (!cancelled) setBudget(d); })
      .catch(() => { if (!cancelled) setBudget(null); });
    payAppReviewApi.getContract(projectId)
      .then(d => { if (!cancelled) setContract(d); })
      .catch(() => { if (!cancelled) setContract(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  const runAnalysis = async (current, previous, currentFileForUpload, previousReviewId) => {
    const fd = new FormData();
    fd.append('current_file', currentFileForUpload);
    fd.append('current', JSON.stringify(current));
    if (previous) fd.append('previous', JSON.stringify(previous));
    if (previousReviewId) fd.append('previous_review_id', previousReviewId);
    if (projectId) fd.append('project_id', projectId);
    if (contractSum) fd.append('original_contract_sum', contractSum);
    if (coLogCsv) fd.append('co_log_csv', coLogCsv);
    if (retainageRate) {
      fd.append('retainage_rate', parseFloat(retainageRate) / 100);
      if (retainageMilestonePct) fd.append('retainage_milestone_pct', retainageMilestonePct);
      if (retainageReducedRate) fd.append('retainage_reduced_rate', parseFloat(retainageReducedRate) / 100);
    }
    const data = await payAppReviewApi.create(fd);
    setResult({ id: data.id, report: data.report, extracted: { current, previous }, previousReviewId });
    // A review may have created a project (or added to one), so refresh both the
    // dropdown and the budget panel rather than leaving stale numbers on screen.
    if (data.projectId && !projectId) setProjectId(String(data.projectId));
    else if (projectId) payAppReviewApi.projectHistory(projectId).then(setBudget).catch(() => {});
    loadHistory();
    loadProjects();
  };

  const handleAnalyze = async () => {
    if (!currentFile) { setError('Upload the current pay application PDF first.'); return; }
    setError(''); setAnalyzing(true); setResult(null); setViewing(null); setEditing(false);
    try {
      const fd = new FormData();
      fd.append('current_file', currentFile);
      if (previousFile) fd.append('previous_file', previousFile);
      const extracted = await payAppReviewApi.extract(fd);

      // With no previous PDF uploaded, fall back to the last pay app already on file.
      // Matching on the selected project's ID is exact; matching on the name text read
      // off the PDF is a guess, and misses when a vendor respells the project.
      let previousData = extracted.previous;
      let previousReviewId = null;
      if (!previousFile && (projectId || extracted.current.summary.projectName)) {
        const match = await payAppReviewApi.latestForProject({
          projectId: projectId || undefined,
          projectName: extracted.current.summary.projectName,
        });
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

            <div>
              <label className="label">Project</label>
              <select className="input" value={projectId} onChange={e => setProjectId(e.target.value)}>
                <option value="">Which project is this pay app for?</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.project_name}
                    {p.pay_app_count > 0
                      ? ` — ${p.pay_app_count} reviewed, latest App #${p.latest_application_number ?? '—'}`
                      : ' — no pay apps yet'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {projectId
                  ? 'This application will be compared against this project\'s billing history.'
                  : 'Leave blank and the project will be picked up from the name on the PDF.'}
              </p>
            </div>

            {projectId && (
              <ContractPanel projectId={projectId} contract={contract} onChange={loadContract} />
            )}

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
              budget?.summary ? (
                // A prior application is already on file for the selected project, so the
                // comparison will run against it — don't tell the user to upload one.
                <p className="text-[11px] text-gray-400">
                  No previous PDF needed — this will be compared against App #{budget.summary.latestApplicationNumber} already on file for this project.
                </p>
              ) : (
                <p className="text-[11px] text-gray-400">
                  No previous application on file — only single-period checks will run. Upload one for full cross-application checks.
                </p>
              )
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
          {budget && <BudgetSummary budget={budget} />}

          {result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Review Result</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-primary px-3 py-1.5" onClick={() => payAppReviewApi.downloadPdf(result.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF Report
                  </button>
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
                  <button className="btn-primary px-3 py-1.5" onClick={() => payAppReviewApi.downloadPdf(viewing.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF Report
                  </button>
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
