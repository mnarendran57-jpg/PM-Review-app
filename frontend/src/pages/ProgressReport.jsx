import { useState, useEffect, useRef } from 'react';
import {
  CameraIcon, SparklesIcon, DocumentTextIcon, TrashIcon, ClockIcon, XMarkIcon,
  ExclamationTriangleIcon, CheckCircleIcon, PhotoIcon, PlusIcon,
} from '@heroicons/react/24/outline';
import { progressReportApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';

// Add photos one at a time — each photo gets its description before the next is added.
// The running list of what's already in the report is shown so the PM can see progress
// and remove any mistakes without leaving the dialog.
function AddPhotosModal({ photos, onAdd, onRemove, onClose }) {
  const [pending, setPending] = useState(null); // { file, url }
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef();

  const choose = files => {
    const f = Array.from(files).find(x => /\.jpe?g$/i.test(x.name) || x.type === 'image/jpeg');
    if (!f) { setErr('Only JPG/JPEG images are supported.'); return; }
    setErr('');
    if (pending) URL.revokeObjectURL(pending.url);
    setPending({ file: f, url: URL.createObjectURL(f) });
    setDesc('');
  };

  const confirmAdd = () => {
    if (!pending || !desc.trim()) return;
    onAdd(pending.file, desc.trim());
    URL.revokeObjectURL(pending.url);
    setPending(null); setDesc('');
    fileRef.current?.focus();
  };

  const discardPending = () => {
    if (pending) URL.revokeObjectURL(pending.url);
    setPending(null); setDesc('');
  };

  return (
    <Modal title="Add Photos" onClose={onClose} size="lg">
      <div className="space-y-4">
        {!pending ? (
          <div
            onClick={() => fileRef.current.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); choose(e.dataTransfer.files); }}
            className="rounded-xl px-4 py-8 text-center cursor-pointer"
            style={{ border: '2px dashed #e2e8f0', background: '#fafbfc' }}
          >
            <input ref={fileRef} type="file" accept=".jpg,.jpeg" className="hidden"
              onChange={e => { choose(e.target.files); e.target.value = ''; }} />
            <PhotoIcon className="w-7 h-7 mx-auto" style={{ color: '#f43f5e' }} />
            <p className="text-sm font-medium text-gray-700 mt-2">Choose a photo to add</p>
            <p className="text-[11px] text-gray-400">JPG/JPEG · you'll describe it next</p>
          </div>
        ) : (
          <div className="p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
            <div className="flex gap-3">
              <img src={pending.url} alt="" className="w-28 h-28 rounded-lg object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <label className="label">What does this photo show? *</label>
                <textarea className="input" rows={3} autoFocus value={desc}
                  onChange={e => setDesc(e.target.value)}
                  placeholder="e.g. Level 2 ductwork rough-in complete along the east corridor" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button className="btn-secondary px-3 py-1.5 text-xs" onClick={discardPending}>Choose different</button>
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={confirmAdd} disabled={!desc.trim()}>
                <PlusIcon className="w-4 h-4" /> Add to report
              </button>
            </div>
          </div>
        )}

        {err && <p className="text-xs" style={{ color: '#b91c1c' }}>{err}</p>}

        {/* Running list of photos already added */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">
            In this report ({photos.length})
          </p>
          {photos.length === 0 ? (
            <p className="text-xs text-gray-400">No photos added yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {photos.map((p, i) => (
                <div key={i} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
                  <img src={p.url} alt="" className="w-10 h-10 rounded-md object-cover flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-gray-400">Photo {i + 1}</p>
                    <p className="text-xs text-gray-700 truncate">{p.caption}</p>
                  </div>
                  <button type="button" className="flex-shrink-0 text-gray-400 hover:text-red-600" onClick={() => onRemove(i)}>
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <button className="btn-primary" onClick={onClose}>Done{photos.length ? ` — ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}</button>
        </div>
      </div>
    </Modal>
  );
}

const FREQUENCIES = ['Weekly', 'Bi-weekly', 'Monthly', 'One-off visit'];

function ReportView({ report, header }) {
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-base font-bold text-gray-900">{report.title || 'Site Progress Report'}</h3>
        <p className="text-xs text-gray-400 mt-1">
          {[header?.frequency, header?.periodLabel, header?.visitDate].filter(Boolean).join(' · ')}
          {header?.imageCount ? ` · ${header.imageCount} photos` : ''}
        </p>
        {report.executiveSummary && <p className="text-sm text-gray-700 mt-3 leading-relaxed">{report.executiveSummary}</p>}
      </div>

      {report.workObserved?.length > 0 && (
        <div className="card p-5 space-y-2.5">
          <h3 className="text-sm font-semibold text-gray-900">Work Observed This Period</h3>
          {report.workObserved.map((w, i) => (
            <div key={i}>
              <p className="text-sm font-medium text-gray-900">{w.area || 'General'}</p>
              <p className="text-xs text-gray-600 mt-0.5">{w.observation}</p>
            </div>
          ))}
        </div>
      )}

      {report.issuesAndConcerns?.length > 0 && (
        <div className="card p-5 space-y-2" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: '#c2410c' }}>
            <ExclamationTriangleIcon className="w-4 h-4" /> Issues &amp; Concerns
          </h3>
          {report.issuesAndConcerns.map((it, i) => <p key={i} className="text-xs text-gray-700">• {it}</p>)}
        </div>
      )}

      {report.recommendedNextSteps?.length > 0 && (
        <div className="card p-5 space-y-2">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <CheckCircleIcon className="w-4 h-4" style={{ color: '#059669' }} /> Recommended Next Steps
          </h3>
          {report.recommendedNextSteps.map((s, i) => <p key={i} className="text-xs text-gray-700">• {s}</p>)}
        </div>
      )}

      {report.photoLog?.length > 0 && (
        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Photo Log</h3>
          {report.photoLog.map((p, i) => (
            <div key={i} className="pb-2" style={{ borderBottom: i < report.photoLog.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
              <p className="text-sm font-medium text-gray-900">Photo {p.photo ?? i + 1}{p.caption ? ` — ${p.caption}` : ''}</p>
              <p className="text-xs text-gray-600 mt-0.5">{p.observation}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0"
          style={{ background: 'rgba(244,63,94,0.08)', color: '#e11d48' }}>
          {item.frequency || 'Report'}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{item.period_label || 'Site progress report'}</p>
          <p className="text-xs text-gray-400 mt-0.5">{item.image_count} photos{item.visit_date ? ` · ${item.visit_date}` : ''}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export default function ProgressReport() {
  const ctx = useProject();
  const routeProjectId = ctx?.projectId;

  const [frequency, setFrequency] = useState('Weekly');
  const [periodLabel, setPeriodLabel] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]); // { file, caption, url }
  const [showAddPhotos, setShowAddPhotos] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // { id, report, header }
  const [viewing, setViewing] = useState(null); // { id, report, header }
  const [history, setHistory] = useState([]);

  const loadHistory = () => progressReportApi.list(routeProjectId ? { project_id: routeProjectId } : undefined).then(setHistory);
  useEffect(() => { loadHistory(); }, [routeProjectId]);

  // Object URLs for previews are revoked on unmount to avoid leaks.
  useEffect(() => () => photos.forEach(p => URL.revokeObjectURL(p.url)), []); // eslint-disable-line

  const addOne = (file, caption) => {
    setError('');
    setPhotos(prev => [...prev, { file, caption, url: URL.createObjectURL(file) }]);
  };
  const removeAt = idx => setPhotos(prev => { URL.revokeObjectURL(prev[idx]?.url); return prev.filter((_, i) => i !== idx); });

  const handleGenerate = async () => {
    if (photos.length === 0) { setError('Upload at least one site photo first.'); return; }
    setError(''); setGenerating(true); setResult(null); setViewing(null);
    try {
      const fd = new FormData();
      photos.forEach(p => fd.append('images', p.file));
      fd.append('captions', JSON.stringify(photos.map(p => p.caption)));
      fd.append('frequency', frequency);
      if (periodLabel) fd.append('period_label', periodLabel);
      if (visitDate) fd.append('visit_date', visitDate);
      if (notes) fd.append('notes', notes);
      if (routeProjectId) fd.append('project_id', routeProjectId);
      const data = await progressReportApi.create(fd);
      setResult({ id: data.id, report: data.report, header: data.header });
      loadHistory();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate the progress report.');
    } finally {
      setGenerating(false);
    }
  };

  const handleView = async id => {
    const rec = await progressReportApi.get(id);
    setResult(null);
    setViewing({ id: rec.id, report: rec.report, header: rec.header });
  };

  const handleDelete = async id => {
    await progressReportApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    if (result?.id === id) setResult(null);
    loadHistory();
  };

  const reset = () => {
    photos.forEach(p => URL.revokeObjectURL(p.url));
    setPhotos([]); setPeriodLabel(''); setVisitDate(''); setNotes(''); setResult(null); setError('');
  };
  const active = result || viewing;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={CameraIcon}
        accent="rose"
        title="Progress Report"
        subtitle="Upload site-visit photos with captions — Claude writes a progress report to send to the team"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #f43f5e, #e11d48)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)' }}>
                  <CameraIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Progress Report</h2>
              </div>
              {(photos.length > 0 || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Visit Frequency</label>
                <select className="input" value={frequency} onChange={e => setFrequency(e.target.value)}>
                  {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Visit Date</label>
                <input className="input" type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="label">Reporting Period (optional)</label>
              <input className="input" value={periodLabel} onChange={e => setPeriodLabel(e.target.value)}
                placeholder="e.g. Week of Jul 21, 2026" />
            </div>

            {/* Photos are added one at a time, each with its description, in a dialog */}
            <div>
              <label className="label">Site Photos (JPG/JPEG) *</label>
              <button type="button" onClick={() => setShowAddPhotos(true)}
                className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-colors"
                style={{ border: '2px dashed #f9a8b4', background: 'rgba(244,63,94,0.04)', color: '#e11d48' }}>
                <PlusIcon className="w-5 h-5" /> Add Photos
              </button>

              {photos.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {photos.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
                      <img src={p.url} alt="" className="w-10 h-10 rounded-md object-cover flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] text-gray-400">Photo {i + 1}</p>
                        <p className="text-xs text-gray-700 truncate">{p.caption || <span className="text-gray-400 italic">No description</span>}</p>
                      </div>
                      <button type="button" className="flex-shrink-0 text-gray-400 hover:text-red-600" onClick={() => removeAt(i)}>
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="label">Overall Notes for This Visit (optional)</label>
              <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Anything the report should account for that isn't obvious from the photos" />
            </div>

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleGenerate} disabled={generating || photos.length === 0}>
              {generating ? (<><SparklesIcon className="w-4 h-4 animate-pulse" /> Generating…</>) : (<><SparklesIcon className="w-4 h-4" /> Analyze &amp; Generate Report</>)}
            </button>
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {active && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">{result ? 'Generated Report' : 'Saved Report'}</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5" onClick={() => progressReportApi.downloadMarkdown(active.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> Download .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => { setResult(null); setViewing(null); }}>Close</button>
                </div>
              </div>
              <ReportView report={active.report} header={active.header} />
            </>
          )}

          {!active && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Report History</h2>
              {history.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-400">
                  No progress reports yet. Upload this visit's photos to generate one.
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

      {showAddPhotos && (
        <AddPhotosModal
          photos={photos}
          onAdd={addOne}
          onRemove={removeAt}
          onClose={() => setShowAddPhotos(false)}
        />
      )}
    </div>
  );
}
