// Table-driven checks for Potential Change Orders (PCOs). Same conventions as
// payAppChecks.js: every description/detail is plain English for a reader with no
// construction-accounting background, and everything here is arithmetic over the
// already-extracted figures — no AI call, so a re-run always gives the same answer.
//
// Every check belongs to a group, and the PM decides which groups run by saying what the change
// order is checked against:
//   math      always — the document against itself
//   contract  only when a contract was chosen — tax, unallowable items, allowance and markup rules
//   backup    always — amounts that should come with a breakdown
//
// A failed check also carries `figures`: the numbers behind the finding, laid out so the report can
// show them as a table — what the document says, what it should say, and the difference — rather
// than leaving a reader to dig them out of a sentence.
//
// Expected shape of the `data` object passed to runPcoChecks():
// {
//   pco: {
//     pcoNumber, title, contractor, date, totalAmount, referencesRfi, isAllowance,
//     taxAmount, taxRate,
//     markups: [{ party, tier, label, rate, base, amount }],
//     lineItems: [{ description, qty, unit, unitPrice, total, hasBreakdown }]
//   },
//   contractTerms: { taxExempt, taxExemptBasis, unallowableItems[], ... } | null,
//   markupPolicy: { subRate, secondTierRate } | null   (defaults 10% / 5%)
// }

const { money } = require('./money');

const LINE_TOL = 0.02;
const AGG_TOL = 1.0;
// A lump sum below this is rarely worth a breakdown request; above it, ask.
const LUMP_SUM_THRESHOLD = 1000;

const DEFAULT_MARKUP_POLICY = { subRate: 0.10, secondTierRate: 0.05 };

function close(a, b, tol) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tol;
}

function pass(detail) { return { status: 'PASS', detail }; }
function fail(detail) { return { status: 'FAIL', detail }; }
function skip(detail) { return { status: 'SKIPPED', detail }; }

function pct(rate) {
  return typeof rate === 'number' ? `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%` : 'n/a';
}

const CHECKS = [
  // P. Pricing math
  {
    id: 'P1', group: 'math', category: 'Pricing Math', critical: true,
    description: 'Do the priced items and markups add up to the PCO total?',
    run: ({ pco }) => {
      if (pco.totalAmount == null) return skip('Skipped — no total amount could be read off this PCO.');
      const items = (pco.lineItems || []).reduce((a, li) => a + (Number(li.total) || 0), 0);
      const markups = (pco.markups || []).reduce((a, m) => a + (Number(m.amount) || 0), 0);
      const tax = Number(pco.taxAmount) || 0;
      const built = items + markups + tax;
      if (close(built, pco.totalAmount, AGG_TOL)) {
        return pass(`Yes — the priced work (${money(items)})${markups ? `, markups (${money(markups)})` : ''}${tax ? `, and tax (${money(tax)})` : ''} add up to the requested total of ${money(pco.totalAmount)}.`);
      }
      return {
        ...fail(`The pieces add up to ${money(built)} (work ${money(items)}${markups ? `, markups ${money(markups)}` : ''}${tax ? `, tax ${money(tax)}` : ''}), but the PCO asks for ${money(pco.totalAmount)} — a difference of ${money(pco.totalAmount - built)} that is not explained by anything on the document.`),
        figures: {
          kind: 'compare',
          rows: [{ item: 'Total requested', shown: pco.totalAmount, computed: built, difference: pco.totalAmount - built }],
          parts: { work: items, markups, tax },
        },
      };
    }
  },
  {
    id: 'P2', group: 'math', category: 'Pricing Math', critical: false,
    description: 'Does quantity × unit price match the total shown for each item?',
    run: ({ pco }) => {
      const checkable = (pco.lineItems || []).filter(li => li.qty != null && li.unitPrice != null && li.total != null);
      if (checkable.length === 0) return skip('Skipped — no items on this PCO show a quantity and unit price to verify.');
      const bad = checkable.filter(li => !close(li.qty * li.unitPrice, li.total, LINE_TOL));
      if (bad.length === 0) return pass(`Yes — for all ${checkable.length} priced items, quantity times unit price matches the total shown.`);
      return {
        ...fail(bad.map(li =>
          `"${li.description}": ${li.qty} × ${money(li.unitPrice)} is ${money(li.qty * li.unitPrice)}, but the PCO shows ${money(li.total)}.`
        ).join(' ')),
        figures: {
          kind: 'compare',
          rows: bad.map(li => ({
            item: li.description,
            working: `${li.qty}${li.unit ? ` ${li.unit}` : ''} × ${money(li.unitPrice)}`,
            shown: li.total, computed: li.qty * li.unitPrice, difference: li.total - li.qty * li.unitPrice,
          })),
        },
      };
    }
  },
  {
    id: 'P3', group: 'math', category: 'Pricing Math', critical: false,
    description: 'Does each markup line equal its stated rate applied to its base?',
    run: ({ pco }) => {
      const checkable = (pco.markups || []).filter(m => m.rate != null && m.base != null && m.amount != null);
      if (checkable.length === 0) return skip('Skipped — no markup lines show a rate, base, and amount to verify.');
      const bad = checkable.filter(m => !close(m.rate * m.base, m.amount, AGG_TOL));
      if (bad.length === 0) return pass(`Yes — all ${checkable.length} markup lines equal their stated rate times the amount they are applied to.`);
      return {
        ...fail(bad.map(m =>
          `"${m.label}": ${pct(m.rate)} of ${money(m.base)} is ${money(m.rate * m.base)}, but the PCO shows ${money(m.amount)}.`
        ).join(' ')),
        figures: {
          kind: 'compare',
          rows: bad.map(m => ({
            item: m.label,
            working: `${pct(m.rate)} of ${money(m.base)}`,
            shown: m.amount, computed: m.rate * m.base, difference: m.amount - m.rate * m.base,
          })),
        },
      };
    }
  },

  // T. Tax
  {
    id: 'T1', group: 'contract', category: 'Tax', critical: true,
    description: 'Is tax being charged on a project the contract says is tax exempt?',
    run: ({ pco, contractTerms }) => {
      const taxed = (Number(pco.taxAmount) || 0) > 0 || (Number(pco.taxRate) || 0) > 0;
      if (!contractTerms) {
        return taxed
          ? fail(`This PCO includes ${pco.taxAmount ? money(pco.taxAmount) + ' of' : ''} tax, and no contract is on file to confirm whether that is allowed. Public entities are usually tax exempt — upload the contract, or confirm the tax status before approving.`)
          : skip('Skipped — no tax appears on this PCO and no contract is on file to check against.');
      }
      if (contractTerms.taxExempt === true) {
        return taxed
          ? {
            ...fail(`This PCO includes ${pco.taxAmount ? money(pco.taxAmount) + ' of' : ''} tax, but the contract states the project is tax exempt${contractTerms.taxExemptBasis ? ` (${contractTerms.taxExemptBasis})` : ''}. The tax should be removed before this is approved.`),
            figures: {
              kind: 'deviation',
              rows: [{
                item: 'Sales tax charged', amount: Number(pco.taxAmount) || null,
                rule: 'The project is tax exempt', basis: contractTerms.taxExemptBasis || null,
              }],
            },
          }
          : pass('No tax is charged, which matches the contract — this project is tax exempt.');
      }
      if (contractTerms.taxExempt === false) {
        return pass(taxed
          ? 'Tax appears on this PCO, and the contract does not exempt this project from tax.'
          : 'No tax appears on this PCO. The contract does not exempt this project, so confirm whether tax should have been included.');
      }
      return taxed
        ? {
          ...fail(`This PCO includes ${pco.taxAmount ? money(pco.taxAmount) + ' of' : ''} tax, and the contract on file does not state the project's tax status. Public entities are usually tax exempt — confirm before approving.`),
          figures: {
            kind: 'deviation',
            rows: [{
              item: 'Sales tax charged', amount: Number(pco.taxAmount) || null,
              rule: 'The contract does not say whether the project is tax exempt — confirm before approving',
              basis: null,
            }],
          },
        }
        : skip('Skipped — no tax appears on this PCO, and the contract does not state the tax status either way.');
    }
  },

  // A. Allowance & markup rules
  {
    id: 'A1', group: 'contract', category: 'Markup Rules', critical: true,
    description: 'If this PCO is an allowance, is the contractor taking overhead and profit on it?',
    run: ({ pco }) => {
      if (!pco.isAllowance) return skip('Skipped — this PCO is not presented as an allowance.');
      const oh = (pco.markups || []).filter(m => (Number(m.amount) || 0) > 0);
      if (oh.length === 0) return pass('This is an allowance and no overhead, profit, or markup is charged on it — which is correct: an allowance is the owner\'s set-aside money, not changed work.');
      const total = oh.reduce((a, m) => a + m.amount, 0);
      return {
        ...fail(`This PCO is presented as an allowance, but it carries ${money(total)} of markup (${oh.map(m => `"${m.label}"`).join(', ')}). An allowance is the owner's own set-aside — the contractor should not take overhead and profit on it.`),
        figures: {
          kind: 'deviation',
          rows: oh.map(m => ({
            item: m.label, amount: m.amount,
            rule: 'No overhead or profit on an allowance', basis: null,
          })),
        },
      };
    }
  },
  {
    id: 'A2', group: 'contract', category: 'Markup Rules', critical: false,
    description: 'Is the subcontractor markup within the allowed 10%?',
    run: ({ pco, markupPolicy }) => {
      const cap = (markupPolicy || DEFAULT_MARKUP_POLICY).subRate;
      const subs = (pco.markups || []).filter(m => m.tier === 'sub' && m.rate != null);
      if (subs.length === 0) return skip('Skipped — no subcontractor markup with a stated rate appears on this PCO.');
      const over = subs.filter(m => m.rate > cap + 0.0001);
      if (over.length === 0) return pass(`Yes — subcontractor markup is at or under the ${pct(cap)} allowed (${subs.map(m => `"${m.label}" at ${pct(m.rate)}`).join(', ')}).`);
      return {
        ...fail(over.map(m =>
          `"${m.label}" takes ${pct(m.rate)}, but the allowed subcontractor markup is ${pct(cap)}${m.base != null ? ` — on ${money(m.base)} that is ${money((m.rate - cap) * m.base)} more than allowed` : ''}.`
        ).join(' ')),
        figures: {
          kind: 'deviation',
          rows: over.map(m => ({
            item: `${m.label} — ${pct(m.rate)} charged`,
            amount: m.base != null ? (m.rate - cap) * m.base : null,
            rule: `Subcontractor markup is limited to ${pct(cap)}`, basis: null,
          })),
        },
      };
    }
  },
  {
    id: 'A3', group: 'contract', category: 'Markup Rules', critical: false,
    description: 'Is the markup on second-tier subcontractor work within the allowed 5%?',
    run: ({ pco, markupPolicy }) => {
      const cap = (markupPolicy || DEFAULT_MARKUP_POLICY).secondTierRate;
      const tier2 = (pco.markups || []).filter(m => m.tier === 'second-tier' && m.rate != null);
      if (tier2.length === 0) return skip('Skipped — no second-tier subcontractor markup with a stated rate appears on this PCO.');
      const over = tier2.filter(m => m.rate > cap + 0.0001);
      if (over.length === 0) return pass(`Yes — markup on second-tier work is at or under the ${pct(cap)} allowed.`);
      return {
        ...fail(over.map(m =>
          `"${m.label}" takes ${pct(m.rate)} on second-tier work, but only ${pct(cap)} is allowed${m.base != null ? ` — on ${money(m.base)} that is ${money((m.rate - cap) * m.base)} more than allowed` : ''}.`
        ).join(' ')),
        figures: {
          kind: 'deviation',
          rows: over.map(m => ({
            item: `${m.label} — ${pct(m.rate)} charged`,
            amount: m.base != null ? (m.rate - cap) * m.base : null,
            rule: `Second-tier markup is limited to ${pct(cap)}`, basis: null,
          })),
        },
      };
    }
  },

  // L. Lump sums
  {
    id: 'L1', group: 'backup', category: 'Backup', critical: false,
    description: 'Are there lump-sum amounts that should be broken down before approving?',
    run: ({ pco }) => {
      const lumps = (pco.lineItems || []).filter(li =>
        li.hasBreakdown === false && (Number(li.total) || 0) >= LUMP_SUM_THRESHOLD
      );
      if ((pco.lineItems || []).length === 0) return skip('Skipped — no priced items could be read off this PCO.');
      if (lumps.length === 0) return pass('Every significant amount on this PCO shows a quantity and unit price — nothing is priced as a bare lump sum.');
      return {
        ...fail(lumps.map(li =>
          `"${li.description}" is a single ${money(li.total)} figure with no quantities or unit prices behind it — ask for the breakdown before approving.`
        ).join(' ')),
        figures: { kind: 'list', rows: lumps.map(li => ({ item: li.description, amount: li.total })) },
      };
    }
  },

  // C. Contract's own unallowable items
  {
    id: 'C1', group: 'contract', category: 'Contract Terms', critical: false,
    description: 'Does this PCO bill for anything the contract says may not be billed?',
    run: ({ pco, contractTerms }) => {
      const banned = contractTerms?.unallowableItems || [];
      if (banned.length === 0) return skip('Skipped — no contract on file, or the contract on file lists no unallowable cost items.');
      const hay = [
        ...(pco.lineItems || []).map(li => li.description || ''),
        ...(pco.markups || []).map(m => m.label || ''),
      ].join(' \n ').toLowerCase();
      const hits = banned.filter(b => {
        const words = String(b.item).toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return words.length > 0 && words.every(w => hay.includes(w));
      });
      if (hits.length === 0) return pass(`Nothing on this PCO matches the ${banned.length} cost item${banned.length === 1 ? '' : 's'} the contract forbids billing for. (This is a wording match — the compliance notes below take a closer look.)`);
      return {
        ...fail(hits.map(b =>
          `The contract does not allow billing for "${b.item}"${b.basis ? ` (${b.basis})` : ''}, but wording matching it appears on this PCO — verify before approving.`
        ).join(' ')),
        figures: {
          kind: 'deviation',
          rows: hits.map(b => ({ item: b.item, amount: null, rule: 'The contract does not allow billing for this', basis: b.basis || null })),
        },
      };
    }
  },
];

// `groups` is which groups to run. Left out, every group runs — which is what a review stored
// before the PM could choose did, so it reads back the same.
function runPcoChecks(data, { groups = ['math', 'contract', 'backup'] } = {}) {
  return CHECKS.filter(c => groups.includes(c.group)).map(c => {
    try {
      const outcome = c.run(data);
      return { id: c.id, group: c.group, category: c.category, critical: c.critical, description: c.description, ...outcome };
    } catch (err) {
      return {
        id: c.id, group: c.group, category: c.category, critical: c.critical, description: c.description,
        status: 'SKIPPED', detail: `Skipped — this check could not run on the extracted data (${err.message}).`,
      };
    }
  });
}

module.exports = { runPcoChecks, DEFAULT_MARKUP_POLICY };
