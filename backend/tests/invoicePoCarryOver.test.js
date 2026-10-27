const assert = require('assert');
const { runInvoiceChecks, billingFor } = require('../lib/invoiceChecks');
const { buildInvoiceReport } = require('../lib/invoiceReport');
const { collectMarks } = require('../lib/invoiceMarkup');
const { combineAgreements, looksLikePo } = require('../lib/agreementSet');

// An engineer's invoice against a purchase order that replaced an expired one — the case that
// raised two false red flags on Collaborative Engineering Group's Invoice 5680 (October 2026). The
// figures are that invoice's. No API call is made.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

// $48,000 fee; $39,000 billed before; this invoice $1,500; the new PO is $14,800, so the expired PO
// covered $33,200 of the fee.
const invoice = {
  vendor: 'Collaborative Engineering Group', invoiceNumber: '5680', total: 1500, feeTotal: 48000, previouslyBilled: 39000,
  lineItems: [{ description: 'Professional Engineering Services from 04/21/2026 to 10/20/2026', total: 1500 }],
  phases: [
    { name: 'Construction Document Phase', fee: 35000, percentComplete: 1, earned: 35000, previouslyBilled: 35000, current: 0 },
    { name: 'Bidding & Negotiation Phase', fee: 3000, percentComplete: 1, earned: 3000, previouslyBilled: 3000, current: 0 },
    { name: 'Construction Administration Services', fee: 10000, percentComplete: 0.25, earned: 2500, previouslyBilled: 1000, current: 1500 },
  ],
};
const PO_QUOTE = 'HCC SHALL HAVE NO OBLIGATION TO PAY THE CONTRACTOR ANY ADDITIONAL SUM IN EXCESS OF THE TOTAL PURCHASE ORDER AMOUNT NOTED ON THIS PURCHASE ORDER.';
const poTerms = (extra = {}) => ({
  originalContractSum: 14800, unallowableItems: [{ item: 'Services', basis: 'must match the PO' }],
  clauses: {
    contractSum: { page: 1, quote: PO_QUOTE, amount: 14800 },
    costRules: [{ item: 'Goods or services', rule: 'Must match the PO', page: 1,
      quote: 'HCC SHALL NOT BE RESPONSIBLE FOR THE PAYMENT OF ANY GOOD OR SERVICE DELIVERED THAT DOES NOT MATCH THE ITEMS AND AMOUNTS SPECIFICALLY NOTED ON THIS PURCHASE ORDER.' }],
    ...extra,
  },
});
const PO_LABEL = 'HVAC Replacement- Science Hall, Spring Branch Campus_CEG_PO R000136351_20260428 (1)';

(async () => {
  await check('the fee table on Invoice 5680 adds up', () => {
    const r = runInvoiceChecks({ invoice, contractTerms: null, duplicates: [] }, { groups: ['math'] });
    assert.strictEqual(r.find(x => x.id === 'M4').status, 'PASS');
  });

  await check('a fee-table row billed ahead of its percent complete is caught', () => {
    const bad = { ...invoice, total: 2500, phases: invoice.phases.map(p => (p.current ? { ...p, current: 2500 } : p)) };
    const r = runInvoiceChecks({ invoice: bad, contractTerms: null, duplicates: [] }, { groups: ['math'] });
    const m4 = r.find(x => x.id === 'M4');
    assert.strictEqual(m4.status, 'FAIL');
    assert.match(m4.figures.rows[0].item, /Construction Administration Services — billed now/);
    assert.strictEqual(m4.figures.rows[0].computed, 1500);
  });

  await check('the earlier PO\'s share is taken off when the PO says it continues one', () => {
    const b = billingFor({ value: 14800, invoice, continues: true });
    assert.deepStrictEqual([b.carriedOver, b.priorBilled, b.source], [33200, 5800, 'invoice']);
    const r = runInvoiceChecks({ invoice, contractTerms: poTerms(), billing: b, duplicates: [] }, { groups: ['contract'] });
    const po2 = r.find(x => x.id === 'PO2');
    assert.strictEqual(po2.status, 'PASS');
    assert.match(po2.detail, /continues an earlier one: \$33,200\.00 of the \$48,000\.00 fee/);
    assert.match(po2.detail, /\$7,300\.00 of the \$14,800\.00 agreement has been billed/);
  });

  await check('or when the PM enters what the earlier PO covered', () => {
    const b = billingFor({ value: 14800, invoice, earlierPaid: 33200 });
    assert.deepStrictEqual([b.carriedOver, b.priorBilled, b.carrySource], [33200, 5800, 'stated']);
  });

  await check('never assumed from the numbers alone: then it is flagged, with how to clear it', () => {
    const b = billingFor({ value: 14800, invoice });
    assert.strictEqual(b.carriedOver, 0);
    const po2 = runInvoiceChecks({ invoice, contractTerms: poTerms(), billing: b, duplicates: [] }, { groups: ['contract'] })
      .find(x => x.id === 'PO2');
    assert.strictEqual(po2.status, 'FAIL');
    assert.match(po2.detail, /Already paid under an earlier PO/);
  });

  await check('earlier invoices reviewed in Coaster are not talked down by the invoice\'s own figure', () => {
    const b = billingFor({ value: 14800, invoice, continues: true, history: { priorBilled: 9000, priorCount: 3 } });
    assert.deepStrictEqual([b.priorBilled, b.source], [9000, 'coaster']);
  });

  await check('a PO is recognised by a name with underscores, and its cost rules are set aside', () => {
    assert.ok(looksLikePo({ label: PO_LABEL, terms: {} }));
    const { terms } = combineAgreements([{ id: 1, label: PO_LABEL, docType: 'contract', terms: poTerms() }]);
    assert.deepStrictEqual([terms.clauses.costRules, terms.unallowableItems], [[], []]);
    const r = runInvoiceChecks({ invoice, contractTerms: terms, duplicates: [] }, { groups: ['contract'] });
    assert.notStrictEqual(r.find(x => x.id === 'C1').status, 'FAIL', 'the engineering services line was flagged');
  });

  await check("a contract's cost rules still apply beside the PO", () => {
    const contract = { id: 2, label: 'Owner-Engineer Agreement', docType: 'contract', terms: {
      unallowableItems: [], clauses: { costRules: [{ item: 'Meals', rule: 'Meals are not reimbursable', page: 7, quote: 'Meals are not Reimbursable Expenses.' }] },
    } };
    const { terms } = combineAgreements([contract, { id: 1, label: PO_LABEL, docType: 'contract', terms: poTerms() }]);
    assert.deepStrictEqual(terms.clauses.costRules.map(c => c.item), ['Meals']);
  });

  await check("Coaster's reading cannot put a general PO condition on a line; real concerns stay", () => {
    const results = runInvoiceChecks({ invoice, contractTerms: poTerms(), billing: billingFor({ value: 14800, invoice, continues: true }), duplicates: [] });
    const report = buildInvoiceReport({
      data: { invoice, contractTerms: poTerms() }, results, contractChosen: true, contractLabel: PO_LABEL, agreement: 'architect',
      observations: {
        contractConcerns: [
          { item: 'Professional Engineering Services from 04/21/2026 to 10/20/2026', amount: 1500, rule: 'Goods or services must match items and amounts on the purchase order.' },
          { item: 'Total billing to date: $39,000', amount: 39000, rule: 'No payment above the total purchase order amount without prior HCC approval.', quote: PO_QUOTE },
          { item: 'Travel to site', amount: 300, rule: 'Travel is not reimbursable under the agreement.' },
        ],
        secondLook: [
          { item: 'Construction Administration Services', amount: 1500, why: 'Billed at 25% while construction has not started.' },
          // Both said by Coaster's reading on a live run: the billing check's question, asked again.
          { item: 'Total contract fee shown as $48,000.00', why: 'The PO total is $14,800, but the invoice indicates the overall engagement is for $48,000, with $39,000 already billed.' },
          { item: 'Total billing to date: $40,500.00', why: 'The invoice shows a total contract fee of $48,000.00, but the purchase order only authorizes $14,800.00.' },
        ],
      },
    });
    const coaster = report.contract.issues.find(f => f.byCoaster);
    assert.deepStrictEqual(coaster.figures.rows.map(r => r.item), ['Travel to site']);
    assert.deepStrictEqual(report.secondLook.map(e => e.note), ['Billed at 25% while construction has not started.']);
    assert.ok(collectMarks(report).some(m => m.tone === 'amber' && m.title === 'Worth a second look'));
    assert.match(report.markdown, /Worth a second look/);
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
