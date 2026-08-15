const { PDFDocument } = require('pdf-lib');

// Sending a document as words instead of as pictures of words.
//
// A PDF page handed to the model is charged as an image — roughly two thousand tokens whatever
// is printed on it. The same page handed over as text is a few hundred. On a real 28-page
// submittal package the difference measured 66,000 tokens against 15,000: four and a half times
// the bill for the identical document, and the review reached the same verdict either way,
// down to the gate valve rated to the wrong AWWA standard.
//
// The catch is that "the text of the page" and "what is on the page" are the same thing only
// for prose. A drawing sheet has a text layer — sheet number, title block, a few callouts — and
// none of it is the drawing. Extracting text from a plan set would hand the model the labels
// and throw away the building. A scanned page has no text layer at all.
//
// So the choice is made per page, on how much text the page actually carries. A page dense
// enough to be prose is sent as prose; anything thinner — a drawing, a scan, a photograph, a
// tab divider — is sent as pages, exactly as before. A mixed package, which is what a submittal
// usually is, comes out mixed: the product data sheets as text, the shop drawings as images.
// Nothing is ever dropped, so the worst case is that a document costs what it costs today.

// Below this a page is not carrying its meaning in its text layer.
//
// A full page of specification runs to two or three thousand characters; a product data sheet a
// thousand or more. A drawing sheet's entire text layer — sheet number, title block, revision
// stamp, a handful of callouts — rarely clears three hundred, and a tab divider or a scan sits
// near zero. The gap between the two populations is wide, which is what makes a single
// threshold safe: it is not trying to split a continuum, it is choosing between prose and
// something that merely has words printed on it.
const PROSE_CHARS = 400;

// Reading a whole document as text and finding almost none of it means a scanned or drawn set.
// Below this share the split is not worth making: the handful of prose pages save little, and
// interleaving them with page ranges makes the document harder for the model to follow than
// simply sending it whole.
const MIN_PROSE_SHARE = 0.25;

// A page with no text at all is either genuinely blank or a scan, and those two must not be
// treated alike: dropping a scanned page loses the page, while sending a blank one costs about
// two thousand tokens to show the model nothing.
//
// Text cannot tell them apart — both report zero characters. What tells them apart is whether
// anything is drawn. A scan is one big image; a drawing is thousands of path operations; a
// genuinely blank separator has neither. So the operator list is the test, and it is only
// consulted for pages that already came back empty of text — which is the only case where the
// question arises, and keeps the cost of asking it off every other page.
const MARKS_DRAWN = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintJpegXObject',
  'paintImageMaskXObject', 'constructPath', 'shadingFill', 'paintFormXObjectBegin']);

async function drawsAnything(page, pdfjs) {
  try {
    const ops = await page.getOperatorList();
    const names = pdfjs.OPS;
    return ops.fnArray.some(fn => {
      for (const key of MARKS_DRAWN) if (names[key] === fn) return true;
      return false;
    });
  } catch {
    // Unreadable operator list: assume something is there rather than risk dropping a page.
    return true;
  }
}

// One entry per page: its number, whatever text the page carries, and whether anything is
// drawn on it. pdfjs reports positioned fragments, which are joined in reading order. No API
// call is involved and nothing is charged.
async function readPages(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    const blank = text.length === 0 ? !(await drawsAnything(page, pdfjs)) : false;
    pages.push({ page: p, text, blank });
  }
  await doc.destroy();
  return pages;
}

// Contiguous runs of the same kind, so a stretch of drawings becomes one page range rather
// than one block per sheet.
function runsOf(pages) {
  const runs = [];
  for (const p of pages) {
    // Nothing written and nothing drawn: there is no version of this page worth paying for.
    if (p.blank) continue;
    const kind = p.text.length >= PROSE_CHARS ? 'text' : 'pages';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && last.end === p.page - 1) {
      last.end = p.page;
      last.pages.push(p);
    } else {
      runs.push({ kind, start: p.page, end: p.page, pages: [p] });
    }
  }
  return runs;
}

async function sliceOf(source, start, end) {
  const part = await PDFDocument.create();
  const copied = await part.copyPages(
    source, Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
  copied.forEach(p => part.addPage(p));
  return Buffer.from(await part.save());
}

const asDocument = buffer => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

// The content blocks for one document, cheapest form first.
//
// Returns { blocks, stats }. stats.mode is 'text' when at least some of it was sent as words
// and 'pages' when the whole thing went as pages, which is what the callers log.
//
// label     names the document in the text blocks, so the model can still cite it by name
//           the way it does when the document arrives as a document block.
// pageLabel prefixes each text run with its page numbers, so a finding can still say which
//           page it came from — the thing that would otherwise be lost by sending text.
async function toContentBlocks(buffer, { label = 'Document' } = {}) {
  let pages;
  let source;
  try {
    [pages, source] = await Promise.all([
      readPages(buffer),
      PDFDocument.load(buffer, { ignoreEncryption: true }),
    ]);
  } catch {
    // Encrypted, malformed, or not a PDF at all. The model's own error message on the whole
    // file reads better than a parser trace, so hand it over unchanged.
    return { blocks: [asDocument(buffer)], stats: { mode: 'pages', reason: 'unreadable' } };
  }

  const prose = pages.filter(p => p.text.length >= PROSE_CHARS).length;
  if (!pages.length || prose / pages.length < MIN_PROSE_SHARE) {
    return {
      blocks: [asDocument(buffer)],
      stats: { mode: 'pages', pages: pages.length, prosePages: prose, reason: 'mostly drawn or scanned' },
    };
  }

  const blocks = [];
  for (const run of runsOf(pages)) {
    if (run.kind === 'text') {
      const where = run.start === run.end ? `page ${run.start}` : `pages ${run.start}–${run.end}`;
      blocks.push({
        type: 'text',
        text: `--- ${label}, ${where} ---\n`
          + run.pages.map(p => `[page ${p.page}]\n${p.text}`).join('\n\n'),
      });
    } else {
      // Sent as pages because the words on them are not what they are about.
      blocks.push(asDocument(await sliceOf(source, run.start, run.end)));
    }
  }

  const blank = pages.filter(p => p.blank).length;
  return {
    blocks,
    stats: {
      mode: 'text',
      pages: pages.length,
      prosePages: prose,
      // Blanks are counted out of the image share because that is what they would have cost:
      // a page carrying neither words nor marks was going to be sent as a picture of nothing.
      imagePages: pages.length - prose - blank,
      blankPages: blank,
    },
  };
}

module.exports = { toContentBlocks, readPages, PROSE_CHARS, MIN_PROSE_SHARE };
