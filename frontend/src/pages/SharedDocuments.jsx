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

// What kind of document this is. A governing document — a contract, or the purchase order that
// stands in its place — is read on upload for its terms, and is what Pay App, Invoice and Change
// Order Review check billing against; only those can be marked primary. Everything else is stored
// for the team and read by whichever review needs it, when it needs it.
//
// 'reference' predates this list and still exists on older uploads, so it is shown rather than
// hidden; new uploads use 'other' instead.
const CATEGORIES = [
  { key: 'contract', label: 'Contract', hint: 'Executed agreement — terms are read automatically', accent: '#2563eb' },
  // Not every job has a contract. Below a client's threshold the vendor proposes, the design
  // team and PM accept, and a purchase order is issued — the PO is what the work runs under, so
  // it is read exactly as a contract is and stands in the same place on every review.
  { key: 'purchase-order', label: 'Purchase Order', hint: 'For jobs run on a PO instead of a contract — read the same way', accent: '#1d4ed8' },
  { key: 'drawings', label: 'Drawings', hint: 'Plan sets, details, sections', accent: '#0891b2' },
  { key: 'design', label: 'Design Documents', hint: 'Narratives, basis of design, calculations', accent: '#7c3aed' },
  { key: 'specifications', label: 'Specifications', hint: 'Spec sections and divisions', accent: '#c026d3' },
  { key: 'scope', label: 'Scope of Work', hint: 'Scope letters and matrices', accent: '#059669' },
  { key: 'proposal', label: 'Proposals', hint: 'Vendor and subcontractor proposals', accent: '#d97706' },
  { key: 'estimate', label: 'Cost Estimate', hint: 'Estimates and budgets', accent: '#dc2626' },
  { key: 'schedule', label: 'Schedule', hint: 'Baseline and updated programmes', accent: '#0d9488' },
  { key: 'permit', label: 'Permits & Approvals', hint: 'Permits, approvals, authority letters', accent: '#65a30d' },
  { key: 'memo-cover', label: 'Memo Cover', hint: 'Your Word memo letter — Proposal Intake fills it in', accent: '#e11d48', docx: true },
  { key: 'other', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b' },
  { key: 'reference', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b' },
];

// A governing document is one a party's billing is measured against. Mirrors GOVERNING_TYPES in
// backend/lib/docTypes.js, which is the authority — the backend validates against its own list.
const GOVERNING = ['contract', 'purchase-order'];

// Only these are offered on upload — 'reference' is legacy and folds into 'other'.
const UPLOAD_CATEGORIES = CATEGORIES.filter(c => c.key !== 'reference');

// Mirrors FIELDS in backend/lib/memoCover.js. Kept in step by hand; the backend rejects
// anything not on its own list, so a drift here fails loudly rather than silently.
const MEMO_FIELDS = [
  ['date', "Today's date"], ['to_name', 'Addressed to'], ['from_name', 'From'],
  ['project_name', 'Project name'], ['vendor_name', 'Vendor name'], ['memo_type', 'Proposal / Change Order'],
  ['po_number', 'PO number'], ['po_reference', 'PO reference wording'], ['scope_of_work', 'Scope of work'],
  ['total_price', 'Total price'], ['change_order_price', 'Change order amount'],
  ['original_po_amount', 'Original PO amount'], ['new_total_amount', 'New PO total'],
  ['request_sentence', 'The request sentence'],
];

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
      {/* A memo cover is the one category that is not a PDF: it stays a Word file so it can be
          filled in and handed back as one. */}
      <FileDrop file={file} onChange={f => { setFile(f); if (!label && f) setLabel(f.name.replace(/\.(pdf|docx)$/i, '')); }}
        label={chosen.docx ? 'Your memo cover (Word .docx)' : 'The document (PDF)'}
        accept={chosen.docx ? '.docx' : '.pdf'}
        hint={chosen.docx ? 'Word document — the memo letter you already use' : 'PDF · no size limit'} />

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
      {chosen.docx && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#fff1f2', border: '1px solid #fecdd3', color: '#9f1239' }}>
          <SparklesIcon className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
          Upload the memo letter you already use — filled in or blank, it does not need placeholders.
          Coaster reads it and shows you which parts it thinks change from memo to memo, for you to
          confirm. After that every proposal is generated into your own document.
        </div>
      )}

      {GOVERNING.includes(docType) && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#eff6ff', border: '1px solid #dbeafe', color: '#1e40af' }}>
          <SparklesIcon className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
          Coaster reads it on upload — tax status, unallowable costs, retainage and the contract
          sum — so the review tools never have to read it again. Uploading takes a moment; the
          reading finishes in the background and this page shows when it is done.
        </div>
      )}

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy || !file}>
          {busy ? 'Uploading…' : `Add ${chosen.label}`}
        </button>
      </div>
    </form>
  );
}

// Confirming what Coaster read out of the memo. Every proposal is shown with the exact text
// it matched, so the user is approving something concrete rather than a field name — and a
// memo goes to an owner for signature, which is why nothing is applied until this is done.
function MemoCoverReview({ doc, projectId, onDone, onCancel }) {
  const initial = (doc.terms?.replacements || []).map(r => ({ ...r, keep: true }));
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const confirm = async () => {
    setBusy(true); setError('');
    try {
      await projectDocumentsApi.update(projectId, doc.id, {
        terms: {
          ...doc.terms,
          confirmed: true,
          replacements: rows.filter(r => r.keep).map(({ keep, ...r }) => r),
        },
      });
      onDone();
    } catch (err) {
      setError(errorText(err, 'Could not save the mapping.'));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 leading-relaxed">
        Coaster read <span className="font-semibold">{doc.file_name}</span> and marked the parts it
        thinks change from memo to memo. Untick anything that should stay fixed, and correct any
        field that was matched to the wrong thing.
      </p>

      {doc.terms?.notes && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
          {doc.terms.notes}
        </div>
      )}

      <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
        {rows.length === 0 && (
          <p className="text-[12px] text-gray-500">
            Nothing variable was found. If the memo already uses {'{{field}}'} placeholders it will
            work as-is — just confirm.
          </p>
        )}
        {rows.map((r, i) => (
          <div key={i} className="p-3 rounded-xl flex items-start gap-2.5"
            style={{ background: r.keep ? '#fff' : '#f9fafb', border: '1px solid #e8edf2', opacity: r.keep ? 1 : 0.55 }}>
            <input type="checkbox" className="mt-1 flex-shrink-0" checked={r.keep}
              onChange={e => setRow(i, { keep: e.target.checked })} />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-gray-900 font-mono break-words">"{r.find}"</p>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-[10px] text-gray-400">becomes</span>
                <select className="input py-0.5 text-[11px] w-auto" value={r.field}
                  onChange={e => setRow(i, { field: e.target.value })}>
                  {MEMO_FIELDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                {r.occurrences > 1 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                    style={{ background: '#eff6ff', color: '#1d4ed8' }}>
                    appears {r.occurrences}×
                  </span>
                )}
                {r.confidence === 'low' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                    style={{ background: '#fff7ed', color: '#c2410c' }}>check this one</span>
                )}
              </div>
              {r.why && <p className="text-[10px] text-gray-400 mt-1">{r.why}</p>}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={confirm} disabled={busy}>
          {busy ? 'Saving…' : `Use this memo cover (${rows.filter(r => r.keep).length} fields)`}
        </button>
      </div>
    </div>
  );
}

// What Coaster got out of this document, and whether it has finished.
//
// This page showed no status at all: a contract still being read looked exactly like one that
// had been read and said nothing about tax, and a contract whose reading had FAILED looked
// identical to both. Now that every document is read on upload, saying nothing would leave the
// whole feature invisible — a PM would have no way to tell a drawing set that has been indexed
// from one that has not.
function ReadingState({ doc }) {
  const status = doc.terms_status || 'ready';
  const terms = doc.terms || {};

  if (status === 'pending' || status === 'reading') {
    return (
      <p className="text-[11px] mt-1" style={{ color: '#c2410c' }}>
        Reading it now — this takes a minute or two on a long document. Reviews can use it as
        soon as it finishes.
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <p className="text-[11px] mt-1" style={{ color: '#b91c1c' }}>
        Could not be read{doc.terms_error ? ` — ${doc.terms_error}` : ''}. The file is still on
        file and can be downloaded; only what Coaster reads from it is missing.
      </p>
    );
  }

  if (GOVERNING.includes(doc.doc_type)) {
    return (
      <p className="text-[11px] text-gray-500 mt-1">
        {terms.taxExempt === true ? 'Tax exempt' : terms.taxExempt === false ? 'Not tax exempt' : 'Tax status not stated'}
        {` · ${(terms.unallowableItems || []).length} unallowable item${(terms.unallowableItems || []).length === 1 ? '' : 's'} on file`}
        {terms.retainageRate != null ? ` · ${(terms.retainageRate * 100).toFixed(1).replace(/\.0$/, '')}% retainage` : ''}
      </p>
    );
  }

  // Everything else is stored and nothing more. The review tools read it when they need it,
  // as far as they need, so there is nothing here to report.
  return null;
}

// Which company a contract or purchase order is with.
//
// The review matches each party's billing to their own agreement, so this field decides whether a
// subcontractor is measured against their subcontract or against nothing. It is editable because
// the model reads it off a signature block that also names the owner and often a surety, and
// getting it wrong sends a subcontractor's figures to the wrong agreement.
//
// It used to be edited on the Pay App Review form. That form is a chooser now, so the field moved
// to the document it belongs to.
function PartyField({ doc, projectId, onChanged }) {
  const [value, setValue] = useState(doc.party || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (value.trim() === (doc.party || '')) return;
    setSaving(true); setError('');
    try {
      await projectDocumentsApi.update(projectId, doc.id, {
        party: value.trim(), party_role: doc.party_role || 'prime',
      });
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Could not save the company name.'));
      setValue(doc.party || '');
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-1.5">
      <input
        className="input text-[11px] py-1"
        value={value}
        disabled={saving}
        placeholder="Which company is this with?"
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {error
        ? <p className="text-[10px] mt-0.5" style={{ color: '#b91c1c' }}>{error}</p>
        : !doc.party && (
          <p className="text-[10px] mt-0.5" style={{ color: '#c2410c' }}>
            With no company named, this is not applied to anybody's billing.
          </p>
        )}
    </div>
  );
}

function DocumentRow({ doc, projectId, onChanged, onReview }) {
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
            {doc.doc_type === 'memo-cover' && (
              <p className="text-[11px] mt-1">
                {terms?.confirmed
                  ? <span style={{ color: '#15803d' }}>
                      Ready — {(terms.replacements || []).length} field{(terms.replacements || []).length === 1 ? '' : 's'} will be filled in on every memo.
                    </span>
                  : <span style={{ color: '#c2410c' }}>
                      Needs review — Coaster found {(terms?.replacements || []).length} variable part(s). Confirm them before it is used.
                    </span>}
              </p>
            )}
            {GOVERNING.includes(doc.doc_type) && <ReadingState doc={doc} />}
            {GOVERNING.includes(doc.doc_type) && (
              <PartyField doc={doc} projectId={projectId} onChanged={onChanged} />
            )}
          </>
        )}
      </div>

      {!renaming && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {doc.doc_type === 'memo-cover' && (
            <button className={doc.terms?.confirmed ? 'btn-secondary px-2 py-1' : 'btn-primary px-2 py-1'}
              title="Review what Coaster will fill in" onClick={() => onReview(doc)}>
              <SparklesIcon className="w-4 h-4" />
            </button>
          )}
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
  const [reviewing, setReviewing] = useState(null);

  const load = useCallback(() => {
    if (!projectId) return;
    projectDocumentsApi.list(projectId)
      .then(d => { setDocs(d); setError(''); })
      .catch(err => setError(errorText(err, 'Could not load this project\'s documents.')));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  // Reading happens after the upload responds, so without this the page would sit on "reading it
  // now" until someone reloaded it by hand — which reads as a hang.
  const anyReading = (docs || []).some(d => d.terms_status === 'pending' || d.terms_status === 'reading');
  useEffect(() => {
    if (!anyReading) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [anyReading, load]);

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

  const hasPrimaryContract = (docs || []).some(d => GOVERNING.includes(d.doc_type) && d.is_primary === 1);

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
          No contract or purchase order is marked for reviews yet. Pay App Review, Invoice Review
          and Change Order Review still run without one — they just check the arithmetic and leave
          the contract sum, retainage and tax rules unchecked. Add one, or mark an existing one
          with the star, if you want those checked too.
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
            Add the contract if the job has one, or the purchase order if it does not — Coaster
            reads its terms once and every review from then on checks against it. Drawings, specs
            and anything else the team needs go here too, and each review reads them when it
            needs them.
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
                <DocumentRow key={doc.id} doc={doc} projectId={projectId}
                  onChanged={load} onReview={setReviewing} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {reviewing && (
        <Modal title="What Coaster will fill in" onClose={() => setReviewing(null)} size="lg">
          <MemoCoverReview doc={reviewing} projectId={projectId}
            onDone={() => { setReviewing(null); load(); }}
            onCancel={() => setReviewing(null)} />
        </Modal>
      )}
      {uploading && (
        <Modal title="Add a Document" onClose={() => setUploading(false)} size="lg">
          <UploadForm projectId={projectId}
            onSaved={saved => {
              setUploading(false);
              load();
              if (saved?.doc_type === 'memo-cover') setReviewing(saved);
            }}
            onCancel={() => setUploading(false)} />
        </Modal>
      )}
    </div>
  );
}
