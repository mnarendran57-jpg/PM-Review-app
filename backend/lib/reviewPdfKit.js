const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapLine, toWinAnsi, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH } = require('./pdfGen');
const { money } = require('./money');
const { citeLabel } = require('./contractClauses');

// The pieces a review report is drawn from — a title block, a verdict banner, a row of counts, and
// small tables of the figures behind each finding — shared by the change order and invoice reports
// so the two look like one product and a fix to one is a fix to both.
//
// Unbranded, like the other standard reports, and every string goes through toWinAnsi: the standard
// PDF fonts throw on characters they cannot encode, and one typographic dash in a line description
// would otherwise take down the whole download.

const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.86, 0.87, 0.89);
const HEAD_BG = rgb(0.96, 0.965, 0.975);
const TONES = {
  red: { fill: rgb(0.996, 0.949, 0.949), ink: rgb(0.72, 0.11, 0.11) },
  amber: { fill: rgb(1, 0.969, 0.929), ink: rgb(0.76, 0.25, 0.05) },
  green: { fill: rgb(0.925, 0.992, 0.961), ink: rgb(0.02, 0.47, 0.34) },
  grey: { fill: rgb(0.973, 0.976, 0.98), ink: GREY },
  indigo: { fill: rgb(0.933, 0.949, 1), ink: rgb(0.26, 0.22, 0.79) },
};
const PAD = 6;

// `kind` is the report's name ("Change Order Review"), `name` what this one is about. Both appear in
// the running head from the second page on.
async function createReviewPdf({ kind, name }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let page;
  let y;
  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - 46;
    if (pdfDoc.getPageCount() > 1) {
      page.drawText(toWinAnsi(kind), { x: MARGIN, y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      const label = toWinAnsi(name).slice(0, 90);
      page.drawText(label, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(label, 8), y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      y = PAGE_HEIGHT - 54;
    }
  };
  newPage();
  const ensure = needed => { if (y - needed < MARGIN) newPage(); };
  const gap = n => { y -= n; };

  const text = (str, { f = font, size = 9.5, color = INK, x = MARGIN, width = CONTENT_WIDTH, gapAfter = 4 } = {}) => {
    for (const line of wrapLine(toWinAnsi(String(str || '')), f, size, width)) {
      ensure(size + 3);
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + 3;
    }
    y -= gapAfter;
  };

  // A table row, measured first so it is never split across a page.
  const row = (cells, { head = false } = {}) => {
    const size = head ? 7.5 : 9;
    const laid = cells.map(cell => {
      const parts = (cell.parts || []).map(p => ({
        ...p,
        lines: wrapLine(toWinAnsi(String(p.text ?? '')), p.f || font, p.size || size, cell.width - PAD * 2),
      }));
      return { ...cell, parts, height: parts.reduce((n, p) => n + p.lines.length * ((p.size || size) + 2.5), 0) };
    });
    const height = Math.max(10, ...laid.map(c => c.height)) + PAD * 2;
    ensure(height);
    if (head) page.drawRectangle({ x: MARGIN, y: y - height + PAD + 2, width: CONTENT_WIDTH, height, color: HEAD_BG });
    let x = MARGIN;
    for (const cell of laid) {
      let cy = y - 2;
      for (const part of cell.parts) {
        const s = part.size || size;
        for (const line of part.lines) {
          const w = (part.f || font).widthOfTextAtSize(line, s);
          const lx = part.align === 'right' ? x + cell.width - PAD - w : x + PAD;
          page.drawText(line, { x: lx, y: cy, size: s, font: part.f || font, color: part.color || INK });
          cy -= s + 2.5;
        }
      }
      x += cell.width;
    }
    y -= height;
    page.drawLine({ start: { x: MARGIN, y: y + PAD }, end: { x: PAGE_WIDTH - MARGIN, y: y + PAD }, thickness: 0.4, color: RULE });
    y -= 2;
  };

  // A section heading with its count beside it. Enough room is kept for the heading and the first
  // lines under it, so a heading is never left alone at the foot of a page.
  const heading = (title, count, tone = 'grey') => {
    ensure(80);
    y -= 6;
    page.drawText(toWinAnsi(title), { x: MARGIN, y, size: 11.5, font: bold, color: INK });
    if (count != null) {
      const label = String(count);
      const w = bold.widthOfTextAtSize(label, 9) + 10;
      const x = MARGIN + bold.widthOfTextAtSize(toWinAnsi(title), 11.5) + 8;
      page.drawRectangle({ x, y: y - 3, width: w, height: 14, color: TONES[tone].fill });
      page.drawText(label, { x: x + 5, y, size: 9, font: bold, color: TONES[tone].ink });
    }
    y -= 14;
  };

  const titleBlock = ({ title, facts, checkedAgainst }) => {
    text(kind, { f: bold, size: 9, color: GREY, gapAfter: 7 });
    text(title, { f: bold, size: 16, gapAfter: 4 });
    if (facts) text(facts, { size: 9.5, color: GREY, gapAfter: 2 });
    if (checkedAgainst?.length) text(`Checked against ${checkedAgainst.join(', ')}.`, { size: 8.5, color: GREY, gapAfter: 10 });
  };

  const verdictBanner = (v) => {
    const tone = TONES[v.tone];
    ensure(40);
    page.drawRectangle({ x: MARGIN, y: y - 22, width: CONTENT_WIDTH, height: 34, color: tone.fill });
    page.drawRectangle({ x: MARGIN, y: y - 22, width: 4, height: 34, color: tone.ink });
    page.drawText(toWinAnsi(v.headline), { x: MARGIN + 14, y: y - 4, size: 13, font: bold, color: tone.ink });
    if (v.sub) {
      const hx = MARGIN + 14 + bold.widthOfTextAtSize(toWinAnsi(v.headline), 13) + 6;
      page.drawText(toWinAnsi(v.sub), { x: hx, y: y - 4, size: 10, font, color: tone.ink });
    }
    y -= 40;
  };

  // `toneOf(tile)` decides each tile's colour; a count of null is "not checked".
  const countTiles = (tiles, toneOf) => {
    const space = 8;
    const tw = (CONTENT_WIDTH - space * (tiles.length - 1)) / tiles.length;
    ensure(52);
    tiles.forEach((t, i) => {
      const x = MARGIN + i * (tw + space);
      const checked = t.count != null;
      const tt = TONES[checked ? toneOf(t) : 'grey'];
      page.drawRectangle({ x, y: y - 36, width: tw, height: 44, color: tt.fill });
      page.drawText(checked ? String(t.count) : '—', { x: x + 10, y: y - 12, size: 17, font: bold, color: tt.ink });
      page.drawText(toWinAnsi(t.label), { x: x + 10, y: y - 28, size: 8, font, color: GREY });
      if (!checked) {
        const nc = 'not checked';
        page.drawText(nc, { x: x + tw - 10 - italic.widthOfTextAtSize(nc, 7), y: y - 12, size: 7, font: italic, color: GREY });
      }
    });
    y -= 50;
  };

  const passedLines = (passed, notChecked) => {
    if (passed?.length) text(`Checked and fine: ${passed.join(', ')}.`, { size: 8, color: GREY, gapAfter: 1 });
    if (notChecked?.length) text(`Could not be checked: ${notChecked.map(n => n.description).join(', ')}.`, { size: 8, color: GREY, gapAfter: 1 });
    y -= 4;
  };

  // Room is kept for the title, the table's head and a first row — taller now that a row can carry
  // the contract's own words — so a finding's name never sits alone at the foot of a page.
  const findingTitle = (f, resolveWord) => {
    ensure(110);
    text(`${f.title}${f.critical ? `  —  resolve before ${resolveWord}` : ''}`, { f: bold, size: 9.5, color: f.critical ? TONES.red.ink : INK, gapAfter: 2 });
    if (f.byCoaster) text("Coaster's reading of the contract — verify before acting.", { size: 8, f: italic, color: GREY, gapAfter: 2 });
  };

  // Where the contract says it, and its words, as the last lines of a table cell.
  const citeParts = clause => (clause ? [
    { text: `CONTRACT${citeLabel(clause) ? ` · ${citeLabel(clause)}` : ''}`, size: 7, f: bold, color: TONES.indigo.ink },
    { text: `"${clause.quote}"`, size: 8, f: italic, color: INK },
  ] : []);

  // What the document says, what it should say, and the gap.
  const compareTable = (rows, shownLabel) => {
    const cS = 80; const cB = 80; const cO = 76; const cI = CONTENT_WIDTH - cS - cB - cO;
    row([
      { width: cI, parts: [{ text: 'ITEM', f: bold, color: GREY }] },
      { width: cS, parts: [{ text: shownLabel, f: bold, color: GREY, align: 'right' }] },
      { width: cB, parts: [{ text: 'SHOULD BE', f: bold, color: GREY, align: 'right' }] },
      { width: cO, parts: [{ text: 'OFF BY', f: bold, color: GREY, align: 'right' }] },
    ], { head: true });
    for (const r of rows) {
      row([
        { width: cI, parts: [{ text: r.item }, ...(r.working ? [{ text: r.working, size: 8, color: GREY }] : [])] },
        { width: cS, parts: [{ text: money(r.shown), align: 'right' }] },
        { width: cB, parts: [{ text: money(r.computed), align: 'right' }] },
        { width: cO, parts: [{ text: money(r.difference), f: bold, color: TONES.red.ink, align: 'right' }] },
      ]);
    }
    y -= 6;
  };

  // Something the agreement does not allow: what was charged, the amount, and the term it breaks.
  const deviationTable = (rows, whatLabel) => {
    const cA = 84; const cR = 210; const cW = CONTENT_WIDTH - cA - cR;
    row([
      { width: cW, parts: [{ text: whatLabel, f: bold, color: GREY }] },
      { width: cA, parts: [{ text: 'AT ISSUE', f: bold, color: GREY, align: 'right' }] },
      { width: cR, parts: [{ text: 'WHAT THE AGREEMENT SAYS', f: bold, color: GREY }] },
    ], { head: true });
    for (const r of rows) {
      row([
        { width: cW, parts: [{ text: r.item }] },
        { width: cA, parts: [{ text: typeof r.amount === 'number' ? money(r.amount) : '—', f: bold, color: TONES.red.ink, align: 'right' }] },
        { width: cR, parts: [
          { text: r.rule },
          ...(r.basis ? [{ text: r.basis, size: 8, f: italic, color: GREY }] : []),
          ...citeParts(r.clause),
        ] },
      ]);
    }
    y -= 6;
  };

  // An item and an amount, with an optional note under the item.
  const listTable = (rows, { emphasise = false } = {}) => {
    for (const r of rows) {
      row([
        { width: CONTENT_WIDTH - 110, parts: [
          { text: r.item, f: r.emphasis ? bold : font },
          ...(r.note ? [{ text: r.note, size: 8, color: GREY }] : []),
          ...citeParts(r.clause),
        ] },
        { width: 110, parts: [{ text: typeof r.amount === 'number' ? money(r.amount) : '—', align: 'right', f: bold, color: (emphasise || r.emphasis) ? TONES.red.ink : INK }] },
      ]);
    }
    y -= 6;
  };

  const notesSection = (notes) => {
    if (!notes?.length) return;
    heading("Coaster's notes", null);
    for (const n of notes) {
      text(n.title, { f: bold, size: 9, gapAfter: 1 });
      text(n.body, { size: 9, gapAfter: 5 });
    }
    text('Coaster reads documents, it does not verify them on site — treat these as prompts to check.', { size: 7.5, f: italic, color: GREY, gapAfter: 6 });
  };

  return {
    fonts: { font, bold, italic },
    text, row, heading, gap, titleBlock, verdictBanner, countTiles, passedLines,
    findingTitle, compareTable, deviationTable, listTable, notesSection, TONES, GREY, INK,
    // The document itself, for a report that adds pages of its own after the findings.
    doc: pdfDoc,
    save: async () => Buffer.from(await pdfDoc.save()),
  };
}

module.exports = { createReviewPdf, TONES };
