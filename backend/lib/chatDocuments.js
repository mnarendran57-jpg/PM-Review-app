const { PDFDocument } = require('pdf-lib');
const { readTextPages } = require('./pdfTextLayer');
const { looksLegible } = require('./veExtract');

// Turning a file into something the model can actually be given.
//
// The API refuses a PDF of more than a hundred pages outright. A real customer contract in this
// application is 168 pages, so attaching one to a chat failed the whole conversation with a raw
// provider error — the sort of thing that happens in front of somebody rather than in a test.
//
// Two different files, two different answers:
//
//   A PROJECT DOCUMENT is a contract, a specification, a scope narrative. It is there to be quoted
//   from, and its text layer is the best form of it: no page ceiling, a fraction of the tokens, and
//   the words are what matter. A 168 page contract is about 90,000 tokens of text against roughly
//   340,000 as images, and after the first turn it is cached at a tenth of that.
//
//   AN ATTACHMENT somebody dragged into the chat is usually a drawing or a photograph, and the
//   picture is the point. That stays a document, and only a long one falls back to text.
//
// A scan has no text layer, so it stays a document either way and is capped at the page limit
// rather than being refused.

// The API's own ceiling.
const MAX_PDF_PAGES = 100;

// Enough for a long contract, bounded so a specification set cannot fill the context window or
// quietly cost several dollars on its first turn.
const MAX_TEXT_CHARS = 200000;

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

// Content blocks for one file. `preferText` is set for project documents, which are read rather
// than looked at.
async function blocksForFile({ buffer, name, mediaType, preferText = false }) {
  if (mediaType && mediaType !== 'application/pdf') {
    return [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } }];
  }

  const pages = await pageCount(buffer);
  const tooLong = pages != null && pages > MAX_PDF_PAGES;

  if (preferText || tooLong) {
    const read = await readableText(buffer);
    if (read) {
      const header = `--- ${name || 'document'}`
        + (pages ? ` (${pages} page${pages === 1 ? '' : 's'})` : '')
        + (read.truncated ? ', shown in part — it is longer than this' : '')
        + ' ---';
      return [{ type: 'text', text: `${header}\n${read.text}` }];
    }
  }

  // A scan, or a document whose text could not be read. Send the pages, trimmed to the ceiling
  // rather than refused — the alternative is the whole conversation failing.
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

module.exports = { blocksForFile, readableText, pageCount, firstPages, MAX_PDF_PAGES, MAX_TEXT_CHARS };
