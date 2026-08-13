import { useState, useEffect } from 'react';
import {
  CloudArrowUpIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon,
  DocumentTextIcon, DocumentMagnifyingGlassIcon, ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';
import { preconReviewApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import { useConfirm } from '../components/ConfirmDialog';
import MultiFileDrop from '../components/MultiFileDrop';
import PreconReviewView from '../components/PreconReviewView';
import ProposalComparisonView from '../components/ProposalComparisonView';

function HistoryItem({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        {item.insufficient_info ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0" style={{ background: '#fef3c7', color: '#92400e' }}>
            Needs more info
          </span>
        ) : (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0" style={{ background: '#eff6ff', color: '#1d4ed8' }}>
            Review
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{item.project_name || 'Untitled Project'}</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{(item.file_names || []).join(', ')}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export default function PreconReview() {
  const ctx = useProject();
  const routeProjectName = ctx?.project?.project_name;
  const [files, setFiles] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [reviewFocus, setReviewFocus] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { id, report }
  const [history, setHistory] = useState([]);
  const [viewing, setViewing] = useState(null); // { id, report }
  // Which of the project's Shared Documents the proposal is checked against. Empty means the
  // review runs exactly as it always has — the comparison is an addition, not a requirement.
  const [projectDocs, setProjectDocs] = useState([]);
  const [checkAgainst, setCheckAgainst] = useState([]);

  const loadHistory = () => preconReviewApi.list(routeProjectName ? { project_name: routeProjectName } : undefined).then(setHistory);
  useEffect(() => { loadHistory(); }, [routeProjectName]);

  // The project's shared documents — the drawings and the contract are normally among them, and
  // they are what a proposal is supposed to be pricing.
  useEffect(() => {
    if (!ctx?.projectId) { setProjectDocs([]); return; }
    payAppReviewApi.listDocuments(ctx.projectId)
      .then(all => setProjectDocs(all.filter(d => d.doc_type !== 'memo-cover')))
      .catch(() => setProjectDocs([]));
  }, [ctx?.projectId]);

  const reset = () => {
    setFiles([]); setProjectName(''); setReviewFocus(''); setCheckAgainst([]);
    setResult(null); setViewing(null); setError('');
  };

  const handleGenerate = async () => {
    if (files.length === 0) { setError('Upload at least one document first.'); return; }
    setError(''); setGenerating(true); setResult(null); setViewing(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('documents', f));
      if (routeProjectName || projectName) fd.append('project_name', routeProjectName || projectName);
      if (reviewFocus) fd.append('review_focus', reviewFocus);
      if (ctx?.projectId && checkAgainst.length) {
        fd.append('project_id', ctx.projectId);
        fd.append('document_ids', checkAgainst.join(','));
      }
      const data = await preconReviewApi.create(fd);
      setResult(data);
      loadHistory();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate the review.');
    } finally {
      setGenerating(false);
    }
  };

  const handleView = async id => {
    const record = await preconReviewApi.get(id);
    setViewing({
      id,
      report: {
        projectName: record.project_name,
        reviewFocus: record.review_focus,
        fileNames: record.file_names,
        ...record.report_json,
      },
      comparison: record.comparison,
    });
    setResult(null);
  };

  const handleDelete = async id => {
    if (!(await confirm('Delete this pre-construction review from history? The uploaded documents are removed too.'))) return;
    await preconReviewApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    loadHistory();
  };

  const [confirm, confirmDialog] = useConfirm();

  return (
    <div className="p-8">
      {confirmDialog}
      <PageHeader
        title="Pre-Construction Document Review"
        subtitle="Upload drawings, specs, proposals, or narratives to get a risk, cost, and change-order review before construction starts"
        icon={ClipboardDocumentCheckIcon}
        accent="emerald"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #10b981, #059669)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}>
                  <DocumentMagnifyingGlassIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Pre-Construction Review</h2>
              </div>
              {(files.length > 0 || projectName || reviewFocus) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <MultiFileDrop files={files} onChange={setFiles} label="Project Documents *" />

            {!routeProjectName && (
              <div>
                <label className="label">Project Name (optional)</label>
                <input className="input" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="e.g. HCC Building Mechanical Upgrade" />
              </div>
            )}
            {/* Checking the proposal against the documents it is meant to price. The design set
                is NOT read — its text is searched for scope language for free, and only the
                dozen-odd pages carrying it are sent on. That is the difference between adding a
                tenth to the cost of a review and multiplying it by twenty. */}
            {ctx?.projectId && (
              <div>
                <label className="label">Check it against (optional)</label>
                {projectDocs.length === 0 ? (
                  <p className="text-[11px] text-gray-400">
                    No shared documents on this project yet. Upload the drawings or the contract on
                    the project's Shared Documents page and they can be compared against here.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1">
                      {projectDocs.map(d => (
                        <label key={d.id} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="checkbox" className="mt-0.5"
                            checked={checkAgainst.includes(d.id)}
                            onChange={() => setCheckAgainst(
                              checkAgainst.includes(d.id)
                                ? checkAgainst.filter(x => x !== d.id)
                                : [...checkAgainst, d.id])}
                          />
                          <span className="text-[12px] text-gray-700">
                            {d.label || d.file_name}
                            <span className="text-gray-400"> · {d.doc_type}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1.5">
                      {checkAgainst.length
                        ? 'The proposal will be checked for work outside the contract, work that '
                          + 'differs from the drawings, and work the documents require but nobody priced.'
                        : 'Tick the drawings and the contract to have the proposal checked against '
                          + 'them. Only the pages carrying scope language are read.'}
                    </p>
                  </>
                )}
              </div>
            )}

            <div>
              <label className="label">Review Focus (optional)</label>
              <textarea className="input" rows={2} value={reviewFocus} onChange={e => setReviewFocus(e.target.value)} placeholder="e.g. Pay attention to electrical capacity and phasing risk" />
            </div>

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleGenerate} disabled={generating || files.length === 0}>
              {generating ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Analyzing documents…
                </span>
              ) : (
                <span className="flex items-center gap-2"><SparklesIcon className="w-4 h-4" /> Generate Review</span>
              )}
            </button>

            {/* A full drawing set is read 40 pages at a time, one pass after another, with a
                pause between them to stay inside the account's per-minute allowance. That is
                genuinely minutes of work, and a spinner with no explanation reads as a hang —
                which is what a large upload looked like before. */}
            {generating && (
              <p className="text-[11px] text-gray-500 text-center leading-relaxed">
                Large sets are read in sections, a few minutes each. Leave this tab open —
                closing it cancels the review.
              </p>
            )}
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Review Result</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-primary px-3 py-1.5" onClick={() => preconReviewApi.downloadPdf(result.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => preconReviewApi.downloadMarkdown(result.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={reset}>New</button>
                </div>
              </div>
              <PreconReviewView report={result.report} />
              <ProposalComparisonView comparison={result.comparison} error={result.comparisonError}
                downloadUrl={preconReviewApi.comparisonMarkdownUrl(result.id)} />
            </>
          )}

          {viewing && !result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Stored Review</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-primary px-3 py-1.5" onClick={() => preconReviewApi.downloadPdf(viewing.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => preconReviewApi.downloadMarkdown(viewing.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => setViewing(null)}>Close</button>
                </div>
              </div>
              <PreconReviewView report={viewing.report} />
              <ProposalComparisonView comparison={viewing.comparison}
                downloadUrl={preconReviewApi.comparisonMarkdownUrl(viewing.id)} />
            </>
          )}

          {!result && !viewing && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Review History</h2>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="card px-5 py-12 text-center">
                    <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    <p className="text-sm text-gray-400">No documents reviewed yet.</p>
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
