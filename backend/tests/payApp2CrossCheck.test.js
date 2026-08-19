// THE CROSS-CHECK, which is the part of the CSP review that decides whether anything else it says
// can be believed.
//
// A pay app review is a reading plus arithmetic. On a scanned form one misread digit produces a
// cascade of confident, wrong dollar findings, and nothing downstream can tell "the contractor made
// an error" from "we misread the page". Reporting the second as the first destroys trust in the
// whole review faster than missing a finding does.
//
// The worked example below is the skill's own: a scheduled value read as 65,000 when the form says
// 85,000 produced three findings — a wrong balance to finish, a wrong percent complete, and a
// column total off by 20,000 — none of which were anyone's error.
//
// Every case here runs with no PDF, which is deliberate: with no page to re-read from, a flagged
// cell can only end up unverified, so these tests measure exactly what the cross-check caught and
// what it correctly withheld.

const assert = require('node:assert');
const { reviewPayApp } = require('../lib/payApp2Skill');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) {
    failures += 1; console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

// A small, internally consistent CSP application in the shape this app's extractor produces.
const line = (itemNo, description, c, d, e, g, h, pct) => ({
  itemNo, description, c, d, e, f: 0, g, h, pctComplete: pct, retainage: null,
});

function application(overrides = {}) {
  const lineItems = overrides.lineItems || [
    line('1', 'Project Management', 56000, 16800, 16800, 33600, 22400, 60),
    line('2', 'Procurement & Submittals', 85000, 20000, 30000, 50000, 35000, 58.8),
    line('3', 'Demolition', 12600, 0, 12600, 12600, 0, 100),
  ];
  const sum = key => lineItems.reduce((s, li) => s + (Number(li[key]) || 0), 0);
  return {
    summary: {
      applicationNumber: 4, periodTo: '2025-08-31', projectName: 'Spring Branch AHU',
      line1: 153600, line2: 0, line3: 153600,
      line4: overrides.line4 ?? sum('g'),
      line5: 4810, line5aAmount: 4810, line5bAmount: 0,
      line6: 91390, line7: 30000, line8: 61390, line9: 62210,
      ...overrides.summary,
    },
    lineItems,
    grandTotalRow: overrides.grandTotalRow || {
      c: sum('c'), d: sum('d'), e: sum('e'), f: 0, g: sum('g'), h: sum('h'), pctComplete: 62.6,
    },
    taxes: [],
  };
}

const run = (app, opts = {}) => reviewPayApp({
  current: app, previous: null, contractTerms: null, contracts: [],
  deliveryMethod: 'CSP', files: {}, ...opts,
});

const readingOf = r => r.cspReview.reading;
const checks = r => r.findings.map(f => f.check);

(async () => {
  console.log('CSP reading cross-check');

  await test('a consistent reading raises nothing', async () => {
    const r = await run(application());
    assert.strictEqual(readingOf(r).suspect, 0, 'no cell should be suspect');
    assert.strictEqual(readingOf(r).unverified.length, 0);
    assert.strictEqual(readingOf(r).checksWithheld.length, 0);
  });

  await test("the skill's worked example: 85,000 misread as 65,000 is caught, not reported", async () => {
    const app = application();
    // Only the scheduled value is wrong. G+H and G/pct both still say 85,000.
    app.lineItems[1].c = 65000;
    app.grandTotalRow.c = 133600;
    const r = await run(app);

    const flagged = readingOf(r).unverified;
    assert.ok(flagged.some(u => /Procurement/.test(u.location) && u.cell === 'scheduled value'),
      `the misread cell should be flagged, got ${JSON.stringify(flagged.map(u => u.cell))}`);

    // The three findings the misreading would otherwise have produced must not be in the list.
    assert.ok(!checks(r).includes('G703_ROW_H'),
      'the balance-to-finish finding is a symptom of the misread cell and must be withheld');
    assert.ok(!checks(r).includes('G703_ROW_PCT'),
      'the percent-complete finding is a symptom of the misread cell and must be withheld');
    assert.ok(r.cspReview.reading.checksWithheld.length > 0, 'withheld checks should be recorded');
  });

  await test('a misread total row is caught by the rows that feed it', async () => {
    const app = application();
    app.grandTotalRow.g = 96200 + 20; // 20 off, exactly the kind of slip that produces phantom findings
    const r = await run(app);
    assert.ok(readingOf(r).unverified.some(u => u.location === 'Schedule grand total row'),
      'the grand total row should be flagged');
    assert.ok(!checks(r).includes('G703_FOOTING'),
      'footing rests on the unverified total and must be withheld, not reported');
  });

  await test('a genuine overbill on a verified line is still reported', async () => {
    const app = application();
    // Billed past the scheduled value, with every other cell agreeing that it was.
    app.lineItems[2] = line('3', 'Demolition', 12600, 0, 15750, 15750, -3150, 125);
    const gt = app.grandTotalRow;
    gt.e = 16800 + 30000 + 15750; gt.g = 33600 + 50000 + 15750; gt.h = 22400 + 35000 - 3150;
    app.summary.line4 = gt.g;
    const r = await run(app);

    assert.strictEqual(readingOf(r).suspect, 0, 'nothing here is a misreading');
    assert.ok(checks(r).includes('G703_OVERBILL'), 'the overbill must be reported');
    // The same fact stated twice reads as two problems. The negative balance is the overbill.
    assert.ok(!checks(r).includes('G703_NEGATIVE_BALANCE'),
      'a negative balance on an overbilled line is the same finding and must be suppressed');
  });

  await test('an unverifiable figure is named in what was not checked', async () => {
    const app = application();
    app.lineItems[1].c = 65000;
    app.grandTotalRow.c = 133600;
    const r = await run(app);
    const said = r.notChecked.join(' ');
    assert.match(said, /could not be corroborated/,
      'the report must say the figure was unverified rather than stay silent');
    assert.match(said, /held back/, 'the withheld checks must be disclosed');
  });

  await test('progress judgments never enter the findings list', async () => {
    const r = await run(application());
    assert.ok(Array.isArray(r.siteChecklist), 'a site checklist is always returned');
    assert.ok(!r.findings.some(f => /worth a second look|PLAUSIBILITY/i.test(f.check + f.title)),
      'progress observations belong on the checklist, not among the findings');
  });

  // THE THREE STATES OF A PREVIOUS APPLICATION.
  //
  // "None was supplied", "one was supplied but nothing came out of it", and "it was read but has no
  // schedule" are indistinguishable to a truthiness test and mean completely different things to
  // whoever reads the report. Telling someone their file was missing when they supplied it is the
  // worst of the three: it reads as a fact about their paperwork while hiding a fault in ours, and
  // it sends them looking in the wrong place.

  await test('no previous application supplied says exactly that, and only notes it', async () => {
    const r = await run(application(), { previous: null, previousSupplied: false });
    assert.ok(checks(r).includes('NO_PRIOR'));
    assert.strictEqual(r.findings.find(f => f.check === 'NO_PRIOR').severity, 'note',
      'an absent previous application is a note, not a defect');
    assert.strictEqual(r.cspReview.inputsReceived.previousSupplied, false);
  });

  await test('a previous application supplied but unreadable is a fault, not a silence', async () => {
    const r = await run(application(), { previous: null, previousSupplied: true });
    assert.ok(!checks(r).includes('NO_PRIOR'),
      'it must never say none was supplied when one was');
    assert.ok(checks(r).includes('PRIOR_EMPTY'), 'the failed reading must be reported');
    assert.strictEqual(r.findings.find(f => f.check === 'PRIOR_EMPTY').severity, 'material');
    assert.match(r.notChecked.join(' '), /one was supplied, but nothing could be read/,
      'the report must say the reading failed rather than that the file was absent');
    assert.match(r.findings.find(f => f.check === 'PRIOR_EMPTY').detail, /not a finding about the contractor/i);
  });

  await test('a previous application with no schedule lines is named as such', async () => {
    const empty = application();
    empty.lineItems = [];
    empty.grandTotalRow = null;
    const r = await run(application(), { previous: empty, previousSupplied: true });
    assert.ok(checks(r).includes('PRIOR_NO_SCHEDULE'));
    assert.ok(!checks(r).includes('CONTINUITY_D'), 'continuity cannot run without a prior schedule');
  });

  // Last month's application, internally consistent, whose column G is this month's column D.
  // Built explicitly rather than by mutating the current one: a prior whose own arithmetic does not
  // hold gets flagged by the cross-check for reasons that have nothing to do with the test.
  const priorApplication = (schedule = [56000, 85000, 12600]) => {
    const lineItems = [
      line('1', 'Project Management', schedule[0], 0, 16800, 16800, schedule[0] - 16800, 30),
      line('2', 'Procurement & Submittals', schedule[1], 0, 20000, 20000, schedule[1] - 20000,
        +(20000 / schedule[1] * 100).toFixed(1)),
      line('3', 'Demolition', schedule[2], 0, 0, 0, schedule[2], 0),
    ];
    const sum = k => lineItems.reduce((s, li) => s + (Number(li[k]) || 0), 0);
    return {
      summary: { applicationNumber: 3, line6: 30000 },
      lineItems,
      grandTotalRow: { c: sum('c'), d: 0, e: sum('e'), f: 0, g: sum('g'), h: sum('h'), pctComplete: 24 },
      taxes: [],
    };
  };

  await test('continuity that actually ran says so, with what it ran against', async () => {
    const r = await run(application(), { previous: priorApplication(), previousSupplied: true });
    assert.match(r.notChecked.join(' '), /Continuity was checked line by line against application 3/,
      'a check that ran must be visible; silence reads identically to never running');
    assert.strictEqual(r.cspReview.inputsReceived.previousLineItems, 3);
  });

  await test("a misread in LAST MONTH's schedule does not become this month's finding", async () => {
    // The prior's own G+H and G/pct both still say 85,000, so its 65,000 is outvoted.
    const prior = priorApplication();
    prior.lineItems[1].c = 65000;
    prior.grandTotalRow.c = 133600;
    const r = await run(application(), { previous: prior, previousSupplied: true });

    assert.ok(r.cspReview.reading.priorSuspect > 0, "last month's misread must be detected");
    const said = r.notChecked.join(' ');
    assert.match(said, /LAST MONTH'S application/,
      'the reader must know the doubtful figure is not on the application in front of them');
    assert.ok(!checks(r).includes('SOV_DRIFT'),
      'a scheduled value that differs only because last month was misread is not a change order finding');
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
