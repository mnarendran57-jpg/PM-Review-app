const assert = require('assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { tidy, combine, citeLabel, clauseFor } = require('../lib/contractClauses');
const { runPcoChecks } = require('../lib/pcoChecks');
const { buildPcoReport } = require('../lib/pcoReport');
const { addMarkedPages } = require('../lib/pcoMarkup');

// A change order checked against a contract cites where in the contract each finding comes from.
// No API call is made: the clauses below stand in for what lib/contractClauses.js reads.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

const clauses = {
  tax: { section: 'Section 3.6', heading: 'Taxes', page: 4, quote: 'The Contractor shall not include sales tax in any Change Order.' },
  markups: { section: 'Section 7.4', heading: 'Markup on Changes', page: 12, quote: 'Contractor 10%, Subcontractor 10%, second-tier 5%.', subRate: 0.10, secondTierRate: 0.05 },
  allowances: null,
  costRules: [{ item: 'Overtime premium', rule: 'Overtime needs written direction first', section: 'Section 7.3', page: 11,
    quote: 'Overtime premium is not reimbursable unless the Owner directed the overtime in writing before the work was performed.' }],
};
const terms = { taxExempt: true, taxExemptBasis: 'Owner is exempt', unallowableItems: [], clauses: clauses };
const pco = {
  pcoNumber: '021', totalAmount: 1000, taxAmount: 80,
  lineItems: [{ description: 'Overtime premium, weekend installation', total: 900 }],
  markups: [{ label: 'Subcontractor markup (Lone Star)', tier: 'sub', rate: 0.15, base: 1000, amount: 150 }],
};
const rows = (results, id) => results.find(r => r.id === id)?.figures?.rows || [];

(async () => {
  await check('a clause is kept only with its words, and its page counted from the start of the contract', () => {
    const t = tidy({ tax: { section: 'Section 3.6', page: 2, quote: ' No tax. ' }, markups: { section: '7.4' } }, 41);
    assert.deepStrictEqual(t.tax, { quote: 'No tax.', section: 'Section 3.6', page: 42 });
    assert.strictEqual(t.markups, null, 'a section with no quote is not a citation');
  });

  await check('across passes, each clause comes whole from the first pass that found it', () => {
    const c = combine([
      tidy({ costRules: [{ item: 'Overtime', quote: 'a' }] }),
      tidy({ tax: { section: 'Section 3.6', quote: 'b' }, costRules: [{ item: 'overtime', quote: 'c' }, { item: 'Bonds', quote: 'd' }] }),
      tidy({ tax: { section: 'Article 9', page: 3, quote: 'e' } }),
    ]);
    assert.deepStrictEqual(c.tax, { quote: 'b', section: 'Section 3.6' });
    assert.deepStrictEqual(c.costRules.map(r => r.quote), ['a', 'd']);
  });

  await check('the label reads as the contract prints it', () => {
    assert.strictEqual(citeLabel(clauses.markups), 'Section 7.4 Markup on Changes, page 12');
    assert.strictEqual(citeLabel({ quote: 'x', page: 3 }), 'page 3');
    assert.strictEqual(citeLabel({ quote: 'x' }), null);
  });

  await check('tax, markup and forbidden-cost findings carry their clause', () => {
    const results = runPcoChecks({ pco, contractTerms: terms, markupPolicy: null });
    assert.strictEqual(rows(results, 'T1')[0].clause.section, 'Section 3.6');
    assert.strictEqual(rows(results, 'A2')[0].clause.page, 12);
    assert.strictEqual(rows(results, 'A2')[0].basis, null);
    assert.strictEqual(rows(results, 'C1')[0].clause.section, 'Section 7.3');
  });

  await check('the markup limit is the contract\'s own when it states one', () => {
    const own = { ...terms, clauses: { ...clauses, markups: { ...clauses.markups, subRate: 0.2 } } };
    const results = runPcoChecks({ pco, contractTerms: own, markupPolicy: null });
    assert.strictEqual(results.find(r => r.id === 'A2').status, 'PASS', '15% is inside the contract\'s 20%');
  });

  await check('a limit the contract does not state is said to be Coaster\'s, and cites nothing', () => {
    const silent = { ...terms, clauses: { ...clauses, markups: null } };
    const [row] = rows(runPcoChecks({ pco, contractTerms: silent, markupPolicy: null }), 'A2');
    assert.strictEqual(row.clause, null);
    assert.match(row.basis, /Coaster's usual limit/);
  });

  await check('a contract read before clauses were recorded still reviews, without citations', () => {
    const results = runPcoChecks({ pco, contractTerms: { taxExempt: true, unallowableItems: [] }, markupPolicy: null });
    assert.strictEqual(results.find(r => r.id === 'T1').status, 'FAIL');
    assert.strictEqual(rows(results, 'T1')[0].clause, null);
  });

  await check("Coaster's own flag keeps a quote only when the contract says it", () => {
    const real = clauseFor({ quote: 'Overtime premium is not reimbursable unless the Owner directed the overtime in writing' }, terms);
    assert.strictEqual(real.section, 'Section 7.3');
    assert.strictEqual(clauseFor({ quote: 'Weekend work is never paid for by the Owner.' }, terms), null);
    assert.strictEqual(clauseFor({ quote: 'short' }, terms), null);
  });

  await check('the report shows the clause, a stored review keeps it, and nothing is flagged twice', () => {
    const results = runPcoChecks({ pco, contractTerms: terms, markupPolicy: null }, { groups: ['math', 'contract', 'backup'] });
    const observations = { contractConcerns: [
      // Already caught by the forbidden-cost check, from the same clause.
      { item: 'Weekend overtime', amount: 900, rule: 'Needs written direction', section: '7.3',
        clause: clauseFor({ quote: 'not reimbursable unless the Owner directed the overtime in writing' }, terms) },
      // Coaster's alone, with the clause it was found in when the review ran.
      { item: 'Bond premium', amount: 40, rule: 'Bonds are in the contract sum',
        clause: { section: 'Section 5.2', page: 9, quote: 'Bond premiums are included in the Contract Sum.' } },
    ] };
    // Rebuilt the way a stored review is: without the contract's terms to hand.
    const report = buildPcoReport({ data: { pco, contractTerms: null }, results, observations, reference: null,
      checkedAgainst: { contract: true, reference: false }, contractLabel: 'Owner-Contractor Agreement' });
    const coaster = report.contract.issues.find(f => f.byCoaster);
    assert.deepStrictEqual(coaster.figures.rows.map(r => r.item), ['Bond premium']);
    assert.strictEqual(coaster.figures.rows[0].clause.page, 9);
    const c1 = report.contract.issues.find(f => f.id === 'C1').figures.rows[0];
    assert.strictEqual(c1.item, 'Overtime premium, weekend installation');
    assert.strictEqual(c1.amount, 900);
    assert.strictEqual(c1.rule, 'Overtime needs written direction first');
    assert.match(report.markdown, /Contract, Section 3\.6 Taxes, page 4: "The Contractor shall not include sales tax/);
    assert.strictEqual(rows(results, 'T1')[0].basis, null, 'the clause says it; no summary beside it');
  });

  await check('the marked-up page notes where in the contract each mark comes from', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Overtime premium, weekend installation', { x: 50, y: 690, size: 10, font });
    page.drawText('$900.00', { x: 480, y: 690, size: 10, font });
    page.drawText('Sales tax', { x: 50, y: 660, size: 10, font });
    page.drawText('$80.00', { x: 480, y: 660, size: 10, font });
    const results = runPcoChecks({ pco, contractTerms: terms, markupPolicy: null }, { groups: ['contract'] });
    const report = buildPcoReport({ data: { pco, contractTerms: terms }, results, observations: {}, reference: null,
      checkedAgainst: { contract: true, reference: false } });
    const target = await PDFDocument.create();
    const out = await addMarkedPages(target, { pdfBuffer: Buffer.from(await doc.save()), report, pco });
    assert.ok(out.placed >= 2, `placed ${out.placed}`);
    if (process.env.MARKUP_SAMPLES) {
      require('fs').writeFileSync(require('path').join(process.env.MARKUP_SAMPLES, 'markup-cite.pdf'), Buffer.from(await target.save()));
    }
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
