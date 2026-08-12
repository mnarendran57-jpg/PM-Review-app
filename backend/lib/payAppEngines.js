// Runs the deterministic review engines over an extracted pay application and folds their
// output into the one shape the report renders from.
//
// This replaces the model-conducted audit that used to sit here. That audit read the documents
// and formed a judgement; these engines take figures that were already read and check them
// against each other. The difference matters: arithmetic is not something to have an opinion
// about, and a check that can be proved against a fixture is worth more than one that sounds
// confident. Everything in backend/tests/fixtures/payapp measures exactly this code.
//
// Eight engines, and each says out loud when it has nothing to work with rather than passing
// silently. A pay application submitted with no cost report gets no reconciliation findings —
// and the report must say that, or "no issues found" becomes a lie of omission.
//
//   payAppInvariants     I1-I30   the G702 and continuation sheet on their own
//   payAppSubcontracts   S1-S9    contractor breakdown -> schedule line -> subcontractor's app
//   payAppBackup         R1-R12   cost report against its receipts, internal allowances
//   payAppCoverage       C1-C7    a line against the documents attached to it
//   payAppWaivers        W1-W8    is it safe to pay — who has released, and for how much
//   payAppVendorRollup   V1-V4    one subcontractor against EVERY line billing their scope
//   payAppTax            T1-T8    who owes the tax, under this contract's own words
//   payAppContracts      K1-K6    each party's billing against the contract signed with THEM
//
// The last one is the only engine that reads across lines. Everything else compares a row to
// something; it compares a subcontract to a set of rows, which is the only way to see scope that
// has been billed in two places at once.

const { runInvariants, groupFindings, SEVERITY } = require('./payAppInvariants');
const { runSubcontractChecks, chainTable } = require('./payAppSubcontracts');
const { runBackupChecks } = require('./payAppBackup');
const { runCoverageChecks, coverageTable } = require('./payAppCoverage');
const { runWaiverChecks, waiverTable } = require('./payAppWaivers');
const { runVendorRollupChecks, vendorRollupTable } = require('./payAppVendorRollup');
const { runTaxChecks, taxTable } = require('./payAppTax');
const { runContractChecks, contractTable, CSP } = require('./payAppContracts');

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
    // The key is `prior` because that is what the invariants read. It was `previousApplication`
    // here for a while, which meant the two cross-application rules stood down on every real
    // upload while passing in every fixture — the fixtures set `prior` directly, so the tests
    // never touched the adapter that was getting it wrong.
    prior: previous ? {
      applicationNumber: previous.summary?.applicationNumber ?? null,
      periodTo: previous.summary?.periodTo ?? null,
      line4: previous.summary?.line4 ?? null,
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

// Waivers are the one family that runs on absence as much as on presence: a package with no
// waivers at all is a finding, not a reason to stand down. So this input is built whenever there
// is anything that could carry a lien, and the engine reports what is missing.
function waiverInput(data) {
  const { current } = data;
  const s = current.summary || {};
  if (!s.contractor && !(current.subApplications || []).length) return null;
  return {
    kind: 'waivers',
    meta: { applicationNumber: s.applicationNumber, periodTo: s.periodTo, contractor: s.contractor },
    summary: s,
    subApplications: current.subApplications || [],
    waivers: current.waivers || [],
  };
}

// Everything the contractor enclosed to prove a cost, as one list. The extractor records each
// document once; the two engines that read backup want it in different shapes, so the conversion
// happens here rather than asking the extractor to say the same thing twice.
const backupDocs = current => (current.backupDocuments || []).filter(d => isNum(d.amount));

function backupInput(data, contractTerms) {
  const { current } = data;
  const reports = current.costReports || [];
  // A cost report is what this engine reconciles against. Receipts alone give it nothing to
  // match them TO, so with no report it stands down — and says so, rather than reporting every
  // receipt as unexplained.
  if (!reports.length) return null;

  const transactions = reports.flatMap((r, i) => (r.transactions || []).map((t, j) => ({
    ...t, id: `${r.name || `report${i + 1}`}-${j}`, report: r.name || `report${i + 1}`,
  })));
  if (!transactions.length) return null;

  const reportTotals = {};
  for (const [i, r] of reports.entries()) {
    if (isNum(r.printedTotal)) reportTotals[r.name || `report${i + 1}`] = r.printedTotal;
  }

  return {
    kind: 'backup',
    meta: current.summary,
    reportTotals,
    transactions,
    receipts: backupDocs(current).map(d => ({
      id: `doc-p${d.page ?? '?'}-${d.ref || d.vendor || ''}`,
      vendor: d.vendor, ref: d.ref, date: d.date, amount: d.amount,
      description: d.description, page: d.page,
      excludedThisPeriod: d.excludedThisPeriod, excludedAmount: d.excludedAmount,
      exclusionNote: d.note,
    })),
    backupScope: current.backupScope,
    billedAgainstDetail: current.billedAgainstDetail || [],
    costRulings: contractTerms?.costRulings || [],
    priorRemovals: current.priorRemovals || [],
  };
}

function coverageInput(data, contractTerms) {
  const { current } = data;
  const s = current.summary || {};

  // This engine asks whether the paper attached to a LINE covers what that line bills, so a
  // document that does not say which line it belongs to cannot be used. Attributing it by guess
  // would be worse than leaving it out: it would report a shortfall on the line it was wrongly
  // attached to and cover a line that has nothing behind it.
  const lineByCode = new Map((current.lineItems || []).map(li => [String(li.itemNo), li]));
  const documentation = backupDocs(current).map((d) => {
    const line = d.supportsItemNo != null ? lineByCode.get(String(d.supportsItemNo)) : null;
    const lineName = line?.description || d.supportsLine || null;
    return lineName ? {
      line: lineName, kind: 'invoice', vendor: d.vendor, ref: d.ref,
      amount: d.amount, fees: null, page: d.page, note: d.note,
    } : null;
  }).filter(Boolean);

  if (!documentation.length) return null;
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
    documentation,
    priorFindings: current.priorDocumentationFindings || [],
  };
}

// The vendor rollup wants the schedule as a whole and each subcontractor's own totals beside it.
// Unlike every other input, it does NOT need anything to say which line belongs to which vendor —
// working that out is the engine's whole job — so nothing here is dropped for want of an
// attribution. What it does need is the vendor's own column totals, which only their application
// carries.
function vendorRollupInput(data) {
  const { current } = data;
  const s = current.summary || {};
  const subs = current.subApplications || [];
  if (!subs.length) return null;

  // A vendor with a this-period figure and nothing else cannot be rolled up: one column agreeing
  // is a coincidence, and the engine would rather say nothing than say that.
  const COLS = ['contractSum', 'previous', 'thisPeriod', 'totalToDate', 'retainage'];
  const vendors = subs
    .filter(v => v.vendor && COLS.filter(k => isNum(v[k])).length >= 2)
    .map(v => ({
      vendor: v.vendor,
      applicationNumber: v.applicationNumber || null,
      commitment: v.commitment || null,
      contractFor: v.contractFor || null,
      scheduledValue: isNum(v.contractSum) ? v.contractSum : null,
      previous: isNum(v.previous) ? v.previous : null,
      thisPeriod: isNum(v.thisPeriod) ? v.thisPeriod : null,
      totalToDate: isNum(v.totalToDate) ? v.totalToDate : null,
      balance: isNum(v.balanceToFinish) ? v.balanceToFinish : null,
      retainage: isNum(v.retainage) ? v.retainage : null,
      groups: v.groups || [],
    }));
  if (!vendors.length) return null;

  // Names a line already carries. The description is where a vendor's name usually appears, but
  // the contractor's own cost breakdown names them too, and a line whose breakdown section is
  // headed by the vendor is as good as one that says so in its title.
  const named = new Map();
  const add = (key, name) => {
    if (key == null || !name) return;
    const k = String(key);
    if (!named.has(k)) named.set(k, new Set());
    named.get(k).add(name);
  };
  for (const b of current.subBreakdowns || []) {
    const key = b.matchesItemNo ?? b.matchesDescription;
    add(key, b.subName);
    for (const c of b.components || []) add(key, c.vendor);
  }

  return {
    kind: 'vendorRollup',
    meta: { applicationNumber: s.applicationNumber, periodTo: s.periodTo, contractor: s.contractor },
    sovLines: (current.lineItems || []).map(li => ({
      itemNo: li.itemNo, description: li.description,
      scheduledValue: li.c, previous: li.d, thisPeriod: li.e,
      totalToDate: li.g, balance: li.h, retainage: li.retainage ?? li.i ?? null,
      vendors: [...(named.get(String(li.itemNo)) || []), ...(named.get(li.description) || [])],
    })),
    vendors,
  };
}

// Tax is the only engine whose rules come from the CONTRACT rather than from the application, so
// it is the only one that can be starved by a project with no contract uploaded. It still runs in
// that case — arithmetic and the owner's exempt status are checkable without one — and says
// plainly that it had no provisions to measure against.
function taxInput(data, contractTerms) {
  const { current } = data;
  const s = current.summary || {};
  const taxes = (current.taxes || []).filter(t => isNum(t.amount));
  if (!taxes.length) return null;
  return {
    kind: 'tax',
    meta: { applicationNumber: s.applicationNumber, periodTo: s.periodTo, contractor: s.contractor },
    contract: {
      ownerTaxExempt: contractTerms?.taxExempt ?? false,
      taxExemptBasis: contractTerms?.taxExemptBasis ?? null,
      feeRate: contractTerms?.feeRate ?? null,
    },
    taxRules: contractTerms?.taxRules || null,
    // Rulings the PM has already given on this project. A category settled in April must not be
    // asked about again in May — that is how a report trains its reader to skim.
    taxRulings: contractTerms?.taxRulings || [],
    taxes,
  };
}

// Every contract on file, each checked against the party it was signed with.
//
// Unlike every other adapter this one takes the CONTRACTS as its subject rather than the
// application: the question is not "is the package complete" but "does what each party billed
// match what each party agreed". It runs whenever a delivery method was recorded even with no
// contract at all, because "no contract is on file" is itself the finding a reviewer needs.
function contractInput(data, contractTerms, options = {}) {
  const { current } = data;
  const s = current.summary || {};
  const contracts = options.contracts || [];
  if (!contracts.length && !options.deliveryMethod && !(options.contractsPending || []).length) return null;

  // Which schedule lines belong to which subcontractor, borrowed from the rollup so the
  // unallowable-cost check looks only at the lines a party is actually billing. Absent the rollup
  // it is empty, and K5 simply checks fewer things rather than checking the wrong ones.
  const rollup = (options.engines || []).find(e => e.key === 'vendorRollup');
  const linesByVendor = {};
  for (const r of rollup?.rolls || []) {
    if (r.outcome === 'reconciled' || r.outcome === 'differs') linesByVendor[r.vendor.vendor] = r.lines;
  }

  return {
    kind: 'contracts',
    meta: { applicationNumber: s.applicationNumber, periodTo: s.periodTo, contractor: s.contractor },
    deliveryMethod: options.deliveryMethod || null,
    summary: s,
    lineItems: (current.lineItems || []).map(li => ({
      itemNo: li.itemNo, description: li.description, thisPeriod: li.e, totalToDate: li.g,
    })),
    subApplications: current.subApplications || [],
    linesByVendor,
    contracts,
    // Uploaded but not yet read. Named separately so K1 can say "still being read" rather than
    // "missing" — the same absence, two very different instructions to the reader.
    contractsPending: options.contractsPending || [],
  };
}

// Why a pass stood down, in words that are true of THIS package.
//
// The old sentences said "no backup was submitted" whenever these engines had no input, and a
// team reviewing a package with fifty pages of invoices bound into it was told their documents
// were not there. Nothing was submitted, backup was submitted and could not be read, and backup
// was submitted but says nothing about which line it belongs to are three different situations,
// and only one of them is the contractor's fault.

function absentBackup(current) {
  const docs = (current.backupDocuments || []).length;
  if (!docs) {
    return (current.backupPageCount || 0) > 0
      ? `The package carries about ${current.backupPageCount} page(s) of backup, but no invoice or `
        + 'receipt could be read from them, so nothing was matched. This is a reading failure, not '
        + 'a missing submission.'
      : 'No cost report or receipts were enclosed, so no charge was matched to a receipt.';
  }
  return `${docs} invoice(s) and receipt(s) were read from the package, but no job-cost or `
    + 'transaction report was enclosed to match them against, so nothing was reconciled.';
}

function absentCoverage(current) {
  const docs = (current.backupDocuments || []).length;
  if (!docs) {
    return (current.backupPageCount || 0) > 0
      ? `About ${current.backupPageCount} page(s) of backup are in the package but none could be `
        + 'read, so no line was checked for whether its documentation covers what it bills.'
      : 'No invoices or receipts were enclosed, so no line was checked for whether its '
        + 'documentation covers what it bills.';
  }
  return `${docs} invoice(s) and receipt(s) were read, but none of them states which billed line `
    + 'it supports, so they could not be checked against any line. Attaching them by guess would '
    + 'report a shortfall on the wrong line and cover a line that has nothing behind it.';
}

// ---- running them --------------------------------------------------------------------------------

const ENGINES = [
  { key: 'arithmetic', label: 'the schedule of values and G702', build: arithmeticInput, run: runInvariants,
    absent: 'No pay application figures were read.' },
  { key: 'subcontracts', label: "the contractor's cost breakdown and subcontractor applications",
    build: subcontractInput, run: runSubcontractChecks,
    absent: "No contractor cost breakdown was submitted, so nothing was traced from a schedule line down to a subcontractor's own application." },
  { key: 'waivers', label: 'lien waivers from everyone who could file one',
    build: waiverInput, run: runWaiverChecks,
    absent: 'Neither a contractor nor any subcontractor was identified, so no lien waiver was looked for.' },
  { key: 'backup', label: 'the cost report and its receipts', build: backupInput, run: runBackupChecks,
    absent: absentBackup },
  { key: 'coverage', label: 'documents attached to each billed line', build: coverageInput, run: runCoverageChecks,
    absent: absentCoverage },
  { key: 'vendorRollup', label: "each subcontractor's total against every line billing their scope",
    build: vendorRollupInput, run: runVendorRollupChecks,
    absent: "No subcontractor enclosed their own application with column totals, so no subcontract "
      + 'was checked against the whole set of schedule lines billing its scope. This is the check '
      + 'that catches a subcontractor whose work is billed in two places at once.' },
  { key: 'tax', label: "sales tax against the contract's own tax provisions",
    build: taxInput, run: runTaxChecks,
    absent: 'No separate tax line appears on any backup document read from this package, so no '
      + 'tax was reviewed. Tax buried inside a lump-sum invoice line cannot be seen.' },
  // Last deliberately: it reads the vendor rollup's output to know which lines each subcontractor
  // is billing, so it has to run after it.
  { key: 'contracts', label: "each party's billing against the contract signed with them",
    build: contractInput, run: runContractChecks,
    absent: 'No contract is on file for this project and no delivery method was recorded, so '
      + 'nothing on this application was checked against an agreement.' },
];

// `options` carries what the REVIEW knows rather than what the application says: which contracts
// are on file for the project, and whether this was submitted as a CSP or CMAR package. Both come
// from the upload form and the project's document shelf, and neither can be read off the PDF.
// On a CSP job the contractor bills the owner directly and there are no subcontractor
// applications to enclose. The generic sentences say a document is missing, which on that package
// is simply false — and a report that lists three things as unsubmitted when none of them was ever
// going to exist teaches its reader to skip the section where the real omission would appear.
const SUBCONTRACT_PASSES = new Set(['subcontracts', 'vendorRollup']);

function absentFor(engine, current, options) {
  if (options.deliveryMethod === CSP && SUBCONTRACT_PASSES.has(engine.key)) {
    return 'This was reviewed as a CSP application, where the contractor bills the owner directly. '
      + `Nothing was looked for under ${engine.label} — that absence is how the job is procured `
      + 'rather than a gap in the package.';
  }
  return typeof engine.absent === 'function' ? engine.absent(current) : engine.absent;
}

function runEngines(data, contractTerms = null, options = {}) {
  const engines = [];
  const findings = [];
  const notChecked = [];
  let checksRun = 0;
  let passed = 0;

  for (const engine of ENGINES) {
    let input = null;
    try {
      input = engine.build(data, contractTerms, { ...options, engines });
    } catch (err) {
      notChecked.push(`${engine.label} — could not be prepared (${err.message}).`);
      continue;
    }
    if (!input) {
      notChecked.push(absentFor(engine, data.current || {}, options));
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
    waivers: byEngine('waivers') ? waiverTable(byEngine('waivers').input) : null,
    coverage: byEngine('coverage') ? coverageTable(byEngine('coverage').lines) : null,
    vendorRollup: byEngine('vendorRollup') ? vendorRollupTable(byEngine('vendorRollup').rolls) : null,
    tax: byEngine('tax') ? taxTable(byEngine('tax').taxes) : null,
    contracts: byEngine('contracts') ? contractTable(byEngine('contracts').rows) : null,
    deliveryMethod: options.deliveryMethod || null,
    // The one figure from the tax pass that lands on a payment certificate rather than in a
    // paragraph. Null when the pass did not run, so the report can tell "nothing to deduct" apart
    // from "not checked".
    taxToDeduct: byEngine('tax') ? byEngine('tax').summary.taxToDeduct : null,
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
      enginesTotal: ENGINES.length,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      // Notes do not move the verdict. They print under a heading that says no action is
      // expected, so letting one downgrade an otherwise clean application would have the
      // report contradict itself.
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
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

// Folds the read-verification into the result, so the report says where its figures came from.
//
// These are notes, not errors: nothing here is the contractor's doing. But a report that silently
// corrected a figure would be hiding the most useful thing it knows, and one that stayed quiet
// about a line it could not verify would be claiming a confidence it does not have.
function attachReadCheck(result, readCheck) {
  if (!result || !readCheck) return result;
  const notes = (readCheck.findings || []).map(f => ({
    ...f, status: 'FAIL', severity: SEVERITY.NOTE, title: 'How the figures were read',
  }));
  if (notes.length) {
    result.findings = [...result.findings, ...notes];
    result.stats.notes += notes.length;
    result.stats.failed += notes.length;
  }
  if (readCheck.note) result.notChecked.push(readCheck.note);
  else if (readCheck.available) {
    result.notChecked.push(`${readCheck.confirmed} of ${(result.stats.lineItems || 0)} schedule `
      + "lines were checked figure by figure against the document's own text layer"
      + `${readCheck.corrections.length ? `, and ${readCheck.corrections.length} misread `
        + 'figure(s) were corrected from it' : ''}.`);
  }
  result.readCheck = {
    available: readCheck.available,
    confirmed: readCheck.confirmed,
    corrections: readCheck.corrections,
    unverified: readCheck.unverified.length,
  };
  return result;
}

module.exports = {
  runEngines, attachReadCheck, arithmeticInput, subcontractInput, backupInput, coverageInput,
  vendorRollupInput, taxInput, contractInput,
};
