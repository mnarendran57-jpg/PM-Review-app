import { useState, useEffect } from 'react';
import {
  CloudArrowUpIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon,
  DocumentTextIcon, DocumentMagnifyingGlassIcon, ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';
import { preconReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import MultiFileDrop from '../components/MultiFileDrop';
import PreconReviewView from '../components/PreconReviewView';

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

  const loadHistory = () => preconReviewApi.list().then(setHistory);
  useEffect(() => { loadHistory(); }, []);

  const reset = () => {
    setFiles([]); setProjectName(''); setReviewFocus('');
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
    });
    setResult(null);
  };

  const handleDelete = async id => {
    if (!confirm('Delete this pre-construction review from history?')) return;
    await preconReviewApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    loadHistory();
  };

  return (
    <div className="p-8">
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
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Review Result</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => preconReviewApi.downloadMarkdown(result.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={reset}>New</button>
                </div>
              </div>
              <PreconReviewView report={result.report} />
            </>
          )}

          {viewing && !result && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Stored Review</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => preconReviewApi.downloadMarkdown(viewing.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => setViewing(null)}>Close</button>
                </div>
              </div>
              <PreconReviewView report={viewing.report} />
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
