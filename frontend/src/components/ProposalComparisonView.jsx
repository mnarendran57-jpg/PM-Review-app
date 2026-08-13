import {
  ScaleIcon, ExclamationTriangleIcon, ArrowsRightLeftIcon, QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';

// The proposal against the documents it is meant to price.
//
// Three groups, in the order the money is in them: work priced that the contract excludes, work
// priced differently from what is drawn, and work the documents require that nobody priced. The
// last is the most expensive and the easiest to miss, because a gap has nothing on the page to
// draw the eye — so it is given the same weight as the other two rather than tucked underneath.
//
// Every finding carries the wording it rests on and the page it came from. That is deliberate:
// the PM forwards this to the contractor, and a finding they cannot attach the drawing note to
// is a finding they have to go and look up before they can use it.

const money = n => (typeof n === 'number' && Number.isFinite(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : null);

const CONFIDENCE = {
  certain: { label: 'certain', color: '#b91c1c' },
  likely: { label: 'likely', color: '#c2410c' },
  worth_checking: { label: 'worth checking', color: '#a16207' },
};

const GROUPS = [
  {
    key: 'outsideContract',
    title: 'Outside the contract',
    blurb: 'Priced, but the documents exclude it or give it to somebody else.',
    icon: ExclamationTriangleIcon,
    bg: '#fef2f2', border: '#fecaca', color: '#b91c1c',
    theirs: 'The documents say',
  },
  {
    key: 'differsFromDocuments',
    title: 'Differs from the design documents',
    blurb: 'Priced, but not as the drawings or the contract describe it.',
    icon: ArrowsRightLeftIcon,
    bg: '#fff7ed', border: '#fed7aa', color: '#c2410c',
    theirs: 'The documents show',
  },
  {
    key: 'notPriced',
    title: 'Required, but not priced',
    blurb: 'The documents call for it and the proposal is silent. This is the one that becomes a '
      + 'change order later.',
    icon: QuestionMarkCircleIcon,
    bg: '#fefce8', border: '#fde68a', color: '#a16207',
    theirs: 'The documents require',
  },
];

function Finding({ f, group }) {
  const c = CONFIDENCE[f.confidence] || CONFIDENCE.worth_checking;
  return (
    <div className="p-3 rounded-lg" style={{ background: '#fff', border: `1px solid ${group.border}` }}>
      <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
        <p className="text-[13px] font-semibold text-gray-900">{f.item}</p>
        {money(f.amount) && (
          <span className="text-[12px] font-semibold" style={{ color: group.color }}>{money(f.amount)}</span>
        )}
        <span className="text-[10px] uppercase tracking-wider ml-auto" style={{ color: c.color }}>{c.label}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400">The proposal</p>
          <p className="text-[12px] text-gray-700">{f.proposalSays}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider" style={{ color: group.color }}>{group.theirs}</p>
          <p className="text-[12px] text-gray-700">{f.documentsSay || '—'}</p>
          {f.source && <p className="text-[10px] text-gray-400 mt-0.5">{f.source}</p>}
        </div>
      </div>
      {f.whyItMatters && (
        <p className="text-[11px] text-gray-600 mt-2 pt-2" style={{ borderTop: '1px solid #f1f5f9' }}>
          {f.whyItMatters}
        </p>
      )}
    </div>
  );
}

export default function ProposalComparisonView({ comparison, error }) {
  if (error) {
    return (
      <div className="card p-5">
        <p className="text-[13px] font-bold text-gray-900 mb-1">Proposal against the documents</p>
        <p className="text-[12px]" style={{ color: '#b91c1c' }}>{error}</p>
        <p className="text-[11px] text-gray-400 mt-1">
          The review above is unaffected — only the comparison failed.
        </p>
      </div>
    );
  }
  if (!comparison) return null;

  const total = GROUPS.reduce((n, g) => n + (comparison[g.key]?.length || 0), 0);
  const free = comparison.freeFindings || [];
  const located = comparison.located;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <ScaleIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#6366f1' }} />
        <p className="text-[13px] font-bold text-gray-900">Proposal against the project documents</p>
      </div>

      {comparison.headline && (
        <p className="text-[14px] font-semibold text-gray-900 leading-snug">{comparison.headline}</p>
      )}

      {GROUPS.map((g) => {
        const items = comparison[g.key] || [];
        if (!items.length) return null;
        const Icon = g.icon;
        return (
          <div key={g.key} className="p-3 rounded-xl" style={{ background: g.bg, border: `1px solid ${g.border}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className="w-4 h-4 flex-shrink-0" style={{ color: g.color }} />
              <p className="text-[12px] font-bold" style={{ color: g.color }}>{g.title}</p>
              <span className="text-[11px] ml-auto" style={{ color: g.color }}>{items.length}</span>
            </div>
            <p className="text-[11px] text-gray-500 mb-2">{g.blurb}</p>
            <div className="space-y-2">
              {items.map((f, i) => <Finding key={i} f={f} group={g} />)}
            </div>
          </div>
        );
      })}

      {total === 0 && comparison.ranAiPass && (
        <p className="text-[12px] text-gray-600">
          Nothing in the proposal contradicts the pages of the documents that were read.
        </p>
      )}

      {/* Found by matching text, with no judgement involved. Shown separately so a reader can see
          which findings are a plain quotation and which took a reading. */}
      {free.length > 0 && (
        <div className="p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #eef1f4' }}>
          <p className="text-[12px] font-bold text-gray-800 mb-1">Exclusions matched word for word</p>
          <p className="text-[11px] text-gray-500 mb-2">
            A priced line whose wording appears inside an exclusion note. Matched on text alone —
            read the note before acting on it.
          </p>
          <div className="space-y-1.5">
            {free.map((f, i) => (
              <div key={i} className="text-[12px] text-gray-700">
                <span className="font-semibold">{f.proposalLine}</span>
                {money(f.amount) && <span className="text-gray-500"> · {money(f.amount)}</span>}
                <p className="text-[11px] text-gray-500">
                  {f.documentLabel} p.{f.page} — “{f.statement || f.passage}”
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {comparison.worthAsking?.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
            Worth asking the contractor
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {comparison.worthAsking.map((q, i) => <li key={i} className="text-[12px] text-gray-700">{q}</li>)}
          </ul>
        </div>
      )}

      {/* The limit of the comparison, always stated. Only a fraction of the documents is read on
          purpose, and a reader who does not know that would take silence for a clean bill. */}
      <div className="pt-2" style={{ borderTop: '1px solid #f1f5f9' }}>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">What was read</p>
        {(located?.read || []).map((r, i) => (
          <p key={i} className="text-[11px] text-gray-500">
            {r.label} — {r.pagesWithScopeLanguage} of {r.pagesTotal} pages carry scope language;
            {' '}the densest were read.
          </p>
        ))}
        {(located?.unreadable || []).map((u, i) => (
          <p key={i} className="text-[11px]" style={{ color: '#b45309' }}>
            {u.label} — not searched: {u.why}
          </p>
        ))}
        {comparison.couldNotCheck && (
          <p className="text-[11px] text-gray-500 mt-1">{comparison.couldNotCheck}</p>
        )}
      </div>
    </div>
  );
}
