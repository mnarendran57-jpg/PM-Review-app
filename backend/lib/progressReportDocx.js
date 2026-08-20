const PizZip = require('pizzip');
const {
  addImages, drawingParagraph, photoExtent, escapeXml, inches,
} = require('./docxImages');
const { attachLetterhead } = require('./docxLetterhead');

// Coaster's own progress report, as a Word document.
//
// The PDF is the finished thing; this is the same report in a form the PM can edit before sending
// it. A site report routinely needs a line changed after the walk — a trade named properly, an
// observation the photographs do not carry — and a PDF cannot take it. Until now the only editable
// output was the customer's own template, which most customers have not uploaded, so most people
// had nothing to change.
//
// The layout deliberately mirrors lib/progressReportPdf.js: the same letterhead, the same header
// block, the same bulleted Progress list, the same two-column grid of captioned photographs. The
// two are read side by side by whoever receives them, and a Word file that laid the report out
// differently would read as a different report.
//
// The package is built from nothing rather than from a stored .docx, because a stored one would be
// a template — and a template belongs to the customer, not in this repository.

// Twips — twentieths of a point, Word's unit for page and table geometry. 1440 to the inch.
const twips = n => Math.round(n * 1440);
const PAGE_W = twips(8.5);
const PAGE_H = twips(11);
const MARGIN = twips(1);
const CONTENT_W = PAGE_W - (MARGIN * 2);

// Half-points, Word's unit for font size.
const pt = n => Math.round(n * 2);

const PHOTO_COLS = 2;
const CELL_W = Math.floor(CONTENT_W / PHOTO_COLS);
// Inside a cell, with a little room either side so two photos never touch.
const MAX_PHOTO_W = inches((CELL_W / 1440) - 0.15);
const MAX_PHOTO_H = inches(2.4);

const GREY = '595959';
const INK = '1A1A1A';

// --- Paragraph and table building -------------------------------------------------------------

function run(text, { bold, size = 11, color = INK } = {}) {
  const props = `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${pt(size)}"/>`
    + `<w:szCs w:val="${pt(size)}"/><w:color w:val="${color}"/></w:rPr>`;
  return `<w:r>${props}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function para(text, { bold, size, color, align, indent, hanging, spaceAfter = 60 } = {}) {
  const props = [
    align ? `<w:jc w:val="${align}"/>` : '',
    indent ? `<w:ind w:left="${indent}"${hanging ? ` w:hanging="${hanging}"` : ''}/>` : '',
    `<w:spacing w:after="${spaceAfter}"/>`,
  ].join('');
  const body = text === '' ? '' : run(text, { bold, size, color });
  return `<w:p><w:pPr>${props}</w:pPr>${body}</w:p>`;
}

// A table with no visible borders, used for the letterhead and the photo grid. Word draws faint
// gridlines on screen for a table with no borders unless they are turned off explicitly, and those
// gridlines do not print — but they do make the document look wrong to whoever opens it.
function table(rows, widths) {
  const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const noBorders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(side => `<w:${side} w:val="none" w:sz="0" w:space="0"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`
    + `<w:tblBorders>${noBorders}</w:tblBorders>`
    + `<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>`
    + rows.map(cells =>
      `<w:tr>${cells.map((content, i) =>
        `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>`
        // Word requires at least one paragraph in a cell; an empty cell without one is invalid.
        + `${content || '<w:p/>'}</w:tc>`).join('')}</w:tr>`).join('')
    + `</w:tbl>`;
}

// --- The package ------------------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// The document's default font and size. Without a styles part Word falls back to its own defaults,
// which differ between versions and installations — the same file would look different on two
// desks.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const SECTION_BODY = `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
  + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"`
  + ` w:header="720" w:footer="720" w:gutter="0"/>`;

// Builds the report. `photos` are [{ buffer, caption }] in order, already upright; `logo` is the
// organization's, or null — there is deliberately no default, so a customer who has uploaded none
// gets a clean report rather than another company's letterhead.
function renderProgressReportDocx({ report, header, photos = [], companyName = null, logo = null }) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  zip.folder('word').file('styles.xml', STYLES);
  zip.folder('word').folder('_rels').file('document.xml.rels', DOC_RELS);

  // The letterhead goes in a Word header part rather than at the top of the body. In the body it
  // came back on rebuild as an inline picture with the company name captioned underneath — see
  // lib/docxLetterhead.js.
  const headerRef = attachLetterhead(zip, { companyName, logo });

  const photoRels = photos.length
    ? addImages(zip, photos.map(p => ({ buffer: p.buffer, mimeType: 'image/jpeg' })),
      { prefix: 'coasterReport' })
    : [];

  const body = [];

  // --- Title
  const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
  body.push(para(`${header.projectName || 'Project'} Progress Report${num}`,
    { bold: true, size: 15, spaceAfter: 160 }));

  // --- Header block
  body.push(para(
    `Date: ${header.visitDate || '—'}      Time: ${header.visitTime || '—'}      `
    + `Weather: ${header.weather || '—'}`));
  body.push(para(`Submitted By: ${header.submittedBy || '—'}`));
  body.push(para(`Project: ${header.projectName || '—'}`));
  body.push(para(`Contractor: ${header.contractor || '—'}`, { spaceAfter: 200 }));

  // --- Progress
  body.push(para('Progress:', { bold: true, size: 12, spaceAfter: 100 }));
  const observations = (report.progress || []).filter(Boolean);
  if (observations.length === 0) {
    body.push(para('No observations recorded.', { color: GREY }));
  } else {
    // A literal bullet with a hanging indent rather than a real Word list. A real one needs a
    // numbering part whose definitions the PM would then be editing around; this is a plain
    // paragraph they can retype, split or delete like any other, which is the point of the Word
    // version existing at all.
    for (const line of observations) {
      body.push(para(`•\t${line}`, { indent: twips(0.25), hanging: twips(0.25) }));
    }
  }
  body.push(para('', { spaceAfter: 120 }));

  // --- Site Pictures, two to a row
  body.push(para('Site Pictures:', { bold: true, size: 12, spaceAfter: 120 }));
  if (photos.length) {
    const cells = photos.map((photo, i) => {
      const { cx, cy } = photoExtent(photo.buffer, MAX_PHOTO_W, MAX_PHOTO_H);
      return drawingParagraph({ relId: photoRels[i], id: 1000 + i, cx, cy })
        + para(photo.caption || '', { size: 9, color: GREY, align: 'center', spaceAfter: 160 });
    });
    const rows = [];
    for (let i = 0; i < cells.length; i += PHOTO_COLS) {
      const row = cells.slice(i, i + PHOTO_COLS);
      while (row.length < PHOTO_COLS) row.push('');   // a short last row still needs its cells
      rows.push(row);
    }
    body.push(table(rows, Array(PHOTO_COLS).fill(CELL_W)));
  } else {
    body.push(para('No photographs were attached to this report.', { color: GREY }));
  }

  zip.folder('word').file('document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document `
    + `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
    + `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<w:body>${body.join('')}<w:sectPr>${headerRef}${SECTION_BODY}</w:sectPr></w:body></w:document>`);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { renderProgressReportDocx };
