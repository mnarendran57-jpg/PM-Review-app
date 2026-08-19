// The standard PDF fonts cannot encode every character, and pdf-lib RAISES rather than skipping.
//
// This is the regression test for a live failure: a review ran, was stored, and then every attempt
// to open its PDF came back 500, because a finding contained an arrow. Nothing in the review was
// wrong — the document simply could not be printed, and the PM saw no report at all.
//
// The exposure grew when a review started putting the model's own prose on the page. "5% -> 85%"
// and "~$800" are the natural way to write those things, and the glyphs a model reaches for are
// exactly the ones WinAnsi lacks.

const assert = require('node:assert');
const { StandardFonts, PDFDocument } = require('pdf-lib');
const { toWinAnsi, wrapLine } = require('../lib/pdfGen');
const { renderPayAppReportPdf } = require('../lib/payAppReportPdf');
const { buildReportDoc } = require('../lib/payAppReportDoc');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) {
    failures += 1; console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

// The characters that actually took the report down, plus the rest of the family.
const UNPRINTABLE = '→ ← ↔ ≈ ≠ ≤ ≥ − × ÷ ✅ ❌ … ‘ ’ “ ”';

(async () => {
  console.log('report PDF encoding');

  await test('every character pdf-lib refuses is translated or dropped', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const page = doc.addPage();
    const cleaned = toWinAnsi(UNPRINTABLE);
    // The real proof is that pdf-lib accepts it, not that it looks a particular way.
    page.drawText(cleaned, { x: 20, y: 700, size: 10, font });
    font.widthOfTextAtSize(cleaned, 10);
  });

  await test('the substitutions say what the character meant', () => {
    assert.match(toWinAnsi('5% → 85%'), /5% -> 85%/);
    assert.match(toWinAnsi('≈ $800'), /~ \$800/);
    assert.match(toWinAnsi('billed ≥ scheduled'), />= scheduled/);
    assert.match(toWinAnsi('−1,200.00'), /^-1,200\.00$/);
  });

  await test('characters WinAnsi does have are left alone', () => {
    const keep = 'Contract § 3.2.9 — retainage “held” at 5% • see p.7';
    assert.strictEqual(toWinAnsi(keep), keep);
  });

  await test('wrapLine sanitizes, so no caller has to remember to', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    // Throws on the unsanitized string; must not throw here.
    const lines = wrapLine(`progress ${UNPRINTABLE} this period`, font, 10, 400);
    for (const line of lines) font.widthOfTextAtSize(line, 10);
  });

  await test('a whole report whose findings are full of them still renders', async () => {
    const result = {
      verdict: 'do-not-certify',
      thisPeriod: 107255,
      deliveryMethod: 'CSP',
      notChecked: ['Retainage — no rate in the contract → could not be verified.'],
      stats: { checksRun: 38, passed: 30, critical: 1, failed: 2 },
      findings: [
        {
          id: 'G703_OVERBILL', severity: 'critical',
          title: 'A line is billed above the value the contract allocates to it',
          detail: 'A line is billed above the value the contract allocates to it. Billed to date '
            + '≈ 125% of the scheduled value, and the balance is ≤ 0.',
          expected: 8000, actual: 10000, difference: 2000,
          where: { description: 'Schedule line 2 — Procurement & Submittals' },
        },
        {
          id: 'PLAUSIBILITY', severity: 'note',
          title: 'Progress this month is worth a second look',
          detail: 'Progress this month is worth a second look. The line moves 5% → 85% in one '
            + 'month, which is ≥ what the crew could produce.',
          where: { description: 'Schedule line 7 — Ductwork' },
        },
      ],
    };
    const report = buildReportDoc({
      result,
      data: { current: { summary: { applicationNumber: 4, periodTo: '2025-08-31', line8: 107255 } } },
      projectName: 'Spring Branch AHU Replacement → Phase 2',
    });
    const pdf = await renderPayAppReportPdf({ report, companyName: 'Olivier Inc → Houston' });
    assert.ok(pdf.length > 1000, 'a PDF with content should come back');
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
