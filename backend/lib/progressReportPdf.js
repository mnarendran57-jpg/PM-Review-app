const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH, wrapLine } = require('./pdfGen');
const { embedLogo } = require('./orgBranding');

const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.4, 0.4, 0.4);
const BODY = 11;

// Renders a site progress report on the reporting organization's letterhead (logo top-left,
// address right-aligned — the same header the memo uses), matching the standard template:
// a header block (Date/Time/Weather, Submitted By, Project, Contractor), a bulleted Progress
// list, and a two-column grid of site photos each captioned underneath.
// There is deliberately no default letterhead. An organization that has uploaded none gets a
// clean report rather than another company's address, which is what used to happen.
async function renderProgressReportPdf({ report, header, photos = [], companyName = null, logo = null }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Whatever this organization uploaded, or nothing at all.
  const logoImage = await embedLogo(pdf, logo);
  let logoDims = { width: 0, height: 0 };
  if (logoImage) {
    const scale = 158 / logoImage.width;
    logoDims = { width: logoImage.width * scale, height: logoImage.height * scale };
  }

  let page;
  let y;

  const drawLetterhead = () => {
    if (logoImage) {
      page.drawImage(logoImage, {
        x: MARGIN - 8, y: PAGE_HEIGHT - 40 - logoDims.height,
        width: logoDims.width, height: logoDims.height,
      });
    }
    // Address block, right-aligned along the right margin.
    let ay = PAGE_HEIGHT - 48;
    for (const line of (companyName || '').split('\n')) {
      const w = font.widthOfTextAtSize(line, 9);
      page.drawText(line, { x: PAGE_WIDTH - MARGIN - w, y: ay, size: 9, font, color: rgb(0.25, 0.25, 0.25) });
      ay -= 12;
    }
    // Content starts below whichever of logo / address block is taller.
    const logoBottom = PAGE_HEIGHT - 40 - logoDims.height;
    return Math.min(logoBottom, ay) - 16;
  };

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = drawLetterhead();
  };
  const ensure = needed => { if (y - needed < MARGIN) newPage(); };

  const text = (str, { x = MARGIN, size = BODY, f = font, color = INK } = {}) => {
    page.drawText(str, { x, y, size, font: f, color });
  };

  newPage();

  // Title
  const num = header.reportNumber != null ? `-${header.reportNumber}` : '';
  const title = `${header.projectName || 'Project'} Progress Report${num}`;
  for (const line of wrapLine(title, bold, 15, CONTENT_WIDTH)) {
    ensure(20); text(line, { size: 15, f: bold }); y -= 20;
  }
  y -= 6;

  // Header block
  const metaLine = `Date: ${header.visitDate || '—'}      Time: ${header.visitTime || '—'}      Weather: ${header.weather || '—'}`;
  const rows = [
    metaLine,
    `Submitted By: ${header.submittedBy || '—'}`,
    `Project: ${header.projectName || '—'}`,
    `Contractor: ${header.contractor || '—'}`,
  ];
  for (const r of rows) { ensure(16); text(r); y -= 16; }
  y -= 8;

  // Progress
  ensure(20); text('Progress:', { size: 12, f: bold }); y -= 18;
  if (report.progress.length === 0) {
    ensure(15); text('No observations recorded.', { color: GREY }); y -= 15;
  } else {
    for (const p of report.progress) {
      const wrapped = wrapLine(p, font, BODY, CONTENT_WIDTH - 16);
      wrapped.forEach((line, i) => {
        ensure(15);
        if (i === 0) text('•', { x: MARGIN, color: INK });
        text(line, { x: MARGIN + 14 }); y -= 15;
      });
      y -= 2;
    }
  }
  y -= 10;

  // Site Pictures — two-column grid, caption under each image
  ensure(20); text('Site Pictures:', { size: 12, f: bold }); y -= 20;

  const GAP = 16;
  const cellW = (CONTENT_WIDTH - GAP) / 2;
  const MAX_IMG_H = 200;

  const embedded = [];
  for (const ph of photos) {
    if (!ph.buffer) continue;
    try {
      const img = /png/i.test(ph.mimeType || '') ? await pdf.embedPng(ph.buffer) : await pdf.embedJpg(ph.buffer);
      let dispW = cellW;
      let dispH = (img.height / img.width) * dispW;
      if (dispH > MAX_IMG_H) { dispH = MAX_IMG_H; dispW = (img.width / img.height) * dispH; }
      embedded.push({ img, dispW, dispH, caption: ph.caption || '' });
    } catch {
      embedded.push({ img: null, dispW: cellW, dispH: 0, caption: ph.caption || '' });
    }
  }

  for (let i = 0; i < embedded.length; i += 2) {
    const pair = embedded.slice(i, i + 2);
    const rowImgH = Math.max(...pair.map(p => p.dispH), 0);
    const capLines = pair.map(p => wrapLine(p.caption, font, 9, cellW));
    const rowCapH = Math.max(...capLines.map(l => l.length), 1) * 12 + 6;
    ensure(rowImgH + rowCapH + 10);

    const rowTop = y;
    pair.forEach((p, col) => {
      const x = MARGIN + col * (cellW + GAP);
      const imgX = x + (cellW - p.dispW) / 2;
      if (p.img) {
        page.drawImage(p.img, { x: imgX, y: rowTop - p.dispH, width: p.dispW, height: p.dispH });
      }
      let cy = rowTop - rowImgH - 12;
      for (const line of capLines[col]) {
        const lw = font.widthOfTextAtSize(line, 9);
        page.drawText(line, { x: x + (cellW - lw) / 2, y: cy, size: 9, font, color: GREY });
        cy -= 12;
      }
    });
    y = rowTop - rowImgH - rowCapH - 12;
  }

  return Buffer.from(await pdf.save());
}

module.exports = { renderProgressReportPdf };
