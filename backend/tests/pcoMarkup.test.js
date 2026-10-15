const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const {
  addMarkedPages, collectMarks, locate, moneyForms, subRun, viewTransform, ovalFor,
} = require('../lib/pcoMarkup');

// Where the marked-up change order puts its marks. No API call is made anywhere in this file: the
// change orders are drawn here, and the report handed in is written by hand.
//
// Set MARKUP_SAMPLES to a folder to also save each drawn page there, for looking at.

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}

// A change order drawn in a proportional font, one run per column, the way estimating software
// prints them — not the one-run-per-line layout of a typewriter font.
async function changeOrder({ rotate = 0, extraPages = 0, scan = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let e = 0; e < extraPages; e++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Backup page ${e + 1} — delivery tickets`, { x: 50, y: 740, size: 11, font });
  }
  const page = doc.addPage([612, 792]);
  if (!scan) {
    const rows = [
      ['Copper pipe, 2 inch type L', '200', 'LF', '$30.00', '$6,500.00'],
      ['Rooftop unit, 10 ton', '1', 'EA', '$22,000.00', '$22,000.00'],
      ['Crane and rigging', '', 'LS', '', '$5,000.00'],
    ];
    page.drawText('POTENTIAL CHANGE ORDER   PCO No. 044', { x: 50, y: 740, size: 13, font });
    rows.forEach((r, i) => {
      const y = 690 - i * 22;
      page.drawText(r[0], { x: 50, y, size: 10, font });
      page.drawText(r[1], { x: 300, y, size: 10, font });
      page.drawText(r[2], { x: 340, y, size: 10, font });
      page.drawText(r[3], { x: 390, y, size: 10, font });
      page.drawText(r[4], { x: 480, y, size: 10, font });
    });
    page.drawText('TOTAL THIS PCO', { x: 390, y: 600, size: 10, font });
    page.drawText('$34,000.00', { x: 480, y: 600, size: 10, font });
  }
  if (rotate) page.setRotation(degrees(rotate));
  return Buffer.from(await doc.save());
}

const pco = {
  pcoNumber: '044',
  lineItems: [
    { description: 'Copper pipe, 2 inch type L', qty: 200, unitPrice: 30, total: 6500 },
    { description: 'Rooftop unit, 10 ton', qty: 1, unitPrice: 22000, total: 22000 },
    { description: 'Crane and rigging', total: 5000 },
  ],
  markups: [],
};
const report = {
  header: { pcoNumber: '044' },
  math: { issues: [
    { id: 'P1', title: 'The total does not add up', figures: { rows: [{ item: 'Total requested', shown: 34000, computed: 33500, difference: 500 }] } },
    { id: 'P2', title: 'Line totals', figures: { rows: [{ item: 'Copper pipe, 2 inch type L', working: '200 LF × $30.00', shown: 6500, computed: 6000, difference: 500 }] } },
  ] },
  contract: null,
  scope: null,
  askFor: [{ item: 'Crane and rigging', amount: 5000 }],
  alternatives: { lines: [{ description: 'Rooftop unit, 10 ton', amount: 22000, options: [{ name: 'Split system', costDifference: '10% to 20% less', isSaving: true }] }] },
};

async function save(name, buffer) {
  if (!process.env.MARKUP_SAMPLES) return;
  fs.writeFileSync(path.join(process.env.MARKUP_SAMPLES, name), buffer);
}

(async () => {
  await check('a figure inside a longer one is not a match', () => {
    const item = { str: 'Fan $11,800.00 and labour $1,800.00', x: 0, y: 0, w: 350, h: 10, angle: 0 };
    const box = subRun(item, '1,800.00');
    assert.ok(box, 'the whole $1,800.00 should be found');
    assert.ok(box.x > 200, 'and it is the one at the end, not the tail of $11,800.00');
    assert.strictEqual(subRun({ ...item, str: 'Fan $11,800.00' }, '1,800.00'), null);
  });

  await check('an amount is looked for in the ways it is printed', () => {
    assert.deepStrictEqual(moneyForms(22000).slice(0, 2), ['22,000.00', '22000.00']);
    assert.deepStrictEqual(moneyForms(0), []);
  });

  await check('the figures are found on the row their words are on, rightmost first', async () => {
    const buffer = await changeOrder();
    const { eachPage } = require('../lib/pdfTextLayer');
    const pages = await eachPage(buffer, async (page, p) => {
      const c = await page.getTextContent();
      return {
        pageIndex: p - 1,
        items: c.items.filter(i => i.str.trim()).map(i => ({
          str: i.str.trim(), x: i.transform[4], y: i.transform[5],
          angle: Math.atan2(i.transform[1], i.transform[0]), w: i.width, h: i.height || 9,
        })),
      };
    });
    const used = new Set();
    const rooftop = locate(pages, { amount: 22000, phrase: 'Rooftop unit, 10 ton' }, used);
    assert.ok(rooftop.x > 470, `the extended total, not the unit price (x=${Math.round(rooftop.x)})`);
    assert.strictEqual(Math.round(rooftop.y), 668);
    const copper = locate(pages, { amount: 6500, phrase: 'Copper pipe' }, used);
    assert.strictEqual(Math.round(copper.y), 690);
    // A second finding about the copper line lands on the same spot.
    const again = locate(pages, { amount: 6500, phrase: 'Copper pipe' }, used);
    assert.strictEqual(again.key, copper.key);
  });

  await check('every finding becomes a numbered mark, in report order', () => {
    const marks = collectMarks(report, pco);
    assert.deepStrictEqual(marks.map(m => m.number), [1, 2, 3, 4]);
    assert.deepStrictEqual(marks.map(m => m.tone), ['red', 'red', 'amber', 'indigo']);
  });

  await check('a marked page is added for the page with findings, and nothing for the rest', async () => {
    const original = await changeOrder({ extraPages: 3 });
    const target = await PDFDocument.create();
    target.addPage();                                   // the report's own page
    const result = await addMarkedPages(target, { pdfBuffer: original, report, pco });
    assert.strictEqual(result.placed, 4);
    assert.strictEqual(target.getPageCount(), 2, 'one report page and one marked page, not the backup');
    const marked = target.getPage(1);
    assert.ok(marked.getWidth() > 612, 'the notes column is added beside the page, not over it');
    await save('markup-flat.pdf', Buffer.from(await target.save()));
  });

  await check('a scanned change order adds no pages and does not fail', async () => {
    const target = await PDFDocument.create();
    const result = await addMarkedPages(target, { pdfBuffer: await changeOrder({ scan: true }), report, pco });
    assert.strictEqual(result.placed, 0);
    assert.strictEqual(target.getPageCount(), 0);
  });

  await check('a sideways page is turned upright, and its marks land on its figures', async () => {
    // A point at the page's own (480, 668) — the rooftop unit's total — seen on a page turned 90°.
    const view = viewTransform(90, 612, 792);
    assert.deepStrictEqual([view.vw, view.vh], [792, 612]);
    const oval = ovalFor({ x: 480, y: 668, w: 55, h: 10, angle: 0 }, view, 0, 0);
    assert.ok(Math.abs(oval.cx - (668 + 10 / 3)) < 1, `across: ${oval.cx}`);
    assert.ok(Math.abs(oval.cy - (612 - 480 - 27.5)) < 1, `down: ${oval.cy}`);

    const target = await PDFDocument.create();
    const result = await addMarkedPages(target, { pdfBuffer: await changeOrder({ rotate: 90 }), report, pco });
    assert.strictEqual(result.placed, 4);
    const page = target.getPage(0);
    assert.strictEqual(Math.round(page.getHeight()), 612 + 44, 'drawn upright: as tall as the page is wide');
    await save('markup-rotated.pdf', Buffer.from(await target.save()));
  });

  await check('with nothing to mark, nothing is added', async () => {
    const target = await PDFDocument.create();
    const empty = { header: {}, math: { issues: [] }, askFor: [], alternatives: null };
    const result = await addMarkedPages(target, { pdfBuffer: await changeOrder(), report: empty, pco });
    assert.strictEqual(result.marks, 0);
    assert.strictEqual(target.getPageCount(), 0);
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
