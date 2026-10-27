import {
  ExclamationTriangleIcon, CheckCircleIcon, LightBulbIcon, CheckIcon,
} from '@heroicons/react/24/outline';

// The pieces a review report is shown with — a verdict, a row of counts, sections, and small tables of
// the figures behind each finding — shared by the change order and invoice reviews so they read as
// one product. Mirrors backend/lib/reviewPdfKit.js, which draws the same report as a PDF.

export function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

export const TONE = {
  red: { bg: '#fef2f2', border: '#fecaca', ink: '#b91c1c' },
  amber: { bg: '#fff7ed', border: '#fed7aa', ink: '#c2410c' },
  green: { bg: '#ecfdf5', border: '#a7f3d0', ink: '#047857' },
  grey: { bg: '#f8fafc', border: '#e2e8f0', ink: '#64748b' },
  indigo: { bg: '#eef2ff', border: '#c7d2fe', ink: '#4338ca' },
};

// The answer first: whether it can go ahead, and if not, how much is wrong with it.
export function VerdictBanner({ verdict }) {
  const t = TONE[verdict.tone];
  return (
    <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: t.bg, border: `1px solid ${t.border}` }}>
      {verdict.tone === 'green'
        ? <CheckCircleIcon className="w-5 h-5 flex-shrink-0" style={{ color: t.ink }} />
        : <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" style={{ color: t.ink }} />}
      <p className="text-[14px] font-semibold" style={{ color: t.ink }}>
        {verdict.headline}{verdict.sub && <span className="font-normal">, {verdict.sub}</span>}
      </p>
    </div>
  );
}

// `toneOf(tile)` decides a tile's colour once it has a count; a count of null is "not checked".
export function CountTiles({ tiles, toneOf = t => (t.count ? (t.tone || 'red') : 'green') }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {tiles.map(t => {
        const checked = t.count != null;
        const c = TONE[checked ? toneOf(t) : 'grey'];
        return (
          <div key={t.key} className="rounded-xl px-3 py-2.5" style={{ background: c.bg }}>
            <p className="text-xl font-bold tabular-nums" style={{ color: c.ink }}>{checked ? t.count : '—'}</p>
            <p className="text-[11px] text-gray-500 leading-tight">{t.label}</p>
            {!checked && <p className="text-[10px] italic text-gray-400">not checked</p>}
          </div>
        );
      })}
    </div>
  );
}

export function Section({ title, count, tone = 'grey', children }) {
  const t = TONE[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {count != null && (
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: t.bg, color: t.ink }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// `before` finishes "Resolve before …": approving a change order, paying an invoice.
export function FindingTitle({ finding, before }) {
  return (
    <>
      <p className="text-[13px] font-medium mb-1.5" style={{ color: finding.critical ? TONE.red.ink : '#111827' }}>
        {finding.title}
        {finding.critical && <span className="text-[11px] font-semibold ml-2">Resolve before {before}</span>}
      </p>
      {finding.byCoaster && (
        <p className="text-[11px] italic text-gray-400 -mt-1 mb-1.5">Coaster's reading of the contract — verify before acting.</p>
      )}
    </>
  );
}

const th = 'text-[10px] font-semibold uppercase tracking-wider text-gray-400 py-1.5';
const td = 'py-2 text-[12px] align-top';

// Wrong arithmetic: what the document says, what it should say, and the gap. Fixed columns, so every
// finding's table lines up with the one above it.
export function CompareFinding({ finding, before, shownLabel }) {
  return (
    <div>
      <FindingTitle finding={finding} before={before} />
      <table className="w-full table-fixed">
        <colgroup><col style={{ width: '46%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /></colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
            <th className={`${th} text-left`}>Item</th>
            <th className={`${th} text-right`}>{shownLabel}</th>
            <th className={`${th} text-right`}>Should be</th>
            <th className={`${th} text-right`}>Off by</th>
          </tr>
        </thead>
        <tbody>
          {(finding.figures?.rows || []).map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f8fafc' }}>
              <td className={td}>
                <span className="text-gray-800">{r.item}</span>
                {r.working && <span className="block text-[11px] text-gray-400">{r.working}</span>}
              </td>
              <td className={`${td} text-right tabular-nums text-gray-600`}>{money(r.shown)}</td>
              <td className={`${td} text-right tabular-nums text-gray-600`}>{money(r.computed)}</td>
              <td className={`${td} text-right tabular-nums font-semibold`} style={{ color: TONE.red.ink }}>{money(r.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Where in the contract a finding comes from: the section and page, then its own words — so a
// reviewer can turn to it, and hand it to the contractor, without hunting.
// Led by the document it is in when the review was checked against more than one.
export function citeLabel(clause) {
  const where = [clause.section, clause.heading].filter(Boolean).join(' ');
  const at = [where, clause.page ? `page ${clause.page}` : null].filter(Boolean).join(', ');
  return [clause.source, at].filter(Boolean).join(' · ');
}

function ContractCite({ clause }) {
  const label = citeLabel(clause);
  return (
    <span className="mt-1.5 block rounded-md border-l-2 border-indigo-300 bg-indigo-50/60 px-2.5 py-1.5">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
        Contract{label ? ` · ${label}` : ''}
      </span>
      <span className="block text-[12px] italic leading-snug text-gray-700">&ldquo;{clause.quote}&rdquo;</span>
    </span>
  );
}

// Something the agreement does not allow: what was charged, the amount at issue, and the term.
export function DeviationFinding({ finding, before, whatLabel }) {
  return (
    <div>
      <FindingTitle finding={finding} before={before} />
      <table className="w-full table-fixed">
        <colgroup><col style={{ width: '38%' }} /><col style={{ width: '17%' }} /><col style={{ width: '45%' }} /></colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
            <th className={`${th} text-left`}>{whatLabel}</th>
            <th className={`${th} text-right`}>At issue</th>
            <th className={`${th} text-left pl-4`}>What the agreement says</th>
          </tr>
        </thead>
        <tbody>
          {(finding.figures?.rows || []).map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f8fafc' }}>
              <td className={`${td} text-gray-800`}>{r.item}</td>
              <td className={`${td} text-right tabular-nums font-semibold`} style={{ color: TONE.red.ink }}>
                {typeof r.amount === 'number' ? money(r.amount) : '—'}
              </td>
              <td className={`${td} pl-4 text-gray-700`}>
                {r.rule}
                {r.basis && <span className="block text-[11px] italic text-gray-400">{r.basis}</span>}
                {r.clause && <ContractCite clause={r.clause} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// An item and an amount per row, with a note under the item where there is one.
export function ListFinding({ finding, before, showTitle = true }) {
  return (
    <div>
      {showTitle && <FindingTitle finding={finding} before={before} />}
      {(finding.figures?.rows || []).map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 py-1.5" style={{ borderTop: i ? '1px solid #f8fafc' : 'none' }}>
          <span className="min-w-0">
            <span className={`text-[12px] ${r.emphasis ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>{r.item}</span>
            {r.note && <span className="block text-[11px] text-gray-400">{r.note}</span>}
            {r.clause && <ContractCite clause={r.clause} />}
          </span>
          <span className="text-[12px] font-semibold tabular-nums flex-shrink-0" style={{ color: r.emphasis ? TONE.red.ink : '#111827' }}>
            {typeof r.amount === 'number' ? money(r.amount) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CoasterNotes({ notes }) {
  if (!notes?.length) return null;
  return (
    <div className="card p-5" style={{ background: '#fafaff' }}>
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-2">
        <LightBulbIcon className="w-4 h-4" style={{ color: '#6366f1' }} /> Coaster's notes
      </h3>
      <div className="space-y-2">
        {notes.map((n, i) => (
          <p key={i} className="text-[12px] text-gray-700"><span className="font-medium text-gray-900">{n.title}:</span> {n.body}</p>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">Coaster reads the documents; it does not verify them on site. Treat these as prompts to check.</p>
    </div>
  );
}

// One quiet line: there for anyone who asks what was looked at, out of everyone else's way.
export function PassedLine({ passed = [], notChecked = [] }) {
  if (!passed.length && !notChecked.length) return null;
  return (
    <div className="px-1 space-y-0.5">
      {passed.length > 0 && (
        <p className="text-[11px] text-gray-400 flex items-start gap-1.5">
          <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 mt-px" style={{ color: TONE.green.ink }} />
          <span>Checked and fine: {passed.join(', ')}.</span>
        </p>
      )}
      {notChecked.length > 0 && (
        <p className="text-[11px] text-gray-400 pl-5">Could not be checked: {notChecked.map(n => n.description).join(', ')}.</p>
      )}
    </div>
  );
}
