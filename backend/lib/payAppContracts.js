// Each party's billing, against the contract signed with that party.
//
// The eighth family, and the one that finally uses the word "contract" to mean something specific.
// Every other engine checks the package against itself: the columns against each other, a line
// against its documents, a subcontractor's total against the lines carrying their scope. Correct
// arithmetic on an agreement nobody read.
//
// What makes this possible is that a project can now hold several contracts, each recorded with
// the party it was signed with. A CMAR job runs on the owner-contractor agreement plus a
// subcontract behind every subcontractor billing through it, and those subcontracts do not share
// terms — a demolition sub retained at 10% and a tree sub retained at 5% are both correct, and
// measuring either against the contractor's own 5% produces a confident finding about nothing.
//
// So the rule is one line long: EVERY contract on file is checked, and each against the party it
// belongs to. What that requires is matching a contract to a biller, which is done in this order:
//
//   1. the commitment number, when both documents print one — unambiguous
//   2. the party name against the biller's name
//   3. nothing. A contract that cannot be matched is REPORTED as unmatched rather than applied to
//      the nearest candidate, because the whole value here is that a subcontractor is measured
//      against their own agreement and not against somebody else's.
//
// DELIVERY METHOD is the other half, and it exists to stop the review nagging. A CSP application
// is the general contractor billing directly, with a release of lien behind it; a CMAR application
// carries every subcontractor's own application too. Told nothing, a review treats the first as an
// incomplete version of the second and reports missing subcontractor paperwork on a package that
// was never going to have any. Told which it is, absence means something — or means nothing — and
// the report can say which.

const { SEVERITY, TOL, money } = require('./payAppInvariants');
const { vendorTokens, vendorAcronym } = require('./payAppVendorRollup');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : 0);
const sum = (list, f) => (list || []).reduce((a, x) => a + num(f(x)), 0);
const pct = r => `${(r * 100).toFixed(r * 100 % 1 ? 2 : 0)}%`;

const CSP = 'CSP';
const CMAR = 'CMAR';

// A rate read off a form is a rounded rate. 5% withheld from $103,980 is $5,199.00 exactly, but
// a sub whose retainage was reduced mid-contract lands a few basis points off, and calling that a
// breach of contract would be wrong every time.
const RATE_TOLERANCE = 0.0025;      // a quarter of a percentage point

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --- matching a contract to whoever is billing under it -------------------------------------------

// Commitment numbers are printed with wildly varying punctuation — "253016-004", "253016 004",
// "#253016.004" — and comparing them as written misses most real matches.
const commitmentKey = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();

function samePart(a, b) {
  if (!a || !b) return false;
  const tokens = vendorTokens(a);
  const acronym = vendorAcronym(a);
  const hay = norm(b);
  if (tokens.length && tokens.some(t => hay.replace(/ /g, '').includes(t))) return true;
  return !!acronym && new RegExp(`\\b${acronym}\\b`).test(hay);
}

// Which biller does this contract govern? Billers are the prime (the application itself) and every
// subcontractor who enclosed their own application.
function billerFor(app, contract) {
  const subs = app.subApplications || [];

  const key = commitmentKey(contract.commitment);
  if (key) {
    const byCommitment = subs.find(s => commitmentKey(s.commitment) === key);
    if (byCommitment) return { kind: 'subcontractor', how: 'commitment number', sub: byCommitment };
  }

  // The prime is whoever the application itself is from. Its role is usually declared; where it is
  // not, a name match against the contractor is just as good.
  if (contract.partyRole === 'prime'
    || (contract.party && samePart(contract.party, app.meta?.contractor))) {
    return { kind: 'prime', how: contract.partyRole === 'prime' ? 'stated on the contract' : 'party name' };
  }

  if (contract.party) {
    const hits = subs.filter(s => samePart(contract.party, s.vendor));
    // Two subcontractors matching one contract means the name is not distinguishing them, and
    // picking either would measure somebody against an agreement that is not theirs.
    if (hits.length === 1) return { kind: 'subcontractor', how: 'party name', sub: hits[0] };
  }
  return null;
}

// Everything worth saying about one contract, worked out once.
function survey(app) {
  return (app.contracts || []).map((contract) => {
    const biller = billerFor(app, contract);
    const t = contract.terms || {};
    const value = isNum(t.originalContractSum) ? t.originalContractSum : null;

    // What that party actually says they are billing under.
    let billed = null;
    if (biller?.kind === 'prime') {
      billed = {
        who: app.meta?.contractor || 'the contractor',
        contractSum: app.summary?.line3 ?? null,
        originalSum: app.summary?.line1 ?? null,
        changes: app.summary?.line2 ?? null,
        toDate: app.summary?.line4 ?? null,
        retainage: app.summary?.line5 ?? app.summary?.line5Total ?? null,
        retainageBase: app.summary?.line4 ?? null,
      };
    } else if (biller?.kind === 'subcontractor') {
      const s = biller.sub;
      billed = {
        who: s.vendor,
        contractSum: isNum(s.contractSum) ? s.contractSum : null,
        originalSum: null,
        changes: null,
        toDate: isNum(s.totalToDate) ? s.totalToDate : null,
        retainage: isNum(s.retainage) ? s.retainage : null,
        retainageBase: isNum(s.totalToDate) ? s.totalToDate : null,
        statedRate: isNum(s.retainageRate) ? s.retainageRate : null,
      };
    }

    const actualRate = billed && isNum(billed.retainage) && num(billed.retainageBase) > 0
      ? billed.retainage / billed.retainageBase : (billed?.statedRate ?? null);

    return { contract, biller, terms: t, value, billed, actualRate };
  });
}

const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });
const named = c => c.party || c.label || c.fileName || 'an unnamed contract';

const CONTRACT_CHECKS = [
  // ---- K1  Which parties are covered by a contract, and which are not ---------------------------
  // The delivery method earns its keep here and nowhere else. On a CSP application there is one
  // agreement and one biller, and asking after subcontracts would be asking after documents that
  // do not exist. On a CMAR application a subcontractor billing with no subcontract on file is a
  // genuine hole: nothing states what they are entitled to, so nothing below can check it.
  {
    id: 'K1',
    title: 'Every party billing on this application has a governing document on file',
    severity: SEVERITY.MATERIAL,
    run(app, rows) {
      const method = app.deliveryMethod;
      const subs = app.subApplications || [];
      const matched = rows.filter(r => r.biller);
      const hasPrime = matched.some(r => r.biller.kind === 'prime');
      const out = [];

      // A contract still being read is not a missing contract, and the difference matters: told
      // the wrong one, the reader goes looking for a document that is already uploaded. Reading a
      // long agreement takes minutes, so a review run straight after an upload lands here.
      const pending = app.contractsPending || [];
      if (pending.length) {
        out.push({
          status: 'SKIPPED',
          severity: SEVERITY.NOTE,
          detail: `${pending.length} document(s) on this project are still being read `
            + `(${pending.map(c => c.party || c.label || c.fileName).join(', ')}), so their terms `
            + 'were not available to this review. Nothing is missing — review the application '
            + 'again once they finish and the checks below will cover them.',
        });
      }

      // Nothing on file is NOT a failure, on either delivery method.
      //
      // Plenty of jobs never have a contract to upload. Below a client's threshold there is no
      // executed agreement at all: the vendor proposes, the architect, engineer and PM accept, a
      // purchase order is issued, and the work runs from there. Reporting that as a finding was
      // an accusation about a document that was never going to exist, on a job being run exactly
      // as intended — and the PM cannot fix it by uploading anything.
      //
      // It is still recorded, as a skip rather than in silence. A report that simply said nothing
      // here would read as though the contract checks had run and passed, and a reader has no way
      // to tell the difference between "measured and correct" and "never measured".
      if (!rows.length) {
        out.push(skip(pending.length
          ? 'No governing document with readable terms is on file yet, so nothing on this '
            + 'application was checked against an agreement — only against itself.'
          : 'No contract or purchase order is on file, so nothing on this application was checked '
            + 'against an agreement — only against itself. The arithmetic, retainage and '
            + 'continuity checks all ran as normal. Upload one if you want the contract sum, '
            + 'retainage rate and tax rules checked too.', { severity: SEVERITY.NOTE }));
        return out;
      }

      if (!hasPrime) {
        out.push({
          status: 'FAIL',
          severity: SEVERITY.NOTE,
          detail: `${rows.length} contract(s) are on file but none of them is the agreement with `
            + `${app.meta?.contractor || 'the contractor submitting this application'}. The `
            + 'contract sum, retainage rate and tax rules on the application itself are therefore '
            + 'unchecked. If one of the contracts on file IS theirs, correcting the party name on '
            + 'it is all this needs.',
        });
      }

      // Subcontractors billing with nothing behind them. Only asked on CMAR, and only about subs
      // who actually enclosed an application — a name on a schedule line is not a claim.
      if (method === CMAR) {
        const uncovered = subs.filter(s => !matched.some(r =>
          r.biller.kind === 'subcontractor' && r.biller.sub === s));
        if (uncovered.length) {
          out.push({
            status: 'FAIL',
            severity: SEVERITY.MATERIAL,
            actual: sum(uncovered, s => s.thisPeriod),
            detail: `${uncovered.length} subcontractor(s) are billing through this application with `
              + `no subcontract on file: ${uncovered.map(s => s.vendor).join(', ')}. Between them `
              + `they bill ${money(sum(uncovered, s => s.thisPeriod))} this period. Nothing states `
              + 'what they are entitled to, so their contract sum, retainage and scope were not '
              + 'checked against anything.',
          });
        }
      }

      const unmatched = rows.filter(r => !r.biller);
      if (unmatched.length) {
        out.push({
          status: 'FAIL',
          severity: SEVERITY.NOTE,
          detail: `${unmatched.length} contract(s) on file could not be tied to anyone billing on `
            + `this application: ${unmatched.map(r => named(r.contract)).join(', ')}. They were not `
            + 'applied to anybody — a contract measured against the wrong party is worse than one '
            + 'left out. Either that party is not billing this month, or the contract needs the '
            + 'company name or commitment number filled in.',
        });
      }

      if (out.length) return out;
      return {
        status: 'PASS',
        detail: `${matched.length} contract(s) on file, each tied to the party billing under it`
          + `${method === CSP ? '. This is a CSP application, so the contractor bills directly and '
            + 'no subcontracts are expected' : ''}.`,
      };
    },
  },

  // ---- K2  The contract sum being billed against is the contract's -------------------------------
  {
    id: 'K2',
    title: 'Each party bills against the contract sum in their own agreement',
    severity: SEVERITY.MATERIAL,
    run(app, rows) {
      const checkable = rows.filter(r => r.biller && isNum(r.value) && isNum(r.billed?.contractSum));
      if (!checkable.length) {
        return skip('No contract on file states an original contract sum that could be compared '
          + 'against what is being billed under it.');
      }
      const out = [];
      for (const r of checkable) {
        const stated = r.billed.contractSum;
        // The application's contract sum to date legitimately exceeds the original by the approved
        // changes. Where the application states those separately, they are allowed for; where it
        // does not, only an UNDERSTATEMENT is a finding, because an increase has an innocent
        // explanation and a decrease does not.
        const changes = isNum(r.billed.changes) ? r.billed.changes : null;
        const expected = changes != null ? r.value + changes : null;
        const diff = Math.round((stated - (expected ?? r.value)) * 100) / 100;
        if (Math.abs(diff) <= TOL.aggregate) continue;

        // Billing against MORE than the contract on file, with no change orders stated on the
        // application to explain it. The innocent reading is the usual one — a subcontractor's own
        // G702 states a contract sum to date that already includes their approved changes, and the
        // changes themselves are on a page nobody extracted. So this is raised as a question about
        // paperwork rather than as an overbill, which is what it would be if the contract on file
        // really were the whole agreement.
        if (expected == null && diff > 0) {
          out.push({
            status: 'FAIL',
            severity: SEVERITY.NOTE,
            where: { vendor: r.billed.who },
            expected: r.value,
            actual: stated,
            difference: diff,
            detail: `${r.billed.who} is billing against ${money(stated)} and the contract on file `
              + `is ${money(r.value)}, so ${money(diff)} of change orders are being relied on that `
              + 'are not on the contract this review holds. That is normal — a subcontract gets '
              + 'amended and the amendment is filed separately — but until one is on file, the '
              + `figure ${r.billed.who} is billing against is unverified.`,
          });
          continue;
        }

        out.push({
          status: 'FAIL',
          severity: SEVERITY.MATERIAL,
          where: { vendor: r.billed.who },
          expected: expected ?? r.value,
          actual: stated,
          difference: diff,
          detail: `${r.billed.who} is billing against a contract sum of ${money(stated)}, and their `
            + `contract on file is ${money(r.value)}`
            + `${changes != null ? ` plus ${money(changes)} of approved changes — ${money(expected)}` : ''}. `
            + `That is ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the agreement `
            + `supports. ${diff > 0 ? 'Either a change order has been approved that is not on the '
              + 'contract on file, or the application is billing against a sum nobody signed.'
    : 'A contract sum billed BELOW the agreement usually means a credit that was taken but never '
      + 'documented as a change.'}`,
        });
      }
      return out.length ? out : {
        status: 'PASS',
        detail: `${checkable.length} part${checkable.length === 1 ? 'y is' : 'ies are'} billing `
          + 'against the contract sum their own agreement states.',
      };
    },
  },

  // ---- K3  Retainage at the rate that party's contract sets ---------------------------------------
  // The clearest case for reading each contract separately. Every subcontract on a job can carry a
  // different retainage rate, and the review has spent its life comparing all of them against one.
  {
    id: 'K3',
    title: 'Each party is retained at the rate their own contract sets',
    severity: SEVERITY.MATERIAL,
    run(app, rows) {
      const checkable = rows.filter(r => r.biller && isNum(r.terms.retainageRate) && isNum(r.actualRate));
      if (!checkable.length) {
        return skip('No contract on file states a retainage rate that could be compared against '
          + 'what is actually being withheld.');
      }
      const out = [];
      for (const r of checkable) {
        const contracted = r.terms.retainageRate;
        const actual = r.actualRate;
        if (Math.abs(actual - contracted) <= RATE_TOLERANCE) continue;
        const shouldBe = Math.round(num(r.billed.retainageBase) * contracted * 100) / 100;
        const diff = Math.round((num(r.billed.retainage) - shouldBe) * 100) / 100;
        out.push({
          status: 'FAIL',
          // Under-withholding is the owner's exposure and the finding that matters. Withholding
          // MORE than the contract allows is the party's money being held wrongly — still worth
          // raising, and still worth fixing, but it does not put the owner at risk.
          severity: diff < 0 ? SEVERITY.MATERIAL : SEVERITY.NOTE,
          where: { vendor: r.billed.who },
          expected: shouldBe,
          actual: num(r.billed.retainage),
          difference: diff,
          detail: `${r.billed.who} is retained at ${pct(actual)} and their contract sets `
            + `${pct(contracted)}. On ${money(r.billed.retainageBase)} completed that is `
            + `${money(num(r.billed.retainage))} withheld where the contract calls for `
            + `${money(shouldBe)} — ${money(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}. `
            + (diff < 0
              ? 'Under-withholding is the owner\'s exposure: it is money released before the work '
                + 'securing it is complete.'
              : 'Over-withholding is the party\'s money held longer than agreed, which is theirs '
                + 'to claim and worth correcting before they do.'),
        });
      }
      return out.length ? out : {
        status: 'PASS',
        detail: `${checkable.length} part${checkable.length === 1 ? 'y is' : 'ies are'} retained at `
          + 'the rate their own contract sets.',
      };
    },
  },

  // ---- K4  Nobody bills past their own contract ------------------------------------------------------
  {
    id: 'K4',
    title: 'No party has billed beyond the contract signed with them',
    severity: SEVERITY.CRITICAL,
    run(app, rows) {
      const checkable = rows.filter(r => r.biller && isNum(r.value) && isNum(r.billed?.toDate));
      if (!checkable.length) return skip('No contract on file states a value that billing to date '
        + 'could be measured against.');
      const out = [];
      for (const r of checkable) {
        // The ceiling is the party's OWN stated contract sum where they state one, because that
        // figure already carries their approved changes. Measuring against the original contract
        // instead reported IDR's $768,561 as $62,631 of overbilling when every dollar of it was
        // covered by change orders their application declares on the line above.
        const ceiling = isNum(r.billed.contractSum)
          ? r.billed.contractSum : r.value + num(r.billed.changes);
        const over = Math.round((r.billed.toDate - ceiling) * 100) / 100;
        if (over <= TOL.aggregate) continue;
        out.push({
          status: 'FAIL',
          severity: SEVERITY.CRITICAL,
          where: { vendor: r.billed.who },
          expected: ceiling,
          actual: r.billed.toDate,
          difference: over,
          detail: `${r.billed.who} has billed ${money(r.billed.toDate)} to date against a contract `
            + `worth ${money(ceiling)} — ${money(over)} beyond it. Work performed past a contract `
            + 'sum is not payable under that contract until a change order covers it, whatever the '
            + 'schedule of values shows.',
        });
      }
      return out.length ? out : {
        status: 'PASS',
        detail: 'No party has billed beyond the contract signed with them.',
      };
    },
  },

  // ---- K5  Costs a party's own contract forbids -------------------------------------------------------
  // Each contract carries its own list, and they differ. A subcontract that excludes overtime
  // says nothing about what the contractor may bill, and applying one party's exclusions to
  // another's billing is exactly the error this whole engine exists to stop.
  {
    id: 'K5',
    title: 'Nothing is billed that the relevant contract forbids',
    severity: SEVERITY.MATERIAL,
    run(app, rows) {
      const withRules = rows.filter(r => r.biller && (r.terms.unallowableItems || []).length);
      if (!withRules.length) {
        return skip('No contract on file lists a cost it forbids, so nothing was checked against '
          + 'an exclusion.');
      }
      const out = [];
      for (const r of withRules) {
        // Only the lines this party is actually billing. For the prime that is the schedule; for a
        // subcontractor it is the lines the rollup gathered for them, which is why an unmatched
        // subcontractor produces no finding here rather than a wrong one.
        const scope = r.biller.kind === 'prime'
          ? (app.lineItems || [])
          : (app.linesByVendor?.[r.billed.who] || []);
        if (!scope.length) continue;
        for (const rule of r.terms.unallowableItems) {
          const needle = norm(rule.item);
          if (needle.length < 4) continue;              // "fee", "tax" alone match everything
          const hits = scope.filter(li => norm(li.description).includes(needle) && num(li.thisPeriod));
          for (const li of hits) {
            out.push({
              status: 'FAIL',
              severity: SEVERITY.MATERIAL,
              where: { vendor: r.billed.who, itemNo: li.itemNo, description: li.description },
              actual: li.thisPeriod,
              detail: `${li.description} bills ${money(li.thisPeriod)} this period, and the contract `
                + `with ${r.billed.who} lists "${rule.item}" as a cost it does not allow. `
                + `${rule.basis ? `The contract says: "${rule.basis}". ` : ''}`
                + 'Either the line is something other than what the exclusion names, or it comes off.',
            });
          }
        }
      }
      return out.length ? out : {
        status: 'PASS',
        detail: 'Nothing billed matches a cost excluded by the contract with the party billing it.',
      };
    },
  },

  // ---- K6  What the contract review covered -----------------------------------------------------------
  {
    id: 'K6',
    title: 'What was checked against a contract',
    severity: SEVERITY.NOTE,
    run(app, rows) {
      const method = app.deliveryMethod;
      const matched = rows.filter(r => r.biller);
      const parts = [
        method
          ? `This was reviewed as a ${method} application${method === CSP
            ? ', so the contractor bills directly and no subcontractor applications were expected '
              + 'or looked for'
            : ', so every subcontractor billing through the contractor was expected to have their '
              + 'own contract and application'}.`
          : 'No delivery method was recorded for this application, so the review could not tell '
            + 'whether missing subcontractor paperwork is an omission or simply how the job is '
            + 'procured.',
        rows.length
          ? `${matched.length} of ${rows.length} contract(s) on file were tied to a party billing `
            + 'here and used.'
          : 'No contract was on file, so every check in this family stood down.',
      ];
      return skip(parts.join(' '));
    },
  },
];

function runContractChecks(app) {
  const rows = survey(app);
  const results = [];
  for (const chk of CONTRACT_CHECKS) {
    let produced;
    try {
      produced = chk.run(app, rows);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r =>
      results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r }));
  }

  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  return {
    results,
    findings,
    rows,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      contractsOnFile: rows.length,
      contractsApplied: rows.filter(r => r.biller).length,
      deliveryMethod: app.deliveryMethod || null,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
  };
}

// One row per contract: who it is with, who it was matched to, and how. A reader has to be able to
// see that a subcontractor was measured against their OWN agreement, because that claim is the
// entire reason this table is worth printing.
function contractTable(rows) {
  if (!rows || !rows.length) return null;
  return rows.map(r => ({
    party: r.contract.party || r.contract.label || r.contract.fileName || '—',
    role: r.contract.partyRole || (r.biller?.kind === 'prime' ? 'prime' : null),
    scope: r.contract.partyScope || null,
    commitment: r.contract.commitment || null,
    value: r.value,
    retainageRate: isNum(r.terms.retainageRate) ? r.terms.retainageRate : null,
    matchedTo: r.biller ? (r.billed?.who || 'the contractor') : null,
    matchedHow: r.biller ? r.biller.how : 'not matched to anyone billing here',
    billedToDate: r.billed?.toDate ?? null,
  }));
}

module.exports = { CONTRACT_CHECKS, runContractChecks, contractTable, survey, billerFor, CSP, CMAR };
