const { createReviewPdf } = require('./reviewPdfKit');
const { money } = require('./money');
const { addMarkedPages } = require('./invoiceMarkup');

// The invoice review as a document: whether it can be paid, a count of each kind of problem, and each
// problem as a small table of its numbers. Built from the same report object the screen shows.
//
// `sources` are the files as uploaded — the invoice, and any receipts sent with it. Given them, the
// pages with findings on them follow the report, marked up — see lib/invoiceMarkup.js.

async function renderInvoiceReportPdf({ report, sources = [] }) {
  const h = report.header;
  const name = `${h.vendor}${h.invoiceNumber ? ` — Invoice ${h.invoiceNumber}` : ''}`;
  const pdf = await createReviewPdf({ kind: 'Invoice Review', name });

  pdf.titleBlock({
    title: name,
    facts: [money(h.total), h.invoiceDate, h.poNumber && `PO ${h.poNumber}`].filter(Boolean).join('   ·   '),
    checkedAgainst: h.checkedAgainst,
  });
  pdf.verdictBanner(report.verdict);
  pdf.countTiles(report.tiles, t => (t.count ? 'red' : 'green'));
  pdf.passedLines(report.passed, report.notChecked);

  if (report.duplicate) {
    const d = report.duplicate;
    pdf.heading('Possible duplicate', d.figures?.rows?.length || 1, 'red');
    pdf.findingTitle(d, 'paying');
    pdf.listTable(d.figures?.rows || []);
  }

  pdf.heading('Math errors', report.math.issues.length, report.math.issues.length ? 'red' : 'green');
  if (report.math.issues.length === 0) pdf.text('The arithmetic on the invoice checks out.', { size: 9, color: pdf.GREY, gapAfter: 6 });
  for (const f of report.math.issues) {
    pdf.findingTitle(f, 'paying');
    pdf.compareTable(f.figures?.rows || [], 'ON THE INVOICE');
  }

  if (report.backup) {
    const b = report.backup;
    pdf.heading('Missing receipts', b.figures?.rows?.length || 1, 'red');
    pdf.text('Billed as costs the vendor paid and is passing on, with no receipt or invoice among the uploads.', { size: 8.5, color: pdf.GREY, gapAfter: 2 });
    pdf.listTable(b.figures?.rows || []);
  }

  if (report.contract) {
    const c = report.contract;
    pdf.heading(`${c.title || 'Contract and PO'}${c.label ? ` — ${c.label}` : ''}`, c.count, c.issues.length ? 'red' : 'green');
    if (c.issues.length === 0) pdf.text('Nothing on the invoice goes against the agreement terms that were checked.', { size: 9, color: pdf.GREY, gapAfter: 4 });
    for (const f of c.issues) {
      pdf.findingTitle(f, 'paying');
      if (f.figures?.kind === 'billing') pdf.listTable(f.figures.rows);
      else pdf.deviationTable(f.figures?.rows || [], 'ON THE INVOICE');
    }
    if (c.billing) pdf.text(c.billing, { size: 8.5, color: pdf.GREY, gapAfter: 6 });
  }

  pdf.notesSection(report.notes);
  if (sources.length) {
    try {
      await addMarkedPages(pdf.doc, { sources, report });
    } catch (err) {
      // The report stands on its own. An invoice that cannot be marked up must not cost the reader it.
      console.error('[invoice markup] skipped:', err.message);
    }
  }
  return pdf.save();
}

module.exports = { renderInvoiceReportPdf };
