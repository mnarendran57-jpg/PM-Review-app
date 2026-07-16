// Deterministic reconciliation of subcontractor cost breakdowns against the G703, plus
// the "missed and worth noting" checks. Same conventions as payAppChecks.js: plain-English
// wording, pure arithmetic over already-extracted data, no AI calls — a re-run always
// gives the same answer. Check ids: S* (sub reconciliation), N* (missed items).

const { money } = require('./payAppChecks');

const AGG_TOL = 1.0;
// Below this, a missing breakdown or a stalled line is noise rather than a finding.
const MATERIALITY = 1000;

function pass(detail) { return { status: 'PASS', detail }; }
function fail(detail) { return { status: 'FAIL', detail }; }
function skip(detail) { return { status: 'SKIPPED', detail }; }

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findLine(lineItems, breakdown) {
  if (breakdown.matchesItemNo != null) {
    const byNo = lineItems.find(li => String(li.itemNo) === String(breakdown.matchesItemNo));
    if (byNo) return byNo;
  }
  const target = norm(breakdown.matchesDescription) || norm(breakdown.subName);
  if (!target) return null;
  return lineItems.find(li => {
    const d = norm(li.description);
    return d && (d === target || d.includes(target) || target.includes(d));
  }) || null;
}

// Builds Chart 1: each sub breakdown tied back to the G703 line it supports, with the
// difference shown. The chart is rendered even when everything matches — the point is
// the reconciliation itself, not only its failures.
function buildSubReconciliation(current) {
  const breakdowns = current?.subBreakdowns || [];
  const lineItems = current?.lineItems || [];
  const rows = [];
  const results = [];

  if (breakdowns.length === 0) {
    return { rows, results };
  }

  const matchedItemNos = new Set();

  for (const b of breakdowns) {
    const componentsSum = (b.components || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const breakdownTotal = b.statedTotal != null ? Number(b.statedTotal) : componentsSum;

    // The breakdown's own internal math: its printed total vs the sum of its rows.
    if (b.statedTotal != null && (b.components || []).length > 0 && Math.abs(b.statedTotal - componentsSum) > AGG_TOL) {
      results.push({
        id: 'S2', category: 'Sub Breakdown', critical: false,
        description: `Does ${b.subName}'s own breakdown add up?`,
        status: 'FAIL',
        detail: `${b.subName}'s breakdown prints a total of ${money(b.statedTotal)}, but its rows add up to ${money(componentsSum)} — a difference of ${money(b.statedTotal - componentsSum)} inside the breakdown itself.`,
      });
    }

    const line = findLine(lineItems, b);
    if (!line) {
      rows.push({
        subName: b.subName, itemNo: null, lineDescription: null,
        breakdownTotal, comparedTo: null, g703Amount: null,
        difference: null, status: 'unmatched',
      });
      results.push({
        id: 'S3', category: 'Sub Breakdown', critical: false,
        description: `Which billing line does ${b.subName}'s breakdown belong to?`,
        status: 'FAIL',
        detail: `A cost breakdown for ${b.subName} totaling ${money(breakdownTotal)} appears in the document, but it could not be tied to any line on the billing summary — confirm which line it supports.`,
      });
      continue;
    }

    matchedItemNos.add(String(line.itemNo));
    const thisPeriod = (Number(line.e) || 0) + (Number(line.f) || 0);
    const toDate = Number(line.g) || 0;

    // Compare on the basis the document itself states; if it is unclear, accept
    // whichever figure the breakdown actually ties to before calling it a mismatch.
    let comparedTo, g703Amount;
    if (b.basis === 'to-date') {
      comparedTo = 'billed to date'; g703Amount = toDate;
    } else if (b.basis === 'this-period') {
      comparedTo = 'billed this period'; g703Amount = thisPeriod;
    } else if (Math.abs(breakdownTotal - thisPeriod) <= AGG_TOL) {
      comparedTo = 'billed this period'; g703Amount = thisPeriod;
    } else if (Math.abs(breakdownTotal - toDate) <= AGG_TOL) {
      comparedTo = 'billed to date'; g703Amount = toDate;
    } else {
      comparedTo = 'billed this period'; g703Amount = thisPeriod;
    }

    const difference = g703Amount - breakdownTotal;
    const matches = Math.abs(difference) <= AGG_TOL;

    rows.push({
      subName: b.subName, itemNo: line.itemNo, lineDescription: line.description,
      breakdownTotal, comparedTo, g703Amount,
      difference: matches ? 0 : difference, status: matches ? 'match' : 'mismatch',
    });

    if (!matches) {
      results.push({
        id: 'S1', category: 'Sub Breakdown', critical: true,
        description: `Does ${b.subName}'s breakdown support what is billed for them?`,
        status: 'FAIL',
        detail: `The billing summary shows ${money(g703Amount)} ${comparedTo} for "${line.description || 'item ' + line.itemNo}", but ${b.subName}'s own breakdown only supports ${money(breakdownTotal)} — ${money(Math.abs(difference))} ${difference > 0 ? 'more is billed than the breakdown supports' : 'less is billed than the breakdown shows'}. Resolve before approving.`,
      });
    }
  }

  if (!results.some(r => r.id === 'S1')) {
    const matched = rows.filter(r => r.status === 'match').length;
    if (matched > 0) {
      results.push({
        id: 'S1', category: 'Sub Breakdown', critical: true,
        description: 'Do the subcontractor breakdowns support what is billed for them?',
        status: 'PASS',
        detail: `Yes — all ${matched} subcontractor breakdown${matched === 1 ? '' : 's'} in the document tie${matched === 1 ? 's' : ''} out to the billing summary.`,
      });
    }
  }

  return { rows, results, matchedItemNos };
}

// The "missed and worth noting" checks. All need context beyond a single number, which is
// why they live here rather than in the per-line math checks.
function runMissedItemChecks({ current, previous, subReconciliation }) {
  const results = [];
  const currItems = current?.lineItems || [];
  const prevItems = previous?.lineItems || [];

  // N1 — lines that were billed before and have now vanished.
  if (!previous) {
    results.push({
      id: 'N1', category: 'Worth Noting', critical: false,
      description: 'Did any previously billed line items disappear?',
      ...skip('Skipped — no previous application was supplied to compare against.'),
    });
  } else {
    const currByNo = new Set(currItems.map(li => String(li.itemNo)));
    const currDescs = currItems.map(li => norm(li.description)).filter(Boolean);
    const vanished = prevItems.filter(li => {
      const billed = (Number(li.g) || 0) > 0;
      if (!billed) return false;
      if (currByNo.has(String(li.itemNo))) return false;
      const d = norm(li.description);
      return !currDescs.some(cd => cd === d);
    });
    results.push({
      id: 'N1', category: 'Worth Noting', critical: false,
      description: 'Did any previously billed line items disappear?',
      ...(vanished.length === 0
        ? pass('No — every line item billed on the previous application still appears on this one.')
        : fail(vanished.map(li =>
            `"${li.description || 'Item ' + li.itemNo}" had ${money(li.g)} billed on the previous application but does not appear on this one — money already certified against it has gone missing from the schedule.`
          ).join(' '))),
    });
  }

  // N2 — lines billed this period with no supporting breakdown. Only meaningful when the
  // document provides breakdowns at all; a GC who never attaches them isn't hiding one line.
  const hasBreakdowns = (current?.subBreakdowns || []).length > 0;
  if (!hasBreakdowns) {
    results.push({
      id: 'N2', category: 'Worth Noting', critical: false,
      description: 'Is anything billed without a supporting cost breakdown?',
      ...skip('Skipped — this document contains no cost-breakdown sections, so there is nothing to compare coverage against.'),
    });
  } else {
    const matched = subReconciliation?.matchedItemNos || new Set();
    const uncovered = currItems.filter(li => {
      const thisPeriod = (Number(li.e) || 0) + (Number(li.f) || 0);
      return thisPeriod >= MATERIALITY && !matched.has(String(li.itemNo));
    });
    results.push({
      id: 'N2', category: 'Worth Noting', critical: false,
      description: 'Is anything billed without a supporting cost breakdown?',
      ...(uncovered.length === 0
        ? pass('No — every line with meaningful billing this period has a cost breakdown behind it.')
        : fail(uncovered.map(li =>
            `"${li.description || 'Item ' + li.itemNo}" bills ${money((Number(li.e) || 0) + (Number(li.f) || 0))} this period with no breakdown anywhere in the document — if this is subcontractor work, ask for its breakdown.`
          ).join(' '))),
    });
  }

  // N3 — scope lines sitting still while the job moves.
  if (!previous) {
    results.push({
      id: 'N3', category: 'Worth Noting', critical: false,
      description: 'Are any scope items stalled while the rest of the job moves?',
      ...skip('Skipped — no previous application was supplied to compare against.'),
    });
  } else {
    const jobMoved = (Number(current?.summary?.line4) || 0) > (Number(previous?.summary?.line4) || 0);
    if (!jobMoved) {
      results.push({
        id: 'N3', category: 'Worth Noting', critical: false,
        description: 'Are any scope items stalled while the rest of the job moves?',
        ...skip('Skipped — overall billing did not move between applications, so per-line stalls mean nothing this period.'),
      });
    } else {
      const prevByNo = new Map(prevItems.map(li => [String(li.itemNo), li]));
      const stalled = currItems.filter(li => {
        const prev = prevByNo.get(String(li.itemNo));
        if (!prev) return false;
        const g = Number(li.g) || 0;
        const c = Number(li.c) || 0;
        const started = g > 0;
        const complete = c > 0 && g >= c - AGG_TOL;
        return c >= MATERIALITY && started && !complete && Math.abs(g - (Number(prev.g) || 0)) <= AGG_TOL;
      });
      results.push({
        id: 'N3', category: 'Worth Noting', critical: false,
        description: 'Are any scope items stalled while the rest of the job moves?',
        ...(stalled.length === 0
          ? pass('No — every started, unfinished line item moved this period.')
          : fail(stalled.map(li =>
              `"${li.description || 'Item ' + li.itemNo}" has sat at ${money(li.g)} of its ${money(li.c)} budget with no progress this period while the rest of the job moved — worth asking why.`
            ).join(' '))),
      });
    }
  }

  return results;
}

module.exports = { buildSubReconciliation, runMissedItemChecks };
