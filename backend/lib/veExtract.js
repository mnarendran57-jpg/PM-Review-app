const { analyzeInPasses, partNotice, mergeExtracted } = require('./pdfChunk');
const { readTextPages, readTextRows } = require('./pdfTextLayer');
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
    // No unitCost. It was transcribed on every row and read by nothing — a field costs output
    // tokens on every one of several hundred rows, which is the one place this module spends real
    // money. Anything added back here has to earn its place downstream first.
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

// ---------------------------------------------------------------------------------------------
// The shortlist path: rank in code, classify only what could matter.
//
// Transcribing every row to use twenty of them was two thirds of what a review cost. The obvious
// fix — ask the model for the biggest rows and skip the rest — was measured and does not work: over
// a 106-row estimate it missed five to eight of the true top twenty on every attempt, and the same
// $424,000 row all three times. Models are excellent at reading a row and poor at ranking a hundred
// of them.
//
// So the ranking stays in code, and what moves is where the rows come from. pdfjs gives every text
// item its position, so the rows can be rebuilt locally and the last money column read off each
// one — measured on the same estimate: 106 of 106 rows recovered, none missed, in 169ms and for
// nothing. Only the shortlist is then sent to be classified and cleaned up.
//
// The local read decides the SHORTLIST; the model decides the AMOUNTS and what each row is. A local
// misparse can therefore cost a place on the shortlist but can never put a wrong number in a report,
// and the shortlist is over-fetched precisely so a few misparses do not matter.

// Comma-grouped or decimal money, with the decimals optional — estimates print both "186,000" and
// "186,000.00". The LAST one on a row is its extended amount in any columnar layout.
const MONEY = /(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})(?![\d.])/g;

// Subtotals crowd the top of any ranking by amount — on the measured estimate, 27 of the 60 biggest
// figures were totals or markup. The shortlist is over-fetched so that filtering them out still
// leaves more than enough real work rows.
const CANDIDATE_MULTIPLE = 3;
const MIN_CANDIDATES = 40;
// Small enough that the classifying passes run side by side and the stage costs one pass, not all.
const ROWS_PER_CLASSIFY_PASS = 20;
// Below this there is nothing worth shortlisting and the old full-transcription path is cheaper.
const MIN_PRICED_ROWS = 8;

function pricedRows(pages) {
  const out = [];
  for (const page of pages) {
    for (const text of page.rows || []) {
      const found = String(text).match(MONEY);
      if (!found) continue;
      const amount = parseFloat(found[found.length - 1].replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      out.push({ page: page.page, text: String(text).trim(), amount });
    }
  }
  return out;
}

function shortlist(rows, limit) {
  const want = Math.max(MIN_CANDIDATES, limit * CANDIDATE_MULTIPLE);
  return [...rows].sort((a, b) => b.amount - a.amount).slice(0, want);
}

const CLASSIFY_TOOL = {
  name: 'classify_estimate_rows',
  description: 'Say what each row of a construction cost estimate is, and read its figures.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'One entry for every numbered row you were given, in the same order. Never '
          + 'skip one — a missing entry silently drops an item from the review.',
        items: {
          type: 'object',
          properties: {
            ref: {
              type: 'integer',
              description: 'The number printed in brackets at the start of the row. Copy it exactly; '
                + 'it is how the answer is matched back.',
            },
            description: {
              type: 'string',
              description: 'What the row is for, with the quantity, rate and amount columns stripped '
                + 'off. Keep the wording — it is what says which product was priced — and do not '
                + 'tidy it up or shorten it. Where the row text was cut off mid-word by the page '
                + 'layout, leave it as it is rather than inventing the ending.',
            },
            quantity: { type: 'number', description: 'The quantity column, as a plain number.' },
            unit: { type: 'string', description: 'The unit — SF, LF, EA, CY, LS, LB, HR.' },
            amount: {
              type: 'number',
              description: 'The extended amount for the row, as a plain number. Take it from the '
                + 'row\'s own total column. Everything downstream ranks on this, so it is the one '
                + 'field that must be exactly right.',
            },
            priceBasis: LINE.properties.priceBasis,
            rowKind: LINE.properties.rowKind,
          },
          required: ['ref', 'description', 'amount', 'rowKind'],
        },
      },
    },
    required: ['rows'],
  },
};

const CLASSIFY_SYSTEM = `You are reading rows lifted out of a construction cost estimate.

Each row arrives as raw text with its columns still in it, numbered in brackets. Give back one entry
per row: what it is for, its figures, and — the part that matters most — what KIND of row it is.

A subtotal is not an item of work. Estimates print division subtotals, a subtotal of all trades, and
a grand total, and those carry the biggest numbers on the page. The same goes for general conditions,
overhead and profit, bond, and contingency. Labelling one of those as work would hand a value
engineering review a number that is only the sum of other numbers.

An estimate bound inside a proposal also prints money that is NOT the price being asked for: add and
deduct alternates, unit prices for work that may never happen, allowances. Those rows say so in the
heading above them, and the heading rows are among those you were given.

A figure in parentheses is NEGATIVE. Estimates write a deduct as "(42,000.00)" under an
"ADD / (DEDUCT)" heading, and read as positive it becomes money added to a price it should be taken
off — the opposite of what the document says.

Copy the figures. Do not correct the estimate's arithmetic and do not compute anything it does not
print.`;

const CONTEXT_TOOL = {
  name: 'record_estimate_context',
  description: 'Read the header, the conditions and the alternates off a construction cost estimate.',
  input_schema: {
    type: 'object',
    properties: {
      estimateTitle: EXTRACT_TOOL.input_schema.properties.estimateTitle,
      contractor: EXTRACT_TOOL.input_schema.properties.contractor,
      estimateDate: EXTRACT_TOOL.input_schema.properties.estimateDate,
      projectLocation: EXTRACT_TOOL.input_schema.properties.projectLocation,
      estimateTotal: EXTRACT_TOOL.input_schema.properties.estimateTotal,
      tradeSubtotal: {
        type: 'number',
        description: 'The subtotal of all trade work BEFORE general conditions, overhead, profit, '
          + 'bond and contingency, if the estimate prints one. Not the grand total, and never added '
          + 'up by you — only from a row that plainly says so.',
      },
      alternates: {
        type: 'array',
        description: 'Add and deduct alternates: work the document prices but says is NOT included '
          + 'in the base amount. Empty on an estimate with no alternates section, which is most. '
          + 'A deduct is a NEGATIVE amount.',
        items: {
          type: 'object',
          properties: {
            itemNumber: { type: 'string', description: 'Its label as printed — "Alternate No. 3".' },
            description: { type: 'string', description: 'What it is, as printed.' },
            amount: { type: 'number', description: 'Negative for a deduct, positive for an add.' },
          },
          required: ['description'],
        },
      },
      scopeNotes: EXTRACT_TOOL.input_schema.properties.scopeNotes,
      exclusions: EXTRACT_TOOL.input_schema.properties.exclusions,
      assumptions: EXTRACT_TOOL.input_schema.properties.assumptions,
    },
  },
};

const CONTEXT_SYSTEM = `You read the parts of a construction cost estimate that are not the priced
rows: who issued it, what it is for, where the building is, and the conditions attached to the price.

Most estimates are just a priced breakdown and have none of the conditions. Return nothing for those
rather than inventing them. Where the estimate is bound inside a proposal there will be a written
scope, a list of exclusions and assumptions, and a page of alternates, and those are what decide
whether a substitution is possible at all.

Copy what the document says. Never add up figures it does not print.`;

async function readContext(text) {
  const { data } = await askForJson({
    content: [{ type: 'text', text: `Read this cost estimate.\n\n${text}` }],
    system: CONTEXT_SYSTEM,
    tool: CONTEXT_TOOL,
    cacheTool: true,
    fast: true,
    maxTokens: 4000,
    label: 've context',
  });
  return data;
}

async function classifyGroup(rows) {
  const body = rows.map(r => `[${r.ref}] ${r.text}`).join('\n');
  const { data } = await askForJson({
    content: [{ type: 'text', text: `Rows from a cost estimate:\n\n${body}` }],
    system: CLASSIFY_SYSTEM,
    tool: CLASSIFY_TOOL,
    cacheTool: true,
    fast: true,
    maxTokens: 8000,
    label: 've classify',
  });
  return asArray(data.rows);
}

// A row with no basis recorded is part of the price being asked for. That default matters: a bare
// estimate has no alternates section at all, and every one of its rows would otherwise arrive
// unlabelled and be thrown away.
const basisOf = line => line.priceBasis || 'base';

// Belt and braces over the same guard in lib/aiJson.js. A stored record read back from the database
// predates that fix and can still hold the string "null" where a list belongs, and this module must
// open an old analysis rather than throw on it.
const asArray = value => (Array.isArray(value) ? value : []);

const indexed = extracted => asArray(extracted.lines).map((line, index) => ({ ...line, index }));
const named = line => (line.description || '').trim();

// Rows that are actually items of work in the price being asked for, in estimate order, each
// carrying the index it had in the full transcription so a finding can always be pointed back at
// the row it came from.
//
// The priceBasis filter is what makes this safe on a proposal. Measured on a three-page proposal
// fixture before it existed: all four add/deduct alternates were read as work, one of them was
// selected for value engineering, and $144,600 of money the owner was never asked for landed in the
// denominator of the coverage figure printed on their report.
// A deterministic backstop on the one rule this module exists to enforce.
//
// The schema tells the model in as many words that general conditions, overhead, profit, bond and
// contingency are markup rather than work. On a real customer budget it labelled "General
// Conditions — $50,000" as work anyway, and it went through to the review as the third largest item
// on the job: an alternative to a markup line is a meaningless suggestion, and the owner reads it
// next to real ones.
//
// So the wording is checked in code as well. The patterns are deliberately narrow — anchored, or
// paired with a second word — because the cost of over-matching is silently dropping a real item.
// "Overhead coiling service doors" is a genuine line item and must survive, which is why bare
// "overhead" only counts at the start of a description.
const MARKUP_WORDING = [
  /\bsub-?total\b/i,
  // "TOTAL ESTIMATE", "Total:", "Total 1,101,112", "Total" alone — but never "Total station survey
  // equipment", which is a real item and was dropped by an anchor that stopped at the word itself.
  /^\s*(grand\s+)?total\b\s*(estimate|proposal|contract|bid|cost|price|amount|due|of\b|[:$\d]|$)/i,
  /\btotal\s+(estimate|proposal|contract|bid|of\s+all\s+trades)\b/i,
  /\bgeneral\s+(conditions|requirements)\b/i,
  /\boverhead\s*(and|&|\/)\s*profit\b/i,
  // "Overhead @ 10%", "Overhead 11%", "Overhead" alone — but never "Overhead coiling service doors"
  // or "Overhead crane rail", which are line items in their own right.
  /^\s*overhead\s*(@|\d|%|and\b|&|\/|:|$)/i,
  /\bprofit\b/i,
  /\bcontingency\b/i,
  /\bescalation\b/i,
  /\bsales\s+tax\b/i,
  /\b(payment|performance|p\s*&\s*p)\s+bonds?\b/i,
  /\bbuilder'?s\s+risk\b/i,
  /\b(gc|cm|contractor'?s|construction\s+manager'?s)\s+fee\b/i,
];

const looksLikeMarkup = description => MARKUP_WORDING.some(re => re.test(String(description || '')));

function workLines(extracted) {
  return indexed(extracted).filter(line => (
    line.rowKind === 'work'
    && basisOf(line) === 'base'
    && named(line)
    && !looksLikeMarkup(line.description)
  ));
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
// The number is put back on the front where the reading separated it out. An owner asks their
// contractor about "Alternate No. 3", not about "substitute epoxy terrazzo", and a report that drops
// the number makes them go back to the proposal to find it.
const labelled = item => (item.itemNumber && !String(item.description).includes(item.itemNumber)
  ? `${item.itemNumber} — ${item.description}`
  : item.description);

function proposalContext(extracted) {
  // Two sources, because the two reading paths find alternates differently. The full transcription
  // labels them row by row; the shortlist path reads them off the whole document in the context
  // pass — which it must, since a deduct alternate is routinely far too small to rank into the
  // biggest rows and would otherwise be lost entirely.
  const fromRows = alternateLines(extracted);
  const fromContext = asArray(extracted.alternateItems).filter(a => a && a.description);

  // The two passes describe the same alternate slightly differently — one writes "Alternate No. 1 —
  // Upgrade lobby lighting", the other "Alternate No. 1 - Upgrade lobby lighting" — so matching on
  // the text as written listed every one of them twice. The key ignores punctuation and spacing
  // entirely, and pairs the wording with the amount so two genuinely different alternates that read
  // alike are still kept apart.
  // Deliberately NOT keyed on the amount. The two passes can disagree about the SIGN of the same
  // alternate — a deduct printed as "(42,000.00)" reads as negative to the pass that saw the ADD /
  // (DEDUCT) column and as positive to the one that saw the row alone — and keying on the amount
  // let both through, so the owner was shown the same alternate twice, once as money off and once
  // as money added. The context pass is listed first and wins, because it read the section.
  const dedupKey = item => String(labelled(item)).toLowerCase().replace(/[^a-z0-9]+/g, '');

  const alternates = [];
  const seen = new Set();
  // Context first: it reads the alternates section as a section and gets the item numbers cleanly,
  // where the row pass only sees whichever ones happened to rank into the shortlist.
  for (const item of [...fromContext, ...fromRows]) {
    const description = labelled(item);
    const key = dedupKey(item);
    if (!String(description).trim() || seen.has(key)) continue;
    seen.add(key);
    alternates.push({
      description,
      amount: typeof item.amount === 'number' ? item.amount : null,
    });
  }

  return {
    alternates,
    exclusions: asArray(extracted.exclusions).filter(Boolean),
    assumptions: asArray(extracted.assumptions).filter(Boolean),
    scopeNotes: asArray(extracted.scopeNotes).filter(n => n && n.system && n.detail),
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
//
// Measured on a 106-row, $18.6M estimate: forty rows reached 75% of the trade value and produced
// seventy-six alternatives, which is not a shortlist. Twenty rows reach 53% and produce about
// thirty-eight, at half the cost and half the wait. The cap only binds on large flat estimates —
// on an ordinary one the coverage rule stops well before it.
const MAX_LINES = 20;

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

  // What the whole job is worth, which is not the same as what the rows in hand add up to.
  //
  // On the shortlist path only the biggest sixty rows were classified, so summing them would give a
  // denominator far smaller than the real trade value — the coverage rule would then stop early
  // believing it had covered most of the estimate when it had covered most of the shortlist. The
  // estimate's own printed trade subtotal is used where it has one; measured exact on every attempt.
  const summed = priced.reduce((n, line) => n + line.amount, 0);
  const printed = extracted.tradeSubtotal;
  const totalWorkValue = typeof printed === 'number' && printed >= summed ? printed : summed;

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

// Reading the estimate as TEXT rather than as a document.
//
// A PDF sent to the model is billed by the page: every page is rasterised to an image and read
// alongside its text, which came to about 2,000 input tokens a page. The same pages pulled out
// locally with pdfjs are about 150 tokens a page and cost nothing at all. Measured on a 22-page
// estimate: 44,008 paid input tokens as a document, 3,400 as text, extracted in a quarter of a
// second. Nothing is lost, because a cost estimate is a table of words and numbers — there is no
// drawing to look at, which is exactly what the image was being paid for.
//
// A scan has no text layer, so it still goes the old way. That path is slower and dearer, and it is
// also the only thing that works on a photocopy — so it stays, it just stops being the default.

// Below this many characters a page, the "text" is page furniture and the document is a scan.
const MIN_CHARS_PER_PAGE = 120;

// A text layer can be present, plentiful, and still meaningless.
//
// A PDF embeds its fonts as subsets and is supposed to ship a ToUnicode map saying which character
// each glyph stands for. Plenty of tools do not, or write a broken one, and then pdfjs can only hand
// back the raw glyph codes — arbitrary letters and punctuation, one per character, in the right
// places. It looks like text. It counts like text. A real customer estimate read this way came out
// as "3 4 5 6 3 7 8 8 3 9 : ; ; 3" for two thousand characters a page, which sails past any check
// that only asks whether characters are present.
//
// Sending that to be read produces confident nonsense about a document nobody can see, so it is
// caught here and the pages themselves are sent instead — dearer, slower, and correct.
//
// The tell is words. Construction estimates are terse, but "Walnut veneer wall panel system" is
// still four runs of letters; glyph soup is overwhelmingly single characters separated by spaces.
const MIN_WORD_RATIO = 0.15;
const MIN_LETTERS = 100;

function looksLegible(text) {
  const body = String(text || '');
  if ((body.match(/[A-Za-z]/g) || []).length < MIN_LETTERS) return false;
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const words = tokens.filter(t => /^[A-Za-z][A-Za-z'’-]{2,}$/.test(t)).length;
  return words / tokens.length >= MIN_WORD_RATIO;
}

// The single gate both text paths go through: enough text, and text that means something. Kept as
// one function so there is one thing to test — the check used to live inline in two places, and a
// mutation removing it from either went unnoticed.
const usableText = (text, pageCount) => (
  pageCount > 0
  && String(text || '').length / pageCount >= MIN_CHARS_PER_PAGE
  && looksLegible(text)
);

// How many pages of text ride in one request. Input is nearly free now, so this is chosen purely
// for wall-clock: what makes a pass slow is the model WRITING the rows, at roughly a hundred tokens
// a second, and small passes run at the same time.
const PAGES_PER_TEXT_PASS = 4;

// Enough of them at once that an ordinary estimate is one wave.
const TEXT_CONCURRENCY = 8;

// The same test as readableTextPages, but keeping the rows: a scan has no text to rebuild rows from,
// and a document whose "text" is page furniture has nothing worth ranking.
async function readableTextRows(buffer) {
  let pages;
  try {
    pages = await readTextRows(buffer);
  } catch {
    return null;
  }
  if (!pages || !pages.length) return null;
  const text = pages.map(p => (p.rows || []).join('\n')).join('\n');
  // Plentiful characters are not the same as readable ones — see looksLegible.
  return usableText(text, pages.length) ? pages : null;
}

async function readableTextPages(buffer) {
  let pages;
  try {
    pages = await readTextPages(buffer);
  } catch {
    return null;              // a malformed or encrypted PDF falls back to the document path
  }
  if (!pages || !pages.length) return null;
  const text = pages.map(p => String(p.text || '')).join('\n');
  return usableText(text, pages.length) ? pages : null;
}

async function inParallel(items, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  };
  // Order is preserved because each worker writes to its own slot: mergeExtracted concatenates
  // line items, and a continuation page read out of order comes back with its rows shuffled.
  await Promise.all(Array.from({ length: Math.min(TEXT_CONCURRENCY, items.length) }, worker));
  return out;
}

async function readEstimateText(pages, context) {
  const body = pages
    .map(p => `--- page ${p.page} ---\n${String(p.text || '').trim()}`)
    .join('\n\n');
  const { data } = await askForJson({
    content: [{ type: 'text', text: `Transcribe this cost estimate.${partNotice(context)}\n\n${body}` }],
    system: EXTRACT_SYSTEM,
    tool: EXTRACT_TOOL,
    cacheTool: true,
    fast: true,
    maxTokens: 16000,
    label: 've extract',
    truncatedMessage: 'This estimate has more rows than one reading could hold. It is being read '
      + 'in smaller sections — nothing was lost.',
  });
  return data;
}

// Reads an estimate into the shape the rest of the module expects: `lines`, plus whatever the pages
// around the numbers said. Three paths, in order of what the document allows.
async function extractEstimate(buffer, { limit = MAX_LINES } = {}) {
  const rowPages = await readableTextRows(buffer);

  if (rowPages) {
    const priced = pricedRows(rowPages);

    if (priced.length >= MIN_PRICED_ROWS) {
      const text = rowPages.map(p => `--- page ${p.page} ---\n${(p.rows || []).join('\n')}`).join('\n\n');
      const candidates = shortlist(priced, limit).map((row, i) => ({ ...row, ref: i }));

      const groups = [];
      for (let i = 0; i < candidates.length; i += ROWS_PER_CLASSIFY_PASS) {
        groups.push(candidates.slice(i, i + ROWS_PER_CLASSIFY_PASS));
      }

      // The context read and every classifying pass are independent, so they all go at once and the
      // stage costs what its slowest single call costs.
      const [context, ...classified] = await inParallel(
        [() => readContext(text), ...groups.map(g => () => classifyGroup(g))],
        job => job(),
      );

      const byRef = new Map(classified.flat().map(row => [row.ref, row]));
      const lines = candidates
        .map((candidate) => {
          const read = byRef.get(candidate.ref);
          if (!read) return null;               // a row the model dropped is left out, never guessed at
          return {
            description: read.description,
            // The model's figure, not the local parse: the local read only chose the shortlist.
            amount: typeof read.amount === 'number' ? read.amount : candidate.amount,
            quantity: typeof read.quantity === 'number' ? read.quantity : null,
            unit: read.unit || null,
            section: null,
            itemNumber: null,
            rowKind: read.rowKind || 'work',
            priceBasis: read.priceBasis || 'base',
          };
        })
        .filter(Boolean);

      return {
        ...context,
        lines,
        // Alternates come from the context read rather than from the shortlist: a deduct alternate
        // is often far too small to rank into the top rows and would otherwise be lost.
        alternateItems: asArray(context.alternates),
        // What the document actually contains, as opposed to what was examined. The local read saw
        // every priced row, so this is exact even though only the shortlist was classified.
        pricedRowCount: priced.length,
        shortlisted: candidates.length,
      };
    }
  }

  // Too few priced rows to shortlist from, but the text itself reads: an unusual layout the money
  // pattern did not catch. Transcribe the whole thing from the text, which is still cheap.
  //
  // Reached only when the text is LEGIBLE — readableTextPages applies the same test. A document
  // whose fonts carry no character map falls past both and goes to the pages themselves, because
  // reading glyph soup produces confident nonsense about a document nobody can see.
  const pages = await readableTextPages(buffer);
  if (pages) {
    const groups = [];
    for (let i = 0; i < pages.length; i += PAGES_PER_TEXT_PASS) {
      groups.push(pages.slice(i, i + PAGES_PER_TEXT_PASS));
    }
    const results = await inParallel(groups, (group, i) => readEstimateText(group, {
      isPart: groups.length > 1,
      partNumber: i + 1,
      partCount: groups.length,
      startPage: group[0].page,
      endPage: group[group.length - 1].page,
    }));
    return mergeExtracted(results) || { lines: [] };
  }

  const extracted = await analyzeInPasses(buffer, readEstimatePages);
  return extracted || { lines: [] };
}

module.exports = {
  extractEstimate, workLines, selectLines, pricedRows, shortlist, looksLegible, usableText,
  alternateLines, proposalContext, hasProposalContext, basisOf,
  COVERAGE_TARGET, MIN_SHARE, MIN_LINES, MAX_LINES,
  EXTRACT_TOOL, EXTRACT_SYSTEM, readEstimatePages,
};
