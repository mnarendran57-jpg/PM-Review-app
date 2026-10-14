const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapLine, toWinAnsi, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH } = require('./pdfGen');
const { money } = require('./money');

// The change order review as a document to hand to an owner: one line saying whether it can be
// approved, a count of each kind of problem, and each problem as a small table of its numbers.
// Built from the same report object the screen shows, so the two cannot disagree.
//
// Unbranded, like the other standard reports, and every string goes through toWinAnsi: the standard
// PDF fonts throw on characters they cannot encode, and a typographic dash in a line description
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

async function renderPcoReportPdf({ report }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const h = report.header || {};
  const name = `PCO ${h.pcoNumber}${h.title ? ` — ${h.title}` : ''}`;

  let page;
  let y;
  const newPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - 46;
    if (pdfDoc.getPageCount() > 1) {
      page.drawText('Change Order Review', { x: MARGIN, y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      const label = toWinAnsi(name).slice(0, 90);
      page.drawText(label, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(label, 8), y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      y = PAGE_HEIGHT - 54;
    }
  };
  newPage();
  const ensure = needed => { if (y - needed < MARGIN) newPage(); };

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

  const heading = (title, count, tone) => {
    // Enough room for the heading and the first lines under it, so a heading is never left alone at
    // the foot of a page with its content on the next.
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

  // --- Title block
  text('Change Order Review', { f: bold, size: 9, color: GREY, gapAfter: 7 });
  text(name, { f: bold, size: 16, gapAfter: 4 });
  const facts = [
    `${money(h.totalAmount)} requested`,
    h.contractor && `by ${h.contractor}`,
    h.date,
    h.isAllowance && 'presented as an allowance',
  ].filter(Boolean).join('   ·   ');
  text(facts, { size: 9.5, color: GREY, gapAfter: 2 });
  text(`Checked against ${(h.checkedAgainst || []).join(', ')}.`, { size: 8.5, color: GREY, gapAfter: 10 });

  // --- Verdict banner
  const v = report.verdict;
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

  // --- Counts
  const tiles = report.tiles || [];
  const gap = 8;
  const tw = (CONTENT_WIDTH - gap * (tiles.length - 1)) / tiles.length;
  ensure(52);
  tiles.forEach((t, i) => {
    const x = MARGIN + i * (tw + gap);
    const checked = t.count != null;
    const tt = !checked ? TONES.grey : t.key === 'savings' ? (t.count ? TONES.indigo : TONES.grey) : t.count ? TONES.red : TONES.green;
    page.drawRectangle({ x, y: y - 36, width: tw, height: 44, color: tt.fill });
    page.drawText(checked ? String(t.count) : '—', { x: x + 10, y: y - 12, size: 17, font: bold, color: tt.ink });
    page.drawText(toWinAnsi(t.label), { x: x + 10, y: y - 28, size: 8, font, color: GREY });
    if (!checked) {
      const nc = 'not checked';
      page.drawText(nc, { x: x + tw - 10 - italic.widthOfTextAtSize(nc, 7), y: y - 12, size: 7, font: italic, color: GREY });
    }
  });
  y -= 50;
  // What passed, as one quiet line under the counts rather than a section of its own at the end.
  if (report.passed.length) text(`Checked and fine: ${report.passed.join(', ')}.`, { size: 8, color: GREY, gapAfter: 1 });
  if (report.notChecked.length) text(`Could not be checked: ${report.notChecked.map(n => n.description).join(', ')}.`, { size: 8, color: GREY, gapAfter: 1 });
  y -= 4;

  // --- Math errors
  const COL_SHOWN = 80; const COL_SHOULD = 80; const COL_OFF = 76;
  const COL_ITEM = CONTENT_WIDTH - COL_SHOWN - COL_SHOULD - COL_OFF;
  heading('Math errors', report.math.issues.length, report.math.issues.length ? 'red' : 'green');
  if (report.math.issues.length === 0) text('The arithmetic on the change order checks out.', { size: 9, color: GREY, gapAfter: 6 });
  for (const f of report.math.issues) {
    text(`${f.title}${f.critical ? '  —  resolve before approving' : ''}`, { f: bold, size: 9.5, color: f.critical ? TONES.red.ink : INK, gapAfter: 2 });
    row([
      { width: COL_ITEM, parts: [{ text: 'ITEM', f: bold, color: GREY }] },
      { width: COL_SHOWN, parts: [{ text: 'ON THE PCO', f: bold, color: GREY, align: 'right' }] },
      { width: COL_SHOULD, parts: [{ text: 'SHOULD BE', f: bold, color: GREY, align: 'right' }] },
      { width: COL_OFF, parts: [{ text: 'OFF BY', f: bold, color: GREY, align: 'right' }] },
    ], { head: true });
    for (const r of f.figures?.rows || []) {
      row([
        { width: COL_ITEM, parts: [{ text: r.item }, ...(r.working ? [{ text: r.working, size: 8, color: GREY }] : [])] },
        { width: COL_SHOWN, parts: [{ text: money(r.shown), align: 'right' }] },
        { width: COL_SHOULD, parts: [{ text: money(r.computed), align: 'right' }] },
        { width: COL_OFF, parts: [{ text: money(r.difference), f: bold, color: TONES.red.ink, align: 'right' }] },
      ]);
    }
    y -= 6;
  }

  // --- Contract deviations
  if (report.contract) {
    const c = report.contract;
    heading(`Contract deviations${c.label ? ` — ${c.label}` : ''}`, c.count ?? c.issues.length, c.issues.length ? 'red' : 'green');
    if (c.issues.length === 0) text('Nothing on the change order goes against the contract terms that were checked.', { size: 9, color: GREY, gapAfter: 6 });
    const COL_AMT = 84; const COL_RULE = 210; const COL_WHAT = CONTENT_WIDTH - COL_AMT - COL_RULE;
    for (const f of c.issues) {
      text(`${f.title}${f.critical ? '  —  resolve before approving' : ''}`, { f: bold, size: 9.5, color: f.critical ? TONES.red.ink : INK, gapAfter: 2 });
      if (f.byCoaster) text("Coaster's reading of the contract — verify before acting.", { size: 8, f: italic, color: GREY, gapAfter: 2 });
      row([
        { width: COL_WHAT, parts: [{ text: 'ON THE PCO', f: bold, color: GREY }] },
        { width: COL_AMT, parts: [{ text: 'AT ISSUE', f: bold, color: GREY, align: 'right' }] },
        { width: COL_RULE, parts: [{ text: 'WHAT THE CONTRACT SAYS', f: bold, color: GREY }] },
      ], { head: true });
      for (const r of f.figures?.rows || []) {
        row([
          { width: COL_WHAT, parts: [{ text: r.item }] },
          { width: COL_AMT, parts: [{ text: typeof r.amount === 'number' ? money(r.amount) : '—', f: bold, color: TONES.red.ink, align: 'right' }] },
          { width: COL_RULE, parts: [{ text: r.rule }, ...(r.basis ? [{ text: r.basis, size: 8, f: italic, color: GREY }] : [])] },
        ]);
      }
      y -= 6;
    }
  }

  // --- Against the RFI/ASI
  if (report.scope) {
    const s = report.scope;
    const count = s.compared ? (s.aligned ? 0 : Math.max(1, s.extraItems.length)) : null;
    heading('Against the RFI/ASI', count, count ? 'amber' : 'green');
    if (s.reference?.label) text(s.reference.label, { size: 9, color: GREY, gapAfter: 2 });
    if (!s.compared) text('Could not be compared — the documents were too long to read side by side.', { size: 9, f: italic, color: GREY, gapAfter: 6 });
    else if (s.aligned) text('The change order prices the work the RFI/ASI asked for.', { size: 9, gapAfter: 6 });
    else {
      text(s.note || 'The change order prices work the RFI/ASI does not call for.', { size: 9, gapAfter: 3 });
      for (const item of s.extraItems) text(`•  ${item}`, { size: 9, x: MARGIN + 8, width: CONTENT_WIDTH - 8, gapAfter: 1 });
      y -= 5;
    }
  }

  // --- Ask for a breakdown
  if (report.askFor.length) {
    heading('Ask for a breakdown', report.askFor.length, 'amber');
    text('Single figures with no quantities or unit prices behind them.', { size: 8.5, color: GREY, gapAfter: 2 });
    for (const r of report.askFor) {
      row([
        { width: CONTENT_WIDTH - 100, parts: [{ text: r.item }] },
        { width: 100, parts: [{ text: money(r.amount), align: 'right', f: bold }] },
      ]);
    }
    y -= 6;
  }

  // --- Savings ideas
  const alt = report.alternatives;
  if (alt?.lines?.length) {
    heading('Savings ideas', alt.optionCount, alt.optionCount ? 'indigo' : 'grey');
    text("Coaster's suggestions for the materials and equipment priced. Rough ranges against each line, not quotes — confirm with the design team.", { size: 8.5, color: GREY, gapAfter: 2 });
    const COL_I = 150; const COL_D = 100; const COL_A = CONTENT_WIDTH - COL_I - COL_D;
    row([
      { width: COL_I, parts: [{ text: 'ITEM', f: bold, color: GREY }] },
      { width: COL_A, parts: [{ text: 'ALTERNATIVE', f: bold, color: GREY }] },
      { width: COL_D, parts: [{ text: 'COST DIFFERENCE', f: bold, color: GREY, align: 'right' }] },
    ], { head: true });
    for (const line of alt.lines) {
      const itemCell = first => ({
        width: COL_I,
        parts: first ? [{ text: line.description, f: bold, size: 8.5 }, ...(typeof line.amount === 'number' ? [{ text: money(line.amount), size: 8, color: GREY }] : [])] : [],
      });
      if (line.options.length === 0) {
        row([itemCell(true), { width: COL_A, parts: [{ text: line.noOptionsReason || 'No alternative suggested.', f: italic, size: 8.5, color: GREY }] }, { width: COL_D, parts: [{ text: '—', align: 'right', color: GREY }] }]);
        continue;
      }
      line.options.forEach((o, i) => {
        row([
          itemCell(i === 0),
          { width: COL_A, parts: [{ text: o.name, f: bold, size: 8.5 }, { text: o.whatItIs, size: 8 }, ...(o.note ? [{ text: o.note, size: 7.5, f: italic, color: TONES.amber.ink }] : [])] },
          { width: COL_D, parts: [{ text: o.costDifference, f: bold, size: 8.5, color: o.isSaving ? TONES.green.ink : INK, align: 'right' }] },
        ]);
      });
    }
    y -= 6;
  }

  // --- Coaster's notes
  if (report.notes.length) {
    heading("Coaster's notes", null);
    for (const n of report.notes) {
      text(n.title, { f: bold, size: 9, gapAfter: 1 });
      text(n.body, { size: 9, gapAfter: 5 });
    }
    text('Coaster reads documents, it does not verify them on site — treat these as prompts to check.', { size: 7.5, f: italic, color: GREY, gapAfter: 6 });
  }

  // --- What checked out, one line each and small: there for the reader who asks what was looked at.
  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderPcoReportPdf };
