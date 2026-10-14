import { useState } from 'react';
import { PaperClipIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { projectDocumentsApi } from '../api';

// Documents added while an RFI or a submittal is being read against the project's documents: as
// many as needed, each with its own answer to "just this once, or keep it for the project?".
//
// Shared by the RFI log and the submittal log, in both places each of them reads something against
// documents, so that adding a drawing works the same way wherever it is done.

// Where an added document ends up. ONCE stays with the one RFI or submittal and is not seen
// anywhere else; any other value is a Shared Documents category, and the document is filed there
// for every tool and every later entry to use.
export const ONCE = 'once';

// The categories Shared Documents offers for reference material. A contract or a purchase order is
// left out on purpose: filing one of those changes what reviews are measured against, and that is a
// decision for the Shared Documents page, not a side effect of logging an RFI.
export const SHARE_CATEGORIES = [
  { key: 'drawings', label: 'Drawings' },
  { key: 'specifications', label: 'Specifications' },
  { key: 'design', label: 'Design Documents' },
  { key: 'scope', label: 'Scope of Work' },
  { key: 'proposal', label: 'Proposals' },
  { key: 'estimate', label: 'Cost Estimate' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'permit', label: 'Permits & Approvals' },
  { key: 'other', label: 'Other' },
];

// What a submittal can be measured against. A submittal review reads only these three kinds — a
// schedule or a proposal filed from here would be saved and then not read, with nothing on the
// page to say why — so they are the only ones offered there. Mirrors DESIGN_TYPES in
// backend/lib/docTypes.js.
// What a change order is measured against, when the document added is its contract.
export const CONTRACT_CATEGORIES = [
  { key: 'contract', label: 'Contract' },
  { key: 'purchase-order', label: 'Purchase Order' },
];

export const DESIGN_CATEGORIES = [
  { key: 'specifications', label: 'Specifications' },
  { key: 'drawings', label: 'Drawings' },
  { key: 'design', label: 'Design Documents' },
];

// The state behind the uploader, and what becomes of the documents in it.
//
// `added` is [{ file, where }], where `where` is ONCE or a Shared Documents category.
export function useAddedDocuments(projectId, documentIds, setDocumentIds) {
  const [added, setAdded] = useState([]);
  const [filing, setFiling] = useState(false);
  const [listVersion, setListVersion] = useState(0);

  // Files everything marked for Shared Documents and returns the full list of documents to read
  // against — the ones already ticked plus the ones just filed.
  //
  // Done at the moment the documents are needed rather than as each is picked, so choosing a
  // category is not itself an upload: a file picked by mistake, or put in the wrong category, can be
  // changed or removed up to the point where the PM acts on it. One at a time, and each is taken off
  // the list as it lands, so a failure half way leaves exactly the ones still to do.
  const fileShared = async () => {
    const toFile = added.filter(a => a.where !== ONCE);
    if (toFile.length === 0) return documentIds;
    setFiling(true);
    const ids = [...documentIds];
    let remaining = added;
    try {
      for (const item of toFile) {
        const fd = new FormData();
        fd.append('file', item.file);
        fd.append('doc_type', item.where);
        const doc = await projectDocumentsApi.add(projectId, fd);
        if (doc?.id) ids.push(doc.id);
        remaining = remaining.filter(a => a !== item);
        setAdded(remaining);
        setDocumentIds([...ids]);
      }
    } finally {
      setFiling(false);
      // Tells whoever lists the Shared Documents that there are new ones to show.
      setListVersion(v => v + 1);
    }
    return ids;
  };

  return {
    added, setAdded, filing, listVersion, fileShared,
    onceFiles: added.filter(a => a.where === ONCE).map(a => a.file),
  };
}

// `noun` is what the documents are being added to — "RFI", "submittal", "change order" — and is
// all that differs in the wording between the places this is used. `single` is for a slot that takes
// one document, a contract: a new pick replaces the old one rather than joining it. With no
// categories (no project to file into) only "for this one" is offered.
export default function AddedDocuments({
  items, onChange, disabled, noun = 'RFI', categories = SHARE_CATEGORIES,
  hint = 'drawings, a specification section, a marked-up sketch', single = false,
  label = "Add documents that aren't in the list",
}) {
  const add = (fileList) => {
    if (single) {
      const file = fileList[0];
      if (file) onChange([{ file, where: ONCE }]);
      return;
    }
    const incoming = [...fileList].filter(f =>
      !items.some(i => i.file.name === f.name && i.file.size === f.size));
    if (incoming.length) onChange([...items, ...incoming.map(file => ({ file, where: ONCE }))]);
  };
  const setWhere = (index, where) => onChange(items.map((item, i) => (i === index ? { ...item, where } : item)));
  const remove = index => onChange(items.filter((_, i) => i !== index));

  return (
    <div>
      <label className="label">{label}</label>
      <input type="file" multiple={!single} accept=".pdf" disabled={disabled}
        className="text-xs text-gray-500 w-full file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 file:cursor-pointer"
        // Cleared after each pick so the same file can be chosen again after being removed, and so
        // a second pick adds to the list instead of replacing it.
        onChange={e => { add(e.target.files); e.target.value = ''; }} />
      <p className="text-[11px] text-gray-400 mt-1">
        {single ? `Choose a PDF — ${hint}.` : `Choose as many PDFs as you need — ${hint}.`}
        {categories.length > 0 && ` Say whether it is for this ${noun} only or should be saved to Shared Documents.`}
      </p>

      {items.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {items.map((item, i) => (
            // Name on one line, the choice on the next: a drawing's file name is long, and beside a
            // dropdown in a narrow form it was squeezed to nothing.
            <div key={`${item.file.name}-${item.file.size}`}
              className="p-2 rounded-lg" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
              <div className="flex items-center gap-2">
                <PaperClipIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <span className="text-[12px] font-medium text-gray-800 truncate flex-1 min-w-0" title={item.file.name}>
                  {item.file.name}
                </span>
                <button type="button" className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                  aria-label={`Remove ${item.file.name}`} disabled={disabled} onClick={() => remove(i)}>
                  <XMarkIcon className="w-4 h-4" />
                </button>
              </div>
              <select className="input py-1 text-[12px] w-full mt-1.5"
                aria-label={`What to do with ${item.file.name}`}
                value={item.where} disabled={disabled} onChange={e => setWhere(i, e.target.value)}>
                <option value={ONCE}>Use for this {noun} only</option>
                {categories.length > 0 && (
                  <optgroup label="Save to Shared Documents as">
                    {categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          ))}
          {items.some(i => i.where !== ONCE) && (
            <p className="text-[11px]" style={{ color: '#1d4ed8' }}>
              The ones marked for Shared Documents are filed there when you run the reading or save,
              and are ticked in the list above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
