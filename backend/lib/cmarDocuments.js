const { PDFDocument } = require('pdf-lib');
const { readTextPages } = require('./pdfTextLayer');

// Turning a PDF into content blocks, owned by the CMAR audit.
//
// WHY THIS IS NOT SHARED
//
// A near-identical helper exists for the chat tab. This module deliberately does not use it, and
// does not use anything belonging to another feature. The whole point of this audit is that it
// implements one review method faithfully and gives the same answer every time; a shared helper
// tuned later to suit a different module would change what this one reads without anybody deciding
// that it should. The duplication is the price of that, and it is a low price — this file is short,
// and it will only ever change for reasons that come from this audit.
//
// Everything below this module depends on is infrastructure — the database, object storage, the job
// queue, the auth middleware, the PDF text reader, the JSON-over-tool-call helper. Nothing it
// depends on belongs to another review tool.
//
// WHY A SCAN IS NOT A PROBLEM HERE
//
// Pay application packets are routinely scans of signed forms with no text layer, and text
// extraction on those returns empty strings while appearing to succeed. A document block hands the
// API the pages themselves, so the model reads a scan and a text layer alike. That also settles the
// notary question honestly: a stamp and a signature are ink, and only something looking at the page
// can say whether they are there.

// The API refuses a PDF longer than this outright.
const MAX_PDF_PAGES = 100;

// Enough for a long contract, bounded so a specification set cannot fill the context window.
const MAX_TEXT_CHARS = 200000;

// A text layer can be present and still be meaningless. A PDF exported without a font character map
// extracts as glyph soup — "3 4 5 6 3 7 8 8 3 9" for two thousand characters a page — which passes
// any check that only asks whether characters exist. Sending that to be read produces confident
// nonsense about a document nobody can see.
//
// The tell is words. A pay application is terse, but "Earthwork (Building Pad)" is still runs of
// letters; glyph soup is overwhelmingly single characters separated by spaces.
const MIN_WORD_RATIO = 0.15;
const MIN_LETTERS = 100;

function looksLegible(text) {
  const body = String(text || '');
  if ((body.match(/[A-Za-z]/g) || []).length < MIN_LETTERS) return false;
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const words = tokens.filter(t => /^[A-Za-z][A-Za-z'’-]{2,}$/.test(t)).length;
  return words / tokens.length >= MIN_WORD_RATIO;
}

async function pageCount(buffer) {
  try {
    return (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
  } catch {
    return null;                      // encrypted or malformed: let the API give its own verdict
  }
}

async function firstPages(buffer, limit) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(source, Array.from({ length: limit }, (_, i) => i));
  pages.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

// The document's words, or null when there are none worth reading.
async function readableText(buffer) {
  let pages;
  try {
    pages = await readTextPages(buffer);
  } catch {
    return null;
  }
  if (!pages || !pages.length) return null;
  const text = pages.map(p => String(p.text || '')).join('\n\n');
  if (!looksLegible(text)) return null;
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}

const documentBlock = data => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data },
});

// Content blocks for one PDF.
//
// `preferText` is set for the CONTRACT, which is read for its words: an agreement usually has a text
// layer, it is a fraction of the tokens, and after the first turn it caches. It is never set for the
// PACKET — the packet is forms, signatures and stamps, and the picture is the point.
async function blocksForFile({ buffer, name, preferText = false }) {
  const pages = await pageCount(buffer);
  const tooLong = pages != null && pages > MAX_PDF_PAGES;

  if (preferText || tooLong) {
    const read = await readableText(buffer);
    if (read) {
      const header = `--- ${name || 'document'}`
        + (pages ? ` (${pages} page${pages === 1 ? '' : 's'})` : '')
        + (read.truncated ? ', shown in part - it is longer than this' : '')
        + ' ---';
      return [{ type: 'text', text: `${header}\n${read.text}` }];
    }
  }

  // A scan, or a document whose text could not be read. Trimmed to the ceiling rather than refused:
  // the alternative is the whole review failing on a document that is merely long.
  if (tooLong) {
    const trimmed = await firstPages(buffer, MAX_PDF_PAGES);
    return [
      documentBlock(trimmed.toString('base64')),
      {
        type: 'text',
        text: `(${name || 'That document'} is ${pages} pages and could not be read as text, so only `
          + `the first ${MAX_PDF_PAGES} are attached. Say so if the answer depends on a later page.)`,
      },
    ];
  }

  return [documentBlock(buffer.toString('base64'))];
}

module.exports = {
  blocksForFile, readableText, looksLegible, pageCount, firstPages,
  MAX_PDF_PAGES, MAX_TEXT_CHARS,
};
