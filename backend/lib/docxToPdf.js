const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { embedLogo } = require('./orgBranding');
const { readBlocks } = require('./docxRead');
const { PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH, wrapLine } = require('./pdfGen');

// Turning an edited Word document back into the PDF that gets circulated.
//
// Both modules hand the PM a .docx of what Coaster produced — the memo in front of a proposal
// package, the write-up of a site visit — precisely so they can change it. A memo routinely needs
// a condition of approval added after the fact; a site report needs a trade named properly, or a
// photograph dropped because it turned out to show nothing. Until the edited file could be turned
// back into a PDF, those edits lived only in the PM's own copy while everyone else kept receiving
// the version Coaster generated.
//
// This reads the document in order — paragraphs and photographs as they appear — and lays it out
// under the organization's letterhead. Moving a photo, deleting one, or writing a sentence between
// two of them all come through, because the order of the blocks IS the edit.
//
// WHAT IT DOES NOT CARRY, stated plainly because it will come up. This is a typesetter, not a Word
// renderer. Text, paragraph breaks, pictures and their order survive; a bold word mid-sentence, a
// table, a text box and the customer's exact font do not. Those live in the .docx, which is still
// handed over untouched — it remains the editable original. Reproducing Word's own layout needs
// Word or LibreOffice, which is a different deployment; this stays inside the app and needs
// nothing installed.

const BODY_SIZE = 11;
const LINE_GAP = 5;
const PARA_GAP = 9;
const CAPTION_SIZE = 9;

// A photo is printed at a size a report reads well at, not at whatever Word was showing.
const MAX_IMAGE_W = CONTENT_WIDTH * 0.62;
const MAX_IMAGE_H = 260;

// A paragraph that reads as a heading rather than prose: short, and either fully capitalised or
// ending in a colon. Drawn bold — the only formatting a plain-text read can recover honestly,
// inferred from the wording rather than pretended to have been read from the run properties.
function looksLikeHeading(text) {
  if (text.length > 60) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  return /:$/.test(text) && text.split(/\s+/).length <= 6;
}

// Renders a .docx to PDF bytes.
//
// `branding` is { companyName, logo } from lib/orgBranding.js. The letterhead is drawn here rather
// than taken from the document, because a customer's letterhead usually lives in a Word header or
// as an image this does not read, and printing neither would leave the page unheaded.
// `confidential` prints the standing marking the memo package has always carried.
async function renderDocxAsPdf(docxBuffer, { branding = {}, confidential = false } = {}) {
  const blocks = readBlocks(docxBuffer);
  if (!blocks.some(b => (b.type === 'text' && b.text) || b.type === 'image')) {
    const err = new Error('No text could be read from that document, so nothing was rebuilt.');
    err.status = 400;
    throw err;
  }

  // Does the document already carry the letterhead in its own body?
  //
  // Coaster's own Word memo and Word report both print the company's address at the top, because
  // they have to look right when opened in Word. Drawing it again here put it on the page twice.
  // A customer's uploaded letter, by contrast, usually keeps its letterhead in a Word header or as
  // an image, neither of which is read back — so for those it must still be drawn.
  //
  // Deciding by what is actually in the opening of the document handles both without needing to
  // know where the file came from, which matters because after a PM edits it, it could be either.
  const opening = blocks.filter(b => b.type === 'text').slice(0, 10).map(b => b.text);
  const addressLines = String(branding.companyName || '')
    .split('\n').map(l => l.trim()).filter(Boolean);
  const alreadyHeaded = addressLines.length > 0
    && addressLines.some(line => opening.some(t => t === line));
  const alreadyMarked = opening.some(t => /^client confidential$/i.test(t));

  const drawHeader = !alreadyHeaded;
  const drawMark = confidential && !alreadyMarked;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const logoImage = drawHeader ? await embedLogo(pdfDoc, branding.logo) : null;
  let logoDims = { width: 0, height: 0 };
  if (logoImage) {
    const scale = 158 / logoImage.width;   // ~2.2in wide, as everywhere else in the app
    logoDims = { width: logoImage.width * scale, height: logoImage.height * scale };
  }

  let page;
  let y;

  const drawLetterhead = () => {
    if (drawMark) {
      page.drawText('Client Confidential', {
        x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize('Client Confidential', BODY_SIZE)) / 2,
        y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: rgb(0.3, 0.3, 0.3),
      });
    }
    if (logoImage) {
      page.drawImage(logoImage, {
        x: MARGIN - 8, y: PAGE_HEIGHT - 40 - logoDims.height,
        width: logoDims.width, height: logoDims.height,
      });
    }
    const lines = drawHeader ? addressLines : [];
    let ay = PAGE_HEIGHT - 48;
    for (const line of lines) {
      const w = font.widthOfTextAtSize(line, BODY_SIZE);
      page.drawText(line, {
        x: PAGE_WIDTH - MARGIN - w, y: ay, size: BODY_SIZE, font, color: rgb(0.25, 0.25, 0.25),
      });
      ay -= 13;
    }
    if (!logoImage && lines.length === 0) return PAGE_HEIGHT - (drawMark ? 52 : MARGIN);
    return Math.min(PAGE_HEIGHT - 40 - logoDims.height, ay) - 24;
  };

  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = drawLetterhead();
  };
  newPage();

  const ensure = needed => { if (y - needed < MARGIN) newPage(); };

  // The paragraph immediately after a picture is its caption, and is centred under it — that is
  // what the report's own layout does, and a caption left ranged left under a centred photo reads
  // as a new paragraph rather than as a label.
  let afterImage = false;

  for (const block of blocks) {
    if (block.type === 'image') {
      let img;
      try {
        img = /png/i.test(block.mimeType)
          ? await pdfDoc.embedPng(block.buffer)
          : await pdfDoc.embedJpg(block.buffer);
      } catch (err) {
        // One unreadable picture costs that picture, not the document the PM is waiting for.
        console.warn('[docx->pdf] a picture could not be embedded:', err.message);
        continue;
      }
      let w = MAX_IMAGE_W;
      let h = (img.height / img.width) * w;
      if (h > MAX_IMAGE_H) { h = MAX_IMAGE_H; w = (img.width / img.height) * h; }

      ensure(h + 8);
      page.drawImage(img, { x: MARGIN + (CONTENT_WIDTH - w) / 2, y: y - h, width: w, height: h });
      y -= h + 6;
      afterImage = true;
      continue;
    }

    if (!block.text) { y -= PARA_GAP; afterImage = false; continue; }

    const caption = afterImage;
    const size = caption ? CAPTION_SIZE : BODY_SIZE;
    const f = (!caption && looksLikeHeading(block.text)) ? fontBold : font;
    const color = caption ? rgb(0.35, 0.35, 0.35) : rgb(0.1, 0.1, 0.1);

    for (const line of wrapLine(block.text, f, size, CONTENT_WIDTH)) {
      ensure(size + LINE_GAP);
      const x = caption
        ? MARGIN + (CONTENT_WIDTH - f.widthOfTextAtSize(line, size)) / 2
        : MARGIN;
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + LINE_GAP;
    }
    y -= caption ? PARA_GAP + 4 : PARA_GAP;
    afterImage = false;
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderDocxAsPdf, looksLikeHeading };
