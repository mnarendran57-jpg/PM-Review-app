const { loadZip, DOC_XML } = require('./memoCover');

// Reading a Word document back as an ordered list of what is in it.
//
// The app hands a PM a .docx, they edit it in Word, and they send it back to be turned into the
// PDF everyone else receives. To do that faithfully the document has to be read in ORDER —
// paragraph, paragraph, photograph, caption, paragraph — because that order is the edit. A PM who
// moves a photo, deletes one, or writes a sentence between two of them has expressed something,
// and a reader that returns "all the text, then all the images" throws it away.
//
// So this walks document.xml once and emits blocks as it meets them:
//
//   { type: 'text',  text }                    a paragraph, trimmed; empty ones are spacing
//   { type: 'image', buffer, mimeType }        an inline picture, resolved to its bytes
//
// What it does not carry is formatting — bold, fonts, tables. See lib/docxToPdf.js for why that
// is the deliberate boundary rather than an oversight.

const RELS = 'word/_rels/document.xml.rels';

const unescapeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

// A copy that owns its whole ArrayBuffer, starting at byte zero.
//
// Buffer.from() takes small allocations out of Node's shared pool, so the result is a VIEW into a
// larger buffer with a non-zero byteOffset. pdf-lib's image embedder reads through
// `new DataView(bytes.buffer)` without passing that offset, so it looks at the start of the pool
// instead of the start of the image and reports "SOI not found in JPEG".
//
// It only bites below the pool threshold — a phone photograph is megabytes and lands in its own
// allocation, so this failed for small pictures only: an icon, a logo, a screenshot pasted into a
// report. Exactly the kind of bug that survives every test written with realistic data.
function standalone(bytes) {
  const copy = Buffer.alloc(bytes.length);
  copy.set(bytes);
  return copy;
}

// relationship id -> the part it points at. An image in the body refers to its bytes this way, and
// the same id means different things in different documents, so it is resolved per document.
function imageTargets(zip) {
  const file = zip.file(RELS);
  if (!file) return new Map();
  const out = new Map();
  for (const m of file.asText().matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (!/\/image"/.test(attrs)) continue;
    const id = attrs.match(/Id="([^"]+)"/)?.[1];
    const target = attrs.match(/Target="([^"]+)"/)?.[1];
    if (id && target) out.set(id, target.replace(/^\/?word\//, '').replace(/^\.\.\//, ''));
  }
  return out;
}

// Walks the body in document order. Paragraphs are found the same way lib/progressCover.js finds
// them — by hand rather than with one regex over the whole file, so a nested table cannot make a
// match run past the paragraph it belongs to.
function readBlocks(buffer) {
  const zip = loadZip(buffer);
  const doc = zip.file(DOC_XML);
  if (!doc) {
    const err = new Error('That .docx has no readable document body.');
    err.status = 400;
    throw err;
  }
  const xml = doc.asText();
  const targets = imageTargets(zip);
  const blocks = [];

  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf('<w:p', index);
    if (start === -1) break;
    const openEnd = xml.indexOf('>', start);
    if (openEnd === -1) break;
    // <w:pPr>, <w:pStyle> and friends also begin with "<w:p".
    if (!/^<w:p(\s[^>]*)?>$/.test(xml.slice(start, openEnd + 1))) { index = openEnd + 1; continue; }
    const close = xml.indexOf('</w:p>', openEnd);
    if (close === -1) break;
    const body = xml.slice(openEnd + 1, close);
    index = close + '</w:p>'.length;

    // Pictures first, in the order they appear inside the paragraph, then the paragraph's text.
    // A caption almost always sits in its own paragraph under the picture, so this ordering is
    // what a reader of the document sees.
    for (const m of body.matchAll(/r:embed="([^"]+)"/g)) {
      const target = targets.get(m[1]);
      if (!target) continue;
      const part = zip.file(`word/${target}`);
      if (!part) continue;
      const ext = (target.split('.').pop() || '').toLowerCase();
      blocks.push({
        type: 'image',
        buffer: standalone(part.asUint8Array()),
        mimeType: MIME_BY_EXT[ext] || 'image/jpeg',
      });
    }

    const text = [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map(t => unescapeXml(t[1])).join('').trim();

    // A paragraph that held a picture and no words emits the picture alone. Emitting an empty text
    // block after it would read as "the picture, then a blank line", which tells the renderer the
    // next paragraph is no longer a caption — and captions are exactly what follows a photograph.
    if (!text && blocks.length && blocks[blocks.length - 1].type === 'image') continue;
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

// Convenience for callers that only want the words.
const readParagraphs = buffer =>
  readBlocks(buffer).filter(b => b.type === 'text').map(b => b.text);

module.exports = { readBlocks, readParagraphs };
