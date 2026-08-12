// Reconciling a pay application's cost detail against the receipts that support it.
//
// This is the second family of rules, kept apart from lib/payAppInvariants.js on purpose. Those
// are arithmetic: a sum is right or it is wrong and there is nothing to argue about. These
// compare two LISTS — every receipt should have a charge, every charge should have a receipt —
// and the hard part is not the comparison but deciding whether two records are the same thing.
//
// Real evidence from one application shows why that matters:
//   - one Home Depot receipt was split across two cost codes, so a single receipt backs two
//     charges and neither amount equals the receipt total
//   - a camera vendor was posted wrongly, reversed, and re-posted under a different name, so
//     the same invoice number appears three times and nets to one charge
//   - two fuel receipts of $300 back a single $600 line
//   - a safety vest receipt and its charge agree on vendor, amount and description but carry
//     DIFFERENT invoice numbers
//
// A matcher that only compares invoice numbers reports four problems there. One that only
// compares amounts hides the fourth, which is the only real one. So matching is tiered, and
// every match carries how confident it is.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

// How far apart a receipt and its posting may sit and still be the same transaction. A charge
// is posted when the invoice is processed, not when it was issued, and a month of lag is
// ordinary.
const POSTING_WINDOW_DAYS = 60;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol = TOL.cent) => Math.abs(a - b) <= tol;

// Invoice numbers are written differently in a job-cost system than on the invoice itself:
// "INV963622" against "963622", "000523427" against "523427". Comparing them raw produces
// mismatches that are nothing but formatting.
const normRef = r => (r == null ? null
  : String(r).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(INV|INVOICE|NO)/, '').replace(/^0+/, '') || null);

// Vendor names differ between the ledger and the letterhead — "White Cap, LP" against
// "WHITE CAP", "Wex Bank - Valero" against "Valero". Comparison is on the significant words,
// so one name containing the other counts as the same vendor.
const NOISE = new Set(['inc', 'llc', 'lp', 'ltd', 'co', 'company', 'corp', 'the', 'of', 'and', 'opco']);
const vendorWords = v => String(v || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(w => w && !NOISE.has(w));

function sameVendor(a, b) {
  const wa = vendorWords(a);
  const wb = vendorWords(b);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter(w => wb.includes(w)).length;
  return shared > 0 && shared >= Math.min(wa.length, wb.length) * 0.5;
}

const parseDate = d => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
};
const daysApart = (a, b) => {
  const ta = parseDate(a);
  const tb = parseDate(b);
  return ta == null || tb == null ? null : Math.abs(ta - tb) / 86400000;
};

// --- what kind of backup a charge needs ------------------------------------------------------
//
// Getting this wrong is the fastest way to a hundred false findings. Payroll, internal
// allowances and equipment auto-charges never have a vendor invoice, and demanding one for
// each would bury the handful of charges that genuinely lack backup. Subcontract draws DO need
// backup, but a subcontractor's own pay application rather than a receipt, which this file
// does not check — so they are reported as unchecked instead of being silently passed.

const SUBCONTRACT_REF = /^\d{6}-\d{3}-\d{2}$/;   // e.g. 253016-004-03, a Textura draw

function backupKind(tx) {
  if (tx.source && tx.source !== 'AP') return 'internal';
  if (SUBCONTRACT_REF.test(String(tx.ref || ''))) return 'subcontract';
  return 'invoice';
}

// --- internal allowances ----------------------------------------------------------------------
//
// A class of charge that the rules above deliberately walk past, and should not.
//
// backupKind() calls these 'internal' and asks no invoice of them, which is right — there is
// nothing to receipt. But 'internal' has been silently standing for 'fine', and it does not mean
// that. It means nobody bought anything: the contractor is spreading its own overhead onto the
// job by formula. Whether the owner agreed to pay for that is a CONTRACT question, and the
// answer is not in any of the arithmetic.
//
// Carver application 01 is the case. Three cost codes were posted this way:
//
//   013100-210  Vehicle Allowance        15 rows   $5.77 per employee-hour   2,354.16
//   013100-230  Cell Allowance           18 rows   $0.40 per employee-hour     187.20
//   015200-110  Computers & Software     18 rows   $4.50 per employee-hour   2,106.00
//
// The PM had the first two struck, and general conditions billing fell from $54,885.68 to
// $52,344.32. The third was never questioned, and is still being billed three applications later
// under a new name. Nothing in the arithmetic could have told anyone.
//
// The fingerprint is exact and needs no contract: every row in the cost code divides to the SAME
// rate per unit, posted by internal journal, with no vendor and no invoice number. Payroll is
// excluded even though it looks identical — an hourly wage is a constant rate too, and the first
// version of this check happily reported the project executive at $70.00 an hour.

const MIN_ALLOCATION_ROWS = 3;   // two rows sharing a rate is a coincidence, not a formula

const allocationSources = app => app.internalSources || ['JC'];

function detectAllocations(app) {
  const groups = new Map();
  for (const tx of app.transactions || []) {
    const code = tx.costCode || tx.costCodeName;
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, { code, name: tx.costCodeName || code, members: [] });
    groups.get(code).members.push(tx);
  }

  const out = [];
  for (const g of groups.values()) {
    const rows = g.members;
    if (rows.length < MIN_ALLOCATION_ROWS) continue;
    if (!rows.every(r => allocationSources(app).includes(r.source))) continue;
    if (!rows.every(r => isNum(r.quantity) && r.quantity > 0 && isNum(r.amount))) continue;
    const rates = new Set(rows.map(r => Math.round((r.amount / r.quantity) * 10000)));
    if (rates.size !== 1) continue;
    const billedRows = rows.filter(r => !r.removed);
    out.push({
      code: g.code,
      name: g.name,
      rows,
      rate: rows[0].amount / rows[0].quantity,
      total: rows.reduce((a, r) => a + r.amount, 0),
      billed: billedRows.reduce((a, r) => a + r.amount, 0),
      removed: billedRows.length === 0,
      // The ERP writes one row per employee per week. Naming them lets the report say what the
      // charge actually is rather than quoting a cost code at a reader who does not use that ERP.
      people: [...new Set(rows.map(r => {
        const m = /_emp_\d+_(.+)$/.exec(String(r.description || ''));
        return m ? m[1].trim() : null;
      }).filter(Boolean))],
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// What the PM has already decided about a cost code, on this project or a previous one. A ruling
// is what turns "this is an internal allowance" into "this may not be billed" — the tool can see
// the first on its own and can never know the second.
const rulingFor = (app, alloc) => (app.costRulings || []).find(r =>
  String(r.code) === String(alloc.code)
  || (r.name && alloc.name && r.name.toLowerCase() === alloc.name.toLowerCase()));

// Which cost reports we actually hold the backup for.
//
// A pay application's costs arrive in more than one ledger, and each has its own packet of
// invoices. Reconciling one report's charges against another report's packet reports every one
// of them as unsupported — which is not a finding about the contractor, it is a finding about
// what we were sent. The first run of this file produced thirteen such findings in one go.
//
// So the scope is declared, and anything outside it is reported as unchecked rather than
// unsupported. A MISSING declaration means "everything", which is right for a single packet. An
// explicitly EMPTY one means no packet was supplied at all — reconciling against an empty list
// would report every charge as unsupported, which says nothing about the contractor. Either way
// R9 states the coverage out loud, so neither can be mistaken for a clean pass.
const inScope = (app, report) => {
  const scope = app.backupScope;
  if (!scope) return true;
  return scope.includes(report);
};

// --- matching --------------------------------------------------------------------------------
//
// Charges are grouped by invoice number before anything is compared, because one invoice can
// legitimately produce several ledger lines — split across cost codes, or reversed and
// re-posted. The group's NET total is what a receipt has to agree with.

function groupByRef(items) {
  const groups = new Map();
  for (const it of items) {
    const key = normRef(it.ref) || `~unref~${it.id}`;
    if (!groups.has(key)) groups.set(key, { ref: it.ref, key, members: [], net: 0 });
    const g = groups.get(key);
    g.members.push(it);
    g.net += isNum(it.amount) ? it.amount : 0;
  }
  return [...groups.values()];
}

// Returns { matches, unmatchedCharges, unmatchedReceipts }.
function matchBackup(app) {
  const { transactions = [], receipts = [] } = app;
  // Matching runs over EVERY vendor charge, in scope or not. One receipt can be split across
  // ledgers — a Home Depot ticket booked $32.44 to general conditions and $188.16 to cost of
  // work — and comparing it against only the half we hold the packet for makes a correct
  // receipt look $188.16 short. Scope decides what must HAVE backup, not how amounts are
  // compared; those are different questions and conflating them invents findings.
  const chargeable = transactions.filter(t => backupKind(t) === 'invoice');
  const chargeGroups = groupByRef(chargeable);
  for (const g of chargeGroups) g.inScope = g.members.some(m => inScope(app, m.report));
  const receiptGroups = groupByRef(receipts);

  const matches = [];
  const takenReceipts = new Set();
  const takenCharges = new Set();

  // Tier 1 — the same invoice number. Certain, whatever the amounts do.
  for (const cg of chargeGroups) {
    const rg = receiptGroups.find(r => !takenReceipts.has(r.key) && r.key === cg.key && !r.key.startsWith('~unref~'));
    if (!rg) continue;
    takenReceipts.add(rg.key);
    takenCharges.add(cg.key);
    matches.push({
      confidence: 'certain',
      basis: 'invoice number',
      charge: cg,
      receipt: rg,
      amountAgrees: close(cg.net, rg.net, TOL.aggregate),
    });
  }

  // Tier 2 — same vendor, same amount, posted close enough in time. Probable, and said to be.
  for (const cg of chargeGroups) {
    if (takenCharges.has(cg.key)) continue;
    const rg = receiptGroups.find(r => {
      if (takenReceipts.has(r.key)) return false;
      if (!close(r.net, cg.net, TOL.aggregate)) return false;
      if (!sameVendor(r.members[0]?.vendor, cg.members[0]?.vendor)) return false;
      const gap = daysApart(r.members[0]?.date, cg.members[0]?.date);
      return gap == null || gap <= POSTING_WINDOW_DAYS;
    });
    if (!rg) continue;
    takenReceipts.add(rg.key);
    takenCharges.add(cg.key);
    matches.push({
      confidence: 'probable',
      basis: 'vendor and amount',
      charge: cg,
      receipt: rg,
      amountAgrees: true,
      // The case worth surfacing rather than swallowing: everything agrees except the one
      // field that is supposed to identify the transaction.
      refMismatch: normRef(cg.ref) && normRef(rg.ref) && normRef(cg.ref) !== normRef(rg.ref),
    });
  }

  // Tier 3 — several receipts from one vendor adding up to one charge, which is how fuel and
  // small purchases usually arrive.
  for (const cg of chargeGroups) {
    if (takenCharges.has(cg.key)) continue;
    const candidates = receiptGroups.filter(r => !takenReceipts.has(r.key)
      && sameVendor(r.members[0]?.vendor, cg.members[0]?.vendor));
    if (candidates.length < 2) continue;
    const total = candidates.reduce((a, r) => a + r.net, 0);
    if (!close(total, cg.net, TOL.aggregate)) continue;
    candidates.forEach(r => takenReceipts.add(r.key));
    takenCharges.add(cg.key);
    matches.push({
      confidence: 'probable',
      basis: `${candidates.length} receipts totalling the charge`,
      charge: cg,
      receipt: { ref: null, key: cg.key, members: candidates.flatMap(c => c.members), net: total },
      amountAgrees: true,
    });
  }

  return {
    matches,
    // Only a charge we hold the packet for can be said to lack backup.
    unmatchedCharges: chargeGroups.filter(g => !takenCharges.has(g.key) && g.inScope),
    unmatchedReceipts: receiptGroups.filter(g => !takenReceipts.has(g.key)),
    skippedCharges: transactions.filter(t => backupKind(t) !== 'invoice'),
    outOfScope: transactions.filter(t => backupKind(t) === 'invoice' && !inScope(app, t.report)),
  };
}

// --- the reconciliation invariants -------------------------------------------------------------

const fail = o => ({ status: 'FAIL', ...o });
const pass = o => ({ status: 'PASS', ...o });
const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });

const describe = g => {
  const m = g.members[0] || {};
  return `${m.vendor || 'unknown vendor'}${g.ref ? ` ${g.ref}` : ''}`;
};

const RECON_INVARIANTS = [

  // ---- R1  The parse is complete ---------------------------------------------------------------
  // The gate on everything else. A transaction report prints its own total; if the lines we
  // read do not add up to it, we are holding an incomplete list, and every charge we failed to
  // read would be reported as a receipt with no charge. Better to check nothing than to
  // fabricate a page of findings out of a bad read.
  {
    id: 'R1',
    title: 'The cost detail was read completely',
    severity: SEVERITY.CRITICAL,
    gate: true,
    run(app) {
      const printed = app.reportTotals || {};
      const names = Object.keys(printed);
      if (!names.length) return skip('No printed report total was captured to check the read against.');
      return names.map(name => {
        const stated = printed[name];
        const read = (app.transactions || []).filter(t => t.report === name)
          .reduce((a, t) => a + (isNum(t.amount) ? t.amount : 0), 0);
        if (!isNum(stated)) return skip(`No printed total for the ${name} report.`, { where: { field: name } });
        return close(read, stated, TOL.aggregate) ? pass({ where: { field: name } }) : fail({
          where: { field: name },
          expected: stated,
          actual: read,
          difference: read - stated,
          detail: `The ${name} report prints a total of ${money(stated)} but only ${money(read)} of `
            + `transactions could be read — ${money(Math.abs(read - stated))} is missing. No `
            + `reconciliation has been attempted, because comparing against an incomplete list `
            + `would report charges as unsupported when they were simply not read.`,
        });
      });
    },
  },

  // ---- R2  Every charge has backup ---------------------------------------------------------------
  {
    id: 'R2',
    title: 'Every vendor charge has a receipt',
    severity: SEVERITY.MATERIAL,
    run(app, matched) {
      if (!matched) return skip('Matching did not run.');
      // Matching works on invoice-number groups, because one invoice can produce several ledger
      // lines. Reporting works on the LINES, because that is what the PM has to chase — two
      // charges sharing a fuel-card statement number are two questions for the contractor, not
      // one, and collapsing them would understate what is missing.
      const out = matched.unmatchedCharges.flatMap(g => g.members.map(m => fail({
        where: { ref: m.ref, vendor: m.vendor, report: m.report },
        actual: m.amount,
        detail: `${m.vendor || 'Unknown vendor'}${m.ref ? ` ${m.ref}` : ''} is charged `
          + `${money(m.amount)}${m.description ? ` for "${m.description}"` : ''} with no supporting `
          + `invoice in the backup.`,
      })));
      return out.length ? out : (matched.matches.length ? pass({}) : skip('No vendor charges to check.'));
    },
  },

  // ---- R3  Every receipt has a charge --------------------------------------------------------------
  // The other direction, and the one people skip. A receipt with no charge means either the
  // backup includes something that is not being billed — harmless but confusing — or a cost is
  // missing from the ledger.
  {
    id: 'R3',
    title: 'Every receipt corresponds to a charge',
    severity: SEVERITY.NOTE,
    run(app, matched) {
      if (!matched) return skip('Matching did not run.');
      const out = matched.unmatchedReceipts.map(g => fail({
        where: { ref: g.ref, vendor: g.members[0]?.vendor },
        actual: g.net,
        detail: `A receipt for ${describe(g)} of ${money(g.net)} is in the backup but appears on `
          + `neither transaction report.`,
      }));
      return out.length ? out : (matched.matches.length ? pass({}) : skip('No receipts to check.'));
    },
  },

  // ---- R4  A matched pair agrees on its invoice number -----------------------------------------------
  {
    id: 'R4',
    title: 'A receipt and its charge carry the same invoice number',
    severity: SEVERITY.MATERIAL,
    run(app, matched) {
      if (!matched) return skip('Matching did not run.');
      const mismatched = matched.matches.filter(m => m.refMismatch);
      if (!mismatched.length) return matched.matches.length ? pass({}) : skip('Nothing matched.');
      return mismatched.map(m => fail({
        where: { ref: m.charge.ref, vendor: m.charge.members[0]?.vendor },
        expected: m.receipt.ref,
        actual: m.charge.ref,
        detail: `${describe(m.charge)} was matched to a receipt on vendor and amount — both `
          + `${money(m.charge.net)} — but the invoice numbers differ: ${m.receipt.ref} on the `
          + `receipt against ${m.charge.ref} on the report. Either these are two separate `
          + `purchases of the same value, one of which has no backup, or the charge was posted `
          + `against the wrong invoice.`,
      }));
    },
  },

  // ---- R5  A matched pair agrees on the money ---------------------------------------------------------
  {
    id: 'R5',
    title: 'A receipt and its charge agree on the amount',
    severity: SEVERITY.CRITICAL,
    run(app, matched) {
      if (!matched) return skip('Matching did not run.');
      const off = matched.matches.filter(m => !m.amountAgrees);
      if (!off.length) return matched.matches.length ? pass({}) : skip('Nothing matched.');
      return off.map(m => fail({
        where: { ref: m.charge.ref, vendor: m.charge.members[0]?.vendor },
        expected: m.receipt.net,
        actual: m.charge.net,
        difference: m.charge.net - m.receipt.net,
        detail: `${describe(m.charge)} is charged ${money(m.charge.net)} against a receipt for `
          + `${money(m.receipt.net)} — ${money(Math.abs(m.charge.net - m.receipt.net))} apart.`,
      }));
    },
  },

  // ---- R6  Costs marked as excluded are actually excluded ------------------------------------------------
  // A receipt annotated "not included in this application" and then billed anyway is the
  // quietest kind of overbilling, because the annotation reads like diligence.
  {
    id: 'R6',
    title: 'Costs marked as not billed this period are not billed',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const excluded = (app.receipts || []).filter(r => r.excludedThisPeriod);
      if (!excluded.length) return skip('No receipt is marked as excluded from this application.');

      const out = [];
      for (const r of excluded) {
        const amount = isNum(r.excludedAmount) ? r.excludedAmount : r.amount;
        const hit = (app.transactions || []).find(t =>
          normRef(t.ref) === normRef(r.ref) && close(t.amount, amount, TOL.aggregate));
        out.push(hit ? fail({
          where: { ref: r.ref, vendor: r.vendor, page: r.page },
          expected: 0,
          actual: hit.amount,
          detail: `The receipt for ${r.vendor} ${r.ref} is annotated "${r.exclusionNote || 'not included in this application'}", `
            + `but ${money(hit.amount)} appears on the ${hit.report} transaction report as `
            + `"${hit.description}". Either the annotation is wrong or the cost should come out.`,
        }) : pass({ where: { ref: r.ref, page: r.page } }));
      }
      return out;
    },
  },

  // ---- R7  The cost detail ties to what is billed -------------------------------------------------------
  {
    id: 'R7',
    title: 'Cost detail ties to the amount billed',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const ties = app.billedAgainstDetail || [];
      if (!ties.length) return skip('No billed line has been tied to a cost report.');
      return ties.map(t => {
        if (!isNum(t.billed) || !isNum(t.detailTotal)) {
          return skip(`Figures missing for ${t.description}.`, { where: { field: t.description } });
        }
        const excluded = isNum(t.excludedTotal) ? t.excludedTotal : 0;
        const expected = t.detailTotal - excluded;
        return close(t.billed, expected, TOL.aggregate) ? pass({ where: { field: t.description } }) : fail({
          where: { field: t.description },
          expected,
          actual: t.billed,
          difference: t.billed - expected,
          detail: `${t.description} bills ${money(t.billed)} this period. The cost detail totals `
            + `${money(t.detailTotal)}${excluded ? `, less ${money(excluded)} marked as removed` : ''}, `
            + `which is ${money(expected)} — a difference of ${money(Math.abs(t.billed - expected))}.`,
        });
      });
    },
  },

  // ---- R8  Charges needing a different kind of backup are named, not ignored ------------------------------
  {
    id: 'R8',
    title: 'Charges needing subcontractor backup are identified',
    severity: SEVERITY.NOTE,
    run(app) {
      const subs = (app.transactions || []).filter(t => backupKind(t) === 'subcontract');
      if (!subs.length) return skip('No subcontract draws on this application.');
      const total = subs.reduce((a, t) => a + (isNum(t.amount) ? t.amount : 0), 0);
      // Not a failure — a statement of what this pass did not cover, so "no issues found" is
      // never read as "everything was verified".
      return skip(`${subs.length} subcontract draw(s) totalling ${money(total)} need a subcontractor `
        + `pay application rather than a receipt, and were not checked here.`);
    },
  },

  // ---- R10  A cost ruled non-reimbursable is not billed ------------------------------------------
  // Once a person has answered the question, the check is deterministic and the answer is
  // quoted back with its date, so a contractor asking "says who?" gets a real reply.
  {
    id: 'R10',
    title: 'Costs ruled non-reimbursable are not billed',
    severity: SEVERITY.CRITICAL,
    run(app, matched, allocations) {
      const ruled = (allocations || []).map(a => ({ a, r: rulingFor(app, a) }))
        .filter(x => x.r && x.r.reimbursable === false);
      if (!ruled.length) return skip('No cost code on this application has been ruled non-reimbursable.');
      return ruled.map(({ a, r }) => (a.billed <= TOL.aggregate ? pass({ where: { field: a.name } }) : fail({
        where: { field: a.name, ref: a.code },
        expected: 0,
        actual: a.billed,
        detail: `${a.name} (${a.code}) bills ${money(a.billed)} on this application. This cost was `
          + `ruled not reimbursable${r.ruledOn ? ` on ${r.ruledOn}` : ''}`
          + `${r.application ? `, when it was removed from application ${r.application}` : ''}`
          + `${r.note ? ` — ${r.note}` : ''}. It should come out again, or the ruling should be `
          + `revisited deliberately.`,
      })));
    },
  },

  // ---- R11  Internal allowances are put to a person, once ------------------------------------------
  // Not an accusation. These charges cannot be proved wrong by any document in the packet, and
  // they cannot be proved right either — the contract decides, and the tool has not read it. So
  // the question is asked plainly, and asked only until it is answered.
  {
    id: 'R11',
    title: 'Internal allowances have been ruled on',
    severity: SEVERITY.NOTE,
    run(app, matched, allocations) {
      const unruled = (allocations || []).filter(a => !rulingFor(app, a) && a.billed > TOL.aggregate);
      if (!(allocations || []).length) return skip('No internal allowance charges on this application.');
      if (!unruled.length) return pass({});
      return unruled.map(a => fail({
        where: { field: a.name, ref: a.code },
        actual: a.billed,
        detail: `${a.name} (${a.code}) bills ${money(a.billed)} as ${a.rows.length} entries at a flat `
          + `${money(a.rate)} per hour`
          + `${a.people.length ? ` across ${a.people.length} staff (${a.people.slice(0, 3).join(', ')}`
            + `${a.people.length > 3 ? ', …' : ''})` : ''}. `
          + `Nothing was purchased — this is the contractor's own overhead spread onto the job by `
          + `formula, so no invoice exists or ever will. Whether the contract allows it to be `
          + `billed is a question only you can settle. Answer once and it will not be asked again.`,
      }));
    },
  },

  // ---- R12  A cost struck from an earlier application has not come back -----------------------------
  // The cheapest check here and the one needing least setup: after the first month, precedent is
  // its own instruction.
  {
    id: 'R12',
    title: 'Costs removed from an earlier application have not reappeared',
    severity: SEVERITY.MATERIAL,
    run(app, matched, allocations) {
      const priors = app.priorRemovals || [];
      if (!priors.length) return skip('No cost has been removed from an earlier application on this project.');
      return priors.map(p => {
        const a = (allocations || []).find(x => String(x.code) === String(p.code))
          || { name: p.name, code: p.code, billed: 0 };
        return a.billed <= TOL.aggregate ? pass({ where: { field: p.name } }) : fail({
          where: { field: a.name, ref: p.code },
          expected: 0,
          actual: a.billed,
          detail: `${a.name} (${p.code}) bills ${money(a.billed)} on this application, having been `
            + `removed from application ${p.application}${isNum(p.amount) ? ` where it came to `
            + `${money(p.amount)}` : ''}. Either it was reinstated deliberately or the earlier `
            + `correction was not carried forward.`,
        });
      });
    },
  },

  // ---- R9  Say which costs were not covered ------------------------------------------------------
  // "No issues found" must never be able to mean "we only looked at a third of it". This check
  // can never fail; it exists so the report always states its own coverage.
  {
    id: 'R9',
    title: 'Coverage of the backup review',
    severity: SEVERITY.NOTE,
    run(app, matched, allocations) {
      const scope = app.backupScope;
      const alloc = (allocations || []).filter(a => a.billed > TOL.aggregate);
      const allocNote = alloc.length
        ? ` Separately, ${alloc.length} internal allowance code(s) totalling `
          + `${money(alloc.reduce((a, x) => a + x.billed, 0))} carry no invoice by their nature and `
          + `are covered by R11, not by receipt matching.`
        : '';
      if (!scope) return skip(`Backup was reconciled across every cost report.${allocNote}`);
      const uncovered = matched ? matched.outOfScope : [];
      const total = uncovered.reduce((a, t) => a + (isNum(t.amount) ? t.amount : 0), 0);
      if (!scope.length) {
        return skip(`No invoice packet was supplied with this application, so NO vendor charge was `
          + `reconciled — ${uncovered.length} charge(s) totalling ${money(total)} are unchecked. `
          + `Nothing here should be read as saying the costs are supported.${allocNote}`);
      }
      const reports = [...new Set(uncovered.map(t => t.report))];
      if (!uncovered.length) return skip(`Backup was reconciled for: ${scope.join(', ')}.${allocNote}`);
      return skip(`${uncovered.length} vendor charge(s) totalling ${money(total)} on the `
        + `${reports.join(', ')} report(s) were NOT checked — no invoice packet was supplied for `
        + `them. Backup was reconciled for ${scope.join(', ')} only.${allocNote}`);
    },
  },
];

function runBackupChecks(app) {
  const results = [];
  const stamp = (inv, r) => results.push({ id: inv.id, title: inv.title, severity: r.severity || inv.severity, ...r });

  // The completeness gate runs first, and a failure stops everything downstream.
  const gate = RECON_INVARIANTS.find(i => i.gate);
  const gateResults = [].concat(gate.run(app));
  gateResults.forEach(r => stamp(gate, r));

  if (gateResults.some(r => r.status === 'FAIL')) {
    for (const inv of RECON_INVARIANTS.filter(i => !i.gate)) {
      stamp(inv, skip('Not attempted: the cost detail could not be read completely.'));
    }
    return summarise(results, null);
  }

  const matched = matchBackup(app);
  const allocations = detectAllocations(app);
  for (const inv of RECON_INVARIANTS.filter(i => !i.gate)) {
    let produced;
    try {
      produced = inv.run(app, matched, allocations);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r => stamp(inv, r));
  }
  return summarise(results, matched, allocations);
}

function summarise(results, matched, allocations = []) {
  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  return {
    results,
    findings,
    matched,
    allocations,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      matchedPairs: matched ? matched.matches.length : 0,
      certainMatches: matched ? matched.matches.filter(m => m.confidence === 'certain').length : 0,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      // Notes do not move the verdict. They print under a heading that says no action is
      // expected, so letting one downgrade an otherwise clean application would have the
      // report contradict itself.
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
  };
}

module.exports = {
  RECON_INVARIANTS, runBackupChecks, matchBackup, normRef, sameVendor, backupKind,
  detectAllocations, rulingFor,
};
