// Following the money from the owner's certificate down to the subcontractor's own application.
//
// The fourth family. The others each look at one document: the arithmetic engine at the G702/G703,
// the backup engine at a cost report and its receipts, the coverage engine at a line and the
// papers attached to it. This one looks at a CHAIN, and the failures it catches are failures of
// agreement between documents that are each internally perfect.
//
// The chain, as a GMP package actually assembles it — Tellepsen application 4 on Aldine ISD:
//
//   G702                    current payment due                        310,732.37
//     G703 line 024100      Demolition, this period                    177,500.00
//       GC invoice 50559    024100 SUBCONTRACTS  Grant Mackay  225020-003-2  177,500.00
//         sub application   Grant Mackay app 2, line 1, this period    177,500.00
//
// Four documents, four parties, one number. Every link in that package holds to the cent, and
// the package still has things wrong with it — which is the whole argument for this file. The
// errors here are not arithmetic errors. They are a cost booked against a contract that does not
// cover it, sales tax charged to a school district that does not pay sales tax, and a fee taken
// on top of a fee. None of them make a single total disagree with another.
//
// The one check worth explaining before you read it is S6.
//
// A subcontract draw carries a commitment reference — 225020-003-2 is the third commitment on
// job 225020, draw 2. An ordinary purchase carries whatever number the vendor prints on their
// invoice. So when a charge is filed under SUBCONTRACTS and its reference is 64328, there is no
// subcontract behind it: the work is being paid as an invoice. On this package that is exactly
// the case the PM annotated by hand — "CO needed, contract currently under CT6 instead of CT7."
// No subcontract log is needed to see it. The shape of the reference gives it away.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol = TOL.aggregate) => Math.abs(a - b) <= tol;
const num = v => (isNum(v) ? v : 0);
const sum = (list, f) => list.reduce((a, x) => a + num(f ? f(x) : x), 0);
const pct = f => `${+(f * 100).toFixed(4)}%`;

// A commitment draw: job number, commitment number, draw number. Bartlett writes 253016-004-03
// and Tellepsen writes 225020-003-2, so the draw is one digit or two.
const COMMITMENT_DRAW = /^(\d{6})-(\d{3})-(\d{1,2})$/;
const commitmentOf = ref => {
  const m = COMMITMENT_DRAW.exec(String(ref || '').trim());
  return m ? `${m[1]}-${m[2]}` : null;
};

const SUBCONTRACT = 'SUBCONTRACTS';

// The contractor's own departments bill the job the same way an outside subcontractor does —
// "Tellepsen Services Department", "Tellepsen Field Support Department" against Tellepsen
// Builders, L.P. Recognising them is what keeps self-perform from being reported as a missing
// subcontract, and what lets it be reported as the different thing it is.
const isAffiliate = (app, vendor) => {
  const names = app.contractorAliases || (app.meta?.contractor ? [app.meta.contractor] : []);
  const v = String(vendor || '').toLowerCase();
  return names.some(n => {
    const stem = String(n).toLowerCase().replace(/[.,]/g, '').split(/\s+/)[0];
    return stem.length > 3 && v.includes(stem);
  });
};

// --- rolling the breakdown up to cost codes ----------------------------------------------------

function byCode(app) {
  const codes = new Map();
  for (const e of app.breakdown || []) {
    if (!codes.has(e.code)) codes.set(e.code, { code: e.code, entries: [], total: 0 });
    const g = codes.get(e.code);
    g.entries.push(e);
    g.total += num(e.amount);
  }
  for (const g of codes.values()) {
    g.sovLine = (app.sovLines || []).find(l => String(l.code) === String(g.code)) || null;
  }
  return [...codes.values()];
}

// Which breakdown entries belong to a subcontractor's application, worked out from the commitment
// number rather than declared. One commitment can appear under several cost codes — Grant Mackay's
// draw 225020-003-2 is split between demolition and asbestos — and it is the SUM that has to agree
// with the sub's application, not any single line.
function entriesForSub(app, sub) {
  const commitment = sub.commitment || commitmentOf(sub.ref);
  if (!commitment) return [];
  return (app.breakdown || []).filter(e => commitmentOf(e.ref) === commitment);
}

const codesOf = entries => [...new Set(entries.map(e => e.code))];

const sovFor = (app, codes) => (app.sovLines || []).filter(l => codes.includes(String(l.code)));

// --- checks -------------------------------------------------------------------------------------

const fail = o => ({ status: 'FAIL', ...o });
const pass = o => ({ status: 'PASS', ...o });
const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });

const SUB_CHECKS = [

  // ---- S1  The breakdown was read completely -------------------------------------------------------
  // The gate, and the same argument as everywhere else: a cost code that failed to parse looks
  // identical to a cost code billed for nothing, and half these checks work by comparing totals.
  {
    id: 'S1',
    title: "The contractor's cost breakdown was read completely",
    severity: SEVERITY.CRITICAL,
    gate: true,
    run(app) {
      const printed = app.invoiceSummary || {};
      if (!isNum(printed.invoiceTotal)) return skip('The invoice total was not captured, so the read cannot be checked.');
      const base = sum(app.breakdown || [], e => e.amount);
      const read = base + num(printed.fee);
      return close(read, printed.invoiceTotal) ? pass({}) : fail({
        expected: printed.invoiceTotal,
        actual: read,
        difference: read - printed.invoiceTotal,
        detail: `The contractor's invoice totals ${money(printed.invoiceTotal)}, but the breakdown `
          + `entries read come to ${money(base)} plus ${money(num(printed.fee))} of fee — `
          + `${money(read)}, which is ${money(Math.abs(read - printed.invoiceTotal))} out. Nothing `
          + `downstream has been checked, because comparing an incomplete breakdown against the `
          + `schedule of values would report the lines that failed to read as billed for nothing.`,
      });
    },
  },

  // ---- S2  Each cost code ties to its line on the schedule of values ---------------------------------
  // The join that makes everything else possible. Until the breakdown is tied code by code, there
  // is no way to know which invoice supports which line.
  {
    id: 'S2',
    title: 'Every cost code in the breakdown ties to its schedule of values line',
    severity: SEVERITY.CRITICAL,
    run(app, codes) {
      if (!(app.sovLines || []).length) return skip('No schedule of values was supplied to tie the breakdown to.');
      return codes.map(g => {
        if (!g.sovLine) {
          return fail({
            where: { itemNo: g.code },
            actual: g.total,
            detail: `Cost code ${g.code} bills ${money(g.total)} on the contractor's breakdown but `
              + `has no line on the schedule of values. Either the cost is billed under a different `
              + `line than the one it is coded to, or it is billed outside the schedule entirely.`,
          });
        }
        const billed = num(g.sovLine.thisPeriod);
        return close(g.total, billed) ? pass({ where: { itemNo: g.code } }) : fail({
          where: { itemNo: g.code, field: g.sovLine.description },
          expected: billed,
          actual: g.total,
          difference: g.total - billed,
          detail: `${g.sovLine.description} (${g.code}) is billed ${money(billed)} on the schedule of `
            + `values, but the ${g.entries.length} cost entries behind it come to ${money(g.total)} — `
            + `${money(Math.abs(g.total - billed))} apart.`,
        });
      });
    },
  },

  // ---- S3  The fee is the contract rate on the stated base --------------------------------------------
  // Worth checking precisely because the contractor prints the base. A fee that is right on a base
  // that has quietly grown is the failure this catches: both figures are internally consistent and
  // only the composition of the base is wrong.
  {
    id: 'S3',
    title: 'The fee is the contract rate applied to the cost base',
    severity: SEVERITY.MATERIAL,
    run(app, codes) {
      const inv = app.invoiceSummary || {};
      const rate = app.contract?.feeRate;
      if (!isNum(rate) || !isNum(inv.fee)) return skip('No contract fee rate or no fee was captured.');
      const out = [];

      // The base the contractor states must actually be the costs, not a number that happens to
      // produce the fee they want.
      if (isNum(inv.feeBase)) {
        const costs = sum(app.breakdown || [], e => e.amount);
        out.push(close(costs, inv.feeBase) ? pass({ where: { field: 'fee base' } }) : fail({
          where: { field: 'fee base' },
          expected: costs,
          actual: inv.feeBase,
          difference: inv.feeBase - costs,
          detail: `The fee is taken on a base of ${money(inv.feeBase)}, but the costs on this `
            + `application add up to ${money(costs)} — a difference of `
            + `${money(Math.abs(inv.feeBase - costs))}. The rate may be right and the fee still wrong.`,
        }));
      }

      const expected = Math.round(num(inv.feeBase) * rate * 100) / 100;
      out.push(close(inv.fee, expected, TOL.cent) ? pass({ where: { field: 'fee' } }) : fail({
        where: { field: 'fee' },
        expected,
        actual: inv.fee,
        difference: inv.fee - expected,
        detail: `The fee is billed at ${money(inv.fee)}. ${pct(rate)} of ${money(num(inv.feeBase))} `
          + `is ${money(expected)}.`,
      }));

      // And it has to arrive on the schedule of values as the fee line, not somewhere else.
      const feeLine = (app.sovLines || []).find(l => l.isFee);
      if (feeLine) {
        out.push(close(num(feeLine.thisPeriod), inv.fee) ? pass({ where: { field: feeLine.description } }) : fail({
          where: { itemNo: feeLine.code, field: feeLine.description },
          expected: inv.fee,
          actual: num(feeLine.thisPeriod),
          difference: num(feeLine.thisPeriod) - inv.fee,
          detail: `The invoice charges ${money(inv.fee)} of fee, but the ${feeLine.description} line `
            + `on the schedule of values bills ${money(num(feeLine.thisPeriod))}.`,
        }));
      }
      return out;
    },
  },

  // ---- S4  Retainage and the amount due follow from the total ------------------------------------------
  {
    id: 'S4',
    title: 'Retainage and the current amount due follow from the invoice total',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const inv = app.invoiceSummary || {};
      const rate = app.contract?.retainageRate;
      if (!isNum(inv.invoiceTotal)) return skip('No invoice total was captured.');
      const out = [];
      if (isNum(rate) && isNum(inv.retainage)) {
        const expected = Math.round(inv.invoiceTotal * rate * 100) / 100;
        out.push(close(Math.abs(inv.retainage), expected, TOL.cent) ? pass({ where: { field: 'retainage' } }) : fail({
          where: { field: 'retainage' },
          expected,
          actual: Math.abs(inv.retainage),
          difference: Math.abs(inv.retainage) - expected,
          detail: `Retainage is withheld at ${money(Math.abs(inv.retainage))}. ${pct(rate)} of `
            + `${money(inv.invoiceTotal)} is ${money(expected)}.`,
        }));
      }
      if (isNum(inv.currentDue) && isNum(inv.retainage)) {
        const expected = inv.invoiceTotal - Math.abs(inv.retainage);
        out.push(close(inv.currentDue, expected, TOL.cent) ? pass({ where: { field: 'current due' } }) : fail({
          where: { field: 'current due' },
          expected,
          actual: inv.currentDue,
          difference: inv.currentDue - expected,
          detail: `The amount due is stated as ${money(inv.currentDue)}. ${money(inv.invoiceTotal)} `
            + `less ${money(Math.abs(inv.retainage))} of retainage is ${money(expected)}.`,
        }));
      }
      return out.length ? out : skip('No retainage rate or amount due was captured.');
    },
  },

  // ---- S5  Each subcontractor's own application agrees with what is billed for them ----------------------
  // The heart of it. A subcontractor bills the contractor; the contractor bills the owner. Those
  // two numbers are prepared by different companies from different systems, and the only thing
  // making them agree is that they describe the same work.
  //
  // Note what is NOT compared: the subcontract value against the schedule of values line. Grant
  // Mackay's asbestos contract is $98,550 while the owner's asbestos line is $255,872, because the
  // line covers scope not yet bought out. Comparing them would be wrong every month. Billing
  // agrees; contract values need not.
  {
    id: 'S5',
    title: "Each subcontractor's application agrees with the contractor's billing",
    severity: SEVERITY.CRITICAL,
    run(app) {
      const subs = app.subApplications || [];
      if (!subs.length) return skip('No subcontractor applications were supplied with this package.');
      const out = [];

      for (const sub of subs) {
        const who = `${sub.vendor}${sub.applicationNumber ? ` application ${sub.applicationNumber}` : ''}`;
        const entries = entriesForSub(app, sub);
        if (!entries.length) {
          out.push(fail({
            where: { vendor: sub.vendor, ref: sub.commitment },
            actual: num(sub.thisPeriod),
            detail: `${who} bills ${money(num(sub.thisPeriod))} this period, but no charge against `
              + `commitment ${sub.commitment || '(none given)'} appears on the contractor's breakdown. `
              + `Either the subcontractor's work is not being passed through this month, or it is `
              + `booked somewhere the commitment number does not identify.`,
          }));
          continue;
        }

        const codes = codesOf(entries);
        const passedThrough = sum(entries, e => e.amount);
        const lines = sovFor(app, codes);

        // 1. What the contractor books for this sub equals what the sub billed.
        out.push(close(passedThrough, num(sub.thisPeriod)) ? pass({ where: { vendor: sub.vendor } }) : fail({
          where: { vendor: sub.vendor, ref: sub.commitment },
          expected: num(sub.thisPeriod),
          actual: passedThrough,
          difference: passedThrough - num(sub.thisPeriod),
          detail: `${who} bills ${money(num(sub.thisPeriod))} this period. The contractor passes `
            + `through ${money(passedThrough)} for them across ${codes.join(', ')} — `
            + `${money(Math.abs(passedThrough - num(sub.thisPeriod)))} apart.`,
        }));

        // 2. And that is what reaches the owner on those lines.
        if (lines.length) {
          const billed = sum(lines, l => l.thisPeriod);
          out.push(close(billed, num(sub.thisPeriod)) ? pass({ where: { vendor: sub.vendor, field: 'this period' } }) : fail({
            where: { vendor: sub.vendor, field: 'this period' },
            expected: num(sub.thisPeriod),
            actual: billed,
            difference: billed - num(sub.thisPeriod),
            detail: `${who} bills ${money(num(sub.thisPeriod))}, but the owner is billed `
              + `${money(billed)} on the line(s) that carry their work (${codes.join(', ')}).`,
          }));

          // 3. Continuity across two parties, which is the check nobody runs by hand. If the sub
          //    and the contractor disagree about what was billed BEFORE, one of them has restated
          //    history and the percentages complete are telling different stories to each party.
          if (isNum(sub.previous)) {
            const prior = sum(lines, l => l.previous);
            out.push(close(prior, sub.previous) ? pass({ where: { vendor: sub.vendor, field: 'previous' } }) : fail({
              severity: SEVERITY.MATERIAL,
              where: { vendor: sub.vendor, field: 'previous' },
              expected: sub.previous,
              actual: prior,
              difference: prior - sub.previous,
              detail: `${who} shows ${money(sub.previous)} billed before this period, while the `
                + `owner's schedule shows ${money(prior)} on the same line(s). The two records of `
                + `what has already been paid for this work do not agree.`,
            }));
          }

          // 4. Retainage held from the sub against retainage held from the owner. A contractor
          //    holding less from its subcontractor than the owner holds from it is financing the
          //    difference; holding more is financing itself out of the sub's money.
          if (isNum(sub.retainage)) {
            const held = sum(lines, l => l.retainage);
            out.push(close(held, sub.retainage) ? pass({ where: { vendor: sub.vendor, field: 'retainage' } }) : fail({
              severity: SEVERITY.MATERIAL,
              where: { vendor: sub.vendor, field: 'retainage' },
              expected: sub.retainage,
              actual: held,
              difference: held - sub.retainage,
              detail: `${money(sub.retainage)} of retainage is withheld from ${sub.vendor}, while `
                + `${money(held)} is withheld from the owner on the same line(s).`,
            }));
          }
        }

        // 5. A subcontractor cannot bill past its own contract.
        if (isNum(sub.contractSum) && isNum(sub.totalToDate) && sub.totalToDate - sub.contractSum > TOL.aggregate) {
          out.push(fail({
            where: { vendor: sub.vendor, ref: sub.commitment },
            expected: sub.contractSum,
            actual: sub.totalToDate,
            difference: sub.totalToDate - sub.contractSum,
            detail: `${who} has billed ${money(sub.totalToDate)} to date against a contract of `
              + `${money(sub.contractSum)} — ${money(sub.totalToDate - sub.contractSum)} beyond it, `
              + `with no change order to cover the difference.`,
          }));
        }
      }
      return out;
    },
  },

  // ---- S6  A subcontract charge has a subcontract behind it ---------------------------------------------
  {
    id: 'S6',
    title: 'Every subcontract charge carries a commitment draw reference',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const subEntries = (app.breakdown || []).filter(e =>
        String(e.category || '').toUpperCase() === SUBCONTRACT && num(e.amount) !== 0);
      if (!subEntries.length) return skip('No subcontract charges on this application.');
      const loose = subEntries.filter(e => !commitmentOf(e.ref));
      if (!loose.length) return pass({});
      // Two different things look identical here and must not read the same. An outside vendor
      // billed without a commitment has no subcontract — that is the finding. The contractor's own
      // department billing the job is self-performed work dressed as a subcontract, which is not
      // wrong, but the owner is entitled to know that is what it is.
      const examples = [...new Set(subEntries.filter(e => commitmentOf(e.ref)).map(e => e.ref))].slice(0, 2);
      return loose.map(e => (isAffiliate(app, e.vendor) ? fail({
        severity: SEVERITY.NOTE,
        where: { itemNo: e.code, vendor: e.vendor, ref: e.ref },
        actual: e.amount,
        detail: `${e.vendor} is charged ${money(e.amount)} under ${e.code} as a subcontract, but it `
          + `is the contractor's own department, billing on internal invoice ${e.ref || '(none)'} `
          + `rather than a commitment draw. This is self-performed work, and the rates behind it `
          + `were never competitively bid. Worth confirming the internal rate is the one the `
          + `contract allows, and that any fee inside the internal invoice is not being marked up `
          + `again by the contract fee.`,
      }) : fail({
        where: { itemNo: e.code, vendor: e.vendor, ref: e.ref },
        actual: e.amount,
        detail: `${e.vendor} is charged ${money(e.amount)} under ${e.code} as a subcontract, but the `
          + `reference is ${e.ref || '(none)'} — a vendor invoice number, not a commitment draw. `
          + `Every arm's-length subcontract on this application draws against a commitment`
          + `${examples.length ? ` (${examples.join(', ')})` : ''}. This work is being paid as an `
          + `invoice, which means there is no subcontract covering it: it needs a change order, or `
          + `it belongs on a different contract than the one it is booked to.`,
      })));
    },
  },

  // ---- S7  Sales tax billed to an owner that does not pay sales tax --------------------------------------
  // School districts and other public bodies are tax exempt, and the contractor is expected to buy
  // on the exemption. Tax that slips through is small each time and never questioned, because it
  // is printed on a genuine invoice for a genuine cost.
  {
    id: 'S7',
    title: 'No sales tax is billed to a tax-exempt owner',
    severity: SEVERITY.MATERIAL,
    run(app) {
      if (!app.contract?.ownerTaxExempt) return skip('The owner is not recorded as tax exempt, so tax was not questioned.');
      const taxed = (app.taxes || []).filter(t => num(t.amount) > TOL.cent);
      if (!taxed.length) return skip('No sales tax was found on the backup supplied.');
      const total = sum(taxed, t => t.amount);
      return taxed.map(t => fail({
        where: { itemNo: t.code, vendor: t.vendor, ref: t.ref },
        actual: t.amount,
        detail: `${t.vendor}${t.ref ? ` ${t.ref}` : ''} bills ${money(t.amount)} of sales tax, passed `
          + `through to an owner that is exempt from it.${taxed.length > 1
            ? ` ${money(total)} of tax appears across ${taxed.length} invoices on this application.` : ''}`
          + ` The contractor should be purchasing on the owner's exemption certificate and crediting `
          + `the tax back.`,
      }));
    },
  },

  // ---- S9  The contract fee is not taken on top of another fee -------------------------------------------
  // Small money, every time. It survives because both figures are correct: the internal invoice is
  // entitled to its line, and the contract fee is entitled to its rate, and nobody looks at what
  // the rate is being applied to.
  {
    id: 'S9',
    title: 'The contract fee is not charged on amounts that already include a fee',
    severity: SEVERITY.NOTE,
    run(app) {
      const rate = app.contract?.feeRate;
      const nested = (app.breakdown || []).filter(e => isNum(e.containsFee) && e.containsFee > 0);
      if (!isNum(rate)) return skip('No contract fee rate was captured.');
      if (!nested.length) return skip('No cost entry is recorded as already containing a fee.');
      const total = sum(nested, e => e.containsFee);
      return nested.map(e => fail({
        where: { itemNo: e.code, vendor: e.vendor, ref: e.ref },
        actual: Math.round(e.containsFee * rate * 100) / 100,
        detail: `${e.vendor}'s charge of ${money(e.amount)} under ${e.code} already includes `
          + `${money(e.containsFee)} of its own fee, and the ${pct(rate)} contract fee is then taken `
          + `on the whole amount — ${money(Math.round(e.containsFee * rate * 100) / 100)} of fee `
          + `charged on fee.${nested.length > 1 ? ` ${money(total)} of nested fee appears across `
            + `${nested.length} entries.` : ''} Whether that is allowed is a question for the contract.`,
      }));
    },
  },

  // ---- S8  Say what was not checked -----------------------------------------------------------------
  // Never fails. Most of a package's subcontract charges usually arrive with no application at all,
  // and a report that stays silent about them is claiming a coverage it does not have.
  {
    id: 'S8',
    title: 'Coverage of the subcontract review',
    severity: SEVERITY.NOTE,
    run(app) {
      const subEntries = (app.breakdown || []).filter(e =>
        String(e.category || '').toUpperCase() === SUBCONTRACT && num(e.amount) !== 0);
      const withApp = new Set((app.subApplications || []).flatMap(s =>
        entriesForSub(app, s).map(e => `${e.code}|${e.ref}|${e.amount}`)));
      const bare = subEntries.filter(e => !withApp.has(`${e.code}|${e.ref}|${e.amount}`));
      const parts = [
        `${subEntries.length} subcontract charge(s) totalling ${money(sum(subEntries, e => e.amount))} `
        + `on this application; ${(app.subApplications || []).length} subcontractor application(s) supplied.`,
      ];
      if (bare.length) {
        parts.push(`${bare.length} charge(s) totalling ${money(sum(bare, e => e.amount))} have no `
          + `subcontractor application in the package and could not be tied to one `
          + `(${[...new Set(bare.map(e => e.vendor))].join(', ')}).`);
      }
      if (!(app.orphanDocuments || []).length) return skip(parts.join(' '));
      const orphans = app.orphanDocuments;
      parts.push(`${orphans.length} document(s) totalling ${money(sum(orphans, o => o.amount))} sit in `
        + `the backup with nothing billed against them this period `
        + `(${orphans.map(o => `${o.vendor} ${money(o.amount)}`).join('; ')}) — expected next month, `
        + `but worth confirming they are not billed twice.`);
      return skip(parts.join(' '));
    },
  },
];

function runSubcontractChecks(app) {
  const results = [];
  const stamp = (chk, r) => results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r });

  const gate = SUB_CHECKS.find(c => c.gate);
  const gateResults = [].concat(gate.run(app));
  gateResults.forEach(r => stamp(gate, r));

  if (gateResults.some(r => r.status === 'FAIL')) {
    for (const chk of SUB_CHECKS.filter(c => !c.gate)) {
      stamp(chk, skip("Not attempted: the contractor's breakdown could not be read completely."));
    }
    return summarise(results, []);
  }

  const codes = byCode(app);
  for (const chk of SUB_CHECKS.filter(c => !c.gate)) {
    let produced;
    try {
      produced = chk.run(app, codes);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r => stamp(chk, r));
  }
  return summarise(results, codes);
}

function summarise(results, codes) {
  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  return {
    results,
    findings,
    codes,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      codesTied: codes.filter(g => g.sovLine && close(g.total, num(g.sovLine.thisPeriod))).length,
      codesTotal: codes.length,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.length ? 'certify-with-corrections' : 'no-issues-found',
  };
}

// The table the report prints: the chain, one row per cost code, so a reader can see the whole
// descent from the owner's line to the subcontractor's application at a glance.
function chainTable(app, codes) {
  return codes.map(g => {
    const subs = (app.subApplications || []).filter(s =>
      entriesForSub(app, s).some(e => e.code === g.code));
    return {
      code: g.code,
      description: g.sovLine?.description || '(no schedule line)',
      billedToOwner: g.sovLine ? num(g.sovLine.thisPeriod) : null,
      costEntries: g.entries.length,
      costTotal: g.total,
      ties: !!g.sovLine && close(g.total, num(g.sovLine.thisPeriod)),
      subcontractors: subs.map(s => `${s.vendor} app ${s.applicationNumber}`),
    };
  });
}

module.exports = {
  SUB_CHECKS, runSubcontractChecks, chainTable, byCode, entriesForSub,
  commitmentOf, COMMITMENT_DRAW,
};
