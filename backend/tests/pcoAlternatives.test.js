const assert = require('assert');
const { candidateLines, alternativesView, MAX_LINES } = require('../lib/pcoAlternatives');
const { buildPcoReport } = require('../lib/pcoReport');

// Which change order lines are worth asking "is there another way?" about, and how the answer is
// shown. No API call is made anywhere in this file: choosing the lines is arithmetic, and the
// options themselves are handed in.

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

const line = (description, kind, total, extra = {}) => ({ description, kind, total, ...extra });

check('a change order for added hours has nothing to look at', () => {
  const pco = { lineItems: [
    line('Electrician overtime, 64 hours', 'labor', 6400),
    line('Scissor lift rental, 2 weeks', 'other', 1800),
    line('Permit revision fee', 'other', 450),
  ] };
  assert.deepStrictEqual(candidateLines(pco), []);
});

check('materials and equipment are the lines that are asked about, biggest first', () => {
  const pco = { lineItems: [
    line('Installation labor', 'labor', 9000),
    line('Copper pipe, 2" type L', 'material', 4000, { qty: 200, unit: 'LF' }),
    line('Rooftop unit, 10 ton', 'equipment', 22000),
    line('Freight', 'other', 600),
  ] };
  const picked = candidateLines(pco);
  assert.deepStrictEqual(picked.map(l => l.description), ['Rooftop unit, 10 ton', 'Copper pipe, 2" type L']);
  // The index is the line's place on the change order, which is how an answer finds its way back.
  assert.deepStrictEqual(picked.map(l => l.index), [2, 1]);
  assert.strictEqual(picked[1].quantity, 200);
  assert.strictEqual(picked[1].unit, 'LF');
});

check('a product too small to be worth a conversation is left out', () => {
  const pco = { lineItems: [
    line('Switchboard', 'equipment', 48000),
    line('Labels and tags', 'material', 150),
  ] };
  assert.deepStrictEqual(candidateLines(pco).map(l => l.description), ['Switchboard']);
});

check('a line priced by quantity and unit price, with no total, still counts', () => {
  const pco = { lineItems: [{ description: 'LED troffer', kind: 'material', qty: 40, unitPrice: 180 }] };
  assert.strictEqual(candidateLines(pco)[0].amount, 7200);
});

check('a line with no kind recorded is not guessed at', () => {
  const pco = { lineItems: [{ description: 'Lump sum per attached', total: 30000 }] };
  assert.deepStrictEqual(candidateLines(pco), []);
});

check('a long change order is capped, keeping the biggest lines', () => {
  const pco = { lineItems: Array.from({ length: 14 }, (_, i) => line(`Fixture type ${i}`, 'material', 1000 + i)) };
  const picked = candidateLines(pco);
  assert.strictEqual(picked.length, MAX_LINES);
  assert.strictEqual(picked[0].description, 'Fixture type 13');
});

check('an empty or missing change order does not throw', () => {
  assert.deepStrictEqual(candidateLines({}), []);
  assert.deepStrictEqual(candidateLines(null), []);
});

const STORED = { entries: [
  {
    lineIndex: 2, description: 'Rooftop unit, 10 ton', amount: 22000, answered: true, noOptionsReason: null,
    options: [
      { name: 'Standard-efficiency packaged unit', whatItIs: 'The same size of unit with a lower efficiency rating.',
        savingsLowPct: 10, savingsHighPct: 20, note: 'Confirm it still meets the energy code.' },
      { name: 'Split system', whatItIs: 'A unit in two parts, one indoors and one outdoors.',
        savingsLowPct: -5, savingsHighPct: 10 },
    ],
  },
  { lineIndex: 1, description: 'Copper pipe', amount: 4000, answered: true,
    noOptionsReason: 'This is the standard way to do it.', options: [] },
] };

check('the view words each cost difference as a band and never as dollars', () => {
  const view = alternativesView(STORED);
  assert.strictEqual(view.optionCount, 2);
  assert.strictEqual(view.lines[0].options[0].costDifference, '10% to 20% less');
  assert.strictEqual(view.lines[0].options[0].isSaving, true);
  assert.strictEqual(view.lines[0].options[1].costDifference, '5% more to 10% less');
  assert.strictEqual(view.lines[0].options[1].isSaving, false);
  assert.ok(!JSON.stringify(view.lines.map(l => l.options)).includes('$'));
});

check('a line with nothing to suggest says why', () => {
  const view = alternativesView(STORED);
  assert.strictEqual(view.lines[1].noOptionsReason, 'This is the standard way to do it.');
});

check('nothing stored means no section at all', () => {
  assert.strictEqual(alternativesView(null), null);
  assert.strictEqual(alternativesView({ entries: [] }), null);
});

const reportFor = alternatives => buildPcoReport({
  data: { pco: { pcoNumber: '012', totalAmount: 26000, lineItems: [] } },
  results: [], observations: {}, reference: null, alternatives,
});

check('the written report carries the section when there are alternatives', () => {
  const md = reportFor(alternativesView(STORED)).markdown;
  assert.ok(md.includes('### Savings ideas'));
  assert.ok(md.includes('Standard-efficiency packaged unit — 10% to 20% less.'));
  assert.ok(md.includes('No alternative suggested. This is the standard way to do it.'));
});

check('and leaves it out entirely when there are none', () => {
  assert.ok(!reportFor(null).markdown.includes('Savings ideas'));
});

console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
  + `${failed ? `, ${failed} FAILED` : '.'}`);
process.exit(failed === 0 ? 0 : 1);
