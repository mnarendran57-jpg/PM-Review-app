// Table-driven checks for Potential Change Orders (PCOs). Same conventions as
// payAppChecks.js: every description/detail is plain English for a reader with no
// construction-accounting background, and everything here is arithmetic over the
// already-extracted figures — no AI call, so a re-run always gives the same answer.
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

const { money } = require('./payAppChecks');

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
    id: 'P1', category: 'Pricing Math', critical: true,
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
      return fail(`The pieces add up to ${money(built)} (work ${money(items)}${markups ? `, markups ${money(markups)}` : ''}${tax ? `, tax ${money(tax)}` : ''}), but the PCO asks for ${money(pco.totalAmount)} — a difference of ${money(pco.totalAmount - built)} that is not explained by anything on the document.`);
    }
  },
  {
    id: 'P2', category: 'Pricing Math', critical: false,
    description: 'Does quantity × unit price match the total shown for each item?',
    run: ({ pco }) => {
      const checkable = (pco.lineItems || []).filter(li => li.qty != null && li.unitPrice != null && li.total != null);
      if (checkable.length === 0) return skip('Skipped — no items on this PCO show a quantity and unit price to verify.');
      const bad = checkable.filter(li => !close(li.qty * li.unitPrice, li.total, LINE_TOL));
      if (bad.length === 0) return pass(`Yes — for all ${checkable.length} priced items, quantity times unit price matches the total shown.`);
      return fail(bad.map(li =>
        `"${li.description}": ${li.qty} × ${money(li.unitPrice)} is ${money(li.qty * li.unitPrice)}, but the PCO shows ${money(li.total)}.`
      ).join(' '));
    }
  },
  {
    id: 'P3', category: 'Pricing Math', critical: false,
    description: 'Does each markup line equal its stated rate applied to its base?',
    run: ({ pco }) => {
      const checkable = (pco.markups || []).filter(m => m.rate != null && m.base != null && m.amount != null);
      if (checkable.length === 0) return skip('Skipped — no markup lines show a rate, base, and amount to verify.');
      const bad = checkable.filter(m => !close(m.rate * m.base, m.amount, AGG_TOL));
      if (bad.length === 0) return pass(`Yes — all ${checkable.length} markup lines equal their stated rate times the amount they are applied to.`);
      return fail(bad.map(m =>
        `"${m.label}": ${pct(m.rate)} of ${money(m.base)} is ${money(m.rate * m.base)}, but the PCO shows ${money(m.amount)}.`
      ).join(' '));
    }
  },

  // T. Tax
  {
    id: 'T1', category: 'Tax', critical: true,
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
          ? fail(`This PCO includes ${pco.taxAmount ? money(pco.taxAmount) + ' of' : ''} tax, but the contract states the project is tax exempt${contractTerms.taxExemptBasis ? ` (${contractTerms.taxExemptBasis})` : ''}. The tax should be removed before this is approved.`)
          : pass('No tax is charged, which matches the contract — this project is tax exempt.');
      }
      if (contractTerms.taxExempt === false) {
        return pass(taxed
          ? 'Tax appears on this PCO, and the contract does not exempt this project from tax.'
          : 'No tax appears on this PCO. The contract does not exempt this project, so confirm whether tax should have been included.');
      }
      return taxed
        ? fail(`This PCO includes ${pco.taxAmount ? money(pco.taxAmount) + ' of' : ''} tax, and the contract on file does not state the project's tax status. Public entities are usually tax exempt — confirm before approving.`)
        : skip('Skipped — no tax appears on this PCO, and the contract does not state the tax status either way.');
    }
  },

  // A. Allowance & markup rules
  {
    id: 'A1', category: 'Markup Rules', critical: true,
    description: 'If this PCO is an allowance, is the contractor taking overhead and profit on it?',
    run: ({ pco }) => {
      if (!pco.isAllowance) return skip('Skipped — this PCO is not presented as an allowance.');
      const oh = (pco.markups || []).filter(m => (Number(m.amount) || 0) > 0);
      if (oh.length === 0) return pass('This is an allowance and no overhead, profit, or markup is charged on it — which is correct: an allowance is the owner\'s set-aside money, not changed work.');
      const total = oh.reduce((a, m) => a + m.amount, 0);
      return fail(`This PCO is presented as an allowance, but it carries ${money(total)} of markup (${oh.map(m => `"${m.label}"`).join(', ')}). An allowance is the owner's own set-aside — the contractor should not take overhead and profit on it.`);
    }
  },
  {
    id: 'A2', category: 'Markup Rules', critical: false,
    description: 'Is the subcontractor markup within the allowed 10%?',
    run: ({ pco, markupPolicy }) => {
      const cap = (markupPolicy || DEFAULT_MARKUP_POLICY).subRate;
      const subs = (pco.markups || []).filter(m => m.tier === 'sub' && m.rate != null);
      if (subs.length === 0) return skip('Skipped — no subcontractor markup with a stated rate appears on this PCO.');
      const over = subs.filter(m => m.rate > cap + 0.0001);
      if (over.length === 0) return pass(`Yes — subcontractor markup is at or under the ${pct(cap)} allowed (${subs.map(m => `"${m.label}" at ${pct(m.rate)}`).join(', ')}).`);
      return fail(over.map(m =>
        `"${m.label}" takes ${pct(m.rate)}, but the allowed subcontractor markup is ${pct(cap)}${m.base != null ? ` — on ${money(m.base)} that is ${money((m.rate - cap) * m.base)} more than allowed` : ''}.`
      ).join(' '));
    }
  },
  {
    id: 'A3', category: 'Markup Rules', critical: false,
    description: 'Is the markup on second-tier subcontractor work within the allowed 5%?',
    run: ({ pco, markupPolicy }) => {
      const cap = (markupPolicy || DEFAULT_MARKUP_POLICY).secondTierRate;
      const tier2 = (pco.markups || []).filter(m => m.tier === 'second-tier' && m.rate != null);
      if (tier2.length === 0) return skip('Skipped — no second-tier subcontractor markup with a stated rate appears on this PCO.');
      const over = tier2.filter(m => m.rate > cap + 0.0001);
      if (over.length === 0) return pass(`Yes — markup on second-tier work is at or under the ${pct(cap)} allowed.`);
      return fail(over.map(m =>
        `"${m.label}" takes ${pct(m.rate)} on second-tier work, but only ${pct(cap)} is allowed${m.base != null ? ` — on ${money(m.base)} that is ${money((m.rate - cap) * m.base)} more than allowed` : ''}.`
      ).join(' '));
    }
  },

  // L. Lump sums
  {
    id: 'L1', category: 'Backup', critical: false,
    description: 'Are there lump-sum amounts that should be broken down before approving?',
    run: ({ pco }) => {
      const lumps = (pco.lineItems || []).filter(li =>
        li.hasBreakdown === false && (Number(li.total) || 0) >= LUMP_SUM_THRESHOLD
      );
      if ((pco.lineItems || []).length === 0) return skip('Skipped — no priced items could be read off this PCO.');
      if (lumps.length === 0) return pass('Every significant amount on this PCO shows a quantity and unit price — nothing is priced as a bare lump sum.');
      return fail(lumps.map(li =>
        `"${li.description}" is a single ${money(li.total)} figure with no quantities or unit prices behind it — ask for the breakdown before approving.`
      ).join(' '));
    }
  },

  // C. Contract's own unallowable items
  {
    id: 'C1', category: 'Contract Terms', critical: false,
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
      return fail(hits.map(b =>
        `The contract does not allow billing for "${b.item}"${b.basis ? ` (${b.basis})` : ''}, but wording matching it appears on this PCO — verify before approving.`
      ).join(' '));
    }
  },
];

function runPcoChecks(data) {
  return CHECKS.map(c => {
    try {
      const outcome = c.run(data);
      return { id: c.id, category: c.category, critical: c.critical, description: c.description, ...outcome };
    } catch (err) {
      return {
        id: c.id, category: c.category, critical: c.critical, description: c.description,
        status: 'SKIPPED', detail: `Skipped — this check could not run on the extracted data (${err.message}).`,
      };
    }
  });
}

module.exports = { runPcoChecks, DEFAULT_MARKUP_POLICY };
