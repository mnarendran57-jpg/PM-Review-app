import { useState, useEffect, useRef } from 'react';
import {
  CameraIcon, SparklesIcon, DocumentTextIcon, TrashIcon, ClockIcon, XMarkIcon,
  PhotoIcon, PlusIcon, ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';
import { progressReportApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';

const FREQUENCIES = ['Weekly', 'Bi-weekly', 'Monthly', 'One-off visit'];

// Add photos one at a time — each photo gets its description before the next is added.
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
                  placeholder="e.g. Irrigation works on site" />
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

// The report as laid out in the standard template: header block, Progress bullets, and a
// captioned photo grid. localPhotos (present only for a just-generated report) supply the
// thumbnails; the downloadable PDF always contains the full-size images.
function ReportView({ report, header, localPhotos }) {
  const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
  const field = (label, value) => (
    <div className="flex gap-2 text-sm">
      <span className="text-gray-400 w-28 flex-shrink-0">{label}</span>
      <span className="text-gray-900">{value || '—'}</span>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-3">
        <h3 className="text-base font-bold text-gray-900">{header.projectName || 'Project'} Progress Report{num}</h3>
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
          {field('Date', header.visitDate)}
          {field('Time', header.visitTime)}
          {field('Weather', header.weather)}
        </div>
        <div className="space-y-1">
          {field('Submitted By', header.submittedBy)}
          {field('Project', header.projectName)}
          {field('Contractor', header.contractor)}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Progress</h3>
        {report.progress?.length ? (
          <ul className="space-y-1.5">
            {report.progress.map((p, i) => (
              <li key={i} className="text-sm text-gray-700 flex gap-2"><span className="text-gray-400">•</span><span>{p}</span></li>
            ))}
          </ul>
        ) : <p className="text-sm text-gray-400">No observations recorded.</p>}
      </div>

      {localPhotos?.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Site Pictures</h3>
          <div className="grid grid-cols-2 gap-4">
            {localPhotos.map((p, i) => (
              <div key={i}>
                <img src={p.url} alt="" className="w-full rounded-lg object-cover" style={{ maxHeight: 180 }} />
                <p className="text-xs text-gray-500 text-center mt-1">{p.caption}</p>
              </div>
            ))}
          </div>
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
          #{item.report_number ?? '—'}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">Progress Report{item.report_number != null ? `-${item.report_number}` : ''}</p>
          <p className="text-xs text-gray-400 mt-0.5">{item.image_count} photos{item.visit_date ? ` · ${item.visit_date}` : ''}{item.contractor ? ` · ${item.contractor}` : ''}</p>
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
  const [reportNumber, setReportNumber] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [visitTime, setVisitTime] = useState('');
  const [weather, setWeather] = useState('');
  const [submittedBy, setSubmittedBy] = useState(() => localStorage.getItem('pr_submitted_by') || '');
  const [contractor, setContractor] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]); // { file, caption, url }
  const [showAddPhotos, setShowAddPhotos] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // { id, report, header, localPhotos }
  const [viewing, setViewing] = useState(null); // { id, report, header }
  const [history, setHistory] = useState([]);

  const loadHistory = () => progressReportApi.list(routeProjectId ? { project_id: routeProjectId } : undefined).then(list => {
    setHistory(list);
    // Pre-fill the next sequential report number from history.
    const maxNum = list.reduce((m, r) => Math.max(m, r.report_number || 0), 0);
    setReportNumber(prev => prev === '' ? String(maxNum + 1) : prev);
  });
  useEffect(() => { loadHistory(); }, [routeProjectId]);

  useEffect(() => () => photos.forEach(p => URL.revokeObjectURL(p.url)), []); // eslint-disable-line

  const addOne = (file, caption) => {
    setError('');
    setPhotos(prev => [...prev, { file, caption, url: URL.createObjectURL(file) }]);
  };
  const removeAt = idx => setPhotos(prev => { URL.revokeObjectURL(prev[idx]?.url); return prev.filter((_, i) => i !== idx); });

  const handleGenerate = async () => {
    if (photos.length === 0) { setError('Add at least one site photo first.'); return; }
    setError(''); setGenerating(true); setResult(null); setViewing(null);
    if (submittedBy.trim()) localStorage.setItem('pr_submitted_by', submittedBy.trim());
    try {
      const fd = new FormData();
      photos.forEach(p => fd.append('images', p.file));
      fd.append('captions', JSON.stringify(photos.map(p => p.caption)));
      fd.append('frequency', frequency);
      if (reportNumber) fd.append('report_number', reportNumber);
      if (visitDate) fd.append('visit_date', visitDate);
      if (visitTime) fd.append('visit_time', visitTime);
      if (weather) fd.append('weather', weather);
      if (submittedBy) fd.append('submitted_by', submittedBy);
      if (contractor) fd.append('contractor', contractor);
      if (notes) fd.append('notes', notes);
      if (routeProjectId) fd.append('project_id', routeProjectId);
      const data = await progressReportApi.create(fd);
      setResult({ id: data.id, report: data.report, header: data.header, localPhotos: photos });
      loadHistory();
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not generate the progress report.');
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
    setPhotos([]); setVisitDate(''); setVisitTime(''); setWeather(''); setContractor(''); setNotes('');
    setResult(null); setError('');
  };
  const active = result || viewing;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={CameraIcon}
        accent="rose"
        title="Progress Report"
        subtitle="Add site-visit photos with descriptions — Claude writes the report, downloadable as a PDF for the team"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-4" style={{ '--card-accent': 'linear-gradient(90deg, #f43f5e, #e11d48)' }}>
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
                <label className="label">Report #</label>
                <input className="input" type="number" min="1" value={reportNumber} onChange={e => setReportNumber(e.target.value)} placeholder="Auto" />
              </div>
              <div>
                <label className="label">Date</label>
                <input className="input" type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Time</label>
                <input className="input" value={visitTime} onChange={e => setVisitTime(e.target.value)} placeholder="e.g. 12:30 PM" />
              </div>
              <div>
                <label className="label">Weather</label>
                <input className="input" value={weather} onChange={e => setWeather(e.target.value)} placeholder="e.g. Sunny" />
              </div>
              <div>
                <label className="label">Contractor</label>
                <input className="input" value={contractor} onChange={e => setContractor(e.target.value)} placeholder="e.g. ERC" />
              </div>
            </div>

            <div>
              <label className="label">Submitted By</label>
              <input className="input" value={submittedBy} onChange={e => setSubmittedBy(e.target.value)} placeholder="Your name" />
            </div>

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
                placeholder="Anything the Progress notes should account for that isn't obvious from the photos" />
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
                  <button className="btn-primary px-3 py-1.5" onClick={() => progressReportApi.downloadPdf(active.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Download PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => progressReportApi.downloadMarkdown(active.id)}>
                    <DocumentTextIcon className="w-4 h-4" /> .md
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => { setResult(null); setViewing(null); }}>Close</button>
                </div>
              </div>
              <ReportView report={active.report} header={active.header} localPhotos={active.localPhotos} />
            </>
          )}

          {!active && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Report History</h2>
              {history.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-400">
                  No progress reports yet. Add this visit's photos to generate one.
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
