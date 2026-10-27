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

  await check('never assumed from the numbers alone: billing before the invoice past the PO is a question, not this invoice\'s fault', () => {
    const b = billingFor({ value: 14800, invoice });
    assert.strictEqual(b.carriedOver, 0);
    const po2 = runInvoiceChecks({ invoice, contractTerms: poTerms(), billing: b, duplicates: [] }, { groups: ['contract'] })
      .find(x => x.id === 'PO2');
    assert.deepStrictEqual([po2.status, po2.critical, po2.title], ['FAIL', false, 'Billed before this invoice is more than this PO']);
    assert.match(po2.figures.summary, /\$39,000\.00 billed before it — already more than this \$14,800\.00 PO/);
    assert.match(po2.figures.summary, /If an earlier PO covered the first \$33,200\.00 of the \$48,000\.00 fee, \$7,300\.00 of this PO has been used with this invoice and \$7,500\.00 is left/);
    assert.match(po2.figures.summary, /Already paid under an earlier PO/);
    assert.strictEqual(po2.figures.markOn, 'prior');
  });

  await check('when this invoice is the one that goes past the PO, it is a red flag on its amount', () => {
    const small = { ...invoice, total: 9000, previouslyBilled: 10000, feeTotal: null, phases: [] };
    const po2 = runInvoiceChecks({ invoice: small, contractTerms: poTerms(), billing: billingFor({ value: 14800, invoice: small }), duplicates: [] }, { groups: ['contract'] })
      .find(x => x.id === 'PO2');
    assert.deepStrictEqual([po2.status, po2.critical, po2.title], ['FAIL', true, undefined]);
    const report = buildInvoiceReport({ data: { invoice: small }, results: [po2], observations: {}, contractChosen: true });
    const mark = collectMarks(report).find(m => m.title === 'Billing goes past what the agreement is worth');
    assert.deepStrictEqual([mark.tone, mark.amount], ['red', 9000]);
  });

  await check('on Invoice 5680 the mark sits on the $39,000 billed before, in amber, and the verdict is a check, not a stop', async () => {
    const { renderInvoiceReportPdf } = require('../lib/invoiceReportPdf');
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    // Through the same path a review takes, which sets the PO's cost rules aside.
    const { terms } = combineAgreements([{ id: 1, label: PO_LABEL, docType: 'contract', terms: poTerms() }]);
    const results = runInvoiceChecks({ invoice, contractTerms: terms, billing: billingFor({ value: 14800, invoice }), duplicates: [] });
    const report = buildInvoiceReport({ data: { invoice }, results, observations: {}, contractChosen: true, contractLabel: PO_LABEL, agreement: 'architect' });
    assert.match(report.verdict.headline, /to check before paying/);
    const mark = collectMarks(report).find(m => m.title === 'Billed before this invoice is more than this PO');
    assert.deepStrictEqual([mark.tone, mark.amount], ['amber', 39000]);
    // The invoice, drawn: the fee table's previous-billing total is where the mark must land.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    [['Professional Engineering Services from 04/21/2026 to 10/20/2026', '', '$1,500.00', 700],
      ['Construction Administration Services', '$1,000.00', '$1,500.00', 640],
      ['Total', '$39,000.00', '$1,500.00', 620]].forEach(([d, prev, cur, y]) => {
      page.drawText(d, { x: 40, y, size: 9, font });
      if (prev) page.drawText(prev, { x: 400, y, size: 9, font });
      page.drawText(cur, { x: 500, y, size: 9, font });
    });
    const pdf = await renderInvoiceReportPdf({ report, sources: [{ name: '5680.pdf', buffer: Buffer.from(await doc.save()) }] });
    if (process.env.MARKUP_SAMPLES) require('fs').writeFileSync(require('path').join(process.env.MARKUP_SAMPLES, 'invoice-5680-fixed.pdf'), pdf);
    const { eachPage } = require('../lib/pdfTextLayer');
    const text = (await eachPage(pdf, async p => (await p.getTextContent()).items.map(i => i.str).join(' '))).join(' ');
    assert.match(text, /already more than this \$14,800\.00 PO/, 'the explanation is in the PDF');
    assert.match(text, /Page 1 of the invoice · 1 finding marked/);
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
