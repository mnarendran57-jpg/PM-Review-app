const { buildOptions } = require('./veOptions');
const { costBand, isSaving } = require('./veReport');

// Another way to do what a change order prices, where there could be one.
//
// A change order is a price for changed work, and the review already asks whether the price is
// right. This asks the question beside it: is there a cheaper way to do the same thing? That is
// the VE Analyzer's question, and the answer is produced by the VE Analyzer's own engine — the same
// rules, the same silence on commodity items, the same refusal to quote a dollar figure. What this
// file adds is deciding which lines to ask it about, and that is most of the work.
//
// WHICH CHANGE ORDERS GET LOOKED AT
//
// Most do not. A change order for added hours, a schedule extension, a rental or a permit has
// nothing in it to substitute, and a section of the review that says so every time is noise. So
// the question is only asked of lines that buy a product: the reading in lib/pcoExtract.js labels
// each line material, equipment, labor or other, and only the first two are candidates. A change
// order with none comes back with no section at all, and costs nothing extra.
//
// The lines already read are what is sent — a few words, a quantity and an amount each. The
// document is not read a second time.

// A line worth less than this share of the priced lines is not worth a conversation with the
// design team, however many lines there are.
const MIN_SHARE = 0.05;
// A change order is short, and so is this. Also the number the options engine gives its careful
// model, so every line here gets it.
const MAX_LINES = 8;

const PRODUCT_KINDS = new Set(['material', 'equipment']);

const amountOf = line => (typeof line?.total === 'number' ? line.total
  : (typeof line?.qty === 'number' && typeof line?.unitPrice === 'number' ? line.qty * line.unitPrice : null));

// The lines to ask about, biggest first, in the shape the options engine takes. `index` is the
// line's position on the change order, so an answer can be matched back to it.
function candidateLines(pco) {
  const lines = (pco?.lineItems || []).map((line, index) => ({ line, index, amount: amountOf(line) }));
  const priced = lines.filter(l => typeof l.amount === 'number' && l.amount > 0);
  const total = priced.reduce((n, l) => n + l.amount, 0);
  if (!total) return [];

  return priced
    .filter(l => PRODUCT_KINDS.has(l.line.kind) && l.amount / total >= MIN_SHARE)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_LINES)
    .map(l => ({
      index: l.index,
      description: l.line.description,
      quantity: typeof l.line.qty === 'number' ? l.line.qty : null,
      unit: l.line.unit || null,
      amount: l.amount,
    }));
}

const SITUATION = 'THIS IS A CHANGE ORDER, NOT A WHOLE ESTIMATE. The lines below are an addition or a '
  + 'change to a project that is already under contract and may already be under construction. '
  + 'Suggest an alternative only if it would still do what the change is for. Be quicker than usual '
  + 'to say nothing: a substitute that needs redesign, a new submittal or a long lead time can cost '
  + 'more in delay than it saves, so where that is likely say it in note, or leave the option out.';

// Returns null when there is nothing to ask about. Otherwise the rows the options engine produced,
// one per line asked about.
async function findAlternatives({ pco, reference }) {
  const lines = candidateLines(pco);
  if (lines.length === 0) return null;

  const title = [pco.pcoNumber && `Change order ${pco.pcoNumber}`, pco.title].filter(Boolean).join(' — ');
  const entries = await buildOptions(lines, {
    situation: SITUATION,
    estimateTitle: title || 'Change order',
    contractor: pco.contractor || null,
    // What the RFI or ASI asked for is the specification this change has to meet, and it goes in
    // the place the engine already reads one from.
    proposal: reference?.scopeSummary ? {
      alternates: [], exclusions: [], assumptions: [],
      scopeNotes: [{ system: `What ${reference.type || 'the RFI/ASI'} ${reference.number || ''} calls for`.replace(/\s+/g, ' ').trim(), detail: reference.scopeSummary }],
    } : null,
  });
  return { entries };
}

// What the report shows: every line that was asked about, with its alternatives worded and its cost
// difference spoken as a band. Worked out here rather than on the page so the screen and the
// downloaded report cannot word the same option differently.
function alternativesView(stored) {
  const entries = stored?.entries || [];
  if (entries.length === 0) return null;
  const lines = entries.map(entry => ({
    description: entry.description,
    amount: entry.amount,
    noOptionsReason: entry.options.length ? null
      : (entry.noOptionsReason || (entry.answered ? 'Nothing worth raising for this item.' : 'This item could not be looked at.')),
    options: entry.options.map(option => ({
      name: option.name,
      whatItIs: option.whatItIs,
      costDifference: costBand(option),
      isSaving: isSaving(option),
      note: option.note || null,
    })),
  }));
  return {
    lines,
    optionCount: lines.reduce((n, l) => n + l.options.length, 0),
  };
}

module.exports = { findAlternatives, alternativesView, candidateLines, MIN_SHARE, MAX_LINES };
