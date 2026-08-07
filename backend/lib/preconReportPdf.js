const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapLine, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH } = require('./pdfGen');

const BODY_SIZE = 10;
const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.35, 0.35, 0.35);
const AMBER = rgb(0.71, 0.33, 0.05);

// Renders the pre-construction review as a plain, unbranded report. Deliberately carries no
// company letterhead: this is a standard output every organization gets the same way, and the
// previous version printed whichever letterhead happened to be first in the database — which
// meant one customer's address on another customer's report.
//
// Built from the same analysis object the markdown export uses, so the two cannot drift apart.
// Every finding is tagged confirmed or assumption, and that distinction is carried into the
// PDF rather than flattened: this document leaves the office, and a reader has to be able to
// tell what the drawings actually say from what the model inferred.
async function renderPreconReportPdf({ projectName, reviewFocus, fileNames, analysis }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let page;
  let y;

  // A running head rather than a letterhead: what the document is and who it is for, with no
  // company identity attached. The project name carries onto later pages so a printed report
  // does not come apart once the first page is separated from it.
  const drawRunningHead = () => {
    const label = 'Client Confidential';
    page.drawText(label, {
      x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize(label, BODY_SIZE)) / 2,
      y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: GREY,
    });
    if (pdfDoc.getPageCount() > 1 && projectName) {
      const width = font.widthOfTextAtSize(projectName, 8);
      page.drawText(projectName, {
        x: PAGE_WIDTH - MARGIN - width, y: PAGE_HEIGHT - 44, size: 8, font, color: GREY,
      });
      page.drawText('Pre-Construction Review', {
        x: MARGIN, y: PAGE_HEIGHT - 44, size: 8, font, color: GREY,
      });
      return PAGE_HEIGHT - 62;
    }
    return PAGE_HEIGHT - 48;
  };

  const newPage = () => { page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = drawRunningHead(); };
  newPage();

  const ensureSpace = needed => { if (y - needed < MARGIN) newPage(); };

  const text = (str, { bold = false, italic = false, size = BODY_SIZE, color = INK, indent = 0, gapAfter = 4 } = {}) => {
    const f = bold ? fontBold : italic ? fontItalic : font;
    const lines = (str || '').split('\n').flatMap(l => wrapLine(l, f, size, CONTENT_WIDTH - indent));
    for (const line of lines) {
      ensureSpace(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size + 4;
    }
    y -= gapAfter;
  };

  const rule = () => {
    ensureSpace(10);
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5, color: rgb(0.75, 0.75, 0.75),
    });
    y -= 12;
  };

  // A callout box, used for the warnings a reader must not skim past.
  const notice = (heading, body, colour) => {
    const lines = wrapLine(body, font, 9, CONTENT_WIDTH - 20);
    const height = 22 + lines.length * 12;
    ensureSpace(height + 8);
    page.drawRectangle({
      x: MARGIN, y: y - height + 10, width: CONTENT_WIDTH, height,
      color: rgb(0.99, 0.96, 0.9), borderColor: colour, borderWidth: 0.8,
    });
    page.drawText(heading, { x: MARGIN + 10, y: y - 4, size: 9, font: fontBold, color: colour });
    lines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + 10, y: y - 18 - i * 12, size: 9, font, color: INK });
    });
    y -= height + 8;
  };

  // Findings are either plain strings (questions, action items) or { text, basis } objects.
  // The basis tag is what tells a reader whether this is in the documents or inferred.
  const findings = (title, items, emptyText) => {
    ensureSpace(40);
    text(title, { bold: true, size: 12, gapAfter: 5 });
    if (!items || items.length === 0) {
      text(emptyText, { italic: true, color: GREY, gapAfter: 12 });
      return;
    }
    for (const item of items) {
      const body = typeof item === 'string' ? item : item.text;
      const basis = typeof item === 'string' ? null : item.basis;
      ensureSpace(BODY_SIZE * 2 + 10);

      // The bullet and its tag sit on the same baseline as the first wrapped line.
      page.drawCircle({ x: MARGIN + 4, y: y + 3.5, size: 1.8, color: GREY });
      if (basis) {
        const tag = basis === 'confirmed' ? 'IN THE DOCUMENTS' : 'ASSUMPTION';
        const colour = basis === 'confirmed' ? rgb(0.08, 0.5, 0.24) : AMBER;
        page.drawText(tag, { x: MARGIN + 12, y: y + 1, size: 6.5, font: fontBold, color: colour });
        y -= 10;
      }
      text(body, { indent: 12, gapAfter: 7 });
    }
    y -= 4;
  };

  text('Pre-Construction Review', { bold: true, size: 16, gapAfter: 6 });
  if (projectName) text(projectName, { size: 12, color: GREY, gapAfter: 10 });
  rule();

  text(`Documents reviewed: ${(fileNames || []).join(', ') || 'Not recorded'}`, { size: 9, color: GREY, gapAfter: 3 });
  if (reviewFocus) text(`Review focus requested: ${reviewFocus}`, { size: 9, color: GREY, gapAfter: 3 });
  y -= 6;

  if (analysis.insufficientInfo) {
    notice(
      'THE DOCUMENTS DO NOT SUPPORT A COMPLETE REVIEW',
      analysis.insufficientInfoNote || 'Additional documents are needed.',
      AMBER
    );
  } else if (analysis.coverage && analysis.coverage.passesRead < analysis.coverage.passesTotal) {
    // A partially-read set produces findings that look complete but are not. Saying so at the
    // top is the difference between a useful partial review and a misleading one.
    notice(
      'THIS REVIEW IS PARTIAL',
      `Only ${analysis.coverage.passesRead} of ${analysis.coverage.passesTotal} sections of the uploaded set could be read. `
      + 'The findings below cover the sections that were read.',
      AMBER
    );
  }

  text('Project / Document Summary', { bold: true, size: 12, gapAfter: 5 });
  text(analysis.documentSummary || 'Not available.', { gapAfter: 12 });

  findings('Potential Risks', analysis.risks, 'None identified.');
  findings('High-Cost Items', analysis.highCostItems, 'None identified.');
  findings('Potential Change Order Areas', analysis.changeOrderAreas, 'None identified.');
  findings('Missing or Unclear Information', analysis.missingInfo, 'Nothing outstanding was identified.');
  findings('Recommended Action Items', analysis.actionItems, 'None identified.');

  rule();
  text(
    'This review reads the uploaded documents and reports what they appear to show. Items marked '
    + 'ASSUMPTION are inferences from normal construction practice, not statements from the documents, '
    + 'and should be confirmed before being relied on for cost or programme decisions.',
    { size: 9, italic: true, color: GREY }
  );

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderPreconReportPdf };
