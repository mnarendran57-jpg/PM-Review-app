import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon, ArrowDownTrayIcon, TrashIcon, PaperClipIcon, SparklesIcon,
  PaperAirplaneIcon, ArrowUturnLeftIcon, ClockIcon, CheckCircleIcon,
  ExclamationTriangleIcon, LightBulbIcon, DocumentTextIcon, ScaleIcon,
} from '@heroicons/react/24/outline';
import { rfisApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import FileDrop from '../components/FileDrop';

const RESPONSE_ACTIONS = [
  'Answered', 'Answered with Conditions', 'Needs More Information', 'Void / Withdrawn',
];

// Which trade the question is really about. This is the one answer that has to come from the
// PM: it decides which drawings the suggested answer is read against.
const DISCIPLINES = [
  'Architectural', 'Electrical', 'Mechanical', 'Plumbing', 'Contract', 'Miscellaneous',
];

const STATUS_FILTERS = [
  { key: '', label: 'All RFIs' },
  { key: 'open', label: 'Outstanding' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'with_ae', label: 'With A/E' },
  { key: 'awaiting_clarification', label: 'Awaiting clarification' },
  { key: 'not_sent', label: 'Not yet sent' },
  { key: 'closed', label: 'Closed' },
];

// Mirrors the categories on the Shared Documents page, so a drawing set reads as "Drawings"
// here rather than the catch-all "Reference" it was labelled before.
const DOC_TYPE_LABELS = {
  contract: 'Contract', drawings: 'Drawings', design: 'Design Documents',
  specifications: 'Specifications', scope: 'Scope of Work', proposal: 'Proposals',
  estimate: 'Cost Estimate', schedule: 'Schedule', permit: 'Permits & Approvals',
  other: 'Other', reference: 'Other',
};

const today = () => new Date().toISOString().slice(0, 10);

function formatDate(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).split('-');
  if (!y || !m || !d) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1] || m} ${Number(d)}, ${y}`;
}

const errorText = (err, fallback) =>
  err?.friendlyMessage || err?.response?.data?.error || fallback;

const statusLabelFor = row => (row.isOverdue ? 'Overdue' : row.statusLabel);

const docName = doc => (doc.label || '').trim() || doc.file_name;

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
        <Icon style={{ color: t.color, width: 18, height: 18 }} />
      </div>
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

// The project's Shared Documents, ticked to say which ones this RFI should be read against.
// Contracts and reference documents are shown together and labelled, because an RFI is just
// as often answered by the specification as by a drawing.
function DocumentPicker({ projectId, selected, onChange }) {
  const [docs, setDocs] = useState(undefined);

  useEffect(() => {
    if (!projectId) return;
    payAppReviewApi.listDocuments(projectId).then(setDocs).catch(() => setDocs([]));
  }, [projectId]);

  const toggle = id => onChange(
    selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]
  );

  if (docs === undefined) return <p className="text-xs text-gray-400">Loading shared documents…</p>;
  if (docs.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        This project has no shared documents yet. Add the drawings, specifications or contract under
        Shared Documents, then they can be chosen here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
      {docs.map(doc => (
        <label key={doc.id}
          className="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors"
          style={{ background: selected.includes(doc.id) ? '#eff6ff' : '#fafbfc' }}>
          <input type="checkbox" className="mt-0.5" checked={selected.includes(doc.id)}
            onChange={() => toggle(doc.id)} />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-gray-800 truncate">{docName(doc)}</span>
            <span className="block text-[10px] text-gray-400">
              {DOC_TYPE_LABELS[doc.doc_type] || 'Other'} · {doc.file_name}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

// --- Showing a suggested answer ----------------------------------------------------------------

const CONFIDENCE = {
  high: { label: 'High confidence', bg: '#f0fdf4', color: '#15803d' },
  medium: { label: 'Medium confidence', bg: '#fefce8', color: '#a16207' },
  low: { label: 'Low confidence', bg: '#fef2f2', color: '#b91c1c' },
};

// Which sheets the answer actually turned on. The sheet numbers the model read off the title
// blocks are the truthful ones — the index-derived picks are only what it went looking for —
// so those come first and the picks are the fallback.
function sheetsRead(analysis, sources) {
  const printed = (analysis?.basis || []).map(b => b.sheet).filter(Boolean);
  if (printed.length) return [...new Set(printed)];
  return [...new Set((sources || [])
    .flatMap(s => (s.sheets || []).map(x => x.sheetNumber))
    .filter(Boolean))];
}

// The answer as the PM reads it: the sheets it came from, one sentence, and how much to trust
// it. Everything that justifies those three things is a click away rather than on the page —
// the whole request here was for something concise and minimal.
function AnswerBody({ analysis: a, sources }) {
  const [open, setOpen] = useState(false);
  const conf = CONFIDENCE[a?.confidence] || CONFIDENCE.low;
  const sheets = sheetsRead(a, sources);
  const headline = a?.shortAnswer || a?.likelyAnswer;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {sheets.length > 0 ? sheets.map(s => (
          <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[11px] font-bold"
            style={{ background: '#eff6ff', color: '#1d4ed8' }}>
            <DocumentTextIcon className="w-3 h-3" />{s}
          </span>
        )) : (
          <span className="text-[11px] text-gray-400">No specific sheet could be tied to the question.</span>
        )}
        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold ml-auto flex-shrink-0"
          style={{ background: conf.bg, color: conf.color }}>{conf.label}</span>
      </div>

      <p className="text-[14px] font-semibold text-gray-900 leading-snug">
        {headline || 'No answer could be drawn from the documents provided.'}
      </p>

      {a?.costScheduleFlag && (
        <p className="text-[12px] px-2.5 py-1.5 rounded-lg" style={{ background: '#fefce8', color: '#854d0e' }}>
          <span className="font-semibold">Watch: </span>{a.costScheduleFlag}
        </p>
      )}

      <button type="button" onClick={() => setOpen(v => !v)}
        className="text-[12px] font-semibold text-blue-600 hover:text-blue-700">
        {open ? 'Hide the detail' : 'Why — the reasoning and the sheets it read'}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          {a.likelyAnswer && a.likelyAnswer !== headline && (
            <p className="text-[12px] text-gray-700 leading-relaxed whitespace-pre-wrap">{a.likelyAnswer}</p>
          )}
          {a.confidenceReason && <p className="text-[11px] text-gray-500">{a.confidenceReason}</p>}

          {a.basis?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Based on</p>
              {a.basis.map((b, i) => (
                <p key={i} className="text-[12px] text-gray-700 mb-1">
                  <span className="font-semibold">{b.document}{b.sheet ? ` — ${b.sheet}` : ''}:</span> {b.shows}
                </p>
              ))}
            </div>
          )}

          {a.conflicts?.length > 0 && (
            <div className="p-2.5 rounded-lg" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#c2410c' }}>
                Conflicts between documents
              </p>
              {a.conflicts.map((c, i) => (
                <p key={i} className="text-[12px] text-gray-700"><span className="font-semibold">{c.between}:</span> {c.detail}</p>
              ))}
            </div>
          )}

          {a.missingInformation && (
            <p className="text-[12px] text-gray-600"><span className="font-semibold">Missing:</span> {a.missingInformation}</p>
          )}

          {a.questionsForAE?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Press the A/E on</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {a.questionsForAE.map((q, i) => <li key={i} className="text-[12px] text-gray-700">{q}</li>)}
              </ul>
            </div>
          )}

          {sources?.length > 0 && (
            <p className="text-[11px] text-gray-400">
              Read: {sources.map(s => {
                const what = s.wholeDocument ? 'in full'
                  : s.sheets?.length ? s.sheets.map(x => x.sheetNumber).join(', ')
                  : `first ${s.pagesUsed} pages`;
                return `${s.label} (${what})`;
              }).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Entering an RFI ------------------------------------------------------------------------

const EMPTY = {
  rfi_number: '', subject: '', question: '', discipline: '', submitted_by: '',
  date_received: today(), notes: '',
};

function NewRfiForm({ onSaved, onCancel }) {
  const { projectId } = useProject();
  const [file, setFile] = useState(null);
  const [extras, setExtras] = useState([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [documentIds, setDocumentIds] = useState([]);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const [cited, setCited] = useState([]);
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Whether the PM has already forwarded this to the A/E. Asked outright rather than left as
  // a bare date field, because a blank date is ambiguous — it could mean "not sent" or
  // "sent, but I didn't fill this in", and the response clock depends on which.
  const [sent, setSent] = useState('no');
  const [sentDate, setSentDate] = useState(today());

  // The suggested answer, run before the entry exists. Held here until the RFI is saved, at
  // which point the token hands it to the new log entry.
  const [preview, setPreview] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const canAnalyse = !!form.discipline && (documentIds.length > 0 || !!file || extras.length > 0);

  const suggest = async () => {
    setAnalysing(true); setAnalysisError(''); setPreview(null);
    try {
      const fd = new FormData();
      fd.append('project_id', projectId);
      fd.append('discipline', form.discipline);
      fd.append('rfi_number', form.rfi_number);
      fd.append('subject', form.subject);
      fd.append('question', form.question);
      fd.append('document_ids', JSON.stringify(documentIds));
      // The RFI itself is read alongside the drawings — often the marked-up sketch on it is
      // what the question is really about.
      if (file) fd.append('files', file);
      for (const extra of extras) fd.append('files', extra);
      setPreview(await rfisApi.previewAnalysis(fd));
    } catch (err) {
      setAnalysisError(errorText(err, 'Could not produce a suggested answer. You can still log the RFI and try again from the entry.'));
    } finally { setAnalysing(false); }
  };

  const read = async () => {
    if (!file) return;
    setReading(true); setError(''); setReadNote('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const found = await rfisApi.extract(fd);
      setForm(f => ({
        ...f,
        rfi_number: found.rfiNumber || f.rfi_number,
        subject: found.subject || f.subject,
        question: found.question || f.question,
        discipline: found.discipline || f.discipline,
        submitted_by: found.submittedBy || f.submitted_by,
        date_received: found.dateSubmitted || f.date_received,
        notes: found.notes || f.notes,
      }));
      // What the RFI itself cites is worth showing: it is the strongest hint as to which
      // shared documents to tick, and the PM knows their own drawing set by these names.
      setCited(found.referencedDocuments || []);
      setReadNote(found.rfiNumber && found.subject
        ? 'Read from the RFI — check it over and save.'
        : 'Read the RFI, but couldn\'t make out everything. Fill in what\'s missing below.');
    } catch (err) {
      setError(errorText(err, 'Could not read this RFI. Enter it by hand below.'));
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
      // Blank when it has not gone out yet, which leaves the log's sent date open for the PM
      // to fill in from the calendar there on the day they send it.
      fd.append('date_forwarded', sent === 'yes' ? sentDate : '');
      if (preview?.token) fd.append('analysis_token', preview.token);
      // The RFI itself goes first; the backend treats the rest as supporting material.
      if (file) fd.append('files', file);
      for (const extra of extras) fd.append('files', extra);
      onSaved(await rfisApi.create(fd));
    } catch (err) {
      setError(errorText(err, 'Could not save this RFI.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <FileDrop file={file} onChange={f => { setFile(f); setReadNote(''); }} label="The RFI the contractor sent (PDF)" />
        {file && (
          <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm mt-2"
            onClick={read} disabled={reading}>
            <SparklesIcon className="w-4 h-4" />
            {reading ? 'Reading the RFI…' : 'Read it and fill in the form'}
          </button>
        )}
        {readNote && <p className="text-[11px] mt-2" style={{ color: '#15803d' }}>{readNote}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="RFI Number *">
          <input className="input" required value={form.rfi_number}
            onChange={set('rfi_number')} placeholder="RFI-014" />
        </Field>
        <Field label="Submitted By">
          <input className="input" value={form.submitted_by} onChange={set('submitted_by')}
            placeholder="Who raised it" />
        </Field>
        <Field label="Subject *" className="col-span-2">
          <input className="input" required value={form.subject} onChange={set('subject')}
            placeholder="Duct routing conflict above corridor 1-14" />
        </Field>
      </div>

      {/* The two questions the analysis needs: what the RFI is about, and what to read it
          against. Everything else on this form is optional. */}
      <div className="p-4 rounded-xl space-y-4" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
        <div className="flex items-center gap-2">
          <LightBulbIcon className="w-4 h-4" style={{ color: '#2563eb' }} />
          <p className="text-[12px] font-bold text-gray-900">So Coaster can suggest an answer</p>
        </div>

        {/* Deliberately not a required field. It is needed to suggest an answer, not to log
            an RFI, and marking it required made the browser block the whole form — so an RFI
            the PM only wanted to record could not be saved at all. The suggestion step below
            asks for it in its own right. */}
        <Field label="What does this RFI ask about?">
          <select className="input" value={form.discipline} onChange={set('discipline')}>
            <option value="">— Choose —</option>
            {DISCIPLINES.map(d => <option key={d}>{d}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            This decides which drawings are read. "Contract" is for commercial or scope questions
            that no drawing answers. Leave it blank to just log the RFI for now.
          </p>
        </Field>

        <div>
          <label className="label">Which documents should it be checked against?</label>
          {cited.length > 0 && (
            <p className="text-[11px] mb-1.5" style={{ color: '#1d4ed8' }}>
              The RFI itself cites {cited.join(', ')} — tick whichever document holds those.
            </p>
          )}
          <DocumentPicker projectId={projectId} selected={documentIds} onChange={setDocumentIds} />
        </div>

        <div>
          <label className="label">Anything else to read alongside it</label>
          <input type="file" multiple accept=".pdf" className="text-[11px]"
            onChange={e => setExtras([...e.target.files])} />
          <p className="text-[11px] text-gray-400 mt-1">
            Optional — a marked-up sketch, a photo, a spec page that isn't in the shared documents.
          </p>
        </div>

        <div className="pt-1" style={{ borderTop: '1px solid #dbeafe' }}>
          {!preview && (
            <div className="pt-3">
              <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm"
                onClick={suggest} disabled={analysing || !canAnalyse}>
                <SparklesIcon className="w-4 h-4" />
                {analysing ? 'Finding the sheets and reading them…' : 'Find the sheets and suggest an answer'}
              </button>
              <p className="text-[11px] text-gray-400 mt-1.5">
                {canAnalyse
                  ? 'Optional, and it takes a minute or two on a full drawing set. It has no bearing on the log.'
                  : 'Choose what the RFI asks about, and at least one document, first.'}
              </p>
            </div>
          )}

          {analysing && (
            <p className="text-[11px] mt-2" style={{ color: '#1d4ed8' }}>
              Reading the drawing index, then the sheets it points to. Leave this open.
            </p>
          )}

          {analysisError && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{analysisError}</p>}

          {preview && (
            <div className="pt-3">
              <AnswerBody analysis={preview.analysis} sources={preview.sources} />
              <div className="flex items-center gap-3 mt-3">
                <button type="button" className="text-[12px] font-semibold text-gray-500 hover:text-gray-700"
                  onClick={suggest} disabled={analysing}>Run it again</button>
                <span className="text-[11px] text-gray-400">
                  Saved with the RFI when you add it to the log.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Asked here rather than left to a date field, because the answer decides whether the
          response clock has started. "Not yet" leaves the date open in the log. */}
      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <label className="label">Has this RFI been sent to the A/E?</label>
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
              The response due date is worked out from this, using the project's response window.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400 mt-2">
            It will sit in the log as "Not yet sent". Fill the sent date in from the log's calendar
            on the day you forward it, and the response clock starts then.
          </p>
        )}
      </div>

      <div>
        <button type="button" onClick={() => setShowDetails(v => !v)}
          className="text-[12px] font-semibold text-blue-600 hover:text-blue-700">
          {showDetails ? 'Hide details' : 'More details'}
          <span className="font-normal text-gray-400 ml-1.5">the question text, dates, notes</span>
        </button>

        {showDetails && (
          <div className="grid grid-cols-2 gap-4 mt-3">
            <Field label="The contractor's question" className="col-span-2">
              <textarea className="input" rows={4} value={form.question} onChange={set('question')}
                placeholder="Read from the RFI — this is what the suggested answer is based on" />
            </Field>
            <Field label="Date received from contractor">
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

// --- The predicted answer, on an RFI already in the log -----------------------------------------

function AnalysisPanel({ rfi, onRan }) {
  const { projectId } = useProject();
  const [discipline, setDiscipline] = useState(rfi.discipline || '');
  const [documentIds, setDocumentIds] = useState((rfi.documents || []).map(d => d.id));
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const stored = rfi.analysis;

  const run = async () => {
    setRunning(true); setError('');
    try {
      const fd = new FormData();
      fd.append('discipline', discipline);
      fd.append('document_ids', JSON.stringify(documentIds));
      await rfisApi.analyze(rfi.id, fd);
      setEditing(false);
      onRan();
    } catch (err) {
      setError(errorText(err, 'Could not produce a suggested answer.'));
    } finally { setRunning(false); }
  };

  const a = stored?.analysis;

  return (
    <div className="p-4 rounded-xl" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
      <div className="flex items-center gap-2 mb-2">
        <LightBulbIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#2563eb' }} />
        <p className="text-[13px] font-bold text-gray-900">Suggested answer</p>
      </div>

      <p className="text-[11px] text-gray-500 mb-3">
        Coaster's reading of the project documents, for your understanding before the A/E replies.
        It is not an answer to the RFI and does not affect the log.
      </p>

      {!stored && !editing && (
        <div className="space-y-2">
          <p className="text-[12px] text-gray-600">
            {rfi.documents?.length
              ? `Will be read against ${rfi.documents.map(docName).join(', ')}${rfi.discipline ? ` as a ${rfi.discipline.toLowerCase()} question` : ''}.`
              : 'No documents are selected for this RFI yet.'}
          </p>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={run} disabled={running || !discipline}>
              <SparklesIcon className="w-4 h-4" />
              {running ? 'Reading the drawings…' : 'Suggest an answer'}
            </button>
            <button className="btn-secondary" onClick={() => setEditing(true)}>Change what it reads</button>
          </div>
          {!discipline && (
            <p className="text-[11px]" style={{ color: '#c2410c' }}>
              Choose what the RFI asks about first — it decides which drawings are read.
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="space-y-3">
          <Field label="What does this RFI ask about?">
            <select className="input" value={discipline} onChange={e => setDiscipline(e.target.value)}>
              <option value="">— Choose —</option>
              {DISCIPLINES.map(d => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <div>
            <label className="label">Documents to read it against</label>
            <DocumentPicker projectId={projectId} selected={documentIds} onChange={setDocumentIds} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={run} disabled={running || !discipline}>
              <SparklesIcon className="w-4 h-4" />
              {running ? 'Reading the drawings…' : stored ? 'Run it again' : 'Suggest an answer'}
            </button>
            <button className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>}

      {stored && !editing && (
        <div className="space-y-3">
          <AnswerBody analysis={a} sources={stored.sources} />

          <div className="flex gap-2 pt-1">
            <button className="btn-secondary text-[12px] py-1" onClick={() => setEditing(true)}>
              Change what it reads
            </button>
            <button className="btn-secondary text-[12px] py-1"
              onClick={() => rfisApi.downloadAnalysis(rfi.id, `${rfi.rfi_number}_suggested_answer.md`)}>
              <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Export
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- The A/E's answer against what was predicted --------------------------------------------------

// Coloured by what the PM has to do about it: green needs nothing, amber is a qualification to
// read, red is work the drawings did not show — which is where the money usually is.
const VERDICTS = {
  confirmed: {
    label: 'Matches the documents',
    bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0',
    blurb: 'The A/E answered the way the project documents indicated.',
  },
  partly_confirmed: {
    label: 'Matches, with a qualification',
    bg: '#fefce8', color: '#a16207', border: '#fde68a',
    blurb: 'Broadly what the documents showed, but the A/E has added or qualified something.',
  },
  contradicted: {
    label: 'Differs from the documents',
    bg: '#fef2f2', color: '#b91c1c', border: '#fecaca',
    blurb: 'The A/E has directed something the contract documents do not show.',
  },
  not_comparable: {
    label: 'Not an answer yet',
    bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb',
    blurb: 'The A/E did not answer the question, so there is nothing to compare.',
  },
};

function ResponseReviewPanel({ rfi, revision, onRan }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const stored = rfi.responseReview;
  const review = stored?.review;

  const run = async () => {
    setRunning(true); setError('');
    try {
      onRan(await rfisApi.reviewResponse(rfi.id, revision.id));
    } catch (err) {
      setError(errorText(err, 'Could not compare the response with the suggested answer.'));
    } finally { setRunning(false); }
  };

  const v = VERDICTS[review?.verdict] || VERDICTS.not_comparable;

  return (
    <div className="p-4 rounded-xl" style={{ background: '#fff', border: `1px solid ${review ? v.border : '#eef1f4'}` }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ScaleIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#6366f1' }} />
        <p className="text-[13px] font-bold text-gray-900">The A/E's answer vs the documents</p>
        {review && (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold ml-auto flex-shrink-0"
            style={{ background: v.bg, color: v.color }}>{v.label}</span>
        )}
      </div>

      {!review && (
        <div className="space-y-2">
          <p className="text-[12px] text-gray-600">
            {rfi.analysis
              ? 'Compare what the A/E answered with the reading Coaster made of the drawings before it came back.'
              : 'No suggested answer was produced for this RFI, so there is nothing to compare the A/E\'s reply against. Run one above first.'}
          </p>
          <button className="btn-primary" onClick={run} disabled={running || !rfi.analysis}>
            <ScaleIcon className="w-4 h-4" />
            {running ? 'Comparing…' : 'Compare with the suggested answer'}
          </button>
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>}

      {review && (
        <div className="space-y-3">
          <p className="text-[14px] font-semibold text-gray-900 leading-snug">{review.headline}</p>
          <p className="text-[11px] text-gray-500">{v.blurb}</p>

          {review.differences?.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Where it differs
              </p>
              {review.differences.map((d, i) => (
                <div key={i} className="p-2.5 rounded-lg" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
                  <p className="text-[12px] font-semibold text-gray-800 mb-1.5">{d.point}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400">Documents showed</p>
                      <p className="text-[12px] text-gray-700">{d.predicted}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider" style={{ color: '#b45309' }}>A/E directed</p>
                      <p className="text-[12px] text-gray-700">{d.actual}</p>
                    </div>
                  </div>
                  {d.whyItMatters && (
                    <p className="text-[11px] text-gray-600 mt-1.5 pt-1.5" style={{ borderTop: '1px solid #eef1f4' }}>
                      {d.whyItMatters}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {review.changeOrderRisk && (
            <div className="p-2.5 rounded-lg" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#c2410c' }}>
                Change order or delay exposure
              </p>
              <p className="text-[12px] text-gray-700">{review.changeOrderRisk}</p>
            </div>
          )}

          {review.actionsForPm?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Do now</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {review.actionsForPm.map((a, i) => <li key={i} className="text-[12px] text-gray-700">{a}</li>)}
              </ul>
            </div>
          )}

          {review.newInformation && (
            <p className="text-[12px] text-gray-600">
              <span className="font-semibold">The A/E knew something the documents didn't carry:</span>{' '}
              {review.newInformation}
            </p>
          )}

          {review.agreements?.length > 0 && (
            <p className="text-[11px] text-gray-500">
              Agrees on: {review.agreements.join(' · ')}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button className="btn-secondary text-[12px] py-1" onClick={run} disabled={running}>
              {running ? 'Comparing…' : 'Run it again'}
            </button>
            <button className="btn-secondary text-[12px] py-1"
              onClick={() => rfisApi.downloadResponseReview(rfi.id, `${rfi.rfi_number}_response_review.md`)}>
              <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Export
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Recording the A/E's response ---------------------------------------------------------------

function ResponseForm({ rfi, revision, onSaved, onCancel }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    response_action: '', responded_by: '', date_returned: today(), response_notes: '',
  });
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const readIt = async () => {
    if (!file) return;
    setReading(true); setError(''); setRead(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const found = await rfisApi.extractResponse(rfi.id, revision.id, fd);
      setForm(f => ({
        ...f,
        response_action: found.responseAction || f.response_action,
        responded_by: found.respondedBy || f.responded_by,
        date_returned: found.dateReturned || f.date_returned,
        response_notes: found.answer || f.response_notes,
      }));
      setRead(found);
    } catch (err) {
      setError(errorText(err, 'Could not read the response. Enter it by hand below.'));
    } finally { setReading(false); }
  };

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      if (file) fd.append('file', file);
      onSaved(await rfisApi.recordResponse(rfi.id, revision.id, fd));
    } catch (err) {
      setError(errorText(err, 'Could not record this response.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm text-gray-500">
        {rfi.rfi_number} Rev {revision.revision_number} — sent to the A/E on {formatDate(revision.date_forwarded)}.
      </p>

      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <FileDrop file={file} onChange={f => { setFile(f); setRead(null); }} label="The A/E's response (PDF)" />
        {file && (
          <button type="button" className="btn-secondary w-full justify-center py-1.5 text-sm mt-2"
            onClick={readIt} disabled={reading}>
            <SparklesIcon className="w-4 h-4" />
            {reading ? 'Reading the response…' : 'Read the A/E\'s response'}
          </button>
        )}
        {read && (
          <div className="mt-2 text-[11px]">
            {!read.responseAction && (
              <p style={{ color: '#c2410c' }}>
                The response didn't make the disposition clear — choose it below.
              </p>
            )}
            {read.directsChangeOrder && (
              <p className="font-semibold" style={{ color: '#a16207' }}>
                This response asks the contractor for pricing — expect a change order.
              </p>
            )}
            {read.impactNoted && <p className="text-gray-500">Impact noted: {read.impactNoted}</p>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="How did the A/E answer? *" className="col-span-2">
          <select className="input" required value={form.response_action} onChange={set('response_action')}>
            <option value="">— Choose —</option>
            {RESPONSE_ACTIONS.map(a => <option key={a}>{a}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            "Needs More Information" keeps this RFI open, waiting on the contractor. Anything else closes it.
          </p>
        </Field>
        <Field label="Date returned">
          <input className="input" type="date" value={form.date_returned} onChange={set('date_returned')} />
        </Field>
        <Field label="Responded by">
          <input className="input" value={form.responded_by} onChange={set('responded_by')}
            placeholder="A/E firm or reviewer" />
        </Field>
        <Field label="The A/E's answer" className="col-span-2">
          <textarea className="input" rows={5} value={form.response_notes} onChange={set('response_notes')}
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

function FollowUpForm({ rfi, onSaved, onCancel }) {
  const nextRev = (rfi.currentRevision ?? 0) + 1;
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ date_received: today() });
  const [sent, setSent] = useState('no');
  const [sentDate, setSentDate] = useState(today());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      fd.append('date_forwarded', sent === 'yes' ? sentDate : '');
      if (file) fd.append('files', file);
      onSaved(await rfisApi.addRevision(rfi.id, fd));
    } catch (err) {
      setError(errorText(err, 'Could not log this follow-up.'));
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm text-gray-500">
        This becomes <span className="font-semibold text-gray-700">{rfi.rfi_number} Rev {nextRev}</span>.
        Revision {rfi.currentRevision} and the A/E's reply stay on the record.
      </p>

      <FileDrop file={file} onChange={setFile} label="The contractor's follow-up (PDF)" />

      <Field label="Date received from contractor">
        <input className="input w-52" type="date" value={form.date_received} onChange={set('date_received')} />
      </Field>

      <div className="p-4 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        <label className="label">Has this follow-up been sent to the A/E?</label>
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
              <input className="input w-52" type="date" value={sentDate} max={today()}
                onChange={e => setSentDate(e.target.value)} />
            </Field>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400 mt-2">
            Fill the sent date in from the log's calendar on the day you forward it.
          </p>
        )}
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

// --- One RFI, opened -------------------------------------------------------------------------

function RevisionCard({ rfi, revision, isCurrent }) {
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
        <StatusBadge status={revision.response_action || (revision.isOverdue ? 'Overdue' : revision.statusLabel)} />
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

      {revision.responded_by && <p className="text-[11px] text-gray-500 mt-1">Answered by {revision.responded_by}</p>}

      {revision.response_notes && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid #eef1f4' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">The A/E's answer</p>
          <p className="text-[12px] text-gray-700 whitespace-pre-wrap leading-relaxed">{revision.response_notes}</p>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {files.map(f => (
            <a key={f.id} href={rfisApi.fileUrl(rfi.id, f.id)} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-gray-600 hover:text-gray-900 transition-colors"
              style={{ background: '#fff', border: '1px solid #e8edf2' }}>
              <PaperClipIcon className="w-3.5 h-3.5" />
              <span className="truncate max-w-[180px]">{f.file_name}</span>
              <span className="text-gray-400">
                {f.kind === 'response' ? '· A/E' : f.kind === 'reference' ? '· backup' : '· RFI'}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function RfiDetail({ id, onChanged, onDeleted }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentDate, setSentDate] = useState(today());

  const load = useCallback(() => {
    rfisApi.get(id).then(setRecord).catch(err => setError(errorText(err, 'Could not open this RFI.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const applyUpdate = updated => {
    setRecord(updated);
    setSub(null);
    // The comparison runs after the response is saved and is allowed to fail without taking
    // the response with it. Saying so beats leaving the panel looking as though nothing
    // happened — the PM can press the button and try again.
    setError(updated?.reviewError
      ? `The response was recorded. Comparing it with the suggested answer didn't work: ${updated.reviewError}`
      : '');
    onChanged();
  };

  // The sent date is chosen, not assumed to be today: an RFI is often logged the day it
  // arrives and forwarded a day or two later, and the response deadline counts from the day
  // it actually went out.
  const sendToAe = async () => {
    if (!sentDate) return;
    const current = record.revisions[record.revisions.length - 1];
    setBusy(true);
    try {
      applyUpdate(await rfisApi.updateRevision(record.id, current.id, { date_forwarded: sentDate }));
    } catch (err) {
      setError(errorText(err, 'Could not record that it was sent.'));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${record.rfi_number} and its full history from the log?`)) return;
    setBusy(true);
    try { await rfisApi.delete(record.id); onDeleted(); }
    catch (err) { setError(errorText(err, 'Could not remove this RFI.')); setBusy(false); }
  };

  if (error && !record) return <p className="text-sm" style={{ color: '#b91c1c' }}>{error}</p>;
  if (!record) return <p className="text-sm text-gray-400">Loading…</p>;

  const current = record.revisions[record.revisions.length - 1];

  if (sub === 'response') {
    return <ResponseForm rfi={record} revision={current} onSaved={applyUpdate} onCancel={() => setSub(null)} />;
  }
  if (sub === 'followup') {
    return <FollowUpForm rfi={record} onSaved={applyUpdate} onCancel={() => setSub(null)} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="font-mono text-[13px] font-bold text-gray-900">{record.rfi_number}</span>
          <span className="text-[11px] text-gray-400">Rev {record.currentRevision}</span>
          <StatusBadge status={statusLabelFor(record)} />
          {record.discipline && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#f3f4f6', color: '#4b5563' }}>{record.discipline}</span>
          )}
        </div>
        <p className="text-[15px] font-semibold text-gray-900">{record.subject}</p>
        {record.submitted_by && <p className="text-[12px] text-gray-500 mt-0.5">Raised by {record.submitted_by}</p>}
      </div>

      {record.question && (
        <div className="p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">The question</p>
          <p className="text-[12px] text-gray-700 whitespace-pre-wrap leading-relaxed">{record.question}</p>
        </div>
      )}

      <div className="p-3 rounded-xl text-[12px]" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
        {record.status === 'not_sent' && <span className="text-gray-700">Logged, but not yet forwarded to the A/E. Pick the date you sent it below and the response clock starts from then.</span>}
        {record.status === 'with_ae' && !record.isOverdue && <span className="text-gray-700">With the A/E — response due {formatDate(record.dueDate)}.</span>}
        {record.isOverdue && <span style={{ color: '#b91c1c' }}>Overdue — the A/E is {record.daysOverdue} day{record.daysOverdue === 1 ? '' : 's'} past the {formatDate(record.dueDate)} deadline.</span>}
        {record.status === 'awaiting_clarification' && <span className="text-gray-700">The A/E needs more information. Waiting on the contractor.</span>}
        {record.status === 'closed' && <span className="text-gray-700">Closed — {record.responseAction} on {formatDate(record.dateReturned)}.</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        {record.status === 'not_sent' && (
          <div className="flex items-center gap-2 p-2 rounded-xl"
            style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
            <span className="text-[12px] font-semibold text-gray-600 pl-1">Sent to A/E on</span>
            <input className="input py-1 text-sm w-40" type="date" value={sentDate} max={today()}
              onChange={e => setSentDate(e.target.value)} />
            <button className="btn-primary py-1.5" onClick={sendToAe} disabled={busy || !sentDate}>
              <PaperAirplaneIcon className="w-4 h-4" /> Record
            </button>
          </div>
        )}
        {record.status === 'with_ae' && (
          <button className="btn-primary" onClick={() => setSub('response')}>
            <ArrowUturnLeftIcon className="w-4 h-4" /> Enter the A/E's response
          </button>
        )}
        {record.status === 'awaiting_clarification' && (
          <button className="btn-primary" onClick={() => setSub('followup')}>
            <PlusIcon className="w-4 h-4" /> Log the contractor's follow-up
          </button>
        )}
        <button className="btn-danger" onClick={remove} disabled={busy} title="Remove from log">
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      {/* Once the A/E has answered, the comparison is the more useful of the two — the
          prediction has served its purpose, and what matters now is where the answer departs
          from it. So it sits above. */}
      {current.response_action && (
        <ResponseReviewPanel rfi={record} revision={current} onRan={applyUpdate} />
      )}

      <AnalysisPanel rfi={record} onRan={load} />

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
          History — {record.revisionCount} revision{record.revisionCount === 1 ? '' : 's'}
        </p>
        <div className="space-y-3">
          {[...record.revisions].reverse().map(rev => (
            <RevisionCard key={rev.id} rfi={record} revision={rev} isCurrent={rev.id === current.id} />
          ))}
        </div>
      </div>

      {record.documents?.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
            Checked against
          </p>
          <div className="flex flex-wrap gap-2">
            {record.documents.map(d => (
              <span key={d.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-gray-600"
                style={{ background: '#fff', border: '1px solid #e8edf2' }}>
                <DocumentTextIcon className="w-3.5 h-3.5" /> {docName(d)}
              </span>
            ))}
          </div>
        </div>
      )}

      {record.notes && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Notes</p>
          <p className="text-[12px] text-gray-700 whitespace-pre-wrap">{record.notes}</p>
        </div>
      )}
    </div>
  );
}

// --- The log -----------------------------------------------------------------------------------

export default function RfiLog() {
  const { projectId } = useProject();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [filters, setFilters] = useState({ status: '', discipline: '', search: '' });

  const load = useCallback(() => {
    if (!projectId) return;
    rfisApi.list({ project_id: projectId })
      .then(d => { setData(d); setError(''); })
      .catch(err => setError(errorText(err, 'Could not load the RFI log.')));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  // Filling the sent date in from the log itself, which is where the PM is standing when they
  // forward the RFI. Opening the entry to record one date is a step too many, and a date left
  // unrecorded means the response clock never starts.
  const recordSent = async (row, value) => {
    if (!value || !row.currentRevisionId) return;
    try {
      await rfisApi.updateRevision(row.id, row.currentRevisionId, { date_forwarded: value });
      load();
    } catch (err) {
      setError(errorText(err, `Could not record when ${row.rfi_number} was sent to the A/E.`));
    }
  };

  const rows = useMemo(() => {
    const all = data?.rfis || [];
    const term = filters.search.trim().toLowerCase();
    return all.filter(r => {
      if (filters.status === 'open' && !r.isOpen) return false;
      if (filters.status === 'overdue' && !r.isOverdue) return false;
      if (['with_ae', 'awaiting_clarification', 'not_sent', 'closed'].includes(filters.status)
        && r.status !== filters.status) return false;
      if (filters.discipline && r.discipline !== filters.discipline) return false;
      if (!term) return true;
      return [r.rfi_number, r.subject, r.submitted_by, r.question]
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
        title="RFI Log"
        subtitle={subtitle}
        actions={
          <>
            <button className="btn-secondary" onClick={() => rfisApi.downloadCsv(projectId)}
              disabled={!rows.length}>
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button className="btn-primary" onClick={() => setModal('new')}>
              <PlusIcon className="w-4 h-4" /> New RFI
            </button>
          </>
        }
      />

      {s && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryTile icon={ClockIcon} tone="blue" label="With A/E" value={s.withReviewer} />
          <SummaryTile icon={ExclamationTriangleIcon} tone="red" label="Overdue" value={s.overdue} />
          <SummaryTile icon={ArrowUturnLeftIcon} tone="amber" label="Awaiting clarification" value={s.awaitingClarification} />
          <SummaryTile icon={CheckCircleIcon} tone="green" label="Closed" value={s.closed} />
        </div>
      )}

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <select className="input py-1.5 text-sm w-44" value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
          {STATUS_FILTERS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select className="input py-1.5 text-sm w-40" value={filters.discipline}
          onChange={e => setFilters(f => ({ ...f, discipline: e.target.value }))}>
          <option value="">All disciplines</option>
          {DISCIPLINES.map(d => <option key={d}>{d}</option>)}
        </select>
        <input className="input py-1.5 text-sm w-56" placeholder="Search number, subject, question…"
          value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        {(filters.status || filters.discipline || filters.search) && (
          <button className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => setFilters({ status: '', discipline: '', search: '' })}>Clear</button>
        )}
        {data && (
          <span className="text-xs text-gray-400 ml-auto">A/E response window: {data.reviewDays} days</span>
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
                <th className="table-th">RFI #</th>
                <th className="table-th">Rev</th>
                <th className="table-th">Subject</th>
                <th className="table-th">Discipline</th>
                <th className="table-th">Submitted By</th>
                <th className="table-th">Status</th>
                <th className="table-th">Ball in Court</th>
                <th className="table-th">Sent to A/E</th>
                <th className="table-th">Response Due</th>
                <th className="table-th">A/E Answer</th>
              </tr>
            </thead>
            <tbody>
              {!data && <tr><td colSpan={10} className="table-td text-center text-gray-400 py-12">Loading…</td></tr>}
              {data && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="table-td text-center text-gray-400 py-12">
                    {data.rfis.length === 0
                      ? 'No RFIs logged yet. Add the first one to start the log.'
                      : 'No RFIs match this filter.'}
                  </td>
                </tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className={`table-tr cursor-pointer ${r.isOverdue ? 'bg-red-50 hover:bg-red-100' : ''}`}
                  onClick={() => setModal({ id: r.id })}>
                  <td className="table-td font-mono text-xs font-semibold text-gray-700 whitespace-nowrap">
                    {r.rfi_number}
                    {r.hasAnalysis && <LightBulbIcon className="w-3.5 h-3.5 inline ml-1.5 text-blue-500" title="A suggested answer has been produced" />}
                  </td>
                  <td className="table-td text-center text-sm text-gray-500">{r.currentRevision}</td>
                  <td className="table-td font-medium max-w-xs">
                    <span className="truncate block" title={r.subject}>{r.subject}</span>
                  </td>
                  <td className="table-td text-gray-500 text-xs">{r.discipline || '—'}</td>
                  <td className="table-td text-gray-500 text-xs">{r.submitted_by || '—'}</td>
                  <td className="table-td"><StatusBadge status={statusLabelFor(r)} /></td>
                  <td className="table-td text-xs text-gray-500">{r.ballInCourt || '—'}</td>
                  <td className="table-td text-xs" onClick={e => e.stopPropagation()}>
                    {r.status === 'not_sent' ? (
                      <input type="date" value="" max={today()}
                        className="input py-0.5 px-1.5 text-[11px] w-[130px]"
                        title={`Enter the date ${r.rfi_number} went to the A/E`}
                        onChange={e => recordSent(r, e.target.value)} />
                    ) : (
                      <span className="text-gray-500">{formatDate(r.dateForwarded)}</span>
                    )}
                  </td>
                  <td className={`table-td text-xs ${r.isOverdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                    {r.isOpen ? formatDate(r.dueDate) : '—'}
                  </td>
                  <td className="table-td text-xs text-gray-500">{r.responseAction || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'new' && (
        <Modal title="New RFI" onClose={() => setModal(null)} size="xl">
          <NewRfiForm onSaved={() => { setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.id && (
        <Modal title="RFI" onClose={() => setModal(null)} size="xl">
          <RfiDetail id={modal.id} onChanged={load}
            onDeleted={() => { setModal(null); load(); }} />
        </Modal>
      )}
    </div>
  );
}
