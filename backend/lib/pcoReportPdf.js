const { createReviewPdf } = require('./reviewPdfKit');
const { MARGIN, CONTENT_WIDTH } = require('./pdfGen');
const { money } = require('./money');
const { addMarkedPages } = require('./pcoMarkup');

// The change order review as a document to hand to an owner: one line saying whether it can be
// approved, a count of each kind of problem, and each problem as a small table of its numbers.
// Built from the same report object the screen shows, so the two cannot disagree. The drawing is
// shared with the invoice report — see lib/reviewPdfKit.js.

// `original` is the change order as uploaded and `pco` what was read from it. Given both, the
// change order's own pages follow the report, marked up — see lib/pcoMarkup.js.
async function renderPcoReportPdf({ report, original = null, pco = null }) {
  const h = report.header || {};
  const name = `PCO ${h.pcoNumber}${h.title ? ` — ${h.title}` : ''}`;
  const pdf = await createReviewPdf({ kind: 'Change Order Review', name });
  const { bold, italic } = pdf.fonts;

  pdf.titleBlock({
    title: name,
    facts: [
      `${money(h.totalAmount)} requested`,
      h.contractor && `by ${h.contractor}`,
      h.date,
      h.isAllowance && 'presented as an allowance',
    ].filter(Boolean).join('   ·   '),
    checkedAgainst: h.checkedAgainst,
  });
  pdf.verdictBanner(report.verdict);
  pdf.countTiles(report.tiles || [], t => (t.key === 'savings' ? (t.count ? 'indigo' : 'grey') : t.count ? 'red' : 'green'));
  pdf.passedLines(report.passed, report.notChecked);

  pdf.heading('Math errors', report.math.issues.length, report.math.issues.length ? 'red' : 'green');
  if (report.math.issues.length === 0) pdf.text('The arithmetic on the change order checks out.', { size: 9, color: pdf.GREY, gapAfter: 6 });
  for (const f of report.math.issues) {
    pdf.findingTitle(f, 'approving');
    pdf.compareTable(f.figures?.rows || [], 'ON THE PCO');
  }

  if (report.contract) {
    const c = report.contract;
    pdf.heading(`Contract deviations${c.label ? ` — ${c.label}` : ''}`, c.count ?? c.issues.length, c.issues.length ? 'red' : 'green');
    if (c.issues.length === 0) pdf.text('Nothing on the change order goes against the contract terms that were checked.', { size: 9, color: pdf.GREY, gapAfter: 6 });
    for (const f of c.issues) {
      pdf.findingTitle(f, 'approving');
      pdf.deviationTable(f.figures?.rows || [], 'ON THE PCO');
    }
  }

  if (report.scope) {
    const s = report.scope;
    const count = s.compared ? (s.aligned ? 0 : Math.max(1, s.extraItems.length)) : null;
    pdf.heading('Against the RFI/ASI', count, count ? 'amber' : 'green');
    if (s.reference?.label) pdf.text(s.reference.label, { size: 9, color: pdf.GREY, gapAfter: 2 });
    if (!s.compared) pdf.text('Could not be compared — the documents were too long to read side by side.', { size: 9, f: italic, color: pdf.GREY, gapAfter: 6 });
    else if (s.aligned) pdf.text('The change order prices the work the RFI/ASI asked for.', { size: 9, gapAfter: 6 });
    else {
      pdf.text(s.note || 'The change order prices work the RFI/ASI does not call for.', { size: 9, gapAfter: 3 });
      for (const item of s.extraItems) pdf.text(`•  ${item}`, { size: 9, x: MARGIN + 8, width: CONTENT_WIDTH - 8, gapAfter: 1 });
      pdf.gap(5);
    }
  }

  if (report.askFor.length) {
    pdf.heading('Ask for a breakdown', report.askFor.length, 'amber');
    pdf.text('Single figures with no quantities or unit prices behind them.', { size: 8.5, color: pdf.GREY, gapAfter: 2 });
    pdf.listTable(report.askFor);
  }

  const alt = report.alternatives;
  if (alt?.lines?.length) {
    pdf.heading('Value engineering options', alt.optionCount, alt.optionCount ? 'indigo' : 'grey');
    pdf.text("Coaster's suggestions for the materials and equipment priced. Rough ranges against each line, not quotes — confirm with the design team.", { size: 8.5, color: pdf.GREY, gapAfter: 2 });
    const COL_I = 150; const COL_D = 100; const COL_A = CONTENT_WIDTH - COL_I - COL_D;
    pdf.row([
      { width: COL_I, parts: [{ text: 'ITEM', f: bold, color: pdf.GREY }] },
      { width: COL_A, parts: [{ text: 'ALTERNATIVE', f: bold, color: pdf.GREY }] },
      { width: COL_D, parts: [{ text: 'COST DIFFERENCE', f: bold, color: pdf.GREY, align: 'right' }] },
    ], { head: true });
    for (const line of alt.lines) {
      const itemCell = first => ({
        width: COL_I,
        parts: first ? [{ text: line.description, f: bold, size: 8.5 }, ...(typeof line.amount === 'number' ? [{ text: money(line.amount), size: 8, color: pdf.GREY }] : [])] : [],
      });
      if (line.options.length === 0) {
        pdf.row([itemCell(true), { width: COL_A, parts: [{ text: line.noOptionsReason || 'No alternative suggested.', f: italic, size: 8.5, color: pdf.GREY }] }, { width: COL_D, parts: [{ text: '—', align: 'right', color: pdf.GREY }] }]);
        continue;
      }
      line.options.forEach((o, i) => {
        pdf.row([
          itemCell(i === 0),
          { width: COL_A, parts: [{ text: o.name, f: bold, size: 8.5 }, { text: o.whatItIs, size: 8 }, ...(o.note ? [{ text: o.note, size: 7.5, f: italic, color: pdf.TONES.amber.ink }] : [])] },
          { width: COL_D, parts: [{ text: o.costDifference, f: bold, size: 8.5, color: o.isSaving ? pdf.TONES.green.ink : pdf.INK, align: 'right' }] },
        ]);
      });
    }
    pdf.gap(6);
  }

  pdf.notesSection(report.notes);
  if (original) {
    try {
      await addMarkedPages(pdf.doc, { pdfBuffer: original, report, pco });
    } catch (err) {
      // The report stands on its own. A change order that cannot be marked up — damaged, encrypted,
      // a format pdf-lib cannot copy pages from — must not cost the reader the report.
      console.error('[pco markup] skipped:', err.message);
    }
  }
  return pdf.save();
}

module.exports = { renderPcoReportPdf };
