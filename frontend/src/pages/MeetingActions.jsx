import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon, ArrowDownTrayIcon, TrashIcon, SparklesIcon, ClipboardDocumentIcon,
  ExclamationTriangleIcon, ClockIcon, CheckCircleIcon, UserGroupIcon,
  ArrowPathIcon, ChevronDownIcon, ChevronRightIcon, DocumentTextIcon, EnvelopeIcon,
} from '@heroicons/react/24/outline';
import { meetingsApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import FileDrop from '../components/FileDrop';

const PRIORITIES = ['High', 'Medium', 'Low'];
const STATUSES = ['Open', 'In Progress', 'Done', 'Cancelled'];

const today = () => new Date().toISOString().slice(0, 10);

function formatDate(value) {
  if (!value) return null;
  const [y, m, d] = String(value).split('-');
  if (!y || !m || !d) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1] || m} ${Number(d)}`;
}

const errorText = (err, fallback) =>
  err?.friendlyMessage || err?.response?.data?.error || fallback;

// The register's whole job is to make lateness impossible to miss, so urgency drives colour
// everywhere — the stripe on an item, the ring on a person's card, the tiles up top.
const URGENCY = {
  overdue: { label: 'Overdue', bar: '#ef4444', bg: '#fef2f2', text: '#b91c1c', border: '#fecaca' },
  due_soon: { label: 'Due soon', bar: '#f59e0b', bg: '#fffbeb', text: '#b45309', border: '#fde68a' },
  stale: { label: 'Going stale', bar: '#a78bfa', bg: '#faf5ff', text: '#7e22ce', border: '#e9d5ff' },
  open: { label: 'Open', bar: '#94a3b8', bg: '#f8fafc', text: '#475569', border: '#e2e8f0' },
  closed: { label: 'Done', bar: '#d1d5db', bg: '#f9fafb', text: '#6b7280', border: '#e5e7eb' },
};
const tone = key => URGENCY[key] || URGENCY.open;

const initials = name => String(name || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// A stable colour per person, so the same face keeps the same swatch between visits.
const AVATARS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f43f5e', '#6366f1'];
const avatarFor = key => {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[hash % AVATARS.length];
};

function SummaryTile({ icon: Icon, label, value, bg, color, onClick, active }) {
  return (
    <button onClick={onClick}
      className="card p-4 flex items-center gap-3 text-left transition-all"
      style={active ? { boxShadow: `inset 0 0 0 2px ${color}` } : undefined}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
        <Icon style={{ color, width: 18, height: 18 }} />
      </div>
      <div className="min-w-0">
        <p className="text-[19px] font-extrabold leading-none text-gray-900">{value}</p>
        <p className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</p>
      </div>
    </button>
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

// --- One action item --------------------------------------------------------------------------

function ItemRow({ item, onChanged, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const t = tone(item.urgency);

  const patch = async data => {
    setBusy(true);
    try { onChanged(await meetingsApi.updateItem(item.id, data)); }
    finally { setBusy(false); }
  };

  const toggleDone = () => patch({ status: item.isClosed ? 'Open' : 'Done' });

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${t.border}`, background: '#fff' }}>
      <div className="flex items-stretch">
        <div style={{ width: 4, background: t.bar, flexShrink: 0 }} />
        <div className="flex items-start gap-2.5 p-3 flex-1 min-w-0">
          <input type="checkbox" checked={item.isClosed} onChange={toggleDone} disabled={busy}
            className="mt-0.5 flex-shrink-0 cursor-pointer" title={item.isClosed ? 'Reopen' : 'Mark done'} />

          <div className="min-w-0 flex-1">
            <p className={`text-[13px] font-semibold leading-snug ${item.isClosed ? 'line-through text-gray-400' : 'text-gray-900'}`}>
              {item.task}
            </p>

            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {!item.isClosed && item.urgency !== 'open' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                  style={{ background: t.bg, color: t.text }}>
                  {item.isOverdue ? `${item.daysOverdue}d OVERDUE` : t.label.toUpperCase()}
                </span>
              )}
              {item.due_date && (
                <span className="text-[10px] text-gray-500">Due {formatDate(item.due_date)}</span>
              )}
              {item.priority === 'High' && !item.isClosed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                  style={{ background: '#fef2f2', color: '#b91c1c' }}>HIGH</span>
              )}
              {/* Having to ask twice is the clearest sign an item is stuck. */}
              {item.timesChased > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-1"
                  style={{ background: '#fff7ed', color: '#c2410c' }}>
                  <ArrowPathIcon className="w-3 h-3" /> chased {item.timesChased}×
                </span>
              )}
              {item.ageDays != null && !item.isClosed && (
                <span className="text-[10px] text-gray-400">{item.ageDays}d open</span>
              )}
              <button onClick={() => setOpen(v => !v)} className="text-[10px] text-blue-600 font-semibold ml-auto">
                {open ? 'Less' : 'Edit'}
              </button>
            </div>

            {open && (
              <div className="mt-3 pt-3 space-y-2.5" style={{ borderTop: '1px solid #f1f5f9' }}>
                {item.detail && <p className="text-[11px] text-gray-600 leading-relaxed">{item.detail}</p>}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="label text-[10px]">Due</label>
                    <input className="input py-1 text-[11px]" type="date" value={item.due_date || ''}
                      onChange={e => patch({ due_date: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-[10px]">Priority</label>
                    <select className="input py-1 text-[11px]" value={item.priority}
                      onChange={e => patch({ priority: e.target.value })}>
                      {PRIORITIES.map(p => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label text-[10px]">Status</label>
                    <select className="input py-1 text-[11px]" value={item.status}
                      onChange={e => patch({ status: e.target.value })}>
                      {STATUSES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  {/* The name is the assignment. Editing it here moves the item to that
                      person's card, which is the only reassignment that ever needs doing. */}
                  <label className="label text-[10px]">Assigned to</label>
                  <input className="input py-1 text-[11px]" defaultValue={item.assignee_name || ''}
                    placeholder="Name from the minutes"
                    onBlur={e => {
                      const next = e.target.value.trim();
                      if (next !== (item.assignee_name || '')) patch({ assignee_name: next });
                    }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-400">
                    {item.meeting_title ? `Raised in ${item.meeting_title}` : 'Added by hand'}
                    {item.raised_on ? ` · ${formatDate(item.raised_on)}` : ''}
                  </span>
                  <button className="btn-danger px-2 py-1"
                    onClick={async () => {
                      if (!window.confirm('Remove this action item?')) return;
                      await meetingsApi.deleteItem(item.id); onDeleted();
                    }}>
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- One person's card ------------------------------------------------------------------------

function PersonCard({ card, projectName, onChanged }) {
  const [showDone, setShowDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addingEmail, setAddingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const colour = avatarFor(card.key);
  const worst = card.overdueCount > 0 ? URGENCY.overdue
    : card.dueSoonCount > 0 ? URGENCY.due_soon
    : card.openCount > 0 ? URGENCY.open : URGENCY.closed;

  const open = card.items.filter(i => !i.isClosed);
  const done = card.items.filter(i => i.isClosed);

  // Built here from the same items on screen, so what gets pasted into an email is exactly
  // what the PM is looking at.
  const copyDigest = async () => {
    const lines = [`Hi ${String(card.name).split(' ')[0]},`, '',
      `Here's what's currently open against your name${projectName ? ` on ${projectName}` : ''}, from our recent meetings:`, ''];
    for (const i of open) {
      const bits = [];
      if (i.due_date) bits.push(`due ${i.due_date}`);
      if (i.isOverdue) bits.push(`${i.daysOverdue} days overdue`);
      if (i.priority === 'High') bits.push('high priority');
      lines.push(`- ${i.task}${bits.length ? ` (${bits.join(', ')})` : ''}`);
      if (i.detail) lines.push(`  ${i.detail}`);
    }
    lines.push('', 'Let me know if any of these have moved on or should come off the list.');
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card overflow-hidden" style={{ borderTop: `3px solid ${worst.bar}` }}>
      <div className="p-4 pb-3 flex items-start gap-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold text-[13px]"
          style={{ background: colour }}>
          {initials(card.name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-bold text-gray-900 leading-tight truncate">{card.name}</p>
          {/* The name from the minutes is the identity. An email is shown when one has been
              added, and its absence is not a problem to be fixed before the card is useful. */}
          <p className="text-[11px] text-gray-500 truncate">
            {card.email || [card.company, card.role].filter(Boolean).join(' · ') || 'From the minutes'}
          </p>
        </div>
        {card.openCount > 0 && (
          <div className="text-right flex-shrink-0">
            <p className="text-[20px] font-extrabold leading-none" style={{ color: worst.text }}>{card.openCount}</p>
            <p className="text-[10px] text-gray-400">open</p>
          </div>
        )}
      </div>

      {card.overdueCount > 0 && (
        <div className="px-4 pb-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
            style={{ background: URGENCY.overdue.bg, color: URGENCY.overdue.text }}>
            {card.overdueCount} overdue
          </span>
        </div>
      )}

      <div className="px-4 pb-4 space-y-2">
        {open.map(item => (
          <ItemRow key={item.id} item={item} onChanged={onChanged} onDeleted={onChanged} />
        ))}
        {open.length === 0 && (
          <p className="text-[12px] text-gray-400 py-2">Nothing outstanding.</p>
        )}

        {done.length > 0 && (
          <>
            <button onClick={() => setShowDone(v => !v)}
              className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-1 pt-1">
              {showDone ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
              {done.length} done
            </button>
            {showDone && done.map(item => (
              <ItemRow key={item.id} item={item} onChanged={onChanged} onDeleted={onChanged} />
            ))}
          </>
        )}
      </div>

      {open.length > 0 && (
        <div className="px-4 py-2.5" style={{ borderTop: '1px solid #f1f5f9', background: '#fafbfc' }}>
          {addingEmail ? (
            // One field, and only when asked for. Adding an address is a convenience for
            // chasing someone, never a step between the minutes and the register.
            <form className="flex items-center gap-2"
              onSubmit={async e => {
                e.preventDefault();
                await meetingsApi.setPersonEmail({ name: card.name, email: emailDraft });
                setAddingEmail(false); onChanged();
              }}>
              <input className="input py-1 text-[11px] flex-1" type="email" autoFocus required
                value={emailDraft} onChange={e => setEmailDraft(e.target.value)}
                placeholder={`Email for ${String(card.name).split(' ')[0]}`} />
              <button type="submit" className="btn-primary text-[11px] py-1">Save</button>
              <button type="button" className="btn-secondary text-[11px] py-1"
                onClick={() => setAddingEmail(false)}>Cancel</button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <button className="btn-secondary text-[11px] py-1" onClick={copyDigest}>
                <ClipboardDocumentIcon className="w-3.5 h-3.5" />
                {copied ? 'Copied' : 'Copy chase-up'}
              </button>
              {card.email ? (
                <a className="btn-secondary text-[11px] py-1"
                  href={`mailto:${card.email}?subject=${encodeURIComponent(`Open actions${projectName ? ` — ${projectName}` : ''}`)}`}>
                  <EnvelopeIcon className="w-3.5 h-3.5" /> Email
                </a>
              ) : (
                <button className="text-[10px] text-gray-400 hover:text-blue-600"
                  onClick={() => { setEmailDraft(''); setAddingEmail(true); }}>
                  + add email
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Uploading minutes -------------------------------------------------------------------------

function UploadMinutes({ onSaved, onCancel }) {
  const { projectId } = useProject();
  const [tab, setTab] = useState('file');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const read = async () => {
    setReading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('project_id', projectId);
      if (tab === 'file' && file) fd.append('file', file);
      else fd.append('text', text);
      const found = await meetingsApi.extract(fd);
      setDraft(found);
    } catch (err) {
      setError(errorText(err, 'Could not read these minutes.'));
    } finally { setReading(false); }
  };

  const setItem = (index, patch) => setDraft(d => ({
    ...d,
    actionItems: d.actionItems.map((it, i) => (i === index ? { ...it, ...patch } : it)),
  }));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('project_id', projectId);
      // Items the PM unticked are dropped rather than saved as cancelled — a false positive
      // from the model was never a real action item, and recording it as one is noise.
      fd.append('payload', JSON.stringify({
        ...draft,
        actionItems: draft.actionItems.filter(i => i.keep !== false),
      }));
      if (tab === 'file' && file) fd.append('file', file);
      if (tab === 'paste') fd.append('text', text);
      onSaved(await meetingsApi.save(fd));
    } catch (err) {
      setError(errorText(err, 'Could not save these minutes.'));
    } finally { setSaving(false); }
  };

  if (!draft) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          {[['file', 'Upload a file'], ['paste', 'Paste the summary']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`text-[12px] px-3 py-1.5 rounded-lg font-semibold ${tab === k ? 'btn-primary' : 'btn-secondary'}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'file' ? (
          <FileDrop file={file} onChange={setFile} label="The meeting minutes"
            accept=".pdf,.txt,.md" hint="PDF, TXT or Markdown — a Fathom summary export works as-is" />
        ) : (
          <div>
            <label className="label">Paste the Fathom summary</label>
            <textarea className="input font-mono text-[11px]" rows={12} value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Paste the summary and action items straight out of Fathom…" />
          </div>
        )}

        {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={read}
            disabled={reading || (tab === 'file' ? !file : text.trim().length < 40)}>
            <SparklesIcon className="w-4 h-4" />
            {reading ? 'Reading the minutes…' : 'Read the minutes'}
          </button>
        </div>
      </div>
    );
  }

  const kept = draft.actionItems.filter(i => i.keep !== false);
  const followUps = kept.filter(i => i.followUpOfId).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Meeting">
          <input className="input" value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={draft.meetingDate || today()}
            onChange={e => setDraft(d => ({ ...d, meetingDate: e.target.value }))} />
        </Field>
      </div>

      {draft.summary && (
        <div className="p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Summary</p>
          <p className="text-[12px] text-gray-700 leading-relaxed">{draft.summary}</p>
          {draft.attendees?.length > 0 && (
            <p className="text-[11px] text-gray-500 mt-2">Present: {draft.attendees.join(', ')}</p>
          )}
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-[12px] font-bold text-gray-900">
            {kept.length} action item{kept.length === 1 ? '' : 's'}
          </p>
          <p className="text-[11px] text-gray-400">
            {followUps > 0 && `${followUps} already on the register · `}Untick anything that isn't a real action
          </p>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {draft.actionItems.map((item, i) => (
            <div key={i} className="p-3 rounded-xl flex items-start gap-2.5"
              style={{
                background: item.keep === false ? '#f9fafb' : '#fff',
                border: `1px solid ${item.followUpOfId ? '#fed7aa' : '#e8edf2'}`,
                opacity: item.keep === false ? 0.5 : 1,
              }}>
              <input type="checkbox" className="mt-1 flex-shrink-0" checked={item.keep !== false}
                onChange={e => setItem(i, { keep: e.target.checked })} />
              <div className="min-w-0 flex-1 space-y-2">
                <input className="input py-1 text-[12px] font-semibold" value={item.task}
                  onChange={e => setItem(i, { task: e.target.value })} />
                {item.detail && <p className="text-[11px] text-gray-500 leading-relaxed">{item.detail}</p>}

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    {/* Read straight off the minutes and editable as text. Names already on
                        the register are reused automatically, so this is only for fixing a
                        misread — not a step to work through. */}
                    <label className="label text-[10px]">Who</label>
                    <input className="input py-1 text-[11px]" value={item.assigneeName || ''}
                      placeholder="Nobody named"
                      onChange={e => setItem(i, { assigneeName: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-[10px]">Due</label>
                    <input className="input py-1 text-[11px]" type="date" value={item.dueDate || ''}
                      onChange={e => setItem(i, { dueDate: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-[10px]">Priority</label>
                    <select className="input py-1 text-[11px]" value={item.priority}
                      onChange={e => setItem(i, { priority: e.target.value })}>
                      {PRIORITIES.map(p => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                </div>

                {item.followUpOfId && (
                  <p className="text-[10px] font-semibold" style={{ color: '#c2410c' }}>
                    Already on the register — this will be recorded as chasing it again{item.isNowComplete ? ', and closed' : ''}, not added twice.
                  </p>
                )}
                {item.isNowComplete && !item.followUpOfId && (
                  <p className="text-[10px] font-semibold" style={{ color: '#15803d' }}>
                    The minutes say this is done — it will be logged as complete.
                  </p>
                )}
              </div>
            </div>
          ))}
          {draft.actionItems.length === 0 && (
            <p className="text-[12px] text-gray-400 py-4 text-center">
              No action items were found in these minutes.
            </p>
          )}
        </div>
      </div>

      {draft.decisions?.length > 0 && (
        <div className="p-3 rounded-xl" style={{ background: '#f6faf7', border: '1px solid #dcf0e2' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#15803d' }}>
            Decisions (recorded, not assigned to anyone)
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {draft.decisions.map((d, i) => <li key={i} className="text-[12px] text-gray-700">{d}</li>)}
          </ul>
        </div>
      )}

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => setDraft(null)}>Back</button>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : `Add ${kept.length} to the register`}
        </button>
      </div>
    </div>
  );
}

// --- The register -------------------------------------------------------------------------------

export default function MeetingActions() {
  const { projectId, project } = useProject();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // An object with an explicit `type`, never a bare string. It was previously either the
  // string 'upload' or { match: card }, and `'upload'?.match` resolves to
  // String.prototype.match — a truthy function — so opening the upload dialog silently
  // rendered a different one on top of it.
  const [modal, setModal] = useState(null);   // null | {type:'upload'}
  const [view, setView] = useState('people');
  const [filter, setFilter] = useState('');       // '' | 'overdue' | 'due_soon' | 'unassigned'
  const [meetingId, setMeetingId] = useState('');

  const load = useCallback(() => {
    if (!projectId) return;
    meetingsApi.register({ project_id: projectId, meeting_id: meetingId || undefined })
      .then(d => { setData(d); setError(''); })
      .catch(err => setError(errorText(err, 'Could not load the action register.')));
  }, [projectId, meetingId]);
  useEffect(() => { load(); }, [load]);

  const people = useMemo(() => {
    const cards = data?.people || [];
    if (!filter) return cards;
    return cards
      .map(card => ({
        ...card,
        items: card.items.filter(i => {
          if (filter === 'overdue') return i.isOverdue;
          if (filter === 'due_soon') return i.urgency === 'due_soon';
          if (filter === 'unassigned') return !String(i.assignee_name || '').trim() && !i.isClosed;
          return true;
        }),
      }))
      .filter(card => card.items.length > 0);
  }, [data, filter]);

  const s = data?.summary;

  return (
    <div className="p-8">
      <PageHeader
        title="Meeting Actions"
        subtitle={s
          ? `${s.open} open across ${s.people} ${s.people === 1 ? 'person' : 'people'} · ${s.overdue > 0 ? `${s.overdue} overdue` : 'none overdue'}`
          : 'Loading…'}
        actions={
          <>
            <button className="btn-secondary" onClick={() => meetingsApi.downloadCsv(projectId)}
              disabled={!s?.total}>
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button className="btn-primary" onClick={() => setModal({ type: 'upload' })}>
              <PlusIcon className="w-4 h-4" /> Upload Minutes
            </button>
          </>
        }
      />

      {s && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryTile icon={ExclamationTriangleIcon} bg="#fef2f2" color="#b91c1c"
            label="Overdue" value={s.overdue} active={filter === 'overdue'}
            onClick={() => setFilter(f => (f === 'overdue' ? '' : 'overdue'))} />
          <SummaryTile icon={ClockIcon} bg="#fffbeb" color="#b45309"
            label="Due in 3 days" value={s.dueSoon} active={filter === 'due_soon'}
            onClick={() => setFilter(f => (f === 'due_soon' ? '' : 'due_soon'))} />
          <SummaryTile icon={UserGroupIcon} bg="#eff6ff" color="#1d4ed8"
            label="Open in total" value={s.open} active={!filter}
            onClick={() => setFilter('')} />
          <SummaryTile icon={CheckCircleIcon} bg="#f0fdf4" color="#15803d"
            label="Done" value={s.done} active={false} onClick={() => setFilter('')} />
        </div>
      )}

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: '#f1f5f9' }}>
          {[['people', 'By person'], ['meetings', 'Meetings']].map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className="text-[12px] px-3 py-1 rounded-lg font-semibold transition-all"
              style={view === k ? { background: '#fff', color: '#0f172a', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' } : { color: '#64748b' }}>
              {label}
            </button>
          ))}
        </div>

        {data?.meetings?.length > 0 && view === 'people' && (
          <select className="input py-1.5 text-sm w-56" value={meetingId}
            onChange={e => setMeetingId(e.target.value)}>
            <option value="">Every meeting</option>
            {data.meetings.map(m => (
              <option key={m.id} value={m.id}>{m.title}{m.meeting_date ? ` — ${formatDate(m.meeting_date)}` : ''}</option>
            ))}
          </select>
        )}

        {(filter || meetingId) && (
          <button className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => { setFilter(''); setMeetingId(''); }}>Clear</button>
        )}

        {/* Now means the minutes named nobody at all — a real gap worth chasing, rather than
            the old "has no contact record", which flagged almost everyone and said nothing. */}
        {s?.unassigned > 0 && (
          <button onClick={() => setFilter(f => (f === 'unassigned' ? '' : 'unassigned'))}
            className="text-[11px] px-2.5 py-1 rounded-full font-semibold ml-auto"
            style={{ background: '#fff7ed', color: '#c2410c' }}>
            {s.unassigned} with nobody named
          </button>
        )}
      </div>

      {error && (
        <div className="card p-4 mb-5 text-sm" style={{ color: '#b91c1c', background: '#fef2f2', borderColor: '#fecaca' }}>
          {error}
        </div>
      )}

      {view === 'people' && (
        <>
          {!data && <p className="text-sm text-gray-400">Loading…</p>}
          {data && people.length === 0 && (
            // An empty register that only describes uploading, with the button stranded in
            // the top corner, reads as though there is nothing to do here. On the one screen
            // where upload is the only sensible action, it belongs in the middle of it.
            <div className="card p-12 text-center">
              {s?.total === 0 ? (
                <>
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
                    style={{ background: 'linear-gradient(135deg, #4ade80, #16a34a)', boxShadow: '0 8px 24px rgba(34,197,94,0.28)' }}>
                    <DocumentTextIcon className="w-7 h-7 text-white" />
                  </div>
                  <h3 className="text-[16px] font-bold text-gray-900 mb-1.5">Start with a set of minutes</h3>
                  <p className="text-sm text-gray-500 max-w-md mx-auto mb-5 leading-relaxed">
                    Upload your Fathom export — or paste the summary straight in — and Coaster pulls
                    out who agreed to do what, then groups it by person.
                  </p>
                  <button className="btn-primary mx-auto" onClick={() => setModal({ type: 'upload' })}>
                    <PlusIcon className="w-4 h-4" /> Upload Minutes
                  </button>
                </>
              ) : (
                <>
                  <DocumentTextIcon className="w-10 h-10 mx-auto text-gray-300 mb-3" />
                  <p className="text-sm text-gray-500">Nothing matches this filter.</p>
                </>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-5 items-start">
            {people.map(card => (
              <PersonCard key={card.key} card={card}
                projectName={project?.project_name} onChanged={load} />
            ))}
          </div>
        </>
      )}

      {view === 'meetings' && (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <tr>
                <th className="table-th">Meeting</th>
                <th className="table-th">Date</th>
                <th className="table-th">Actions raised</th>
                <th className="table-th">Logged by</th>
              </tr>
            </thead>
            <tbody>
              {(data?.meetings || []).length === 0 && (
                <tr><td colSpan={4} className="table-td text-center text-gray-400 py-12">No meetings uploaded yet.</td></tr>
              )}
              {(data?.meetings || []).map(m => (
                <tr key={m.id} className="table-tr cursor-pointer"
                  onClick={() => { setView('people'); setMeetingId(String(m.id)); }}>
                  <td className="table-td font-medium">{m.title}</td>
                  <td className="table-td text-xs text-gray-500">{formatDate(m.meeting_date) || '—'}</td>
                  <td className="table-td text-xs text-gray-500">{m.action_count ?? 0}</td>
                  <td className="table-td text-xs text-gray-500">{m.created_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.type === 'upload' && (
        <Modal title="Upload Meeting Minutes" onClose={() => setModal(null)} size="xl">
          <UploadMinutes onSaved={() => { setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}
