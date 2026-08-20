const PizZip = require('pizzip');
const { addImages, drawingParagraph, photoExtent, escapeXml, inches } = require('./docxImages');
const { fillPlaceholders } = require('./pdfGen');

// Coaster's own memo, as a Word document.
//
// The Word memo used to exist only for organizations that had uploaded their own letter, because
// it was made by filling that letter. Everyone else got a PDF they could not change — and being
// able to change the memo is the point: a PM adds a condition of approval, corrects a name, or
// rewrites a sentence about the scope after reading it back.
//
// So the built-in memo is produced as a .docx too, from the same wording the PDF has always used.
// A customer with no letterhead of their own still gets an editable memo; one who has uploaded a
// letter gets theirs. Either way the PM can edit it and send it back to rebuild the package.

const twips = n => Math.round(n * 1440);
const PAGE_W = twips(8.5);
const PAGE_H = twips(11);
const MARGIN = twips(1);
const CONTENT_W = PAGE_W - (MARGIN * 2);
const pt = n => Math.round(n * 2);

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

// Times, matching the memo PDF this stands beside — the two are read as the same document.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
<w:sz w:val="22"/><w:szCs w:val="22"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const SECTION = `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
  + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"`
  + ` w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

function run(text, { bold, italic, size = 11, color = '1A1A1A' } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}`
    + `<w:sz w:val="${pt(size)}"/><w:szCs w:val="${pt(size)}"/><w:color w:val="${color}"/></w:rPr>`
    + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function para(text, { bold, italic, size, color, align, spaceAfter = 120 } = {}) {
  const props = `${align ? `<w:jc w:val="${align}"/>` : ''}<w:spacing w:after="${spaceAfter}"/>`;
  // Word keeps a paragraph's line breaks; the memo's sections are written with them.
  const body = String(text ?? '').split('\n')
    .map((line, i) => (i ? '<w:br/>' : '') + run(line, { bold, italic, size, color }))
    .join('');
  return `<w:p><w:pPr>${props}</w:pPr>${body}</w:p>`;
}

function borderlessTable(cells, widths) {
  const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const none = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(s => `<w:${s} w:val="none" w:sz="0" w:space="0"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`
    + `<w:tblBorders>${none}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
    + `<w:tblGrid>${grid}</w:tblGrid><w:tr>`
    + cells.map((c, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>${c || '<w:p/>'}</w:tc>`).join('')
    + `</w:tr></w:tbl>`;
}

// Builds the memo. `template` is a memo_templates row (header_title + sections), `fields` are this
// proposal's values, `branding` is the organization's letterhead.
function renderMemoDocx(template, fields, branding = {}) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  zip.folder('word').file('styles.xml', STYLES);
  zip.folder('word').folder('_rels').file('document.xml.rels', DOC_RELS);

  const logo = branding.logo?.buffer ? branding.logo : null;
  const relIds = logo
    ? addImages(zip, [{ buffer: logo.buffer, mimeType: logo.mimeType }], { prefix: 'coasterMemo' })
    : [];

  const body = [];
  body.push(para('Client Confidential', { italic: true, size: 11, color: '4D4D4D', align: 'center', spaceAfter: 60 }));

  const addressLines = String(branding.companyName || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (logo || addressLines.length) {
    const logoCell = logo
      ? drawingParagraph({
        relId: relIds[0], id: 800, align: 'left',
        ...photoExtent(logo.buffer, inches(158 / 72), inches(1.1), logo.mimeType),
      })
      : '';
    const addressCell = addressLines
      .map(line => para(line, { size: 11, color: '404040', align: 'right', spaceAfter: 0 }))
      .join('');
    body.push(borderlessTable([logoCell, addressCell],
      [Math.floor(CONTENT_W / 2), Math.ceil(CONTENT_W / 2)]));
    body.push(para('', { spaceAfter: 120 }));
  }

  if (template?.header_title) {
    body.push(para(fillPlaceholders(template.header_title, fields), { bold: true, spaceAfter: 200 }));
  }

  for (const section of template?.sections || []) {
    body.push(para(fillPlaceholders(section.content, fields), { spaceAfter: 220 }));
    if (section.divider_after) {
      // A rule across the page, as the PDF draws. A bottom border on an empty paragraph is how
      // Word expresses one, and it survives editing as a paragraph the PM can delete.
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="333333"/>'
        + '</w:pBdr><w:spacing w:after="220"/></w:pPr></w:p>');
    }
  }

  zip.folder('word').file('document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document `
    + `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
    + `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<w:body>${body.join('')}${SECTION}</w:body></w:document>`);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { renderMemoDocx };
