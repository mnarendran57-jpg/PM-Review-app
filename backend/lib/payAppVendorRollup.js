// One subcontractor, every line they touch.
//
// The sixth family, and the first one that reads the application VENDOR by vendor instead of line
// by line. Every other engine reasons about a single row, a single document, or a single pair of
// figures. None of them can see the failure this file exists for, which is a subcontractor whose
// scope is billed in two different places on the schedule.
//
// The case it was built from, GreenScape on a real application:
//
//                              schedule    sched value    previous   this period   to date    balance   retainage
//   Tree Protection            Div 32       110,380.00   100,780.00     3,200.00  103,980.00  6,400.00   5,199.00
//   CPR 002 - Tree Trimming    AEA 02        27,335.00    20,329.58     1,401.10   21,730.68  5,604.32   1,086.53
//                                           ----------   ----------   ----------  ----------  --------  ---------
//                                           137,715.00   121,109.58     4,601.10  125,710.68 12,004.32   6,285.53
//   GreenScape's own sheet                  137,715.00   121,109.58     4,601.10  125,710.68 12,004.32   6,285.53
//
// Six columns, six exact hits — and nothing in the review noticed, because the coverage engine
// matches one document to one line and there is no such line. Half of GreenScape's scope is a base
// contract line in Division 32 and half is an allowance drawn down under a completely different
// section. Read either one alone and it is defensible. Read them together and they are a contract.
//
// TWO IDEAS CARRY THE FILE.
//
// 1. THE SET, NOT THE LINE. The question asked here is "which lines are this vendor's, and do they
//    add up to what the vendor billed" — so the unit of comparison is a SUBSET of the schedule.
//    Which subset is not declared anywhere in the package, so it is searched for.
//
// 2. THE WHOLE VECTOR AT ONCE. One column agreeing proves nothing; $137,715 could be a
//    coincidence. Six columns agreeing is not a coincidence — previous, this period, to date,
//    balance and retainage all landing exactly means the set genuinely is that vendor's scope.
//    That strength is what makes the search safe: a wrong set is rejected by arithmetic rather
//    than by a rule that has to be taught what a bold unnumbered header row means.
//
// It follows that the interesting finding is a set that matches on MOST columns. If contract sum,
// previously billed and retainage all tie and only this period does not, the set is certainly
// right and the difference is certainly real: the contractor is billing the owner an amount this
// month that their own subcontractor did not bill them.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : 0);
const sum = (list, f) => (list || []).reduce((a, x) => a + num(f(x)), 0);

// Tighter than the aggregate tolerance used elsewhere. A rollup is only ever believed because its
// columns land exactly; allowing a few dollars of slack would let a near-miss set pass as the
// vendor's scope and turn a real difference into a rounding story.
const EXACT = 0.05;

// The columns compared. Order is the order they appear on a continuation sheet, which is the order
// a reader checks them in.
const COLUMNS = [
  { key: 'scheduledValue', label: 'contract sum' },
  { key: 'previous', label: 'previously billed' },
  { key: 'thisPeriod', label: 'billed this period' },
  { key: 'totalToDate', label: 'billed to date' },
  { key: 'balance', label: 'balance to finish' },
  { key: 'retainage', label: 'retainage held' },
];

// Contract sum is the anchor. It is the one column that identifies a SCOPE rather than a moment:
// two lines can bill the same amount this month by chance, but a set whose contract sums total to
// the subcontract exactly is that subcontract. Nothing is called a match without it.
const ANCHOR = 'scheduledValue';

// Below this the arithmetic is not strong enough to name a set. Two columns can agree by accident
// when one of them is a zero and the other is a repeat of the first.
const MIN_COLUMNS = 3;

// The search is over subsets, so the pool has to stay small. Ten lines is 1,023 combinations,
// which is nothing; twenty is a million. Real vendors touch two or three lines, and a pool larger
// than this means the name matched something generic, so the pool is trimmed and the trim is
// declared rather than hidden. Twelve, not ten: a demolition subcontract on the application this
// was calibrated against legitimately spans seven lines across four divisions, and a ceiling that
// cannot hold a real subcontract is not a safety margin.
const MAX_POOL = 12;

// --- naming ------------------------------------------------------------------------------------
//
// Which lines might be this vendor's. Getting this wrong in the generous direction is cheap — the
// arithmetic throws out anything that does not belong — so it errs towards including a line.

const normalise = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Words that identify no one. "Construction Services LLC" and "Services Construction LLC" are two
// different companies and neither is found by searching for "services".
const NOISE = new Set([
  'inc', 'llc', 'lp', 'llp', 'ltd', 'co', 'corp', 'company', 'corporation', 'group', 'holdings',
  'the', 'and', 'of', 'services', 'service', 'construction', 'contractors', 'contractor',
  'builders', 'systems', 'solutions', 'enterprises', 'industries', 'usa', 'texas', 'inc.',
]);

function vendorTokens(vendor) {
  const words = normalise(vendor).split(' ').filter(w => w && !NOISE.has(w));
  const strong = words.filter(w => w.length >= 5);
  // A short distinctive name — "Aztec", "Bond" — is still a name. When nothing survives the length
  // filter the whole name is used instead, joined up, so it has to appear as written.
  return strong.length ? strong : (words.length ? [words.join('')] : []);
}

// A schedule almost never calls a subcontractor by the name on their pay application. Bartlett
// Cocke's own schedule bills "Integrated Demolition and Remediation Inc." as "Demolition - IDR",
// "Abatement - IDR", "Survey Existing Piers - IDR" — seven lines, and only one of them contains a
// word from the company's actual name. Without the initials the rollup found one line out of
// seven and reported a subcontract that reconciles to the penny as failing to add up.
//
// Matched as a WHOLE WORD, never as a substring. Three letters loose inside a description would
// hit constantly, and a wrongly gathered line is worse here than a missed one.
function vendorAcronym(vendor) {
  const words = normalise(vendor).split(' ').filter(w => w && !NOISE.has(w));
  const initials = words.map(w => w[0]).join('');
  return initials.length >= 3 && initials.length <= 5 ? initials : null;
}

function namesVendor(li, tokens, acronym) {
  const text = `${normalise(li.description)} ${normalise((li.vendors || []).join(' '))}`;
  if (tokens.length && tokens.some(t => text.replace(/ /g, '').includes(t))) return true;
  return !!acronym && new RegExp(`\\b${acronym}\\b`).test(text);
}

// --- vectors -----------------------------------------------------------------------------------

const vectorOf = o => Object.fromEntries(COLUMNS.map(c => [c.key, isNum(o?.[c.key]) ? o[c.key] : null]));

// A column can only be totalled when EVERY line in the set carries it. Summing four lines that
// state retainage and one that does not produces a figure that looks like a total and is not one,
// and it would then be compared against the vendor's real total and reported as a difference.
function subsetVector(lines) {
  const out = {};
  for (const c of COLUMNS) {
    out[c.key] = lines.every(l => isNum(l[c.key])) ? sum(lines, l => l[c.key]) : null;
  }
  return out;
}

function compare(theirs, ours) {
  const matched = [];
  const differ = [];
  for (const c of COLUMNS) {
    const a = theirs[c.key];
    const b = ours[c.key];
    if (!isNum(a) || !isNum(b)) continue;
    (Math.abs(a - b) <= EXACT ? matched : differ).push({ ...c, theirs: a, ours: b, difference: b - a });
  }
  return { matched, differ, comparable: matched.length + differ.length };
}

const anchored = cmp => cmp.matched.some(m => m.key === ANCHOR);

// --- the search ----------------------------------------------------------------------------------
//
// Every non-empty subset of the pool, scored by how many columns it gets exactly right. Ties are
// broken towards the SMALLER set: a set that matches and the same set plus a line billing nothing
// both match equally well, and the smaller one is the true answer.
//
// Two different sets of the same size scoring the same is treated as no answer at all. Picking one
// would attribute a subcontract to lines it may have nothing to do with, and every sentence
// printed afterwards would be confidently about the wrong money.

function bestSubset(pool, theirs) {
  let best = null;
  let ambiguous = false;

  for (let mask = 1; mask < (1 << pool.length); mask++) {
    const lines = pool.filter((_, i) => mask & (1 << i));
    const cmp = compare(theirs, subsetVector(lines));
    if (!cmp.comparable) continue;
    const score = [cmp.matched.length, -lines.length];
    if (!best) { best = { lines, cmp, score }; continue; }
    const d = score[0] - best.score[0] || score[1] - best.score[1];
    if (d > 0) { best = { lines, cmp, score }; ambiguous = false; }
    else if (d === 0 && lines.length === best.lines.length
      && lines.some(l => !best.lines.includes(l))) ambiguous = true;
  }
  return best ? { ...best, ambiguous } : null;
}

// The one line nobody named.
//
// A vendor's scope can land on a line that never mentions them — an allowance section, a line
// carrying only a change-order reference. Rather than widen the subset search across the whole
// schedule, which would be both slow and far too willing to find something, this asks a single
// closed question: is there exactly one line anywhere that is EXACTLY the difference between what
// the vendor billed and what the named lines account for, in every column?
//
// That is a lookup, not a search, and a line matching a multi-column remainder by chance is not a
// thing that happens.
function completingLine(all, chosen, theirs) {
  const have = subsetVector(chosen);
  const want = {};
  let comparable = 0;
  for (const c of COLUMNS) {
    if (!isNum(theirs[c.key]) || !isNum(have[c.key])) { want[c.key] = null; continue; }
    want[c.key] = theirs[c.key] - have[c.key];
    comparable += 1;
  }
  if (comparable < MIN_COLUMNS) return null;
  if (!isNum(want[ANCHOR]) || Math.abs(want[ANCHOR]) <= EXACT) return null;

  const hits = all.filter(l => !chosen.includes(l)
    && COLUMNS.every(c => !isNum(want[c.key]) || (isNum(l[c.key]) && Math.abs(l[c.key] - want[c.key]) <= EXACT)));
  return hits.length === 1 ? hits[0] : null;
}

// --- putting one vendor together -------------------------------------------------------------------

function rollUp(app, vendor) {
  const all = (app.sovLines || []).map(l => ({ ...l, ...vectorOf(l) }));
  const theirs = vectorOf(vendor);
  const tokens = vendorTokens(vendor.vendor);
  const acronym = vendorAcronym(vendor.vendor);

  const named = all.filter(l => namesVendor(l, tokens, acronym)
    && COLUMNS.some(c => num(l[c.key]) !== 0));
  const truncated = named.length > MAX_POOL;
  const pool = truncated
    ? [...named].sort((a, b) => Math.abs(num(b.scheduledValue)) - Math.abs(num(a.scheduledValue))).slice(0, MAX_POOL)
    : named;

  const base = { vendor, named, pool, truncated, tokens, acronym };

  if (!isNum(theirs[ANCHOR]) && COLUMNS.filter(c => isNum(theirs[c.key])).length < MIN_COLUMNS) {
    return { ...base, outcome: 'no-figures', lines: [], cmp: null };
  }
  if (!pool.length) return { ...base, outcome: 'no-lines', lines: [], cmp: null };

  let best = bestSubset(pool, theirs);
  if (!best) return { ...base, outcome: 'no-lines', lines: [], cmp: null };

  let widened = null;
  if (best.cmp.differ.length) {
    widened = completingLine(all, best.lines, theirs);
    if (widened) {
      const lines = [...best.lines, widened];
      const cmp = compare(theirs, subsetVector(lines));
      // Only kept if it genuinely improves the reconciliation. A line that closes one column and
      // breaks two is not the missing piece.
      if (cmp.matched.length > best.cmp.matched.length && !cmp.differ.length) {
        best = { lines, cmp, ambiguous: false };
      } else widened = null;
    }
  }

  const { cmp, lines, ambiguous } = best;
  const leftover = named.filter(l => !lines.includes(l));

  const outcome =
    ambiguous ? 'ambiguous'
      : cmp.comparable < MIN_COLUMNS ? 'too-few-columns'
        : !cmp.differ.length && anchored(cmp) ? 'reconciled'
          : anchored(cmp) ? 'differs'
            : cmp.matched.length >= 2 ? 'partial'
              : 'unmatched';

  return { ...base, outcome, lines, cmp, leftover, widened };
}

// --- the checks ------------------------------------------------------------------------------------

const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });

const nameList = lines => lines.map(l => l.description || `item ${l.itemNo ?? l.code}`);
const andList = (items) => {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

// How this vendor's scope is spread, in one clause, for the front of a sentence.
const spread = r => (r.lines.length === 1
  ? `one schedule line (${nameList(r.lines)[0]})`
  : `${r.lines.length} schedule lines (${andList(nameList(r.lines))})`);

const VENDOR_CHECKS = [
  {
    id: 'V1',
    title: "Each subcontractor's own application ties to the lines billing their scope",
    severity: SEVERITY.CRITICAL,
    run(app, rolls) {
      const out = [];
      for (const r of rolls) {
        const who = r.vendor.vendor;
        const ref = [r.vendor.applicationNumber ? `application ${r.vendor.applicationNumber}` : null,
          r.vendor.commitment].filter(Boolean).join(', ');
        const where = { vendor: who };

        if (r.outcome === 'no-figures') {
          out.push(skip(`${who}'s application was read but carries too few column totals to be `
            + 'rolled up against the schedule.', { where }));
          continue;
        }
        if (r.outcome === 'no-lines') {
          out.push(skip(`No schedule line names ${who}, so their application could not be matched `
            + 'to the work being billed to the owner. This is usually a schedule that describes '
            + 'scope rather than subcontractors, not a missing line.', { where }));
          continue;
        }
        if (r.outcome === 'ambiguous' || r.outcome === 'too-few-columns') {
          out.push(skip(`${who}'s application could not be tied to a definite set of schedule `
            + `lines${r.outcome === 'ambiguous' ? ' — more than one combination fits equally well' : ''}, `
            + `so nothing was concluded about it. ${r.named.length} line(s) name them: `
            + `${andList(nameList(r.named))}.`, { where }));
          continue;
        }

        if (r.outcome === 'reconciled') {
          out.push({
            status: 'PASS',
            where,
            detail: `${who}${ref ? ` (${ref})` : ''} bills ${money(num(r.vendor.thisPeriod))} this `
              + `period, accounted for exactly by ${spread(r)}. `
              + `All ${r.cmp.matched.length} comparable columns agree`
              + `${r.widened ? `, including one line that does not carry their name (${r.widened.description})` : ''}.`,
          });
          continue;
        }

        // Identified, and something is wrong with it. Which column is adrift decides how hard this
        // is pushed: a difference in this period is money being asked for now.
        const period = r.cmp.differ.find(d => d.key === 'thisPeriod');
        const agreed = r.cmp.matched.map(m => m.label);
        const wrong = r.cmp.differ.map(d =>
          `${d.label} — they show ${money(d.theirs)}, the application ${money(d.ours)}`);

        if (r.outcome === 'differs' && period) {
          out.push({
            status: 'FAIL',
            severity: SEVERITY.CRITICAL,
            where,
            expected: period.theirs,
            actual: period.ours,
            difference: period.difference,
            // The first sentence is the report's headline, so it carries the whole point on its
            // own and is kept short enough to survive intact: the report cuts a long headline at
            // its first turn of phrase, which would strand the difference in the paragraph below.
            // The two figures and the lines they sit on are the explanation and follow after.
            detail: `The schedule bills ${money(Math.abs(period.difference))} `
              + `${period.difference > 0 ? 'more' : 'less'} of ${who}'s work this period than they `
              + `billed for. ${who} billed ${money(period.theirs)}; ${spread(r)} bill the owner `
              + `${money(period.ours)}. Their ${andList(agreed)} tie exactly to those same lines, `
              + 'so this is one scope described in two documents and the difference is in this '
              + 'month alone. '
              // The other columns move with it — a line billed too much is also completed too
              // much and retained too much — so they are named rather than restated in full.
              // Repeating four pairs of figures that all say the same thing buries the one that
              // matters.
              + (r.cmp.differ.length > 1
                ? `It carries through into ${andList(r.cmp.differ.filter(d => d.key !== 'thisPeriod')
                  .map(d => d.label))} as well. ` : '')
              + 'Ask for the page of their application that supports what is being billed.',
          });
          continue;
        }

        // Retainage alone is a different animal, and calling it an error would be wrong on most
        // real applications. The owner retains from the contractor under one agreement and the
        // contractor retains from the subcontractor under another, at rates that are not obliged
        // to match — on the application this was calibrated against, the owner held 5% of IDR's
        // work while the contractor held 0.75% from IDR, five columns tying exactly around it.
        // That is worth knowing and is not worth holding a certificate over.
        const retainageOnly = r.cmp.differ.length === 1 && r.cmp.differ[0].key === 'retainage';
        if (r.outcome === 'differs' && retainageOnly) {
          const d = r.cmp.differ[0];
          out.push({
            status: 'FAIL',
            severity: SEVERITY.NOTE,
            where,
            difference: d.difference,
            detail: `${who} is retained at a different rate than the owner retains on their work. `
              + `The owner holds ${money(d.ours)} against ${spread(r)}; ${who}'s own application `
              + `shows ${money(d.theirs)} held from them — ${money(Math.abs(d.difference))} `
              + `${d.difference > 0 ? 'more' : 'less'}. Everything else ties exactly, so this is two `
              + 'contracts with different retainage terms rather than an error. It is worth knowing '
              + `because it is the contractor, not the owner, carrying the difference.`,
          });
          continue;
        }

        if (r.outcome === 'differs') {
          out.push({
            status: 'FAIL',
            severity: SEVERITY.MATERIAL,
            where,
            difference: r.cmp.differ[0].difference,
            detail: `${who}'s ${andList(r.cmp.differ.map(d => d.label))} does not agree with the `
              + `lines billing their work — ${andList(wrong)}. Their contract sum ties exactly to `
              + `${spread(r)}, so those lines are certainly their scope. The amount billed this `
              + 'period is not in question; the history behind it is, and it will be in question '
              + 'again next month.',
          });
          continue;
        }

        // Partial: enough agrees to be worth raising, not enough to be sure which lines are theirs.
        out.push({
          status: 'FAIL',
          severity: SEVERITY.MATERIAL,
          where,
          detail: `${who} billed ${money(num(r.vendor.thisPeriod))} this period and the lines naming `
            + `them do not add up to their application. The closest fit is ${spread(r)}. That set `
            + `agrees on ${andList(agreed)} but not on ${andList(r.cmp.differ.map(d => d.label))}. `
            + 'Either part of their scope is billed under a line that does not carry their name, or '
            + 'the schedule and their application describe different work.',
        });
      }
      return out.length ? out : skip('No subcontractor application carried enough figures to roll up.');
    },
  },

  {
    id: 'V2',
    title: "Lines billed under a subcontractor's name that their application does not cover",
    severity: SEVERITY.MATERIAL,
    run(app, rolls) {
      const out = [];
      for (const r of rolls) {
        if (r.outcome !== 'reconciled') continue;      // only meaningful once the set is certain
        for (const l of r.leftover) {
          if (!num(l.thisPeriod)) continue;
          out.push({
            status: 'FAIL',
            severity: SEVERITY.MATERIAL,
            where: { vendor: r.vendor.vendor, itemNo: l.itemNo ?? l.code, description: l.description },
            actual: l.thisPeriod,
            detail: `${l.description} bills ${money(l.thisPeriod)} this period under `
              + `${r.vendor.vendor}'s name, but it is outside the scope their own application `
              + `covers — their figures reconcile exactly to ${spread(r)} without it. `
              + 'Either this line belongs to someone else, or there is a second contract with them '
              + 'that was not submitted.',
          });
        }
      }
      return out.length ? out : { status: 'PASS', detail: 'Every line naming a subcontractor falls '
        + 'inside the scope that subcontractor billed for.' };
    },
  },

  {
    id: 'V3',
    title: "The subcontractor's own scope groups each land on a schedule line",
    severity: SEVERITY.NOTE,
    run(app, rolls) {
      const withGroups = rolls.filter(r => (r.vendor.groups || []).length && r.lines.length);
      if (!withGroups.length) {
        return skip('No subcontractor application separated its rows into scope groups, so their '
          + 'totals were checked as a whole rather than piece by piece.');
      }
      const out = [];
      for (const r of withGroups) {
        for (const g of r.vendor.groups) {
          if (!isNum(g.scheduledValue)) continue;
          const hit = r.lines.find(l => Math.abs(num(l.scheduledValue) - g.scheduledValue) <= EXACT);
          if (hit) continue;
          out.push({
            status: 'FAIL',
            severity: SEVERITY.NOTE,
            where: { vendor: r.vendor.vendor, ref: g.code || g.description },
            actual: g.scheduledValue,
            detail: `${r.vendor.vendor}'s application separates ${money(g.scheduledValue)} of scope `
              + `as ${g.description || g.code}, and no single schedule line carries that amount. `
              + 'Their total still ties, so nothing is missing — but the owner\'s schedule and '
              + 'their contract are divided differently, which is worth knowing before a change '
              + 'order has to be priced against one of them.',
          });
        }
      }
      return out.length ? out : { status: 'PASS', detail: 'Each scope group on a subcontractor\'s '
        + 'application corresponds to a line on the schedule.' };
    },
  },

  {
    id: 'V4',
    title: 'What the vendor rollup covered',
    severity: SEVERITY.NOTE,
    run(app, rolls) {
      const done = rolls.filter(r => r.outcome === 'reconciled');
      const untied = rolls.filter(r => ['no-lines', 'ambiguous', 'too-few-columns', 'no-figures'].includes(r.outcome));
      const trimmed = rolls.filter(r => r.truncated);
      const parts = [
        `${rolls.length} subcontractor application(s) were rolled up against the schedule, and `
        + `${done.length} tied to it exactly.`,
        untied.length ? `${untied.length} could NOT be tied to any definite set of lines `
          + `(${andList(untied.map(r => r.vendor.vendor))}), so nothing above says anything about `
          + 'their money either way.' : null,
        trimmed.length ? `For ${andList(trimmed.map(r => r.vendor.vendor))} the name matched more `
          + `lines than could be searched, so only the ${MAX_POOL} largest were considered.` : null,
      ].filter(Boolean);
      return skip(parts.join(' '));
    },
  },
];

function runVendorRollupChecks(app) {
  const results = [];
  const rolls = (app.vendors || []).map(v => rollUp(app, v));

  for (const chk of VENDOR_CHECKS) {
    let produced;
    try {
      produced = chk.run(app, rolls);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r =>
      results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r }));
  }

  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  return {
    results,
    findings,
    rolls,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      vendors: rolls.length,
      vendorsReconciled: rolls.filter(r => r.outcome === 'reconciled').length,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
  };
}

// One row per subcontractor: their own totals beside the schedule lines carrying their scope, and
// how many columns agree. The findings say what is wrong; this says what was compared, which is
// how a reader satisfies themselves that a vendor is quiet because they tie.
const STATUS = {
  reconciled: 'ties exactly',
  differs: 'differs',
  partial: 'partly ties',
  unmatched: 'not tied',
  ambiguous: 'cannot be placed',
  'too-few-columns': 'too few figures',
  'no-lines': 'no line names them',
  'no-figures': 'no totals on their application',
};

function vendorRollupTable(rolls) {
  const rows = (rolls || []).map(r => ({
    vendor: r.vendor.vendor,
    note: [r.vendor.applicationNumber ? `app ${r.vendor.applicationNumber}` : null,
      r.vendor.commitment, r.vendor.contractFor].filter(Boolean).join(' · '),
    lines: nameList(r.lines || []),
    theyBilled: isNum(r.vendor.thisPeriod) ? r.vendor.thisPeriod : null,
    onSchedule: r.lines?.length && r.lines.every(l => isNum(l.thisPeriod))
      ? sum(r.lines, l => l.thisPeriod) : null,
    columnsMatched: r.cmp ? r.cmp.matched.length : 0,
    columnsCompared: r.cmp ? r.cmp.comparable : 0,
    status: STATUS[r.outcome] || r.outcome,
  }));
  return rows.length ? rows : null;
}

module.exports = {
  VENDOR_CHECKS, runVendorRollupChecks, vendorRollupTable, rollUp,
  vendorTokens, vendorAcronym, namesVendor, bestSubset, compare, COLUMNS,
};
