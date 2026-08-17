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

// The local calendar date, not the UTC one.
//
// toISOString() converts to UTC first, so anywhere west of Greenwich it starts returning
// tomorrow's date partway through the evening — at 7pm in Texas it is already tomorrow in UTC.
// A submittal logged after dinner was therefore dated a day ahead, which is visible on the log
// and moves the response deadline it is measured against.
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`
    + `${String(now.getDate()).padStart(2, '0')}`;
};

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
  date_forwarded: '', notes: '',
};

// Reading the PDF is the intended way to fill this in, so the form asks for as little as
// possible: the number and a description, which are what make a log entry mean anything.
// Spec section, type, revision and dates are read off the submittal — they sit behind
// "More details", already filled, for the times something needs correcting. Asking a PM to
// type a CSI section by hand for every submittal is exactly the data entry this replaces.
function NewSubmittalForm({ onSaved, onCancel }) {
  const { projectId } = useProject();
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // 'no' until said otherwise: most submittals are logged as they arrive, before being sent on.
  const [sent, setSent] = useState('no');
  // What it will be checked against. Asked here rather than left to the review, because a
  // submittal with nothing to measure it against cannot be reviewed at all, and discovering
  // that at prediction time means coming back to fix the entry.
  const [docs, setDocs] = useState([]);
  const [documentIds, setDocumentIds] = useState([]);
  const [specFile, setSpecFile] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    payAppReviewApi.listDocuments(projectId)
      .then(all => setDocs(all.filter(d => d.doc_type !== 'memo-cover')))
      .catch(() => setDocs([]));
  }, [projectId]);

  const toggleDoc = id => setDocumentIds(
    documentIds.includes(id) ? documentIds.filter(x => x !== id) : [...documentIds, id]);

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

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
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      fd.append('document_ids', JSON.stringify(documentIds));
      if (specFile) fd.append('spec_file', specFile);
      if (file) fd.append('file', file);
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
        {/* Offered, not demanded. Predicting the review is a feature a PM opts into when it is
            worth the wait, and the log's first job is to record what was sent and when — which
            has to work for someone holding the submittal and nothing else. Asked here anyway,
            because this is the moment the specification is in mind. */}
        <Field label="Check it against a specification?" className="col-span-2">
          <p className="text-[11px] text-gray-500 -mt-1 mb-2">
            Optional. Choose or attach one and Coaster can predict how the A/E will review it —
            it finds the section this submittal cites inside whatever you give it. You can also
            do this later, or not at all.
          </p>
          {docs.length > 0 && (
            <div className="space-y-1 mb-2">
              {docs.map(d => (
                <label key={d.id} className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={documentIds.includes(d.id)}
                    onChange={() => toggleDoc(d.id)} />
                  <span className="text-[12px] text-gray-700">
                    {d.label || d.file_name}
                    <span className="text-gray-400"> · {d.doc_type}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <input type="file" accept=".pdf"
            className="text-xs text-gray-500 w-full file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 file:cursor-pointer"
            onChange={e => setSpecFile(e.target.files?.[0] || null)} />
          <p className="text-[11px] text-gray-400 mt-1">
            {specFile
              ? `${specFile.name} — it will be filed under Shared Documents, so you only upload it once.`
              : docs.length
                ? 'Tick one above, or attach it here if it is not filed yet.'
                : 'Nothing is filed on this project yet — anything you attach here is added to '
                  + 'Shared Documents.'}
          </p>
        </Field>

        {/* Asked as a question rather than offered as a blank date box. A blank box does not say
            whether the submittal is sitting on the PM's desk or sitting with the A/E, and those
            are different states: one has a clock running against it and the other does not. */}
        <Field label="Has it gone to the A/E yet?" className="col-span-2">
          <div className="flex gap-2">
            {[['yes', 'Yes'], ['no', 'Not yet']].map(([value, label]) => (
              <button key={value} type="button"
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
                style={sent === value
                  ? { background: '#1d4ed8', color: '#fff' }
                  : { background: '#fff', color: '#6b7280', border: '1px solid #e8edf2' }}
                onClick={() => {
                  setSent(value);
                  // Choosing "Yes" offers today, which is right almost every time and is one
                  // less thing to type; choosing "Not yet" clears it, because a date left
                  // behind would start the response clock on a submittal nobody has sent.
                  setForm(f => ({ ...f, date_forwarded: value === 'yes' ? (f.date_forwarded || today()) : '' }));
                }}>
                {label}
              </button>
            ))}
          </div>
          {sent === 'yes' ? (
            <div className="mt-2">
              <input className="input" type="date" value={form.date_forwarded}
                onChange={set('date_forwarded')} />
              <p className="text-[11px] text-gray-400 mt-1">
                The response clock starts on this date, using the project's review window.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-gray-400 mt-1">
              Nothing is overdue until it goes out. Record the date from the log when you send it.
            </p>
          )}
        </Field>
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

function PredictedReviewPanel({ record, onRan }) {
  const { projectId } = useProject();
  const [docs, setDocs] = useState([]);
  const [chosen, setChosen] = useState(null);      // null until the user or the record decides
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [specFiles, setSpecFiles] = useState([]);

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

  // There has to be something to measure against, and the panel says so rather than failing
  // once the PM has waited for a review to run.
  const canRun = selected.length > 0 || specFiles.length > 0;

  const run = async () => {
    setRunning(true); setError('');
    try {
      const fd = new FormData();
      // Always sent, because the panel now shows the choice: what is ticked is what is read,
      // including when the PM has deliberately unticked everything and attached a file instead.
      fd.append('document_ids', JSON.stringify(selected));
      for (const f of specFiles) fd.append('spec_files', f);
      const res = await submittalsApi.analyze(record.id, fd);
      onRan(res.submittal);
      setOpen(false);
    } catch (err) {
      setError(errorText(err, 'Could not predict the review.'));
    } finally { setRunning(false); }
  };

  // What the review will read, named before it runs, so the PM is never guessing.
  const willRead = [
    ...docs.filter(d => selected.includes(d.id)).map(d => d.label || d.file_name),
    ...specFiles.map(f => f.name),
  ].join(', ') || null;

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

      {/* What it is read against is shown, not hidden. The choice was folded behind a link on
          the theory that the project already answers it — but the PM is the one accountable for
          the review being measured against the right document, and a choice they cannot see is
          a choice they cannot check. It comes pre-ticked from the entry, so the common case is
          still one button. */}
      {(!a || open) && (
        <div className="space-y-2">
          <p className="text-[12px] text-gray-600">
            Optional. Read this submittal against the specification before it goes out — the
            deviations and missing items it finds are the ones that would otherwise come back as
            a resubmittal.
          </p>

          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 pt-1">
            Read it against
          </p>
          {docs.length === 0 && (
            <p className="text-[12px] text-gray-500">
              Nothing is filed on this project yet — attach the specification below.
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

          <div className="pt-1">
            <label className="label">…or attach it, if it is not filed yet</label>
            <input type="file" multiple accept=".pdf"
              className="text-xs text-gray-500 w-full file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 file:cursor-pointer"
              onChange={e => setSpecFiles(Array.from(e.target.files || []))} />
            <p className="text-[11px] text-gray-400 mt-1">
              {specFiles.length
                ? `${specFiles.length} attached — read for this prediction only, not filed in the project.`
                : 'Used for this prediction only; it is not added to Shared Documents.'}
            </p>
          </div>

          {willRead && (
            <p className="text-[11px] text-gray-500">
              Will look for {record.spec_section
                ? <b>{record.spec_section}</b>
                : 'the section this submittal cites'} in {willRead}.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button className="btn-primary" onClick={run} disabled={running || !canRun}>
              <SparklesIcon className="w-4 h-4" />
              {running ? 'Finding the section…' : a ? 'Run it again' : 'Predict the review'}
            </button>
            {a && (
              <button className="btn-secondary" onClick={() => setOpen(false)} disabled={running}>Cancel</button>
            )}
          </div>
          <p className="text-[11px] text-gray-400">
            {canRun
              ? 'The section is found by its number in the manual\'s own text, so a long book '
                + 'costs no more to read than the one section does.'
              : 'Tick a document or attach one to run this. The submittal is logged either way — '
                + 'a prediction is only worth having when there is a specification to measure '
                + 'against.'}
          </p>
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>}

      {a && !open && (
        <div className="space-y-3">
          <p className="text-[14px] font-semibold text-gray-900 leading-snug">{a.headline}</p>

          {/* Which section it actually landed on. A prediction is only worth reading if it was
              measured against the right requirements, and that is a fact about the run, not a
              judgement — so it is stated rather than left in a sources list further down. */}
          {(stored?.sources || []).some(s => s.sections?.length || s.note) && (
            <div className="text-[11px] text-gray-500 space-y-0.5">
              {(stored.sources || []).map((s, i) => (
                (s.sections?.length || s.note) ? (
                  <p key={i}>
                    {s.sections?.length ? (
                      <>Read against <b className="text-gray-700">
                        {s.sections.map(x => [x.sectionNumber, x.sectionTitle].filter(Boolean).join(' — ')).join('; ')}
                      </b> in {s.label}.</>
                    ) : null}
                    {s.note ? <span className="text-gray-400"> {s.note}</span> : null}
                  </p>
                ) : null
              ))}
            </div>
          )}

          {a.deviations?.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Departs from the specification
              </p>
              {a.deviations.map((d, i) => {
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

          {a.missingSubmittalItems?.length > 0 && (
            <div className="p-2.5 rounded-lg" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#c2410c' }}>
                Required by the spec, not in this package
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {a.missingSubmittalItems.map((m, i) => <li key={i} className="text-[12px] text-gray-700">{m}</li>)}
              </ul>
            </div>
          )}

          {a.fixBeforeSending?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Fix before sending</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {a.fixBeforeSending.map((f, i) => <li key={i} className="text-[12px] text-gray-700">{f}</li>)}
              </ul>
            </div>
          )}

          {a.coordinationNotes && (
            <p className="text-[12px] text-gray-600">{a.coordinationNotes}</p>
          )}

          <div className="flex items-center gap-3 flex-wrap pt-1" style={{ borderTop: '1px solid #eef1f4' }}>
            <span className="text-[11px] text-gray-400 pt-2">
              Confidence: {a.confidence}{a.confidenceReason ? ` — ${a.confidenceReason}` : ''}
            </span>
            <button className="text-[11px] text-gray-500 hover:text-gray-900 pt-2 ml-auto" onClick={() => setOpen(true)}>
              Run again
            </button>
          </div>
          {a.missingInformation && (
            <p className="text-[11px] text-gray-500">Not read: {a.missingInformation}</p>
          )}
        </div>
      )}
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

// What each row of the comparison means, and the colour that says so before it is read. The
// colours are the panel's own scale — green needs nothing, amber is worth reading, red is work
// the specification did not require.
const POINT_STATUS = {
  agreed: { label: 'Both flagged it', bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
  ae_only: { label: 'A/E only', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  beyond_spec: { label: 'Beyond the spec', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  waived: { label: 'Let through', bg: '#fefce8', color: '#a16207', border: '#fde68a' },
};

// The rows to draw, whichever shape the stored comparison is in.
//
// Comparisons produced before this panel became a table were saved as four separate lists, and
// those records are still on real submittals. Rather than leave them rendering as a blank
// panel — or keep both layouts alive — the old lists are folded into the same rows the table
// draws. Each of the four was already a status in all but name.
function rowsOf(review) {
  if (Array.isArray(review.points) && review.points.length) return review.points;

  const rows = [];
  for (const n of review.notInTheContract || []) {
    rows.push({ point: n.point, specSaid: n.specificationSaid, aeSaid: n.aeDirected,
      status: 'beyond_spec', note: n.whyItMatters });
  }
  for (const m of review.missedByPrediction || []) {
    rows.push({ point: m.point, specSaid: m.inTheSpecification, aeSaid: m.aeComment,
      status: 'ae_only', note: null });
  }
  for (const c of review.approvedDespite || []) {
    rows.push({ point: c, specSaid: null, aeSaid: 'Approved anyway', status: 'waived', note: null });
  }
  for (const c of review.confirmed || []) {
    rows.push({ point: c, specSaid: null, aeSaid: 'Raised it too', status: 'agreed', note: null });
  }
  return rows;
}

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
  const rows = review ? rowsOf(review) : [];

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

          {/* One table, ordered as the model ranked it — the rows worth money first. Two
              columns side by side is the whole point: what was required and what was asked for
              are read against each other, which is the comparison the PM came here to make. */}
          {rows.length > 0 && (
            <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #eef1f4' }}>
              <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr] gap-px text-[10px] font-semibold uppercase tracking-wider text-gray-400"
                style={{ background: '#f9fafb', borderBottom: '1px solid #eef1f4' }}>
                <div className="px-2.5 py-1.5">Point</div>
                <div className="px-2.5 py-1.5">The spec said</div>
                <div className="px-2.5 py-1.5">The A/E said</div>
              </div>
              {rows.map((p, i) => {
                const s = POINT_STATUS[p.status] || POINT_STATUS.ae_only;
                return (
                  <div key={i} style={{ borderTop: i ? '1px solid #f3f4f6' : 'none', background: s.bg }}>
                    <div className="sm:grid sm:grid-cols-[1fr_1fr_1fr]">
                      <div className="px-2.5 py-2">
                        <p className="text-[12px] font-semibold text-gray-900 leading-snug">{p.point}</p>
                        <span className="inline-block text-[9px] font-bold uppercase tracking-wider mt-1 px-1.5 py-0.5 rounded"
                          style={{ background: '#fff', color: s.color, border: `1px solid ${s.border}` }}>
                          {s.label}
                        </span>
                      </div>
                      {/* Labelled on a narrow screen, where the columns stack and the header
                          scrolls away — an unlabelled value in a stack is unreadable. */}
                      <div className="px-2.5 pb-2 sm:py-2">
                        <span className="sm:hidden text-[9px] uppercase tracking-wider text-gray-400 block">The spec said</span>
                        <p className="text-[12px] text-gray-700 leading-snug">{p.specSaid || '—'}</p>
                      </div>
                      <div className="px-2.5 pb-2 sm:py-2">
                        <span className="sm:hidden text-[9px] uppercase tracking-wider text-gray-400 block">The A/E said</span>
                        <p className="text-[12px] leading-snug" style={{ color: s.color }}>{p.aeSaid}</p>
                      </div>
                    </div>
                    {/* The one part of a row that is a sentence, kept out of the columns so the
                        table stays scannable. */}
                    {p.note && (
                      <p className="text-[11px] text-gray-600 px-2.5 pb-2 sm:pl-2.5">{p.note}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {rows.some(p => p.status === 'waived') && (
            <p className="text-[11px] text-gray-500">
              Approval is not a waiver of the specification. Worth a record.
            </p>
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
  // Whether this revision has already been read against the prediction. Once it has, the
  // comparison is the answer and everything it is derived from becomes background.
  const compared = !!revision.reviewComparison;
  const [showNotes, setShowNotes] = useState(false);
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
      {/* Once the comparison exists it has already said what the A/E said, point by point and
          beside what the specification required. Leaving their raw comments open above it means
          reading the same review twice in two different shapes, which is the confusion this
          folds away. Still one click from here, because a paraphrase is not a quote and a PM
          arguing a change order needs the words the A/E actually wrote. */}
      {revision.response_notes && (
        compared && !showNotes ? (
          <button type="button" className="text-[11px] font-semibold text-gray-400 hover:text-gray-700 mt-2"
            onClick={() => setShowNotes(true)}>
            Show the A/E's comments as they were written
          </button>
        ) : (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid #eef1f4' }}>
            <div className="flex items-baseline gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">A/E comments</p>
              {compared && (
                <button type="button" className="text-[10px] text-gray-400 hover:text-gray-700 ml-auto"
                  onClick={() => setShowNotes(false)}>Hide</button>
              )}
            </div>
            <p className="text-[12px] text-gray-700 whitespace-pre-wrap leading-relaxed">{revision.response_notes}</p>
          </div>
        )
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
  const [showPrediction, setShowPrediction] = useState(false);

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
  // The comparison, once it exists, is what this page is for.
  const compared = !!current?.reviewComparison;

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

      {/* The prediction earns the top of this page right up until the A/E answers.
          After that it is a forecast of something that has already happened, and the
          comparison below restates every part of it that still matters — beside what the
          A/E actually said, which is the only form in which it is now useful. Two panels
          both headed with a stamp, one predicted and one real, is what made this page
          confusing to read. Kept one click away for anyone checking what was foreseen. */}
      {!compared ? (
        <PredictedReviewPanel record={record} onRan={applyUpdate} />
      ) : showPrediction ? (
        <div>
          <button type="button" className="text-[11px] font-semibold text-gray-400 hover:text-gray-700 mb-1"
            onClick={() => setShowPrediction(false)}>Hide what was predicted</button>
          <PredictedReviewPanel record={record} onRan={applyUpdate} />
        </div>
      ) : (
        <button type="button" className="text-[11px] font-semibold text-gray-400 hover:text-gray-700"
          onClick={() => setShowPrediction(true)}>
          Show what Coaster predicted before it went out
        </button>
      )}

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
