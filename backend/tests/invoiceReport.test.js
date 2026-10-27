const assert = require('assert');
const { runInvoiceChecks, normalizeRef } = require('../lib/invoiceChecks');
const { buildInvoiceReport } = require('../lib/invoiceReport');
const { renderInvoiceReportPdf } = require('../lib/invoiceReportPdf');

// What the invoice review checks and how it lays the findings out. No API call is made anywhere in
// this file: the checks are arithmetic, and the earlier reviews and billing are handed in.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

const invoice = {
  vendor: 'Lone Star Electric', invoiceNumber: 'INV-1042', invoiceDate: '2026-10-01', poNumber: 'PO 253016-004',
  total: 9000, taxAmount: 0,
  lineItems: [
    { description: 'Conduit and wire', qty: 100, unit: 'LF', unitPrice: 20, total: 2500 },
    { description: 'Lift rental (reimbursable)', total: 1500, isReimbursable: true, hasBackup: false, backupNote: 'No rental invoice attached' },
    { description: 'Labor', total: 5000 },
  ],
};
const terms = { taxExempt: true, commitment: '253016-004', originalContractSum: 20000, unallowableItems: [] };
const all = { groups: ['math', 'backup', 'history', 'contract'] };
const noContract = { groups: ['math', 'backup', 'history'] };

(async () => {
  await check('without an agreement, nothing about the contract or PO runs', () => {
    const ids = runInvoiceChecks({ invoice, contractTerms: null }, noContract).map(r => r.id).sort();
    assert.deepStrictEqual(ids, ['D1', 'M1', 'M2', 'M3', 'M4', 'R1']);
  });

  await check('a wrong line comes back with its figures', () => {
    const m2 = runInvoiceChecks({ invoice }, noContract).find(r => r.id === 'M2');
    assert.deepStrictEqual([m2.figures.rows[0].shown, m2.figures.rows[0].computed], [2500, 2000]);
  });

  await check('a reimbursable cost with no receipt is listed with its amount', () => {
    const r1 = runInvoiceChecks({ invoice }, noContract).find(r => r.id === 'R1');
    assert.strictEqual(r1.status, 'FAIL');
    assert.strictEqual(r1.figures.rows[0].amount, 1500);
  });

  await check('an earlier review of the same invoice is flagged as a possible duplicate', () => {
    const duplicates = [{ id: 7, invoiceNumber: 'INV-1042', total: 9000, invoiceDate: '2026-10-01', reviewedOn: '2026-10-03' }];
    const d1 = runInvoiceChecks({ invoice, duplicates }, noContract).find(r => r.id === 'D1');
    assert.strictEqual(d1.status, 'FAIL');
    assert.strictEqual(d1.critical, true);
    assert.match(d1.figures.rows[0].note, /2026-10-03/);
  });

  await check('no earlier review means no duplicate', () => {
    assert.strictEqual(runInvoiceChecks({ invoice, duplicates: [] }, noContract).find(r => r.id === 'D1').status, 'PASS');
  });

  await check('PO numbers are matched however they are written', () => {
    assert.strictEqual(normalizeRef('PO 253016-004'), normalizeRef('#253016 004'));
    const po1 = runInvoiceChecks({ invoice, contractTerms: terms }, all).find(r => r.id === 'PO1');
    assert.strictEqual(po1.status, 'PASS');
  });

  await check('an invoice citing a different PO is flagged', () => {
    const other = { ...invoice, poNumber: 'PO 253016-009' };
    assert.strictEqual(runInvoiceChecks({ invoice: other, contractTerms: terms }, all).find(r => r.id === 'PO1').status, 'FAIL');
  });

  await check('billing past the agreement value must be resolved, with the figures', () => {
    const billing = { contractValue: 20000, priorBilled: 14000, priorCount: 2 };
    const po2 = runInvoiceChecks({ invoice, contractTerms: terms, billing }, all).find(r => r.id === 'PO2');
    assert.strictEqual(po2.status, 'FAIL');
    assert.strictEqual(po2.critical, true);
    assert.strictEqual(po2.figures.rows.find(r => r.emphasis).amount, 3000);
  });

  await check('billing within the value passes and says what is left', () => {
    const billing = { contractValue: 20000, priorBilled: 5000, priorCount: 1 };
    const po2 = runInvoiceChecks({ invoice, contractTerms: terms, billing }, all).find(r => r.id === 'PO2');
    assert.strictEqual(po2.status, 'PASS');
    assert.match(po2.detail, /leaving \$6,000\.00/);
  });

  const fullReport = () => {
    const data = {
      invoice, contractTerms: terms,
      duplicates: [{ id: 7, invoiceNumber: 'INV-1042', total: 9000, invoiceDate: '2026-10-01', reviewedOn: '2026-10-03' }],
      billing: { contractValue: 20000, priorBilled: 14000, priorCount: 2 },
    };
    const results = runInvoiceChecks(data, all);
    return buildInvoiceReport({
      data, results, contractChosen: true, contractLabel: 'Electrical PO',
      observations: {
        pricingSanity: 'Conduit looks high.',
        contractConcerns: [
          { item: 'Sales tax', rule: 'Exempt' },
          { item: 'Lift rental (reimbursable)', amount: 1500, rule: 'Equipment rental needs prior approval', section: '7.2' },
        ],
      },
    });
  };

  await check('the verdict leads with what must be resolved before paying', () => {
    const r = fullReport();
    assert.strictEqual(r.verdict.tone, 'red');
    assert.match(r.verdict.headline, /before paying/);
  });

  await check('each kind of problem is counted on its own tile', () => {
    const tile = key => fullReport().tiles.find(t => t.key === key).count;
    assert.strictEqual(tile('math'), 1, 'the conduit line; the total itself adds up');
    assert.strictEqual(tile('backup'), 1);
    assert.strictEqual(tile('duplicate'), 1);
    assert.strictEqual(tile('contract'), 2, 'the billing overrun and one Coaster row — its tax row is dropped');
  });

  await check('without an agreement the contract tile reads "not checked", not zero', () => {
    const results = runInvoiceChecks({ invoice }, noContract);
    const r = buildInvoiceReport({ data: { invoice }, results, observations: {} });
    assert.strictEqual(r.contract, null);
    assert.strictEqual(r.tiles.find(t => t.key === 'contract').count, null);
  });

  await check('the wording is Coaster\'s, not "the AI\'s"', () => {
    const md = fullReport().markdown;
    assert.ok(md.includes("Coaster's notes"));
    assert.ok(!/\bAI\b/.test(md));
  });

  await check('a review stored before the checks had groups still reads back', () => {
    const legacy = runInvoiceChecks({ invoice, contractTerms: terms }, all).map(({ group, ...rest }) => rest);
    const r = buildInvoiceReport({ data: { invoice }, results: legacy, observations: { unallowable: 'Old note' }, contractChosen: true });
    assert.strictEqual(r.math.issues.length, 1);
    assert.ok(r.notes.some(n => n.title === 'Possible contract conflicts'));
  });

  await check('the PDF renders, including typographic characters', async () => {
    const r = fullReport();
    r.notes.push({ title: 'Quote “test”', body: 'A dash — and an ellipsis…' });
    const pdf = await renderInvoiceReportPdf({ report: r });
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
