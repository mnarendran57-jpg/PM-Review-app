const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money } = require('./payAppChecks');
const {
  wrapLine, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH, LOGO_PATH,
} = require('./pdfGen');

const BODY_SIZE = 10;
const RED = rgb(0.65, 0.13, 0.13);
const GREY = rgb(0.35, 0.35, 0.35);
const INK = rgb(0.1, 0.1, 0.1);

// Renders the pay app review report as a client-facing PDF on Olivier letterhead.
// Consumes the same object buildReport() already returns, so the PDF and the
// markdown export never drift apart. Deliberately omits check IDs and the
// pass/skip detail — those are internal, and this document goes to a client.
async function renderPayAppReportPdf({ report, companyName }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let logoImage = null;
  let logoDims = { width: 0, height: 0 };
  if (fs.existsSync(LOGO_PATH)) {
    logoImage = await pdfDoc.embedJpg(fs.readFileSync(LOGO_PATH));
    const scale = 158 / logoImage.width;
    logoDims = { width: logoImage.width * scale, height: logoImage.height * scale };
  }

  let page;
  let y;

  const drawLetterhead = () => {
    const label = 'Client Confidential';
    page.drawText(label, {
      x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize(label, BODY_SIZE)) / 2,
      y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: GREY,
    });
    if (logoImage) {
      page.drawImage(logoImage, {
        x: MARGIN - 8, y: PAGE_HEIGHT - 40 - logoDims.height,
        width: logoDims.width, height: logoDims.height,
      });
    }
    let ay = PAGE_HEIGHT - 48;
    for (const line of (companyName || '').split('\n')) {
      const w = font.widthOfTextAtSize(line, BODY_SIZE);
      page.drawText(line, { x: PAGE_WIDTH - MARGIN - w, y: ay, size: BODY_SIZE, font, color: rgb(0.25, 0.25, 0.25) });
      ay -= 13;
    }
    return PAGE_HEIGHT - 40 - logoDims.height - 24;
  };

  const newPage = () => { page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = drawLetterhead(); };
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

  const h = report.header;

  text('Pay Application Review', { bold: true, size: 16, gapAfter: 6 });
  text(h.projectName, { size: 12, color: GREY, gapAfter: 10 });
  rule();

  // Facts the client needs to identify which application this is.
  text(`Application #: ${h.applicationNumber}     Period To: ${h.periodTo}`, { gapAfter: 10 });

  text('Summary', { bold: true, size: 12, gapAfter: 5 });
  text(report.plainEnglish, { gapAfter: 12 });

  text('The Numbers', { bold: true, size: 12, gapAfter: 5 });
  const rows = [
    ['Current payment requested', money(h.currentPaymentDue)],
    ['Total completed & stored to date', money(h.totalCompletedToDate)],
    ['Contract sum to date', money(h.contractSumToDate)],
    ['Balance remaining to finish', money(h.balanceToFinish)],
  ];
  if (h.billedPct != null) rows.push(['Percent of contract billed', `${h.billedPct.toFixed(1)}%`]);
  if (h.retainedPct != null) rows.push(['Percent retained', `${h.retainedPct.toFixed(1)}%`]);
  for (const [label, value] of rows) {
    ensureSpace(BODY_SIZE + 4);
    page.drawText(label, { x: MARGIN, y, size: BODY_SIZE, font, color: INK });
    const vw = fontBold.widthOfTextAtSize(value, BODY_SIZE);
    page.drawText(value, { x: PAGE_WIDTH - MARGIN - vw, y, size: BODY_SIZE, font: fontBold, color: INK });
    y -= BODY_SIZE + 5;
  }
  y -= 8;

  const issues = [...report.critical, ...report.mathErrors];
  text('Issues Found', { bold: true, size: 12, gapAfter: 5 });
  if (issues.length === 0) {
    text('None. Every figure checked was internally consistent and within contract limits.', { italic: true, gapAfter: 12 });
  } else {
    for (const r of issues) {
      text(`• ${r.description}`, { bold: true, gapAfter: 2 });
      text(r.detail, { indent: 12, gapAfter: 7 });
    }
    y -= 4;
  }

  text('To Verify On Site Before Approving', { bold: true, size: 12, gapAfter: 5 });
  if (report.checklist.length === 0) {
    text('Nothing new was billed this period, so there is no new work to confirm on site.', { italic: true, gapAfter: 12 });
  } else {
    for (const item of report.checklist) {
      // Reserve the whole item so the drawn checkbox can't be orphaned from its text
      // by a page break landing between them.
      ensureSpace(BODY_SIZE * 3 + 16);
      page.drawRectangle({
        x: MARGIN, y: y - 1, width: 8.5, height: 8.5,
        borderWidth: 0.8, borderColor: INK,
      });
      text(`${item.description} — ${money(item.amount)}${item.isNew ? '  (new this period)' : ''}`, { bold: true, indent: 15, gapAfter: 2 });
      text(item.detail, { indent: 15, gapAfter: 7 });
    }
    y -= 4;
  }

  rule();
  const passed = report.cleanBill.length;
  const skipped = report.warnings.length;
  text(
    `Checks performed: ${passed} passed, ${issues.length} flagged, ${skipped} not applicable to this application.`,
    { size: 9, color: GREY, gapAfter: 4 }
  );
  text(
    'This review confirms that the figures on this application are internally consistent and within contract limits. ' +
    'It does not confirm that the billed work was physically completed — that requires the site verification above.',
    { size: 9, italic: true, color: GREY }
  );

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderPayAppReportPdf };
