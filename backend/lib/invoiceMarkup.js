const { citeLabel } = require('./contractClauses');
const { money } = require('./money');
const { drawMarkedPages } = require('./reviewMarkup');

// The vendor's invoice, marked up with what the review found: which findings are marked, and what
// each note says. Where they go and how they are drawn is lib/reviewMarkup.js, shared with the change
// order review.

const cite = r => (r?.clause ? { label: citeLabel(r.clause), quote: r.clause.quote } : null);

// The figures and words of the PO number as printed — "PO-253016-004" is found as "253016 004".
const poPhrase = v => String(v || '').replace(/^(PO|P\.O\.|NO\.?|#)\s*/i, '');

// Every mark worth making, in the order the report presents its findings.
function collectMarks(report) {
  const marks = [];
  const add = mark => marks.push({ ...mark, number: marks.length + 1 });
  const h = report.header || {};

  // One mark however many earlier reviews match: they all point at the same total.
  const earlier = report.duplicate?.figures?.rows || [];
  if (earlier.length) {
    add({ tone: 'red', title: 'May already have been reviewed', amount: h.total, phrase: null,
      lines: [earlier[0].item, earlier[0].note, earlier.length > 1 ? `+${earlier.length - 1} more in the report` : null].filter(Boolean) });
  }

  for (const f of report.math?.issues || []) {
    for (const r of f.figures?.rows || []) {
      if (f.id === 'M1') {
        add({ tone: 'red', title: 'The total does not add up', amount: r.shown, phrase: null,
          lines: [`The lines add up to ${money(r.computed)}`, `Off by ${money(r.difference)}`] });
      } else if (f.id === 'M3') {
        add({ tone: 'red', title: 'The subtotal does not add up', amount: r.shown, phrase: 'subtotal',
          lines: [`The lines add up to ${money(r.computed)}`, `Off by ${money(r.difference)}`] });
      } else {
        add({ tone: 'red', title: 'Line total is wrong', amount: r.shown, phrase: r.item,
          lines: [`${r.working ? `${r.working} = ` : 'Should be '}${money(r.computed)}`, `Shows ${money(r.shown)} — off by ${money(r.difference)}`] });
      }
    }
  }

  for (const r of report.backup?.figures?.rows || []) {
    add({ tone: 'red', title: 'No receipt for this cost', amount: r.amount, phrase: r.item,
      lines: ['Billed as a cost passed on, with no receipt among the uploads'], cite: cite(r) });
  }

  for (const f of report.contract?.issues || []) {
    if (f.figures?.kind === 'billing') {
      // Past what the agreement is worth: the invoice's own total is what tips it over.
      const rows = f.figures.rows || [];
      const value = rows.find(r => r.item === 'Agreement value') || rows[0];
      const over = rows.find(r => r.emphasis);
      add({ tone: 'red', title: f.title, amount: h.total, phrase: null,
        lines: [`The agreement is worth ${money(value?.amount)}`, over ? `Over it by ${money(over.amount)}` : null].filter(Boolean),
        cite: cite(value) });
      continue;
    }
    for (const r of f.figures?.rows || []) {
      let amount = r.amount;
      let phrase = r.item;
      if (f.id === 'T1') phrase = 'tax';
      if (f.id === 'PO1') { amount = null; phrase = poPhrase(h.poNumber); }
      add({
        tone: f.byCoaster ? 'amber' : 'red',
        title: f.byCoaster ? 'Coaster: against the contract' : f.title,
        amount, phrase,
        lines: [r.rule, r.basis && String(r.basis).length < 70 ? r.basis : null].filter(Boolean),
        cite: cite(r),
      });
    }
  }
  for (const e of report.secondLook || []) {
    add({ tone: 'amber', title: 'Worth a second look', amount: e.amount, phrase: e.item, lines: [e.note] });
  }
  return marks;
}

// `sources`: the files uploaded, in order — the invoice, and any receipts sent with it. All of their
// pages follow the report, marked where a finding is.
async function addMarkedPages(target, { sources, report }) {
  const h = report.header || {};
  return drawMarkedPages(target, {
    sources,
    marks: collectMarks(report),
    heading: `${h.invoiceNumber ? `Invoice ${h.invoiceNumber}` : h.vendor || 'Invoice'} — marked up`,
    noun: 'invoice',
    // The invoice as it was sent, every page, after the report — not only the pages with a finding.
    wholeDocument: true,
  });
}

module.exports = { addMarkedPages, collectMarks };
