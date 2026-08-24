const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapLine, toWinAnsi, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH } = require('./pdfGen');
const { money } = require('./money');
const { costBand, isSaving } = require('./veReport');

// The owner's copy: a table of items, their alternatives, and what each would do to the cost.
//
// Unbranded on purpose, for the same reason the pre-construction report is — this is a standard
// output every organization gets identically, and a letterhead picked from the database is how one
// customer's address ends up on another customer's report.
//
// Every string goes through toWinAnsi first. The standard PDF fonts throw on characters they
// cannot encode, and this document is full of prose the model wrote — one typographic dash in an
// option name would otherwise take down the whole download.

const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.4, 0.4, 0.4);
const RULE = rgb(0.82, 0.82, 0.82);
const HEAD_BG = rgb(0.96, 0.96, 0.97);
const GREEN = rgb(0.05, 0.43, 0.23);
const AMBER = rgb(0.64, 0.34, 0.04);

// Three columns: the item, the alternative, and the number. The number column is sized to the
// longest thing that can land in it ("18% more to 24% less") and the rest is split so the
// alternative — which carries a sentence — gets the room.
const COL_ITEM = 150;
const COL_COST = 105;
const COL_ALT = CONTENT_WIDTH - COL_ITEM - COL_COST;
const PAD = 7;

async function renderVeReportPdf({ report }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const header = report.header || {};
  const projectName = header.projectName || header.estimateTitle || '';

  let page;
  let y;

  const runningHead = () => {
    if (pdfDoc.getPageCount() > 1 && projectName) {
      const name = toWinAnsi(projectName);
      page.drawText('Options to Consider', { x: MARGIN, y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      page.drawText(name, {
        x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(name, 8),
        y: PAGE_HEIGHT - 34, size: 8, font, color: GREY,
      });
      return PAGE_HEIGHT - 52;
    }
    return PAGE_HEIGHT - 46;
  };

  const newPage = () => { page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = runningHead(); };
  newPage();

  const ensure = needed => { if (y - needed < MARGIN) { newPage(); return true; } return false; };

  const text = (str, { f = font, size = 9.5, color = INK, x = MARGIN, width = CONTENT_WIDTH, gapAfter = 4 } = {}) => {
    for (const line of wrapLine(toWinAnsi(String(str || '')), f, size, width)) {
      ensure(size + 3);
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + 3;
    }
    y -= gapAfter;
  };

  const rule = () => {
    ensure(8);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: RULE });
    y -= 10;
  };

  // Draws one table row as columns, and returns the height it used. Cells are measured first so the
  // row can be kept whole across a page break — a row split down the middle is unreadable.
  const row = (cells, { headRow = false } = {}) => {
    const size = headRow ? 8.5 : 9;
    const laid = cells.map((cell) => {
      const parts = (cell.parts || []).map(p => ({
        ...p,
        lines: wrapLine(toWinAnsi(String(p.text || '')), p.f || font, p.size || size, cell.width - PAD * 2),
      }));
      const height = parts.reduce((n, p) => n + p.lines.length * ((p.size || size) + 2.5), 0);
      return { ...cell, parts, height };
    });
    const height = Math.max(...laid.map(c => c.height)) + PAD * 2;

    ensure(height);
    if (headRow) {
      page.drawRectangle({ x: MARGIN, y: y - height + PAD, width: CONTENT_WIDTH, height, color: HEAD_BG });
    }

    let x = MARGIN;
    for (const cell of laid) {
      let cy = y;
      for (const part of cell.parts) {
        for (const line of part.lines) {
          const size2 = part.size || size;
          const lx = part.align === 'right'
            ? x + cell.width - PAD - (part.f || font).widthOfTextAtSize(line, size2)
            : x + PAD;
          page.drawText(line, { x: lx, y: cy, size: size2, font: part.f || font, color: part.color || INK });
          cy -= size2 + 2.5;
        }
      }
      x += cell.width;
    }
    y -= height;
    page.drawLine({
      start: { x: MARGIN, y: y + PAD - 2 }, end: { x: PAGE_WIDTH - MARGIN, y: y + PAD - 2 },
      thickness: 0.4, color: RULE,
    });
    y -= 3;
  };

  // Title block
  text(`Options to Consider${projectName ? ` — ${projectName}` : ''}`, { f: bold, size: 16, gapAfter: 5 });
  const facts = [];
  if (header.contractor) facts.push(`Estimate from: ${header.contractor}`);
  if (header.estimateDate) facts.push(`Dated: ${header.estimateDate}`);
  if (typeof header.estimateTotal === 'number') facts.push(`Total: ${money(header.estimateTotal)}`);
  if (facts.length) text(facts.join('   |   '), { size: 9, color: GREY, gapAfter: 6 });
  text(report.disclaimer, { f: italic, size: 8.5, color: GREY, gapAfter: 8 });
  rule();

  // The contractor's own priced alternates, where there were any.
  const offered = report.alreadyOffered || [];
  if (offered.length) {
    text('Already offered by your contractor', { f: bold, size: 12, gapAfter: 5 });
    for (const item of offered) {
      row([
        { width: CONTENT_WIDTH - COL_COST, parts: [{ text: item.description, size: 9 }] },
        {
          width: COL_COST,
          parts: [{
            text: item.effect || '—', size: 9, align: 'right',
            f: bold, color: item.isSaving ? GREEN : INK,
          }],
        },
      ]);
    }
    y -= 8;
  }

  text('Options by item', { f: bold, size: 12, gapAfter: 5 });

  const entries = report.entries || [];
  if (entries.length === 0) {
    text('No priced items could be read from this document.', { f: italic, color: GREY });
    return Buffer.from(await pdfDoc.save());
  }

  row([
    { width: COL_ITEM, parts: [{ text: 'ITEM', f: bold, color: GREY }] },
    { width: COL_ALT, parts: [{ text: 'ALTERNATIVE', f: bold, color: GREY }] },
    { width: COL_COST, parts: [{ text: 'DIFFERENCE IN COST', f: bold, color: GREY, align: 'right' }] },
  ], { headRow: true });

  for (const entry of entries) {
    const itemCell = position => ({
      width: COL_ITEM,
      // Named once and blank on continuation rows, so an item with three alternatives reads as one
      // block rather than as three separate findings.
      parts: position > 0 ? [] : [
        { text: entry.description, f: bold, size: 9 },
        ...(typeof entry.amount === 'number'
          ? [{ text: money(entry.amount), size: 8.5, color: GREY }] : []),
      ],
    });

    if (entry.options.length === 0) {
      row([
        itemCell(0),
        {
          width: COL_ALT,
          // Blank where the PM dropped everything: saying "no alternative worth raising" there
          // would be claiming on their behalf that none existed.
          parts: entry.hadOptions ? [] : [
            { text: entry.noOptionsReason || 'No alternative worth raising.', f: italic, size: 9, color: GREY },
          ],
        },
        { width: COL_COST, parts: [{ text: '—', size: 9, color: GREY, align: 'right' }] },
      ]);
      continue;
    }

    entry.options.forEach((option, i) => {
      row([
        itemCell(i),
        {
          width: COL_ALT,
          parts: [
            { text: option.name, f: bold, size: 9 },
            { text: option.whatItIs, size: 8.5 },
            ...(option.note ? [{ text: option.note, f: italic, size: 8, color: AMBER }] : []),
          ],
        },
        {
          width: COL_COST,
          parts: [{
            text: costBand(option), size: 9, align: 'right',
            f: bold, color: isSaving(option) ? GREEN : INK,
          }],
        },
      ]);
    });
  }

  y -= 6;
  const c = report.counts;
  text(`${c.options} alternative${c.options === 1 ? '' : 's'} across ${c.itemsWithOptions} of the `
    + `${c.items} item${c.items === 1 ? '' : 's'} looked at.`, { size: 8.5, color: GREY });

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderVeReportPdf };
