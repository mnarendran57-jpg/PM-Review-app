import { useState } from 'react';

// The organization's own Word documents that Coaster fills in. Each is uploaded once, its varying
// parts are confirmed, and from then on the module named here produces that document rather than
// an approximation of it drawn in code.
//
// Two places on file: the company's, in Settings, fed once by an admin; and a project's own, on its
// Shared Documents, for a job that needs a different format. The project's wins where it exists —
// the rule lives in backend/lib/coverLookup.js.
//
// Mirrors COVER_KINDS in backend/lib/coverTemplates.js. Kept in step by hand; the backend rejects
// anything not on its own list, so a drift here fails loudly rather than silently.
export const COVERS = {
  'memo-cover': {
    noun: 'memo cover',
    thing: 'memo',
    label: 'Memo Cover',
    filledBy: 'Proposal Intake',
    blurb: 'The letter that goes on top of a vendor proposal when it is sent to an owner.',
    upload: 'Upload the memo letter you already use — filled in or blank, it does not need '
      + 'placeholders. Coaster reads it and shows you which parts it thinks change from memo to '
      + 'memo, for you to confirm. After that every proposal is generated into your own document.',
    fields: [
      ['date', "Today's date"], ['to_name', 'Addressed to'], ['from_name', 'From'],
      ['project_name', 'Project name'], ['vendor_name', 'Vendor name'], ['memo_type', 'Proposal / Change Order'],
      ['po_number', 'PO number'], ['po_reference', 'PO reference wording'], ['scope_of_work', 'Scope of work'],
      ['total_price', 'Total price'], ['change_order_price', 'Change order amount'],
      ['original_po_amount', 'Original PO amount'], ['new_total_amount', 'New PO total'],
      ['request_sentence', 'The request sentence'],
    ],
  },
  'progress-cover': {
    noun: 'progress report template',
    thing: 'report',
    label: 'Progress Report Template',
    filledBy: 'Progress Report',
    blurb: 'The site-visit report you send the team after a walk.',
    upload: 'Upload a progress report you have already written — one with its observations and '
      + 'photos still in it works best. Coaster reads it and shows you which parts change from '
      + 'report to report, for you to confirm. After that every site visit is written up into '
      + 'your own document, photographs and all.',
    fields: [
      ['report_title', 'Report title'], ['report_number', 'Report number'], ['date', 'Visit date'],
      ['time', 'Visit time'], ['weather', 'Weather'], ['submitted_by', 'Submitted by'],
      ['project_name', 'Project name'], ['contractor', 'Contractor'],
      ['progress', 'One progress observation (repeats)'],
      ['photo_caption', 'One photo caption (repeats)'],
    ],
  },
};

export const coverFor = docType => COVERS[docType] || null;

const errorText = (err, fallback) =>
  err?.friendlyMessage || err?.response?.data?.error || fallback;

// Confirming what Coaster read out of the customer's document. Every proposal is shown with the
// exact text it matched, so the user is approving something concrete rather than a field name —
// and these documents go out over somebody's name, which is why nothing is applied until this is
// done.
//
// `save(terms)` is supplied by whoever is showing this, because the same confirmation is made in
// two places against two different endpoints: a project's document on Shared Documents, and the
// company's own in Settings. The screen is identical either way, which is the point — a PM who has
// confirmed one has confirmed both.
export default function CoverReview({ docType, fileName, terms, save, onDone, onCancel }) {
  const cover = coverFor(docType) || COVERS['memo-cover'];
  const [rows, setRows] = useState((terms?.replacements || []).map(r => ({ ...r, keep: true })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const confirm = async () => {
    setBusy(true); setError('');
    try {
      await save({
        ...terms,
        confirmed: true,
        replacements: rows.filter(r => r.keep).map(({ keep, ...r }) => r),
      });
      onDone();
    } catch (err) {
      setError(errorText(err, 'Could not save the mapping.'));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 leading-relaxed">
        Coaster read <span className="font-semibold">{fileName}</span> and marked the parts it
        thinks change from {cover.thing} to {cover.thing}. Untick anything that should stay fixed,
        and correct any field that was matched to the wrong thing.
      </p>

      {docType === 'progress-cover' && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#fff1f2', border: '1px solid #fecdd3', color: '#9f1239' }}>
          Two of these repeat. <span className="font-semibold">One progress observation</span> and{' '}
          <span className="font-semibold">one photo caption</span> should each be marked on a single
          example — one bullet, one caption — and Coaster copies that line once per observation and
          once per photo, with the photograph placed above its caption. If two are ticked for the
          same field, the list comes out twice.
        </div>
      )}

      {terms?.notes && (
        <div className="p-3 rounded-xl text-[11px] leading-relaxed"
          style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
          {terms.notes}
        </div>
      )}

      <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
        {rows.length === 0 && (
          <p className="text-[12px] text-gray-500">
            Nothing variable was found. If the {cover.thing} already uses {'{{field}}'} placeholders
            it will work as-is — just confirm.
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
                  {cover.fields.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
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
          {busy ? 'Saving…' : `Use this ${cover.noun} (${rows.filter(r => r.keep).length} fields)`}
        </button>
      </div>
    </div>
  );
}
