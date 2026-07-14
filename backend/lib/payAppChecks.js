// Table-driven validation checks for AIA G702/G703-style pay applications.
//
// Wording note: every "description" and "detail" string here is written for a client or
// PM with no construction-accounting background — plain dollar amounts and short sentences,
// no "Line 3" / "ΣG" jargon. The check "id" (A1, B3, etc.) still exists for the JSON export
// and internal debugging, but is not meant to be shown front-and-center in the UI.
//
// Expected shape of the `data` object passed to runChecks():
// {
//   current: {
//     summary: {
//       applicationNumber, periodTo, projectName, contractDate,
//       line1, line2, line3, line4,
//       line5aRate, line5aAmount, line5bRate, line5bAmount, line5,
//       line6, line7, line8, line9,
//       changeOrderSummary: { additions, deductions, net } | null
//     },
//     lineItems: [{ itemNo, description, c, d, e, f, g, h, retainage }],
//     grandTotalRow: { c, d, e, f, g, h } | null,
//     coBreakdown: [{ coNumber, amount }] | null
//   },
//   previous: (same shape as current.summary/lineItems) | null,
//   contract: { originalContractSum, changeOrderLog: [{ coNumber, amount }] } | null,
//   retainagePolicy: { rate, reductionMilestonePct, reducedRate } | null
// }

const LINE_TOL = 0.02;
const AGG_TOL = 1.0;

function close(a, b, tol) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tol;
}

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

function sum(items, key) {
  return items.reduce((acc, it) => acc + (Number(it[key]) || 0), 0);
}

function pass(detail) { return { status: 'PASS', detail }; }
function fail(detail) { return { status: 'FAIL', detail }; }
function skip(detail) { return { status: 'SKIPPED', detail }; }

function itemLabel(li) { return `"${li.description || 'Item ' + li.itemNo}" (item #${li.itemNo})`; }

// Each check: { id, category, critical, description, run(data) => {status, detail} }
const CHECKS = [
  // A. Continuation sheet, per line item
  {
    id: 'A1', category: 'Continuation Sheet', critical: false,
    description: 'Do the billed amounts add up correctly for each item?',
    run: ({ current }) => {
      const bad = current.lineItems.filter(li => !close(li.g, (li.d || 0) + (li.e || 0) + (li.f || 0), LINE_TOL));
      if (bad.length === 0) return pass(`Yes — for all ${current.lineItems.length} items, previously billed + billed this period + stored materials adds up to the total billed to date.`);
      return fail(bad.map(li => `${itemLabel(li)}: total billed to date shows ${money(li.g)}, but the pieces add up to ${money((li.d||0)+(li.e||0)+(li.f||0))} instead.`).join(' '));
    }
  },
  {
    id: 'A2', category: 'Continuation Sheet', critical: false,
    description: 'Does the remaining budget shown for each item add up correctly?',
    run: ({ current }) => {
      const bad = current.lineItems.filter(li => li.h != null && !close(li.h, (li.c || 0) - (li.g || 0), LINE_TOL));
      if (bad.length === 0) return pass('Yes — the remaining budget shown for every item matches (budget minus total billed to date).');
      return fail(bad.map(li => `${itemLabel(li)}: remaining budget shows ${money(li.h)}, but budget minus billed-to-date works out to ${money((li.c||0)-(li.g||0))}.`).join(' '));
    }
  },
  {
    id: 'A3', category: 'Continuation Sheet', critical: false,
    description: 'Does the "percent complete" shown for each item match its billed amount?',
    run: ({ current }) => {
      const bad = current.lineItems.filter(li => {
        if (li.pctComplete == null || !li.c) return false;
        const computed = (li.g / li.c) * 100;
        return Math.abs(computed - li.pctComplete) > 0.5;
      });
      if (bad.length === 0) return pass('Yes — the percent-complete shown matches the billed amount for every item.');
      return fail(bad.map(li => `${itemLabel(li)}: shown as ${li.pctComplete}% complete, but the billed amount works out to ${((li.g/li.c)*100).toFixed(1)}%.`).join(' '));
    }
  },
  {
    id: 'A4', category: 'Continuation Sheet', critical: true,
    description: 'Has any individual item been billed for more than its own budget?',
    run: ({ current }) => {
      const bad = current.lineItems.filter(li => (li.g || 0) - (li.c || 0) > LINE_TOL);
      if (bad.length === 0) return pass('No — no item has been billed for more than its own budgeted amount.');
      return fail(bad.map(li => `${itemLabel(li)} has been billed ${money(li.g)} total, which is ${money(li.g - li.c)} more than its ${money(li.c)} budget. This looks like overbilling and should not be approved as-is.`).join(' '));
    }
  },
  {
    id: 'A5', category: 'Continuation Sheet', critical: false,
    description: 'Does the amount held back (retainage) on each item match the agreed rate?',
    run: ({ current, retainagePolicy }) => {
      const hasVariableCol = current.lineItems.some(li => li.retainage != null);
      if (!hasVariableCol) return skip('Not applicable — this pay application does not hold back a different retainage amount per item.');
      const rate = retainagePolicy?.rate;
      if (rate == null) return skip('Skipped — no agreed retainage rate was provided to check against.');
      const bad = current.lineItems.filter(li => li.retainage != null && !close(li.retainage, li.g * rate, LINE_TOL));
      if (bad.length === 0) return pass('Yes — the amount held back matches the agreed rate for every item.');
      return fail(bad.map(li => `${itemLabel(li)}: holding back ${money(li.retainage)}, but the agreed rate on the billed amount works out to ${money(li.g * rate)}.`).join(' '));
    }
  },

  // B. Subtotals / grand total tie-outs
  {
    id: 'B1', category: 'Subtotals', critical: false,
    description: 'Does the grand-total row at the bottom of the item list match the sum of all items?',
    run: ({ current }) => {
      if (!current.grandTotalRow) return skip('Skipped — no separate grand-total row was found to check against the item list.');
      const cols = ['c', 'd', 'e', 'f', 'g', 'h'];
      const labels = { c: 'budgeted amounts', d: 'previously billed', e: 'billed this period', f: 'stored materials', g: 'total billed to date', h: 'remaining budget' };
      const mismatches = cols.filter(col => {
        const computed = sum(current.lineItems, col);
        const stated = current.grandTotalRow[col];
        return stated != null && !close(computed, stated, AGG_TOL);
      });
      if (mismatches.length === 0) return pass('Yes — the grand-total row matches the sum of all individual items.');
      return fail(mismatches.map(col => `For ${labels[col]}: the grand-total row shows ${money(current.grandTotalRow[col])}, but the items add up to ${money(sum(current.lineItems, col))}.`).join(' '));
    }
  },
  {
    id: 'B2', category: 'Subtotals', critical: false,
    description: 'Do the page-by-page subtotals add up to the grand total?',
    run: ({ current }) => {
      if (!current.pageSubtotals || current.pageSubtotals.length === 0) {
        return skip('Skipped — this document does not print separate subtotals per page.');
      }
      const cols = ['c', 'd', 'e', 'f', 'g', 'h'];
      const labels = { c: 'budgeted amounts', d: 'previously billed', e: 'billed this period', f: 'stored materials', g: 'total billed to date', h: 'remaining budget' };
      const totals = cols.reduce((acc, col) => { acc[col] = sum(current.pageSubtotals, col); return acc; }, {});
      const target = current.grandTotalRow;
      if (!target) return skip('Skipped — no grand-total row to compare the page subtotals against.');
      const mismatches = cols.filter(col => target[col] != null && !close(totals[col], target[col], AGG_TOL));
      if (mismatches.length === 0) return pass('Yes — the page subtotals add up to the grand total.');
      return fail(mismatches.map(col => `For ${labels[col]}: the page subtotals add up to ${money(totals[col])}, but the grand total shows ${money(target[col])}.`).join(' '));
    }
  },
  {
    id: 'B3', category: 'Summary Tie-Out', critical: true,
    description: 'Does the total budget across all items match the contract total on the summary page?',
    run: ({ current }) => {
      const total = sum(current.lineItems, 'c');
      if (close(total, current.summary.line3, AGG_TOL)) return pass(`Yes — the sum of all item budgets (${money(total)}) matches the total contract amount on the summary page.`);
      return fail(`The sum of all item budgets is ${money(total)}, but the summary page shows the total contract amount as ${money(current.summary.line3)} — these should match exactly.`);
    }
  },
  {
    id: 'B4', category: 'Summary Tie-Out', critical: true,
    description: 'Does the total work billed to date across all items match the summary page?',
    run: ({ current }) => {
      const total = sum(current.lineItems, 'g');
      if (close(total, current.summary.line4, AGG_TOL)) return pass(`Yes — the sum of all items billed to date (${money(total)}) matches the summary page.`);
      return fail(`The sum of all items billed to date is ${money(total)}, but the summary page shows ${money(current.summary.line4)} — these should match exactly.`);
    }
  },
  {
    id: 'B5', category: 'Summary Tie-Out', critical: false,
    description: 'Does the amount billed this period match the increase in total work since last time?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      const periodActivity = sum(current.lineItems, 'e') + sum(current.lineItems, 'f');
      const impliedPeriodActivity = (current.summary.line4 || 0) - (previous.summary.line4 || 0);
      if (close(periodActivity, impliedPeriodActivity, AGG_TOL)) return pass(`Yes — the ${money(periodActivity)} billed this period matches the increase in total work completed since the last application.`);
      return fail(`This period's items add up to ${money(periodActivity)} of new billing, but the total-completed amount only increased by ${money(impliedPeriodActivity)} since the last application — these should match.`);
    }
  },

  // C. Summary sheet internal math
  {
    id: 'C1', category: 'Summary Math', critical: false,
    description: 'Does the total contract amount equal the original contract plus approved changes?',
    run: ({ current: { summary: s } }) => close(s.line3, (s.line1 || 0) + (s.line2 || 0), AGG_TOL)
      ? pass(`Yes — the original contract (${money(s.line1)}) plus approved changes (${money(s.line2)}) equals the total contract amount (${money(s.line3)}).`)
      : fail(`The original contract (${money(s.line1)}) plus approved changes (${money(s.line2)}) should equal ${money((s.line1||0)+(s.line2||0))}, but the total contract amount shown is ${money(s.line3)}.`)
  },
  {
    id: 'C2', category: 'Summary Math', critical: false,
    description: 'Does the amount held back on completed work match the agreed retainage percentage?',
    run: ({ current, retainagePolicy }) => {
      const rate = current.summary.line5aRate ?? retainagePolicy?.rate;
      if (rate == null) return skip('Skipped — no retainage percentage for completed work was found or provided.');
      const base = sum(current.lineItems, 'd') + sum(current.lineItems, 'e');
      const expected = base * rate;
      if (close(current.summary.line5aAmount, expected, AGG_TOL)) return pass(`Yes — the ${money(current.summary.line5aAmount)} held back on completed work matches ${(rate*100).toFixed(2)}% of the ${money(base)} completed.`);
      return fail(`${(rate*100).toFixed(2)}% held back on ${money(base)} of completed work should be ${money(expected)}, but the amount shown is ${money(current.summary.line5aAmount)}.`);
    }
  },
  {
    id: 'C3', category: 'Summary Math', critical: false,
    description: 'Does the amount held back on stored materials match the agreed retainage percentage?',
    run: ({ current }) => {
      const rate = current.summary.line5bRate;
      const sigmaF = sum(current.lineItems, 'f');
      if (rate == null) {
        if (!sigmaF) return skip('Not applicable — no materials are being stored this period.');
        return skip('Skipped — no retainage percentage for stored materials was found.');
      }
      const expected = sigmaF * rate;
      if (close(current.summary.line5bAmount, expected, AGG_TOL)) return pass(`Yes — the ${money(current.summary.line5bAmount)} held back on stored materials matches ${(rate*100).toFixed(2)}% of ${money(sigmaF)}.`);
      return fail(`${(rate*100).toFixed(2)}% held back on ${money(sigmaF)} of stored materials should be ${money(expected)}, but the amount shown is ${money(current.summary.line5bAmount)}.`);
    }
  },
  {
    id: 'C4', category: 'Summary Math', critical: false,
    description: 'Does the total amount held back equal the two retainage pieces added together?',
    run: ({ current: { summary: s } }) => close(s.line5, (s.line5aAmount || 0) + (s.line5bAmount || 0), AGG_TOL)
      ? pass(`Yes — ${money(s.line5aAmount)} plus ${money(s.line5bAmount)} equals the total held back (${money(s.line5)}).`)
      : fail(`${money(s.line5aAmount)} plus ${money(s.line5bAmount)} should total ${money((s.line5aAmount||0)+(s.line5bAmount||0))}, but the total amount held back shown is ${money(s.line5)}.`)
  },
  {
    id: 'C5', category: 'Summary Math', critical: false,
    description: 'Does the amount earned so far equal total work done minus the amount held back?',
    run: ({ current: { summary: s } }) => close(s.line6, (s.line4 || 0) - (s.line5 || 0), AGG_TOL)
      ? pass(`Yes — total work done (${money(s.line4)}) minus the amount held back (${money(s.line5)}) equals the amount earned so far (${money(s.line6)}).`)
      : fail(`Total work done (${money(s.line4)}) minus the amount held back (${money(s.line5)}) should be ${money((s.line4||0)-(s.line5||0))}, but the amount earned so far shown is ${money(s.line6)}.`)
  },
  {
    id: 'C6', category: 'Summary Math', critical: false,
    description: 'Does the payment due now equal what’s earned so far minus what’s already been paid?',
    run: ({ current: { summary: s } }) => close(s.line8, (s.line6 || 0) - (s.line7 || 0), AGG_TOL)
      ? pass(`Yes — amount earned so far (${money(s.line6)}) minus what's already been paid (${money(s.line7)}) equals the payment due now (${money(s.line8)}).`)
      : fail(`Amount earned so far (${money(s.line6)}) minus what's already been paid (${money(s.line7)}) should be ${money((s.line6||0)-(s.line7||0))}, but the payment due now shown is ${money(s.line8)}.`)
  },
  {
    id: 'C7', category: 'Summary Math', critical: false,
    description: 'Does the remaining contract balance equal the total contract minus what’s been earned?',
    run: ({ current: { summary: s } }) => close(s.line9, (s.line3 || 0) - (s.line6 || 0), AGG_TOL)
      ? pass(`Yes — the total contract amount (${money(s.line3)}) minus what's been earned (${money(s.line6)}) equals the remaining balance (${money(s.line9)}).`)
      : fail(`Total contract amount (${money(s.line3)}) minus what's been earned (${money(s.line6)}) should be ${money((s.line3||0)-(s.line6||0))}, but the remaining balance shown is ${money(s.line9)}.`)
  },
  {
    id: 'C8', category: 'Summary Math', critical: true,
    description: 'Is the contractor billing for more than the total contract allows, overall?',
    run: ({ current: { summary: s } }) => (s.line4 || 0) - (s.line3 || 0) > AGG_TOL
      ? fail(`Yes — total work completed and stored so far (${money(s.line4)}) is ${money(s.line4 - s.line3)} MORE than the total contract amount (${money(s.line3)}). This should not be approved as-is.`)
      : pass(`No — total work completed and stored so far (${money(s.line4)}) does not exceed the total contract amount (${money(s.line3)}).`)
  },

  // D. Cross-application checks
  {
    id: 'D1', category: 'Cross-Application', critical: true,
    description: 'Does this payment application correctly show what was already paid before?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      if (close(current.summary.line7, previous.summary.line6, AGG_TOL)) return pass(`Yes — the "already paid" amount on this application (${money(current.summary.line7)}) matches what was earned on the previous application.`);
      return fail(`The "already paid" amount on this application is ${money(current.summary.line7)}, but the previous application shows ${money(previous.summary.line6)} was earned — these should match exactly.`);
    }
  },
  {
    id: 'D2', category: 'Cross-Application', critical: false,
    description: 'Does each item’s "previously billed" amount match what was billed last time?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      const prevByItem = new Map(previous.lineItems.map(li => [String(li.itemNo), li]));
      const mismatches = [];
      for (const li of current.lineItems) {
        const prev = prevByItem.get(String(li.itemNo));
        if (!prev) continue;
        if (!close(li.d, prev.g, LINE_TOL)) {
          mismatches.push(`${itemLabel(li)}: shows ${money(li.d)} billed before this period, but the previous application shows ${money(prev.g)} billed to date.`);
        }
      }
      if (mismatches.length === 0) return pass('Yes — every item\'s "previously billed" amount matches the previous application\'s totals.');
      return fail(mismatches.join(' '));
    }
  },
  {
    id: 'D3', category: 'Cross-Application', critical: false,
    description: 'Is this application numbered correctly, following right after the last one?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      const diff = (current.summary.applicationNumber ?? NaN) - (previous.summary.applicationNumber ?? NaN);
      if (diff === 1) return pass(`Yes — Application #${current.summary.applicationNumber} correctly follows #${previous.summary.applicationNumber}.`);
      return fail(`The application number jumped from #${previous.summary.applicationNumber} to #${current.summary.applicationNumber} — normally it should increase by exactly 1.`);
    }
  },
  {
    id: 'D4', category: 'Cross-Application', critical: false,
    description: 'Does this billing period come after the last one, with no overlap?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      const cur = new Date(current.summary.periodTo);
      const prev = new Date(previous.summary.periodTo);
      if (isNaN(cur) || isNaN(prev)) return skip('Skipped — could not read one or both billing period dates.');
      if (cur > prev) return pass(`Yes — this billing period (ending ${current.summary.periodTo}) comes after the previous one (ending ${previous.summary.periodTo}).`);
      return fail(`This billing period (ending ${current.summary.periodTo}) does not come after the previous one (ending ${previous.summary.periodTo}) — check for a date error or overlapping billing periods.`);
    }
  },
  {
    id: 'D5', category: 'Cross-Application', critical: false,
    description: 'If the contract amount changed, is it backed up by a listed change order?',
    run: ({ current, previous }) => {
      if (!previous) return skip('Skipped — no previous application was supplied to compare against.');
      const delta = (current.summary.line2 || 0) - (previous.summary.line2 || 0);
      if (Math.abs(delta) <= AGG_TOL) return pass('Yes — the approved-changes total is unchanged from the previous application, so there\'s nothing new to verify here.');
      if (!current.coBreakdown || current.coBreakdown.length === 0) {
        return skip(`The approved-changes total went up by ${money(delta)} since the last application, but no change-order breakdown was found to verify it against.`);
      }
      const coTotal = sum(current.coBreakdown, 'amount');
      if (close(coTotal, current.summary.line2, AGG_TOL)) return pass(`Yes — the ${money(delta)} change since the last application is backed up by the change orders listed (totaling ${money(coTotal)}).`);
      return fail(`The approved-changes total went up by ${money(delta)}, but the change orders listed only add up to ${money(coTotal)} — not matching the ${money(current.summary.line2)} shown.`);
    }
  },

  // E. Contract-level checks
  {
    id: 'E1', category: 'Contract-Level', critical: false,
    description: 'Does the original contract amount match what’s on file?',
    run: ({ current, contract }) => {
      if (contract?.originalContractSum == null) return skip('Skipped — no original contract amount was provided to check against.');
      if (close(current.summary.line1, contract.originalContractSum, AGG_TOL)) return pass(`Yes — the original contract amount (${money(current.summary.line1)}) matches what's on file.`);
      return fail(`The original contract amount shown is ${money(current.summary.line1)}, but the amount on file is ${money(contract.originalContractSum)} — these should match.`);
    }
  },
  {
    id: 'E2', category: 'Contract-Level', critical: false,
    description: 'Does the total of approved changes match your change order log?',
    run: ({ current, contract }) => {
      if (!contract?.changeOrderLog || contract.changeOrderLog.length === 0) return skip('Skipped — no change order log was provided to check against.');
      const logTotal = sum(contract.changeOrderLog, 'amount');
      if (close(current.summary.line2, logTotal, AGG_TOL)) return pass(`Yes — approved changes (${money(current.summary.line2)}) match your change order log total.`);
      return fail(`Approved changes on this application total ${money(current.summary.line2)}, but your change order log totals ${money(logTotal)} — these should match.`);
    }
  },
  {
    id: 'E3', category: 'Contract-Level', critical: false,
    description: 'Does every change order match between this application and your change order log?',
    run: ({ current, contract }) => {
      if (!contract?.changeOrderLog || contract.changeOrderLog.length === 0) return skip('Skipped — no change order log was provided to check against.');
      if (!current.coBreakdown || current.coBreakdown.length === 0) return skip('Skipped — this application doesn\'t list individual change orders to compare.');
      const logNumbers = new Set(contract.changeOrderLog.map(c => String(c.coNumber)));
      const appNumbers = new Set(current.coBreakdown.map(c => String(c.coNumber)));
      const missingFromLog = [...appNumbers].filter(n => !logNumbers.has(n));
      const missingFromApp = [...logNumbers].filter(n => !appNumbers.has(n));
      if (missingFromLog.length === 0 && missingFromApp.length === 0) return pass('Yes — every change order matches between this application and your log.');
      const parts = [];
      if (missingFromLog.length) parts.push(`Listed on this application but not in your log: ${missingFromLog.join(', ')}.`);
      if (missingFromApp.length) parts.push(`In your log but not on this application: ${missingFromApp.join(', ')}.`);
      return fail(parts.join(' '));
    }
  },
  {
    id: 'E4', category: 'Contract-Level', critical: false,
    description: 'Is the amount being held back (retainage) the correct percentage per your contract?',
    run: ({ current, retainagePolicy }) => {
      if (!retainagePolicy?.rate) return skip('Skipped — no contract retainage policy was provided to check against.');
      const pctComplete = current.summary.line3 ? (current.summary.line4 || 0) / current.summary.line3 : null;
      let expectedRate = retainagePolicy.rate;
      if (retainagePolicy.reductionMilestonePct != null && pctComplete != null && pctComplete * 100 >= retainagePolicy.reductionMilestonePct) {
        expectedRate = retainagePolicy.reducedRate ?? retainagePolicy.rate;
      }
      const statedRate = current.summary.line5aRate;
      if (statedRate == null) return skip('Skipped — no retainage percentage was found on the pay application.');
      if (Math.abs(statedRate - expectedRate) <= 0.001) return pass(`Yes — the ${(statedRate*100).toFixed(2)}% held back matches your contract's retainage policy.`);
      return fail(`This application holds back ${(statedRate*100).toFixed(2)}%, but your contract policy calls for ${(expectedRate*100).toFixed(2)}%${pctComplete != null ? ` at this stage (project is ${(pctComplete*100).toFixed(1)}% complete)` : ''}.`);
    }
  },
];

function runChecks(data) {
  return CHECKS.map(check => {
    let result;
    try {
      result = check.run(data);
    } catch (err) {
      result = skip(`We couldn't finish this check — some expected information was missing or in an unexpected format (${err.message}).`);
    }
    return { id: check.id, category: check.category, critical: check.critical, description: check.description, ...result };
  });
}

module.exports = { CHECKS, runChecks, money, sum };
