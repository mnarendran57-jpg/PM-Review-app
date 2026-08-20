const PizZip = require('pizzip');
const { escapeXml } = require('./docxImages');
const { attachLetterhead } = require('./docxLetterhead');
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

const SECTION_BODY = `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
  + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"`
  + ` w:header="720" w:footer="720" w:gutter="0"/>`;

function run(text, { bold, italic, size = 11, color = '1A1A1A' } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}`
    + `<w:sz w:val="${pt(size)}"/><w:szCs w:val="${pt(size)}"/><w:color w:val="${color}"/></w:rPr>`
    + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// One paragraph per line, rather than one paragraph with <w:br/> inside it.
//
// A memo section is written with line breaks in it — the To/From/Date block, the two signature
// lines. Expressing those as breaks inside a single paragraph looks the same in Word and reads as
// one run of text to anything that walks the XML, so the rebuilt PDF came out with
// "Date: 08/04/2026To: James WalkerFrom: Devin Roy" on one line. Separate paragraphs survive the
// round trip, and are what a PM would get if they typed the memo themselves.
function paras(text, opts = {}) {
  const lines = String(text ?? '').split('\n');
  return lines.map((line, i) => para(line, {
    ...opts,
    // The gap belongs after the last line of the block, not between its lines.
    spaceAfter: i === lines.length - 1 ? (opts.spaceAfter ?? 120) : 20,
  })).join('');
}

function para(text, { bold, italic, size, color, align, spaceAfter = 120 } = {}) {
  const props = `${align ? `<w:jc w:val="${align}"/>` : ''}<w:spacing w:after="${spaceAfter}"/>`;
  return `<w:p><w:pPr>${props}</w:pPr>${run(text, { bold, italic, size, color })}</w:p>`;
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

  // The letterhead goes in a Word header part, not into the body. See lib/docxLetterhead.js —
  // in the body it came back on rebuild as a picture with the company name captioned under it.
  const headerRef = attachLetterhead(zip, { ...branding, confidential: true });

  const body = [];
  if (template?.header_title) {
    body.push(para(fillPlaceholders(template.header_title, fields), { bold: true, spaceAfter: 200 }));
  }

  for (const section of template?.sections || []) {
    body.push(paras(fillPlaceholders(section.content, fields), { spaceAfter: 220 }));
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
    + `<w:body>${body.join('')}<w:sectPr>${headerRef}${SECTION_BODY}</w:sectPr></w:body></w:document>`);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { renderMemoDocx };
