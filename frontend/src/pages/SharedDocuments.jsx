import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon, TrashIcon, ArrowDownTrayIcon, DocumentTextIcon, CheckBadgeIcon,
  PencilIcon, SparklesIcon, StarIcon,
} from '@heroicons/react/24/outline';
import { projectDocumentsApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import FileDrop from '../components/FileDrop';

// What kind of document this is. Only 'contract' behaves differently — its terms are read on
// upload and it can be the one Pay App and Change Order Review check against. Everything else
// is stored for the team and offered to the tools that read documents on request.
//
// 'reference' predates this list and still exists on older uploads, so it is shown rather than
// hidden; new uploads use 'other' instead.
const CATEGORIES = [
  { key: 'contract', label: 'Contract', hint: 'Executed agreement — terms are read automatically', accent: '#2563eb' },
  { key: 'drawings', label: 'Drawings', hint: 'Plan sets, details, sections', accent: '#0891b2' },
  { key: 'design', label: 'Design Documents', hint: 'Narratives, basis of design, calculations', accent: '#7c3aed' },
  { key: 'specifications', label: 'Specifications', hint: 'Spec sections and divisions', accent: '#c026d3' },
  { key: 'scope', label: 'Scope of Work', hint: 'Scope letters and matrices', accent: '#059669' },
  { key: 'proposal', label: 'Proposals', hint: 'Vendor and subcontractor proposals', accent: '#d97706' },
  { key: 'estimate', label: 'Cost Estimate', hint: 'Estimates and budgets', accent: '#dc2626' },
  { key: 'schedule', label: 'Schedule', hint: 'Baseline and updated programmes', accent: '#0d9488' },
  { key: 'permit', label: 'Permits & Approvals', hint: 'Permits, approvals, authority letters', accent: '#65a30d' },
  { key: 'other', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b' },
  { key: 'reference', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b' },
];

// Only these are offered on upload — 'reference' is legacy and folds into 'other'.
const UPLOAD_CATEGORIES = CATEGORIES.filter(c => c.key !== 'reference');

const categoryFor = key => CATEGORIES.find(c => c.key === key) || CATEGORIES.find(c => c.key === 'other');
const docName = doc => (doc.label || '').trim() || doc.file_name;

const errorText = (err, fallback) =>
  err?.friendlyMessage || err?.response?.data?.error || fallback;

function formatDate(value) {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1] || m} ${Number(d)}, ${y}`;
}

function UploadForm({ projectId, onSaved, onCancel }) {
  const [file, setFile] = useState(null);
  const [docType, setDocType] = useState('contract');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async e => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      fd.append('label', label);
      onSaved(await projectDocumentsApi.add(projectId, fd));
    } catch (err) {
      setError(errorText(err, 'Could not add this document.'));
    } finally { setBusy(false); }
  };

  const chosen = categoryFor(docType);

  return (
    <form onSubmit={save} className="space-y-4">
      <FileDrop file={file} onChange={f => { setFile(f); if (!label && f) setLabel(f.name.replace(/\.pdf$/i, '')); }}
        label="The document (PDF)" />

      <div>
        <label className="label">What is it?</label>
        <div className="grid grid-cols-2 gap-2">
          {UPLOAD_CATEGORIES.map(c => (
            <button key={c.key} type="button" onClick={() => setDocType(c.key)}
              className="text-left px-3 py-2 rounded-xl transition-all"
              style={{
                background: docType === c.key ? '#eff6ff' : '#fafbfc',
                boxShadow: docType === c.key ? `inset 0 0 0 2px ${c.accent}` : 'inset 0 0 0 1px #eef1f4',
              }}>
              <span className="block text-[12px] font-semibold text-gray-900">{c.label}</span>
              <span className="block text-[10px] text-gray-500 leading-tight">{c.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Name it</label>
        <input className="input" value={label} onChange={e => setLabel(e.target.value)}
          placeholder="How this should appear in the list" />
      </div>

      {/* Uploading a contract triggers a model read of the whole agreement, which takes a
          while and is worth saying before the user waits on a spinner. */}
      {docType === 'contract' && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#eff6ff', border: '1px solid #dbeafe', color: '#1e40af' }}>
          <SparklesIcon className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
          Coaster reads the contract on upload — tax status, unallowable costs, retainage and the
          contract sum — so the review tools never have to re-read it. This takes a minute or two.
        </div>
      )}

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy || !file}>
          {busy ? (docType === 'contract' ? 'Reading the contract…' : 'Uploading…') : `Add ${chosen.label}`}
        </button>
      </div>
    </form>
  );
}

function DocumentRow({ doc, projectId, onChanged }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(docName(doc));
  const [busy, setBusy] = useState(false);
  const category = categoryFor(doc.doc_type);
  const terms = doc.terms || null;

  const rename = async e => {
    e.preventDefault();
    setBusy(true);
    try { await projectDocumentsApi.update(projectId, doc.id, { label: draft }); setRenaming(false); onChanged(); }
    finally { setBusy(false); }
  };

  const makePrimary = async () => {
    setBusy(true);
    try { await projectDocumentsApi.update(projectId, doc.id, { is_primary: true }); onChanged(); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${docName(doc)}" from this project?`)) return;
    setBusy(true);
    try { await projectDocumentsApi.remove(projectId, doc.id); onChanged(); }
    catch { setBusy(false); }
  };

  return (
    <div className="p-3.5 rounded-xl flex items-start gap-3"
      style={{ background: '#fff', border: '1px solid #e8edf2' }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${category.accent}14` }}>
        <DocumentTextIcon className="w-4 h-4" style={{ color: category.accent }} />
      </div>

      <div className="min-w-0 flex-1">
        {renaming ? (
          <form className="flex items-center gap-2" onSubmit={rename}>
            <input className="input py-1 text-[12px] flex-1" autoFocus value={draft}
              onChange={e => setDraft(e.target.value)} />
            <button type="submit" className="btn-primary text-[11px] py-1" disabled={busy}>Save</button>
            <button type="button" className="btn-secondary text-[11px] py-1"
              onClick={() => { setDraft(docName(doc)); setRenaming(false); }}>Cancel</button>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-gray-900">{docName(doc)}</span>
              {/* The primary contract is the one Pay App and Change Order Review read, so it
                  is called out rather than left to be inferred from ordering. */}
              {doc.is_primary === 1 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-bold"
                  style={{ background: '#eff6ff', color: '#1d4ed8' }}>
                  <CheckBadgeIcon className="w-3 h-3" /> USED FOR REVIEWS
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5 truncate">
              {doc.file_name}
              {doc.created_at ? ` · added ${formatDate(doc.created_at)}` : ''}
              {doc.terms_edited === 1 ? ' · terms corrected by you' : ''}
            </p>
            {terms && doc.doc_type === 'contract' && (
              <p className="text-[11px] text-gray-500 mt-1">
                {terms.taxExempt === true ? 'Tax exempt' : terms.taxExempt === false ? 'Not tax exempt' : 'Tax status not stated'}
                {` · ${(terms.unallowableItems || []).length} unallowable item${(terms.unallowableItems || []).length === 1 ? '' : 's'} on file`}
              </p>
            )}
          </>
        )}
      </div>

      {!renaming && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {doc.doc_type === 'contract' && doc.is_primary !== 1 && (
            <button className="btn-secondary px-2 py-1" title="Use this contract for reviews"
              onClick={makePrimary} disabled={busy}>
              <StarIcon className="w-4 h-4" />
            </button>
          )}
          <a className="btn-secondary px-2 py-1" title="Download"
            href={projectDocumentsApi.fileUrl(projectId, doc.id)} target="_blank" rel="noreferrer">
            <ArrowDownTrayIcon className="w-4 h-4" />
          </a>
          <button className="btn-secondary px-2 py-1" title="Rename" onClick={() => setRenaming(true)}>
            <PencilIcon className="w-4 h-4" />
          </button>
          <button className="btn-danger px-2 py-1" title="Remove" onClick={remove} disabled={busy}>
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function SharedDocuments() {
  const { projectId, project } = useProject();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return;
    projectDocumentsApi.list(projectId)
      .then(d => { setDocs(d); setError(''); })
      .catch(err => setError(errorText(err, 'Could not load this project\'s documents.')));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  // Grouped in the order the categories are declared, so contracts lead and the rest follow a
  // stable sequence rather than shuffling as documents are added.
  const groups = useMemo(() => {
    if (!docs) return [];
    const byKey = new Map();
    for (const doc of docs) {
      const key = categoryFor(doc.doc_type).key === 'reference' ? 'other' : doc.doc_type;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(doc);
    }
    return UPLOAD_CATEGORIES
      .map(c => ({ ...c, docs: byKey.get(c.key) || [] }))
      .filter(g => g.docs.length > 0);
  }, [docs]);

  const hasPrimaryContract = (docs || []).some(d => d.doc_type === 'contract' && d.is_primary === 1);

  return (
    <div className="p-8">
      <PageHeader
        title="Shared Documents"
        subtitle={docs
          ? `${docs.length} document${docs.length === 1 ? '' : 's'} on ${project?.project_name || 'this project'}`
          : 'Loading…'}
        actions={
          <button className="btn-primary" onClick={() => setUploading(true)}>
            <PlusIcon className="w-4 h-4" /> Add Document
          </button>
        }
      />

      <p className="text-sm text-gray-500 -mt-2 mb-6 max-w-3xl leading-relaxed">
        Everything the project needs on file, uploaded once here and read by every tool — you never
        attach the contract or the drawings to an individual review again.
      </p>

      {error && (
        <div className="card p-4 mb-5 text-sm" style={{ color: '#b91c1c', background: '#fef2f2', borderColor: '#fecaca' }}>
          {error}
        </div>
      )}

      {docs && docs.length > 0 && !hasPrimaryContract && (
        <div className="card p-4 mb-5 text-sm" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
          No contract is marked for reviews yet. Pay App Review and Change Order Review need one —
          add a contract, or mark an existing one with the star.
        </div>
      )}

      {!docs && <p className="text-sm text-gray-400">Loading…</p>}

      {docs && docs.length === 0 && (
        <div className="card p-12 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg, #60a5fa, #2563eb)', boxShadow: '0 8px 24px rgba(37,99,235,0.28)' }}>
            <DocumentTextIcon className="w-7 h-7 text-white" />
          </div>
          <h3 className="text-[16px] font-bold text-gray-900 mb-1.5">Nothing on file yet</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-5 leading-relaxed">
            Start with the executed contract — Coaster reads its terms once, and every review from
            then on checks against it. Then add drawings, specs and anything else the team needs.
          </p>
          <button className="btn-primary mx-auto" onClick={() => setUploading(true)}>
            <PlusIcon className="w-4 h-4" /> Add Document
          </button>
        </div>
      )}

      <div className="space-y-6">
        {groups.map(group => (
          <div key={group.key}>
            <div className="flex items-baseline gap-2 mb-2.5">
              <span className="w-2 h-2 rounded-full" style={{ background: group.accent }} />
              <h2 className="text-[13px] font-bold text-gray-900">{group.label}</h2>
              <span className="text-[11px] text-gray-400">{group.docs.length}</span>
            </div>
            <div className="space-y-2">
              {group.docs.map(doc => (
                <DocumentRow key={doc.id} doc={doc} projectId={projectId} onChanged={load} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {uploading && (
        <Modal title="Add a Document" onClose={() => setUploading(false)} size="lg">
          <UploadForm projectId={projectId}
            onSaved={() => { setUploading(false); load(); }}
            onCancel={() => setUploading(false)} />
        </Modal>
      )}
    </div>
  );
}
