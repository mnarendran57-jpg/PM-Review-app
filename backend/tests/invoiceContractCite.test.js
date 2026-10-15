const assert = require('assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runInvoiceChecks } = require('../lib/invoiceChecks');
const { buildInvoiceReport } = require('../lib/invoiceReport');
const { renderInvoiceReportPdf } = require('../lib/invoiceReportPdf');
const { collectMarks } = require('../lib/invoiceMarkup');

// An invoice checked against the architect's or the contractor's agreement cites where in it each
// finding comes from, and its PDF carries the invoice marked up. No API call is made: the clauses
// below stand in for what lib/contractClauses.js reads.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

const clauses = {
  tax: { section: 'Article 11.5', heading: 'Taxes', page: 6, quote: 'The Owner is exempt from sales tax; no sales tax shall be billed.' },
  contractSum: { section: 'Article 11.1', heading: 'Compensation', page: 5, quote: 'The Architect shall be paid a fixed fee of $48,000.', amount: 48000 },
  reimbursables: { section: 'Article 11.8', heading: 'Reimbursable Expenses', page: 7, backupRequired: true,
    quote: 'Reimbursable Expenses shall be billed at cost with receipts attached.' },
  costRules: [{ item: 'Meals', rule: 'Meals are not reimbursable', section: 'Article 11.8.3', page: 7,
    quote: 'Meals and entertainment are not Reimbursable Expenses.' }],
};
const terms = { taxExempt: true, originalContractSum: 48000, unallowableItems: [], clauses };
const invoice = {
  vendor: 'Studio Arc Architects', invoiceNumber: 'A-1042', poNumber: null, total: 12950, taxAmount: 250,
  lineItems: [
    { description: 'Design development phase, 25% complete', total: 12000 },
    { description: 'Printing and plotting', total: 500, isReimbursable: true, hasBackup: false },
    { description: 'Meals during site visits', total: 200, isReimbursable: true, hasBackup: true },
  ],
};
const billing = { contractValue: 48000, priorBilled: 40000, priorCount: 3 };
const rows = (results, id) => results.find(r => r.id === id)?.figures?.rows || [];

async function invoicePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const line = (t, a, y) => { page.drawText(t, { x: 50, y, size: 10, font }); page.drawText(a, { x: 470, y, size: 10, font }); };
  page.drawText('STUDIO ARC ARCHITECTS      INVOICE A-1042', { x: 50, y: 740, size: 12, font });
  line('Design development phase, 25% complete', '$12,000.00', 690);
  line('Printing and plotting', '$500.00', 670);
  line('Meals during site visits', '$200.00', 650);
  line('Sales tax', '$250.00', 630);
  line('TOTAL DUE', '$12,950.00', 600);
  return Buffer.from(await doc.save());
}

(async () => {
  const results = runInvoiceChecks({ invoice, contractTerms: terms, billing, duplicates: [] });

  await check('tax, forbidden-cost, receipt and agreement-value findings carry their clause', () => {
    assert.strictEqual(rows(results, 'T1')[0].clause.section, 'Article 11.5');
    assert.strictEqual(rows(results, 'T1')[0].basis, null);
    const meals = rows(results, 'C1')[0];
    assert.deepStrictEqual([meals.item, meals.amount, meals.rule, meals.clause.page], ['Meals during site visits', 200, 'Meals are not reimbursable', 7]);
    assert.strictEqual(rows(results, 'R1')[0].clause.heading, 'Reimbursable Expenses');
    assert.strictEqual(rows(results, 'PO2')[0].clause.section, 'Article 11.1');
  });

  await check('a receipt is good practice, not a clause, when the agreement does not ask for one', () => {
    const silent = { ...terms, clauses: { ...clauses, reimbursables: null } };
    assert.strictEqual(rows(runInvoiceChecks({ invoice, contractTerms: silent, duplicates: [] }), 'R1')[0].clause, null);
  });

  const report = buildInvoiceReport({
    data: { invoice, contractTerms: terms }, results,
    observations: { contractConcerns: [
      { item: 'Meals during site visits', amount: 200, rule: 'Meals are not paid for', quote: 'Meals and entertainment are not Reimbursable Expenses.' },
      { item: 'Design development phase', amount: 12000, rule: 'Billed ahead of the phase schedule',
        clause: { section: 'Article 11.4', page: 6, quote: 'Fees are billed monthly in proportion to services performed.' } },
    ] },
    contractChosen: true, contractLabel: 'Owner-Architect Agreement', agreement: 'architect',
  });

  await check("the report names whose agreement it was, and does not flag one cost twice", () => {
    assert.strictEqual(report.contract.title, "Architect's contract / PO");
    assert.match(report.header.checkedAgainst.join(', '), /the architect's contract or PO \(Owner-Architect Agreement\)/);
    const coaster = report.contract.issues.find(f => f.byCoaster);
    assert.deepStrictEqual(coaster.figures.rows.map(r => r.item), ['Design development phase']);
    assert.match(report.markdown, /Contract, Article 11\.8 Reimbursable Expenses, page 7: "Reimbursable Expenses shall be billed at cost/);
  });

  await check('every finding becomes a mark, and contract marks carry their clause', () => {
    const marks = collectMarks(report);
    const titles = marks.map(m => m.title);
    assert.ok(titles.includes('No receipt for this cost'));
    assert.ok(titles.includes('Billing goes past what the agreement is worth'));
    assert.ok(marks.filter(m => m.cite).length >= 4, `${marks.filter(m => m.cite).length} cited`);
  });

  await check('the PDF carries the invoice marked up after the report', async () => {
    const pdf = await renderInvoiceReportPdf({ report, sources: [{ name: 'A-1042.pdf', buffer: await invoicePdf() }] });
    const doc = await PDFDocument.load(pdf);
    const last = doc.getPage(doc.getPageCount() - 1);
    assert.ok(last.getWidth() > 612, 'the last page is the marked-up invoice, with its notes column');
    if (process.env.MARKUP_SAMPLES) require('fs').writeFileSync(require('path').join(process.env.MARKUP_SAMPLES, 'invoice-cite.pdf'), pdf);
  });

  await check('a math-only review has no contract section and still marks its math', async () => {
    const math = runInvoiceChecks({ invoice: { ...invoice, total: 13000 }, contractTerms: null, duplicates: [] },
      { groups: ['math', 'backup', 'history'] });
    const r = buildInvoiceReport({ data: { invoice: { ...invoice, total: 13000 }, contractTerms: null }, results: math, observations: {} });
    assert.strictEqual(r.contract, null);
    assert.ok(collectMarks(r).some(m => m.title === 'The total does not add up'));
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
