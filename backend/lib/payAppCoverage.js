// Does the paperwork actually add up to what is being billed?
//
// The third family of rules. The other two ask whether the arithmetic is right
// (lib/payAppInvariants.js) and whether each ledger charge has a receipt (lib/payAppBackup.js).
// Neither of them can see the failure this file exists for, which is a whole SCHEDULE OF VALUES
// LINE billed for more than its documentation supports.
//
// The case it was built from, Carver High School application 04:
//
//   Ground Breaking     scheduled 12,573.27   this period 12,573.27   100%
//   backup supplied     one invoice from The Tent Co. for 6,902.02
//
// Every arithmetic check passes. The line adds up, the column totals tie, the retainage is
// exactly 5%. The transaction report reconciles perfectly to the receipts in its packet, because
// Ground Breaking is not on the transaction report at all. Nothing is wrong with any number.
// $5,671.25 is simply being billed with no paper behind it, and the only way to see that is to
// compare a line's billing against the documents attached to that line.
//
// Two decisions carry the whole file, and neither is arithmetic:
//
//   1. WHICH LINES NEED DOCUMENTS. Asking for receipts against a lump-sum subcontract billed by
//      percent complete is noise — the evidence there is the subcontractor's own application.
//      Demanding it everywhere would bury the handful of lines that genuinely lack backup.
//
//   2. NONE versus SHORT. A line with no documents may simply have had its packet submitted
//      elsewhere. A line with SOME documents cannot make that argument: supplying part of the
//      backup concedes that the line needs backup, so the shortfall is a real question. Short is
//      the stronger finding and is graded higher, which is the opposite of what you would guess.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol = TOL.aggregate) => Math.abs(a - b) <= tol;
const num = v => (isNum(v) ? v : 0);
const pct = f => `${(f * 100).toFixed(f * 100 % 1 ? 2 : 0)}%`;

// A line is identified by its description. Item numbers are absent from plenty of real
// schedules — Carver's has none at all — so the description is the only thing always present.
const lineKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// --- who performs the work, and therefore what evidence is even possible ----------------------
//
// Inference here can only ever RELAX a requirement, so it is deliberately timid. Guessing that a
// line is subcontracted when it is not suppresses a finding, which is the one failure mode this
// file cannot afford; a name is only accepted when it appears on the project's own subcontractor
// list. Anything unrecognised falls through to "the contractor paid for this directly", which
// asks for a document rather than hiding the line.

const SELF_PERFORM = /self[-\s]?perform/i;

function inferPerformer(li, subcontractors = []) {
  if (li.performer && li.performer.kind) return li.performer;
  const desc = String(li.description || '');
  if (SELF_PERFORM.test(desc)) return { kind: 'self-perform', name: null };
  const hit = subcontractors.find(s => s && desc.toLowerCase().includes(String(s).toLowerCase()));
  if (hit) return { kind: 'subcontractor', name: hit };
  return { kind: 'gc-cost', name: null };
}

// --- why a line is a pass-through cost rather than a priced scope -----------------------------
//
// These are the tells that a figure was ADDED UP rather than NEGOTIATED. A negotiated lump sum
// is defensible on its own terms — it is what the parties agreed. A figure arrived at by
// totalling invoices has to reconcile to those invoices, because that is the only thing it means.
//
// Every one of them is true of Ground Breaking at once, which is why it reads as the exception
// it is rather than as one more line on a long schedule.

function costTells(li) {
  const tells = [];
  const sched = li.scheduledValue;

  // Funded by moving money, not by pricing scope. Carver's Ground Breaking line has an original
  // value of zero and a $12,573.27 reallocation out of contingency — the contract never priced
  // it, so its amount is whatever it turned out to cost.
  if (!num(li.originalValue) && num(li.changeInValue))
    tells.push('it was created by a change in value with no original scheduled amount');

  // Nothing to compare against. A line billed in one movement has no prior period to check it
  // against and will have none afterwards, so this application is the only chance to look.
  if (!num(li.previous) && num(li.thisPeriod) && isNum(sched) && close(num(li.totalToDate), sched))
    tells.push('it went from nothing to fully billed in this one application');

  // Round numbers are priced. Odd cents are added up.
  if (isNum(sched) && Math.round(Math.abs(sched) * 100) % 100 !== 0)
    tells.push(`the amount is an odd figure (${money(sched)}) rather than a round one, which is `
      + `what a total of actual costs looks like`);

  return tells;
}

// --- what a line needs, and what it has -------------------------------------------------------

const NEEDS = {
  INVOICE: 'invoice',            // the contractor paid a vendor: show the invoice
  SUBAPP: 'sub-application',     // a subcontract draw: the sub's own pay app, not checked here
  LEDGER: 'ledger',              // self-performed or general conditions: the cost report
  FORMULA: 'formula',            // fee, insurance, bond — a percentage, checked by arithmetic
  NONE: 'none',                  // nothing billed this period
};

function classify(li, app) {
  if (li.backupRequired === false) return { needs: NEEDS.NONE, reason: 'excused in the fixture' };
  if (!num(li.thisPeriod)) return { needs: NEEDS.NONE, reason: 'nothing billed this period' };
  if (li.backupRequired === true) return { needs: NEEDS.INVOICE, reason: 'required explicitly' };
  if (li.isFormula) return { needs: NEEDS.FORMULA, reason: 'a percentage of other costs' };
  // A line can name its own evidence. General conditions is the case that matters: no
  // subcontractor performs it and it is not self-performed labour either, but its backup is the
  // cost report, which the backup engine already reconciles invoice by invoice.
  if (li.evidence && Object.values(NEEDS).includes(li.evidence))
    return { needs: li.evidence, reason: 'declared on the line' };

  const performer = inferPerformer(li, app.subcontractors || []);
  if (performer.kind === 'subcontractor')
    return { needs: NEEDS.SUBAPP, performer, reason: `performed by ${performer.name}` };
  if (performer.kind === 'self-perform')
    return { needs: NEEDS.LEDGER, performer, reason: 'self-performed by the contractor' };
  return { needs: NEEDS.INVOICE, performer, reason: 'a cost the contractor paid directly' };
}

// Documents attached to a line, and what they add up to. `fees` is carried separately because a
// card processing fee or a small tax genuinely explains a difference of that size and should not
// be argued about — but it should also not silently pad the coverage figure.
function documentsFor(app, li) {
  const key = lineKey(li.description);
  const docs = (app.documentation || []).filter(d => lineKey(d.line) === key);
  return {
    docs,
    documented: docs.reduce((a, d) => a + num(d.amount), 0),
    fees: docs.reduce((a, d) => a + num(d.fees), 0),
  };
}

// Whether we hold the paperwork for this line at all. Same reasoning as the backup engine's
// scope: reconciling a line against a packet that was never submitted for it reports the
// submission, not the contractor. Absent a declaration, everything is in scope — which is right
// in production, where a line with nothing attached genuinely has nothing attached.
// Below this, a missing document is a housekeeping item rather than a reason to hold a
// certificate. A permit fee topped up by $27.33 and a $34,162 contingency draw are not the same
// question, and grading them the same is how a report teaches its reader to skim.
const materialityFloor = app => (isNum(app.materialityFloor) ? app.materialityFloor : 1000);

const inScope = (app, li) => {
  const scope = app.documentationScope;
  return !scope || !scope.length || scope.some(s => lineKey(s) === lineKey(li.description));
};

function survey(app) {
  return (app.lineItems || []).map(li => {
    const c = classify(li, app);
    const { docs, documented, fees } = documentsFor(app, li);
    const billed = num(li.thisPeriod);
    const feePercent = app.contract?.feePercent;
    // Two innocent explanations for a difference, ruled out before anything is reported: the
    // contractor's fee sitting on top of the raw cost, and processing fees or tax that the
    // invoice itself shows.
    const withMarkup = isNum(feePercent) ? documented * (1 + feePercent) : documented;
    const explained = Math.max(documented + fees, withMarkup);
    return {
      li,
      ...c,
      docs,
      billed,
      documented,
      fees,
      explained,
      shortfall: billed - explained,
      tells: costTells(li),
      inScope: inScope(app, li),
      markupExplains: isNum(feePercent) && documented > 0 && close(withMarkup, billed),
    };
  });
}

// --- the checks -------------------------------------------------------------------------------

const fail = o => ({ status: 'FAIL', ...o });
const pass = o => ({ status: 'PASS', ...o });
const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });

const where = s => ({ itemNo: s.li.itemNo, field: s.li.description, page: s.li.page });

// "This line needs paper because…" — written out in full, because a PM forwarding the finding to
// a contractor has to be able to defend it, and "the tool said so" is not a defence.
const list = items => (items.length < 2 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const because = s => (s.tells.length
  ? ` This line needs supporting documents because ${list(s.tells)}.`
  : '');

const COVERAGE_CHECKS = [

  // ---- C1  Every billed line was read -----------------------------------------------------------
  // The gate. Coverage findings are made by ABSENCE — a line with no documents attached is the
  // finding — and absence is exactly what a bad read produces. If the schedule was not read
  // completely, the honest answer is that nothing was checked.
  {
    id: 'C1',
    title: 'The schedule of values was read completely',
    severity: SEVERITY.CRITICAL,
    gate: true,
    run(app) {
      const printed = app.printedTotals?.thisPeriod;
      if (!isNum(printed)) return skip('No printed this-period total was captured to check the read against.');
      const read = (app.lineItems || []).reduce((a, li) => a + num(li.thisPeriod), 0);
      return close(read, printed) ? pass({}) : fail({
        expected: printed,
        actual: read,
        difference: read - printed,
        detail: `The schedule of values prints ${money(printed)} billed this period, but the lines `
          + `read total ${money(read)} — ${money(Math.abs(read - printed))} apart. No line has been `
          + `checked for documentation, because a line that was missed would look exactly like a `
          + `line with nothing behind it.`,
      });
    },
  },

  // ---- C2  Documentation covers the amount billed ------------------------------------------------
  // The one this family was built for, and the strongest finding it can make. Partial backup is
  // an admission that the line needs backup, so the shortfall cannot be waved away.
  {
    id: 'C2',
    title: 'Documentation covers the amount billed',
    severity: SEVERITY.CRITICAL,
    run(app, lines) {
      const partial = lines.filter(s => s.needs === NEEDS.INVOICE && s.inScope
        && s.documented > 0 && s.shortfall > TOL.aggregate);
      if (!partial.length) {
        const any = lines.some(s => s.needs === NEEDS.INVOICE && s.documented > 0);
        return any ? pass({}) : skip('No line carries partial documentation.');
      }
      return partial.map(s => fail({
        where: where(s),
        expected: s.billed,
        actual: s.documented,
        difference: -s.shortfall,
        detail: `${s.li.description} bills ${money(s.billed)} this period. The documentation `
          + `attached to it comes to ${money(s.documented)}`
          + `${s.docs.length === 1 ? ` (${s.docs[0].vendor || 'one document'}`
            + `${s.docs[0].ref ? ` ${s.docs[0].ref}` : ''})` : ` across ${s.docs.length} documents`}, `
          + `leaving ${money(s.shortfall)} billed with nothing behind it.`
          + `${s.fees ? ` ${money(s.fees)} of fees shown on the paperwork has already been allowed for.` : ''}`
          + because(s)
          + ` Ask the contractor for the remaining invoices, or for a breakdown showing how `
          + `${money(s.billed)} was arrived at.`,
      }));
    },
  },

  // ---- C3  A line that needs documents has some ------------------------------------------------
  // Graded below C2 on purpose. Nothing attached is a question; part of it attached is a problem.
  {
    id: 'C3',
    title: 'Every line needing documents has some',
    severity: SEVERITY.MATERIAL,
    run(app, lines) {
      const bare = lines.filter(s => s.needs === NEEDS.INVOICE && s.inScope && s.documented === 0);
      if (!bare.length) {
        const any = lines.some(s => s.needs === NEEDS.INVOICE && s.inScope);
        return any ? pass({}) : skip('No line requires vendor documentation this period.');
      }
      return bare.map(s => fail({
        where: where(s),
        // A pass-through created out of contingency and billed straight to 100% is a different
        // proposition from a $27.33 permit top-up, and the report should not pretend otherwise.
        // Small amounts are still reported — a PM collecting backup wants the whole list — but
        // they never carry a severity that would stop a certification on their own.
        severity: s.billed < materialityFloor(app) ? SEVERITY.NOTE
          : s.tells.length >= 2 ? SEVERITY.CRITICAL : SEVERITY.MATERIAL,
        expected: s.billed,
        actual: 0,
        detail: `${s.li.description} bills ${money(s.billed)} this period with no invoice or `
          + `receipt submitted for it.` + because(s)
          + ` This is a cost the contractor paid directly, so no subcontractor application will `
          + `ever cover it — an invoice is the only evidence available.`,
      }));
    },
  },

  // ---- C4  Documentation does not exceed what is billed -------------------------------------------
  // The other direction. Usually harmless — costs held back for next month — but it is also what
  // a line billed twice looks like from here, and it costs nothing to say.
  {
    id: 'C4',
    title: 'Documentation does not exceed the amount billed',
    severity: SEVERITY.NOTE,
    run(app, lines) {
      const over = lines.filter(s => s.needs === NEEDS.INVOICE && s.documented > 0
        && s.documented - s.billed > TOL.aggregate);
      if (!over.length) return skip('No line carries more documentation than it bills.');
      return over.map(s => fail({
        where: where(s),
        expected: s.billed,
        actual: s.documented,
        difference: s.documented - s.billed,
        detail: `${s.li.description} bills ${money(s.billed)} against documentation totalling `
          + `${money(s.documented)} — ${money(s.documented - s.billed)} more paperwork than `
          + `billing. Usually this means costs are being held for a later application, which is `
          + `fine, but it is worth confirming they are not billed twice.`,
      }));
    },
  },

  // ---- C5  The markup explanation is stated, not assumed --------------------------------------------
  // When a gap turns out to be the contractor's fee, that is a PASS — but a silent one is
  // indistinguishable from a check that never ran, so it is said out loud.
  {
    id: 'C5',
    title: 'Gaps explained by contract markup are identified as such',
    severity: SEVERITY.NOTE,
    run(app, lines) {
      const marked = lines.filter(s => s.markupExplains);
      if (!isNum(app.contract?.feePercent)) return skip('No contract fee percentage was supplied, so no gap could be attributed to markup.');
      if (!marked.length) return skip(`No gap is explained by the ${pct(app.contract.feePercent)} contract fee.`);
      return marked.map(s => skip(
        `${s.li.description} bills ${money(s.billed)} against ${money(s.documented)} of documents, `
        + `which is that cost plus the ${pct(app.contract.feePercent)} contract fee. Treated as `
        + `covered rather than short.`, { where: where(s) }));
    },
  },

  // ---- C6  Questions raised on earlier applications stay raised ----------------------------------------
  // The failure the PM actually described: the gap was found, the contractor was asked, and the
  // question quietly evaporated because the next month's paperwork looked clean. An open item
  // stays open until the documents arrive or a person closes it deliberately.
  {
    id: 'C6',
    title: 'Documentation questions from earlier applications are resolved',
    severity: SEVERITY.MATERIAL,
    run(app, lines) {
      const prior = (app.priorFindings || []).filter(p => p.status === 'open');
      if (!prior.length) return skip('No documentation questions are carried over from earlier applications.');
      return prior.map(p => {
        const s = lines.find(x => lineKey(x.li.description) === lineKey(p.line));
        // Resolved when the documents that were missing have since been supplied.
        const nowCovered = s && s.documented > 0 && s.shortfall <= TOL.aggregate;
        return nowCovered ? pass({ where: { field: p.line } }) : fail({
          where: { field: p.line },
          actual: p.amount,
          detail: `${money(p.amount)} on ${p.line} was queried on application ${p.raisedIn} and `
            + `is still not documented.${p.note ? ` ${p.note}` : ''} It stays on this review until `
            + `the backup is supplied or the question is closed deliberately.`,
        });
      });
    },
  },

  // ---- C7  Say what was not checked ---------------------------------------------------------------
  // Can never fail. It exists so that "no issues found" is never able to mean "we looked at a
  // third of it" — the same job R9 does for the backup engine.
  {
    id: 'C7',
    title: 'Coverage of the documentation review',
    severity: SEVERITY.NOTE,
    run(app, lines) {
      const billed = lines.filter(s => s.needs !== NEEDS.NONE);
      const sum = list => list.reduce((a, s) => a + s.billed, 0);
      const subs = billed.filter(s => s.needs === NEEDS.SUBAPP);
      const ledger = billed.filter(s => s.needs === NEEDS.LEDGER);
      const formula = billed.filter(s => s.needs === NEEDS.FORMULA);
      const outside = billed.filter(s => s.needs === NEEDS.INVOICE && !s.inScope);
      const parts = [
        `${billed.length} line(s) bill ${money(sum(billed))} this period.`,
        subs.length && `${subs.length} subcontract line(s) totalling ${money(sum(subs))} need the `
          + `subcontractor's own application rather than invoices, and were not checked here.`,
        ledger.length && `${ledger.length} self-performed or general conditions line(s) totalling `
          + `${money(sum(ledger))} are evidenced by the cost report, which the backup review covers.`,
        formula.length && `${formula.length} line(s) totalling ${money(sum(formula))} are a `
          + `percentage of other costs and are checked by arithmetic, not by documents.`,
        outside.length && `${outside.length} line(s) totalling ${money(sum(outside))} were NOT `
          + `checked — no documentation packet was supplied for them.`,
      ].filter(Boolean);
      return skip(parts.join(' '));
    },
  },
];

function runCoverageChecks(app) {
  const results = [];
  const stamp = (chk, r) => results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r });

  const gate = COVERAGE_CHECKS.find(c => c.gate);
  const gateResults = [].concat(gate.run(app));
  gateResults.forEach(r => stamp(gate, r));

  if (gateResults.some(r => r.status === 'FAIL')) {
    for (const chk of COVERAGE_CHECKS.filter(c => !c.gate)) {
      stamp(chk, skip('Not attempted: the schedule of values could not be read completely.'));
    }
    return summarise(results, []);
  }

  const lines = survey(app);
  for (const chk of COVERAGE_CHECKS.filter(c => !c.gate)) {
    let produced;
    try {
      produced = chk.run(app, lines);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r => stamp(chk, r));
  }
  return summarise(results, lines);
}

function summarise(results, lines) {
  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  const needing = lines.filter(l => l.needs === NEEDS.INVOICE && l.inScope);
  return {
    results,
    findings,
    lines,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      linesNeedingDocuments: needing.length,
      linesFullyDocumented: needing.filter(l => l.documented > 0 && l.shortfall <= TOL.aggregate).length,
      undocumentedAmount: needing.reduce((a, l) => a + Math.max(0, l.shortfall), 0),
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.length ? 'certify-with-corrections' : 'no-issues-found',
  };
}

// The table the report prints: every line billed this period and what stands behind it. The
// findings say what is wrong; this says what was looked at, which is how a reader satisfies
// themselves that a quiet line is quiet because it is fine.
function coverageTable(lines) {
  const LABEL = {
    [NEEDS.INVOICE]: 'invoices', [NEEDS.SUBAPP]: 'subcontractor application',
    [NEEDS.LEDGER]: 'cost report', [NEEDS.FORMULA]: 'calculated', [NEEDS.NONE]: '—',
  };
  return lines.filter(s => s.needs !== NEEDS.NONE).map(s => ({
    line: s.li.description,
    billed: s.billed,
    evidence: LABEL[s.needs],
    documented: s.needs === NEEDS.INVOICE ? s.documented : null,
    status: s.needs !== NEEDS.INVOICE ? 'not applicable'
      : !s.inScope ? 'not checked'
        : s.documented === 0 ? 'none supplied'
          : s.shortfall > TOL.aggregate ? 'short'
            : 'documented',
    shortfall: s.needs === NEEDS.INVOICE && s.inScope && s.shortfall > TOL.aggregate ? s.shortfall : 0,
  }));
}

module.exports = {
  COVERAGE_CHECKS, runCoverageChecks, coverageTable, survey, classify,
  inferPerformer, costTells, NEEDS,
};
