import { useState, useEffect, useRef } from 'react';
import { CloudArrowUpIcon, MagnifyingGlassIcon, TrashIcon, ClockIcon, DocumentTextIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { reviewsApi, projectsApi } from '../api';
import PageHeader from '../components/PageHeader';

const DOC_TYPES = [
  'Pay Application', 'Invoice', 'RFI', 'Submittal',
  'Change Order', 'Construction Drawing', 'General / Other'
];

const TYPE_COLORS = {
  'Pay Application': { bg: '#eff6ff', color: '#1d4ed8' },
  'Invoice':         { bg: '#faf5ff', color: '#7e22ce' },
  'RFI':             { bg: '#fff7ed', color: '#c2410c' },
  'Submittal':       { bg: '#fefce8', color: '#a16207' },
  'Change Order':    { bg: '#fef2f2', color: '#b91c1c' },
  'Construction Drawing': { bg: '#f0fdf4', color: '#15803d' },
  'General / Other': { bg: '#f9fafb', color: '#6b7280' },
};

function AIReview({ text }) {
  const lines = text.split('\n');
  return (
    <div className="ai-review space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
        if (line.startsWith('### ')) return <h3 key={i}>{line.slice(4)}</h3>;
        if (line.startsWith('- ')) return <li key={i}>{line.slice(2)}</li>;
        if (line.startsWith('**') && line.endsWith('**')) {
          const content = line.slice(2, -2);
          const isRec = /APPROVE|HOLD|REJECT|HIGH|MEDIUM|LOW|REVISE|NEGOTIATE/i.test(content);
          return (
            <p key={i} className={isRec
              ? 'inline-flex px-3 py-1.5 rounded-lg text-sm font-bold bg-amber-50 text-amber-800 border border-amber-200'
              : ''
            }>
              <strong>{content}</strong>
            </p>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

function HistoryItem({ item, onDelete }) {
  const [open, setOpen] = useState(false);
  const date = new Date(item.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  const tc = TYPE_COLORS[item.document_type] || TYPE_COLORS['General / Other'];

  return (
    <div className="card overflow-hidden" style={{ borderLeft: `3px solid ${tc.color}` }}>
      <div
        className="flex items-center justify-between px-5 py-3.5 cursor-pointer"
        style={{ transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#fafbfc'}
        onMouseLeave={e => e.currentTarget.style.background = ''}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide flex-shrink-0"
            style={{ background: tc.bg, color: tc.color }}
          >
            {item.document_type}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{item.file_name}</p>
            {item.project_name && (
              <p className="text-xs text-gray-400 mt-0.5">{item.project_name}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <ClockIcon className="w-3.5 h-3.5" />{date}
          </span>
          <button
            className="btn-danger"
            onClick={e => { e.stopPropagation(); onDelete(item.id); }}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #f3f4f6', background: '#fafbfc' }} className="px-5 py-4">
          {item.context_notes && (
            <div className="mb-4 p-3 rounded-xl" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
              <p className="text-[11px] font-semibold uppercase tracking-widest mb-1" style={{ color: '#92400e' }}>Context Notes</p>
              <p className="text-sm" style={{ color: '#78350f' }}>{item.context_notes}</p>
            </div>
          )}
          <AIReview text={item.ai_review} />
        </div>
      )}
    </div>
  );
}

export default function DocumentReview() {
  const [projects, setProjects] = useState([]);
  const [docType, setDocType] = useState('Pay Application');
  const [generalSubType, setGeneralSubType] = useState('');
  const [projectName, setProjectName] = useState('');
  const [contextNotes, setContextNotes] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    projectsApi.list().then(setProjects);
    loadHistory();
  }, []);

  const loadHistory = () => reviewsApi.list().then(setHistory);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!file) { setError('Please select a file.'); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('document_type', docType);
      fd.append('general_sub_type', generalSubType);
      fd.append('context_notes', contextNotes);
      fd.append('project_name', projectName);
      const data = await reviewsApi.submit(fd);
      setResult(data.review);
      loadHistory();
    } catch (err) {
      setError(err.response?.data?.error || 'Review failed. Check your API key and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async id => {
    if (!confirm('Remove this review from history?')) return;
    await reviewsApi.delete(id);
    loadHistory();
  };

  const filteredHistory = history.filter(h => {
    if (filterType && h.document_type !== filterType) return false;
    if (search && !h.file_name.toLowerCase().includes(search.toLowerCase()) &&
        !h.ai_review.toLowerCase().includes(search.toLowerCase()) &&
        !(h.project_name || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="p-8">
      <PageHeader
        title="Document Review"
        subtitle="AI-powered analysis using Claude — upload any construction document"
      />

      <div className="grid grid-cols-5 gap-6">
        {/* Upload panel */}
        <div className="col-span-2 space-y-4">
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)' }}>
                <SparklesIcon className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">Upload &amp; Review</h2>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Drop zone */}
              <div
                onClick={() => fileRef.current.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); setFile(e.dataTransfer.files[0]); }}
                style={{
                  border: `2px dashed ${dragOver ? '#f59e0b' : file ? '#10b981' : '#e2e8f0'}`,
                  borderRadius: '14px',
                  padding: '28px 20px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? 'rgba(245,158,11,0.04)' : file ? 'rgba(16,185,129,0.04)' : '#fafbfc',
                  transition: 'all 0.2s',
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx"
                  onChange={e => setFile(e.target.files[0])}
                />
                {file ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ background: '#d1fae5' }}>
                      <DocumentTextIcon className="w-5 h-5" style={{ color: '#059669' }} />
                    </div>
                    <p className="text-sm font-semibold text-gray-800">{file.name}</p>
                    <p className="text-xs" style={{ color: '#059669' }}>Ready to review · click to change</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ background: '#fff7ed' }}>
                      <CloudArrowUpIcon className="w-5 h-5" style={{ color: '#f97316' }} />
                    </div>
                    <p className="text-sm font-medium text-gray-700">Drop file here or click to browse</p>
                    <p className="text-xs text-gray-400">PDF, PNG, JPG, DOCX, XLSX · max 20 MB</p>
                  </div>
                )}
              </div>

              <div>
                <label className="label">Document Type</label>
                <select className="input" value={docType} onChange={e => { setDocType(e.target.value); setGeneralSubType(''); }}>
                  {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>

              {docType === 'General / Other' && (
                <div>
                  <label className="label">Specify Document Type</label>
                  <input
                    className="input"
                    placeholder="e.g. Proposal, Contract, Meeting Minutes, Letter…"
                    value={generalSubType}
                    onChange={e => setGeneralSubType(e.target.value)}
                  />
                </div>
              )}

              <div>
                <label className="label">Project (optional)</label>
                <select className="input" value={projectName} onChange={e => setProjectName(e.target.value)}>
                  <option value="">— Select project —</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.project_name}>{p.project_name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Context Notes (optional)</label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="e.g. Mechanical sub pay app for HCC Fine Arts, contract value $420,000"
                  value={contextNotes}
                  onChange={e => setContextNotes(e.target.value)}
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                  {error}
                </div>
              )}

              <button type="submit" className="btn-primary w-full justify-center" disabled={loading}>
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Analyzing document…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <SparklesIcon className="w-4 h-4" />
                    Review Document
                  </span>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Result / History panel */}
        <div className="col-span-3 space-y-5">
          {result && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between"
                style={{ background: 'linear-gradient(135deg, #fffbeb 0%, #fff7ed 100%)', borderBottom: '1px solid #fde68a' }}>
                <div className="flex items-center gap-2">
                  <SparklesIcon className="w-4 h-4" style={{ color: '#d97706' }} />
                  <h2 className="text-sm font-semibold" style={{ color: '#92400e' }}>AI Review — {docType}</h2>
                </div>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
                  style={{ background: '#d1fae5', color: '#065f46' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#10b981' }} />
                  Complete
                </span>
              </div>
              <div className="p-5">
                <AIReview text={result} />
              </div>
            </div>
          )}

          {/* History */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-semibold text-gray-900 flex-1">Review History</h2>
              <div className="relative">
                <MagnifyingGlassIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  className="input pl-8 py-1.5 w-44 text-xs"
                  placeholder="Search reviews…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <select className="input py-1.5 text-xs w-44" value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="">All types</option>
                {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              {filteredHistory.length === 0 ? (
                <div className="card px-5 py-12 text-center">
                  <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                  <p className="text-sm text-gray-400">No reviews yet. Upload a document to get started.</p>
                </div>
              ) : (
                filteredHistory.map(h => (
                  <HistoryItem key={h.id} item={h} onDelete={handleDelete} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
