import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SparklesIcon, PaperClipIcon, PaperAirplaneIcon, TrashIcon, PlusIcon,
  XMarkIcon, DocumentIcon, ChatBubbleLeftRightIcon, BoltIcon,
} from '@heroicons/react/24/outline';
import { coasterAiApi, projectsApi, payAppReviewApi } from '../api';
import { WORD_TEMPLATES } from '../wordTemplates';
import PageHeader from '../components/PageHeader';
import { useConfirm } from '../components/ConfirmDialog';

const TIER_STYLE = {
  fast: { label: 'Fast', bg: '#f0fdf4', fg: '#15803d' },
  careful: { label: 'Careful', bg: '#eff6ff', fg: '#1d4ed8' },
  deep: { label: 'Deep', bg: '#faf5ff', fg: '#7e22ce' },
};

const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The model writes markdown. Rendering all of it would mean pulling in a parser; what actually
// shows up in these answers is paragraphs, bullets, and the occasional bold run, so those are
// handled and everything else is left as written rather than shown with its syntax showing.
function Answer({ text }) {
  const blocks = String(text || '').split(/\n{2,}/);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const isList = lines.every(l => /^\s*[-*•]\s+/.test(l)) && lines.length > 0;
        if (isList) {
          return (
            <ul key={i} className="space-y-1 pl-1">
              {lines.map((l, j) => (
                <li key={j} className="flex gap-2 text-[13.5px] text-gray-800 leading-relaxed">
                  <span className="mt-[7px] w-1 h-1 rounded-full flex-shrink-0" style={{ background: '#94a3b8' }} />
                  <span>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</span>
                </li>
              ))}
            </ul>
          );
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(block.trim());
        if (heading) {
          return <p key={i} className="text-[13.5px] font-semibold text-gray-900 pt-1">{inline(heading[1])}</p>;
        }
        return <p key={i} className="text-[13.5px] text-gray-800 leading-relaxed whitespace-pre-wrap">{inline(block)}</p>;
      })}
    </div>
  );
}

function inline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(part)) {
      return <code key={i} className="px-1 py-0.5 rounded text-[12px]" style={{ background: '#f1f5f9' }}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function Bubble({ message, streaming }) {
  const mine = message.role === 'user';
  const tier = TIER_STYLE[message.tier];
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${mine ? '' : 'w-full'}`}>
        {!mine && tier && (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{ background: tier.bg, color: tier.fg }}>{tier.label}</span>
            {message.reason && <span className="text-[11px] text-gray-400">{message.reason}</span>}
          </div>
        )}
        <div className="rounded-2xl px-4 py-3"
          style={mine
            ? { background: 'linear-gradient(135deg, #6366f1, #4f46e5)', color: '#fff' }
            : { background: '#fff', border: '1px solid #e2e8f0' }}>
          {(message.attachments || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {message.attachments.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px]"
                  style={mine ? { background: 'rgba(255,255,255,0.18)' } : { background: '#f1f5f9', color: '#475569' }}>
                  <DocumentIcon className="w-3 h-3" />{f.name}
                </span>
              ))}
            </div>
          )}
          {mine
            ? <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{message.content}</p>
            : <Answer text={message.content} />}
          {streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle animate-pulse" style={{ background: '#6366f1' }} />}
        </div>
      </div>
    </div>
  );
}

export default function CoasterAi() {
  const [chats, setChats] = useState([]);
  const [keepHours, setKeepHours] = useState(24);
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState([]);        // files attached to the message being written
  const [uploading, setUploading] = useState(false);
  const [streaming, setStreaming] = useState(null);  // the answer as it arrives
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deep, setDeep] = useState(false);

  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [projectDocs, setProjectDocs] = useState([]);
  const [documentIds, setDocumentIds] = useState([]);

  const [confirm, confirmDialog] = useConfirm();
  const fileInput = useRef(null);
  const bottom = useRef(null);
  const abort = useRef(null);

  const loadChats = useCallback(() => coasterAiApi.listChats()
    .then(d => { setChats(d.chats || []); setKeepHours(d.keepHours || 24); })
    .catch(() => setChats([])), []);

  useEffect(() => { loadChats(); }, [loadChats]);
  useEffect(() => { projectsApi.list().then(setProjects).catch(() => setProjects([])); }, []);

  useEffect(() => {
    if (!projectId) { setProjectDocs([]); setDocumentIds([]); return; }
    payAppReviewApi.listDocuments(projectId)
      .then(all => setProjectDocs(all.filter(d => !WORD_TEMPLATES.includes(d.doc_type))))
      .catch(() => setProjectDocs([]));
  }, [projectId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  const openChat = async (id) => {
    const chat = await coasterAiApi.getChat(id);
    setChatId(id);
    setMessages(chat.messages || []);
    setProjectId(chat.project_id || '');
    setDocumentIds(chat.document_ids || []);
    setError('');
  };

  const newChat = () => {
    setChatId(null); setMessages([]); setDraft(''); setPending([]);
    setError(''); setProjectId(''); setDocumentIds([]);
  };

  const removeChat = async (id) => {
    if (!(await confirm('Delete this conversation?'))) return;
    await coasterAiApi.deleteChat(id);
    if (chatId === id) newChat();
    loadChats();
  };

  const attach = async (files) => {
    setError(''); setUploading(true);
    try {
      for (const file of files) {
        const stored = await coasterAiApi.upload(file);
        setPending(p => [...p, stored]);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'That file could not be attached.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !pending.length) || busy) return;

    setError(''); setBusy(true);
    const attachments = pending;
    setDraft(''); setPending([]);
    setMessages(m => [...m, { role: 'user', content: text, attachments }]);

    try {
      let id = chatId;
      if (!id) {
        const chat = await coasterAiApi.createChat({
          project_id: projectId || null,
          document_ids: documentIds,
        });
        id = chat.id;
        setChatId(id);
      } else if (projectId || documentIds.length) {
        await coasterAiApi.updateChat(id, { project_id: projectId || null, document_ids: documentIds });
      }

      abort.current = new AbortController();
      let answer = '';
      let meta = {};

      await coasterAiApi.ask(id, { text, attachments, deep, signal: abort.current.signal }, (event, data) => {
        if (event === 'start') { meta = data; setStreaming({ ...data, content: '' }); }
        if (event === 'text') { answer += data.t; setStreaming(s => ({ ...s, content: answer })); }
        if (event === 'error') { setError(data.error); }
      });

      if (answer) {
        setMessages(m => [...m, { role: 'assistant', content: answer, tier: meta.tier, reason: meta.reason }]);
      }
      setStreaming(null);
      setDeep(false);
      loadChats();
    } catch (err) {
      setStreaming(null);
      setError(err.message || 'Coaster could not answer that.');
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="p-8">
      {confirmDialog}
      <PageHeader
        title="Coaster AI"
        subtitle="Ask anything about construction — terms, methods, a document you want a second opinion on"
        icon={SparklesIcon}
        accent="indigo"
      />

      <div className="grid grid-cols-4 gap-6" style={{ height: 'calc(100vh - 210px)' }}>
        {/* Conversations */}
        <div className="col-span-1 flex flex-col min-h-0">
          <button className="btn-primary w-full justify-center mb-3" onClick={newChat}>
            <PlusIcon className="w-4 h-4" /> New chat
          </button>
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {chats.length === 0 ? (
              <p className="text-[12px] text-gray-400 px-1 py-3">No conversations yet.</p>
            ) : chats.map(c => (
              <div key={c.id}
                className="px-3 py-2 rounded-xl cursor-pointer flex items-start justify-between gap-2 group"
                style={{ background: c.id === chatId ? '#eef2ff' : 'transparent' }}
                onClick={() => openChat(c.id)}>
                <div className="min-w-0">
                  <p className="text-[12.5px] text-gray-800 truncate">{c.title || 'New chat'}</p>
                  <p className="text-[10.5px] text-gray-400">{c.message_count} messages</p>
                </div>
                <button className="opacity-0 group-hover:opacity-100 flex-shrink-0"
                  onClick={e => { e.stopPropagation(); removeChat(c.id); }}>
                  <TrashIcon className="w-3.5 h-3.5 text-gray-400" />
                </button>
              </div>
            ))}
          </div>
          {/* Said plainly rather than discovered. Deleting somebody's conversation without warning
              them first is the kind of thing that is only forgivable if it was on screen. */}
          <p className="text-[10.5px] text-gray-400 mt-3 leading-relaxed px-1">
            Conversations are cleared {keepHours} hours after the last message, along with anything
            attached to them. Copy out anything you want to keep.
          </p>
        </div>

        {/* The conversation */}
        <div className="col-span-3 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {messages.length === 0 && !streaming && (
              <div className="card p-6">
                <div className="flex items-center gap-2 mb-3">
                  <ChatBubbleLeftRightIcon className="w-5 h-5" style={{ color: '#6366f1' }} />
                  <p className="text-sm font-semibold text-gray-900">Ask Coaster</p>
                </div>
                <p className="text-[13px] text-gray-600 leading-relaxed mb-3">
                  General construction questions — what a term means, how something is normally
                  done, what to look for in a document. Attach a drawing or a page you want read.
                </p>
                <p className="text-[12px] text-gray-500 leading-relaxed">
                  Coaster will not tell you something meets a code or a fire rating, and will not
                  quote you a price — those need your architect, engineer, or a real quote.
                </p>
              </div>
            )}

            {messages.map((m, i) => <Bubble key={i} message={m} />)}
            {streaming && <Bubble message={{ role: 'assistant', ...streaming }} streaming />}
            <div ref={bottom} />
          </div>

          {error && (
            <div className="p-3 rounded-xl text-sm mt-3"
              style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
              {error}
            </div>
          )}

          {/* Composer */}
          <div className="card p-3 mt-3">
            {(projects.length > 0) && (
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <select className="input py-1 text-[12px]" style={{ width: 'auto' }}
                  value={projectId} onChange={e => { setProjectId(e.target.value); setDocumentIds([]); }}>
                  <option value="">No project</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                </select>
                {projectDocs.map(d => (
                  <label key={d.id} className="flex items-center gap-1 text-[11px] text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={documentIds.includes(d.id)}
                      onChange={() => setDocumentIds(ids => ids.includes(d.id)
                        ? ids.filter(x => x !== d.id) : [...ids, d.id])} />
                    {d.label || d.file_name}
                  </label>
                ))}
              </div>
            )}

            {pending.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {pending.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]"
                    style={{ background: '#f1f5f9', color: '#475569' }}>
                    <DocumentIcon className="w-3 h-3" />{f.name}
                    <span className="text-gray-400">{kb(f.bytes)}</span>
                    <button onClick={() => setPending(p => p.filter((_, j) => j !== i))}>
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <button className="btn-secondary px-2.5 py-2" disabled={uploading || busy}
                onClick={() => fileInput.current?.click()} title="Attach a PDF or an image">
                <PaperClipIcon className="w-4 h-4" />
              </button>
              <input ref={fileInput} type="file" className="hidden" multiple
                accept="application/pdf,image/*"
                onChange={e => attach(Array.from(e.target.files || []))} />

              <textarea
                className="input flex-1 resize-none" rows={2}
                placeholder="Ask a question…"
                value={draft} disabled={busy}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
              />

              <button
                className={deep ? 'btn-primary px-2.5 py-2' : 'btn-secondary px-2.5 py-2'}
                onClick={() => setDeep(d => !d)} disabled={busy}
                title="Use the deepest model for this question — slower and several times dearer">
                <BoltIcon className="w-4 h-4" />
              </button>

              <button className="btn-primary px-3 py-2" onClick={send}
                disabled={busy || uploading || (!draft.trim() && !pending.length)}>
                <PaperAirplaneIcon className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[10.5px] text-gray-400 mt-1.5">
              {deep
                ? 'Deep mode is on for the next question — slower, and several times the cost.'
                : 'Coaster picks the model from the question and anything attached, and tells you which it used.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
