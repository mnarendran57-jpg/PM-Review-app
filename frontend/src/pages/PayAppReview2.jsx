// PAY APP REVIEWER 2 — the same reviewer, running the CSP review.
//
// A copy of PayAppReview.jsx talking to /api/pay-app-review-2, which keeps its reviews in a table of
// its own. The interface is deliberately identical: the point is to change what happens BEHIND it,
// not what the PM does.
//
// The review logic lives in backend/lib/payApp2Skill.js — the CSP pay application skill, covering a
// single prime billing against a stipulated sum. It shares Shared Documents with the real module on
// purpose: the same contract and the same pay application, reviewed a different way, is the
// comparison worth making.
//
// Every api call on this page must go through payAppReview2Api, including the ones made by shared
// components on its behalf. A review id from this module means nothing to the live module's routes,
// and the failure is quiet — a 404 that renders as "the report could not be loaded" above a review
// that ran perfectly well.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  CloudArrowUpIcon, SparklesIcon, DocumentMagnifyingGlassIcon, ArrowDownTrayIcon,
  TrashIcon, ClockIcon, DocumentTextIcon, CodeBracketIcon, PencilSquareIcon,
  ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import { payAppReview2Api } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import { useConfirm } from '../components/ConfirmDialog';
import FileDrop from '../components/FileDrop';
import PayAppFindingsReport from '../components/PayAppFindingsReport';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

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
  // "Not checked" comes first deliberately. A review whose checks fell over has no findings and a
  // zero fail count, which is indistinguishable from a clean application by the numbers alone — and
  // it used to read as "Clean", which is the one thing it certainly is not.
  const badge = item.checks_ran === 0
    ? { bg: '#f1f5f9', color: '#475569', text: 'Not checked' }
    : item.critical_count > 0
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

// How the job is procured, as the project records it.
//
// This used to be a question on this form, asked every month. It belongs to the project — a job
// does not change delivery method between applications — so it now lives in the project's own
// settings and this only reports what it says. Shown rather than hidden, because it changes what
// the review will and will not look for, and a reviewer should not have to remember which.
function DeliveryMethodNote({ method }) {
  if (!method) {
    return (
      <div className="rounded-xl px-3 py-2" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
        <p className="text-xs font-medium" style={{ color: '#9a3412' }}>No delivery method set for this project</p>
        <p className="text-[11px] mt-0.5" style={{ color: '#9a3412' }}>
          The review cannot tell missing subcontractor paperwork from a job that never has any.
          Set it on the project — Projects → edit → Delivery Method.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <p className="text-xs font-medium text-gray-900">{method} delivery</p>
      <p className="text-[11px] text-gray-500 mt-0.5">
        {method === 'CSP'
          ? 'The contractor bills directly, so no subcontractor applications are expected or looked for.'
          : 'Every subcontractor billing through the contractor is expected to have their own contract on file.'}
        {' '}Change it on the project if that is wrong.
      </p>
    </div>
  );
}

// Which contract this project's applications are measured against.
//
// Choose the document, and attach one if it is not there yet.
//
// The upload here is NOT a second home for contracts. It posts to Shared Documents, exactly as the
// Shared Documents page does, and the file lands in one place owned by the project — which is what
// an earlier version of this panel got wrong by carrying its own "Executed Contract (PDF)" drop
// that stored a separate copy, so the two could disagree about which one reviews used. What is
// fixed here is only the errand: being sent to another screen while holding the file is how a
// review ends up run against no contract at all.
//
// It does not show what was READ out of the contract. A panel of tax status, exemption wording
// and unallowable items sat above the review and read like findings, when it is only Coaster's
// working memory — the reviewer's question is whether this application is right, and everything
// that answers it belongs in the report. The terms are still read, still stored, and still drive
// the checks; they are just not the reviewer's business on this screen.
//
// One dropdown on a CSP job, because there is one agreement and one biller. On CMAR there are
// several — the contractor's and every subcontract under it — so the dropdown names the primary
// and the list underneath says which of the others apply.
function ContractPanel({ projectId, docs, deliveryMethod, otherIds, onOtherIds, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const choose = async (doc) => {
    setBusy(true); setError('');
    try {
      await payAppReview2Api.updateDocument(projectId, doc.id, { is_primary: true });
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change which contract reviews use.');
    } finally { setBusy(false); }
  };

  // Attaching the contract from here rather than sending the reviewer to Shared Documents.
  //
  // The link is still there and still right — a contract belongs to the project, not to this
  // review. But being told to go and do something else, in another part of the app, at the moment
  // you are holding the file, is how a review gets run without a contract "just this once". The
  // upload lands in exactly the same place; it just does not cost the reviewer their place.
  const attach = async (file, docType) => {
    if (!file) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      const added = await payAppReview2Api.addDocument(projectId, fd);
      // First governing document on the project becomes the one reviews check against, so the
      // common case is one upload and no second decision.
      if (added?.id && !(docs || []).length) {
        await payAppReview2Api.updateDocument(projectId, added.id, { is_primary: true });
      }
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add that document.');
    } finally { setUploading(false); }
  };

  const UploadRow = ({ compact }) => (
    <div className={compact ? 'mt-2' : 'mt-2.5'}>
      <div className="flex items-center gap-2 flex-wrap">
        {[['contract', 'Add a contract'], ['purchase-order', 'Add a purchase order']].map(([type, label]) => (
          <label key={type}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer"
            style={{ background: '#eff6ff', color: '#1d4ed8', opacity: uploading ? 0.5 : 1 }}>
            <ArrowUpTrayIcon className="w-3 h-3" />
            {uploading ? 'Adding…' : label}
            <input type="file" accept=".pdf" className="hidden" disabled={uploading}
              onChange={e => { attach(e.target.files?.[0], type); e.target.value = ''; }} />
          </label>
        ))}
      </div>
      <p className="text-[11px] text-gray-400 mt-1">
        Added to{' '}
        <Link to={`/project/${projectId}/shared-documents`} className="underline">Shared Documents</Link>,
        so every review on this project can use it. Read once, on the first review that needs it.
      </p>
    </div>
  );

  // Shown even with no project selected. Hiding it entirely made the whole idea undiscoverable —
  // a reviewer had no way to know reviews check against anything at all.
  if (!projectId) {
    return (
      <div className="space-y-2 opacity-60">
        <label className="label">Review against which contract?</label>
        <div className="rounded-xl px-4 py-6 text-center" style={{ border: '1px dashed #e2e8f0', background: '#fafbfc' }}>
          <DocumentTextIcon className="w-5 h-5 mx-auto text-gray-300" />
          <p className="text-xs text-gray-400 mt-1.5">Pick a project above</p>
        </div>
      </div>
    );
  }

  const available = docs || [];

  if (available.length === 0) {
    return (
      <div>
        <label className="label">Review against which contract?</label>
        <div className="rounded-xl px-3 py-3" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
          <p className="text-xs" style={{ color: '#9a3412' }}>
            No contract or purchase order is in this project's Shared Documents.
          </p>
          <p className="text-[11px] mt-1" style={{ color: '#9a3412' }}>
            The review still runs — the arithmetic, retainage and continuity checks do not need
            one. Add one to have the contract sum, retainage rate, tax rules and unallowable items
            checked as well.
          </p>
          <UploadRow compact />
          {error && <p className="text-[11px] mt-1" style={{ color: '#b91c1c' }}>{error}</p>}
        </div>
      </div>
    );
  }

  const nameOf = d => `${(d.label || '').trim() || d.file_name}${d.party ? ` — ${d.party}` : ''}`;
  const primary = available.find(d => d.is_primary === 1) || available[0];
  const others = available.filter(d => d.id !== primary.id);
  const status = primary.terms_status || 'ready';

  const toggle = id => onOtherIds(
    otherIds.includes(id) ? otherIds.filter(x => x !== id) : [...otherIds, id]
  );

  return (
    <div className="space-y-2">
      <label className="label mb-0">
        {deliveryMethod === 'CMAR' ? 'Primary contract' : 'Review against which contract?'}
      </label>

      <select className="input" value={primary.id} disabled={busy}
        onChange={e => {
          const doc = available.find(d => String(d.id) === e.target.value);
          if (doc) choose(doc);
        }}>
        {available.map(d => (
          <option key={d.id} value={d.id}>{nameOf(d)}</option>
        ))}
      </select>
      <UploadRow />
      {error && <p className="text-[11px]" style={{ color: '#b91c1c' }}>{error}</p>}

      {/* Only a CMAR package bills under more than one agreement. Ticked by default, because a
          subcontract on file is on file to be used; untick one that does not apply this month. */}
      {deliveryMethod === 'CMAR' && others.length > 0 && (
        <div className="rounded-xl p-3 space-y-1.5" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
          <p className="text-[11px] font-semibold text-gray-700">Other contracts on file</p>
          {others.map(d => (
            <label key={d.id} className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={otherIds.includes(d.id)}
                onChange={() => toggle(d.id)} />
              <span className="text-[11px] text-gray-700 leading-snug">
                {nameOf(d)}
                {!d.party && (
                  <span className="block text-[10px]" style={{ color: '#c2410c' }}>
                    No company named — it cannot be matched to anyone billing. Name it in Shared Documents.
                  </span>
                )}
                {d.terms_status && d.terms_status !== 'ready' && (
                  <span className="block text-[10px] text-gray-400">
                    {d.terms_status === 'failed' ? 'could not be read' : 'still being read'}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* Not a finding — whether the document is usable yet. Worth one line, because a review run
          before the reading finishes stands its contract checks down, and the reviewer would
          otherwise have no way to know why. */}
      {status === 'pending' && (
        <p className="text-[11px] text-gray-500">
          Not read yet — this review will read it once, which adds a minute or two the first time.
        </p>
      )}
      {status === 'failed' && (
        <p className="text-[11px]" style={{ color: '#b91c1c' }}>
          Could not be read, so its terms are not available to a review. Remove and re-add it in
          Shared Documents to retry.
        </p>
      )}
    </div>
  );
}

// Where the job stands overall, before looking at any single application. Headline
// numbers first (the view a PM would turn toward a client), then the application-by-
// application movement underneath.
function BudgetSummary({ budget }) {
  const s = budget.summary;
  // A project with no reviews on file has no billing history to show. Nothing is rendered at
  // all rather than an empty shell — a panel headed with the project name reads as a dashboard
  // whether or not it has figures in it, and a job that has just been cleared down should look
  // cleared down.
  if (!s) return null;

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

export default function PayAppReview2() {
  const [currentFile, setCurrentFile] = useState(null);
  const [previousFile, setPreviousFile] = useState(null);
  // Backup often arrives bundled inside the pay app PDF itself; these are for the
  // vendors who send it separately.
  const [backupFiles, setBackupFiles] = useState([]);
  // What those files actually yielded. Shown because "10 files added" says only that they were
  // uploaded, and they were uploaded before too — while being read by nothing.
  const [backupRead, setBackupRead] = useState(null);
  const [historyMatch, setHistoryMatch] = useState(null);
  const [usePreviousFromHistory, setUsePreviousFromHistory] = useState(false);

  const [contractSum, setContractSum] = useState('');
  const [coLogCsv, setCoLogCsv] = useState('');
  const [retainageRate, setRetainageRate] = useState('');
  const [retainageMilestonePct, setRetainageMilestonePct] = useState('');
  const [retainageReducedRate, setRetainageReducedRate] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  // Seconds since the read started. Shown while it runs, because a document that takes four minutes
  // and a page that has quietly died look identical without it.
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { id, report, extracted: { current, previous } }
  const [editing, setEditing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const [history, setHistory] = useState([]);
  const [viewing, setViewing] = useState(null); // { id, report }

  // The active project comes from the URL (/project/:id/...). Inside a project the
  // reviewer never picks one — this tool is already scoped to it.
  const ctx = useProject();
  const routeProjectId = ctx?.projectId;

  // Projects populate themselves as pay apps are reviewed — there is no separate
  // "create a project" step, so this list fills in on its own.
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(routeProjectId ? String(routeProjectId) : '');
  const [budget, setBudget] = useState(null); // { project, applications, summary }

  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  // Marking up re-reads the source PDF's text layer to anchor each finding, so it takes a
  // moment on a long application — hold the button while it runs.
  const [markingUp, setMarkingUp] = useState(false);
  const downloadMarkedUp = async id => {
    setMarkingUp(true); setError('');
    try {
      await payAppReview2Api.downloadMarkedUpPdf(id);
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not produce the marked-up PDF.');
    } finally {
      setMarkingUp(false);
    }
  };

  const loadHistory = () => payAppReview2Api.list(routeProjectId ? { project_id: routeProjectId } : undefined).then(setHistory);
  const loadProjects = () => payAppReview2Api.projects().then(setProjects);
  useEffect(() => { loadProjects(); }, []);
  useEffect(() => { loadHistory(); }, [routeProjectId]);

  // Keep the scoped project in sync if the route changes under us.
  useEffect(() => {
    if (routeProjectId) setProjectId(String(routeProjectId));
  }, [routeProjectId]);

  // Adding a project selects it immediately — the reviewer's next move is always to
  // upload something against it, so making them re-find it in the list is pure friction.
  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true); setError('');
    try {
      const created = await payAppReview2Api.createProject(name);
      await loadProjects();
      setProjectId(String(created.id));
      setAddingProject(false);
      setNewProjectName('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this project.');
    } finally {
      setCreatingProject(false);
    }
  };

  const [contract, setContract] = useState(null);
  // Every contract and purchase order in this project's Shared Documents. The chooser lists them;
  // nothing is uploaded from this page.
  const [governingDocs, setGoverningDocs] = useState([]);
  // On CMAR, which of the non-primary contracts apply to this application. Every one on file is
  // ticked as it arrives: a subcontract is on file in order to be used, and a control that
  // defaulted to none would quietly turn off the checks it exists to run.
  const [otherContractIds, setOtherContractIds] = useState([]);
  // Read from the project, never set here.
  const deliveryMethod = budget?.project?.delivery_method || '';

  const loadContract = () => {
    if (!projectId) { setContract(null); setGoverningDocs([]); return Promise.resolve(); }
    return Promise.all([
      payAppReview2Api.getContract(projectId).then(setContract).catch(() => setContract(null)),
      payAppReview2Api.listDocuments(projectId)
        .then((all) => {
          const govern = (all || []).filter(d => GOVERNING_DOCS.includes(d.doc_type));
          setGoverningDocs(govern);
          // Anything new is ticked; anything the reviewer unticked stays unticked.
          setOtherContractIds(prev => govern
            .filter(d => d.is_primary !== 1)
            .filter(d => prev.includes(d.id) || !prev.some(id => govern.some(g => g.id === id)))
            .map(d => d.id));
        })
        .catch(() => setGoverningDocs([])),
    ]);
  };

  // The budget panel is derived entirely from the reviews on file, so anything that adds or
  // removes one has to refetch it. Leaving it to the project-change effect alone meant deleting
  // every review still left its figures on screen until the page was reloaded.
  const refreshBudget = () => {
    if (!projectId) { setBudget(null); return Promise.resolve(); }
    return payAppReview2Api.projectHistory(projectId)
      .then(setBudget)
      .catch(() => setBudget(null));
  };

  // Pull the selected project's billing history and executed contract so the PM sees
  // where the job stands, and what the contract allows, before uploading anything.
  useEffect(() => {
    if (!projectId) { setBudget(null); setContract(null); setGoverningDocs([]); return; }
    let cancelled = false;
    payAppReview2Api.projectHistory(projectId)
      .then((d) => {
        if (cancelled) return;
        setBudget(d);
      })
      .catch(() => { if (!cancelled) setBudget(null); });
    payAppReview2Api.getContract(projectId)
      .then(d => { if (!cancelled) setContract(d); })
      .catch(() => { if (!cancelled) setContract(null); });
    payAppReview2Api.listDocuments(projectId)
      .then((all) => {
        if (cancelled) return;
        const govern = (all || []).filter(d => GOVERNING_DOCS.includes(d.doc_type));
        setGoverningDocs(govern);
        setOtherContractIds(govern.filter(d => d.is_primary !== 1).map(d => d.id));
      })
      .catch(() => { if (!cancelled) setGoverningDocs([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  // The contract is read after upload, so its panel starts out saying "reading". Without this it
  // would say that until the page was reloaded by hand, which would look like it had hung.
  const contractReading = [contract, ...governingDocs]
    .some(d => d && (d.terms_status === 'pending' || d.terms_status === 'reading'));
  useEffect(() => {
    if (!contractReading) return undefined;
    const timer = setInterval(loadContract, 4000);
    return () => clearInterval(timer);
  }, [contractReading, projectId]);

  const runAnalysis = async (current, previous, currentFileForUpload, previousReviewId) => {
    const fd = new FormData();
    fd.append('current_file', currentFileForUpload);
    fd.append('current', JSON.stringify(current));
    if (previous) fd.append('previous', JSON.stringify(previous));
    if (previousReviewId) fd.append('previous_review_id', previousReviewId);
    // THAT a previous application was uploaded, separately from whether anything came out of
    // reading it. Without this the review has no way to tell an empty extraction from an empty
    // upload slot: both arrive as no `previous` field, and the report says none was supplied — to
    // a reviewer who is looking at the file they just attached. The fact has to travel even when
    // the data does not.
    if (previousFile) fd.append('previous_uploaded', 'true');
    if (projectId) fd.append('project_id', projectId);
    if (deliveryMethod) fd.append('delivery_method', deliveryMethod);
    const primaryId = governingDocs.find(d => d.is_primary === 1)?.id;
    const chosen = [primaryId, ...otherContractIds].filter(Boolean);
    if (chosen.length) fd.append('contract_ids', chosen.join(','));
    if (contractSum) fd.append('original_contract_sum', contractSum);
    if (coLogCsv) fd.append('co_log_csv', coLogCsv);
    if (retainageRate) {
      fd.append('retainage_rate', parseFloat(retainageRate) / 100);
      if (retainageMilestonePct) fd.append('retainage_milestone_pct', retainageMilestonePct);
      if (retainageReducedRate) fd.append('retainage_reduced_rate', parseFloat(retainageReducedRate) / 100);
    }
    const data = await payAppReview2Api.create(fd, setElapsed);
    setResult({ id: data.id, report: data.report, extracted: { current, previous }, previousReviewId });
    // A review may have created a project (or added to one), so refresh both the
    // dropdown and the budget panel rather than leaving stale numbers on screen.
    if (data.projectId && !projectId) setProjectId(String(data.projectId));
    else refreshBudget();
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
      // Separately-sent backup is read alongside the pay app, in the same step. It used to be
      // attached to the review call, which accepted it and never opened it.
      for (const f of backupFiles) fd.append('backup_files', f);
      const extracted = await payAppReview2Api.extract(fd, setElapsed);
      setBackupRead(extracted.backupRead || null);

      // With no previous PDF uploaded, fall back to the last pay app already on file.
      // Matching on the selected project's ID is exact; matching on the name text read
      // off the PDF is a guess, and misses when a vendor respells the project.
      let previousData = extracted.previous;
      let previousReviewId = null;
      if (!previousFile && (projectId || extracted.current.summary.projectName)) {
        const match = await payAppReview2Api.latestForProject({
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
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not analyze these pay applications.');
    } finally {
      setAnalyzing(false);
      setElapsed(0);
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
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not recompute the review.');
    } finally {
      setRecomputing(false);
    }
  };

  const handleView = async id => {
    const record = await payAppReview2Api.get(id);
    // The backend builds the full report (both charts, worth-noting, compliance) from the
    // stored data, so use it directly rather than reassembling it here — a second builder
    // silently drifts from the first.
    setViewing({ id, report: record.report });
    setResult(null);
  };

  const handleDelete = async id => {
    if (!(await confirm('Delete this pay app review from history? The original PDF is removed too.'))) return;
    await payAppReview2Api.delete(id);
    if (viewing?.id === id) setViewing(null);
    loadHistory();
    refreshBudget();
  };

  const reset = () => {
    setCurrentFile(null); setPreviousFile(null); setBackupFiles([]); setHistoryMatch(null);
    setUsePreviousFromHistory(false); setResult(null); setViewing(null); setError(''); setEditing(false);
    setContractSum(''); setCoLogCsv(''); setRetainageRate(''); setRetainageMilestonePct(''); setRetainageReducedRate('');
  };

  const [confirm, confirmDialog] = useConfirm();

  return (
    <div className="p-8">
      {confirmDialog}
      <PageHeader
        title="Pay App Reviewer 2"
        subtitle="Reviews a CSP pay application against the contract and last month's application. Subcontractor billings and GMP contingency are not checked here."
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
                <h2 className="text-sm font-semibold text-gray-900">New Pay App Review — Sandbox</h2>
              </div>
              {(currentFile || previousFile || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            {!routeProjectId && (
            <div>
              <label className="label">Project</label>
              {addingProject ? (
                <div className="space-y-2">
                  <input
                    className="input" autoFocus placeholder="Project name — e.g. Aldine ISD — Middle School Rebuild"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); createProject(); }
                      if (e.key === 'Escape') { setAddingProject(false); setNewProjectName(''); }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn-primary flex-1 justify-center py-1.5 text-xs"
                      onClick={createProject} disabled={creatingProject || !newProjectName.trim()}>
                      {creatingProject ? 'Adding…' : 'Add project'}
                    </button>
                    <button type="button" className="btn-secondary px-3 py-1.5 text-xs"
                      onClick={() => { setAddingProject(false); setNewProjectName(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <select
                  className="input" value={projectId}
                  onChange={e => {
                    if (e.target.value === '__new__') { setAddingProject(true); return; }
                    setProjectId(e.target.value);
                  }}
                >
                  <option value="">
                    {projects.length ? 'Which project is this pay app for?' : 'No projects yet — add one to get started'}
                  </option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.project_name}
                      {p.pay_app_count > 0
                        ? ` — ${p.pay_app_count} reviewed, latest App #${p.latest_application_number ?? '—'}`
                        : ' — no pay apps yet'}
                    </option>
                  ))}
                  <option value="__new__">+ Add a new project…</option>
                </select>
              )}
              {!addingProject && (
                <p className="text-xs text-gray-400 mt-1">
                  {projectId
                    ? 'This application will be compared against this project\'s billing history.'
                    : 'Pick a project, or add one — then upload the contract and pay applications below.'}
                </p>
              )}
            </div>
            )}

            <DeliveryMethodNote method={deliveryMethod} />

            <ContractPanel projectId={projectId} docs={governingDocs}
              deliveryMethod={deliveryMethod}
              otherIds={otherContractIds} onOtherIds={setOtherContractIds}
              onChange={loadContract} />


            <FileDrop file={currentFile} onChange={setCurrentFile} label="Current Pay Application (PDF) *" />
            <FileDrop file={previousFile} onChange={setPreviousFile} label="Previous Pay Application (PDF)" />

            {/* Not gated on a contract being on file. It used to be, which meant a job running on a
                purchase order alone could not hand Coaster the invoices it was asking for — while
                the panel above said, correctly, that the review runs without a contract. */}
            <div>
                <label className="label">Extra Backup Documentation (PDF)</label>
                <input
                  type="file" multiple accept=".pdf"
                  className="text-xs text-gray-500 w-full file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 file:cursor-pointer"
                  onChange={e => { setBackupFiles(Array.from(e.target.files || [])); setBackupRead(null); }}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {backupFiles.length > 0
                    ? `${backupFiles.length} file${backupFiles.length === 1 ? '' : 's'} added. `
                    : 'Optional. '}
                  Receipts and invoices bundled inside the pay app above are read automatically — only add files here if they arrived separately.
                </p>
                {backupRead && (
                  <p className="text-[11px] mt-1" style={{ color: '#047857' }}>
                    Read from {backupRead.files} file{backupRead.files === 1 ? '' : 's'}:{' '}
                    {backupRead.documents} invoice{backupRead.documents === 1 ? '' : 's'} or receipt
                    {backupRead.documents === 1 ? '' : 's'}
                    {backupRead.waivers ? `, ${backupRead.waivers} lien waiver${backupRead.waivers === 1 ? '' : 's'}` : ''}
                    {backupRead.breakdowns ? `, ${backupRead.breakdowns} cost breakdown${backupRead.breakdowns === 1 ? '' : 's'}` : ''}.
                  </p>
                )}
            </div>

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
                  {elapsed > 8
                    ? `Reading the documents… ${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`
                    : 'Analyzing pay applications…'}
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
                  <button className="btn-primary px-3 py-1.5" onClick={() => downloadMarkedUp(result.id)} disabled={markingUp}>
                    <PencilSquareIcon className="w-4 h-4" /> {markingUp ? 'Marking up…' : 'Marked-Up PDF'}
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReview2Api.downloadPdf(result.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF Report
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={reset}>New</button>
                </div>
              </div>
              <PayAppFindingsReport reviewId={result.id} api={payAppReview2Api} />
            </>
          )}

          {viewing && !result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Stored Review</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-primary px-3 py-1.5" onClick={() => downloadMarkedUp(viewing.id)} disabled={markingUp}>
                    <PencilSquareIcon className="w-4 h-4" /> {markingUp ? 'Marking up…' : 'Marked-Up PDF'}
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReview2Api.downloadPdf(viewing.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF Report
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => payAppReview2Api.downloadOriginal(viewing.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Original PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => setViewing(null)}>Close</button>
                </div>
              </div>
              <PayAppFindingsReport reviewId={viewing.id} api={payAppReview2Api} />
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
