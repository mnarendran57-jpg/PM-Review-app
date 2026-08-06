const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money } = require('./payAppChecks');
const {
  wrapLine, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, CONTENT_WIDTH,
} = require('./pdfGen');

const BODY_SIZE = 10;
const RED = rgb(0.65, 0.13, 0.13);
const GREY = rgb(0.35, 0.35, 0.35);
const INK = rgb(0.1, 0.1, 0.1);

// Renders the pay app review report as a client-facing PDF on the Coaster letterhead.
// Consumes the same object buildReport() already returns, so the PDF and the
// markdown export never drift apart. Deliberately omits check IDs and the
// pass/skip detail — those are internal, and this document goes to a client.
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
    page.drawText(companyName || 'Coaster', {
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
    const xFor = i => MARGIN + cols.slice(0, i).reduce((a, c) => a + c.width * CONTENT_WIDTH, 0);
    const drawRow = (cells, { bold = false, color = INK } = {}) => {
      const wrapped = cells.map((cell, i) => {
        const val = typeof cell === 'object' ? cell.text : cell;
        return wrapLine(String(val ?? ''), font, TABLE_SIZE, cols[i].width * CONTENT_WIDTH - 6);
      });
      const rowHeight = Math.max(...wrapped.map(w => w.length)) * (TABLE_SIZE + 2);
      ensureSpace(rowHeight + 4);
      const top = y;
      cells.forEach((cell, i) => {
        const cellBold = bold || (typeof cell === 'object' && cell.bold);
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

  text('Pay Application Review', { bold: true, size: 16, gapAfter: 6 });
  text(h.projectName, { size: 12, color: GREY, gapAfter: 10 });
  rule();

  // Facts the client needs to identify which application this is.
  text(`Application #: ${h.applicationNumber}     Period To: ${h.periodTo}`, { gapAfter: 10 });

  text('Summary', { bold: true, size: 12, gapAfter: 5 });
  // The audit's own summary wins where there is one. The generated sentence describes only
  // the arithmetic checks, so on an application that adds up but fails the audit it would
  // read "no issues found" directly above a list of failures.
  text(
    report.compliance?.audit && !report.compliance.audit.unavailable && report.compliance.audit.summary
      ? report.compliance.audit.summary
      : report.plainEnglish,
    { gapAfter: 12 }
  );

  text('The Numbers', { bold: true, size: 12, gapAfter: 5 });
  const rows = [
    ['Current payment requested', money(h.currentPaymentDue)],
    ['Total completed & stored to date', money(h.totalCompletedToDate)],
    ['Contract sum to date', money(h.contractSumToDate)],
    ['Balance remaining to finish', money(h.balanceToFinish)],
  ];
  if (h.billedPct != null) rows.push(['Percent of contract billed', `${h.billedPct.toFixed(1)}%`]);
  if (h.retainedPct != null) rows.push(['Percent retained', `${h.retainedPct.toFixed(1)}%`]);
  for (const [label, value] of rows) {
    ensureSpace(BODY_SIZE + 4);
    page.drawText(label, { x: MARGIN, y, size: BODY_SIZE, font, color: INK });
    const vw = fontBold.widthOfTextAtSize(value, BODY_SIZE);
    page.drawText(value, { x: PAGE_WIDTH - MARGIN - vw, y, size: BODY_SIZE, font: fontBold, color: INK });
    y -= BODY_SIZE + 5;
  }
  y -= 8;

  const audit = report.compliance?.audit && !report.compliance.audit.unavailable
    ? report.compliance.audit : null;

  // Where the audit's recomputation disagrees with the extracted figures, both are shown.
  // One is wrong, and the person releasing payment is the right one to decide which.
  if (audit?.recomputationDisagreements?.length) {
    text('Recomputation Disagreements', { bold: true, size: 12, gapAfter: 3 });
    text('The audit recalculated these from the documents and did not reach the same number. Resolve each before certifying.',
      { size: 9, italic: true, color: GREY, gapAfter: 5 });
    table(
      [
        { label: 'Figure', width: 0.40, align: 'left' },
        { label: 'On the form', width: 0.20, align: 'right' },
        { label: 'Recomputed', width: 0.20, align: 'right' },
        { label: 'Difference', width: 0.20, align: 'right' },
      ],
      report.compliance.audit.recomputationDisagreements.map(d => [
        d.field, money(d.stated), money(d.recomputed), { text: money(d.difference), bold: true },
      ])
    );
  }

  const issues = [...report.critical, ...report.mathErrors];
  text('Issues Found', { bold: true, size: 12, gapAfter: 5 });

  // The six questions the audit standard requires an explicit answer to, each marked plainly
  // rather than left for the reader to infer from the prose below.
  if (audit?.verdicts) {
    for (const v of Object.values(audit.verdicts)) {
      ensureSpace(BODY_SIZE * 3 + 10);
      const failed = v.pass === false;
      const mark = v.pass === true ? 'PASS' : failed ? 'FAIL' : 'UNKNOWN';
      const colour = v.pass === true ? rgb(0.08, 0.5, 0.24) : failed ? RED : GREY;
      page.drawText(mark, { x: MARGIN, y, size: 7.5, font: fontBold, color: colour });
      text(v.label, { bold: failed, indent: 46, gapAfter: 1, color: failed ? RED : INK });
      if (v.detail) text(v.detail, { indent: 46, size: 9, color: GREY, gapAfter: 6 });
    }
    y -= 4;
  }

  if (audit?.notarization) {
    const n = audit.notarization;
    const state = n.valid === true ? 'Notarization valid'
      : n.valid === false ? 'NOTARIZATION NOT VALID' : 'Notarization could not be confirmed';
    text(state, { bold: true, size: 10, color: n.valid === false ? RED : INK, gapAfter: 2 });
    if (n.detail) text(n.detail, { indent: 12, size: 9, color: GREY, gapAfter: 8 });
  }

  if (issues.length === 0) {
    text('None. Every figure checked was internally consistent and within contract limits.', { italic: true, gapAfter: 12 });
  } else {
    for (const r of issues) {
      text(`• ${r.description}`, { bold: true, gapAfter: 2 });
      text(r.detail, { indent: 12, gapAfter: 7 });
    }
    y -= 4;
  }

  if (report.worthNoting?.length) {
    text('Missed or Worth Noting', { bold: true, size: 12, gapAfter: 5 });
    for (const r of report.worthNoting) {
      text(`• ${r.description}`, { bold: true, gapAfter: 2 });
      text(r.detail, { indent: 12, gapAfter: 7 });
    }
    y -= 4;
  }

  // Chart 1 — subcontractor billing vs. their own breakdown.
  if (report.subReconciliation?.length) {
    text('Subcontractor Billing vs. Their Cost Breakdown', { bold: true, size: 12, gapAfter: 5 });
    table(
      [
        { label: 'Subcontractor', width: 0.38, align: 'left' },
        { label: 'Billed', width: 0.19, align: 'right' },
        { label: 'Breakdown', width: 0.19, align: 'right' },
        { label: 'Difference', width: 0.24, align: 'right' },
      ],
      report.subReconciliation.map(r => [
        `${r.subName}${r.comparedTo ? ` (${r.comparedTo})` : ''}`,
        r.g703Amount != null ? money(r.g703Amount) : '—',
        money(r.breakdownTotal),
        r.status === 'match' ? 'Matches'
          : r.status === 'mismatch' ? { text: money(r.difference), bold: true }
          : 'no billing line',
      ])
    );
  }

  // Read from the documents rather than calculated, so it is set apart from the math
  // above and worded as items to confirm.
  const c = report.compliance;
  if (c) {
    const findings = [
      ...(c.taxFindings || []).map(f => ({
        head: `Tax charged: ${f.description}`, amount: f.amount, where: f.where, detail: f.detail,
      })),
      ...(c.unallowableFindings || []).map(f => ({
        head: `Not allowed by contract: ${f.contractItem}`, amount: f.amount, where: f.where, detail: f.detail,
      })),
    ];
    text('Checked Against the Contract', { bold: true, size: 12, gapAfter: 3 });
    text('Read from the documents rather than calculated — confirm each before approving.', { size: 9, italic: true, color: GREY, gapAfter: 5 });

    // Chart 2 — billed lines vs. the agreed scope.
    if (c.scopeComparison?.length) {
      text(`Billed scope vs. ${c.scopeSource === 'contract' ? 'the contract' : 'the original schedule (App #1)'}`, { bold: true, size: 10, gapAfter: 3 });
      table(
        [
          { label: 'Item', width: 0.46, align: 'left' },
          { label: 'Scheduled', width: 0.20, align: 'right' },
          { label: 'Status', width: 0.34, align: 'left' },
        ],
        c.scopeComparison.map(r => [
          `${r.itemNo ? `#${r.itemNo} ` : ''}${r.description}`,
          r.scheduledValue != null ? money(r.scheduledValue) : '—',
          r.status === 'in_contract' ? 'In contract'
            : r.status === 'changed' ? 'Value changed'
            : r.status === 'covered_by_co' ? `Approved change${r.coNumber ? ` (${r.coNumber})` : ''}`
            : { text: 'NOT IN CONTRACT', bold: true },
        ])
      );
    }

    if (findings.length === 0) {
      text('Nothing on this application conflicts with the contract terms on file.', { italic: true, gapAfter: 12 });
    } else {
      for (const f of findings) {
        text(`• ${f.head}${f.amount != null ? ` — ${money(f.amount)}` : ''}`, { bold: true, gapAfter: 2 });
        if (f.where) text(f.where, { indent: 12, size: 9, color: GREY, gapAfter: 1 });
        text(f.detail, { indent: 12, gapAfter: 7 });
      }
      y -= 4;
    }
    if (c.backupCoverage) text(`Backup documentation: ${c.backupCoverage}`, { size: 9, color: GREY, gapAfter: 10 });
  }

  text('To Verify On Site Before Approving', { bold: true, size: 12, gapAfter: 5 });
  if (report.checklist.length === 0) {
    text('Nothing new was billed this period, so there is no new work to confirm on site.', { italic: true, gapAfter: 12 });
  } else {
    for (const item of report.checklist) {
      // Reserve the whole item so the drawn checkbox can't be orphaned from its text
      // by a page break landing between them.
      ensureSpace(BODY_SIZE * 3 + 16);
      page.drawRectangle({
        x: MARGIN, y: y - 1, width: 8.5, height: 8.5,
        borderWidth: 0.8, borderColor: INK,
      });
      text(`${item.description} — ${money(item.amount)}${item.isNew ? '  (new this period)' : ''}`, { bold: true, indent: 15, gapAfter: 2 });
      text(item.detail, { indent: 15, gapAfter: 7 });
    }
    y -= 4;
  }

  // The standard closes with one numbered checklist, so that everything raised above has a
  // single place where it becomes an action rather than being scattered through the report.
  if (audit) {
    const actions = [];
    for (const d of audit.recomputationDisagreements || []) {
      actions.push(`Resolve the ${d.field} disagreement — the form shows ${money(d.stated)}, recomputation gives ${money(d.recomputed)}.`);
    }
    if (audit.notarization?.valid === false) actions.push('Return the application for proper notarization.');
    for (const s of audit.subcontractors || []) {
      for (const issue of s.issues || []) actions.push(`${s.name}: ${issue}`);
    }
    if (audit.taxTotalCharged > 0) {
      actions.push(`Deduct ${money(audit.taxTotalCharged)} of sales tax before certifying.`);
    }
    for (const u of audit.untracedBilling || []) {
      actions.push(`Obtain backup for ${u.item}, or remove it from this application.`);
    }
    if (actions.length) {
      ensureSpace(60);
      text('Before Approving, or Needing Correction', { bold: true, size: 12, gapAfter: 5 });
      actions.forEach((a, i) => text(`${i + 1}. ${a}`, { indent: 8, gapAfter: 4 }));
      y -= 6;
    }
  }

  rule();
  const passed = report.cleanBill.length;
  const skipped = report.warnings.length;
  text(
    // Counts the arithmetic checks only, and says so — the audit's findings are listed above
    // and counting them here would imply one tally covers both.
    `Arithmetic checks: ${passed} passed, ${issues.length} flagged, ${skipped} not applicable.`
    + (audit ? ` Audit findings are listed above.` : ''),
    { size: 9, color: GREY, gapAfter: 4 }
  );
  text(
    'This review confirms that the figures on this application are internally consistent and within contract limits. ' +
    'It does not confirm that the billed work was physically completed — that requires the site verification above.',
    { size: 9, italic: true, color: GREY }
  );

  return Buffer.from(await pdfDoc.save());
}

module.exports = { renderPayAppReportPdf };
