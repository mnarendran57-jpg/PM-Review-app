// Scores the invariant engine against real pay applications.
//
//   node tests/payAppInvariants.test.js            all fixtures
//   node tests/payAppInvariants.test.js horizon    only fixtures whose file name matches
//   node tests/payAppInvariants.test.js -v         show every finding in full
//
// Needs no server, no database and no API key: the fixtures carry figures already read from
// the documents, so this measures the RULES, not the reading. Extraction gets its own harness
// once this one is trusted.
//
// Three numbers matter, and the third matters most:
//   caught      a real error the engine found
//   missed      a real error it walked past
//   unexpected  a finding on something that is not wrong
//
// Unexpected findings are the ones that destroy a reviewer's usefulness. A tool that cries
// wolf gets ignored, and then the real finding is ignored with it. So an unexpected finding
// fails the run just as hard as a missed one.

const fs = require('fs');
const path = require('path');
const { runInvariants, groupFindings, money } = require('../lib/payAppInvariants');
const { runBackupChecks } = require('../lib/payAppBackup');
const { runCoverageChecks, coverageTable } = require('../lib/payAppCoverage');
const { runSubcontractChecks, chainTable } = require('../lib/payAppSubcontracts');

const ENGINES = {
  backup: runBackupChecks,
  coverage: runCoverageChecks,
  subcontracts: runSubcontractChecks,
};

const DIR = path.join(__dirname, 'fixtures', 'payapp');
const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const filter = args.find(a => !a.startsWith('-'));

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[36m',
};
const paint = (c, s) => `${C[c]}${s}${C.reset}`;

// An expected finding matches an actual one when the invariant fires in the place the fixture
// says it should. Location is only compared when the fixture bothers to state it, so a fixture
// can say "I12 fires" without pinning down a field that might legitimately move.
function matches(expected, actual) {
  if (expected.id !== actual.id) return false;
  if (expected.itemNo != null && String(expected.itemNo) !== String(actual.where?.itemNo)) return false;
  if (expected.field != null && expected.field !== actual.where?.field) return false;
  if (expected.page != null && expected.page !== actual.where?.page) return false;
  if (expected.ref != null && String(expected.ref) !== String(actual.where?.ref)) return false;
  return true;
}

const place = f => {
  const w = f.where || {};
  const bits = [];
  if (w.page != null) bits.push(`p${w.page}`);
  if (w.itemNo != null) bits.push(`item ${w.itemNo}`);
  if (w.field) bits.push(w.field);
  if (w.ref) bits.push(String(w.ref));
  else if (w.vendor) bits.push(String(w.vendor));
  return bits.length ? bits.join(' · ') : 'summary';
};

const SEV_COLOR = { critical: 'red', material: 'yellow', note: 'dim' };

function runFixture(file) {
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const expected = fixture.expected || { findings: [] };
  // Three families, three engines. Arithmetic fixtures carry G702/G703 figures; backup fixtures
  // carry transactions and receipts; coverage fixtures carry a schedule of values and the
  // documents attached to each line. The `kind` field says which.
  const { findings, summary, verdict, results, lines, codes } =
    (ENGINES[fixture.kind] || runInvariants)(fixture);

  const unmatchedActual = [...findings];
  const caught = [];
  const missed = [];
  for (const exp of expected.findings) {
    const hit = unmatchedActual.findIndex(a => matches(exp, a));
    if (hit === -1) missed.push(exp);
    else caught.push({ exp, actual: unmatchedActual.splice(hit, 1)[0] });
  }
  // Findings the ground truth cannot settle: the engine raises them, the PM's list does not
  // cover them, and I have no basis to call them right or wrong. Counting them as hits would
  // flatter the engine; counting them as false positives would condemn it. They are pulled out
  // and shown for a human ruling instead.
  const unresolved = [];
  for (const u of expected.unresolved || []) {
    const hit = unmatchedActual.findIndex(a => matches(u, a));
    if (hit !== -1) unresolved.push({ u, actual: unmatchedActual.splice(hit, 1)[0] });
  }
  const unexpected = unmatchedActual;
  const verdictOk = !expected.verdict || expected.verdict === verdict;
  const ok = missed.length === 0 && unexpected.length === 0 && verdictOk;

  console.log(`\n${paint('bold', fixture.name || file)}`);
  console.log(paint('dim', `  ${fixture.$source || file}`));
  console.log(`  ${summary.checksRun} checks — ${paint('green', `${summary.passed} pass`)}, `
    + `${summary.failed} fail, ${paint('dim', `${summary.skipped} skipped`)}`);
  console.log(`  verdict: ${verdictOk ? paint('green', verdict) : paint('red', `${verdict}  (expected ${expected.verdict})`)}`);

  if (caught.length) {
    console.log(paint('green', `\n  caught ${caught.length}/${expected.findings.length} expected:`));
    for (const { exp, actual } of caught) {
      console.log(`    ${paint(SEV_COLOR[actual.severity] || 'dim', actual.severity.padEnd(8))} `
        + `${actual.id.padEnd(4)} ${place(actual).padEnd(22)} ${exp.why || actual.title}`);
      if (verbose) console.log(paint('dim', `             ${actual.detail}`));
    }
  }
  if (missed.length) {
    console.log(paint('red', `\n  MISSED ${missed.length} real error(s) the engine should have found:`));
    for (const m of missed) console.log(`    ${m.id.padEnd(4)} ${m.why || ''}`);
  }
  if (unexpected.length) {
    console.log(paint('red', `\n  UNEXPECTED ${unexpected.length} finding(s) on something not known to be wrong:`));
    for (const u of unexpected) {
      console.log(`    ${u.id.padEnd(4)} ${place(u).padEnd(30)} ${u.detail}`);
    }
  }

  if (unresolved.length) {
    console.log(paint('blue', `
  ${unresolved.length} finding(s) awaiting a ruling — raised by the engine, not on the PM's list:`));
    for (const { u, actual } of unresolved) {
      console.log(`    ${actual.id.padEnd(4)} ${place(actual).padEnd(30)} ${u.why}`);
    }
  }

  // Skips are printed because a check that quietly stood down is indistinguishable, in a
  // report, from one that passed — and the difference matters a great deal.
  if (verbose) {
    const skipped = results.filter(r => r.status === 'SKIPPED');
    const byId = new Map();
    for (const s of skipped) if (!byId.has(s.id)) byId.set(s.id, s);
    if (byId.size) {
      console.log(paint('dim', `\n  stood down (${skipped.length}):`));
      for (const s of byId.values()) console.log(paint('dim', `    ${s.id.padEnd(4)} ${s.detail}`));
    }
    // For a coverage fixture the table IS most of the value: the findings say what is wrong,
    // the table says what was looked at, which is how a reader satisfies themselves that a
    // quiet line is quiet because it is fine.
    if (lines) {
      console.log(paint('blue', '\n  what stands behind each line billed this period:'));
      for (const row of coverageTable(lines)) {
        const mark = { short: 'red', 'none supplied': 'yellow', documented: 'green' }[row.status] || 'dim';
        console.log(`    ${paint(mark, row.status.padEnd(14))} ${row.line.slice(0, 46).padEnd(46)} `
          + `${money(row.billed).padStart(13)}  ${row.evidence}`
          + (row.shortfall ? paint('red', `   short ${money(row.shortfall)}`) : ''));
      }
    }
    // For a subcontract fixture the descent is the thing worth seeing: owner's line, the cost
    // entries behind it, and which subcontractor's own application backs them.
    if (codes) {
      console.log(paint('blue', '\n  the chain, cost code by cost code:'));
      for (const row of chainTable(fixture, codes)) {
        console.log(`    ${row.ties ? paint('green', 'ties  ') : paint('red', 'BREAKS')} `
          + `${row.code} ${row.description.slice(0, 30).padEnd(30)} `
          + `${money(row.billedToOwner ?? 0).padStart(13)}  ${row.costEntries} entr${row.costEntries === 1 ? 'y' : 'ies'}`
          + (row.subcontractors.length ? paint('dim', `  <- ${row.subcontractors.join('; ')}`) : ''));
      }
    }
    const groups = groupFindings(findings);
    if (groups.length) {
      console.log(paint('blue', `\n  as the report would group them — ${groups.length} issue(s) from ${findings.length} finding(s):`));
      for (const g of groups) {
        console.log(`    ${paint(SEV_COLOR[g.severity] || 'dim', '•')} ${place(g.primary)}: ${g.primary.detail}`);
        for (const a of g.alsoTrips) console.log(paint('dim', `        also: ${a.title.toLowerCase()}`));
      }
    }
  }

  console.log(ok ? paint('green', '\n  PASS') : paint('red', '\n  FAIL'));
  return { ok, caught: caught.length, missed: missed.length, unexpected: unexpected.length,
           unresolved: unresolved.length, expected: expected.findings.length };
}

// A clean fixture passing tells you nothing on its own — a check that stood down, or one whose
// comparison is vacuous, passes just as quietly as one that works. So each clean application is
// also run with a single figure nudged, and every nudge must be noticed. A mutation that slips
// through is a rule that is not actually watching the thing it claims to watch.
const MUTATIONS = [
  ['Line 8 overstated by $100',            a => { a.summary.line8 += 100; }],
  ['Line 9 overstated by $100',            a => { a.summary.line9 += 100; }],
  ['Line 7 understated by $100',           a => { a.summary.line7 -= 100; }],
  ['Line 3 overstated by $100',            a => { a.summary.line3 += 100; }],
  ['Line 4 overstated by $100',            a => { a.summary.line4 += 100; }],
  ['retainage overstated by $100',         a => { a.summary.line5aAmount += 100; a.summary.line5Total += 100; }],
  ['a line billed $100 beyond its value',  a => { const li = a.lineItems.find(x => x.c > 0); li.g = li.c + 100; }],
  ['a line claims $100 more done before',  a => { a.lineItems[0].d += 100; }],
  ['the grand total inflated by $100',     a => { a.grandTotals.g += 100; }],
];

// A coverage fixture cannot be scored the same way. Its clean lines are clean because no
// documentation packet was supplied for them, and the honest expectation is silence — so
// "produced no findings" proves nothing. Instead each mutation states the finding it must
// provoke BY NAME, which is the only way to tell a check that works from one that happens to be
// firing about something else.
const COVERAGE_MUTATIONS = [
  ['the one supporting invoice is withdrawn', 'C3',
    a => { a.documentation = a.documentation.filter(d => d.line !== 'Ground Breaking'); }],
  ['the invoice is inflated past what is billed', 'C4',
    a => { a.documentation.find(d => d.line === 'Ground Breaking').amount = 20000; }],
  ['a line goes unread, breaking the printed total', 'C1',
    a => { a.lineItems = a.lineItems.filter(l => l.description !== 'Demolition - IDR'); }],
  ['a question carried over from application 3 is still open', 'C6',
    a => { a.priorFindings = [{ line: 'Building Permit', amount: 645.85, raisedIn: '3', status: 'open' }]; }],
  // With the packet in hand and no subcontractor named, a line has to be asked about rather
  // than assumed to be covered by a sub's own application. Both halves are needed: unrecognised
  // performer AND documentation we actually hold.
  ['a subcontract line loses its subcontractor', 'C3',
    a => { a.subcontractors = []; a.documentationScope = null; }],
];

// The same idea for the backup engine. Only the allowance checks are nudged here — the matching
// tiers are already exercised by the two Bartlett fixtures, which carry real unmatched charges
// and real orphan receipts. A mutation that the fixture cannot express throws and is not counted,
// so a packet with no cost codes simply reports nothing rather than failing.
const withCode = (a, code) => {
  const rows = (a.transactions || []).filter(t => t.costCode === code);
  if (!rows.length) throw new Error('not in this fixture');
  return rows;
};

const BACKUP_MUTATIONS = [
  ['a struck allowance is billed again', 'R10',
    a => withCode(a, '013100-210').forEach(t => { t.removed = false; })],
  ['a cost removed on an earlier application reappears', 'R12',
    a => {
      withCode(a, '015200-110');
      a.priorRemovals = [{ code: '015200-110', name: 'Computers & Software', application: '0', amount: 2106 }];
    }],
  ['the removal is annotated but never deducted', 'R7',
    a => {
      if (!a.billedAgainstDetail?.length) throw new Error('not in this fixture');
      a.billedAgainstDetail[0].excludedTotal = 0;
    }],
  ['a ruling is forgotten and the cost comes back', 'R11',
    a => {
      withCode(a, '013100-230').forEach(t => { t.removed = false; });
      a.costRulings = (a.costRulings || []).filter(r => r.code !== '013100-230');
    }],
  ['a transaction goes unread, breaking the printed total', 'R1',
    a => { a.transactions = (a.transactions || []).slice(0, -1); }],
];

function runBackupMutations(base) {
  const undetected = [];
  let applicable = 0;
  for (const [label, expectId, mutate] of BACKUP_MUTATIONS) {
    const copy = JSON.parse(JSON.stringify(base));
    try { mutate(copy); } catch { continue; }
    applicable++;
    const { findings } = runBackupChecks(copy);
    if (!findings.some(f => f.id === expectId)) undetected.push(`${label} (expected ${expectId})`);
  }
  if (!applicable) return null;
  console.log(`  sensitivity: ${applicable - undetected.length}/${applicable} single changes noticed`
    + (undetected.length ? paint('red', ` — MISSED: ${undetected.join('; ')}`) : paint('green', ' ✓')));
  return undetected.length === 0;
}

// The subcontract fixture is almost entirely correct, so twenty-six passing checks prove nothing
// on their own. Each mutation breaks exactly one link in the chain and names the check that must
// notice — the only way to tell a check that agrees from a check that never looked.
const findEntry = (a, ref) => {
  const e = (a.breakdown || []).find(x => x.ref === ref);
  if (!e) throw new Error('not in this fixture');
  return e;
};
const findLine = (a, code) => {
  const l = (a.sovLines || []).find(x => x.code === code);
  if (!l) throw new Error('not in this fixture');
  return l;
};

const SUB_MUTATIONS = [
  ['a cost code no longer ties to its schedule line', 'S2',
    a => { findLine(a, '024100').thisPeriod += 100; }],
  ['the fee is taken on a base that is not the costs', 'S3',
    a => { a.invoiceSummary.feeBase += 1000; }],
  ['retainage is under-withheld by $100', 'S4',
    a => { a.invoiceSummary.retainage = -16254.34; }],
  // Deliberately mutating the SUB rather than the contractor. Inflating a cost entry would break
  // the invoice total and the gate would stop everything before S5 ran — which is correct
  // behaviour, and would have made this mutation prove nothing. The real shape of this failure is
  // the subcontractor billing less than the contractor passes through.
  ['the sub billed less than the contractor passes through', 'S5',
    a => { a.subApplications.find(s => s.commitment === '225020-004').thisPeriod -= 500; }],
  ['the sub and the owner disagree about what was billed before', 'S5',
    a => { a.subApplications.find(s => s.commitment === '225020-003').previous += 250; }],
  ['the sub is retained at a different rate than the owner', 'S5',
    a => { a.subApplications.find(s => s.commitment === '225020-004').retainage = 2050; }],
  ['a sub bills past its own subcontract', 'S5',
    a => { a.subApplications.find(s => s.commitment === '225020-003').totalToDate = 500000; }],
  ['a subcontract charge loses its commitment reference', 'S6',
    a => { findEntry(a, '225020-003-2').ref = 'INV88213'; }],
  ['an entry goes unread, breaking the invoice total', 'S1',
    a => { a.breakdown = a.breakdown.filter(e => e.ref !== '225020-003-2'); }],
];

function runSubMutations(base) {
  const undetected = [];
  let applicable = 0;
  for (const [label, expectId, mutate] of SUB_MUTATIONS) {
    const copy = JSON.parse(JSON.stringify(base));
    try { mutate(copy); } catch { continue; }
    applicable++;
    const { findings } = runSubcontractChecks(copy);
    if (!findings.some(f => f.id === expectId)) undetected.push(`${label} (expected ${expectId})`);
  }
  if (!applicable) return null;
  console.log(`  sensitivity: ${applicable - undetected.length}/${applicable} single changes noticed`
    + (undetected.length ? paint('red', ` — MISSED: ${undetected.join('; ')}`) : paint('green', ' ✓')));
  return undetected.length === 0;
}

function runCoverageMutations(base) {
  const undetected = [];
  for (const [label, expectId, mutate] of COVERAGE_MUTATIONS) {
    const copy = JSON.parse(JSON.stringify(base));
    try { mutate(copy); } catch { continue; }
    const { findings } = runCoverageChecks(copy);
    if (!findings.some(f => f.id === expectId)) undetected.push(`${label} (expected ${expectId})`);
  }
  const detected = COVERAGE_MUTATIONS.length - undetected.length;
  console.log(`  sensitivity: ${detected}/${COVERAGE_MUTATIONS.length} single changes noticed`
    + (undetected.length ? paint('red', ` — MISSED: ${undetected.join('; ')}`) : paint('green', ' ✓')));
  return undetected.length === 0;
}

function runMutations(file) {
  const base = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  if (base.kind === 'coverage') return runCoverageMutations(base);
  if (base.kind === 'subcontracts') return runSubMutations(base);
  if (base.kind === 'backup') return runBackupMutations(base);
  if ((base.expected?.findings || []).length) return null;   // only meaningful on a clean one

  const undetected = [];
  for (const [label, mutate] of MUTATIONS) {
    const copy = JSON.parse(JSON.stringify(base));
    try { mutate(copy); } catch { continue; }                // fixture lacks what this nudges
    const { findings } = runInvariants(copy);
    if (!findings.length) undetected.push(label);
  }

  const detected = MUTATIONS.length - undetected.length;
  console.log(`  sensitivity: ${detected}/${MUTATIONS.length} single-figure changes noticed`
    + (undetected.length ? paint('red', ` — MISSED: ${undetected.join('; ')}`) : paint('green', ' ✓')));
  return undetected.length === 0;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && (!filter || f.includes(filter))).sort();
if (!files.length) {
  console.error(`No fixtures matched${filter ? ` "${filter}"` : ''} in ${DIR}`);
  process.exit(1);
}

console.log(paint('bold', `\nPay app invariant engine — ${files.length} fixture(s)`));
const totals = { ok: 0, caught: 0, missed: 0, unexpected: 0, expected: 0, blind: 0, unresolved: 0 };
for (const f of files) {
  const r = runFixture(f);
  const sensitive = runMutations(f);
  if (sensitive === false) { totals.blind++; r.ok = false; }
  totals.ok += r.ok ? 1 : 0;
  totals.caught += r.caught;
  totals.missed += r.missed;
  totals.unexpected += r.unexpected;
  totals.unresolved += r.unresolved;
  totals.expected += r.expected;
}

console.log(paint('bold', '\n────────────────────────────────────────────────────────'));
console.log(`  fixtures passing   ${totals.ok}/${files.length}`);
console.log(`  real errors caught ${totals.caught}/${totals.expected}`);
console.log(`  missed             ${totals.missed}`);
console.log(`  unexpected         ${totals.unexpected}${totals.unexpected ? paint('red', '   <- the number that decides whether this is trustworthy') : ''}`);
console.log('');

process.exit(totals.ok === files.length ? 0 : 1);
