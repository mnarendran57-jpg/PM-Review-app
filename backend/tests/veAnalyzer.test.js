// The VE Analyzer's decisions, without an API call.
//
// Three things here are load-bearing and none of them are obvious from reading the code:
//
//   1. Subtotal and markup rows must never be selected. They carry the biggest numbers on an
//      estimate, so a selection that includes them spends the whole analysis on "Division 09
//      Subtotal" and never reaches the wood panel inside it.
//   1b. Which rows ARE selected is decided from the estimate, with nothing asked of the project
//      manager. The rule has to hold on a lopsided estimate, an even one, and a 400-row one.
//   2. The owner's report must contain only what the project manager kept, and must never print a
//      dollar figure for an option — the whole design rests on there being no pricing feed behind
//      these numbers.
//   3. A cost band that straddles zero must not be reported as a saving.
//   4. When the upload is a PROPOSAL rather than a bare estimate, money that is not part of the
//      price being asked for — add and deduct alternates, unit prices, allowances — must stay out
//      of both the ranking and the coverage denominator, and the contractor's own priced offers
//      must be handed to the owner rather than re-invented as suggestions.
const assert = require('assert');
const {
  workLines, selectLines, alternateLines, proposalContext, hasProposalContext, pricedRows, shortlist, looksLegible, usableText,
  MAX_LINES, MIN_LINES,
} = require('../lib/veExtract');
const { buildVeReport, keptEntries, costBand } = require('../lib/veReport');
const { buildLinesText, optionId, OPTIONS_SYSTEM } = require('../lib/veOptions');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

// An estimate shaped the way real ones are: work rows, a division subtotal that is larger than any
// of them, and markup rows at the bottom.
const ESTIMATE = {
  estimateTitle: 'Spring Branch Lobby Renovation',
  contractor: 'Acme Construction',
  estimateTotal: 1_000_000,
  lines: [
    { section: 'Div 06 — Wood', description: 'Walnut veneer wall panel system', quantity: 2400, unit: 'SF', amount: 186_000, rowKind: 'work' },
    { section: 'Div 06 — Wood', description: 'Rough carpentry blocking', quantity: 1, unit: 'LS', amount: 14_500, rowKind: 'work' },
    { section: 'Div 06 — Wood', description: 'Division 06 Subtotal', amount: 200_500, rowKind: 'subtotal' },
    { section: 'Div 09 — Finishes', description: 'Terrazzo flooring', quantity: 3100, unit: 'SF', amount: 248_000, rowKind: 'work' },
    { section: 'Div 09 — Finishes', description: 'Acoustic ceiling tile', quantity: 3100, unit: 'SF', amount: 27_900, rowKind: 'work' },
    { description: 'Subtotal of all trades', amount: 476_400, rowKind: 'subtotal' },
    { description: 'General conditions', amount: 62_000, rowKind: 'markup' },
    { description: 'Overhead and profit @ 12%', amount: 64_608, rowKind: 'markup' },
    { description: '   ', amount: 500, rowKind: 'work' },
  ],
};

console.log('\nVE Analyzer — what gets analysed');

check('only real work rows survive', () => {
  const work = workLines(ESTIMATE);
  assert.strictEqual(work.length, 4, `expected 4 work rows, got ${work.length}`);
  assert.ok(!work.some(l => l.rowKind !== 'work'), 'a non-work row got through');
});

check('a blank description is not a line item', () => {
  assert.ok(!workLines(ESTIMATE).some(l => !l.description.trim()));
});

check('every row keeps the index it had in the full transcription', () => {
  // The join back to the estimate depends on this, and filtering is exactly where it would break.
  const work = workLines(ESTIMATE);
  assert.strictEqual(work[0].index, 0);
  assert.strictEqual(work[2].index, 3, 'index shifted when subtotals were filtered out');
  assert.strictEqual(ESTIMATE.lines[work[3].index].description, work[3].description);
});

check('the costliest work rows are picked, biggest first', () => {
  const { lines } = selectLines(ESTIMATE);
  assert.deepStrictEqual(lines.slice(0, 3).map(l => l.description), [
    'Terrazzo flooring',                 // 248,000
    'Walnut veneer wall panel system',   // 186,000
    'Acoustic ceiling tile',             //  27,900
  ]);
});

check('no subtotal is ever selected, however large', () => {
  // 476,400 and 200,500 are both bigger than every real work row on this estimate.
  const { lines } = selectLines(ESTIMATE);
  assert.ok(!lines.some(l => l.rowKind !== 'work'));
  assert.ok(!lines.some(l => /subtotal/i.test(l.description)));
});

check('markup rows are never selected either', () => {
  const { lines } = selectLines(ESTIMATE);
  assert.ok(!lines.some(l => /overhead|general conditions/i.test(l.description)),
    'a markup row was offered up for value engineering');
});

console.log('\nVE Analyzer — markup rows the model mislabelled as work');

check('a markup row labelled "work" by the model is still kept out', () => {
  // Found on a real customer budget: "General Conditions — $50,000" came back labelled work and
  // reached the review as the third largest item on the job. An alternative to a markup line is a
  // meaningless suggestion, printed next to real ones.
  const mislabelled = { lines: [
    { description: 'General Conditions', amount: 50_000, rowKind: 'work' },
    { description: 'Overhead and profit @ 11%', amount: 113_179, rowKind: 'work' },
    { description: 'Contingency', amount: 32_013, rowKind: 'work' },
    { description: 'Payment and performance bond', amount: 12_760, rowKind: 'work' },
    { description: 'Subtotal of all trades', amount: 881_160, rowKind: 'work' },
    { description: 'TOTAL ESTIMATE', amount: 1_101_112, rowKind: 'work' },
    { description: 'Sales tax', amount: 8_000, rowKind: 'work' },
    { description: 'Terrazzo flooring, poured in place', amount: 248_000, rowKind: 'work' },
  ] };
  const work = workLines(mislabelled);
  assert.deepStrictEqual(work.map(l => l.description), ['Terrazzo flooring, poured in place'],
    `let through: ${work.map(l => l.description).join(' | ')}`);
});

check('real line items that merely contain those words survive', () => {
  // The cost of over-matching is silently dropping a genuine item, which is worse than the problem.
  const genuine = { lines: [
    { description: 'Overhead coiling service doors', amount: 29_400, rowKind: 'work' },
    { description: 'Overhead crane rail and supports', amount: 84_000, rowKind: 'work' },
    { description: 'Total station survey equipment', amount: 18_000, rowKind: 'work' },
    { description: 'Bond breaker at construction joints', amount: 4_200, rowKind: 'work' },
    { description: 'General purpose receptacles and devices', amount: 62_000, rowKind: 'work' },
    { description: 'Conditioned air distribution ductwork', amount: 76_880, rowKind: 'work' },
  ] };
  assert.strictEqual(workLines(genuine).length, 6,
    `dropped: ${genuine.lines.filter(l => !workLines(genuine).some(w => w.description === l.description)).map(l => l.description).join(' | ')}`);
});

check('nothing has to be asked of the project manager', () => {
  // The whole point of the change: one argument in, a decision out.
  assert.strictEqual(selectLines.length, 1);
});

console.log('\nVE Analyzer — Coaster decides how far to look');

check('a lopsided estimate stops once the big items are covered', () => {
  // One row is 90% of the job. Everything after it is rounding.
  const lopsided = {
    lines: [
      { description: 'Structural steel package', amount: 900_000, rowKind: 'work' },
      ...Array.from({ length: 30 }, (_, i) => (
        { description: `Minor item ${i}`, amount: 3_333, rowKind: 'work' })),
    ],
  };
  const { lines, coverage } = selectLines(lopsided);
  assert.ok(lines.length <= MIN_LINES + 1, `looked at ${lines.length} rows on a one-item job`);
  assert.ok(coverage > 0.85, `coverage was ${coverage}`);
});

check('an even estimate keeps going until most of the money is covered', () => {
  const even = { lines: Array.from({ length: 20 }, (_, i) => (
    { description: `Trade package ${i}`, amount: 50_000, rowKind: 'work' })) };
  const { lines, coverage } = selectLines(even);
  assert.ok(coverage >= 0.8, `stopped at ${coverage} coverage`);
  assert.strictEqual(lines.length, 16); // 16 of 20 evenly-priced rows is 80%
});

check('a lump-sum estimate still gets more than one item looked at', () => {
  const lump = { lines: [
    { description: 'General construction, all trades', amount: 980_000, rowKind: 'work' },
    { description: 'Site work', amount: 12_000, rowKind: 'work' },
    { description: 'Landscaping', amount: 8_000, rowKind: 'work' },
  ] };
  assert.strictEqual(selectLines(lump).lines.length, 3);
});

check('trivial rows are never dragged in to make up the numbers', () => {
  const withDust = { lines: [
    { description: 'Curtain wall', amount: 500_000, rowKind: 'work' },
    { description: 'Door hardware', amount: 400_000, rowKind: 'work' },
    { description: 'Sealant', amount: 300, rowKind: 'work' },
    { description: 'Fasteners', amount: 120, rowKind: 'work' },
  ] };
  const { lines } = selectLines(withDust);
  assert.ok(!lines.some(l => /sealant|fastener/i.test(l.description)),
    'a row worth a rounding error was sent for value engineering');
});

check('a very long estimate is capped so the report stays readable', () => {
  const huge = { lines: Array.from({ length: 400 }, (_, i) => (
    { description: `Item ${i}`, amount: 10_000, rowKind: 'work' })) };
  const { lines, workLineCount } = selectLines(huge);
  assert.strictEqual(lines.length, MAX_LINES);
  // The whole document was still read — the cap is on the report, not on the estimate.
  assert.strictEqual(workLineCount, 400);
});

check('an estimate with no extended amounts still produces something', () => {
  const noAmounts = { lines: [
    { description: 'Millwork, priced by allowance', rowKind: 'work' },
    { description: 'Signage, priced by allowance', rowKind: 'work' },
  ] };
  const { lines, coverage } = selectLines(noAmounts);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(coverage, null);
});

check('the estimate\'s own trade subtotal is the denominator, not the rows in hand', () => {
  // On the shortlist path only the biggest rows are classified, so summing them would give a
  // denominator far smaller than the job — and the coverage rule would stop early believing it had
  // covered the estimate when it had covered the shortlist.
  const shortlisted = {
    tradeSubtotal: 1_000_000,
    lines: Array.from({ length: 10 }, (_, i) => (
      { description: `Item ${i}`, amount: 30_000, rowKind: 'work' })),
  };
  const { coverage, totalWorkValue, lines } = selectLines(shortlisted);
  assert.strictEqual(totalWorkValue, 1_000_000, 'summed the shortlist instead of reading the estimate');
  assert.ok(coverage < 0.35, `claimed ${Math.round(coverage * 100)}% coverage of a job it barely touched`);
  // And with the true denominator it keeps going rather than stopping at the coverage target.
  assert.strictEqual(lines.length, 10);
});

check('a trade subtotal smaller than the rows in hand is not believed', () => {
  // A misread subtotal must never shrink the denominator below what is demonstrably there.
  const wrong = {
    tradeSubtotal: 1_000,
    lines: [{ description: 'A', amount: 500_000, rowKind: 'work' }],
  };
  assert.strictEqual(selectLines(wrong).totalWorkValue, 500_000);
});

check('coverage is reported honestly, never as "we read everything"', () => {
  const { coverage } = selectLines(ESTIMATE);
  assert.ok(coverage > 0 && coverage <= 1, `coverage was ${coverage}`);
});

console.log('\nVE Analyzer — is the text layer actually readable?');

// Taken from a real customer estimate. The PDF embeds subset fonts with no character map, so the
// text layer is plentiful — two thousand characters a page — and completely meaningless. Every
// check that only counts characters passes it, and the model is then asked to price a document
// nobody can see.
const GARBLED = `3 4 5 6 3 7 8 8 3 9 : ; ; 3 <= > ? 3 : @ A B 3 C D E E F 3 G E H H I 3 4 J K F J L B 3 3 M 4 5 G N
? Y ? ? ] Z ? Z ? \\? ? ? Z ? \\ ? ?[ ? f ? \\ ? g ? d? ? h i ? Y ? ?Z ? ^ ] g ? d W a d ? [ ? \\[ ? j ? ? j
5 6 7 58 9 : ; < = 8 > ; ? 8 = @ < A B : B ? A C 8 A B D ? = E 8 B > 8 ? F B D 8 < G ; < ; D H A 8
t u v w x t yx z u { | x u } t ~ ? ~ ~ ? ? ? ? ? ? ? ? ~ ? ? ? ? ? ? ? ? ? ? ? ? ? ? ~ ? ? ? ? ?`.repeat(6);

const REAL_TEXT = `MERIDIAN BUILDERS INCORPORATED - Northline Regional Health Campus Phase 2
DIVISION 06 - WOOD AND PLASTICS
DESCRIPTION QTY UNIT UNIT COST AMOUNT
Walnut veneer wall panel system, floor to ceiling 2,400 SF 77.50 186,000.00
Custom millwork reception desk, solid surface top 1 LS 68,400.00 68,400.00
Architectural wood ceiling, linear slat 1,850 SF 62.00 114,700.00
DIVISION 06 Subtotal 456,840.00`;

check('glyph soup is not mistaken for a readable estimate', () => {
  assert.ok(GARBLED.length > 1000, 'the sample needs to be long enough to pass a length check');
  assert.strictEqual(looksLegible(GARBLED), false,
    'a document with no character map would have been read as text and priced from nonsense');
});

check('a real estimate reads as legible', () => {
  assert.strictEqual(looksLegible(REAL_TEXT), true);
});

check('a terse estimate that is mostly numbers still reads as legible', () => {
  // The test must not demand prose: estimates are terse by nature.
  const terse = ['Concrete 1200 CY 185.00 222,000.00', 'Rebar 44000 LB 1.95 85,800.00',
    'Formwork 8600 SF 12.40 106,640.00', 'Curing compound 8600 SF 0.42 3,612.00'].join('\n').repeat(8);
  assert.strictEqual(looksLegible(terse), true);
});

check('an empty or tiny text layer is not legible', () => {
  assert.strictEqual(looksLegible(''), false);
  assert.strictEqual(looksLegible('Page 1 of 4'), false);
});

check('the gate both text paths go through rejects a garbled document', () => {
  // The real one: four pages, two thousand characters each, none of it meaning anything. It passes
  // any check that counts characters, which is exactly how it reached the model.
  assert.strictEqual(usableText(GARBLED, 4), false,
    'garbled text would be sent to be priced');
  assert.strictEqual(usableText(REAL_TEXT.repeat(4), 4), true);
});

check('the gate also rejects a scan, which has almost no text at all', () => {
  assert.strictEqual(usableText('Page 1', 4), false);
  assert.strictEqual(usableText('', 0), false);
});

console.log('\nVE Analyzer — reading the rows locally, before anything is paid for');

// The shortlist is chosen from rows rebuilt out of the PDF's own text layer, at no cost. Getting the
// amount off a row wrong here does not put a wrong number in a report — the model re-reads whatever
// is shortlisted — but it can cost a row its place, so the parse has to hold on the layouts
// estimating software actually produces.
const page = rows => [{ page: 1, rows }];

check('the amount is the last money column, not the rate or the quantity', () => {
  const [row] = pricedRows(page(['Walnut veneer wall panel system 2,400 SF 77.50 186,000.00']));
  assert.strictEqual(row.amount, 186000);
});

check('an estimate that prints amounts without decimals still reads', () => {
  const [row] = pricedRows(page(['Terrazzo flooring 3,100 SF 80 248,000']));
  assert.strictEqual(row.amount, 248000);
});

check('a lump sum row with no quantity reads', () => {
  const [row] = pricedRows(page(['Building automation and controls 1 LS 386,000.00 386,000.00']));
  assert.strictEqual(row.amount, 386000);
});

check('a subtotal row is picked up too, so it can be ruled out later', () => {
  // Deliberately kept: it has to reach the model to be labelled a subtotal. Dropping totals here on
  // a guess is how a work row called "Total station survey equipment" would vanish.
  const [row] = pricedRows(page(['DIVISION 06 Subtotal 456,840.00']));
  assert.strictEqual(row.amount, 456840);
});

check('a heading with no money on it is not a row', () => {
  assert.strictEqual(pricedRows(page(['DIVISION 09 - FINISHES', 'DESCRIPTION QTY UNIT AMOUNT'])).length, 0);
});

check('a negative-looking deduct still yields its magnitude', () => {
  const [row] = pricedRows(page(['Alternate No. 3 - Substitute epoxy terrazzo (42,000.00)']));
  assert.strictEqual(row.amount, 42000);
});

check('the shortlist takes the biggest rows and over-fetches', () => {
  // Subtotals crowd the top of any ranking by amount, so the shortlist has to be several times the
  // number of items actually wanted or filtering them out leaves too few.
  const many = page(Array.from({ length: 200 }, (_, i) => `Item ${i} 1 LS ${(i + 1) * 1000}.00`));
  const picked = shortlist(pricedRows(many), 20);
  // Three times what is wanted. On the measured estimate 27 of the 60 biggest figures were totals
  // or markup, so a shortlist the same size as the wanted count leaves far too few real rows.
  assert.strictEqual(picked.length, 60, `shortlisted ${picked.length} for 20 wanted`);
  assert.strictEqual(picked[0].amount, 200000);
  assert.ok(picked.every((r, i) => i === 0 || r.amount <= picked[i - 1].amount), 'not sorted');
});

check('a short estimate is shortlisted whole rather than truncated', () => {
  const few = page(['A 1 LS 100.00', 'B 1 LS 200.00', 'C 1 LS 300.00']);
  assert.strictEqual(shortlist(pricedRows(few), 20).length, 3);
});

console.log('\nVE Analyzer — an estimate bound inside a proposal');

// The shape that broke it before this existed: a base breakdown, then a page of money that is NOT
// the price being asked for. Measured on the real fixture, all four alternates were read as work,
// one was selected for value engineering, and $144,600 landed in the coverage denominator.
const PROPOSAL = {
  estimateTitle: 'Lobby Renovation',
  estimateTotal: 1_101_112,
  exclusions: ['Excludes fire sprinkler modifications; existing heads to be reused as-is.'],
  assumptions: ['Terrazzo price assumes the existing slab is level within 1/4 inch in 10 feet.'],
  scopeNotes: [{ system: 'Wall finishes', detail: 'Book-matched American black walnut veneer over 3/4 inch fire-rated MDF, Class A flame spread.' }],
  lines: [
    { description: 'Terrazzo flooring, poured in place', amount: 248_000, rowKind: 'work', priceBasis: 'base' },
    { description: 'Walnut veneer wall panel system', amount: 186_000, rowKind: 'work', priceBasis: 'base' },
    { description: 'Rooftop air handling unit', amount: 164_000, rowKind: 'work', priceBasis: 'base' },
    { description: 'Aluminum storefront glazing', amount: 122_120, rowKind: 'work', priceBasis: 'base' },
    { description: 'Sheet metal ductwork, galvanized', amount: 76_880, rowKind: 'work', priceBasis: 'base' },
    { description: 'Acoustic ceiling tile', amount: 27_900, rowKind: 'work', priceBasis: 'base' },
    { description: 'Solid core wood doors', amount: 24_120, rowKind: 'work', priceBasis: 'base' },
    { description: 'Painting, walls and ceilings', amount: 17_640, rowKind: 'work', priceBasis: 'base' },
    { description: 'Rough carpentry blocking', amount: 14_500, rowKind: 'work', priceBasis: 'base' },
    { description: 'SUBTOTAL OF ALL TRADES', amount: 881_160, rowKind: 'subtotal', priceBasis: 'base' },
    { description: 'Overhead and profit @ 12%', amount: 113_179, rowKind: 'markup', priceBasis: 'base' },
    // The trap page.
    { description: 'Alternate No. 1 - Upgrade lobby lighting to tunable white LED', amount: 48_600, rowKind: 'work', priceBasis: 'alternate' },
    { description: 'Alternate No. 3 - Substitute epoxy terrazzo for cement terrazzo', amount: -42_000, rowKind: 'work', priceBasis: 'alternate' },
    { description: 'Alternate No. 4 - Extend wall panel system into the corridor', amount: 64_800, rowKind: 'work', priceBasis: 'alternate' },
    { description: 'Additional walnut wall panel', unitCost: 77.5, unit: 'SF', rowKind: 'work', priceBasis: 'unit_price' },
    { description: 'Decorative lighting allowance', amount: 35_000, rowKind: 'work', priceBasis: 'allowance' },
  ],
};

// The true base trade value: the nine base work rows, and nothing else.
const TRUE_BASE = 248_000 + 186_000 + 164_000 + 122_120 + 76_880 + 27_900 + 24_120 + 17_640 + 14_500;

check('an alternate is never treated as work to be re-engineered', () => {
  const work = workLines(PROPOSAL);
  assert.ok(!work.some(l => /alternate/i.test(l.description)),
    'money the owner was never asked for was sent for value engineering');
  assert.strictEqual(work.length, 9);
});

check('a unit price is not a line item', () => {
  assert.ok(!workLines(PROPOSAL).some(l => /additional walnut/i.test(l.description)));
});

check('an allowance is not something to substitute', () => {
  assert.ok(!workLines(PROPOSAL).some(l => /allowance/i.test(l.description)));
});

check('none of the trap rows can reach the selection', () => {
  const { lines } = selectLines(PROPOSAL);
  assert.ok(!lines.some(l => /alternate|allowance|additional walnut/i.test(l.description)));
});

check('the coverage denominator is the base price and nothing else', () => {
  // This is the bug that put a confidently wrong percentage in a client-facing document.
  const { totalWorkValue } = selectLines(PROPOSAL);
  assert.strictEqual(totalWorkValue, TRUE_BASE,
    `work value was ${totalWorkValue}, should be ${TRUE_BASE}`);
});

check('a row with no basis recorded still counts as the base price', () => {
  // A bare estimate has no alternates section, so nothing is labelled. Every row would be thrown
  // away if the default went the other way.
  const bare = { lines: [{ description: 'Terrazzo', amount: 100, rowKind: 'work' }] };
  assert.strictEqual(workLines(bare).length, 1);
});

check('the contractor\'s own alternates are collected, not discarded', () => {
  const alts = alternateLines(PROPOSAL);
  assert.strictEqual(alts.length, 3);
  assert.ok(alts.some(a => a.amount === -42_000), 'the deduct alternate was lost');
});

check('the string "null" where a list belongs does not take the analysis down', () => {
  // Found on a real 22-page estimate with no exclusions section: the model wrote the STRING "null"
  // into exclusions, assumptions and scopeNotes rather than omitting them. "null" is truthy, so
  // `(x || []).filter(...)` threw and the whole job died after the document had been read and paid
  // for. Worst on the most ordinary documents — a plain estimate has none of those sections.
  const stringy = {
    lines: 'null',
    exclusions: 'null',
    assumptions: 'null',
    scopeNotes: 'null',
  };
  const ctx = proposalContext(stringy);
  assert.deepStrictEqual(ctx.exclusions, []);
  assert.deepStrictEqual(ctx.assumptions, []);
  assert.deepStrictEqual(ctx.scopeNotes, []);
  assert.deepStrictEqual(ctx.alternates, []);
  assert.strictEqual(hasProposalContext(ctx), false);
  assert.deepStrictEqual(workLines(stringy), []);
  assert.deepStrictEqual(selectLines(stringy).lines, []);
});

check('the same alternate found by both reading paths is listed once', () => {
  // The shortlist path reads alternates twice — once as a section, once as rows that happened to
  // rank in. The two spell them differently ("No. 1 — Upgrade" against "No. 1 - Upgrade"), so
  // matching on the text as written listed every alternate on the proposal twice.
  const both = {
    lines: [
      { description: 'Alternate No. 1 - Upgrade lobby lighting to tunable white LED', amount: 48_600, rowKind: 'work', priceBasis: 'alternate' },
      { description: 'Alternate No. 3 - Substitute epoxy terrazzo', amount: -42_000, rowKind: 'work', priceBasis: 'alternate' },
    ],
    alternateItems: [
      { itemNumber: 'Alternate No. 1', description: 'Upgrade lobby lighting to tunable white LED', amount: 48_600 },
      { itemNumber: 'Alternate No. 3', description: 'Substitute epoxy terrazzo', amount: -42_000 },
    ],
  };
  const { alternates } = proposalContext(both);
  assert.strictEqual(alternates.length, 2, `listed ${alternates.length}: ${alternates.map(a => a.description).join(' | ')}`);
  assert.ok(alternates.some(a => a.amount === -42_000), 'the deduct was lost');
});

check('the same alternate with a disagreeing sign is listed once, as a deduct', () => {
  // The real failure: one pass read "(42,000.00)" as a deduct and the other as a positive, so the
  // owner was shown the same alternate twice — once as money off and once as money added.
  const disagreeing = {
    lines: [{ description: 'Alternate No. 3 - Substitute epoxy terrazzo', amount: 42_000, rowKind: 'work', priceBasis: 'alternate' }],
    alternateItems: [{ itemNumber: 'Alternate No. 3', description: 'Substitute epoxy terrazzo', amount: -42_000 }],
  };
  const { alternates } = proposalContext(disagreeing);
  assert.strictEqual(alternates.length, 1, `listed ${alternates.length}`);
  assert.strictEqual(alternates[0].amount, -42_000, 'the section reading did not win');
});

check('an alternate only the context pass saw is still kept', () => {
  // A deduct alternate is routinely too small to rank into the biggest rows, so the shortlist path
  // would never see it. It must come through the context read regardless.
  const contextOnly = {
    lines: [],
    alternateItems: [{ itemNumber: 'Alternate No. 3', description: 'Substitute epoxy terrazzo', amount: -42_000 }],
  };
  const { alternates } = proposalContext(contextOnly);
  assert.strictEqual(alternates.length, 1);
  assert.match(alternates[0].description, /Alternate No\. 3/);
});

check('a bare estimate carries no proposal context at all', () => {
  const bare = { lines: [{ description: 'Terrazzo', amount: 100, rowKind: 'work' }] };
  assert.strictEqual(hasProposalContext(proposalContext(bare)), false);
});

check('a proposal does carry it', () => {
  assert.strictEqual(hasProposalContext(proposalContext(PROPOSAL)), true);
});

console.log('\nVE Analyzer — what the contractor already offered is handed over, not re-invented');

check('the alternates are told to the model as off limits', () => {
  const text = buildLinesText(selectLines(PROPOSAL).lines, { proposal: proposalContext(PROPOSAL) });
  assert.match(text, /ALREADY OFFERED BY THE CONTRACTOR/);
  assert.match(text, /epoxy terrazzo/i);
  assert.match(text, /Do NOT propose/);
});

check('a deduct is described as a deduct, not an add', () => {
  const text = buildLinesText(selectLines(PROPOSAL).lines, { proposal: proposalContext(PROPOSAL) });
  assert.match(text, /deduct \$42,000/);
  assert.match(text, /add \$64,800/);
});

check('the exclusions and assumptions reach the model', () => {
  const text = buildLinesText(selectLines(PROPOSAL).lines, { proposal: proposalContext(PROPOSAL) });
  assert.match(text, /fire sprinkler modifications/);
  assert.match(text, /level within 1\/4 inch in 10 feet/,
    'the slab assumption never reached the model — it is what rules out polished concrete');
});

check('the written scope reaches the model, with its fire rating intact', () => {
  const text = buildLinesText(selectLines(PROPOSAL).lines, { proposal: proposalContext(PROPOSAL) });
  assert.match(text, /Class A flame spread/);
});

check('the rules in the system prompt point at sections that actually exist', () => {
  // The system prompt says "anything under ALREADY OFFERED BY THE CONTRACTOR is off limits". If
  // that heading is ever reworded in one place and not the other, the rule quietly refers to a
  // section that is not there — and the model goes back to re-proposing the contractor's own
  // alternates with nothing failing anywhere.
  const text = buildLinesText(selectLines(PROPOSAL).lines, { proposal: proposalContext(PROPOSAL) });
  const headings = [
    'ALREADY OFFERED BY THE CONTRACTOR',
    'WHAT THE PROPOSAL SAYS IS NOT INCLUDED',
    'WHAT THE PRICE ASSUMES',
    'WHAT WAS ACTUALLY SPECIFIED',
  ];
  for (const heading of headings) {
    assert.ok(text.includes(heading), `the prompt never prints "${heading}"`);
  }
  // The system prompt refers to each of them by name.
  assert.ok(OPTIONS_SYSTEM.includes('ALREADY OFFERED BY THE CONTRACTOR'),
    'the rule about the contractor\'s own alternates no longer names the section it governs');
  assert.ok(OPTIONS_SYSTEM.includes('EXCLUDES'), 'the exclusions rule is gone');
  assert.ok(OPTIONS_SYSTEM.includes('ASSUMPTION'), 'the assumptions rule is gone');
  assert.ok(OPTIONS_SYSTEM.includes('WHAT WAS ACTUALLY SPECIFIED'), 'the written-scope rule is gone');
});

check('a bare estimate gets none of those sections in its prompt', () => {
  const bare = { lines: [{ description: 'Terrazzo', amount: 100, rowKind: 'work' }] };
  const text = buildLinesText(workLines(bare), { proposal: proposalContext(bare) });
  assert.ok(!/ALREADY OFFERED|NOT INCLUDED|WHAT THE PRICE ASSUMES|ACTUALLY SPECIFIED/.test(text),
    'empty headings were printed for a document that has none of this');
});

// A small local fixture: the shared ENTRIES constant is declared further down this file, and
// reaching for it here would hit the temporal dead zone.
const SOME_ENTRIES = [{
  lineIndex: 0, description: 'Terrazzo flooring', amount: 248_000,
  options: [{
    id: 'L0-O0', name: 'Polished concrete', kind: 'saves_money', confidence: 'well_established',
    whatItIs: 'The slab itself, ground smooth.', askTheDesigner: 'Is the slab flat enough?', kept: true,
  }],
}];

check('the owner report leads with what the contractor already priced', () => {
  const report = buildVeReport({
    header: { projectName: 'X', proposal: proposalContext(PROPOSAL) },
    entries: SOME_ENTRIES,
  });
  assert.strictEqual(report.alreadyOffered.length, 3);
  assert.match(report.markdown, /Already offered by your contractor/);
  // Before anything this tool thought of.
  assert.ok(report.markdown.indexOf('already offered') < report.markdown.indexOf('Polished concrete'),
    'the contractor\'s own offers were printed after the suggestions');
});

check('a deduct alternate is presented as money off, in the contractor\'s own figures', () => {
  const report = buildVeReport({
    header: { projectName: 'X', proposal: proposalContext(PROPOSAL) },
    entries: SOME_ENTRIES,
  });
  const deduct = report.alreadyOffered.find(a => a.isSaving);
  assert.ok(deduct, 'the deduct was not recognised as a saving');
  assert.match(deduct.effect, /\$42,000\.00 off/);
  assert.ok(!deduct.effect.includes('added'), 'a deduct was described as an addition');
});

check('a document with no readable items says so instead of printing an empty table', () => {
  const report = buildVeReport({ header: { projectName: 'X' }, entries: [] });
  assert.match(report.markdown, /No priced items could be read/i);
});

check('a bare estimate report has no such section', () => {
  const report = buildVeReport({ header: { projectName: 'X' }, entries: SOME_ENTRIES });
  assert.strictEqual(report.alreadyOffered.length, 0);
  assert.ok(!/already offered/i.test(report.markdown));
});

console.log('\nVE Analyzer — how cost is spoken about');

check('a saving is stated as a range of percentages', () => {
  const said = costBand({ savingsLowPct: 12, savingsHighPct: 28 });
  assert.match(said, /12%/); assert.match(said, /28%/); assert.match(said, /less/);
  assert.ok(!said.includes('$'), 'a dollar sign reached the owner-facing text');
});

check('an option that costs more says so', () => {
  const said = costBand({ savingsLowPct: -20, savingsHighPct: -8 });
  assert.match(said, /more/);
  assert.ok(!/less/.test(said), `"${said}" reads as a saving`);
});

check('a band that straddles zero is not sold as a saving', () => {
  const said = costBand({ savingsLowPct: -10, savingsHighPct: 15 });
  assert.match(said, /more/);
  assert.match(said, /less/);
  assert.ok(!/^\d+% (to \d+% )?less$/.test(said), `"${said}" reads as a pure saving`);
});

check('no numbers at all is an honest answer, not a blank', () => {
  const said = costBand({});
  assert.match(said, /depends on the design/i);
  assert.ok(!said.includes('%'));
});

console.log('\nVE Analyzer — the table the owner reads');

const ENTRIES = [
  {
    lineIndex: 3, description: 'Terrazzo flooring', section: 'Div 09 — Finishes', amount: 248_000,
    quantity: 3100, unit: 'SF', answered: true,
    options: [
      { id: 'L3-O0', name: 'Polished concrete', whatItIs: 'The concrete slab itself, ground smooth.', savingsLowPct: 40, savingsHighPct: 60, kept: true },
      { id: 'L3-O1', name: 'Porcelain tile', whatItIs: 'Large-format tile.', kept: false },
    ],
  },
  {
    lineIndex: 0, description: 'Walnut veneer wall panel system', amount: 186_000, answered: true,
    options: [
      { id: 'L0-O0', name: 'Fibre-cement rainscreen', whatItIs: 'A pressed cement board panel.', note: 'Confirm the fire rating.', savingsLowPct: 15, savingsHighPct: 30, kept: false },
    ],
  },
  {
    lineIndex: 4, description: 'Acoustic ceiling tile', amount: 27_900, answered: true,
    noOptionsReason: 'This is the standard product for the use.',
    options: [],
  },
];

const HEADER = { projectName: 'Spring Branch Lobby', contractor: 'Acme Construction', estimateTotal: 1_000_000 };

// The three columns of a markdown table row, for a row that is not a separator.
// Split on UNESCAPED pipes only: "\|" is the markdown escape for a literal pipe inside a cell, and
// a renderer treats it as content rather than as a column boundary.
const rowsOf = markdown => markdown.split('\n')
  .filter(l => l.startsWith('|') && !/^\|\s*---/.test(l))
  .map(l => l.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim()));

check('the report is a table of item, alternative and cost difference', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  assert.match(report.markdown, /\| Item \| Alternative \| Difference in cost \|/,
    'the three columns are not the ones asked for');
  const body = rowsOf(report.markdown).filter(r => r.length === 3 && r[0] !== 'Item');
  assert.ok(body.length >= 3, `expected a row per item, got ${body.length}`);
});

check('dropped options are gone from the owner report', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  assert.ok(report.markdown.includes('Polished concrete'));
  assert.ok(!report.markdown.includes('Porcelain tile'), 'a dropped option reached the owner');
});

check('every item stays in the table, including the ones with nothing to offer', () => {
  // This is the change: the owner asked what the options were for each item, and "none" is an
  // answer. Items used to disappear from the report entirely.
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  for (const name of ['Terrazzo flooring', 'Walnut veneer wall panel system', 'Acoustic ceiling tile']) {
    assert.ok(report.markdown.includes(name), `"${name}" is missing from the table`);
  }
  assert.strictEqual(report.entries.length, 3);
});

check('an item the model found nothing for shows its reason', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  assert.ok(report.markdown.includes('This is the standard product for the use.'));
});

check('an item whose options the PM dropped does NOT claim there were none', () => {
  // The walnut line had one option and the PM dropped it. Printing "no alternative worth raising"
  // there would put a judgement in their mouth that they never made.
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  const walnut = rowsOf(report.markdown).find(r => r[0] && r[0].includes('Walnut'));
  assert.ok(walnut, 'the walnut row is missing');
  assert.strictEqual(walnut[1], '', `claimed "${walnut[1]}" on the PM's behalf`);
});

check('the counts describe what the owner is actually looking at', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  assert.strictEqual(report.counts.items, 3);
  assert.strictEqual(report.counts.itemsWithOptions, 1);
  assert.strictEqual(report.counts.options, 1);
  assert.match(report.markdown, /1 alternative across 1 of the 3 items looked at/);
});

check('the alternative and cost columns never carry a dollar figure', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  // The item's own price is quoted from the estimate and is allowed in column one. Columns two and
  // three are the model's opinion and may never name a dollar amount.
  for (const row of rowsOf(report.markdown).filter(r => r.length === 3)) {
    assert.ok(!row[1].includes('$'), `a price reached an alternative: ${row[1]}`);
    assert.ok(!row[2].includes('$'), `a price reached the cost column: ${row[2]}`);
  }
});

check('the one-line note survives into the table', () => {
  const kept = ENTRIES.map(e => ({ ...e, options: e.options.map(o => ({ ...o, kept: true })) }));
  const report = buildVeReport({ header: HEADER, entries: kept });
  assert.ok(report.markdown.includes('Confirm the fire rating.'));
});

check('a pipe in the model\'s prose does not break the table', () => {
  // Rare in construction writing and catastrophic when it happens: every value after it lands in
  // the wrong column.
  const nasty = [{
    lineIndex: 1, description: 'Panel | system', amount: 100,
    options: [{ id: 'a', name: 'Swap | thing', whatItIs: 'A | B', kept: true }],
  }];
  const report = buildVeReport({ header: HEADER, entries: nasty });
  for (const row of rowsOf(report.markdown).filter(r => r.length !== 2)) {
    assert.strictEqual(row.length, 3, `a row broke into ${row.length} columns: ${row.join(' ~ ')}`);
  }
});

check('the report says out loud that these are not quotes', () => {
  const report = buildVeReport({ header: HEADER, entries: ENTRIES });
  assert.match(report.disclaimer, /not quotes/i);
  assert.match(report.disclaimer, /architect or engineer/i);
  assert.ok(report.markdown.includes(report.disclaimer), 'the disclaimer never made it into the document');
});

check('an option with no kept flag at all counts as kept', () => {
  // Records written before a decision was ever made must not silently empty themselves.
  const legacy = [{ lineIndex: 1, description: 'X', options: [{ id: 'L1-O0', name: 'Y', whatItIs: 'z' }] }];
  assert.strictEqual(keptEntries(legacy)[0].options.length, 1);
});

console.log('\nVE Analyzer — what the model is asked');

check('the line index the answer is joined on is printed for every line', () => {
  const chosen = selectLines(ESTIMATE).lines;
  const text = buildLinesText(chosen, { estimateTitle: 'T', contractor: 'C', location: 'Houston, TX' });
  for (const line of chosen) {
    assert.ok(text.includes(`[${line.index}]`), `line ${line.index} had no index marker`);
  }
});

check('the location read off the estimate reaches the model', () => {
  const text = buildLinesText(selectLines(ESTIMATE).lines, { location: 'Anchorage, AK' });
  assert.match(text, /Anchorage, AK/);
});

check('no location is simply absent rather than an empty label', () => {
  const text = buildLinesText(selectLines(ESTIMATE).lines, {});
  assert.ok(!/Where the project is/.test(text));
});

check('option ids are stable across regeneration', () => {
  assert.strictEqual(optionId(3, 0), 'L3-O0');
  assert.strictEqual(optionId(3, 0), optionId(3, 0));
  assert.notStrictEqual(optionId(3, 0), optionId(3, 1));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
