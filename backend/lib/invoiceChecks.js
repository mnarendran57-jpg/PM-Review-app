// Table-driven checks for vendor invoices. Same conventions as pcoChecks.js /
// payAppChecks.js: every description/detail is plain English for a reader with no
// construction-accounting background, and everything here is arithmetic or a direct
// reading of the already-extracted figures — no AI call, so a re-run always gives the
// same answer.
//
// Expected shape of the `data` object passed to runInvoiceChecks():
// {
//   invoice: {
//     vendor, invoiceNumber, invoiceDate, poNumber,
//     subtotal, taxAmount, taxRate, total,
//     lineItems: [{ description, qty, unit, unitPrice, total,
//                   isReimbursable, hasBackup, backupNote }]
//   },
//   contractTerms: { taxExempt, taxExemptBasis, unallowableItems[], commitment,
//                    originalContractSum, clauses, ... } | null,
//   billing: { contractValue, priorBilled, priorCount } | null — what Coaster has already reviewed
//            against the same contract or PO, worked out by the route,
//   duplicates: [{ id, invoiceNumber, total, invoiceDate, reviewedOn }] — earlier reviews of what
//            looks like the same invoice
// }
//
// Every check belongs to a group:
//   math      always — the invoice against itself
//   backup    always — reimbursable costs and their receipts
//   history   always — whether this invoice has been reviewed before
//   contract  only when a contract or PO was chosen — tax, costs it forbids, the PO number, and
//             whether this invoice takes the total billed past what the agreement is worth
//
// A failed check also carries `figures`, the numbers behind the finding, so the report can show
// them as a small table rather than a sentence.
//
// A finding that comes from the agreement cites where the agreement says it: its rows carry `clause`
// — { section, heading, page, quote } from lib/contractClauses.js — when the agreement's clauses were
// read. Nothing is cited that the agreement does not say.

const { money } = require('./money');
const { forbiddenCosts } = require('./contractClauses');

const LINE_TOL = 0.02;
const AGG_TOL = 1.0;

function close(a, b, tol) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tol;
}

const clausesOf = terms => terms?.clauses || null;

function pass(detail) { return { status: 'PASS', detail }; }
function fail(detail) { return { status: 'FAIL', detail }; }
function skip(detail) { return { status: 'SKIPPED', detail }; }

const CHECKS = [
  // M. Invoice math
  {
    id: 'M1', group: 'math', category: 'Invoice Math', critical: true,
    description: 'Do the line items (plus tax) add up to the invoice total?',
    run: ({ invoice }) => {
      if (invoice.total == null) return skip('Skipped — no invoice total could be read off this document.');
      const items = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.total) || 0), 0);
      const tax = Number(invoice.taxAmount) || 0;
      const built = items + tax;
      if (close(built, invoice.total, AGG_TOL)) {
        return pass(`Yes — the line items (${money(items)})${tax ? ` and tax (${money(tax)})` : ''} add up to the invoice total of ${money(invoice.total)}.`);
      }
      return {
        ...fail(`The line items${tax ? ' and tax' : ''} add up to ${money(built)} (items ${money(items)}${tax ? `, tax ${money(tax)}` : ''}), but the invoice total reads ${money(invoice.total)} — a difference of ${money(invoice.total - built)} that is not explained on the document.`),
        figures: { kind: 'compare', rows: [{ item: 'Invoice total', shown: invoice.total, computed: built, difference: invoice.total - built }] },
      };
    }
  },
  {
    id: 'M2', group: 'math', category: 'Invoice Math', critical: false,
    description: 'Does quantity × unit price match the amount shown for each line?',
    run: ({ invoice }) => {
      const checkable = (invoice.lineItems || []).filter(li => li.qty != null && li.unitPrice != null && li.total != null);
      if (checkable.length === 0) return skip('Skipped — no lines on this invoice show a quantity and unit price to verify.');
      const bad = checkable.filter(li => !close(li.qty * li.unitPrice, li.total, LINE_TOL));
      if (bad.length === 0) return pass(`Yes — for all ${checkable.length} itemized lines, quantity times unit price matches the amount shown.`);
      return {
        ...fail(bad.map(li =>
          `"${li.description}": ${li.qty} × ${money(li.unitPrice)} is ${money(li.qty * li.unitPrice)}, but the invoice shows ${money(li.total)}.`
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
    id: 'M3', group: 'math', category: 'Invoice Math', critical: false,
    description: 'If the invoice prints a subtotal, do the line items add up to it?',
    run: ({ invoice }) => {
      if (invoice.subtotal == null) return skip('Skipped — this invoice does not print a separate subtotal to check.');
      const items = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.total) || 0), 0);
      if (close(items, invoice.subtotal, AGG_TOL)) return pass(`Yes — the line items add up to the printed subtotal of ${money(invoice.subtotal)}.`);
      return {
        ...fail(`The line items add up to ${money(items)}, but the printed subtotal is ${money(invoice.subtotal)} — a difference of ${money(invoice.subtotal - items)}.`),
        figures: { kind: 'compare', rows: [{ item: 'Subtotal', shown: invoice.subtotal, computed: items, difference: invoice.subtotal - items }] },
      };
    }
  },

  // A professional's fee table: each phase's fee × percent complete is what it has earned, and what
  // it has earned less what was billed before is what this invoice may bill. Engineers' and
  // architects' invoices are built this way, and a slip anywhere in a row is money billed early.
  {
    id: 'M4', group: 'math', category: 'Invoice Math', critical: true,
    description: 'Does the fee table add up — fee × percent complete, earned less previously billed, and the current column to the invoice total?',
    run: ({ invoice }) => {
      const phases = (invoice.phases || []).filter(p => p && p.name);
      if (phases.length === 0) return skip('Skipped — this invoice does not bill by phase with a fee table.');
      const rows = [];
      for (const p of phases) {
        if (p.fee != null && p.percentComplete != null && p.earned != null) {
          const should = p.fee * p.percentComplete;
          if (!close(should, p.earned, AGG_TOL)) {
            rows.push({ item: `${p.name} — earned`, working: `${money(p.fee)} × ${Math.round(p.percentComplete * 1000) / 10}%`, shown: p.earned, computed: should, difference: p.earned - should });
          }
        }
        if (p.earned != null && p.previouslyBilled != null && p.current != null) {
          const should = p.earned - p.previouslyBilled;
          if (!close(should, p.current, AGG_TOL)) {
            rows.push({ item: `${p.name} — billed now`, working: `${money(p.earned)} earned − ${money(p.previouslyBilled)} billed before`, shown: p.current, computed: should, difference: p.current - should });
          }
        }
      }
      const currents = phases.filter(p => p.current != null);
      if (currents.length === phases.length && invoice.total != null) {
        const sum = currents.reduce((a, p) => a + p.current, 0) + (Number(invoice.taxAmount) || 0);
        // Only when the fee table is the whole invoice: one with expenses listed beside it adds them.
        const extras = (invoice.lineItems || []).filter(li => li.isReimbursable).reduce((a, li) => a + (Number(li.total) || 0), 0);
        if (!close(sum + extras, invoice.total, AGG_TOL) && !close(sum, invoice.total, AGG_TOL)) {
          rows.push({ item: 'Current billing, all phases', working: 'the "current" column added up', shown: invoice.total, computed: sum + extras, difference: invoice.total - (sum + extras) });
        }
      }
      if (rows.length === 0) return pass(`Yes — every row of the fee table works out, and the current billing adds up to the invoice.`);
      return {
        ...fail(rows.map(r => `${r.item}: ${r.working} is ${money(r.computed)}, but the invoice shows ${money(r.shown)}.`).join(' ')),
        figures: { kind: 'compare', rows },
      };
    }
  },

  // T. Tax
  {
    id: 'T1', group: 'contract', category: 'Tax', critical: true,
    description: 'Is tax being charged on a project the contract says is tax exempt?',
    run: ({ invoice, contractTerms }) => {
      const taxed = (Number(invoice.taxAmount) || 0) > 0 || (Number(invoice.taxRate) || 0) > 0;
      if (!contractTerms) {
        return taxed
          ? fail(`This invoice includes ${invoice.taxAmount ? money(invoice.taxAmount) + ' of' : ''} tax, and no contract is on file to confirm whether that is allowed. Public entities are usually tax exempt — upload the contract, or confirm the tax status before paying.`)
          : skip('Skipped — no tax appears on this invoice and no contract is on file to check against.');
      }
      if (contractTerms.taxExempt === true) {
        return taxed
          ? {
            ...fail(`This invoice includes ${invoice.taxAmount ? money(invoice.taxAmount) + ' of' : ''} tax, but the contract states the project is tax exempt${contractTerms.taxExemptBasis ? ` (${contractTerms.taxExemptBasis})` : ''}. The tax should be removed before this is paid.`),
            figures: {
              kind: 'deviation',
              rows: [{
                item: 'Sales tax charged', amount: Number(invoice.taxAmount) || null, rule: 'The project is tax exempt',
                // The clause, when there is one, says it in the agreement's own words.
                basis: clausesOf(contractTerms)?.tax ? null : (contractTerms.taxExemptBasis || null),
                clause: clausesOf(contractTerms)?.tax || null,
              }],
            },
          }
          : pass('No tax is charged, which matches the contract — this project is tax exempt.');
      }
      if (contractTerms.taxExempt === false) {
        return pass(taxed
          ? 'Tax appears on this invoice, and the contract does not exempt this project from tax.'
          : 'No tax appears on this invoice. The contract does not exempt this project, so confirm whether tax should have been included.');
      }
      return taxed
        ? {
          ...fail(`This invoice includes ${invoice.taxAmount ? money(invoice.taxAmount) + ' of' : ''} tax, and the contract on file does not state the project's tax status. Public entities are usually tax exempt — confirm before paying.`),
          figures: { kind: 'deviation', rows: [{ item: 'Sales tax charged', amount: Number(invoice.taxAmount) || null, rule: 'The contract does not say whether the project is tax exempt — confirm before paying', basis: null }] },
        }
        : skip('Skipped — no tax appears on this invoice, and the contract does not state the tax status either way.');
    }
  },

  // R. Reimbursable backup
  {
    id: 'R1', group: 'backup', category: 'Reimbursable Backup', critical: true,
    description: 'Does every reimbursable (pass-through) cost have a backup receipt or invoice?',
    run: ({ invoice, contractTerms }) => {
      const reimbursable = (invoice.lineItems || []).filter(li => li.isReimbursable === true);
      // Where the agreement asks for backup, the finding cites it; without one this is good practice.
      const rule = clausesOf(contractTerms)?.reimbursables;
      const clause = rule && rule.backupRequired !== false ? rule : null;
      if (reimbursable.length === 0) return skip('Skipped — no reimbursable, cost-plus, or pass-through lines were found on this invoice.');
      const missing = reimbursable.filter(li => li.hasBackup === false);
      if (missing.length === 0) {
        return pass(`Yes — all ${reimbursable.length} reimbursable line${reimbursable.length === 1 ? '' : 's'} on this invoice have a matching backup document among the uploads.`);
      }
      return {
        ...fail(missing.map(li =>
          `"${li.description}"${li.total != null ? ` (${money(li.total)})` : ''} is billed as a reimbursable cost but no backup receipt or invoice was found for it${li.backupNote ? ` — ${li.backupNote}` : ''}. Ask the vendor for the supporting document before paying.`
        ).join(' ')),
        figures: { kind: 'list', rows: missing.map(li => ({ item: li.description, amount: li.total ?? null, note: li.backupNote || null, clause })) },
      };
    }
  },

  // C. Contract's own unallowable items
  {
    id: 'C1', group: 'contract', category: 'Contract Terms', critical: false,
    description: 'Does this invoice bill for anything the contract says may not be billed?',
    run: ({ invoice, contractTerms }) => {
      // The agreement's unallowable items, and the costs its clauses restrict, once each — a cost
      // found in both keeps the clause, which says where it is written.
      const banned = forbiddenCosts(contractTerms);
      if (banned.length === 0) return skip('Skipped — no contract on file, or the contract on file lists no unallowable cost items.');
      const lines = invoice.lineItems || [];
      const wordsOf = b => String(b.item).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
      const lineFor = b => lines.find(li => wordsOf(b).every(w => String(li.description || '').toLowerCase().includes(w)));
      const hay = lines.map(li => li.description || '').join(' \n ').toLowerCase();
      const hits = banned.filter(b => {
        const words = wordsOf(b);
        return words.length > 0 && words.every(w => hay.includes(w));
      });
      if (hits.length === 0) return pass(`Nothing on this invoice matches the ${banned.length} cost item${banned.length === 1 ? '' : 's'} the contract forbids billing for. (This is a wording match — the review notes below take a closer look.)`);
      return {
        ...fail(hits.map(b =>
          `The contract does not allow billing for "${b.item}"${b.basis ? ` (${b.basis})` : ''}, but wording matching it appears on this invoice — verify before paying.`
        ).join(' ')),
        figures: {
          kind: 'deviation',
          rows: hits.map(b => ({
            item: lineFor(b)?.description || b.item,
            amount: typeof lineFor(b)?.total === 'number' ? lineFor(b).total : null,
            // A cost the agreement restricts says how; one it simply lists as unallowable says that.
            rule: b.rule || 'The contract does not allow billing for this',
            basis: b.clause ? null : (b.basis || null), clause: b.clause || null,
          })),
        },
      };
    }
  },

  // P. The purchase order or contract the invoice is billed against
  {
    id: 'PO1', group: 'contract', category: 'Purchase Order', critical: false,
    description: 'Does the PO number on the invoice match the agreement it is checked against?',
    run: ({ invoice, contractTerms }) => {
      // Checked against several agreements, the invoice may cite any of their numbers.
      const numbers = (contractTerms?.commitments?.length ? contractTerms.commitments : [contractTerms?.commitment]).filter(Boolean);
      const onInvoice = normalizeRef(invoice.poNumber);
      const onAgreements = numbers.map(normalizeRef).filter(Boolean);
      if (!onInvoice || onAgreements.length === 0) {
        return skip('Skipped — the invoice or the agreement does not print a PO or commitment number to compare.');
      }
      if (onAgreements.some(a => onInvoice === a || onInvoice.endsWith(a) || a.endsWith(onInvoice))) {
        return pass(`Yes — the invoice cites ${invoice.poNumber}, the number on the agreement it is checked against.`);
      }
      const named = numbers.join(' or ');
      return {
        ...fail(`The invoice cites PO ${invoice.poNumber}, but the agreement it is being checked against is ${named}. Confirm it is billed against the right agreement before paying.`),
        figures: {
          kind: 'deviation',
          rows: [{ item: `PO ${invoice.poNumber} on the invoice`, amount: null, rule: `The agreement chosen is ${named}`, basis: null }],
        },
      };
    }
  },
  {
    id: 'PO2', group: 'contract', category: 'Purchase Order', critical: true,
    description: 'Does this invoice keep the total billed within what the PO or contract is worth?',
    run: ({ invoice, billing, contractTerms }) => {
      if (!billing || !(billing.contractValue > 0)) {
        return skip('Skipped — the agreement does not state a value to measure the billing against.');
      }
      if (invoice.total == null) return skip('Skipped — no invoice total could be read to add to what has been billed.');
      const toDate = (billing.priorBilled || 0) + invoice.total;
      const remaining = billing.contractValue - toDate;
      // Where the billing before this invoice came from: the invoice's own "previously billed",
      // less what an earlier PO covered — or, failing that, the invoices reviewed in Coaster.
      const carried = billing.carriedOver > 0;
      const earlier = billing.source === 'invoice'
        ? `${money(billing.priorBilled)} billed under it before this invoice${carried ? '' : ', as the invoice shows'}`
        : billing.priorCount
          ? `${money(billing.priorBilled)} across ${billing.priorCount} earlier invoice${billing.priorCount === 1 ? '' : 's'} reviewed in Coaster`
          : 'no earlier invoices reviewed in Coaster';
      const carryNote = carried
        ? `This purchase order continues an earlier one: ${money(billing.carriedOver)} of the `
          + `${billing.feeTotal ? `${money(billing.feeTotal)} fee` : 'engagement'} was covered before it`
          + `${billing.carrySource === 'stated' ? ' (as you entered)' : ''}, so only billing after that counts against this PO. `
        : '';
      if (remaining >= -AGG_TOL) {
        return pass(`${carryNote}Yes — with this invoice, ${money(toDate)} of the ${money(billing.contractValue)} agreement has been billed (${earlier}), leaving ${money(remaining)}.`);
      }

      // The invoice says more was billed BEFORE it than this whole PO is worth. This invoice did not
      // cause that, so it is not marked on this invoice's amount or put down as one to resolve: it is
      // a question for the PM. Most often a PO that replaced an expired one, whose earlier share
      // nobody has entered; sometimes a real overrun. Both are said, with the arithmetic for the first.
      // (Invoice 5680, October 2026: $39,000 billed before a $14,800 PO, and the red flag sat on the
      // invoice's own $1,500.)
      const priorAlreadyOver = billing.source === 'invoice' && !carried
        && billing.priorBilled > billing.contractValue + AGG_TOL;
      if (priorAlreadyOver) {
        const earlierShare = billing.feeTotal > billing.contractValue ? billing.feeTotal - billing.contractValue : null;
        const used = earlierShare != null ? billing.priorBilled - earlierShare + invoice.total : null;
        const left = used != null ? billing.contractValue - used : null;
        const ifCarried = earlierShare != null
          ? ` If an earlier PO covered the first ${money(earlierShare)} of the ${money(billing.feeTotal)} fee, `
            + (left >= -AGG_TOL
              ? `${money(used)} of this PO has been used with this invoice and ${money(left)} is left.`
              : `this PO would still be ${money(-left)} over.`)
          : '';
        const summary = `The invoice shows ${money(billing.priorBilled)} billed before it — already more than this `
          + `${money(billing.contractValue)} PO, before this invoice adds ${money(invoice.total)}. That usually means an earlier `
          + `PO paid for part of the work.${ifCarried} If so, enter what the earlier PO covered under "Already paid `
          + 'under an earlier PO" and review the invoice again. If not, this PO has been overrun and needs a change '
          + 'order or an amendment before more is paid.';
        return {
          status: 'FAIL',
          critical: false,
          title: 'Billed before this invoice is more than this PO',
          detail: summary,
          figures: {
            kind: 'billing',
            summary,
            // Where the mark goes on the invoice: its "previous billing", not this invoice's amount.
            markOn: 'prior',
            rows: [
              { item: 'Agreement value', amount: billing.contractValue, clause: clausesOf(contractTerms)?.contractSum || null },
              { item: 'Billed before this invoice, as the invoice shows', amount: billing.priorBilled, emphasis: true },
              { item: 'This invoice', amount: invoice.total },
              ...(earlierShare != null ? [
                { item: 'Total fee on the invoice', amount: billing.feeTotal },
                { item: `If an earlier PO covered the first ${money(earlierShare)}: used under this PO`, amount: used },
                ...(left >= -AGG_TOL ? [{ item: '…and left on this PO', amount: left }] : []),
              ] : []),
            ],
          },
        };
      }
      return {
        ...fail(`${carryNote}With this invoice, ${money(toDate)} has been billed against an agreement worth ${money(billing.contractValue)} (${earlier}) — ${money(-remaining)} more than it allows. A change order or an amended PO is needed before this is paid.`
          // The fee is bigger than this PO and nothing said why: the likeliest innocent reason is a PO
          // that replaced an earlier one, and the PM can say so.
          + (!carried && billing.feeTotal > billing.contractValue
            ? ` If an earlier purchase order covered part of the ${money(billing.feeTotal)} fee, enter what it covered under "Already paid under an earlier PO" and review the invoice again.`
            : '')),
        figures: {
          kind: 'billing',
          rows: [
            // The agreement's own statement of what it is worth, where its clauses were read.
            { item: 'Agreement value', amount: billing.contractValue, clause: clausesOf(contractTerms)?.contractSum || null },
            ...(carried ? [{ item: 'Covered by an earlier PO (not counted here)', amount: billing.carriedOver }] : []),
            { item: billing.source === 'invoice'
              ? 'Billed under this agreement before this invoice'
              : `Billed before this invoice${billing.priorCount ? ` (${billing.priorCount} reviewed in Coaster)` : ''}`, amount: billing.priorBilled || 0 },
            { item: 'This invoice', amount: invoice.total },
            { item: 'Over the agreement by', amount: -remaining, emphasis: true },
          ],
        },
      };
    }
  },

  // H. This invoice against the ones already reviewed
  {
    id: 'D1', group: 'history', category: 'Duplicates', critical: true,
    description: 'Has this invoice already been reviewed?',
    run: ({ duplicates }) => {
      const found = duplicates || [];
      if (found.length === 0) return pass('No earlier review in Coaster matches this invoice\'s number, or its vendor, date and total.');
      return {
        ...fail(found.map(d =>
          `Invoice ${d.invoiceNumber || '(no number)'} for ${money(d.total)}${d.invoiceDate ? ` dated ${d.invoiceDate}` : ''} was already reviewed on ${d.reviewedOn}. Confirm this is not the same bill sent twice before paying it.`
        ).join(' ')),
        figures: {
          kind: 'list',
          rows: found.map(d => ({
            item: `Invoice ${d.invoiceNumber || '(no number)'}${d.invoiceDate ? `, dated ${d.invoiceDate}` : ''}`,
            amount: d.total, note: `Reviewed on ${d.reviewedOn}`,
          })),
        },
      };
    }
  },
];

// What has been billed under THIS agreement before this invoice, for the billing check.
//
// A professional's invoice carries the engagement's whole history — the total fee and everything
// billed before — and when a purchase order has replaced an expired one, part of that history was
// billed under the old one. Counting it against the new PO reports an overrun that is not there.
//
// So the earlier PO's share is taken off first: the amount the PM entered, or — only where the PO
// itself says it continues an earlier one — the fee less this PO's value. Never assumed from the
// numbers alone: a fee larger than the PO with nothing saying why may be exactly the overrun this
// check exists to catch.
//
// value: what this agreement is worth. history: { priorBilled, priorCount } from invoices reviewed
// in Coaster against it. earlierPaid: what the PM said an earlier PO covered, or null. continues:
// whether the PO says it continues an earlier one.
function billingFor({ value, invoice, history = { priorBilled: 0, priorCount: 0 }, earlierPaid = null, continues = false }) {
  if (!(value > 0)) return null;
  const prev = typeof invoice.previouslyBilled === 'number' && invoice.previouslyBilled >= 0 ? invoice.previouslyBilled : null;
  const fee = typeof invoice.feeTotal === 'number' && invoice.feeTotal > 0 ? invoice.feeTotal : null;
  let carriedOver = 0;
  let carrySource = null;
  if (earlierPaid > 0) {
    carriedOver = earlierPaid;
    carrySource = 'stated';
  } else if (continues && fee && prev != null && fee > value + AGG_TOL) {
    carriedOver = Math.min(fee - value, prev);
    carrySource = 'worked out';
  }
  const base = { contractValue: value, priorCount: history.priorCount || 0, carriedOver, carrySource, feeTotal: fee };
  // The invoice's own record of what came before, less the earlier PO's share — unless the invoices
  // reviewed in Coaster against this agreement come to more, which the invoice cannot talk down.
  if (prev != null) {
    const underThis = Math.max(0, prev - carriedOver);
    if (underThis >= (history.priorBilled || 0)) return { ...base, priorBilled: underThis, source: 'invoice' };
  }
  return { ...base, priorBilled: history.priorBilled || 0, source: 'coaster', carriedOver: prev != null ? carriedOver : 0 };
}

// "PO-253016-004", "253016 004" and "#253016-004" are the same number.
function normalizeRef(value) {
  return String(value || '').toUpperCase().replace(/^(PO|P\.O\.|NO\.?|#)\s*/, '').replace(/[^A-Z0-9]/g, '');
}

// `groups` is which groups to run. Left out, every group runs.
function runInvoiceChecks(data, { groups = ['math', 'backup', 'history', 'contract'] } = {}) {
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

module.exports = { runInvoiceChecks, normalizeRef, billingFor };
