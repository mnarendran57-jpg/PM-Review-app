import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon, ArrowDownTrayIcon, TrashIcon, PaperClipIcon, SparklesIcon,
  PaperAirplaneIcon, ArrowUturnLeftIcon, InboxArrowDownIcon, ClockIcon,
  CheckCircleIcon, ExclamationTriangleIcon, ScaleIcon, DocumentMagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { submittalsApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import FileDrop from '../components/FileDrop';

const REVIEW_ACTIONS = [
  'Approved', 'Approved as Noted', 'Revise and Resubmit', 'Rejected', 'For Record Only',
];

const SUBMITTAL_TYPES = [
  'Product Data', 'Shop Drawings', 'Samples', 'Test Reports',
  'Certificates', 'O&M Manuals', 'Closeout', 'Other',
];

// Mirrors the status keys the server derives in lib/submittalLog.js.
const STATUS_FILTERS = [
  { key: '', label: 'All submittals' },
  { key: 'open', label: 'Outstanding' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'with_ae', label: 'With A/E' },
  { key: 'awaiting_resubmittal', label: 'Awaiting resubmittal' },
  { key: 'not_sent', label: 'Not yet sent' },
  { key: 'closed', label: 'Closed' },
];

const today = () => new Date().toISOString().slice(0, 10);

// Dates are stored as plain YYYY-MM-DD with no zone. Splitting the string rather than
// parsing it keeps the displayed day identical to the one that was typed in, which
// `new Date('2026-08-05')` does not guarantee west of Greenwich.
function formatDate(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).split('-');
  if (!y || !m || !d) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1] || m} ${Number(d)}, ${y}`;
}

const errorText = (err, fallback) =>
  err?.friendlyMessage || err?.response?.data?.error || fallback;

// The log shows where a submittal stands; overdue is called out in place of "With A/E"
// because it is the one status that needs chasing today.
const statusLabelFor = row => (row.isOverdue ? 'Overdue' : row.statusLabel);

function SummaryTile({ icon: Icon, label, value, tone }) {
  const tones = {
    blue: { bg: '#eff6ff', color: '#1d4ed8' },
    red: { bg: '#fef2f2', color: '#b91c1c' },
    amber: { bg: '#fff7ed', color: '#c2410c' },
    green: { bg: '#f0fdf4', color: '#15803d' },
  };
  const t = tones[tone] || tones.blue;
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: t.bg }}>
        <Icon className="w-4.5 h-4.5" style={{ color: t.color, width: 18, height: 18 }} />
      </div>
      {/* The label wraps rather than truncating: four tiles across a sidebar-narrowed page
          leaves each one around 60px of text, and "Awaiting resubmittal" clipped to
          "Awa…" tells the reader nothing. */}
      <div className="min-w-0">
        <p className="text-[19px] font-extrabold leading-none text-gray-900">{value}</p>
        <p className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</p>
      </div>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

// --- Entering a new submittal -------------------------------------------------------------

const EMPTY = {
  submittal_number: '', spec_section: '', description: '', vendor: '',
  submittal_type: '', revision_number: 0, date_received: today(),
  // No date_forwarded here: it comes from the sent question below, not from a form field.
  // Kept in both, FormData carried two values under one key and the empty one won.
  notes: '',
};

// Reading the PDF is the intended way to fill this in, so the form asks for as little as
// possible: the number and a description, which are what make a log entry mean anything.
// Spec section, type, revision and dates are read off the submittal — they sit behind
// "More details", already filled, for the times something needs correcting. Asking a PM to
// type a CSI section by hand for every submittal is exactly the data entry this replaces.
// The project's Shared Documents, to choose what this submittal is read against. The
// specification is normally the one that matters; a memo cover never is.
function SubmittalDocumentPicker({ projectId, selected, onChange }) {
  const [docs, setDocs] = useState(undefined);

  useEffect(() => {
    if (!projectId) return;
    payAppReviewApi.listDocuments(projectId)
      .then(all => setDocs((all || []).filter(d => d.doc_type !== 'memo-cover')))
      .catch(() => setDocs([]));
  }, [projectId]);

  const toggle = id => onChange(
    selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  if (docs === undefined) return <p className="text-xs text-gray-400">Loading shared documents…</p>;
  if (docs.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        This project has no shared documents yet. Add the specification under Shared Documents,
        then it can be chosen here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
      {docs.map(doc => (
        <label key={doc.id}
          className="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors"
          style={{ background: selected.includes(doc.id) ? '#eff6ff' : '#fff' }}>
          <input type="checkbox" className="mt-0.5" checked={selected.includes(doc.id)}
            onChange={() => toggle(doc.id)} />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-gray-800 truncate">
              {doc.label || doc.file_name}
            </span>
            <span className="block text-[10px] text-gray-400">{doc.doc_type} · {doc.file_name}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function NewSubmittalForm({ onSaved, onCancel }) {
  const { projectId } = useProject();
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Whether the PM has already forwarded this to the A/E. Asked outright rather than left as a
  // bare date field, because a blank date is ambiguous — it could mean "not sent" or "sent, but I
  // didn't fill this in", and the response clock depends on which.
  const [sent, setSent] = useState('no');
  const [sentDate, setSentDate] = useState(today());

  // What the submittal itself cites, and which project documents to read it against.
  const [cited, setCited] = useState([]);
  const [documentIds, setDocumentIds] = useState([]);

  // The predicted review, run before the entry exists. Held here until the submittal is saved,
  // at which point the token hands it to the new log entry.
  const [preview, setPreview] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  // The package is the other half of the comparison, so there is nothing to predict without it.
  const canAnalyse = !!file && documentIds.length > 0;

  const predict = async () => {
    setAnalysing(true); setAnalysisError(''); setPreview(null);
    try {
      const fd = new FormData();
      fd.append('project_id', projectId);
      fd.append('document_ids', JSON.stringify(documentIds));
      ['submittal_number', 'description', 'spec_section', 'submittal_type', 'vendor', 'notes']
        .forEach(k => fd.append(k, form[k] ?? ''));
      fd.append('files', file);
      setPreview(await submittalsApi.previewAnalysis(fd));
    } catch (err) {
      setAnalysisError(errorText(err, 'Could not predict the review. You can still log the submittal and try again from the entry.'));
    } finally { setAnalysing(false); }
  };

  const read = async () => {
    if (!file) return;
    setReading(true); setError(''); setReadNote('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const found = await submittalsApi.extract(fd);
      setForm(f => ({
        ...f,
        submittal_number: found.submittalNumber || f.submittal_number,
        spec_section: found.specSection || f.spec_section,
        description: found.description || f.description,
        vendor: found.vendor || f.vendor,
        submittal_type: found.submittalType || f.submittal_type,
        revision_number: found.revisionNumber ?? f.revision_number,
        date_received: found.dateSubmitted || f.date_received,
        notes: found.notes || f.notes,
      }));
      // What the submittal itself cites is worth showing: it is the strongest hint as to which
      // shared documents to tick, and the PM knows their own set by these names.
      setCited(found.referencedDocuments || []);
      // Only the two fields that must be right are worth mentioning. Anything else the
      // cover sheet didn't show is simply left blank rather than turned into a chore.
      setReadNote(found.submittalNumber && found.description
        ? 'Read from the submittal — check it over and save.'
        : 'Read the submittal, but couldn\'t make out everything. Fill in what\'s missing below.');
    } catch (err) {
      setError(errorText(err, 'Could not read this submittal. Enter it by hand below.'));
    } finally { setReading(false); }
  };

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('project_id', projectId);
      Object.entries(form)
        .filter(([k]) => k !== 'date_forwarded')
        .forEach(([k, v]) => fd.append(k, v ?? ''));
      fd.append('date_forwarded', sent === 'yes' ? sentDate : '');
      if (file) fd.append('file', file);
      if (preview?.token) fd.append('analysis_token', preview.token);
      onSaved(await submittalsApi.create(fd));
    } catch (err) {
      setError(errorText(err, 'Could not save this submittal.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <FileDrop file={file} onChange={f => { setFile(f); setReadNote(''); }} label="The submittal the contractor sent (PDF)" />
        {file && (
          <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm mt-2"
            onClick={read} disabled={reading}>
            <SparklesIcon className="w-4 h-4" />
            {reading ? 'Reading the cover sheet…' : 'Read it and fill in the form'}
          </button>
        )}
        {readNote && <p className="text-[11px] mt-2" style={{ color: '#15803d' }}>{readNote}</p>}
        <p className="text-[11px] text-gray-400 mt-2">
          Optional. You can enter a submittal without attaching anything, and attach the file later.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Submittal Number *">
          <input className="input" required value={form.submittal_number}
            onChange={set('submittal_number')} placeholder="S-001" />
        </Field>
        <Field label="Vendor / Subcontractor">
          <input className="input" value={form.vendor} onChange={set('vendor')}
            placeholder="Who sent it" />
        </Field>
        <Field label="Description *" className="col-span-2">
          <input className="input" required value={form.description} onChange={set('description')}
            placeholder="VAV boxes — product data" />
        </Field>
      </div>

      {/* Asked here rather than left to a date field, because the answer decides whether the
          response clock has started. "Not yet" leaves the date open in the log. */}
      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <label className="label">Has this submittal been sent to the A/E?</label>
        <div className="flex gap-2">
          {[['no', 'Not yet'], ['yes', 'Yes — sent']].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setSent(value)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
              style={sent === value
                ? { background: '#2563eb', color: '#fff' }
                : { background: '#fff', color: '#4b5563', border: '1px solid #e8edf2' }}>
              {label}
            </button>
          ))}
        </div>
        {sent === 'yes' ? (
          <div className="mt-3">
            <Field label="Date sent">
              <input className="input" type="date" value={sentDate} max={today()}
                onChange={e => setSentDate(e.target.value)} />
            </Field>
            <p className="text-[11px] text-gray-400 mt-1">
              The response due date is worked out from this, using the project's review window.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400 mt-2">
            It will sit in the log as "Not yet sent". Fill the sent date in from the log's calendar
            on the day you forward it, and the response clock starts then.
          </p>
        )}
      </div>

      {/* The prediction, before it goes out — which is the only time it is worth having. The
          same step as the RFI log's: choose what it is read against, then read it. */}
      <div className="p-4 rounded-xl space-y-4" style={{ background: '#f5f9ff', border: '1px solid #dbeafe' }}>
        <div>
          <p className="text-[13px] font-bold text-gray-900">What will the A/E say?</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Optional. Reads the package against the specification and predicts the stamp, so a
            missing certificate costs an email now rather than a resubmittal in three weeks.
          </p>
        </div>

        <div>
          <label className="label">Which documents should it be checked against?</label>
          {cited.length > 0 && (
            <p className="text-[11px] mb-1.5" style={{ color: '#1d4ed8' }}>
              The submittal itself cites {cited.join(', ')} — tick whichever document holds those.
            </p>
          )}
          <SubmittalDocumentPicker projectId={projectId} selected={documentIds} onChange={setDocumentIds} />
        </div>

        <div className="pt-1" style={{ borderTop: '1px solid #dbeafe' }}>
          {!preview && (
            <div className="pt-3">
              <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm"
                onClick={predict} disabled={analysing || !canAnalyse}>
                <SparklesIcon className="w-4 h-4" />
                {analysing ? 'Finding the section and reading it…' : 'Find the section and predict the review'}
              </button>
              <p className="text-[11px] text-gray-400 mt-1.5">
                {canAnalyse
                  ? 'Takes a minute or two on a full project manual. It has no bearing on the log.'
                  : 'Attach the contractor\'s package above, and tick at least one document, first.'}
              </p>
            </div>
          )}

          {analysing && (
            <p className="text-[11px] mt-2" style={{ color: '#1d4ed8' }}>
              Searching the manual for the section, then reading the package against it. Leave this open.
            </p>
          )}

          {analysisError && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{analysisError}</p>}

          {preview && (
            <div className="pt-3">
              <PredictionBody analysis={preview.analysis} />
              <div className="flex items-center gap-3 mt-3">
                <button type="button" className="text-[12px] font-semibold text-gray-500 hover:text-gray-700"
                  onClick={predict} disabled={analysing}>Run it again</button>
                <span className="text-[11px] text-gray-400">
                  Saved with the submittal when you add it to the log.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setShowDetails(v => !v)}
          className="text-[12px] font-semibold text-blue-600 hover:text-blue-700">
          {showDetails ? 'Hide details' : 'More details'}
          <span className="font-normal text-gray-400 ml-1.5">
            spec section, type, revision{form.spec_section || form.submittal_type ? ' · filled in from the submittal' : ''}
          </span>
        </button>

        {showDetails && (
          <div className="grid grid-cols-2 gap-4 mt-3">
            <Field label="Spec Section" className="col-span-2">
              <input className="input" value={form.spec_section} onChange={set('spec_section')}
                placeholder="Read from the submittal — leave blank if unknown" />
            </Field>
            <Field label="Type">
              <select className="input" value={form.submittal_type} onChange={set('submittal_type')}>
                <option value="">— Not specified —</option>
                {SUBMITTAL_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Revision">
              <input className="input" type="number" min="0" value={form.revision_number}
                onChange={set('revision_number')} />
            </Field>
            <Field label="Date received from contractor" className="col-span-2">
              <input className="input" type="date" value={form.date_received} onChange={set('date_received')} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </Field>
          </div>
        )}
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Add to log'}
        </button>
      </div>
    </form>
  );
}

// --- Recording what the A/E sent back -----------------------------------------------------

// The step that closes a round trip. The returned PDF is read for its stamp, but the action
// is always confirmed by hand before saving: a misread stamp would either close a submittal
// that is still live or hold a finished one open, and both are worse than typing it.
function ResponseForm({ submittal, revision, onSaved, onCancel }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    review_action: '', reviewed_by: '', date_returned: today(), response_notes: '',
  });
  const [reading, setReading] = useState(false);
  const [stamp, setStamp] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const read = async () => {
    if (!file) return;
    setReading(true); setError(''); setStamp(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const found = await submittalsApi.extractResponse(submittal.id, revision.id, fd);
      setForm(f => ({
        ...f,
        review_action: found.reviewAction || f.review_action,
        reviewed_by: found.reviewedBy || f.reviewed_by,
        date_returned: found.dateReturned || f.date_returned,
        response_notes: found.comments || f.response_notes,
      }));
      setStamp(found);
    } catch (err) {
      setError(errorText(err, 'Could not read the stamp. Enter the response by hand below.'));
    } finally { setReading(false); }
  };

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      if (file) fd.append('file', file);
      onSaved(await submittalsApi.recordResponse(submittal.id, revision.id, fd));
    } catch (err) {
      setError(errorText(err, 'Could not record this response.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm text-gray-500">
        {submittal.submittal_number} Rev {revision.revision_number} — sent to the A/E on{' '}
        {formatDate(revision.date_forwarded)}.
      </p>

      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <FileDrop file={file} onChange={f => { setFile(f); setStamp(null); }} label="What the A/E returned (PDF)" />
        {file && (
          <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm mt-2"
            onClick={read} disabled={reading}>
            <SparklesIcon className="w-4 h-4" />
            {reading ? 'Reading the stamp…' : 'Read the A/E\'s stamp'}
          </button>
        )}
        {stamp && (
          <div className="mt-2 text-[11px]">
            {stamp.stampText
              ? <p className="text-gray-500">Stamp reads: <span className="font-semibold text-gray-700">"{stamp.stampText}"</span></p>
              : <p className="text-gray-400">No stamp wording could be made out.</p>}
            {!stamp.reviewAction && (
              <p className="mt-1" style={{ color: '#c2410c' }}>
                The stamp wasn't clear enough to tell which action it is — choose it below.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="What the A/E returned it as *" className="col-span-2">
          <select className="input" required value={form.review_action} onChange={set('review_action')}>
            <option value="">— Choose —</option>
            {REVIEW_ACTIONS.map(a => <option key={a}>{a}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            "Revise and Resubmit" and "Rejected" keep this submittal open, waiting on the contractor.
            Anything else closes it.
          </p>
        </Field>
        <Field label="Date returned">
          <input className="input" type="date" value={form.date_returned} onChange={set('date_returned')} />
        </Field>
        <Field label="Reviewed by">
          <input className="input" value={form.reviewed_by} onChange={set('reviewed_by')}
            placeholder="A/E firm or reviewer" />
        </Field>
        <Field label="A/E comments" className="col-span-2">
          <textarea className="input" rows={4} value={form.response_notes} onChange={set('response_notes')}
            placeholder="What the contractor has to act on" />
        </Field>
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Record response'}
        </button>
      </div>
    </form>
  );
}

// A resubmittal — the contractor's answer to "Revise and Resubmit". It becomes the next
// revision of the same entry, so the log keeps one line per submittal.
function ResubmittalForm({ submittal, onSaved, onCancel }) {
  const nextRev = (submittal.currentRevision ?? 0) + 1;
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ date_received: today(), date_forwarded: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      if (file) fd.append('file', file);
      onSaved(await submittalsApi.addRevision(submittal.id, fd));
    } catch (err) {
      setError(errorText(err, 'Could not log this resubmittal.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm text-gray-500">
        This becomes <span className="font-semibold text-gray-700">{submittal.submittal_number} Rev {nextRev}</span>.
        Revision {submittal.currentRevision} and its A/E response stay on the record.
      </p>

      <FileDrop file={file} onChange={setFile} label="The resubmitted package (PDF)" />

      <div className="grid grid-cols-2 gap-4">
        <Field label="Date received from contractor">
          <input className="input" type="date" value={form.date_received} onChange={set('date_received')} />
        </Field>
        <Field label="Date sent to A/E">
          <input className="input" type="date" value={form.date_forwarded} onChange={set('date_forwarded')} />
        </Field>
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : `Log Rev ${nextRev}`}
        </button>
      </div>
    </form>
  );
}

// --- One submittal, opened -----------------------------------------------------------------

// --- The predicted review, and how it compared -------------------------------------------------
//
// The same pair of panels as the RFI log, in the same order and worded the same way, because it
// is the same question asked at a different moment: what do the documents require, and did the
// A/E apply them?
//
// The difference is when it pays. An RFI prediction helps the PM understand an answer that is
// already on its way. A submittal prediction runs while the package is still on their desk —
// so a missing certificate costs an email today instead of a resubmittal and three weeks.

const SEVERITY_STYLE = {
  critical: { bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  material: { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  minor: { bg: '#fefce8', color: '#a16207', border: '#fde68a' },
};

const ACTION_STYLE = {
  Approved: { bg: '#f0fdf4', color: '#15803d' },
  'Approved as Noted': { bg: '#fefce8', color: '#a16207' },
  'Revise and Resubmit': { bg: '#fff7ed', color: '#c2410c' },
  Rejected: { bg: '#fef2f2', color: '#b91c1c' },
  'For Record Only': { bg: '#f1f5f9', color: '#475569' },
};

// What a predicted review looks like on screen. One component, used both while the submittal
// is being entered and on the entry afterwards, so the PM reads the same thing in both places.
function PredictionBody({ analysis }) {
  if (!analysis) return null;
  return (
    <div className="space-y-3">
          <p className="text-[14px] font-semibold text-gray-900 leading-snug">{analysis.headline}</p>

          {analysis.deviations?.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Departs from the specification
              </p>
              {analysis.deviations.map((d, i) => {
                const st = SEVERITY_STYLE[d.severity] || SEVERITY_STYLE.minor;
                return (
                  <div key={i} className="p-2.5 rounded-lg" style={{ background: st.bg, border: `1px solid ${st.border}` }}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="text-[12px] font-semibold text-gray-800">{d.item}</p>
                      <span className="text-[10px] font-semibold uppercase tracking-wider ml-auto"
                        style={{ color: st.color }}>{d.severity}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-gray-400">Spec requires</p>
                        <p className="text-[12px] text-gray-700">{d.required}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wider" style={{ color: st.color }}>Submitted</p>
                        <p className="text-[12px] text-gray-700">{d.submitted}</p>
                      </div>
                    </div>
                    {d.whyItMatters && (
                      <p className="text-[11px] text-gray-600 mt-1.5 pt-1.5" style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                        {d.whyItMatters}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {analysis.missingSubmittalItems?.length > 0 && (
            <div className="p-2.5 rounded-lg" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#c2410c' }}>
                Required by the spec, not in this package
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {analysis.missingSubmittalItems.map((m, i) => <li key={i} className="text-[12px] text-gray-700">{m}</li>)}
              </ul>
            </div>
          )}

          {analysis.fixBeforeSending?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Fix before sending</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {analysis.fixBeforeSending.map((f, i) => <li key={i} className="text-[12px] text-gray-700">{f}</li>)}
              </ul>
            </div>
          )}

          {analysis.coordinationNotes && (
            <p className="text-[12px] text-gray-600">{analysis.coordinationNotes}</p>
          )}

          <div className="flex items-center gap-3 flex-wrap pt-1" style={{ borderTop: '1px solid #eef1f4' }}>
            <span className="text-[11px] text-gray-400 pt-2">
              Confidence: {analysis.confidence}{analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}
            </span>
            <button className="text-[11px] text-gray-500 hover:text-gray-900 pt-2 ml-auto" onClick={() => setOpen(true)}>
              Run again
            </button>
          </div>
          {analysis.missingInformation && (
            <p className="text-[11px] text-gray-500">Not read: {analysis.missingInformation}</p>
          )}
    </div>
  );
}

function PredictedReviewPanel({ record, onRan }) {
  const { projectId } = useProject();
  const [docs, setDocs] = useState([]);
  const [chosen, setChosen] = useState(null);      // null until the user or the record decides
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const stored = record.analysis;
  const a = stored?.analysis;

  // The project's Shared Documents — the specification is normally among them, and it is what a
  // submittal is actually judged against.
  useEffect(() => {
    if (!projectId) return;
    payAppReviewApi.listDocuments(projectId)
      .then(all => setDocs(all.filter(d => d.doc_type !== 'memo-cover')))
      .catch(() => setDocs([]));
  }, [projectId]);

  const selected = chosen ?? (record.documents || []).map(d => d.id);
  const toggle = id => setChosen(
    selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  const run = async () => {
    setRunning(true); setError('');
    try {
      const fd = new FormData();
      fd.append('document_ids', selected.join(','));
      const res = await submittalsApi.analyze(record.id, fd);
      onRan(res.submittal);
      setOpen(false);
    } catch (err) {
      setError(errorText(err, 'Could not predict the review.'));
    } finally { setRunning(false); }
  };

  const actionStyle = ACTION_STYLE[a?.likelyAction] || ACTION_STYLE['For Record Only'];

  return (
    <div className="p-4 rounded-xl" style={{ background: '#fff', border: '1px solid #eef1f4' }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <DocumentMagnifyingGlassIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#6366f1' }} />
        <p className="text-[13px] font-bold text-gray-900">What the A/E is likely to say</p>
        {a && (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold ml-auto flex-shrink-0"
            style={{ background: actionStyle.bg, color: actionStyle.color }}>
            {a.likelyAction}
          </span>
        )}
      </div>

      {!a && !open && (
        <div className="space-y-2">
          <p className="text-[12px] text-gray-600">
            Read this submittal against the specification before it goes out — the deviations and
            missing items it finds are the ones that would otherwise come back as a resubmittal.
          </p>
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <SparklesIcon className="w-4 h-4" /> Check it against the spec
          </button>
        </div>
      )}

      {(open || (!a && docs.length === 0)) && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Read it against
          </p>
          {docs.length === 0 && (
            <p className="text-[12px]" style={{ color: '#b45309' }}>
              This project has no shared documents yet. Upload the specification on the project's
              Shared Documents page, then come back.
            </p>
          )}
          {docs.map(d => (
            <label key={d.id} className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={selected.includes(d.id)}
                onChange={() => toggle(d.id)} />
              <span className="text-[12px] text-gray-700">
                {d.label || d.file_name}
                <span className="text-gray-400"> · {d.doc_type}</span>
              </span>
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <button className="btn-primary" onClick={run} disabled={running || !selected.length}>
              <SparklesIcon className="w-4 h-4" />
              {running ? 'Reading the spec…' : a ? 'Run it again' : 'Predict the review'}
            </button>
            <button className="btn-secondary" onClick={() => setOpen(false)} disabled={running}>Cancel</button>
          </div>
          <p className="text-[11px] text-gray-400">
            A project manual is searched for the section first, then only that section is read —
            so this takes a minute or two on a long book.
          </p>
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>}

      {a && !open && <PredictionBody analysis={a} />}

    </div>
  );
}

// Coloured by what the PM has to do about it: green needs nothing, amber is worth reading, red
// is work the specification did not require — which is where the money usually is.
const COMPARISON_VERDICTS = {
  as_expected: {
    label: 'As the spec suggested',
    bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0',
    blurb: 'The A/E reviewed it the way the specification indicated.',
  },
  stricter: {
    label: 'Stricter than the spec',
    bg: '#fef2f2', color: '#b91c1c', border: '#fecaca',
    blurb: 'The A/E has asked for something the specification does not appear to require.',
  },
  more_lenient: {
    label: 'More lenient than the spec',
    bg: '#fefce8', color: '#a16207', border: '#fde68a',
    blurb: 'The A/E accepted a departure from the specification. Approval is not a waiver.',
  },
  different_grounds: {
    label: 'Same outcome, different grounds',
    bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe',
    blurb: 'The A/E landed in the same place, for reasons the prediction did not find.',
  },
  not_comparable: {
    label: 'Not reviewed on the merits',
    bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb',
    blurb: 'The A/E returned it without reviewing it against the specification.',
  },
};

function ReviewComparisonPanel({ record, revision, onRan }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const stored = revision.reviewComparison;
  const review = stored?.review;

  const run = async () => {
    setRunning(true); setError('');
    try {
      onRan(await submittalsApi.compareReview(record.id, revision.id));
    } catch (err) {
      setError(errorText(err, "Could not compare the A/E's review with the prediction."));
    } finally { setRunning(false); }
  };

  const v = COMPARISON_VERDICTS[review?.verdict] || COMPARISON_VERDICTS.not_comparable;

  return (
    <div className="p-4 rounded-xl mt-3" style={{ background: '#fff', border: `1px solid ${review ? v.border : '#eef1f4'}` }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ScaleIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#6366f1' }} />
        <p className="text-[13px] font-bold text-gray-900">The A/E's review vs the spec</p>
        {review && (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold ml-auto flex-shrink-0"
            style={{ background: v.bg, color: v.color }}>{v.label}</span>
        )}
      </div>

      {!review && (
        <div className="space-y-2">
          <p className="text-[12px] text-gray-600">
            {record.analysis
              ? "Compare what the A/E returned with the reading Coaster made of the specification before it went out."
              : 'No predicted review was produced for this submittal, so there is nothing to compare the A/E\'s stamp against. Run one above first.'}
          </p>
          <button className="btn-primary" onClick={run} disabled={running || !record.analysis}>
            <ScaleIcon className="w-4 h-4" />
            {running ? 'Comparing…' : 'Compare with the prediction'}
          </button>
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>}

      {review && (
        <div className="space-y-3">
          <p className="text-[14px] font-semibold text-gray-900 leading-snug">{review.headline}</p>
          <p className="text-[11px] text-gray-500">
            {v.blurb}
            {review.predictedAction && review.actualAction && review.predictedAction !== review.actualAction && (
              <> Predicted <b>{review.predictedAction}</b>, returned as <b>{review.actualAction}</b>.</>
            )}
          </p>

          {review.notInTheContract?.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#b91c1c' }}>
                Asked for, but not in the specification
              </p>
              {review.notInTheContract.map((n, i) => (
                <div key={i} className="p-2.5 rounded-lg" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                  <p className="text-[12px] font-semibold text-gray-800 mb-1.5">{n.point}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400">Spec said</p>
                      <p className="text-[12px] text-gray-700">{n.specificationSaid || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider" style={{ color: '#b91c1c' }}>A/E directed</p>
                      <p className="text-[12px] text-gray-700">{n.aeDirected}</p>
                    </div>
                  </div>
                  {n.whyItMatters && (
                    <p className="text-[11px] text-gray-600 mt-1.5 pt-1.5" style={{ borderTop: '1px solid #fecaca' }}>
                      {n.whyItMatters}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {review.approvedDespite?.length > 0 && (
            <div className="p-2.5 rounded-lg" style={{ background: '#fefce8', border: '1px solid #fde68a' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#a16207' }}>
                Approved despite a departure
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {review.approvedDespite.map((x, i) => <li key={i} className="text-[12px] text-gray-700">{x}</li>)}
              </ul>
              <p className="text-[11px] text-gray-500 mt-1">Approval is not a waiver of the specification.</p>
            </div>
          )}

          {review.missedByPrediction?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                Raised by the A/E, not by the prediction
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {review.missedByPrediction.map((m, i) => (
                  <li key={i} className="text-[12px] text-gray-700">
                    <b>{m.point}</b> — {m.aeComment}
                    {m.inTheSpecification && <span className="text-gray-400"> ({m.inTheSpecification})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {review.confirmed?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                Predicted, and the A/E agreed
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {review.confirmed.map((c, i) => <li key={i} className="text-[12px] text-gray-700">{c}</li>)}
              </ul>
            </div>
          )}

          {review.actionsForPm?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Do now</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {review.actionsForPm.map((x, i) => <li key={i} className="text-[12px] text-gray-700">{x}</li>)}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-3 pt-1" style={{ borderTop: '1px solid #eef1f4' }}>
            <button className="text-[11px] text-gray-500 hover:text-gray-900 pt-2 ml-auto"
              onClick={run} disabled={running}>
              {running ? 'Comparing…' : 'Run again'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RevisionCard({ submittal, revision, isCurrent, onChanged }) {
  const files = revision.files || [];
  return (
    <div className="p-4 rounded-xl" style={{
      background: isCurrent ? '#fbfdff' : '#fafbfc',
      border: `1px solid ${isCurrent ? '#dbeafe' : '#eef1f4'}`,
    }}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-[13px] font-bold text-gray-900">
          Revision {revision.revision_number}
          {isCurrent && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-blue-600">Current</span>}
        </span>
        <StatusBadge status={revision.review_action || (revision.isOverdue ? 'Overdue' : revision.statusLabel)} />
      </div>

      <div className="grid grid-cols-4 gap-3 text-[11px]">
        {[
          ['Received', formatDate(revision.date_received)],
          ['Sent to A/E', formatDate(revision.date_forwarded)],
          ['Response due', formatDate(revision.dueDate)],
          ['Returned', formatDate(revision.date_returned)],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-gray-400">{label}</p>
            <p className="font-semibold text-gray-700">{value}</p>
          </div>
        ))}
      </div>

      {revision.daysWithReviewer != null && (
        <p className="text-[11px] text-gray-500 mt-2">
          {revision.isOpen
            ? `${revision.daysWithReviewer} day${revision.daysWithReviewer === 1 ? '' : 's'} with the A/E so far`
            : `Turned around in ${revision.daysWithReviewer} day${revision.daysWithReviewer === 1 ? '' : 's'}`}
          {revision.isOverdue && (
            <span style={{ color: '#b91c1c' }}> · {revision.daysOverdue} day{revision.daysOverdue === 1 ? '' : 's'} past due</span>
          )}
        </p>
      )}

      {revision.reviewed_by && (
        <p className="text-[11px] text-gray-500 mt-1">Reviewed by {revision.reviewed_by}</p>
      )}
      {revision.response_notes && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid #eef1f4' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">A/E comments</p>
          <p className="text-[12px] text-gray-700 whitespace-pre-wrap leading-relaxed">{revision.response_notes}</p>
        </div>
      )}

      {/* Only where there is a stamp to compare against. A revision still with the A/E has
          nothing to say here, and an empty panel on every open revision would be noise. */}
      {revision.review_action && onChanged && (
        <ReviewComparisonPanel record={submittal} revision={revision} onRan={onChanged} />
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {files.map(f => (
            <a key={f.id} href={submittalsApi.fileUrl(submittal.id, f.id)} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-gray-600 hover:text-gray-900 transition-colors"
              style={{ background: '#fff', border: '1px solid #e8edf2' }}>
              <PaperClipIcon className="w-3.5 h-3.5" />
              <span className="truncate max-w-[180px]">{f.file_name}</span>
              <span className="text-gray-400">{f.kind === 'response' ? '· A/E' : '· submitted'}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmittalDetail({ id, onChanged, onDeleted, onClose }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [sub, setSub] = useState(null); // 'response' | 'resubmittal'
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    submittalsApi.get(id).then(setRecord).catch(err => setError(errorText(err, 'Could not open this submittal.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const applyUpdate = updated => { setRecord(updated); setSub(null); onChanged(); };

  const sendToAe = async () => {
    const current = record.revisions[record.revisions.length - 1];
    setBusy(true);
    try {
      applyUpdate(await submittalsApi.updateRevision(record.id, current.id, { date_forwarded: today() }));
    } catch (err) {
      setError(errorText(err, 'Could not record that it was sent.'));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${record.submittal_number} and its full revision history from the log?`)) return;
    setBusy(true);
    try { await submittalsApi.delete(record.id); onDeleted(); }
    catch (err) { setError(errorText(err, 'Could not remove this submittal.')); setBusy(false); }
  };

  if (error && !record) return <p className="text-sm" style={{ color: '#b91c1c' }}>{error}</p>;
  if (!record) return <p className="text-sm text-gray-400">Loading…</p>;

  const current = record.revisions[record.revisions.length - 1];

  if (sub === 'response') {
    return <ResponseForm submittal={record} revision={current} onSaved={applyUpdate} onCancel={() => setSub(null)} />;
  }
  if (sub === 'resubmittal') {
    return <ResubmittalForm submittal={record} onSaved={applyUpdate} onCancel={() => setSub(null)} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-[13px] font-bold text-gray-900">{record.submittal_number}</span>
          <span className="text-[11px] text-gray-400">Rev {record.currentRevision}</span>
          <StatusBadge status={statusLabelFor(record)} />
        </div>
        <p className="text-[15px] font-semibold text-gray-900">{record.description}</p>
        <p className="text-[12px] text-gray-500 mt-0.5">
          {[record.spec_section, record.vendor, record.submittal_type].filter(Boolean).join(' · ') || 'No spec section or vendor recorded'}
        </p>
      </div>

      {/* What to do next, stated rather than left to be worked out from the dates. */}
      <div className="p-3 rounded-xl text-[12px]" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        {record.status === 'not_sent' && <span className="text-gray-700">Logged, but not yet forwarded to the A/E. The response clock starts when you send it.</span>}
        {record.status === 'with_ae' && !record.isOverdue && <span className="text-gray-700">With the A/E — response due {formatDate(record.dueDate)}.</span>}
        {record.isOverdue && <span style={{ color: '#b91c1c' }}>Overdue — the A/E is {record.daysOverdue} day{record.daysOverdue === 1 ? '' : 's'} past the {formatDate(record.dueDate)} deadline.</span>}
        {record.status === 'awaiting_resubmittal' && <span className="text-gray-700">Returned as "{record.reviewAction}". Waiting on the contractor to resubmit.</span>}
        {record.status === 'closed' && <span className="text-gray-700">Closed — returned as "{record.reviewAction}" on {formatDate(record.dateReturned)}.</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        {record.status === 'not_sent' && (
          <button className="btn-primary" onClick={sendToAe} disabled={busy}>
            <PaperAirplaneIcon className="w-4 h-4" /> Sent to A/E today
          </button>
        )}
        {(record.status === 'with_ae') && (
          <button className="btn-primary" onClick={() => setSub('response')}>
            <ArrowUturnLeftIcon className="w-4 h-4" /> Enter the A/E's response
          </button>
        )}
        {record.status === 'awaiting_resubmittal' && (
          <button className="btn-primary" onClick={() => setSub('resubmittal')}>
            <PlusIcon className="w-4 h-4" /> Log the resubmittal
          </button>
        )}
        <button className="btn-danger" onClick={remove} disabled={busy} title="Remove from log">
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <PredictedReviewPanel record={record} onRan={applyUpdate} />

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
          History — {record.revisionCount} revision{record.revisionCount === 1 ? '' : 's'}
        </p>
        <div className="space-y-3">
          {[...record.revisions].reverse().map(rev => (
            <RevisionCard key={rev.id} submittal={record} revision={rev}
              isCurrent={rev.id === current.id} onChanged={applyUpdate} />
          ))}
        </div>
      </div>

      {record.notes && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Notes</p>
          <p className="text-[12px] text-gray-700 whitespace-pre-wrap">{record.notes}</p>
        </div>
      )}
    </div>
  );
}

// --- The log ---------------------------------------------------------------------------------

export default function SubmittalLog() {
  const { projectId } = useProject();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);        // 'new' | { id }
  const [filters, setFilters] = useState({ status: '', search: '' });

  const load = useCallback(() => {
    if (!projectId) return;
    submittalsApi.list({ project_id: projectId })
      .then(d => { setData(d); setError(''); })
      .catch(err => setError(errorText(err, 'Could not load the submittal log.')));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.submittals || [];
    const term = filters.search.trim().toLowerCase();
    return all.filter(r => {
      if (filters.status === 'open' && !r.isOpen) return false;
      if (filters.status === 'overdue' && !r.isOverdue) return false;
      if (['with_ae', 'awaiting_resubmittal', 'not_sent', 'closed'].includes(filters.status)
        && r.status !== filters.status) return false;
      if (!term) return true;
      return [r.submittal_number, r.description, r.vendor, r.spec_section]
        .some(v => String(v || '').toLowerCase().includes(term));
    });
  }, [data, filters]);

  const s = data?.summary;
  const subtitle = s
    ? `${s.open} outstanding · ${s.overdue > 0 ? `${s.overdue} overdue` : 'none overdue'} · ${s.closed} closed`
    : 'Loading…';

  return (
    <div className="p-8">
      <PageHeader
        title="Submittal Log"
        subtitle={subtitle}
        actions={
          <>
            <button className="btn-secondary" onClick={() => submittalsApi.downloadCsv(projectId)}
              disabled={!rows.length}>
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button className="btn-primary" onClick={() => setModal('new')}>
              <PlusIcon className="w-4 h-4" /> New Submittal
            </button>
          </>
        }
      />

      {s && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryTile icon={ClockIcon} tone="blue" label="With A/E" value={s.withReviewer} />
          <SummaryTile icon={ExclamationTriangleIcon} tone="red" label="Overdue" value={s.overdue} />
          <SummaryTile icon={ArrowUturnLeftIcon} tone="amber" label="Awaiting resubmittal" value={s.awaitingResubmittal} />
          <SummaryTile icon={CheckCircleIcon} tone="green" label="Closed" value={s.closed} />
        </div>
      )}

      <div className="flex items-center gap-3 mb-5">
        <select className="input py-1.5 text-sm w-52" value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
          {STATUS_FILTERS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <input className="input py-1.5 text-sm w-64" placeholder="Search number, description, vendor…"
          value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        {(filters.status || filters.search) && (
          <button className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => setFilters({ status: '', search: '' })}>Clear</button>
        )}
        {data && (
          <span className="text-xs text-gray-400 ml-auto">
            A/E review window: {data.reviewDays} days
          </span>
        )}
      </div>

      {error && (
        <div className="card p-4 mb-5 text-sm" style={{ color: '#b91c1c', background: '#fef2f2', borderColor: '#fecaca' }}>
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <tr>
                <th className="table-th">Submittal #</th>
                <th className="table-th">Rev</th>
                <th className="table-th">Description</th>
                <th className="table-th">Vendor</th>
                <th className="table-th">Spec Section</th>
                <th className="table-th">Status</th>
                <th className="table-th">Ball in Court</th>
                <th className="table-th">Response Due</th>
                <th className="table-th">Last A/E Action</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr><td colSpan={9} className="table-td text-center text-gray-400 py-12">Loading…</td></tr>
              )}
              {data && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="table-td text-center text-gray-400 py-12">
                    {data.submittals.length === 0
                      ? 'No submittals logged yet. Add the first one to start the log.'
                      : 'No submittals match this filter.'}
                  </td>
                </tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className={`table-tr cursor-pointer ${r.isOverdue ? 'bg-red-50 hover:bg-red-100' : ''}`}
                  onClick={() => setModal({ id: r.id })}>
                  <td className="table-td font-mono text-xs font-semibold text-gray-700">{r.submittal_number}</td>
                  <td className="table-td text-center text-sm text-gray-500">{r.currentRevision}</td>
                  <td className="table-td font-medium max-w-xs">
                    <span className="truncate block" title={r.description}>{r.description}</span>
                  </td>
                  <td className="table-td text-gray-500 text-xs">{r.vendor || '—'}</td>
                  <td className="table-td text-gray-500 text-xs">{r.spec_section || '—'}</td>
                  <td className="table-td"><StatusBadge status={statusLabelFor(r)} /></td>
                  <td className="table-td text-xs text-gray-500">{r.ballInCourt || '—'}</td>
                  <td className={`table-td text-xs ${r.isOverdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                    {r.isOpen ? formatDate(r.dueDate) : '—'}
                  </td>
                  <td className="table-td text-xs text-gray-500">{r.reviewAction || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'new' && (
        <Modal title="New Submittal" onClose={() => setModal(null)} size="xl">
          <NewSubmittalForm onSaved={() => { setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.id && (
        <Modal title="Submittal" onClose={() => setModal(null)} size="xl">
          <SubmittalDetail
            id={modal.id}
            onChanged={load}
            onDeleted={() => { setModal(null); load(); }}
            onClose={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
}
