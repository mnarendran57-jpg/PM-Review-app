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
//   contractTerms: { taxExempt, taxExemptBasis, unallowableItems[], ... } | null
// }

const { money } = require('./payAppChecks');

const LINE_TOL = 0.02;
const AGG_TOL = 1.0;

function close(a, b, tol) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tol;
}

function pass(detail) { return { status: 'PASS', detail }; }
function fail(detail) { return { status: 'FAIL', detail }; }
function skip(detail) { return { status: 'SKIPPED', detail }; }

const CHECKS = [
  // M. Invoice math
  {
    id: 'M1', category: 'Invoice Math', critical: true,
    description: 'Do the line items (plus tax) add up to the invoice total?',
    run: ({ invoice }) => {
      if (invoice.total == null) return skip('Skipped — no invoice total could be read off this document.');
      const items = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.total) || 0), 0);
      const tax = Number(invoice.taxAmount) || 0;
      const built = items + tax;
      if (close(built, invoice.total, AGG_TOL)) {
        return pass(`Yes — the line items (${money(items)})${tax ? ` and tax (${money(tax)})` : ''} add up to the invoice total of ${money(invoice.total)}.`);
      }
      return fail(`The line items${tax ? ' and tax' : ''} add up to ${money(built)} (items ${money(items)}${tax ? `, tax ${money(tax)}` : ''}), but the invoice total reads ${money(invoice.total)} — a difference of ${money(invoice.total - built)} that is not explained on the document.`);
    }
  },
  {
    id: 'M2', category: 'Invoice Math', critical: false,
    description: 'Does quantity × unit price match the amount shown for each line?',
    run: ({ invoice }) => {
      const checkable = (invoice.lineItems || []).filter(li => li.qty != null && li.unitPrice != null && li.total != null);
      if (checkable.length === 0) return skip('Skipped — no lines on this invoice show a quantity and unit price to verify.');
      const bad = checkable.filter(li => !close(li.qty * li.unitPrice, li.total, LINE_TOL));
      if (bad.length === 0) return pass(`Yes — for all ${checkable.length} itemized lines, quantity times unit price matches the amount shown.`);
      return fail(bad.map(li =>
        `"${li.description}": ${li.qty} × ${money(li.unitPrice)} is ${money(li.qty * li.unitPrice)}, but the invoice shows ${money(li.total)}.`
      ).join(' '));
    }
  },
  {
    id: 'M3', category: 'Invoice Math', critical: false,
    description: 'If the invoice prints a subtotal, do the line items add up to it?',
    run: ({ invoice }) => {
      if (invoice.subtotal == null) return skip('Skipped — this invoice does not print a separate subtotal to check.');
      const items = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.total) || 0), 0);
      if (close(items, invoice.subtotal, AGG_TOL)) return pass(`Yes — the line items add up to the printed subtotal of ${money(invoice.subtotal)}.`);
      return fail(`The line items add up to ${money(items)}, but the printed subtotal is ${money(invoice.subtotal)} — a difference of ${money(invoice.subtotal - items)}.`);
    }
  },

  // T. Tax
  {
    id: 'T1', category: 'Tax', critical: true,
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
          ? fail(`This invoice includes ${invoice.taxAmount ? money(invoice.taxAmount) + ' of' : ''} tax, but the contract states the project is tax exempt${contractTerms.taxExemptBasis ? ` (${contractTerms.taxExemptBasis})` : ''}. The tax should be removed before this is paid.`)
          : pass('No tax is charged, which matches the contract — this project is tax exempt.');
      }
      if (contractTerms.taxExempt === false) {
        return pass(taxed
          ? 'Tax appears on this invoice, and the contract does not exempt this project from tax.'
          : 'No tax appears on this invoice. The contract does not exempt this project, so confirm whether tax should have been included.');
      }
      return taxed
        ? fail(`This invoice includes ${invoice.taxAmount ? money(invoice.taxAmount) + ' of' : ''} tax, and the contract on file does not state the project's tax status. Public entities are usually tax exempt — confirm before paying.`)
        : skip('Skipped — no tax appears on this invoice, and the contract does not state the tax status either way.');
    }
  },

  // R. Reimbursable backup
  {
    id: 'R1', category: 'Reimbursable Backup', critical: true,
    description: 'Does every reimbursable (pass-through) cost have a backup receipt or invoice?',
    run: ({ invoice }) => {
      const reimbursable = (invoice.lineItems || []).filter(li => li.isReimbursable === true);
      if (reimbursable.length === 0) return skip('Skipped — no reimbursable, cost-plus, or pass-through lines were found on this invoice.');
      const missing = reimbursable.filter(li => li.hasBackup === false);
      if (missing.length === 0) {
        return pass(`Yes — all ${reimbursable.length} reimbursable line${reimbursable.length === 1 ? '' : 's'} on this invoice have a matching backup document among the uploads.`);
      }
      return fail(missing.map(li =>
        `"${li.description}"${li.total != null ? ` (${money(li.total)})` : ''} is billed as a reimbursable cost but no backup receipt or invoice was found for it${li.backupNote ? ` — ${li.backupNote}` : ''}. Ask the vendor for the supporting document before paying.`
      ).join(' '));
    }
  },

  // C. Contract's own unallowable items
  {
    id: 'C1', category: 'Contract Terms', critical: false,
    description: 'Does this invoice bill for anything the contract says may not be billed?',
    run: ({ invoice, contractTerms }) => {
      const banned = contractTerms?.unallowableItems || [];
      if (banned.length === 0) return skip('Skipped — no contract on file, or the contract on file lists no unallowable cost items.');
      const hay = (invoice.lineItems || []).map(li => li.description || '').join(' \n ').toLowerCase();
      const hits = banned.filter(b => {
        const words = String(b.item).toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return words.length > 0 && words.every(w => hay.includes(w));
      });
      if (hits.length === 0) return pass(`Nothing on this invoice matches the ${banned.length} cost item${banned.length === 1 ? '' : 's'} the contract forbids billing for. (This is a wording match — the review notes below take a closer look.)`);
      return fail(hits.map(b =>
        `The contract does not allow billing for "${b.item}"${b.basis ? ` (${b.basis})` : ''}, but wording matching it appears on this invoice — verify before paying.`
      ).join(' '));
    }
  },
];

function runInvoiceChecks(data) {
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

module.exports = { runInvoiceChecks };
