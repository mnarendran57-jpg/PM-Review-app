const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_WIDTH = 612; // 8.5in
const PAGE_HEIGHT = 792; // 11in
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'olivier-logo.jpg');

function fillPlaceholders(text, fields) {
  return (text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => fields[key] ?? '');
}

function wrapLine(line, font, size, maxWidth) {
  if (line === '') return [''];
  const words = line.split(' ');
  const wrapped = [];
  let current = '';
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
      wrapped.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

// Renders a memo template (header_title, company_name, sections[]) filled with
// the given field values into a single-page-or-more cover-sheet PDF buffer,
// using the Olivier Inc. letterhead (logo + address) on every page.
const BODY_SIZE = 10;

async function renderMemoPdf(template, fields) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let logoImage = null;
  let logoDims = { width: 0, height: 0 };
  if (fs.existsSync(LOGO_PATH)) {
    logoImage = await pdfDoc.embedJpg(fs.readFileSync(LOGO_PATH));
    const scale = 158 / logoImage.width; // ~2.2in wide
    logoDims = { width: logoImage.width * scale, height: logoImage.height * scale };
  }

  let page;
  let y;

  const drawLetterhead = () => {
    page.drawText('Client Confidential', {
      x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize('Client Confidential', BODY_SIZE)) / 2,
      y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: rgb(0.3, 0.3, 0.3)
    });
    if (logoImage) {
      page.drawImage(logoImage, { x: MARGIN - 8, y: PAGE_HEIGHT - 40 - logoDims.height, width: logoDims.width, height: logoDims.height });
    }
    // Address block is right-aligned along the page's right margin.
    const addressLines = (template.company_name || '').split('\n');
    let ay = PAGE_HEIGHT - 48;
    for (const line of addressLines) {
      const lineWidth = font.widthOfTextAtSize(line, BODY_SIZE);
      page.drawText(line, { x: PAGE_WIDTH - MARGIN - lineWidth, y: ay, size: BODY_SIZE, font, color: rgb(0.25, 0.25, 0.25) });
      ay -= 13;
    }
    return PAGE_HEIGHT - 40 - logoDims.height - 24;
  };

  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = drawLetterhead();
  };
  newPage();

  const ensureSpace = needed => {
    if (y - needed < MARGIN) newPage();
  };

  const drawText = (text, { bold = false, gapAfter = 5, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    const f = bold ? fontBold : font;
    const lines = (text || '').split('\n').flatMap(l => wrapLine(l, f, BODY_SIZE, CONTENT_WIDTH));
    for (const line of lines) {
      ensureSpace(BODY_SIZE + 5);
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: f, color });
      y -= BODY_SIZE + 5;
    }
    y -= gapAfter;
  };

  if (template.header_title) {
    drawText(template.header_title, { bold: true, gapAfter: 12 });
  } else {
    y -= 8;
  }

  for (const section of template.sections || []) {
    drawText(fillPlaceholders(section.content, fields), { gapAfter: 14 });
    if (section.divider_after) {
      ensureSpace(10);
      page.drawLine({
        start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y },
        thickness: 1.5, color: rgb(0.2, 0.2, 0.2)
      });
      y -= 14;
    }
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// Merges multiple PDF buffers (in order) into one PDF buffer.
async function mergePdfBuffers(buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf) continue;
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

module.exports = { renderMemoPdf, mergePdfBuffers, fillPlaceholders };
