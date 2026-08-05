import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon, ArrowDownTrayIcon, TrashIcon, PaperClipIcon, SparklesIcon,
  PaperAirplaneIcon, ArrowUturnLeftIcon, InboxArrowDownIcon, ClockIcon,
  CheckCircleIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { submittalsApi } from '../api';
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
        <Field label="Date sent to A/E" className="col-span-2">
          <input className="input" type="date" value={form.date_forwarded} onChange={set('date_forwarded')} />
          <p className="text-[11px] text-gray-400 mt-1">
            Leave blank if you haven't forwarded it yet — the response clock starts on this date.
          </p>
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

function RevisionCard({ submittal, revision, isCurrent }) {
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

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
          History — {record.revisionCount} revision{record.revisionCount === 1 ? '' : 's'}
        </p>
        <div className="space-y-3">
          {[...record.revisions].reverse().map(rev => (
            <RevisionCard key={rev.id} submittal={record} revision={rev} isCurrent={rev.id === current.id} />
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
