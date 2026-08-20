const db = require('../database');
const storage = require('./storage');
const { applyPlaceholders, fillDocx, loadZip, DOC_XML } = require('./memoCover');
const { jpegSize } = require('./imageOrientation');

// Filling the organization's own progress report — their Word document, their formatting, with
// this visit's observations and photographs written into it.
//
// The memo cover only ever substitutes single values, so docxtemplater does all of its work. A
// progress report has two things a substitution cannot express: the observations are a list of
// unknown length, and the site pictures are images. Both are handled here, on the XML, before
// docxtemplater fills the ordinary fields:
//
//   {{progress}}        the paragraph holding it is copied once per observation
//   {{photo_caption}}   the paragraph holding it is copied once per photo, with the photograph
//                       placed in a paragraph immediately above it
//
// A template with no {{photo_caption}} still gets its photographs — they are appended at the end
// of the document rather than dropped, because a progress report without the site pictures is not
// the document anybody asked for.

const RELS = 'word/_rels/document.xml.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

// English Metric Units — Word's internal length. 914400 to the inch.
const EMU_PER_INCH = 914400;
const MAX_PHOTO_W = Math.round(3.1 * EMU_PER_INCH);
const MAX_PHOTO_H = Math.round(2.6 * EMU_PER_INCH);

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const unescapeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// --- Walking paragraphs ----------------------------------------------------------------------
// Done by hand rather than with a regex over the whole document, so nested content — a table
// inside a paragraph's ancestor, a <w:pPr> that also starts with "<w:p" — cannot make a match run
// past the paragraph it belongs to. Same reasoning as lib/memoCover.js.

function* paragraphs(xml) {
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf('<w:p', index);
    if (start === -1) return;
    const openEnd = xml.indexOf('>', start);
    if (openEnd === -1) return;
    const openTag = xml.slice(start, openEnd + 1);
    // <w:pPr>, <w:pStyle> and friends also begin with "<w:p".
    if (!/^<w:p(\s[^>]*)?>$/.test(openTag)) { index = openEnd + 1; continue; }
    const close = xml.indexOf('</w:p>', openEnd);
    if (close === -1) return;
    const end = close + '</w:p>'.length;
    yield { start, end, openTag, body: xml.slice(openEnd + 1, close) };
    index = end;
  }
}

const textOf = body => [...body.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
  .map(m => unescapeXml(m[1])).join('');

// One paragraph carrying the same properties and run formatting as the host, with `text` in it.
// Rebuilding rather than editing in place is what makes a tag Word has split across half a dozen
// runs behave the same as one it has not.
function paragraphLike({ openTag, body }, text) {
  const pPr = body.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const rPr = body.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  return `${openTag}${pPr ? pPr[0] : ''}<w:r>${rPr ? rPr[0] : ''}`
    + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// Replaces the paragraph containing `tag` with whatever `build` returns for it. Answers null when
// the tag is not in the document, so the caller can decide what "the template does not have one"
// means — for the observations that is nothing to do, for the photographs it is "put them at the
// end instead".
function expandParagraph(xml, tag, build) {
  for (const para of paragraphs(xml)) {
    const text = textOf(para.body);
    if (!text.includes(tag)) continue;
    const replacement = build(para, text);
    return xml.slice(0, para.start) + replacement + xml.slice(para.end);
  }
  return null;
}

// --- The photographs -------------------------------------------------------------------------

// An inline picture, sized in EMU, referring to a relationship added to the document's part.
function drawingParagraph({ relId, id, cx, cy, alignment = '<w:jc w:val="center"/>' }) {
  const name = `Site photo ${id}`;
  return `<w:p><w:pPr>${alignment}</w:pPr><w:r><w:drawing>`
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

// Fits a photo inside the page's usable width, keeping its shape. A photo with no readable
// dimensions is drawn at the maximum width in a 4:3 box, which is wrong-shaped at worst; refusing
// to place it would lose the picture entirely.
function photoExtent(buffer) {
  const { width, height } = jpegSize(buffer);
  if (!width || !height) return { cx: MAX_PHOTO_W, cy: Math.round(MAX_PHOTO_W * 0.75) };
  let cx = MAX_PHOTO_W;
  let cy = Math.round((height / width) * cx);
  if (cy > MAX_PHOTO_H) {
    cy = MAX_PHOTO_H;
    cx = Math.round((width / height) * cy);
  }
  return { cx, cy };
}

// Adds the image parts, their relationships and the JPEG content type. Returns the relationship
// id for each photo, in order.
function addImageParts(zip, photos) {
  const rels = zip.file(RELS);
  if (!rels) throw new Error('That Word document has no relationships part and cannot take images.');
  let relsXml = rels.asText();

  // Continue the document's own numbering rather than starting at 1 — an id already in use would
  // silently repoint an existing image, or the header's logo, at a site photo.
  let nextId = [...relsXml.matchAll(/Id="rId(\d+)"/g)]
    .reduce((max, m) => Math.max(max, Number(m[1])), 0) + 1;

  const added = [];
  photos.forEach((photo, i) => {
    const relId = `rId${nextId++}`;
    const target = `media/coasterPhoto${i + 1}.jpeg`;
    zip.file(`word/${target}`, photo.buffer);
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="${REL_IMAGE}" Target="${target}"/></Relationships>`
    );
    added.push(relId);
  });

  zip.file(RELS, relsXml);

  const types = zip.file(CONTENT_TYPES);
  if (types) {
    let typesXml = types.asText();
    // Without this Word reports the file as corrupt rather than showing it without the pictures.
    if (!/Extension="jpeg"/i.test(typesXml)) {
      zip.file(CONTENT_TYPES, typesXml.replace(
        /(<Types[^>]*>)/,
        '$1<Default Extension="jpeg" ContentType="image/jpeg"/>'
      ));
    }
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

// --- Filling one report ----------------------------------------------------------------------

// The project's confirmed progress report template, or null. Unconfirmed templates are ignored on
// purpose: the placeholder mapping is a model's reading of the customer's document, and an
// unreviewed one put into a report that goes to the team is exactly the thing the confirm step
// exists to prevent.
function templateForProject(projectId) {
  if (!projectId) return null;
  const row = db.prepare(`
    SELECT * FROM project_contracts
    WHERE project_id = ? AND doc_type = 'progress-cover'
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(projectId);
  if (!row) return null;
  let terms;
  try { terms = JSON.parse(row.terms || '{}'); } catch { return null; }
  return terms.confirmed ? { row, terms } : null;
}

// Returns the finished .docx. `photos` are [{ buffer, caption }] in report order, already upright.
function fillProgressTemplate({ templateBuffer, replacements, fields, photos = [] }) {
  const { buffer: prepared } = applyPlaceholders(templateBuffer, replacements || [], 'progress-cover');
  const zip = loadZip(prepared);
  let xml = ensureNamespaces(zip.file(DOC_XML).asText());

  const relIds = photos.length ? addImageParts(zip, photos) : [];

  // The observations: one copy of the host paragraph each, so a numbered or bulleted list stays a
  // numbered or bulleted list.
  const observations = (fields.progress || []).filter(Boolean);
  const expandedProgress = expandParagraph(xml, '{{progress}}', (para, text) =>
    (observations.length ? observations : ['No observations were recorded for this visit.'])
      .map(line => paragraphLike(para, text.split('{{progress}}').join(line)))
      .join(''));
  if (expandedProgress !== null) xml = expandedProgress;

  // The site pictures: the photograph, then the caption paragraph the template already styles.
  const photoBlock = (para, text) => photos.map((photo, i) => {
    const { cx, cy } = photoExtent(photo.buffer);
    const image = drawingParagraph({ relId: relIds[i], id: 1000 + i, cx, cy });
    const caption = para
      ? paragraphLike(para, text.split('{{photo_caption}}').join(photo.caption || ''))
      : `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr>`
        + `<w:t xml:space="preserve">${escapeXml(photo.caption || '')}</w:t></w:r></w:p>`;
    return image + caption;
  }).join('');

  const expandedPhotos = photos.length
    ? expandParagraph(xml, '{{photo_caption}}', photoBlock)
    : expandParagraph(xml, '{{photo_caption}}', () => '');

  if (expandedPhotos !== null) {
    xml = expandedPhotos;
  } else if (photos.length) {
    // No caption placeholder in this template. The photographs go at the end of the body rather
    // than nowhere — see the note at the top of this file.
    xml = xml.replace('</w:body>', `${photoBlock(null, '')}</w:body>`);
  }

  zip.file(DOC_XML, xml);

  // Everything left is an ordinary single value, which is docxtemplater's job. `progress` and
  // `photo_caption` are gone from the XML by now, so nothing here can double them up.
  return fillDocx(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), fields);
}

module.exports = { fillProgressTemplate, templateForProject };
