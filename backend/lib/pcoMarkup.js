const { citeLabel } = require('./contractClauses');
const { money } = require('./money');
const { drawMarkedPages, locate, moneyForms, subRun, viewTransform, ovalFor, layoutNotes } = require('./reviewMarkup');

// The contractor's change order, marked up with what the review found: which findings are marked,
// and what each note says. Where they go and how they are drawn is lib/reviewMarkup.js, shared with
// the invoice review.

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The line on the change order a description belongs to, for its amount.
function lineFor(pco, description) {
  const want = norm(description);
  return (pco?.lineItems || []).find(li => norm(li.description) === want)
    || (pco?.lineItems || []).find(li => want && norm(li.description).startsWith(want.slice(0, 18)));
}

// Every mark worth making, in the order the report presents its findings. Each says what to look
// for on the page — an amount, and the words on the same row — and what to write in its note.
function collectMarks(report, pco) {
  const marks = [];
  const add = mark => marks.push({ ...mark, number: marks.length + 1 });

  for (const f of report.math?.issues || []) {
    for (const r of f.figures?.rows || []) {
      if (f.id === 'P1') {
        add({ tone: 'red', title: 'The total does not add up', amount: r.shown, phrase: null,
          lines: [`The pieces add up to ${money(r.computed)}`, `Off by ${money(r.difference)}`] });
      } else {
        add({ tone: 'red', title: f.id === 'P3' ? 'Markup amount is wrong' : 'Line total is wrong',
          amount: r.shown, phrase: r.item,
          lines: [`${r.working ? `${r.working} = ` : 'Should be '}${money(r.computed)}`, `Shows ${money(r.shown)} — off by ${money(r.difference)}`] });
      }
    }
  }

  for (const f of report.contract?.issues || []) {
    for (const r of f.figures?.rows || []) {
      // A markup over its limit carries the overage, which is not printed anywhere; the line it is
      // about is found by its label, and its own amount is what is circled.
      let amount = r.amount;
      let phrase = r.item;
      if (f.id === 'A2' || f.id === 'A3') {
        const label = String(r.item).split(' — ')[0];
        const m = (pco?.markups || []).find(x => norm(x.label) === norm(label));
        amount = m?.amount ?? null;
        phrase = label;
      }
      if (f.id === 'T1') phrase = 'tax';
      add({
        tone: f.byCoaster ? 'amber' : 'red',
        title: f.byCoaster ? 'Coaster: against the contract' : f.title,
        amount, phrase,
        lines: [
          `${r.rule}${f.id === 'A2' || f.id === 'A3' ? ` — ${money(r.amount)} over` : ''}`,
          r.basis && String(r.basis).length < 70 ? r.basis : null,
        ].filter(Boolean),
        // Where the contract says it, so the note can be traced back to the agreement.
        cite: r.clause ? { label: citeLabel(r.clause), quote: r.clause.quote } : null,
      });
    }
  }

  for (const item of report.scope?.extraItems || []) {
    const line = lineFor(pco, item);
    add({ tone: 'amber', title: 'Not asked for in the RFI/ASI', amount: line?.total ?? null, phrase: item,
      lines: ['Priced here, but the RFI/ASI does not call for it'] });
  }

  for (const r of report.askFor || []) {
    add({ tone: 'amber', title: 'Ask for a breakdown', amount: r.amount, phrase: r.item,
      lines: ['One figure, no quantities or unit prices behind it'] });
  }

  for (const line of report.alternatives?.lines || []) {
    if (!line.options?.length) continue;
    const top = line.options.find(o => o.isSaving) || line.options[0];
    add({ tone: 'indigo', title: 'VE option', amount: line.amount, phrase: line.description,
      lines: [`${top.name} — ${top.costDifference}`, line.options.length > 1 ? `+${line.options.length - 1} more in the report` : null].filter(Boolean) });
  }
  return marks;
}

async function addMarkedPages(target, { pdfBuffer, report, pco }) {
  return drawMarkedPages(target, {
    sources: [{ buffer: pdfBuffer }],
    marks: collectMarks(report, pco),
    heading: `PCO ${report.header?.pcoNumber || ''} — marked up`,
    noun: 'change order',
  });
}

module.exports = { addMarkedPages, collectMarks, locate, moneyForms, subRun, viewTransform, ovalFor, layoutNotes };
