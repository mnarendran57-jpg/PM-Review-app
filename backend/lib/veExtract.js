const { analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Reading a cost estimate into line items.
//
// This is transcription and nothing else — copy the rows out of the estimate — so it goes to the
// fast model, the same division of labour the rest of the app uses. Deciding what could be built
// a different way is judgement and happens in veOptions.js on the careful model.
//
// Two things about estimates make this less obvious than a pay application's schedule of values:
//
//   SUBTOTAL ROWS. An estimate is full of them — division subtotals, a subtotal before overhead,
//   the grand total. They look exactly like line items and they carry the biggest numbers on the
//   page, so ranking by amount without excluding them would hand the whole analysis to "Division
//   09 — Finishes, $840,000" and never reach the wood panel inside it. They are flagged here and
//   filtered before anything is ranked.
//
//   MARKUP ROWS. Overhead, profit, general conditions, bond, contingency, escalation. These are
//   real money and they are also not something anyone value-engineers by choosing a different
//   product. Flagged for the same reason and kept out of the ranking.

const LINE = {
  type: 'object',
  properties: {
    section: {
      type: 'string',
      description: 'The heading this row sits under — a CSI division, a trade, or a system name, '
        + 'exactly as the estimate writes it. Null if the estimate has no headings.',
    },
    itemNumber: {
      type: 'string',
      description: 'The row\'s own number or code, if it has one — "03-140", "Alternate No. 3". '
        + 'Keep the label exactly as printed: an alternate is referred to by its number in every '
        + 'conversation the owner will have about it.',
    },
    description: {
      type: 'string',
      description: 'What the row is for, copied from the estimate. Do not shorten it and do not '
        + 'tidy it up — the wording is what says which product was priced.',
    },
    quantity: { type: 'number', description: 'The quantity, as a plain number with no unit.' },
    unit: { type: 'string', description: 'The unit the quantity is in — SF, LF, EA, CY, LS, HR.' },
    unitCost: { type: 'number', description: 'Cost per unit, if the estimate shows one.' },
    amount: {
      type: 'number',
      description: 'The extended amount for this row in dollars, as a plain number: 12500.00, '
        + 'not "$12,500". This is the figure everything downstream ranks on, so take it from the '
        + 'row\'s own total column rather than recomputing it.',
    },
    priceBasis: {
      type: 'string',
      enum: ['base', 'alternate', 'unit_price', 'allowance'],
      description: 'Which pot of money this row belongs to, which is a different question from what '
        + 'kind of row it is. '
        + '"base" — part of the price being asked for. Assume this unless the document says '
        + 'otherwise. '
        + '"alternate" — an add alternate, a deduct alternate, an option, or anything under a '
        + 'heading saying it is NOT included in the base amount. These are prices the owner has '
        + 'not been asked for. '
        + '"unit_price" — a rate for pricing work that may or may not happen, usually under a "unit '
        + 'prices" heading and usually with no extended amount. '
        + '"allowance" — a round sum carried for work that has not been designed or selected yet. '
        + 'Label it "allowance" EVEN WHEN the document says it is included in the base amount, '
        + 'which it usually is. The distinction being drawn here is not whether the owner is paying '
        + 'for it — they are — but whether there is a specified product behind it. An allowance is '
        + 'a placeholder with no product chosen, so there is nothing to compare it against. '
        + 'Read the heading a row sits under. A proposal states plainly which sections are outside '
        + 'the base price, and getting this wrong means the owner is shown money nobody is asking '
        + 'them for.',
    },
    rowKind: {
      type: 'string',
      enum: ['work', 'subtotal', 'markup'],
      description: 'What kind of row this is, and the most important field here. '
        + '"work" — an actual item of work, material, or equipment being priced. '
        + '"subtotal" — a division subtotal, a section total, a carried-forward figure, or the '
        + 'grand total. Any row whose amount is the sum of other rows above it. '
        + '"markup" — overhead, profit, general conditions, insurance, bond, permit, fee, '
        + 'contingency, allowance, escalation, sales tax, or a percentage applied to a subtotal. '
        + 'When a row could be read either way, say "subtotal" or "markup" rather than "work": a '
        + 'total mistaken for an item of work distorts everything that follows.',
    },
  },
  required: ['description', 'rowKind'],
};

const EXTRACT_TOOL = {
  name: 'record_cost_estimate',
  description: 'Transcribe a construction cost estimate into its individual line items.',
  input_schema: {
    type: 'object',
    properties: {
      estimateTitle: { type: 'string', description: 'The project or estimate name printed on it.' },
      contractor: { type: 'string', description: 'The company that issued the estimate.' },
      estimateDate: { type: 'string', description: 'The date on the estimate, as printed.' },
      projectLocation: {
        type: 'string',
        description: 'Where the project is — the city and state, or the site address, if the '
          + 'estimate prints one anywhere. Null if it does not say. Never guess from the company '
          + 'letterhead: the contractor\'s office is often not where the building is.',
      },
      estimateTotal: {
        type: 'number',
        description: 'The grand total the estimate arrives at, as a plain number. Only from a row '
          + 'that plainly says so — do not add the rows up yourself.',
      },
      currency: { type: 'string', description: 'The currency, if the estimate states one other than US dollars.' },
      lines: { type: 'array', description: 'Every row on these pages, in the order printed.', items: LINE },

      // A cost estimate often arrives bound into a proposal, and the pages around the numbers carry
      // most of what makes a substitution sensible or impossible. Captured here as prose rather than
      // as rows, because it is not money — it is the conditions attached to the money.
      scopeNotes: {
        type: 'array',
        description: 'What the written scope says about each part of the work, where the document '
          + 'has a narrative as well as a priced breakdown. This is where the detail lives — a '
          + 'breakdown row says "wall panel system" while the narrative says which timber, which '
          + 'substrate, which finish and which fire rating. Empty where there is no narrative.',
        items: {
          type: 'object',
          properties: {
            system: { type: 'string', description: 'What it is about — "wall finishes", "flooring", "glazing".' },
            detail: {
              type: 'string',
              description: 'What the document says about it, closely paraphrased and keeping every '
                + 'material, standard, rating and finish it names.',
            },
          },
          required: ['system', 'detail'],
        },
      },
      exclusions: {
        type: 'array',
        description: 'Work the document says is NOT included — exclusions, clarifications, things '
          + 'by others or by the owner. One entry per item, in the document\'s own words.',
        items: { type: 'string' },
      },
      assumptions: {
        type: 'array',
        description: 'Conditions the price depends on — what the contractor has assumed about the '
          + 'existing building, the schedule, or who does what. Often printed alongside the '
          + 'exclusions. These decide whether a substitution is even possible, so keep the '
          + 'specifics: "assumes the existing slab is level within a quarter inch in ten feet".',
        items: { type: 'string' },
      },
    },
    required: ['lines'],
  },
};

const EXTRACT_SYSTEM = `You transcribe construction cost estimates.

Copy what is on the page. Do not price anything, do not judge anything, and do not correct the
estimate's arithmetic — a row that does not multiply out is transcribed exactly as printed, because
somebody downstream needs to see that.

Every row on the page gets an entry, including subtotals and markup rows. Do not silently drop them:
they are labelled by rowKind and filtered later, and a subtotal that arrives labelled as work will be
mistaken for the largest item of work on the job.

An estimate is often bound inside a proposal, and a proposal prints money that is NOT the price being
asked for: add and deduct alternates, unit prices for work that may never happen, allowances. Those
sections say so in their own headings — "not included in the base proposal", "for use in pricing
added or deleted work". Read the heading each row sits under and label the row's priceBasis from it.
A deduct alternate mislabelled as base work becomes an item somebody tries to re-engineer, and the
owner is shown a saving against money nobody asked them for.

Where the document has a written scope as well as a priced breakdown, capture the narrative too. The
breakdown row is the price; the narrative is what was actually specified, and it is usually the only
place the material, the finish and the fire rating appear.

Where a row spans two printed lines, join it into one entry. Where an estimate prints the same
description twice for genuinely separate quantities, keep both.`;

// One pass over a slice of the estimate. Long documents are split by pdfChunk and merged, so a
// three-hundred-line estimate reads the same way a one-page one does.
async function readEstimatePages(buffer, context) {
  const { data } = await askForJson({
    content: [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
      },
      { type: 'text', text: `Transcribe this cost estimate.${partNotice(context)}` },
    ],
    system: EXTRACT_SYSTEM,
    tool: EXTRACT_TOOL,
    // The schema and the rules are the same on every pass and on every estimate, so they are the
    // part worth caching. See lib/aiJson.js for why the breakpoint lands on the system block.
    cacheTool: true,
    fast: true,
    maxTokens: 16000,
    label: 've extract',
    truncatedMessage: 'This estimate has more rows than one reading could hold. It is being read '
      + 'in smaller sections — nothing was lost.',
  });
  return data;
}

// A row with no basis recorded is part of the price being asked for. That default matters: a bare
// estimate has no alternates section at all, and every one of its rows would otherwise arrive
// unlabelled and be thrown away.
const basisOf = line => line.priceBasis || 'base';

const indexed = extracted => (extracted.lines || []).map((line, index) => ({ ...line, index }));
const named = line => (line.description || '').trim();

// Rows that are actually items of work in the price being asked for, in estimate order, each
// carrying the index it had in the full transcription so a finding can always be pointed back at
// the row it came from.
//
// The priceBasis filter is what makes this safe on a proposal. Measured on a three-page proposal
// fixture before it existed: all four add/deduct alternates were read as work, one of them was
// selected for value engineering, and $144,600 of money the owner was never asked for landed in the
// denominator of the coverage figure printed on their report.
function workLines(extracted) {
  return indexed(extracted)
    .filter(line => line.rowKind === 'work' && basisOf(line) === 'base' && named(line));
}

// What the contractor has already put on the table. Not something to re-engineer — something to
// hand the owner first, because an alternate the vendor has already priced is worth more than any
// suggestion this tool can make: it is a number they can act on today.
function alternateLines(extracted) {
  return indexed(extracted).filter(line => basisOf(line) === 'alternate' && named(line));
}

// The conditions attached to the price. Gathered in one place because they travel together into the
// options prompt: an alternative that the proposal has already excluded, or that breaks an
// assumption the price depends on, is not an alternative.
function proposalContext(extracted) {
  const alternates = alternateLines(extracted).map(line => ({
    // The number is put back on the front where the transcription separated it out. An owner asks
    // their contractor about "Alternate No. 3", not about "substitute epoxy terrazzo", and a report
    // that drops the number makes them go back to the proposal to find it.
    description: line.itemNumber && !line.description.includes(line.itemNumber)
      ? `${line.itemNumber} — ${line.description}`
      : line.description,
    amount: typeof line.amount === 'number' ? line.amount : null,
  }));
  return {
    alternates,
    exclusions: (extracted.exclusions || []).filter(Boolean),
    assumptions: (extracted.assumptions || []).filter(Boolean),
    scopeNotes: (extracted.scopeNotes || []).filter(n => n && n.system && n.detail),
  };
}

const hasProposalContext = ctx => !!(ctx && (ctx.alternates.length || ctx.exclusions.length
  || ctx.assumptions.length || ctx.scopeNotes.length));

// Which rows are worth an opinion. Decided here, from the estimate itself, rather than asked of the
// project manager — a PM who has to guess a number before they can use the tool is doing the tool's
// job for it, and they cannot know the answer before they have seen the estimate anyway.
//
// The rule is cost significance, which is how any estimator would sort this by hand. Sort the priced
// work rows biggest first and take them until they account for most of what the building costs.
// On a normal estimate that lands on a handful of rows, because construction cost is always
// lopsided: a few systems carry the budget and the long tail of small rows carries almost none of
// it. Re-engineering the long tail is effort nobody recovers.
//
// The two guards on either side matter as much as the rule:
//
//   MIN_SHARE   a row worth less than half a percent of the job is never worth a meeting, however
//               few rows it takes to reach the target.
//   MIN_LINES   an estimate priced as three lump sums would otherwise come back with one row
//               examined. A few more are always looked at, so the report has something to say.

// How much of the estimate's work value the selection sets out to cover.
const COVERAGE_TARGET = 0.8;
// Below this share of the work value, a row is noise however the arithmetic falls.
const MIN_SHARE = 0.005;
// Always look at least this widely, for lump-sum estimates where one row dominates.
const MIN_LINES = 5;
// A ceiling on how long the report gets, not on how big the estimate may be — the whole document is
// read either way. Past this many findings nobody reaches the end, and the two rows that mattered
// are buried by the thirty that did not.
const MAX_LINES = 40;

function selectLines(extracted) {
  const all = workLines(extracted);
  const priced = all
    .filter(line => typeof line.amount === 'number' && line.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  // An estimate that prints quantities and unit costs but no extended column is unusual and not
  // wrong. There is nothing to rank on, so everything is looked at up to the report ceiling —
  // far better than showing the PM an empty report with no explanation.
  if (priced.length === 0) {
    return { lines: all.slice(0, MAX_LINES), totalWorkValue: null, coverage: null, workLineCount: all.length };
  }

  const totalWorkValue = priced.reduce((n, line) => n + line.amount, 0);
  const significant = priced.filter(line => line.amount / totalWorkValue >= MIN_SHARE);
  // Every row being tiny means they are all tiny relative to each other, not that none matter.
  const pool = significant.length ? significant : priced;

  const lines = [];
  let running = 0;
  for (const line of pool) {
    if (lines.length >= MAX_LINES) break;
    if (lines.length >= MIN_LINES && running / totalWorkValue >= COVERAGE_TARGET) break;
    lines.push(line);
    running += line.amount;
  }

  return { lines, totalWorkValue, coverage: running / totalWorkValue, workLineCount: all.length };
}

async function extractEstimate(buffer) {
  const extracted = await analyzeInPasses(buffer, readEstimatePages);
  return extracted || { lines: [] };
}

module.exports = {
  extractEstimate, workLines, selectLines,
  alternateLines, proposalContext, hasProposalContext, basisOf,
  COVERAGE_TARGET, MIN_SHARE, MIN_LINES, MAX_LINES,
  EXTRACT_TOOL, EXTRACT_SYSTEM, readEstimatePages,
};
