// Several agreements read as one, for an invoice or change order checked against more than one.
//
// A job is often governed by a contract AND a purchase order: the contract says how the work may be
// billed and priced — tax, what is not reimbursable, the rates, the markup limits — and the PO says how
// much has been set aside for it. A review is checked against both, and each finding cites the
// document it comes from.
//
// How the terms combine:
//   tax          exempt if any agreement says so, citing that one — a PO silent on tax does not
//                undo the contract's exemption
//   forbidden    every agreement's forbidden and restricted costs, together
//   PO number    an invoice may cite any of the agreements' numbers
//   value        the PO's, where one states a value — the PO is the money set aside — else the
//                first agreement that states one
//   the rest     reimbursables, rates, markup limits and allowances from the first agreement, in
//                the order chosen, that addresses them
//   continues    whether a PO says it revises or continues an earlier one, for the billing check
//
// Costs not allowed — the rules a line on an invoice or change order is matched against — come from
// contracts only, never from purchase orders (Naren, October 2026). A PO's conditions are general:
// that billing must match the PO, that it may not exceed the PO total. Matched word by word against
// the lines they put red flags on ordinary billing for the very services the PO is for. The PO's
// total is checked as a total, by the billing check.
//
// Each clause carries `source`, the document it is quoted from, when there is more than one — so a
// citation says "PO 253016-004 · Section 4.2" and not just "Section 4.2" of which document.

const { ensureTermsWithClauses } = require('./contractTerms');
const { extractContractTerms } = require('./contractExtract');
const { readContractClauses } = require('./contractClauses');

// Filed as a purchase order; or named as one — "PO 253016", "…_CEG_PO R000136351…" (an underscore
// counts as a separator, which a word boundary does not); or describing itself as one in its own
// wording, which a PO's terms nearly always do ("the total purchase order amount").
const PO_IN_NAME = /(?:^|[^a-z0-9])p\.?\s?o\.?(?:[^a-z]|$)|purchase\s*order/i;
const looksLikePo = a => a.docType === 'purchase-order'
  || PO_IN_NAME.test(a.label || '')
  || (a.docType !== 'contract' && /purchase\s+order/i.test(Object.values(a.terms?.clauses || {})
    .filter(c => c && !Array.isArray(c) && typeof c === 'object').map(c => c.quote || '').join(' ')));

// agreements: [{ id, label, docType, terms }] in the order chosen, each terms as read (with clauses).
// Returns { terms, valueFrom } — the combined terms, and the agreement whose value is used (for what
// has been billed against it before), or null.
// A PO's terms with its cost rules set aside — see above.
function withoutPoCostRules(a) {
  if (!looksLikePo(a)) return a;
  const clauses = a.terms.clauses ? { ...a.terms.clauses, costRules: [] } : a.terms.clauses;
  return { ...a, terms: { ...a.terms, unallowableItems: [], clauses } };
}

function combineAgreements(agreements) {
  const list = (agreements || []).filter(a => a && a.terms).map(withoutPoCostRules);
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
      earlierAgreement: firstWith(a => a.terms.clauses?.earlierAgreement),
      costRules: list.flatMap(a => (a.terms.clauses?.costRules || []).map(c => tag(c, a))),
    },
    // Which documents these are, for the reading that looks for costs they forbid.
    agreements: list.map(a => ({ label: a.label, kind: looksLikePo(a) ? 'purchase order' : 'contract' })),
  };
  return { terms, valueFrom };
}

// Reads every agreement a review was asked to check against, all at once — each is independent of
// the others. Filed ones (`rows`, project_contracts rows) are read on first use and the reading kept;
// uploaded ones (`files`, multer files) are read now and not kept, because keeping one is what saving
// it to Shared Documents is for. Either way each comes with where its rules are written, so a finding
// can cite it. Returns combineAgreements' answer.
async function readAgreements({ rows = [], files = [] }) {
  const readUploaded = async f => {
    const [{ usage, ...terms }, clauses] = await Promise.all([
      extractContractTerms(f.buffer),
      readContractClauses(f.buffer).then(r => r.clauses).catch(err => {
        console.error('[contract clauses] uploaded contract failed:', err.message);
        return null;
      }),
    ]);
    return { ...terms, clauses };
  };
  const agreements = await Promise.all([
    ...rows.map(async r => ({ id: r.id, label: r.label || r.file_name, docType: r.doc_type, terms: await ensureTermsWithClauses(r) })),
    ...files.map(async f => ({ id: null, label: labelOf(f), docType: null, terms: await readUploaded(f) })),
  ]);
  return combineAgreements(agreements);
}

// What an uploaded agreement is called in the report: its file name, without ".pdf".
const labelOf = f => String(f.originalname || 'Uploaded agreement').replace(/\.pdf$/i, '');

// What the agreements together are called in a report heading.
const labelAll = ({ rows = [], files = [] }) => {
  const labels = [...rows.map(r => r.label || r.file_name), ...files.map(labelOf)];
  return labels.length ? labels.join(' + ') : null;
};

module.exports = { combineAgreements, readAgreements, labelAll, looksLikePo };
