const { money } = require('./money');

// Every check that is arithmetic rather than judgement.
//
// WHY NONE OF THIS ASKS THE MODEL
//
// Recomputing Lines 1-9 and reconciling a schedule of values is addition. A language model does
// addition well enough to be convincing and not well enough to be relied on, and the failure is
// silent: a total that is $400 out reads exactly like a total that ties. Worse, it is not stable —
// the same packet checked twice can produce two different answers, which is the one thing a
// document that gets attached to a payment decision cannot do.
//
// So the model transcribes (cmarRead.js) and this file decides. Every figure below is compared
// against a figure printed on the form, the comparison is a subtraction, and the same packet always
// produces the same findings.
//
// ROUNDING VERSUS ERROR
//
// AIA forms carry cents, and a spreadsheet that rounds each row can land a dollar or two away from
// a total without anything being wrong. A mismatch inside ROUNDING_TOLERANCE is reported as
// something worth noting; past it, it is an issue. Both are reported — a silently swallowed
// discrepancy is how a real error gets filed as a rounding artifact.

const ROUNDING_TOLERANCE = 1;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const has = v => num(v) !== null;
const diff = (a, b) => Math.round((a - b) * 100) / 100;
const near = (a, b, tol = ROUNDING_TOLERANCE) => Math.abs(diff(a, b)) <= tol;

// Statuses a finding can carry. `unknown` is a real answer and is used whenever the packet did not
// carry what the check needed — never silently dropped, because "we could not check this" is
// information the person certifying payment needs.
const PASS = 'pass';
const FAIL = 'fail';
const NOTE = 'note';
const UNKNOWN = 'unknown';

const finding = (section, title, status, detail, extra = {}) =>
  ({ section, title, status, detail, ...extra });

// A stated figure against a computed one, which is most of this file.
function compare({ section, title, stated, computed, formula, amountLabel = 'Difference' }) {
  if (!has(stated) || !has(computed)) {
    return finding(section, title, UNKNOWN,
      `Could not be checked — ${!has(stated) ? 'the form does not state this figure' : 'the figures it is built from are not all on the form'}.`);
  }
  const delta = diff(stated, computed);
  if (delta === 0) {
    return finding(section, title, PASS, `${formula} — ${money(stated)}, as stated.`);
  }
  const status = Math.abs(delta) <= ROUNDING_TOLERANCE ? NOTE : FAIL;
  return finding(section, title, status,
    `The form states ${money(stated)}. ${formula} gives ${money(computed)}. `
    + `${amountLabel}: ${money(Math.abs(delta))}${delta > 0 ? ' overstated' : ' understated'}.`,
    { amount: Math.abs(delta), stated, computed });
}

// Work rows only. A subtotal row counted as work doubles the schedule of values, and that is the
// single most common way a reconciliation comes out wrong for a reason that is not a real finding.
const workRows = rows => (Array.isArray(rows) ? rows : []).filter(r => r && !r.isSubtotal);

// The rows a subcontractor's billing can be matched to, in one fixed order.
//
// Both the prompt and the reconciliation index into THIS list, so an index means the same row on
// both sides. They did not agree before: the prompt numbered every work row but printed only the
// active ones, so the model saw brackets like [0] [2] [7] and matched by position in what it could
// see. Sendero came back matched to a GreenScape row. One list, built once, removes the whole
// class of error.
const matchableRows = rows => workRows(rows)
  .filter(r => (typeof r.thisPeriod === 'number' && r.thisPeriod)
    || (typeof r.completedToDate === 'number' && r.completedToDate));

const sumOf = (rows, field) => workRows(rows)
  .reduce((total, r) => (has(r[field]) ? total + r[field] : total), 0);

// --- The nine lines ------------------------------------------------------------------------

// Recomputes a G702 from its own parts. Used for the GC's certificate and for every
// subcontractor's, because it is the same form and the same arithmetic.
function certificateChecks(cert, { section, sovRows = null, label = 'The application' } = {}) {
  const out = [];
  if (!cert) return out;

  const l = key => num(cert[key]);

  out.push(compare({
    section,
    title: 'Line 3 — Contract Sum to Date',
    stated: l('line3ContractSumToDate'),
    computed: has(l('line1OriginalContractSum')) && has(l('line2NetChangeByChangeOrders'))
      ? l('line1OriginalContractSum') + l('line2NetChangeByChangeOrders') : null,
    formula: 'Line 1 plus Line 2',
  }));

  // 5a and 5b only when the form broke them out; many forms state Line 5 alone.
  if (has(l('line5aCompletedWork')) || has(l('line5bStoredMaterial'))) {
    out.push(compare({
      section,
      title: 'Line 5 — Total Retainage',
      stated: l('line5Retainage'),
      computed: (l('line5aCompletedWork') || 0) + (l('line5bStoredMaterial') || 0),
      formula: 'Line 5a plus Line 5b',
    }));
  }

  out.push(compare({
    section,
    title: 'Line 6 — Total Earned Less Retainage',
    stated: l('line6TotalEarnedLessRetainage'),
    computed: has(l('line4CompletedAndStoredToDate')) && has(l('line5Retainage'))
      ? l('line4CompletedAndStoredToDate') - l('line5Retainage') : null,
    formula: 'Line 4 less Line 5',
  }));

  out.push(compare({
    section,
    title: 'Line 8 — Current Payment Due',
    stated: l('line8CurrentPaymentDue'),
    computed: has(l('line6TotalEarnedLessRetainage')) && has(l('line7LessPreviousCertificates'))
      ? l('line6TotalEarnedLessRetainage') - l('line7LessPreviousCertificates') : null,
    formula: 'Line 6 less Line 7',
  }));

  out.push(compare({
    section,
    title: 'Line 9 — Balance to Finish',
    stated: l('line9BalanceToFinish'),
    computed: has(l('line3ContractSumToDate')) && has(l('line6TotalEarnedLessRetainage'))
      ? l('line3ContractSumToDate') - l('line6TotalEarnedLessRetainage') : null,
    formula: 'Line 3 less Line 6',
  }));

  if (sovRows && workRows(sovRows).length) {
    // The two reconciliations that prove the summary page is actually built from the detail rather
    // than merely self-consistent.
    out.push(compare({
      section,
      title: 'Schedule of values totals to the Contract Sum',
      stated: l('line3ContractSumToDate'),
      computed: sumOf(sovRows, 'scheduledValue'),
      formula: `The scheduled value of all ${workRows(sovRows).length} work items added up`,
      amountLabel: 'Unallocated',
    }));

    out.push(compare({
      section,
      title: 'Schedule of values totals to work completed',
      stated: l('line4CompletedAndStoredToDate'),
      computed: sumOf(sovRows, 'completedToDate'),
      formula: 'Completed-to-date across all work items added up',
    }));

    // Column G should be D + E + F on every row. A row that fails this is where a reconciliation
    // that is out by an odd amount usually comes from, and naming the row saves the hunt.
    const badRows = workRows(sovRows).filter(r => (
      has(r.completedToDate)
      && (has(r.previousApplications) || has(r.thisPeriod) || has(r.storedMaterials))
      && !near(r.completedToDate,
        (r.previousApplications || 0) + (r.thisPeriod || 0) + (r.storedMaterials || 0))
    ));
    out.push(badRows.length
      ? finding(section, 'Every schedule-of-values row adds up across its columns', FAIL,
        `${badRows.length} row${badRows.length === 1 ? '' : 's'} do not: `
        + badRows.slice(0, 6).map(r => `"${r.description}" (states ${money(r.completedToDate)}, `
          + `columns give ${money((r.previousApplications || 0) + (r.thisPeriod || 0) + (r.storedMaterials || 0))})`).join('; ')
        + (badRows.length > 6 ? `, and ${badRows.length - 6} more.` : '.'),
        { rows: badRows.map(r => r.description) })
      : finding(section, 'Every schedule-of-values row adds up across its columns', PASS,
        `All ${workRows(sovRows).length} rows: previous plus this period plus stored equals completed to date.`));
  }

  return out.map(f => ({ ...f, subject: label }));
}

// --- What was already paid ------------------------------------------------------------------

function previousPaymentChecks(packet) {
  const section = 'previous';
  const cert = packet.certificate || {};
  const out = [];

  const line7 = num(cert.line7LessPreviousCertificates);
  const priorLine6 = num(packet.priorApplication?.line6TotalEarnedLessRetainage);

  if (has(priorLine6)) {
    // The strongest form of this check: against the prior period's own certificate.
    out.push(compare({
      section,
      title: 'Line 7 carries forward from the previous application',
      stated: line7,
      computed: priorLine6,
      formula: `The previous application (No. ${packet.priorApplication?.applicationNumber || 'unnumbered'}) certified Line 6 of`,
    }));
  } else {
    // Fall back to the continuation sheet, and say which check was possible.
    const previousFromSov = sumOf(packet.sovRows, 'previousApplications');
    const rate = num(packet.retainagePercent);
    const expected = has(rate) ? previousFromSov * (1 - rate / 100) : null;
    out.push(has(expected)
      ? compare({
        section,
        title: 'Line 7 matches previous billing less retainage',
        stated: line7,
        computed: expected,
        formula: `Previous applications on the continuation sheet (${money(previousFromSov)}) less ${rate}% retainage`,
      })
      : finding(section, 'Line 7 matches previous billing less retainage', UNKNOWN,
        'The previous period\'s certificate is not in the packet and the forms do not state a '
        + 'retainage rate, so Line 7 could only be taken as given. Attach the prior application to close this.'));
  }

  return out;
}

// --- Retainage ----------------------------------------------------------------------------

function retainageChecks(packet, terms) {
  const section = 'retainage';
  const out = [];
  const cert = packet.certificate || {};
  const line4 = num(cert.line4CompletedAndStoredToDate);
  const line5 = num(cert.line5Retainage);
  const contractRate = num(terms?.retainagePercent);
  const statedRate = num(packet.retainagePercent);

  const impliedRate = has(line4) && has(line5) && line4 !== 0
    ? Math.round((line5 / line4) * 10000) / 100
    : null;

  if (has(contractRate) && has(impliedRate)) {
    out.push(Math.abs(impliedRate - contractRate) <= 0.05
      ? finding(section, 'Retainage is held at the contracted rate', PASS,
        `${money(line5)} against ${money(line4)} completed is ${impliedRate}%, which matches the `
        + `${contractRate}% the contract requires${terms.retainageClause ? ` (${terms.retainageClause})` : ''}.`)
      : finding(section, 'Retainage is held at the contracted rate', FAIL,
        `The contract requires ${contractRate}%${terms.retainageClause ? ` (${terms.retainageClause})` : ''}, `
        + `but ${money(line5)} against ${money(line4)} completed is ${impliedRate}%. `
        + `At the contracted rate, retainage would be ${money(line4 * contractRate / 100)} — `
        + `a difference of ${money(Math.abs(line4 * contractRate / 100 - line5))}.`,
        { amount: Math.abs(line4 * contractRate / 100 - line5) }));
  } else if (has(impliedRate)) {
    out.push(finding(section, 'Retainage is held at the contracted rate', UNKNOWN,
      `The application holds ${money(line5)} against ${money(line4)} completed, which is ${impliedRate}%. `
      + 'The contract on file does not state a retainage rate, so this could only be checked for '
      + 'internal consistency, not against a contracted rate.'
      + (has(statedRate) ? ` The forms themselves state ${statedRate}%.` : '')));
  }

  // A sub held at a higher rate than the owner holds from the GC is the GC financing itself with
  // subcontractor money. Worth flagging even where the contract is silent, because it is the norm.
  const gcRate = has(contractRate) ? contractRate : impliedRate;
  const overheld = (packet.subApplications || [])
    .map(sub => {
      const subLine4 = num(sub.certificate?.line4CompletedAndStoredToDate);
      const subLine5 = num(sub.certificate?.line5Retainage);
      const rate = has(sub.retainagePercent) ? num(sub.retainagePercent)
        : (has(subLine4) && has(subLine5) && subLine4 !== 0
          ? Math.round((subLine5 / subLine4) * 10000) / 100 : null);
      return { firm: sub.firmName, rate };
    })
    .filter(s => has(s.rate) && has(gcRate) && s.rate - gcRate > 0.05);

  if (has(gcRate) && (packet.subApplications || []).length) {
    out.push(overheld.length
      ? finding(section, 'No subcontractor is held at a higher retainage than the owner holds', FAIL,
        `The owner holds ${gcRate}% from the contractor, but `
        + overheld.map(s => `${s.firm} is held at ${s.rate}%`).join(', ') + '.',
        { firms: overheld.map(s => s.firm) })
      : finding(section, 'No subcontractor is held at a higher retainage than the owner holds', PASS,
        `Every subcontractor is held at ${gcRate}% or less.`));
  }

  return out;
}

// --- Dates and numbering --------------------------------------------------------------------

// Dates on these forms are written every way a person can write a date. Anything ambiguous is
// treated as unreadable rather than guessed at — a date comparison built on a misparse produces a
// confident finding about nothing.
function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slash) {
    const year = Number(slash[3]) < 100 ? 2000 + Number(slash[3]) : Number(slash[3]);
    return new Date(year, Number(slash[1]) - 1, Number(slash[2]));
  }
  const named = Date.parse(text);
  return Number.isNaN(named) ? null : new Date(named);
}

const dayBefore = (a, b) => a && b && a.getTime() < b.setHours(0, 0, 0, 0);

function dateChecks(packet) {
  const section = 'dates';
  const out = [];

  // A certification signed before the period it certifies. Easy to skip because it looks like a
  // formality; it is a contractor certifying work that had not happened when they signed.
  const early = [];
  const check = (cert, who) => {
    const signed = parseDate(cert?.certifiedDate);
    const periodTo = parseDate(cert?.periodTo);
    if (signed && periodTo && dayBefore(signed, new Date(periodTo))) {
      early.push({ who, signed: cert.certifiedDate, periodTo: cert.periodTo });
    }
  };
  check(packet.certificate, packet.contractorName || 'The contractor');
  (packet.subApplications || []).forEach(sub => check(sub.certificate, sub.firmName));

  if (early.length) {
    out.push(finding(section, 'No application is certified before the period it covers', FAIL,
      early.map(e => `${e.who} certified work through ${e.periodTo} with a signature dated ${e.signed}`).join('; ') + '.',
      { firms: early.map(e => e.who) }));
  } else {
    out.push(finding(section, 'No application is certified before the period it covers', PASS,
      'Every signed certification is dated on or after the end of the period it covers.'));
  }

  // The application number should be the same on every form in the packet.
  const gcNumber = String(packet.certificate?.applicationNumber || '').trim();
  const mismatched = (packet.subApplications || [])
    .filter(s => {
      const n = String(s.certificate?.applicationNumber || '').trim();
      return n && gcNumber && n !== gcNumber;
    })
    .map(s => `${s.firmName} (No. ${s.certificate.applicationNumber})`);

  if (!gcNumber) {
    out.push(finding(section, 'The application number is consistent across the packet', UNKNOWN,
      'No application number could be read off the contractor\'s certificate.'));
  } else if (mismatched.length) {
    out.push(finding(section, 'The application number is consistent across the packet', NOTE,
      `The contractor's application is No. ${gcNumber}, but ${mismatched.join(', ')} carry a different `
      + 'number. Subcontractors often number their own applications independently, so this is worth '
      + 'confirming rather than assuming wrong.',
      { firms: mismatched }));
  } else {
    out.push(finding(section, 'The application number is consistent across the packet', PASS,
      `Application No. ${gcNumber} throughout.`));
  }

  return out;
}

// --- Notarization ---------------------------------------------------------------------------

function notaryChecks(packet) {
  const section = 'notary';
  const n = packet.notary;
  if (!n) {
    return [finding(section, 'The contractor\'s certificate is properly notarized', UNKNOWN,
      'No notary block could be located on the certificate.')];
  }

  const problems = [];
  if (n.signaturePresent === false) problems.push('no contractor signature is visible');
  if (n.notaryStampPresent === false) problems.push('no notary stamp or seal is visible');
  if (n.notarySignaturePresent === false) problems.push('the notary has not signed');

  const signed = parseDate(n.notarySignedDate);
  const certified = parseDate(packet.certificate?.certifiedDate);
  const expiry = parseDate(n.commissionExpiryDate);

  if (signed && certified && dayBefore(new Date(certified), new Date(signed))) {
    problems.push(`the notary signed on ${n.notarySignedDate}, after the certification date of ${packet.certificate.certifiedDate}`);
  }
  // A notary cannot validly notarize on an expired commission.
  if (signed && expiry && expiry.getTime() < signed.getTime()) {
    problems.push(`the notary's commission expired on ${n.commissionExpiryDate}, before they signed on ${n.notarySignedDate}`);
  }

  if (problems.length) {
    return [finding(section, 'The contractor\'s certificate is properly notarized', FAIL,
      `${problems.join('; ')}.${n.observation ? ` Read from the page: ${n.observation}` : ''}`)];
  }
  return [finding(section, 'The contractor\'s certificate is properly notarized', PASS,
    n.observation || 'Signature, notary signature and stamp are all present, and the commission was '
    + 'current on the date of signing.')];
}

// --- Subcontractor backup --------------------------------------------------------------------

function subcontractorChecks(packet, terms) {
  const section = 'subs';
  const subs = packet.subApplications || [];
  if (!subs.length) {
    return [finding(section, 'Subcontractor applications are included', UNKNOWN,
      'No subcontractor applications were found in the packet. If the contractor bills '
      + 'subcontracted work, their certified applications are the backup for it.')];
  }

  const out = [];
  const threshold = num(terms?.lienWaiverRequirement?.thresholdAmount);
  const waiversRequired = terms?.lienWaiverRequirement?.present === true;

  const missingWaiver = subs.filter(s => {
    if (s.lienWaiverIncluded !== false) return false;
    const value = num(s.certificate?.line3ContractSumToDate) ?? num(s.certificate?.line1OriginalContractSum);
    return !has(threshold) || !has(value) || value >= threshold;
  });

  if (waiversRequired) {
    out.push(missingWaiver.length
      ? finding(section, 'Lien waivers are included where the contract requires them', FAIL,
        `No waiver found for ${missingWaiver.map(s => s.firmName).join(', ')}. `
        + `The contract requires ${terms.lienWaiverRequirement.waiverType || 'waivers'}`
        + `${has(threshold) ? ` on subcontracts above ${money(threshold)}` : ''}`
        + `${terms.lienWaiverRequirement.section ? ` (${terms.lienWaiverRequirement.section})` : ''} `
        + 'as a condition of processing the next progress payment.',
        { firms: missingWaiver.map(s => s.firmName), amount: null })
      : finding(section, 'Lien waivers are included where the contract requires them', PASS,
        'A waiver is on file for every subcontractor that needs one.'));
  } else if (missingWaiver.length) {
    out.push(finding(section, 'Lien waivers are included', NOTE,
      `No waiver found for ${missingWaiver.map(s => s.firmName).join(', ')}. The contract on file `
      + 'does not state a waiver requirement, so this is a gap in the backup rather than a breach.',
      { firms: missingWaiver.map(s => s.firmName) }));
  }

  // Each sub's own nine lines.
  for (const sub of subs) {
    out.push(...certificateChecks(sub.certificate, {
      section: 'subs',
      sovRows: sub.sovRows,
      label: sub.firmName,
    }));
  }

  return out;
}

// --- Sales tax ------------------------------------------------------------------------------

// The check the method is emphatic about, and the one that is easiest to under-scope. Every invoice
// with a nonzero tax line is listed BEFORE any of them is judged, so partial coverage cannot
// quietly become the final answer.
function taxChecks(packet, terms) {
  const section = 'tax';
  const clause = terms?.taxExemptionClause;
  const invoices = packet.backupInvoices || [];

  if (!clause?.present) {
    return {
      findings: terms
        ? [finding(section, 'Sales tax', PASS,
          'The contract on file contains no tax-exemption provision, so sales tax in the backup is '
          + 'an ordinary cost of the work.')]
        : [],
      taxed: [],
      exempt: [],
      total: 0,
    };
  }

  const taxed = invoices.filter(i => has(i.taxAmount) && i.taxAmount > 0);
  const exempt = invoices.filter(i => (has(i.taxAmount) && i.taxAmount === 0) || i.exemptionNoted === true);
  const total = Math.round(taxed.reduce((t, i) => t + i.taxAmount, 0) * 100) / 100;

  const cite = clause.section ? ` (${clause.section})` : '';

  if (!taxed.length) {
    return {
      findings: [finding(section, 'Sales tax is not billed to a tax-exempt owner', PASS,
        `The contract makes the owner tax-exempt${cite}. No invoice in the backup shows a tax charge`
        + `${exempt.length ? `, and ${exempt.length} show the exemption applied` : ''}.`)],
      taxed: [], exempt, total: 0,
    };
  }

  // The strongest evidence that tax was avoidable: the same vendor, same period, billing $0.00 tax
  // elsewhere in the packet. That proves the certificate works and was simply not applied.
  const exemptVendors = new Set(exempt.map(i => String(i.vendor || '').toLowerCase().trim()));
  const provenAvoidable = taxed.filter(i => exemptVendors.has(String(i.vendor || '').toLowerCase().trim()));

  const burden = clause.burdenOnContractor === true;
  const detail = burden
    ? `The contract makes the owner tax-exempt and puts the burden of claiming that exemption on the `
      + `contractor${cite}. ${taxed.length} invoice${taxed.length === 1 ? '' : 's'} in the backup `
      + `carr${taxed.length === 1 ? 'ies' : 'y'} sales tax totalling ${money(total)}. That amount is `
      + `not payable by the owner and should be deducted from this application before it is certified.`
      + (provenAvoidable.length
        ? ` ${provenAvoidable.length} of them ${provenAvoidable.length === 1 ? 'is' : 'are'} from a `
          + `vendor that billed this job at $0.00 tax on another invoice in the same packet, which `
          + `shows the exemption certificate is usable and was simply not applied consistently.`
        : '')
    : `The contract addresses tax exemption${cite} but does not clearly place the burden of claiming `
      + `it on the contractor. ${taxed.length} invoice${taxed.length === 1 ? '' : 's'} carry tax `
      + `totalling ${money(total)}. Who bears this depends on reading the clause against the owner's `
      + `exemption practice — worth resolving before certifying.`;

  return {
    findings: [finding(section, 'Sales tax is not billed to a tax-exempt owner', burden ? FAIL : NOTE,
      detail, { amount: total, count: taxed.length })],
    taxed, exempt, total,
  };
}

// --- Change order mapping and caps -------------------------------------------------------------

function changeOrderChecks(packet, terms) {
  const section = 'changeorders';
  const out = [];
  const cert = packet.certificate || {};

  // A sub whose change order was approved this period should show up in the GC's contingency or
  // allowance buckets, not folded into their base scope line.
  const drawn = workRows(packet.sovRows)
    .filter(r => r.isContingencyOrAllowance && has(r.thisPeriod) && r.thisPeriod !== 0);
  const drawnTotal = drawn.reduce((t, r) => t + r.thisPeriod, 0);

  const newCos = (packet.subApplications || [])
    .filter(s => has(s.newChangeOrdersThisPeriod) && s.newChangeOrdersThisPeriod !== 0);
  const newCoTotal = newCos.reduce((t, s) => t + s.newChangeOrdersThisPeriod, 0);

  if (newCos.length) {
    out.push(near(newCoTotal, drawnTotal, ROUNDING_TOLERANCE)
      ? finding(section, 'Change orders approved this period appear in the contingency draw', PASS,
        `${newCos.map(s => `${s.firmName} (${money(s.newChangeOrdersThisPeriod)})`).join(', ')} — `
        + `${money(newCoTotal)} in total, matching the ${money(drawnTotal)} drawn from contingency and allowances.`)
      : finding(section, 'Change orders approved this period appear in the contingency draw', FAIL,
        `${newCos.map(s => `${s.firmName} shows ${money(s.newChangeOrdersThisPeriod)} newly approved`).join(', ')}, `
        + `totalling ${money(newCoTotal)}. The contingency and allowance rows draw ${money(drawnTotal)} this `
        + `period — a difference of ${money(Math.abs(newCoTotal - drawnTotal))}. Confirm the change order was `
        + 'not folded into a base scope line instead of being drawn where it can be seen.',
        { amount: Math.abs(newCoTotal - drawnTotal), firms: newCos.map(s => s.firmName) }));
  }

  // A statutory or contractual cap on cumulative change orders.
  const cap = terms?.changeOrderCap;
  const line1 = num(cert.line1OriginalContractSum);
  const line2 = num(cert.line2NetChangeByChangeOrders);
  if (cap?.present && has(cap.percent) && has(line1) && has(line2) && line1 !== 0) {
    const used = Math.round((line2 / line1) * 10000) / 100;
    const allowed = line1 * cap.percent / 100;
    out.push(used <= cap.percent
      ? finding(section, 'Cumulative change orders are within the contract limit', PASS,
        `${money(line2)} of change orders is ${used}% of the original contract sum, within the `
        + `${cap.percent}% limit${cap.section ? ` (${cap.section})` : ''} of ${money(allowed)}.`)
      : finding(section, 'Cumulative change orders are within the contract limit', FAIL,
        `${money(line2)} of change orders is ${used}% of the original contract sum of ${money(line1)}, `
        + `over the ${cap.percent}% limit${cap.section ? ` (${cap.section})` : ''} of ${money(allowed)} — `
        + `exceeded by ${money(line2 - allowed)}.`,
        { amount: line2 - allowed }));
  }

  return out;
}

// --- Finding a firm's rows on the prime's schedule ------------------------------------------------

// The names never agree between the two documents. On a real packet the schedule said "IDR",
// "GreenScape" and "Greenrise" while the applications said "Integrated Demolition and Remediation
// Inc.", "Greenscape Associates" and "GREENRISE TECHNOLOGIES LLC FKA CONSTRUCTION ECO SERVICES II
// LLC" — and one of those firms was spread over eleven rows.
//
// Asked to match them, the model got every firm wrong or partly wrong. The reason is not that the
// task is hard to understand: it is that the task is exhaustive search over seventy-five rows plus
// addition, which is what code is for. What the schedule actually carries is the firm's SHORT
// NAME, written into the row description — "Earthwork (Building Pad) - Sendero", "AEA 08 CPR 009 -
// Additional Pier Removal (IDR)". So the aliases are derived from the firm name, every row is
// searched for each, and the arithmetic settles which alias was the right one.
//
// Words that identify nobody. "Industries", "Associates" and "Technologies" appear in half the
// firm names on a job and would match rows belonging to other trades.
const FIRM_NOISE = new Set([
  'inc', 'llc', 'ltd', 'lp', 'llp', 'co', 'company', 'corp', 'corporation', 'the', 'and', 'of',
  'industries', 'associates', 'technologies', 'services', 'service', 'group', 'enterprises',
  'contractors', 'contracting', 'construction', 'constructors', 'systems', 'solutions', 'fka',
  'dba', 'ii', 'iii', 'a', 'l',
]);

const firmWords = name => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/)
  .filter(w => w && !FIRM_NOISE.has(w));

// What this firm might be called on the schedule: each distinctive word, and the initials of those
// words — which is how "Integrated Demolition and Remediation" becomes "IDR".
function aliasesFor(firmName, extra = null) {
  const words = firmWords(firmName);
  const acronym = words.map(w => w[0]).join('');
  const candidates = [
    ...(extra ? [String(extra).toLowerCase().trim()] : []),
    ...words.filter(w => w.length > 3),
    ...(acronym.length >= 2 ? [acronym] : []),
  ];
  return [...new Set(candidates.filter(a => a && a.length >= 2))];
}

// Rows whose description mentions this alias as a word of its own, so "idr" does not match
// "bridge" and "sendero" does not match a longer word containing it.
const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rowsMatching = (rows, alias) => {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}([^a-z0-9]|$)`, 'i');
  return rows.filter(r => re.test(String(r.description || '')));
};

// The firm's rows on the prime's schedule, and how confident that is.
//
// When one alias's rows add up to exactly what the firm billed, that is not a guess — two
// independent documents agreeing to the penny is about as strong as evidence gets in a pay
// application. Where nothing adds up exactly, the fullest match is offered and said to be
// approximate rather than presented as fact.
function findFirmRows(firmName, primeRows, { gross = null, alias = null } = {}) {
  const rows = matchableRows(primeRows);
  if (!rows.length) return { rows: [], total: null, alias: null, exact: false };

  const tried = aliasesFor(firmName, alias)
    .map(a => {
      const hit = rowsMatching(rows, a);
      const total = Math.round(hit.reduce((t, r) => t + (num(r.thisPeriod) || 0), 0) * 100) / 100;
      return { alias: a, rows: hit, total };
    })
    .filter(t => t.rows.length);

  if (!tried.length) return { rows: [], total: null, alias: null, exact: false };

  const exact = has(gross) && tried.find(t => near(t.total, gross));
  if (exact) return { ...exact, exact: true };

  // Otherwise the alias that accounts for the most money, which is the one most likely to be the
  // firm's real short name rather than a word that happens to appear somewhere.
  const best = [...tried].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))[0];
  return { ...best, exact: false };
}

// --- Reconciling a subcontractor to the prime's schedule of values --------------------------------

// THE TRAP THIS EXISTS FOR
//
// A subcontractor's G702 "AMOUNT CERTIFIED" is the payment due — NET of their retainage. The
// prime's G703 "this application" column is GROSS. Compared directly, every subcontractor on a 5%
// job shows a variance of exactly 5% of their billing, and all of it is imaginary.
//
// That matters more than it sounds. A reviewer that reports four phantom variances on a clean
// application is worse than no reviewer at all, because the PM stops reading the findings — and the
// next one is real. So the comparison is made here, in code, from the gross pair, rather than being
// left to a model holding the distinction in its head while also doing the subtraction.
function reconcileSub(match, { retainagePercent = null, sub = null, primeRows = null } = {}) {
  const rate = num(retainagePercent);

  // Both sides are added up HERE, from rows the model transcribed but did not total. On a real
  // packet, asking it for the totals returned exactly double for all four subcontractors: their
  // continuation sheets carry subtotal rows that repeat the detail. workRows drops those by the
  // flag recorded during transcription, which is a fact about each row rather than a judgement
  // made while adding.
  const fromRows = rows => {
    const work = workRows(rows);
    if (!work.length) return null;
    const total = work.reduce((t, r) => t + (num(r.thisPeriod) || 0), 0);
    return Math.round(total * 100) / 100;
  };

  const certified = num(sub?.certificate?.line8CurrentPaymentDue) ?? num(match.subAmountCertified);

  let gross = fromRows(sub?.sovRows) ?? num(match.subGrossThisPeriod);

  // The prime's side, found by searching every row for the firm's short name. See findFirmRows:
  // this is exhaustive search plus addition over seventy-five rows, which code does exactly and a
  // model does not. The firm's own gross is handed in, so an alias whose rows add up to it can be
  // recognised as the right one rather than merely the plausible one.
  let found = Array.isArray(primeRows)
    ? findFirmRows(match.firmName, primeRows, { gross, alias: match.sovAlias })
    : { rows: [], total: null, exact: false };

  let sov = found.total;
  let matchedRows = found.rows;

  // Only if no alias matched anything: the indexes the model named. A firm genuinely absent from
  // the schedule has no alias to find, and this is what distinguishes that from a naming quirk.
  if (!has(sov) && Array.isArray(match.sovRowIndexes)) {
    const work = matchableRows(primeRows || []);
    const picked = [...new Set(match.sovRowIndexes)].map(i => work[i]).filter(Boolean);
    if (picked.length) {
      matchedRows = picked;
      sov = Math.round(picked.reduce((t, r) => t + (num(r.thisPeriod) || 0), 0) * 100) / 100;
    }
  }
  if (!has(sov)) sov = num(match.sovThisPeriod);
  let derived = false;

  // The sub's form may only show the certified figure. Grossing it back up is exact when the rate
  // is known, and is the difference between a real comparison and a phantom one.
  if (!has(gross) && has(certified) && has(rate) && rate < 100) {
    gross = Math.round((certified / (1 - rate / 100)) * 100) / 100;
    derived = true;
  }

  if (!has(gross) || !has(sov)) {
    return {
      ...match,
      ties: null,
      variance: null,
      basis: 'not-comparable',
      basisNote: 'There was not enough on the forms to compare this firm\'s billing with the '
        + 'schedule of values on the same basis.',
    };
  }

  const variance = diff(gross, sov);
  const ties = Math.abs(variance) <= ROUNDING_TOLERANCE;

  // A certified figure that is not gross less retainage is itself worth knowing about — it means
  // one of the two numbers is not what it is labelled.
  let certifiedNote = null;
  if (has(certified) && has(rate) && !derived) {
    const expected = gross * (1 - rate / 100);
    if (!near(certified, expected)) {
      certifiedNote = `Their certified amount of ${money(certified)} is not ${rate}% retainage off `
        + `${money(gross)} (which would be ${money(expected)}) — worth confirming which figure is right.`;
    }
  }

  const names = matchedRows.length
    ? [...new Set(matchedRows.map(r => r.description).filter(Boolean))]
    : (match.sovItems || []);

  return {
    ...match,
    sovItems: names,
    matchedBy: found.alias || (matchedRows.length ? 'the rows identified in the packet' : null),
    matchExact: !!found.exact,
    subGrossThisPeriod: gross,
    subAmountCertified: certified,
    sovThisPeriod: sov,
    ties,
    variance,
    basis: 'gross',
    basisNote: [
      derived
        ? `Compared gross: their certified ${money(certified)} grossed back up at ${rate}% retainage `
          + `is ${money(gross)}, against ${money(sov)} on the prime's schedule.`
        : `Compared gross: ${money(gross)} billed against ${money(sov)} on the prime's schedule.`,
      certifiedNote,
    ].filter(Boolean).join(' '),
  };
}

// --- Putting it together ----------------------------------------------------------------------

// Everything checkable, given what the packet carried and what the contract said. `terms` is null in
// math-only mode, and every check that needs the contract reports itself as unchecked rather than
// disappearing — the report has to be able to say what it did not look at.
function runChecks(packet, terms = null) {
  const tax = taxChecks(packet, terms);

  const findings = [
    ...certificateChecks(packet.certificate, {
      section: 'numbers',
      sovRows: packet.sovRows,
      label: packet.contractorName || 'The contractor',
    }),
    ...previousPaymentChecks(packet),
    ...retainageChecks(packet, terms),
    ...dateChecks(packet),
    ...notaryChecks(packet),
    ...subcontractorChecks(packet, terms),
    ...tax.findings,
    ...changeOrderChecks(packet, terms),
  ];

  const counts = findings.reduce((acc, f) => ({ ...acc, [f.status]: (acc[f.status] || 0) + 1 }), {});

  return {
    findings,
    tax,
    counts: {
      pass: counts[PASS] || 0,
      fail: counts[FAIL] || 0,
      note: counts[NOTE] || 0,
      unknown: counts[UNKNOWN] || 0,
    },
    // What a reader most wants first: is there a reason not to certify this as it stands.
    certifiable: (counts[FAIL] || 0) === 0,
  };
}

module.exports = {
  runChecks, certificateChecks, taxChecks, parseDate, reconcileSub, matchableRows,
  findFirmRows, aliasesFor,
  workRows, sumOf, PASS, FAIL, NOTE, UNKNOWN, ROUNDING_TOLERANCE,
};
