// Runs the deterministic review engines over an extracted pay application and folds their
// output into the one shape the report renders from.
//
// This replaces the model-conducted audit that used to sit here. That audit read the documents
// and formed a judgement; these engines take figures that were already read and check them
// against each other. The difference matters: arithmetic is not something to have an opinion
// about, and a check that can be proved against a fixture is worth more than one that sounds
// confident. Everything in backend/tests/fixtures/payapp measures exactly this code.
//
// Four engines, and each says out loud when it has nothing to work with rather than passing
// silently. A pay application submitted with no cost report gets no reconciliation findings —
// and the report must say that, or "no issues found" becomes a lie of omission.
//
//   payAppInvariants     I1-I24   the G702 and continuation sheet on their own
//   payAppSubcontracts   S1-S9    contractor breakdown -> schedule line -> subcontractor's app
//   payAppBackup         R1-R12   cost report against its receipts, internal allowances
//   payAppCoverage       C1-C7    a line against the documents attached to it

const { runInvariants, groupFindings, SEVERITY } = require('./payAppInvariants');
const { runSubcontractChecks, chainTable } = require('./payAppSubcontracts');
const { runBackupChecks } = require('./payAppBackup');
const { runCoverageChecks, coverageTable } = require('./payAppCoverage');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : 0);
const sum = (list, f) => (list || []).reduce((a, x) => a + num(f(x)), 0);

const RANK = { [SEVERITY.CRITICAL]: 0, [SEVERITY.MATERIAL]: 1, [SEVERITY.NOTE]: 2 };

// ---- shaping the extracted data for each engine -------------------------------------------------

// The arithmetic engine wants the columns under their AIA letters, which is how the extractor
// already stores them. Only the wrapper differs.
function arithmeticInput(data, contractTerms) {
  const { current, previous } = data;
  const s = current.summary || {};
  return {
    kind: 'arithmetic',
    meta: {
      applicationNumber: s.applicationNumber, periodTo: s.periodTo,
      projectName: s.projectName, contractor: s.contractor,
      isRetainageRelease: !!s.isRetainageRelease,
    },
    contract: { retainageRate: contractTerms?.retainageRate ?? s.line5aRate ?? null },
    summary: {
      ...s,
      line5Total: s.line5 ?? s.line5Total ?? null,
      changeOrderSummary: s.changeOrderSummary || null,
    },
    lineItems: current.lineItems || [],
    grandTotals: current.grandTotalRow || null,
    pageSubtotals: current.pageSubtotals || null,
    // Line 7 has to tie to a document, not merely to itself: the prior application's Line 6.
    // That figure comes from the uploaded previous application when there is one, and otherwise
    // from the project's own stored history, which is just as authoritative and far more often
    // available.
    previousApplication: previous ? {
      applicationNumber: previous.summary?.applicationNumber ?? null,
      line6: previous.summary?.line6 ?? null,
      lineItems: previous.lineItems || [],
    } : (data.priorApplication || null),
  };
}

// The subcontract engine wants the contractor's own cost breakdown keyed to schedule lines. The
// extractor captures those as subBreakdowns — one section per vendor, each naming the schedule
// line it supports. Sections that state a basis other than this period are left out rather than
// compared against a this-period figure they were never meant to match.
function subcontractInput(data, contractTerms) {
  const { current } = data;
  const s = current.summary || {};
  const sections = (current.subBreakdowns || []).filter(b => b.basis !== 'to-date');
  if (!sections.length) return null;

  // A breakdown section names the schedule line it supports either by item number or by
  // repeating its description. Sections that name neither cannot be tied to anything and are
  // left out rather than guessed at — a section attached to the wrong line would produce a
  // confident finding about a line that is perfectly fine.
  // An item number, when the section gives one, is the ONLY thing consulted. Descriptions repeat
  // — a schedule can carry "General Conditions" twice, once per GMP — and letting a description
  // match override a stated item number attaches a section to the wrong line, which then reports
  // a line that is perfectly correct as failing to tie.
  const lineFor = (section) => {
    const items = current.lineItems || [];
    if (section.matchesItemNo != null && String(section.matchesItemNo).trim() !== '') {
      return items.find(li => String(li.itemNo) === String(section.matchesItemNo)) || null;
    }
    if (!section.matchesDescription) return null;
    const want = section.matchesDescription.toLowerCase().trim();
    const hits = items.filter(li => (li.description || '').toLowerCase().trim() === want);
    // An ambiguous description is no better than none.
    return hits.length === 1 ? hits[0] : null;
  };

  const breakdown = [];
  for (const section of sections) {
    const line = lineFor(section);
    if (!line) continue;
    for (const c of section.components || []) {
      breakdown.push({
        code: String(line.itemNo), category: c.category || 'SUBCONTRACTS',
        vendor: c.vendor || section.subName, ref: c.ref ?? null,
        date: c.date || null, amount: c.amount, description: c.description,
      });
    }
    // A section with no itemised components still carries its own printed total, which is worth
    // tying to the schedule line even though nothing inside it can be checked.
    if (!(section.components || []).length && isNum(section.statedTotal)) {
      breakdown.push({
        code: String(line.itemNo), category: 'SUBCONTRACTS',
        vendor: section.subName, ref: null, date: null, amount: section.statedTotal,
      });
    }
  }
  if (!breakdown.length) return null;

  return {
    kind: 'subcontracts',
    meta: { applicationNumber: s.applicationNumber, periodTo: s.periodTo, contractor: s.contractor },
    contract: {
      feeRate: contractTerms?.feeRate ?? null,
      retainageRate: contractTerms?.retainageRate ?? s.line5aRate ?? null,
      ownerTaxExempt: contractTerms?.ownerTaxExempt ?? false,
    },
    contractorAliases: [s.contractor].filter(Boolean),
    sovLines: (current.lineItems || []).map(li => ({
      code: String(li.itemNo), description: li.description,
      scheduledValue: li.c, previous: li.d, thisPeriod: li.e,
      totalToDate: li.g, retainage: li.retainage ?? li.i ?? null,
      isFee: /\bfee\b/i.test(li.description || ''),
    })),
    breakdown,
    // Only assert an invoice total when the breakdown is the whole application; a partial set of
    // sections would fail the completeness gate for a reason that is about us, not the contractor.
    invoiceSummary: current.contractorInvoice || null,
    subApplications: current.subApplications || [],
    taxes: current.taxes || [],
  };
}

function backupInput(data, contractTerms) {
  const { current } = data;
  if (!(current.transactions || []).length) return null;
  return {
    kind: 'backup',
    meta: current.summary,
    reportTotals: current.reportTotals || {},
    transactions: current.transactions,
    receipts: current.receipts || [],
    backupScope: current.backupScope,
    billedAgainstDetail: current.billedAgainstDetail || [],
    costRulings: contractTerms?.costRulings || [],
    priorRemovals: current.priorRemovals || [],
  };
}

function coverageInput(data, contractTerms) {
  const { current } = data;
  if (!(current.documentation || []).length) return null;
  const s = current.summary || {};
  return {
    kind: 'coverage',
    meta: s,
    contract: { feePercent: contractTerms?.feeRate ?? null },
    printedTotals: { thisPeriod: current.grandTotalRow?.e ?? null },
    subcontractors: contractTerms?.subcontractors || [],
    documentationScope: current.documentationScope,
    lineItems: (current.lineItems || []).map(li => ({
      itemNo: li.itemNo, description: li.description,
      originalValue: li.originalValue, changeInValue: li.changeOrders,
      scheduledValue: li.c, previous: li.d, thisPeriod: li.e,
      totalToDate: li.g, retainage: li.retainage ?? li.i ?? null,
    })),
    documentation: current.documentation,
    priorFindings: current.priorDocumentationFindings || [],
  };
}

// ---- running them --------------------------------------------------------------------------------

const ENGINES = [
  { key: 'arithmetic', label: 'the schedule of values and G702', build: arithmeticInput, run: runInvariants,
    absent: 'No pay application figures were read.' },
  { key: 'subcontracts', label: "the contractor's cost breakdown and subcontractor applications",
    build: subcontractInput, run: runSubcontractChecks,
    absent: "No contractor cost breakdown was submitted, so nothing was traced from a schedule line down to a subcontractor's own application." },
  { key: 'backup', label: 'the cost report and its receipts', build: backupInput, run: runBackupChecks,
    absent: 'No job-cost transaction report was submitted, so no charge was matched to a receipt.' },
  { key: 'coverage', label: 'documents attached to each billed line', build: coverageInput, run: runCoverageChecks,
    absent: 'No line-by-line backup was submitted, so no line was checked for whether its documentation covers what it bills.' },
];

function runEngines(data, contractTerms = null) {
  const engines = [];
  const findings = [];
  const notChecked = [];
  let checksRun = 0;
  let passed = 0;

  for (const engine of ENGINES) {
    let input = null;
    try {
      input = engine.build(data, contractTerms);
    } catch (err) {
      notChecked.push(`${engine.label} — could not be prepared (${err.message}).`);
      continue;
    }
    if (!input) {
      notChecked.push(engine.absent);
      continue;
    }
    let out;
    try {
      out = engine.run(input);
    } catch (err) {
      notChecked.push(`${engine.label} — this check could not be run (${err.message}).`);
      continue;
    }
    checksRun += out.summary.checksRun;
    passed += out.summary.passed;
    for (const f of out.findings) findings.push({ ...f, engine: engine.key });
    // Every engine's last rule states its own coverage as a skip. Those sentences are the honest
    // limit of the review and belong in the report, not in a log.
    for (const r of out.results) {
      if (r.status === 'SKIPPED' && /NOT checked|not checked|no invoice packet|were not checked/i.test(r.detail || '')) {
        notChecked.push(r.detail);
      }
    }
    engines.push({ key: engine.key, input, ...out });
  }

  findings.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

  const byEngine = key => engines.find(e => e.key === key);
  const arith = byEngine('arithmetic');
  const subs = byEngine('subcontracts');

  return {
    engines,
    findings,
    grouped: groupFindings(findings),
    notChecked,
    // Tables the report draws. Absent when the engine that produces them did not run.
    chain: subs ? chainTable(subs.input, subs.codes) : null,
    subMatch: subs ? subcontractorMatch(subs.input) : null,
    coverage: byEngine('coverage') ? coverageTable(byEngine('coverage').lines) : null,
    stats: {
      checksRun,
      passed,
      failed: findings.length,
      critical: findings.filter(f => f.severity === SEVERITY.CRITICAL).length,
      material: findings.filter(f => f.severity === SEVERITY.MATERIAL).length,
      notes: findings.filter(f => f.severity === SEVERITY.NOTE).length,
      lineItems: (data.current.lineItems || []).length,
      codesTied: subs ? subs.summary.codesTied : null,
      codesTotal: subs ? subs.summary.codesTotal : null,
      enginesRun: engines.map(e => e.key),
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.length ? 'certify-with-corrections' : 'no-issues-found',
    amountApplied: arith ? (data.current.summary?.line8 ?? null) : null,
    thisPeriod: data.current.grandTotalRow?.e ?? sum(data.current.lineItems, li => li.e),
  };
}

// ---- the subcontractor match table -----------------------------------------------------------------
//
// One row per subcontractor: what they billed, what the contractor passed through, what reached
// the owner, retainage on both sides, and whether anything was added in between. The columns are
// chosen so that overbilling and hidden markup are visible by reading across a row, without the
// reader doing arithmetic.

function subcontractorMatch(app) {
  const { entriesForSub, commitmentOf } = require('./payAppSubcontracts');
  // Self-performed work has no subcontract by definition, and saying "no contract" about the
  // contractor's own department would read as an accusation of something that is not happening.
  const aliases = (app.contractorAliases || []).map(n =>
    String(n).toLowerCase().replace(/[.,]/g, '').split(/\s+/)[0]).filter(n => n.length > 3);
  const isSelf = v => aliases.some(a => String(v || '').toLowerCase().includes(a));
  const rows = [];
  const claimed = new Set();

  for (const sub of app.subApplications || []) {
    const entries = entriesForSub(app, sub);
    entries.forEach(e => claimed.add(e));
    const codes = [...new Set(entries.map(e => e.code))];
    const lines = (app.sovLines || []).filter(l => codes.includes(String(l.code)));
    const passedThrough = sum(entries, e => e.amount);
    const toOwner = sum(lines, l => l.thisPeriod);
    rows.push({
      vendor: sub.vendor,
      codes,
      note: [sub.applicationNumber ? `app ${sub.applicationNumber}` : null, sub.commitment,
        sub.contractFor].filter(Boolean).join(' · '),
      theyBilled: num(sub.thisPeriod),
      passedThrough,
      toOwner,
      retainageSub: isNum(sub.retainage) ? sub.retainage : null,
      retainageOwner: lines.length ? sum(lines, l => l.retainage) : null,
      markup: passedThrough - num(sub.thisPeriod),
      status: Math.abs(passedThrough - num(sub.thisPeriod)) <= 0.05
        && Math.abs(toOwner - num(sub.thisPeriod)) <= 0.05 ? 'exact' : 'differs',
    });
  }

  // Subcontract charges with no application supplied. Shown rather than dropped: a charge nobody
  // can vouch for is the thing a reviewer most wants to see, and leaving it out of the table
  // would make the table read as complete when it is not.
  // Several charges can share one schedule line — two Tellepsen departments both land on Fences
  // and Gates. Repeating that line's figure on every row would read as the amount being billed
  // twice, so it is shown once and the rest of the group says so.
  const lineShown = new Set(rows.flatMap(r => r.codes || []));

  for (const e of app.breakdown || []) {
    if (String(e.category || '').toUpperCase() !== 'SUBCONTRACTS' || claimed.has(e) || !num(e.amount)) continue;
    const line = (app.sovLines || []).find(l => String(l.code) === String(e.code));
    const first = line && !lineShown.has(String(e.code));
    if (line) lineShown.add(String(e.code));
    rows.push({
      vendor: e.vendor,
      note: [isSelf(e.vendor) ? 'the contractor\'s own department'
        : commitmentOf(e.ref) ? 'no application supplied' : null,
      e.ref ? `inv ${e.ref}` : null, line?.description,
      line && !first ? 'shares the line above' : null].filter(Boolean).join(' · '),
      theyBilled: num(e.amount),
      passedThrough: num(e.amount),
      toOwner: first ? num(line.thisPeriod) : null,
      retainageSub: null,
      retainageOwner: first ? num(line.retainage) : null,
      markup: 0,
      status: isSelf(e.vendor) ? 'self-perform'
        : commitmentOf(e.ref) ? 'no application' : 'no contract',
    });
  }

  if (!rows.length) return null;
  return {
    rows,
    totals: {
      theyBilled: sum(rows, r => r.theyBilled),
      passedThrough: sum(rows, r => r.passedThrough),
      markup: sum(rows, r => r.markup),
    },
    feeRate: app.contract?.feeRate ?? null,
    fee: app.invoiceSummary?.fee ?? null,
    feeBase: app.invoiceSummary?.feeBase ?? null,
  };
}

module.exports = { runEngines, arithmeticInput, subcontractInput, backupInput, coverageInput };
