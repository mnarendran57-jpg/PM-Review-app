const { findCover, loadCover } = require('./coverLookup');
const { applyPlaceholders, fillDocx, loadZip, DOC_XML } = require('./memoCover');
const {
  addImages, drawingParagraph, photoExtent, ensureNamespaces, escapeXml, inches,
} = require('./docxImages');

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

// A photo dropped into a paragraph of the customer's own document. Kept under the usable width of
// a portrait page with ordinary margins, whatever their template's layout turns out to be.
const MAX_PHOTO_W = inches(3.1);
const MAX_PHOTO_H = inches(2.6);

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



// --- Filling one report ----------------------------------------------------------------------

// The progress report template to fill, or null. The project's own comes first and the
// organization's stands behind it — the rule, and the reason for it, are in lib/coverLookup.js.
const templateFor = ({ projectId, orgId }) =>
  findCover({ docType: 'progress-cover', projectId, orgId });

const loadTemplate = ({ projectId, orgId }) =>
  loadCover({ docType: 'progress-cover', projectId, orgId });

// Returns the finished .docx. `photos` are [{ buffer, caption }] in report order, already upright.
function fillProgressTemplate({ templateBuffer, replacements, fields, photos = [] }) {
  const { buffer: prepared } = applyPlaceholders(templateBuffer, replacements || [], 'progress-cover');
  const zip = loadZip(prepared);
  let xml = ensureNamespaces(zip.file(DOC_XML).asText());

  const relIds = photos.length
    ? addImages(zip, photos.map(p => ({ buffer: p.buffer, mimeType: 'image/jpeg' })),
      { prefix: 'coasterPhoto' })
    : [];

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
    const { cx, cy } = photoExtent(photo.buffer, MAX_PHOTO_W, MAX_PHOTO_H);
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

module.exports = { fillProgressTemplate, templateFor, loadTemplate };
