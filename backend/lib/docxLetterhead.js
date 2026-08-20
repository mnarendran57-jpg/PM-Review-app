const { addImages, drawingParagraph, photoExtent, escapeXml, inches } = require('./docxImages');

// The organization's letterhead, as a Word HEADER part rather than as content at the top of the
// page.
//
// It began life as content: a table with the logo on the left and the address on the right, the
// first thing in the body. That looks right when the document is opened in Word, and it is wrong
// in every other respect. The letterhead is not something the PM wrote, so it should not sit in
// the text they are editing — and when the edited document is read back to rebuild the PDF, a
// letterhead in the body comes back as ordinary content: the logo as an inline picture in the
// middle of the page, the company name as a caption underneath it, the address as three stray
// paragraphs. That is exactly what a customer reported seeing.
//
// A header part is what Word itself uses for this. It repeats on every page, it stays out of the
// body, editing the document does not disturb it, and lib/docxRead.js — which reads only
// word/document.xml — does not see it at all. So the rebuilt PDF draws the letterhead properly
// from the organization's own record instead of trying to typeset a picture of one.

const HEADER_PART = 'word/header1.xml';
const HEADER_RELS = 'word/_rels/header1.xml.rels';
const HEADER_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const HEADER_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';

const pt = n => Math.round(n * 2);

function run(text, { italic, size = 9, color = '404040' } = {}) {
  return `<w:r><w:rPr>${italic ? '<w:i/>' : ''}`
    + `<w:sz w:val="${pt(size)}"/><w:szCs w:val="${pt(size)}"/><w:color w:val="${color}"/></w:rPr>`
    + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

const para = (content, { align, spaceAfter = 0 } = {}) =>
  `<w:p><w:pPr>${align ? `<w:jc w:val="${align}"/>` : ''}`
  + `<w:spacing w:after="${spaceAfter}"/></w:pPr>${content}</w:p>`;

// Adds the header part to a .docx being built and returns the sectPr reference that has to go
// FIRST inside <w:sectPr>, which is where the schema requires it.
//
// Returns '' when there is nothing to put in it. An organization that has uploaded no letterhead
// gets a clean document rather than an empty header or somebody else's mark.
function attachLetterhead(zip, { companyName = null, logo = null, confidential = false } = {}) {
  const addressLines = String(companyName || '').split('\n').map(l => l.trim()).filter(Boolean);
  const hasLogo = !!logo?.buffer;
  if (!addressLines.length && !hasLogo && !confidential) return '';

  // The logo's relationship belongs to the header, not the document.
  const relIds = hasLogo
    ? addImages(zip, [{ buffer: logo.buffer, mimeType: logo.mimeType }],
      { prefix: 'coasterMark', relsPath: HEADER_RELS })
    : [];

  const rows = [];
  if (confidential) {
    rows.push(para(run('Client Confidential', { italic: true, size: 11, color: '4D4D4D' }),
      { align: 'center' }));
  }
  if (hasLogo) {
    rows.push(drawingParagraph({
      relId: relIds[0], id: 700, align: 'left',
      // ~2.2in wide, matching the letterhead every other document in the app prints.
      ...photoExtent(logo.buffer, inches(158 / 72), inches(1.1), logo.mimeType),
    }));
  }
  for (const line of addressLines) {
    rows.push(para(run(line), { align: 'right' }));
  }

  zip.file(HEADER_PART,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:hdr `
    + `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
    + `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `${rows.join('')}</w:hdr>`);

  // The document's own relationship to the header part.
  const docRels = zip.file('word/_rels/document.xml.rels');
  let xml = docRels.asText();
  const nextId = [...xml.matchAll(/Id="rId(\d+)"/g)]
    .reduce((max, m) => Math.max(max, Number(m[1])), 0) + 1;
  const headerRelId = `rId${nextId}`;
  zip.file('word/_rels/document.xml.rels', xml.replace('</Relationships>',
    `<Relationship Id="${headerRelId}" Type="${HEADER_TYPE}" Target="header1.xml"/></Relationships>`));

  // Without the content-type override Word calls the whole file corrupt.
  const types = zip.file('[Content_Types].xml');
  if (types) {
    const t = types.asText();
    if (!t.includes(HEADER_PART.replace('word/', '/word/'))) {
      zip.file('[Content_Types].xml', t.replace('</Types>',
        `<Override PartName="/${HEADER_PART}" ContentType="${HEADER_CONTENT_TYPE}"/></Types>`));
    }
  }

  return `<w:headerReference w:type="default" r:id="${headerRelId}"/>`;
}

module.exports = { attachLetterhead };
