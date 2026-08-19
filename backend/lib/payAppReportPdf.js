const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money } = require('./money');
const {
  wrapLine, toWinAnsi, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH,
} = require('./pdfGen');

const BODY_SIZE = 10;
const RED = rgb(0.65, 0.13, 0.13);
const AMBER = rgb(0.54, 0.35, 0.05);
const GREY = rgb(0.35, 0.35, 0.35);
const INK = rgb(0.1, 0.1, 0.1);

// The client-facing PDF of the review, on letterhead.
//
// Renders the same document object the on-screen report and the Markdown export are built from,
// so the three can never disagree. Deliberately omits rule IDs and the pass/skip detail — those
// are internal, and this copy goes to an owner.
//
// It follows the on-screen order for the same reason that order was chosen: what was applied
// for, the call, then findings grouped by what the reader would do about them, then the tables
// that let someone satisfy themselves nothing has been missed.
async function renderPayAppReportPdf({ report, companyName }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let page;
  let y;

  const drawLetterhead = () => {
    const label = 'Client Confidential';
    page.drawText(label, {
      x: (PAGE_WIDTH - fontItalic.widthOfTextAtSize(label, BODY_SIZE)) / 2,
      y: PAGE_HEIGHT - 28, size: BODY_SIZE, font: fontItalic, color: GREY,
    });
    // Wordmark, top-left, in place of a logo image.
    // Everything else on the page reaches drawText through wrapLine, which sanitizes. This does
    // not, and an organization's name is user-supplied.
    page.drawText(toWinAnsi(companyName || 'Coaster'), {
      x: MARGIN, y: PAGE_HEIGHT - 52, size: 18, font: fontBold, color: INK,
    });
    return PAGE_HEIGHT - 76;
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

  // Minimal table: cols = [{ label, width, align }], rows = [[cell, cell, ...]].
  // width is a fraction of CONTENT_WIDTH. A cell may be { text, bold } to emphasize.
  const TABLE_SIZE = 9;
  const table = (cols, rows) => {
    if (!rows.length) return;
    const xFor = i => MARGIN + cols.slice(0, i).reduce((a, c) => a + c.width * CONTENT_WIDTH, 0);
    const drawRow = (cells, { bold = false, color = INK } = {}) => {
      const wrapped = cells.map((cell, i) => {
        const val = typeof cell === 'object' && cell !== null ? cell.text : cell;
        return wrapLine(String(val ?? ''), font, TABLE_SIZE, cols[i].width * CONTENT_WIDTH - 6);
      });
      const rowHeight = Math.max(...wrapped.map(w => w.length)) * (TABLE_SIZE + 2);
      ensureSpace(rowHeight + 4);
      const top = y;
      cells.forEach((cell, i) => {
        const cellBold = bold || (typeof cell === 'object' && cell !== null && cell.bold);
        const f = cellBold ? fontBold : font;
        const col = cols[i];
        wrapped[i].forEach((ln, j) => {
          const w = f.widthOfTextAtSize(ln, TABLE_SIZE);
          const x = col.align === 'right' ? xFor(i) + col.width * CONTENT_WIDTH - w - 6 : xFor(i) + 2;
          page.drawText(ln, { x, y: top - j * (TABLE_SIZE + 2), size: TABLE_SIZE, font: f, color });
        });
      });
      y = top - rowHeight;
    };
    drawRow(cols.map(c => c.label), { bold: true, color: GREY });
    y -= 2;
    page.drawLine({ start: { x: MARGIN, y: y + 6 }, end: { x: PAGE_WIDTH - MARGIN, y: y + 6 }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
    y -= 2;
    for (const r of rows) drawRow(r);
    y -= 8;
  };

  const h = report.header;

  // ---- masthead -------------------------------------------------------------------------------
  text('Pay Application Review', { bold: true, size: 16, gapAfter: 6 });
  text(h.projectName, { size: 12, color: GREY, gapAfter: 4 });
  text([h.contractor, h.applicationNumber != null ? `Application ${h.applicationNumber}` : null,
    h.periodTo ? `Period to ${h.periodTo}` : null].filter(Boolean).join(' · '),
  { size: 10, color: GREY, gapAfter: 10 });
  rule();

  // ---- the four figures -------------------------------------------------------------------------
  table(
    [{ label: 'Applied for', width: 0.25 }, { label: 'This period', width: 0.25 },
      { label: 'Retainage', width: 0.25 }, { label: 'Complete', width: 0.25 }],
    [[
      { text: money(h.appliedFor), bold: true },
      money(h.thisPeriod),
      money(h.retainage),
      h.pctComplete == null ? '—' : `${(h.pctComplete * 100).toFixed(2)}%`,
    ]],
  );

  // ---- the call ---------------------------------------------------------------------------------
  const verdictColor = report.verdict === 'do-not-certify' ? RED
    : report.verdict === 'certify-with-corrections' ? AMBER : INK;
  text(report.verdictLabel.toUpperCase(), { bold: true, size: 11, color: verdictColor, gapAfter: 3 });
  text(report.headline, { gapAfter: 12 });

  // ---- findings, grouped by what to do about them -------------------------------------------------
  const findingSection = (title, items, color) => {
    if (!items.length) return;
    rule();
    text(`${title} — ${items.length} item${items.length === 1 ? '' : 's'}`,
      { bold: true, size: 11, color, gapAfter: 6 });
    for (const f of items) {
      ensureSpace(40);
      text(f.showAmount ? `${f.head}   ${money(f.amount)}` : f.head, { bold: true, gapAfter: 2 });
      if (f.rest) text(f.rest, { size: 9, color: GREY, indent: 10, gapAfter: 2 });
      if (f.where) text(f.where, { size: 8, color: GREY, indent: 10, gapAfter: 8 });
      else y -= 4;
    }
  };
  // Same order as the on-screen report and the markdown: what stops a cheque, then what to confirm,
  // then the tables, then observations. See payAppReportHtml.js for why.
  findingSection('What to resolve', report.resolve, RED);
  findingSection('To confirm', report.confirm, AMBER);

  // ---- subcontractor billing ----------------------------------------------------------------------
  if (report.subMatch?.rows?.length) {
    rule();
    text('Subcontractor billing', { bold: true, size: 11, gapAfter: 6 });
    table(
      [{ label: 'Subcontractor', width: 0.3 }, { label: 'They billed', width: 0.16, align: 'right' },
        { label: 'Passed through', width: 0.18, align: 'right' },
        { label: 'To owner', width: 0.16, align: 'right' },
        { label: 'Markup', width: 0.1, align: 'right' }, { label: 'Match', width: 0.1 }],
      report.subMatch.rows.map(r => [
        r.vendor,
        money(r.theyBilled),
        money(r.passedThrough),
        r.toOwner == null ? '—' : money(r.toOwner),
        Math.abs(r.markup) < 0.005 ? 'none' : money(r.markup),
        r.status,
      ]),
    );
  }

  // ---- subcontractor scope across the schedule -----------------------------------------------------
  // A different question from the table above: not "was anything added on the way through" but
  // "which lines is this subcontract being billed on, and do they add up to it". A subcontractor
  // whose scope sits on two lines is invisible everywhere else in the report.
  if (report.vendorRollup?.length) {
    rule();
    text('Subcontractor scope on the schedule', { bold: true, size: 11, gapAfter: 6 });
    table(
      [{ label: 'Subcontractor', width: 0.20 }, { label: 'Lines carrying their scope', width: 0.28 },
        { label: 'They billed', width: 0.13, align: 'right' },
        { label: 'Contractor billed', width: 0.13, align: 'right' },
        { label: 'Difference', width: 0.14, align: 'right' },
        { label: 'Columns', width: 0.12 }],
      report.vendorRollup.map(r => [
        r.vendor,
        r.lines.length ? r.lines.join('; ') : '—',
        r.theyBilled == null ? '—' : money(r.theyBilled),
        r.onSchedule == null ? '—' : money(r.onSchedule),
        r.difference == null ? '—'
          : `${money(r.difference)}${r.exceeds ? ' over' : r.short ? ' under' : ''}`,
        r.columnsCompared ? `${r.columnsMatched}/${r.columnsCompared} ${r.status}` : r.status,
      ]),
    );
  }

  // ---- sales tax --------------------------------------------------------------------------------
  if (report.tax?.length) {
    rule();
    text('Sales tax — who owes it', { bold: true, size: 11, gapAfter: 6 });
    table(
      [{ label: 'Vendor', width: 0.28 }, { label: 'What was bought', width: 0.34 },
        { label: 'Tax', width: 0.16, align: 'right' },
        { label: 'Under the contract', width: 0.22 }],
      report.tax.map(t => [
        [t.vendor, t.ref].filter(Boolean).join(' '),
        t.category,
        money(t.amount),
        t.verdict,
      ]),
    );
    if (typeof report.taxToDeduct === 'number' && report.taxToDeduct > 0) {
      text(`${money(report.taxToDeduct)} of the tax billed is the contractor's own cost under this `
        + 'contract and should come off this payment.', { size: 9, bold: true, gapAfter: 6 });
    }
  }

  // ---- contracts checked against -----------------------------------------------------------------
  if (report.contracts?.length) {
    rule();
    text('Contracts checked against', { bold: true, size: 11, gapAfter: 6 });
    table(
      [{ label: 'Party', width: 0.28 }, { label: 'Scope', width: 0.24 },
        { label: 'Value', width: 0.16, align: 'right' },
        { label: 'Retainage', width: 0.12, align: 'right' },
        { label: 'Matched to', width: 0.20 }],
      report.contracts.map(c => [
        c.party,
        c.scope || '—',
        c.value == null ? '—' : money(c.value),
        c.retainageRate == null ? '—' : `${(c.retainageRate * 100).toFixed(2)}%`,
        c.matchedTo || 'not matched',
      ]),
    );
  }

  findingSection('Noted, no action expected', report.noted, GREY);

  // ---- lien waivers ---------------------------------------------------------------------------------
  if (report.waivers?.length) {
    rule();
    text('Lien waivers', { bold: true, size: 11, gapAfter: 6 });
    table(
      [{ label: 'Party', width: 0.3 }, { label: 'Being paid', width: 0.18, align: 'right' },
        { label: 'Release on file', width: 0.32 }, { label: 'Status', width: 0.2 }],
      report.waivers.map(w => [
        w.party, money(w.amount), w.waivers.join(', ') || '—', w.status,
      ]),
    );
  }

  // ---- to verify on site -------------------------------------------------------------------------
  if (report.checklist?.length) {
    rule();
    text('To verify on site this period', { bold: true, size: 11, gapAfter: 6 });
    for (const item of report.checklist) {
      text(`•  ${item.description || item}`, { size: 9, gapAfter: 2 });
    }
    y -= 6;
  }

  // ---- coverage ----------------------------------------------------------------------------------
  // Always drawn, even with nothing to say. The count of what passed is what gives the findings
  // above their weight, and the list of what could not be checked is the honest limit of the
  // review — a report that omits it claims a coverage it does not have.
  rule();
  text('Checked and clean', { bold: true, size: 11, gapAfter: 4 });
  text(`${report.stats.passed} of ${report.stats.checksRun} checks passed. Every figure is `
    + 'recalculated from the submitted documents — nothing here is an estimate or an opinion.',
  { size: 9, color: GREY, gapAfter: report.notChecked.length ? 6 : 0 });
  if (report.notChecked.length) {
    text(`Not checked. ${report.notChecked.join(' ')}`, { size: 9, color: GREY });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderPayAppReportPdf };
