const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { embedLogo } = require('./orgBranding');
const { readDocx } = require('./memoCover');
const { PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH, wrapLine } = require('./pdfGen');

// The organization's filled memo cover, as the first page of the merged package.
//
// Proposal Intake staples a memo in front of the vendor's proposal and hands back one PDF. That
// memo page used to be drawn from the old memo_templates rows — a list of section strings edited
// in the database — while the customer's own Word letter was filled separately and offered as a
// download beside it. Two memos, from two different sources, and only the one nobody had written
// went into the document that gets circulated.
//
// So the page is drawn from the .docx now. The letter is filled with this proposal's values, its
// paragraphs are read back, and those are what gets typeset here under the organization's
// letterhead. The consequence that matters: edit the Word file, send it back, and the merged PDF
// changes, because the PDF is made of the Word file's words rather than of a template that merely
// resembled them.
//
// WHAT THIS DOES NOT CARRY. It is a typesetter, not a Word renderer. Paragraph text, paragraph
// breaks and the letterhead survive. A bold word mid-sentence, a table, an image pasted into the
// letter body and the customer's exact font do not — those live in the .docx, which is still
// handed over untouched. Word's own layout would need Word (or LibreOffice) to render it, which is
// a different deployment; this stays inside the app and needs nothing installed.

const BODY_SIZE = 11;
const LINE_GAP = 5;
const PARA_GAP = 9;

// A paragraph in a memo that is a heading rather than prose: short, and either fully capitalised
// or ending in a colon. Drawn bold, which is the only formatting a plain-text read can recover
// honestly — inferring it from the wording rather than pretending to have read the run properties.
function looksLikeHeading(text) {
  if (text.length > 60) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  return /:$/.test(text) && text.split(/\s+/).length <= 6;
}

// Renders the filled memo cover to a one-or-more-page PDF.
//
// `docxBuffer` is the customer's letter with this proposal's values already written into it.
// `branding` is { companyName, logo } from lib/orgBranding.js — the letterhead, which is drawn
// here rather than taken from the document because the .docx carries its own letterhead as an
// image or a header that this cannot read, and printing neither would leave the memo unheaded.
async function renderMemoCoverPdf(docxBuffer, branding = {}) {
  const { paragraphs } = readDocx(docxBuffer);

  // A memo with nothing in it would print as a blank sheet at the front of a package that goes to
  // an owner for signature, and nothing downstream would notice. Refusing is the safe failure: the
  // PM sees a message and still has the document they uploaded.
  if (!paragraphs.some(p => (p || '').trim())) {
    const err = new Error('No text could be read from that memo, so the package was not rebuilt.');
    err.status = 400;
    throw err;
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const logoImage = await embedLogo(pdfDoc, branding.logo);
  let logoDims = { width: 0, height: 0 };
  if (logoImage) {
    const scale = 158 / logoImage.width;   // ~2.2in wide, matching the rest of the app
    logoDims = { width: logoImage.width * scale, height: logoImage.height * scale };
  }

  let page;
  let y;

  // The same letterhead every other document in the app prints, so a memo, a progress report and
  // a pay app review from one company look like they came from one company.
  const drawLetterhead = () => {
    page.drawText('Client Confidential', {
      x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize('Client Confidential', BODY_SIZE)) / 2,
      y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: rgb(0.3, 0.3, 0.3),
    });
    if (logoImage) {
      page.drawImage(logoImage, {
        x: MARGIN - 8, y: PAGE_HEIGHT - 40 - logoDims.height,
        width: logoDims.width, height: logoDims.height,
      });
    }
    const addressLines = String(branding.companyName || '')
      .split('\n').map(l => l.trim()).filter(Boolean);
    let ay = PAGE_HEIGHT - 48;
    for (const line of addressLines) {
      const w = font.widthOfTextAtSize(line, BODY_SIZE);
      page.drawText(line, {
        x: PAGE_WIDTH - MARGIN - w, y: ay, size: BODY_SIZE, font, color: rgb(0.25, 0.25, 0.25),
      });
      ay -= 13;
    }
    // Below whichever of the logo and the address block reaches lower.
    return Math.min(PAGE_HEIGHT - 40 - logoDims.height, ay) - 24;
  };

  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = drawLetterhead();
  };
  newPage();

  // A memo that runs past one page continues onto another rather than being cut off. The old
  // renderer already did this; a customer's own letter is more likely to need it, because it was
  // written to fill a page rather than to fit a code path.
  const ensure = needed => { if (y - needed < MARGIN) newPage(); };

  for (const raw of paragraphs) {
    const text = (raw || '').trim();
    if (!text) { y -= PARA_GAP; continue; }   // a blank paragraph is spacing the writer intended

    const bold = looksLikeHeading(text);
    const f = bold ? fontBold : font;
    for (const line of wrapLine(text, f, BODY_SIZE, CONTENT_WIDTH)) {
      ensure(BODY_SIZE + LINE_GAP);
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= BODY_SIZE + LINE_GAP;
    }
    y -= PARA_GAP;
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderMemoCoverPdf, looksLikeHeading };
