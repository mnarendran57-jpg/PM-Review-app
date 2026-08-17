// Reading a PDF's own text layer. Free — no API call — and the basis of every path in the app that
// finds the right pages before paying to read them: spec sections, drawing sheets, proposal scope,
// and the pay app's own transcription check.
//
// Five places opened a document and walked its pages with the same fifteen lines, and all five held
// every page's parsed content until the whole document was finished. pdfjs caches each page's
// operator list and font data on the document as it goes, so a 500-page drawing set kept 500 pages
// resident where one would have done. The service runs in 512 MB and is handed documents that are
// routinely larger than most web applications ever see, so this is the difference between reading a
// set and restarting the service.
//
// What this adds over the copies: each page is released as soon as its caller has taken what it
// needs, the document is closed even when the extractor throws, and the file is not duplicated on
// the way in.

// DO NOT make this a view over the caller's buffer. It looks like free money — a Node Buffer is
// already a typed array, so `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` hands pdfjs
// the same bytes and saves copying a 100 MB drawing set. It is a trap.
//
// pdfjs TRANSFERS the array it is given and DETACHES the backing store. Every caller here reads the
// text layer first and then slices pages out of that same buffer, so the buffer they slice would be
// empty — and a Buffer under about 8 KB shares its backing store with unrelated buffers from Node's
// allocation pool, which would be emptied along with it.
//
// This was tried, and the trap is well set: a small test document survives intact, because a pooled
// buffer is not transferred. It only fails once the document is big enough to be allocated on its
// own — which is to say, on every real drawing set and no test fixture. tests/pdfTextLayer.test.js
// now uses a document large enough to catch it.
//
// The copy is the price of the caller keeping its file. It is worth it.
const bytesOf = buffer => new Uint8Array(buffer);

// Walks every page, handing each to `extract`, and collects what it returns.
//
// extract(page, pageNumber, pdfjs) may await. Anything it wants to keep it must return: the page
// object itself is released the moment it returns, and reading from it afterwards gives nothing.
async function eachPage(buffer, extract) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytesOf(buffer), useSystemFonts: true, isEvalSupported: false,
  }).promise;

  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      try {
        out.push(await extract(page, p, pdfjs));
      } finally {
        // Drops this page's operator list and font data. Without it they accumulate on the document
        // for the length of the read, which is the whole cost this module exists to avoid.
        page.cleanup();
      }
    }
  } finally {
    // Always, including when a page fails to parse. A document left open holds everything it has
    // cached until the garbage collector happens to notice, which on a busy request is too late.
    await doc.destroy();
  }
  return out;
}

// One page's text, joined in reading order and collapsed to single spaces.
async function textOf(page) {
  const content = await page.getTextContent();
  return content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

// [{ page, text }] — what every caller wants except the pay app, which needs positions too.
function readTextPages(buffer) {
  return eachPage(buffer, async (page, p) => ({ page: p, text: await textOf(page) }));
}

module.exports = { eachPage, textOf, readTextPages, bytesOf };
