const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapLine, toWinAnsi, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH } = require('./pdfGen');
const { money } = require('./money');
const { PASS, FAIL, NOTE, UNKNOWN } = require('./cmarChecks');

// The audit as a document somebody can put in front of an owner.
//
// Unbranded, like the pre-construction and VE reports: this is a standard output every organization
// gets identically, and a letterhead pulled from the database is how one customer's address ends up
// on another customer's report.
//
// Colour carries the verdict — green for a check that passed, red for one that did not — because
// the first thing a reader does with this is scan section three for red. Everything still reads
// correctly in black and white, since the status is also spelled out in words.
//
// Every string goes through toWinAnsi. The standard PDF fonts throw on characters they cannot
// encode, and this document is full of prose the model wrote; one typographic dash in a finding
// would otherwise take down the whole download.

const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.82, 0.82, 0.82);
const HEAD_BG = rgb(0.96, 0.96, 0.97);
const GREEN = rgb(0.05, 0.43, 0.23);
const RED = rgb(0.68, 0.11, 0.11);
const AMBER = rgb(0.64, 0.34, 0.04);
const PAD = 7;

const COLOUR = { [PASS]: GREEN, [FAIL]: RED, [NOTE]: AMBER, [UNKNOWN]: GREY };
const WORD = { [PASS]: 'OK', [FAIL]: 'ISSUE', [NOTE]: 'MINOR', [UNKNOWN]: 'NOT CHECKED' };

async function renderCmarReportPdf({ report }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const h = report.header || {};
  const title = h.projectName || 'Pay Application Audit';

  let page;
  let y;

  const runningHead = () => {
    if (pdfDoc.getPageCount() > 1) {
      page.drawText('Pay Application Audit', { x: MARGIN, y: PAGE_HEIGHT - 34, size: 8, font, color: GREY });
      const name = toWinAnsi(title);
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

  const text = (str, { f = font, size = 9.5, color = INK, x = MARGIN, width = CONTENT_WIDTH, gapAfter = 4, indent = 0 } = {}) => {
    for (const line of wrapLine(toWinAnsi(String(str || '')), f, size, width - indent)) {
      ensure(size + 3);
      page.drawText(line, { x: x + indent, y, size, font: f, color });
      y -= size + 3;
    }
    y -= gapAfter;
  };

  const rule = (gap = 10) => {
    ensure(8);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: RULE });
    y -= gap;
  };

  // A section heading always sits with at least some of its content, never alone at a page foot.
  const heading = label => {
    ensure(46);
    y -= 4;
    text(label, { f: bold, size: 13, gapAfter: 6 });
  };

  const row = (cells, { headRow = false, tint = null } = {}) => {
    const size = headRow ? 8.5 : 9;
    const laid = cells.map(cell => {
      const parts = (cell.parts || []).map(p => ({
        ...p,
        lines: wrapLine(toWinAnsi(String(p.text ?? '')), p.f || font, p.size || size, cell.width - PAD * 2),
      }));
      const height = parts.reduce((n, p) => n + p.lines.length * ((p.size || size) + 2.5), 0);
      return { ...cell, parts, height };
    });
    const height = Math.max(...laid.map(c => c.height), size) + PAD * 2;

    ensure(height);
    if (headRow || tint) {
      page.drawRectangle({
        x: MARGIN, y: y - height + PAD, width: CONTENT_WIDTH, height, color: tint || HEAD_BG,
      });
    }

    let x = MARGIN;
    for (const cell of laid) {
      let cy = y;
      for (const part of cell.parts) {
        for (const line of part.lines) {
          const s = part.size || size;
          const lx = part.align === 'right'
            ? x + cell.width - PAD - (part.f || font).widthOfTextAtSize(line, s)
            : x + PAD;
          page.drawText(line, { x: lx, y: cy, size: s, font: part.f || font, color: part.color || INK });
          cy -= s + 2.5;
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

  // --- Title block ---------------------------------------------------------------------------

  text('Pay Application Audit', { f: bold, size: 18, gapAfter: 4 });
  if (h.projectName) text(h.projectName, { size: 11, gapAfter: 4 });

  const facts = [];
  if (h.contractorName) facts.push(`Contractor: ${h.contractorName}`);
  if (h.applicationNumber) facts.push(`Application No. ${h.applicationNumber}`);
  if (h.periodTo) facts.push(`Period to ${h.periodTo}`);
  if (facts.length) text(facts.join('   |   '), { size: 9, color: GREY, gapAfter: 3 });

  text(report.summary.mathOnly
    ? 'Checked for arithmetic only. No contract was provided, so nothing here has been checked '
      + 'against contracted rates, tax exemption, or change-order limits.'
    : `Checked against ${h.contractName || 'the contract on file'}.`,
  { f: italic, size: 8.5, color: report.summary.mathOnly ? AMBER : GREY, gapAfter: 8 });
  rule();

  // --- 1. Summary ----------------------------------------------------------------------------

  heading('Summary');

  // The verdict as a banner, because it is the one thing a reader must not be able to miss.
  const verdict = report.summary.certifiable
    ? 'No arithmetic or contract issues were found.'
    : `${report.summary.issueCount} issue${report.summary.issueCount === 1 ? '' : 's'} found — `
      + 'see "Any Issues That Were Found" below.';
  row([{
    width: CONTENT_WIDTH,
    parts: [
      { text: verdict, f: bold, size: 10, color: report.summary.certifiable ? GREEN : RED },
      ...(report.summary.paymentDue != null
        ? [{ text: `Current payment due: ${money(report.summary.paymentDue)}`, size: 9.5 }]
        : []),
    ],
  }], { tint: rgb(0.975, 0.975, 0.98) });
  y -= 4;

  if (report.summary.text) text(report.summary.text, { gapAfter: 8 });

  // --- 2. The Numbers ------------------------------------------------------------------------

  heading('The Numbers');

  const NUM_LINE = 28;
  const NUM_AMOUNT = 110;
  const NUM_LABEL = CONTENT_WIDTH - NUM_LINE - NUM_AMOUNT;

  row([
    { width: NUM_LINE, parts: [{ text: '', f: bold }] },
    { width: NUM_LABEL, parts: [{ text: 'Application for Payment', f: bold }] },
    { width: NUM_AMOUNT, parts: [{ text: 'Amount', f: bold, align: 'right' }] },
  ], { headRow: true });

  for (const line of report.numbers.lines) {
    const strong = line.line === 8;
    row([
      { width: NUM_LINE, parts: [{ text: String(line.line), color: GREY, size: 8.5 }] },
      { width: NUM_LABEL, parts: [{ text: line.label, f: strong ? bold : font }] },
      {
        width: NUM_AMOUNT,
        parts: [{ text: money(line.amount), f: strong ? bold : font, align: 'right' }],
      },
    ], strong ? { tint: rgb(0.965, 0.97, 0.99) } : {});
  }
  y -= 6;

  if (report.numbers.categories.length) {
    text('This application, by category', { f: bold, size: 10.5, gapAfter: 5 });
    const CAT_AMOUNT = 110;
    const CAT_ITEMS = 60;
    const CAT_NAME = CONTENT_WIDTH - CAT_AMOUNT - CAT_ITEMS;
    row([
      { width: CAT_NAME, parts: [{ text: 'Category', f: bold }] },
      { width: CAT_ITEMS, parts: [{ text: 'Items', f: bold, align: 'right' }] },
      { width: CAT_AMOUNT, parts: [{ text: 'This period', f: bold, align: 'right' }] },
    ], { headRow: true });
    for (const c of report.numbers.categories) {
      row([
        { width: CAT_NAME, parts: [{ text: c.category }] },
        { width: CAT_ITEMS, parts: [{ text: String(c.items), align: 'right' }] },
        { width: CAT_AMOUNT, parts: [{ text: money(c.thisPeriod), align: 'right' }] },
      ]);
    }
    row([
      { width: CAT_NAME, parts: [{ text: 'Total', f: bold }] },
      { width: CAT_ITEMS, parts: [{ text: '' }] },
      { width: CAT_AMOUNT, parts: [{ text: money(report.numbers.thisPeriodTotal), f: bold, align: 'right' }] },
    ], { tint: rgb(0.965, 0.97, 0.99) });
    y -= 6;
  }

  // --- 3. Any Issues That Were Found -----------------------------------------------------------

  heading('Any Issues That Were Found');

  for (const q of report.headline) {
    ensure(40);
    const colour = COLOUR[q.status] || GREY;
    text(`${WORD[q.status]} — ${q.question}`, { f: bold, size: 9.5, color: colour, gapAfter: 2 });
    text(q.detail, { size: 9, indent: 12, gapAfter: 7 });
  }

  const shown = new Set(report.headline.map(q => q.detail));
  const otherIssues = report.issues.filter(f => !shown.has(f.detail));
  if (otherIssues.length) {
    text('Also found', { f: bold, size: 10.5, gapAfter: 5 });
    for (const f of otherIssues) {
      ensure(34);
      text(`ISSUE — ${f.subject ? `${f.subject}: ` : ''}${f.title}`, { f: bold, size: 9.5, color: RED, gapAfter: 2 });
      text(f.detail, { size: 9, indent: 12, gapAfter: 7 });
    }
  }

  // --- 4. Missed or Worth Noting ---------------------------------------------------------------

  const wn = report.worthNoting;
  const hasNotes = wn.findings.length || wn.unchecked.length || wn.untraceable.length
    || wn.observations.length || wn.unreadablePages.length;

  if (hasNotes) {
    heading('Missed or Worth Noting');

    for (const u of wn.untraceable) {
      text(`No backup found — ${u.item}${u.amount ? ` (${money(u.amount)})` : ''}`,
        { f: bold, size: 9.5, color: AMBER, gapAfter: 2 });
      if (u.note) text(u.note, { size: 9, indent: 12, gapAfter: 6 });
    }
    for (const f of wn.findings) {
      text(`${f.subject ? `${f.subject} — ` : ''}${f.title}`, { f: bold, size: 9.5, color: AMBER, gapAfter: 2 });
      text(f.detail, { size: 9, indent: 12, gapAfter: 6 });
    }
    for (const o of wn.observations) text(`- ${o}`, { size: 9, gapAfter: 4 });
    for (const f of wn.unchecked) {
      text(`Not checked — ${f.title}`, { f: bold, size: 9.5, color: GREY, gapAfter: 2 });
      text(f.detail, { size: 9, indent: 12, gapAfter: 6 });
    }
    if (wn.unreadablePages.length) {
      text(`Pages that could not be read confidently: ${wn.unreadablePages.join(', ')}.`,
        { size: 9, color: AMBER, gapAfter: 6 });
    }
  }

  // --- 5. Subcontractor Billing vs Cost Breakdown ------------------------------------------------

  if (report.subcontractors.length) {
    heading('Subcontractor Billing vs Cost Breakdown');

    for (const s of report.subcontractors) {
      ensure(110);
      text(`${s.firmName}${s.scopeDescription ? ` — ${s.scopeDescription}` : ''}`,
        { f: bold, size: 10.5, gapAfter: 5 });

      const SUB_AMOUNT = 110;
      const SUB_LABEL = CONTENT_WIDTH - SUB_AMOUNT;
      const line = (label, amount, strong = false) => row([
        { width: SUB_LABEL, parts: [{ text: label, f: strong ? bold : font }] },
        { width: SUB_AMOUNT, parts: [{ text: money(amount), f: strong ? bold : font, align: 'right' }] },
      ]);
      line('Contract to date', s.contractToDate);
      line('Completed to date', s.completedToDate);
      line('Billed this period (gross)', s.subGrossThisPeriod);
      line('Matched schedule-of-values items', s.sovThisPeriod);
      if (s.variance != null && s.variance !== 0) line('Variance', s.variance, true);
      y -= 3;

      const verdict = s.ties === null
        ? { text: 'Could not be compared on the same basis.', colour: GREY }
        : (s.ties
          ? { text: 'Ties to the schedule of values.', colour: GREEN }
          : { text: 'Does not tie to the schedule of values.', colour: RED });
      text(verdict.text, { f: bold, size: 9.5, color: verdict.colour, gapAfter: 2 });
      if (s.basisNote) text(s.basisNote, { size: 9, indent: 12, gapAfter: 3 });
      if (s.explanation) text(s.explanation, { size: 9, indent: 12, gapAfter: 4 });
      if ((s.sovItems || []).length) {
        text(`Matched against: ${s.sovItems.join('; ')}.`, { size: 8.5, color: GREY, indent: 12, gapAfter: 4 });
      }
      if (s.newChangeOrders) {
        text(`Change orders newly approved this period: ${money(s.newChangeOrders)}.`,
          { size: 9, indent: 12, gapAfter: 4 });
      }
      for (const c of (s.checks || []).filter(c => c.status === FAIL)) {
        text(`ISSUE — ${c.title}`, { f: bold, size: 9, color: RED, indent: 12, gapAfter: 2 });
        text(c.detail, { size: 9, indent: 24, gapAfter: 4 });
      }
      y -= 6;
    }
  }

  // --- 6. Tax ------------------------------------------------------------------------------------

  if (report.tax) {
    heading('Items Where Tax Was Charged Unwantedly');

    if (report.tax.finding) {
      text(report.tax.finding.detail, {
        size: 9.5,
        color: report.tax.finding.status === FAIL ? RED : INK,
        f: report.tax.finding.status === FAIL ? bold : font,
        gapAfter: 8,
      });
    }

    const TAX_AMOUNT = 80;
    const TAX_TOTAL = 80;
    const TAX_INV = 90;
    const TAX_VENDOR = CONTENT_WIDTH - TAX_AMOUNT - TAX_TOTAL - TAX_INV;

    row([
      { width: TAX_VENDOR, parts: [{ text: 'Vendor', f: bold }] },
      { width: TAX_INV, parts: [{ text: 'Invoice', f: bold }] },
      { width: TAX_TOTAL, parts: [{ text: 'Total', f: bold, align: 'right' }] },
      { width: TAX_AMOUNT, parts: [{ text: 'Tax', f: bold, align: 'right' }] },
    ], { headRow: true });

    for (const i of report.tax.charged) {
      row([
        { width: TAX_VENDOR, parts: [{ text: i.vendor }, ...(i.description ? [{ text: i.description, size: 8, color: GREY }] : [])] },
        { width: TAX_INV, parts: [{ text: i.invoiceNumber || '-' }, ...(i.invoiceDate ? [{ text: i.invoiceDate, size: 8, color: GREY }] : [])] },
        { width: TAX_TOTAL, parts: [{ text: money(i.total), align: 'right' }] },
        { width: TAX_AMOUNT, parts: [{ text: money(i.taxAmount), f: bold, color: RED, align: 'right' }] },
      ]);
    }
    row([
      { width: TAX_VENDOR, parts: [{ text: 'Total not payable by the owner', f: bold }] },
      { width: TAX_INV, parts: [{ text: '' }] },
      { width: TAX_TOTAL, parts: [{ text: '' }] },
      { width: TAX_AMOUNT, parts: [{ text: money(report.tax.total), f: bold, color: RED, align: 'right' }] },
    ], { tint: rgb(0.99, 0.96, 0.96) });
    y -= 8;

    if (report.tax.exempt.length) {
      text('For contrast, the exemption was correctly applied on these:', { size: 9, color: GREY, gapAfter: 5 });
      row([
        { width: TAX_VENDOR, parts: [{ text: 'Vendor', f: bold }] },
        { width: TAX_INV, parts: [{ text: 'Invoice', f: bold }] },
        { width: TAX_TOTAL, parts: [{ text: 'Total', f: bold, align: 'right' }] },
        { width: TAX_AMOUNT, parts: [{ text: 'Tax', f: bold, align: 'right' }] },
      ], { headRow: true });
      for (const i of report.tax.exempt) {
        row([
          { width: TAX_VENDOR, parts: [{ text: i.vendor }] },
          { width: TAX_INV, parts: [{ text: i.invoiceNumber || '-' }] },
          { width: TAX_TOTAL, parts: [{ text: money(i.total), align: 'right' }] },
          { width: TAX_AMOUNT, parts: [{ text: money(i.taxAmount ?? 0), color: GREEN, align: 'right' }] },
        ]);
      }
      y -= 6;
    }
  }

  // --- Invoices worth a second look ---------------------------------------------------------------

  if (report.invoiceConcerns.length) {
    heading('Invoices Worth a Second Look');
    for (const c of report.invoiceConcerns) {
      ensure(34);
      text(`${c.vendor}${c.invoiceNumber ? ` #${c.invoiceNumber}` : ''}`
        + `${c.amount ? ` — ${money(c.amount)}` : ''} (${c.confidence || 'possible'})`,
      { f: bold, size: 9.5, color: AMBER, gapAfter: 2 });
      text(c.concern, { size: 9, indent: 12, gapAfter: 6 });
    }
  }

  // --- 7. The checklist ----------------------------------------------------------------------------

  if (report.actions.length) {
    heading('Items to Verify Before Approving');

    report.actions.forEach((a, i) => {
      ensure(36);
      text(`${i + 1}. ${a.action}${a.amount ? ` — ${money(a.amount)}` : ''}`,
        { f: a.blocking ? bold : font, size: 9.5, color: a.blocking ? RED : INK, gapAfter: 2 });
      const tail = [a.why, a.blocking ? 'Do not certify until this is resolved.' : null]
        .filter(Boolean).join('  ');
      if (tail) text(tail, { f: italic, size: 8.5, color: GREY, indent: 14, gapAfter: 6 });
    });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderCmarReportPdf };
