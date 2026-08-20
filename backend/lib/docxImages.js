const { jpegSize } = require('./imageOrientation');

// Putting pictures into a Word document.
//
// Shared by the two places that do it: filling the customer's own progress report template
// (lib/progressCover.js), and building Coaster's own Word report from nothing
// (lib/progressReportDocx.js). Both need the same three things, and getting any one of them
// wrong makes Word call the whole file corrupt rather than show it without the picture:
//
//   the image bytes as a part in the package
//   a relationship from the document to that part
//   a content type for the file extension
//
// Sizes are in English Metric Units, Word's internal length — 914400 to the inch.

const RELS = 'word/_rels/document.xml.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const EMU_PER_INCH = 914400;
const inches = n => Math.round(n * EMU_PER_INCH);

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// An inline picture, sized in EMU, referring to a relationship on the document part.
function drawingParagraph({ relId, id, cx, cy, align = 'center' }) {
  const name = `Picture ${id}`;
  return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="${name}"/>`
    + `<wp:cNvGraphicFramePr>`
    + `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>`
    + `</wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// The pixel dimensions of a JPEG or a PNG. Site photos are always JPEG — the module accepts
// nothing else — but a letterhead logo may be either, and a PNG measured with the JPEG reader
// comes back as nothing, which used to mean every PNG logo was drawn in a 4:3 box regardless of
// its real shape.
//
// A PNG's width and height are the first eight bytes of its IHDR chunk, which the format requires
// to come first, immediately after the eight-byte signature.
function imageSize(buffer, mimeType) {
  if (/png/i.test(mimeType || '')) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 24) return { width: 0, height: 0 };
    if (buffer.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
    if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return { width: 0, height: 0 };
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return jpegSize(buffer);
}

// Fits a picture inside a box, keeping its shape. One with no readable dimensions is drawn at the
// full width in a 4:3 box, which is wrong-shaped at worst; refusing to place it would lose the
// picture entirely.
function photoExtent(buffer, maxW, maxH, mimeType) {
  const { width, height } = imageSize(buffer, mimeType);
  if (!width || !height) return { cx: maxW, cy: Math.round(maxW * 0.75) };
  let cx = maxW;
  let cy = Math.round((height / width) * cx);
  if (cy > maxH) {
    cy = maxH;
    cx = Math.round((width / height) * cy);
  }
  return { cx, cy };
}

// Adds the image parts, their relationships and the content type for each extension used.
// Returns the relationship id for each image, in order.
//
// `images` are [{ buffer, mimeType }]. The zip may already carry pictures of its own — a
// letterhead logo, a diagram in the customer's template — which is why the relationship ids
// continue the document's own numbering rather than starting at 1. An id already in use would
// silently repoint that logo at a site photo.
function addImages(zip, images, { prefix = 'coasterImage', relsPath = RELS } = {}) {
  // A picture used in a header lives in that header's own relationships part, not the document's.
  // Pointing it at document.xml.rels makes Word report the file as corrupt.
  if (!zip.file(relsPath)) {
    zip.file(relsPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '</Relationships>');
  }
  const rels = zip.file(relsPath);
  if (!rels) throw new Error('That Word document has no relationships part and cannot take images.');
  let relsXml = rels.asText();

  let nextId = [...relsXml.matchAll(/Id="rId(\d+)"/g)]
    .reduce((max, m) => Math.max(max, Number(m[1])), 0) + 1;

  const extensions = new Set();
  const added = [];
  images.forEach((image, i) => {
    const ext = /png/i.test(image.mimeType || '') ? 'png' : 'jpeg';
    extensions.add(ext);
    const relId = `rId${nextId++}`;
    const target = `media/${prefix}${i + 1}.${ext}`;
    zip.file(`word/${target}`, image.buffer);
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="${REL_IMAGE}" Target="${target}"/></Relationships>`
    );
    added.push(relId);
  });
  zip.file(relsPath, relsXml);

  const types = zip.file(CONTENT_TYPES);
  if (types) {
    let typesXml = types.asText();
    let changed = false;
    for (const ext of extensions) {
      if (new RegExp(`Extension="${ext}"`, 'i').test(typesXml)) continue;
      typesXml = typesXml.replace(
        /(<Types[^>]*>)/,
        `$1<Default Extension="${ext}" ContentType="image/${ext}"/>`
      );
      changed = true;
    }
    if (changed) zip.file(CONTENT_TYPES, typesXml);
  }
  return added;
}

// r:embed and the wp: drawing elements need their namespaces declared on the document root. Word
// declares both in anything it has saved, but a document generated by another tool may not, and a
// missing declaration makes Word refuse to open the file rather than ignore the picture.
function ensureNamespaces(xml) {
  return xml.replace(/<w:document\b([^>]*)>/, (whole, attrs) => {
    let next = attrs;
    if (!/xmlns:r=/.test(next)) {
      next += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    }
    if (!/xmlns:wp=/.test(next)) {
      next += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    }
    return `<w:document${next}>`;
  });
}

module.exports = {
  addImages, drawingParagraph, photoExtent, imageSize, ensureNamespaces, escapeXml,
  inches, EMU_PER_INCH, RELS, CONTENT_TYPES, REL_IMAGE,
};
