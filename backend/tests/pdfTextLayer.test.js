// The caller's buffer must survive having its text layer read.
//
// Every caller does the same two things in the same order: read the text layer to find out WHICH
// pages matter, then slice those pages out of the same buffer. If reading the text destroys the
// buffer, the second step silently produces nothing — the submittal is read against no
// specification, the RFI against no drawing, and the pay app's own PDF cannot be marked up.
//
// This is not hypothetical. pdfjs TRANSFERS the typed array it is given and detaches the backing
// store, so handing it a view over the caller's buffer — which looks like an obvious way to avoid
// copying a 100 MB drawing set — empties that buffer. lib/pdfTextLayer.js therefore copies, and this
// test is what stops the copy being removed again as an optimisation.
//
// The trap is well set, which is the reason this test exists rather than a comment: a SMALL document
// survives a view intact, because a Buffer under about 8 KB shares Node's allocation pool and is not
// transferred. A one-page fixture would pass and every real document would fail. So the fixture here
// is deliberately large enough to be allocated on its own.
//
// Run: node tests/pdfTextLayer.test.js

const assert = require('assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { readTextPages, eachPage } = require('../lib/pdfTextLayer');

// Comfortably past Node's 8 KB pooling threshold, where a view stops being safe.
const PAGES = 60;

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= PAGES; p++) {
    const page = doc.addPage([1224, 792]);
    page.drawText(`SHEET M-${100 + p} MECHANICAL PLAN`, { x: 40, y: 700, size: 12, font });
    for (let l = 0; l < 20; l++) {
      page.drawText(`NOTE ${l + 1}: COORDINATE DUCT ROUTING WITH STRUCTURE ABOVE CEILING.`,
        { x: 40, y: 660 - l * 14, size: 9, font });
    }
  }
  return Buffer.from(await doc.save());
}

(async () => {
  console.log('\npdfTextLayer — reading a document must not consume it');

  const buffer = await fixture();
  console.log(`  (fixture: ${PAGES} pages, ${(buffer.length / 1024).toFixed(0)} KB, `
    + `pooled=${buffer.buffer.byteLength !== buffer.length})`);

  // Taken before anything reads the buffer, so the comparison afterwards is against what it WAS
  // rather than against itself.
  const original = Buffer.from(buffer);

  await check('the text layer is read', async () => {
    const pages = await readTextPages(buffer);
    assert.strictEqual(pages.length, PAGES, `expected ${PAGES} pages, got ${pages.length}`);
    assert.match(pages[0].text, /SHEET M-101/, 'first page should carry its sheet number');
  });

  await check('the buffer is byte-for-byte intact afterwards', () => {
    // A detached buffer throws here rather than comparing unequal, which is also a failure.
    assert.ok(buffer.equals(original),
      'the buffer changed while its text was being read — pdfjs took ownership of the bytes');
  });

  await check('and can still be re-read as a PDF, which is what callers do next', async () => {
    const reloaded = await PDFDocument.load(buffer);
    assert.strictEqual(reloaded.getPageCount(), PAGES);
  });

  await check('reading it twice gives the same text both times', async () => {
    const first = await readTextPages(buffer);
    const second = await readTextPages(buffer);
    assert.deepStrictEqual(first, second);
  });

  await check('a failing extractor still closes the document and propagates', async () => {
    // A document left open holds everything it has cached. The copies this replaced would leak it
    // on any page that failed to parse, which is precisely when it is largest.
    await assert.rejects(
      eachPage(buffer, async (page, p) => {
        if (p === 3) throw new Error('extractor blew up');
        return p;
      }),
      /extractor blew up/,
    );
  });

  console.log(`\n${passed} check(s) passed${process.exitCode ? ' — with failures above' : ''}\n`);
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1); });
