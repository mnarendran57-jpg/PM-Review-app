const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { embedLogo } = require('./orgBranding');

const PAGE_WIDTH = 612; // 8.5in
const PAGE_HEIGHT = 792; // 11in
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// The logo is no longer a file on disk. It belongs to the organization printing the document
// and arrives as a parameter — see lib/orgBranding.js. The constant is kept only because the
// path is still referenced by the one-off asset that shipped with the first deployment.
const LEGACY_LOGO_PATH = path.join(__dirname, '..', 'assets', 'olivier-logo.jpg');

function fillPlaceholders(text, fields) {
  return (text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => fields[key] ?? '');
}

// THE STANDARD PDF FONTS CANNOT WRITE EVERY CHARACTER, and they raise rather than skip.
//
// pdf-lib's built-in fonts encode WinAnsi, which covers the em dash, the section sign and curly
// quotes but NOT the arrow, the approximately-equal sign, the true minus, or the comparison
// operators. Handed one of those, both drawText and widthOfTextAtSize throw, and a whole report
// that had already been produced comes back as a 500 with nothing to show the PM.
//
// That was survivable while the text in these documents was written in code. It stopped being
// survivable once a review could put the model's own prose on the page: "5% -> 85%" and "~$800"
// are the natural way to write those things, and neither can be printed.
//
// So the unprintable characters are translated to what a typesetter would have used before the
// glyphs existed, and anything still unencodable is dropped rather than allowed to take the
// document down with it. A PDF with "->" in it is a small blemish. A PDF that does not exist is
// the difference between a review and no review.
// Only characters WinAnsi genuinely lacks. Curly quotes, the em dash, the ellipsis, the bullet,
// the section sign, ×, ÷, ± and ° all encode perfectly well, and rewriting them would be an
// unprompted downgrade of the typography on a document that goes to a client.
const SUBSTITUTIONS = [
  [/[→➡]/g, '->'], [/←/g, '<-'], [/↔/g, '<->'],
  [/≈/g, '~'], [/≠/g, '!='], [/≤/g, '<='], [/≥/g, '>='],
  [/−/g, '-'],
  [/[✅✔✓]/g, 'yes'], [/[❌✗]/g, 'no'],
  [/[   ⁠]/g, ' '],
];

// WinAnsi is Latin-1 plus a handful of typographic characters in 0x80–0x9F. Anything outside what
// the substitutions above rescue is removed.
const ENCODABLE = /[\t\n\r\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/;

function toWinAnsi(text) {
  let s = String(text ?? '');
  for (const [pattern, replacement] of SUBSTITUTIONS) s = s.replace(pattern, replacement);
  return [...s].filter(ch => ENCODABLE.test(ch)).join('');
}

function wrapLine(line, font, size, maxWidth) {
  if (line === '') return [''];
  const words = toWinAnsi(line).split(' ');
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

async function renderMemoPdf(template, fields, branding = {}) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  // Whatever this organization uploaded, or nothing. An organization that has uploaded no
  // logo prints an address-only letterhead rather than borrowing someone else's mark.
  let logoImage = await embedLogo(pdfDoc, branding.logo);
  let logoDims = { width: 0, height: 0 };
  if (logoImage) {
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
    // Address block is right-aligned along the page's right margin. The organization's own
    // letterhead wins over the copy stored on the template, so editing it in one place
    // updates every memo rather than only newly created templates. Blank lines are dropped
    // so a trailing newline does not push the block up the page.
    const addressLines = String(branding.companyName || template.company_name || '')
      .split('\n').map(l => l.trim()).filter(Boolean);
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

module.exports = {
  renderMemoPdf, mergePdfBuffers, fillPlaceholders, wrapLine, toWinAnsi,
  PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH, LEGACY_LOGO_PATH,
};
