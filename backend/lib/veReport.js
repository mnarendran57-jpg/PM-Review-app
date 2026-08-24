const { money } = require('./money');

// The report the owner reads: a table of items, the alternatives to each, and what each would do
// to the cost.
//
// Built from the same rows the project manager curated on screen, filtered to the options they
// kept, so the PM's view and the owner's document are one set of data seen through one filter
// rather than two renderings that can drift apart.
//
// Everything here is worded for somebody paying for a building who does not work in construction.
// That is not a style preference: this document exists to be forwarded to an owner, and a report
// they have to have explained to them has failed at the only thing it was for.

// How a cost difference is spoken. Never a dollar figure — see lib/veOptions.js for why that
// restriction exists and is not negotiable.
function costBand(option) {
  const low = typeof option.savingsLowPct === 'number' ? option.savingsLowPct : null;
  const high = typeof option.savingsHighPct === 'number' ? option.savingsHighPct : null;
  if (low == null && high == null) return 'Depends on the design';

  const [lo, hi] = [low ?? high, high ?? low].sort((a, b) => a - b);
  const pct = n => `${Math.abs(Math.round(n))}%`;
  const same = Math.round(lo) === Math.round(hi);

  // A band that straddles zero is honest and common: cheaper or dearer depending on how it is
  // detailed. Saying "0-15% less" there would be a quiet lie in the owner's favour.
  if (lo < 0 && hi > 0) return `${pct(lo)} more to ${pct(hi)} less`;
  if (hi <= 0) return `${same ? '' : `${pct(hi)} to `}${pct(lo)} more`;
  return `${same ? '' : `${pct(lo)} to `}${pct(hi)} less`;
}

// True where the option costs less at both ends of its band. Derived from the numbers rather than
// carried as a separate field the model could contradict.
const isSaving = option => typeof option.savingsLowPct === 'number' && option.savingsLowPct > 0;

// Only what the PM kept. `hadOptions` records whether there were any before they decided, which is
// the difference between "nothing was found" and "the PM did not want these in front of this
// client" — printing the first where the second is true would put words in their mouth.
function keptEntries(entries) {
  return (entries || []).map((entry) => {
    const all = entry.options || [];
    return { ...entry, options: all.filter(o => o.kept !== false), hadOptions: all.length > 0 };
  });
}

// The contractor's own priced alternates, where the upload was a proposal. The only real prices in
// this document — their figures, not an estimate of anything — so they are printed as money and
// attributed.
function alreadyOffered(header) {
  return (header?.proposal?.alternates || [])
    .filter(a => a && a.description)
    .map((a) => {
      const amount = typeof a.amount === 'number' ? a.amount : null;
      return {
        description: a.description,
        amount,
        effect: amount == null ? null
          : amount < 0 ? `${money(Math.abs(amount))} off` : `${money(amount)} added`,
        isSaving: amount != null && amount < 0,
      };
    });
}

const DISCLAIMER =
  'The percentages below are how these products and methods generally compare. They are not quotes '
  + 'and they are not drawn from any pricing service. Whether an option works on your building '
  + 'depends on the drawings, the building code, and the approvals for your project — ask your '
  + 'architect or engineer before acting on anything here.';

function buildVeReport({ header, entries }) {
  const rows = keptEntries(entries);
  const offered = alreadyOffered(header);
  const withOptions = rows.filter(r => r.options.length > 0);

  const report = {
    header,
    disclaimer: DISCLAIMER,
    alreadyOffered: offered,
    // Every item that was looked at, in the order it was ranked. An item with nothing to offer
    // stays in the table with its one-line reason rather than disappearing — the owner asked what
    // the options were, and "none" is an answer.
    entries: rows,
    counts: {
      items: rows.length,
      itemsWithOptions: withOptions.length,
      options: withOptions.reduce((n, e) => n + e.options.length, 0),
      alreadyOffered: offered.length,
    },
  };
  report.markdown = renderMarkdown(report);
  return report;
}

function renderMarkdown({ header, disclaimer, entries, alreadyOffered: offered, counts }) {
  const lines = [];
  const title = header.projectName || header.estimateTitle || 'Cost Estimate';
  lines.push(`# Options to Consider — ${title}`);
  lines.push('');

  const facts = [];
  if (header.contractor) facts.push(`**Estimate from:** ${header.contractor}`);
  if (header.estimateDate) facts.push(`**Dated:** ${header.estimateDate}`);
  if (typeof header.estimateTotal === 'number') facts.push(`**Total:** ${money(header.estimateTotal)}`);
  if (facts.length) { lines.push(facts.join(' · ')); lines.push(''); }

  lines.push(`> ${disclaimer}`);
  lines.push('');

  if (offered && offered.length) {
    lines.push('## Already offered by your contractor');
    lines.push('');
    lines.push('| Alternate | Cost |');
    lines.push('| --- | --- |');
    for (const item of offered) {
      lines.push(`| ${cell(item.description)} | ${item.effect || '—'} |`);
    }
    lines.push('');
  }

  lines.push('## Options by item');
  lines.push('');

  if (entries.length === 0) {
    lines.push('No priced items could be read from this document.');
    return lines.join('\n');
  }

  lines.push('| Item | Alternative | Difference in cost |');
  lines.push('| --- | --- | --- |');

  for (const entry of entries) {
    const label = `**${cell(entry.description)}**`
      + (typeof entry.amount === 'number' ? `<br>${money(entry.amount)}` : '');

    if (entry.options.length === 0) {
      // Nothing to say only where nothing was found. Where the PM dropped everything, the cell is
      // left blank rather than claiming on their behalf that there was no alternative.
      const said = entry.hadOptions ? '' : `*${cell(entry.noOptionsReason || 'No alternative worth raising.')}*`;
      lines.push(`| ${label} | ${said} | — |`);
      continue;
    }
    entry.options.forEach((option, i) => {
      const what = `**${cell(option.name)}**<br>${cell(option.whatItIs)}`
        + (option.note ? `<br>*${cell(option.note)}*` : '');
      // The item is named once and left blank on its continuation rows, so a line with three
      // alternatives reads as one block rather than as three separate findings.
      lines.push(`| ${i === 0 ? label : ''} | ${what} | ${costBand(option)} |`);
    });
  }

  lines.push('');
  lines.push(`${counts.options} alternative${counts.options === 1 ? '' : 's'} across `
    + `${counts.itemsWithOptions} of the ${counts.items} item${counts.items === 1 ? '' : 's'} looked at.`);

  return lines.join('\n');
}

// A pipe inside a cell ends the column early and shifts every value after it into the wrong
// heading. Rare in construction prose and catastrophic when it happens, so it is escaped rather
// than hoped about.
const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

module.exports = { buildVeReport, keptEntries, costBand, isSaving, DISCLAIMER };
