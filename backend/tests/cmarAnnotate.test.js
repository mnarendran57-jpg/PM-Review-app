const assert = require('assert');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const {
  buildMarkedUpPacket, markable, markGeometry, findAnchor, findPhrase, figuresIn, firmHandles,
} = require('../lib/cmarAnnotate');

// Marking the contractor's packet with the findings.
//
// THE BUG THESE EXIST FOR
//
// A pay application is full of landscape sheets saved as portrait pages with /Rotate 90, and on
// those the text is drawn SIDEWAYS in the page's own coordinates so it reads correctly once the
// viewer turns the page. Measured on a real packet, a figure on the certificate has the text
// matrix [0, 6.24, -6.24, 0, 520.92, 454.2] — it advances straight UP the y axis — where a flat
// page gives [7, 0, 0, 7, ...] and advances along x.
//
// The first version assumed every run was horizontal. The mark came out ninety degrees off and
// offset sideways out of the figure, straddling the rows above and below it, on exactly the pages
// that matter most: the certificate and the continuation sheet. Everything below is about never
// shipping that again.

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

console.log('\nThe mark follows the direction the text runs:');

check('on a flat page the mark centres along x', () => {
  // [7,0,0,7,...]: advances along +x. A 30-wide run at x=100 centres at x=115.
  const g = markGeometry({ x: 100, y: 200, w: 30, h: 7, angle: 0 });
  assert.ok(near(g.cx, 115), `cx should be 115, got ${g.cx}`);
  assert.ok(near(g.cy, 200 + 7 / 3), `cy should sit just above the baseline, got ${g.cy}`);
  assert.strictEqual(g.angle, 0);
});

check('on a sideways page the mark centres along y, not x', () => {
  // The real matrix from the Carver certificate: angle = atan2(6.24, 0) = 90 degrees.
  const angle = Math.atan2(6.24, 0);
  const g = markGeometry({ x: 520.92, y: 454.2, w: 24.2, h: 6.24, angle });

  // It must travel UP the run, not across it. This is the assertion the old code failed.
  assert.ok(near(g.cy, 454.2 + 24.2 / 2), `cy should advance along the run, got ${g.cy}`);
  assert.ok(near(g.cx, 520.92 - 6.24 / 3), `cx should barely move, got ${g.cx}`);
  assert.ok(near(g.angle, Math.PI / 2), 'the ellipse must be turned to match the text');
});

check('a horizontal assumption would miss a sideways figure entirely', () => {
  // What the old code computed, kept as a guard: if this ever equals the right answer again,
  // the direction has stopped being taken into account.
  const angle = Math.atan2(6.24, 0);
  const correct = markGeometry({ x: 520.92, y: 454.2, w: 24.2, h: 6.24, angle });
  const naive = { cx: 520.92 + 24.2 / 2, cy: 454.2 + 6.24 / 3 };
  assert.ok(Math.abs(correct.cx - naive.cx) > 10,
    'the correct centre must differ from the horizontal assumption');
  assert.ok(Math.abs(correct.cy - naive.cy) > 8);
});

check('a page rotated the other way is handled too', () => {
  const angle = Math.atan2(-6.24, 0);                 // 270 degrees
  const g = markGeometry({ x: 300, y: 400, w: 20, h: 6, angle });
  assert.ok(near(g.cy, 400 - 10), `cy should advance downward, got ${g.cy}`);
  assert.ok(near(g.cx, 300 + 2), `cx should barely move, got ${g.cx}`);
});

check('the ellipse is never smaller than a readable minimum', () => {
  const g = markGeometry({ x: 0, y: 0, w: 1, h: 1, angle: 0 });
  assert.ok(g.xScale >= 14 && g.yScale >= 8, 'a tiny run still gets a visible ring');
});

console.log('\nFinding what a finding is talking about:');

const PAGES = [{
  pageIndex: 0,
  items: [
    { str: '$1,120.00', norm: '1120.00', x: 520, y: 454, w: 24, h: 6, angle: Math.PI / 2 },
    { str: 'Subscribed and sworn to before me this 31st day of July, 2026', norm: 'Subscribedandswornto', x: 300, y: 300, w: 200, h: 7, angle: Math.PI / 2 },
    { str: 'Integrated Demolition and Remediation Inc.', norm: 'IntegratedDemolition', x: 60, y: 700, w: 180, h: 8, angle: 0 },
  ],
}];

check('a dollar figure in the finding is matched to the page', () => {
  const a = findAnchor(PAGES, '$1,120.00', new Set());
  assert.ok(a, 'the figure should be found');
  assert.strictEqual(a.x, 520);
  assert.ok(near(a.angle, Math.PI / 2), 'the run direction must come back with it');
});

check('the same figure is never marked twice', () => {
  const used = new Set();
  assert.ok(findAnchor(PAGES, '$1,120.00', used));
  assert.strictEqual(findAnchor(PAGES, '$1,120.00', used), null,
    'a second finding must not stack a mark on the first one');
});

check('a finding with no figure is placed by the words it names', () => {
  // The notary finding and an early certification carry no money at all. Before phrases, both
  // ended up on the cover page — which is where they are least use.
  const a = findPhrase(PAGES, 'subscribed and sworn', new Set());
  assert.ok(a, 'the notary block should be found by its wording');
  assert.strictEqual(a.y, 300);
});

check('a firm is found by the short name a schedule uses', () => {
  const handles = firmHandles('Integrated Demolition and Remediation Inc.');
  assert.ok(handles.includes('idr') || handles.includes('IDR'),
    `the acronym should be among the handles, got ${handles.join(', ')}`);
  assert.ok(!handles.some(h => /^(inc|and)$/i.test(h)), 'noise words must not become handles');
});

check('figures are pulled out of a finding\'s own words', () => {
  const found = figuresIn('The form states $1,830,900.00. Line 4 less Line 5 gives $1,825,900.00.');
  assert.deepStrictEqual(found, ['$1,830,900.00', '$1,825,900.00']);
});

console.log('\nWhat gets marked:');

const REPORT = {
  header: { projectName: 'Carver High School', applicationNumber: '9' },
  headline: [
    { question: 'Is the notarization correct?', status: 'fail', detail: 'No notary seal is visible.' },
    { question: 'Is the pay application number correct?', status: 'pass', detail: 'No. 9 throughout.' },
  ],
  issues: [{ title: 'No application is certified before the period it covers', detail: 'IDR signed early.', firms: ['Integrated Demolition and Remediation Inc.'] }],
  subcontractors: [
    { firmName: 'Sendero Industries, L.L.C.', ties: true, variance: 0 },
    { firmName: 'Overbill Co', ties: false, variance: 5000, subGrossThisPeriod: 25000, sovThisPeriod: 20000 },
  ],
  worthNoting: { findings: [], untraceable: [], observations: [], unreadablePages: [] },
  tax: null,
  actions: [],
  invoiceConcerns: [],
  summary: { certifiable: false, issueCount: 2, mathOnly: true, paymentDue: 486050 },
  numbers: { lines: [], categories: [], thisPeriodTotal: 0 },
};

check('only failures are marked — a passing check is not', () => {
  const marks = markable(REPORT);
  assert.ok(marks.some(m => /notarization/i.test(m.title)));
  assert.ok(!marks.some(m => /application number/i.test(m.title)),
    'a check that passed must not be marked on the packet');
});

check('a subcontractor that reconciles is not marked', () => {
  const marks = markable(REPORT);
  assert.ok(!marks.some(m => /Sendero/.test(m.title)),
    'marking a firm that ties is the false positive this whole module guards against');
  assert.ok(marks.some(m => /Overbill Co/.test(m.title)));
});

check('the notary finding carries the words that locate it', () => {
  const notary = markable(REPORT).find(m => /notarization/i.test(m.title));
  assert.ok((notary.phrases || []).some(p => /subscribed and sworn/i.test(p)));
});

// --- Against a real PDF -------------------------------------------------------------------

async function buildTestPdf({ rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (rotate) page.setRotation(degrees(rotate));
  page.drawText('CURRENT PAYMENT DUE', { x: 60, y: 600, size: 10, font });
  page.drawText('$486,050.00', { x: 300, y: 600, size: 10, font });
  page.drawText('Subscribed and sworn to before me', { x: 60, y: 500, size: 10, font });
  return Buffer.from(await doc.save());
}

(async () => {
  console.log('\nAgainst a real PDF:');

  const run = async (name, fn) => {
    try { await fn(); console.log(`  PASS  ${name}`); passed += 1; } catch (err) {
      console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); failed += 1;
    }
  };

  await run('a marked-up copy is produced and keeps the original pages', async () => {
    const original = await buildTestPdf();
    const out = await buildMarkedUpPacket({
      pdfBuffer: original,
      report: { ...REPORT, issues: [{ title: 'Payment due is wrong', detail: 'States $486,050.00.' }] },
    });
    const doc = await PDFDocument.load(out.buffer);
    assert.strictEqual(doc.getPageCount(), 2, 'one findings page prepended to the one original page');
    assert.ok(out.buffer.length > original.length, 'the marked copy carries more than the original');
  });

  await run('a finding whose figure is on the page is placed on it', async () => {
    const out = await buildMarkedUpPacket({
      pdfBuffer: await buildTestPdf(),
      report: { ...REPORT, headline: [], subcontractors: [], issues: [{ title: 'Payment due', detail: 'States $486,050.00.' }] },
    });
    assert.strictEqual(out.placedCount, 1, 'the figure is on the page, so the finding belongs on it');
  });

  await run('a finding naming no figure is still placed on the page, via its words', async () => {
    // The gap a mutation found: findPhrase was tested on its own but nothing proved the markup
    // actually used it. Removing the phrase lookup entirely passed every other check here, while
    // silently sending the notary finding — one of the two that matter most on a real packet —
    // back to the cover page.
    const out = await buildMarkedUpPacket({
      pdfBuffer: await buildTestPdf(),
      report: {
        ...REPORT,
        headline: [{ question: 'Is the notarization correct?', status: 'fail', detail: 'No notary seal is visible.' }],
        issues: [], subcontractors: [],
      },
    });
    assert.strictEqual(out.findingCount, 1);
    assert.strictEqual(out.placedCount, 1,
      'the notary block is named on the page, so the finding belongs on it, not on the cover');
  });

  await run('a sideways page is marked too, not skipped', async () => {
    const out = await buildMarkedUpPacket({
      pdfBuffer: await buildTestPdf({ rotate: 90 }),
      report: { ...REPORT, headline: [], subcontractors: [], issues: [{ title: 'Payment due', detail: 'States $486,050.00.' }] },
    });
    assert.strictEqual(out.placedCount, 1, 'rotation must not stop a finding being placed');
  });

  await run('a packet with no readable text still produces a usable document', async () => {
    // A scan: nothing to anchor to. The copy must still open with every finding listed, rather
    // than being an unmarked duplicate of the packet pretending to be a markup.
    const blank = await PDFDocument.create();
    blank.addPage([612, 792]);
    const out = await buildMarkedUpPacket({
      pdfBuffer: Buffer.from(await blank.save()),
      report: REPORT,
    });
    assert.strictEqual(out.placedCount, 0);
    assert.ok(out.findingCount >= 2, 'the findings must still be counted and listed');
    const doc = await PDFDocument.load(out.buffer);
    assert.strictEqual(doc.getPageCount(), 2, 'the findings page is still there');
  });

  await run('a clean audit produces a copy that says so', async () => {
    const out = await buildMarkedUpPacket({
      pdfBuffer: await buildTestPdf(),
      report: {
        ...REPORT,
        headline: [{ question: 'Is the notarization correct?', status: 'pass', detail: 'Signed and sealed.' }],
        issues: [], subcontractors: [],
        summary: { ...REPORT.summary, certifiable: true, issueCount: 0 },
      },
    });
    assert.strictEqual(out.findingCount, 0);
    assert.strictEqual(out.placedCount, 0);
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
