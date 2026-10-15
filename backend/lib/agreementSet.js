// Several agreements read as one, for an invoice checked against more than one of them.
//
// A job is often governed by a contract AND a purchase order: the contract says how the work may be
// billed — tax, what is not reimbursable, the rates — and the PO says how much has been set aside for
// it. An invoice is checked against both, and each finding cites the document it comes from.
//
// How the terms combine:
//   tax          exempt if any agreement says so, citing that one — a PO silent on tax does not
//                undo the contract's exemption
//   forbidden    every agreement's forbidden and restricted costs, together
//   PO number    the invoice may cite any of the agreements' numbers
//   value        the PO's, where one states a value — the PO is the money set aside — else the
//                first agreement that states one
//   the rest     reimbursables, rates and markups from the first agreement that addresses them
//
// Each clause carries `source`, the document it is quoted from, when there is more than one — so a
// citation says "PO 253016-004 · Section 4.2" and not just "Section 4.2" of which document.

const looksLikePo = a => a.docType === 'purchase-order'
  || /\bP\.?\s?O\.?\b|purchase\s+order/i.test(a.label || '');

// agreements: [{ id, label, docType, terms }] in the order chosen, each terms as read (with clauses).
// Returns { terms, valueFrom } — the combined terms, and the agreement whose value is used (for what
// has been billed against it before), or null.
function combineAgreements(agreements) {
  const list = (agreements || []).filter(a => a && a.terms);
  if (list.length === 0) return { terms: null, valueFrom: null };
  if (list.length === 1) {
    const only = list[0];
    const value = Number(only.terms.originalContractSum) || Number(only.terms.clauses?.contractSum?.amount) || 0;
    return { terms: only.terms, valueFrom: value > 0 ? only : null };
  }

  const tag = (clause, a) => (clause ? { ...clause, source: a.label } : null);
  const firstWith = pick => {
    for (const a of list) {
      const v = pick(a);
      if (v) return tag(v, a);
    }
    return null;
  };

  const exempt = list.find(a => a.terms.taxExempt === true);
  const notExempt = list.find(a => a.terms.taxExempt === false);
  const taxFrom = exempt || notExempt || null;

  const valueOf = a => Number(a.terms.originalContractSum) || Number(a.terms.clauses?.contractSum?.amount) || 0;
  const valueFrom = list.find(a => looksLikePo(a) && valueOf(a) > 0) || list.find(a => valueOf(a) > 0) || null;

  const commitments = list.map(a => a.terms.commitment).filter(Boolean);

  const terms = {
    taxExempt: exempt ? true : notExempt ? false : null,
    taxExemptBasis: taxFrom?.terms.taxExemptBasis || null,
    unallowableItems: list.flatMap(a => (a.terms.unallowableItems || []).map(i => ({ ...i, source: a.label }))),
    commitment: (list.find(looksLikePo)?.terms.commitment) || commitments[0] || null,
    commitments,
    originalContractSum: valueFrom ? valueOf(valueFrom) : null,
    clauses: {
      tax: taxFrom ? tag(taxFrom.terms.clauses?.tax, taxFrom) : firstWith(a => a.terms.clauses?.tax),
      contractSum: valueFrom ? tag(valueFrom.terms.clauses?.contractSum, valueFrom) : null,
      reimbursables: firstWith(a => a.terms.clauses?.reimbursables),
      rates: firstWith(a => a.terms.clauses?.rates),
      markups: firstWith(a => a.terms.clauses?.markups),
      allowances: firstWith(a => a.terms.clauses?.allowances),
      costRules: list.flatMap(a => (a.terms.clauses?.costRules || []).map(c => tag(c, a))),
    },
    // Which documents these are, for the reading that looks for costs they forbid.
    agreements: list.map(a => ({ label: a.label, kind: looksLikePo(a) ? 'purchase order' : 'contract' })),
  };
  return { terms, valueFrom };
}

module.exports = { combineAgreements, looksLikePo };
