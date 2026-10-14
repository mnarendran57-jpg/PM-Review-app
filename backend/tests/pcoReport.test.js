const assert = require('assert');
const { runPcoChecks } = require('../lib/pcoChecks');
const { buildPcoReport } = require('../lib/pcoReport');
const { renderPcoReportPdf } = require('../lib/pcoReportPdf');

// What the change order review checks for each choice the PM makes, and how the findings are laid
// out. No API call is made anywhere in this file: the checks are arithmetic and the report is
// assembled from what they found.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

// A change order with one of each problem: a line whose quantity times price is wrong, a total that
// does not add up, sales tax on an exempt job, and a lump sum.
const pco = {
  pcoNumber: '014', title: 'Lobby upgrades', contractor: 'Brazos Valley', totalAmount: 12000,
  taxAmount: 400, isAllowance: false,
  lineItems: [
    { description: 'Copper pipe', qty: 100, unit: 'LF', unitPrice: 30, total: 3500, hasBreakdown: true, kind: 'material' },
    { description: 'Crane and rigging', total: 5000, hasBreakdown: false, kind: 'other' },
  ],
  markups: [{ label: 'Sub markup 15%', tier: 'sub', rate: 0.15, base: 8500, amount: 1275 }],
};
const terms = { taxExempt: true, taxExemptBasis: 'Section 3.6 — owner is a school district', unallowableItems: [] };
const groupsFor = contract => ({ groups: ['math', 'backup', ...(contract ? ['contract'] : [])] });

(async () => {
  await check('a basic check runs the math and the backup check, and nothing about the contract', () => {
    const ids = runPcoChecks({ pco, contractTerms: null }, groupsFor(false)).map(r => r.id);
    assert.deepStrictEqual(ids.sort(), ['L1', 'P1', 'P2', 'P3']);
  });

  await check('checking against a contract adds tax, allowance, markup and unallowable items', () => {
    const ids = runPcoChecks({ pco, contractTerms: terms }, groupsFor(true)).map(r => r.id);
    for (const id of ['T1', 'A1', 'A2', 'A3', 'C1']) assert.ok(ids.includes(id), `${id} missing`);
  });

  await check('a wrong line comes back with the figures behind it', () => {
    const p2 = runPcoChecks({ pco }, groupsFor(false)).find(r => r.id === 'P2');
    assert.strictEqual(p2.status, 'FAIL');
    const r = p2.figures.rows[0];
    assert.deepStrictEqual([r.shown, r.computed, r.difference], [3500, 3000, 500]);
    assert.strictEqual(r.working, '100 LF × $30.00');
  });

  const contractReport = () => {
    const results = runPcoChecks({ pco, contractTerms: terms }, groupsFor(true));
    return buildPcoReport({
      data: { pco }, results, observations: { pricingSanity: 'Copper looks high.' }, reference: null,
      checkedAgainst: { contract: true, reference: false }, contractLabel: 'GC Agreement',
    });
  };

  await check('the verdict leads with what must be resolved', () => {
    const r = contractReport();
    assert.strictEqual(r.verdict.tone, 'red');
    assert.match(r.verdict.headline, /to resolve before approving/);
  });

  await check('math errors and contract deviations are counted separately', () => {
    const r = contractReport();
    const tile = key => r.tiles.find(t => t.key === key).count;
    assert.ok(tile('math') >= 2, 'the total and the copper line');
    assert.ok(tile('contract') >= 2, 'the tax and the sub markup');
    assert.strictEqual(tile('scope'), null, 'not checked, not zero');
  });

  await check('the tax deviation names the clause it comes from', () => {
    const tax = contractReport().contract.issues.find(f => f.id === 'T1');
    assert.strictEqual(tax.figures.rows[0].amount, 400);
    assert.match(tax.figures.rows[0].basis, /Section 3\.6/);
  });

  await check('a basic check leaves the contract section out rather than showing it empty', () => {
    const results = runPcoChecks({ pco, contractTerms: null }, groupsFor(false));
    const r = buildPcoReport({ data: { pco }, results, observations: {}, reference: null, checkedAgainst: { contract: false, reference: false } });
    assert.strictEqual(r.contract, null);
    assert.strictEqual(r.tiles.find(t => t.key === 'contract').count, null);
    assert.ok(r.askFor.some(a => a.item === 'Crane and rigging'));
  });

  await check('the notes are Coaster\'s, not "the AI\'s"', () => {
    const md = contractReport().markdown;
    assert.ok(md.includes("Coaster's notes"));
    assert.ok(!/\bAI\b/.test(md));
  });

  await check('a review stored before the choice existed still reads back', () => {
    const legacy = runPcoChecks({ pco, contractTerms: terms }).map(({ group, ...rest }) => rest);
    const r = buildPcoReport({ data: { pco }, results: legacy, observations: {}, reference: null, contractChosen: true });
    assert.ok(r.contract && r.contract.issues.length > 0);
    assert.ok(r.math.issues.length > 0);
  });

  await check('the PDF renders, including typographic characters in the text', async () => {
    const r = contractReport();
    r.notes.push({ title: 'Quote “test”', body: 'A dash — and an ellipsis…' });
    const pdf = await renderPcoReportPdf({ report: r });
    assert.ok(pdf.length > 1000);
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
