const assert = require('assert');
const { runChecks, reconcileSub, PASS, FAIL, NOTE, UNKNOWN } = require('../lib/cmarChecks');
const { buildReport, HEADLINE_QUESTIONS } = require('../lib/cmarReport');
const { renderCmarReportPdf } = require('../lib/cmarReportPdf');

// The arithmetic half of the CMAR audit, checked against packets built by hand.
//
// Every case here is a pay application with exactly one thing wrong with it, and the test asserts
// that the one thing is found AND that nothing else is. A check that fires on everything is as
// useless as one that fires on nothing, and only the second half of that catches it.
//
// No API call is made anywhere in this file. That is the point of keeping the arithmetic in code:
// it can be proven, for free, every time, rather than sampled.

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

const find = (result, title) => result.findings.find(f => f.title === title);
const statusOf = (result, title) => find(result, title)?.status;

// A packet that is correct in every respect. Each test below takes this and breaks exactly one
// thing, so a failure anywhere else in the result is a false positive and the test says so.
function goodPacket(overrides = {}) {
  return {
    projectName: 'Example Middle School',
    ownerName: 'Example Independent School District',
    contractorName: 'Example Construction, LLC',
    certificate: {
      applicationNumber: '7',
      periodTo: '2026-07-31',
      certifiedDate: '2026-08-05',
      line1OriginalContractSum: 10000000,
      line2NetChangeByChangeOrders: 250000,
      line3ContractSumToDate: 10250000,
      line4CompletedAndStoredToDate: 4000000,
      line5Retainage: 200000,
      line6TotalEarnedLessRetainage: 3800000,
      // Previous applications on the continuation sheet total 3,200,000; less 5% retainage that is
      // 3,040,000, and Line 7 has to agree with it or the packet is not actually clean.
      line7LessPreviousCertificates: 3040000,
      line8CurrentPaymentDue: 760000,
      line9BalanceToFinish: 6450000,
    },
    retainagePercent: 5,
    sovRows: [
      {
        description: 'General conditions',
        scheduledValue: 1000000,
        previousApplications: 400000,
        thisPeriod: 100000,
        storedMaterials: 0,
        completedToDate: 500000,
        isSubtotal: false,
        category: 'General',
      },
      {
        description: 'Concrete',
        scheduledValue: 5000000,
        previousApplications: 2000000,
        thisPeriod: 500000,
        storedMaterials: 0,
        completedToDate: 2500000,
        isSubtotal: false,
        category: 'Structure',
      },
      {
        description: 'Mechanical',
        scheduledValue: 4000000,
        previousApplications: 800000,
        thisPeriod: 200000,
        storedMaterials: 0,
        completedToDate: 1000000,
        isSubtotal: false,
        category: 'MEP',
      },
      {
        description: 'Contingency',
        scheduledValue: 250000,
        previousApplications: 0,
        thisPeriod: 0,
        storedMaterials: 0,
        completedToDate: 0,
        isSubtotal: false,
        isContingencyOrAllowance: true,
        category: 'Contingency',
      },
      // A subtotal row. Counted as work it would double the schedule of values, so it must be
      // excluded from every sum.
      {
        description: 'TOTAL',
        scheduledValue: 10250000,
        completedToDate: 4000000,
        isSubtotal: true,
      },
    ],
    notary: {
      signaturePresent: true,
      notaryStampPresent: true,
      notarySignaturePresent: true,
      notarySignedDate: '2026-08-05',
      commissionExpiryDate: '2028-01-31',
      observation: 'Signed, stamped and dated.',
    },
    subApplications: [],
    backupInvoices: [],
    ...overrides,
  };
}

const goodTerms = (overrides = {}) => ({
  contractForm: 'AIA A133-2019',
  retainagePercent: 5,
  retainageClause: 'Section 5.1.7',
  taxExemptionClause: { present: false },
  changeOrderCap: { present: false },
  lienWaiverRequirement: { present: false },
  ...overrides,
});

console.log('\nA correct application passes:');

check('a clean packet produces no issues at all', () => {
  const result = runChecks(goodPacket(), goodTerms());
  const fails = result.findings.filter(f => f.status === FAIL);
  assert.strictEqual(fails.length, 0,
    `expected no failures, got: ${fails.map(f => `${f.title} (${f.detail})`).join(' | ')}`);
  assert.strictEqual(result.certifiable, true);
});

check('subtotal rows are excluded from the schedule-of-values sums', () => {
  // The TOTAL row carries the full contract sum. If it were counted as work, the scheduled values
  // would come to 20,500,000 and the check would fail. That it passes is the proof.
  const result = runChecks(goodPacket(), goodTerms());
  assert.strictEqual(statusOf(result, 'Schedule of values totals to the Contract Sum'), PASS);
});

console.log('\nThe nine lines are recomputed:');

check('Line 3 that does not equal Line 1 plus Line 2 is caught', () => {
  const packet = goodPacket();
  packet.certificate.line3ContractSumToDate = 10200000;   // $50,000 short
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Line 3 — Contract Sum to Date');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 50000);
});

check('Line 6 that does not equal Line 4 less Line 5 is caught', () => {
  const packet = goodPacket();
  packet.certificate.line6TotalEarnedLessRetainage = 3805000;
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Line 6 — Total Earned Less Retainage');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 5000);
  assert.ok(/overstated/.test(f.detail), 'should say which way it is wrong');
});

check('Line 8 that does not equal Line 6 less Line 7 is caught', () => {
  const packet = goodPacket();
  packet.certificate.line8CurrentPaymentDue = 812000;
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Line 8 — Current Payment Due'), FAIL);
});

check('a mismatch just past the rounding threshold is an issue, not a note', () => {
  // The boundary matters more than either side of it. A tolerance set loosely enough to swallow
  // a small real error is the failure this guards against, and nothing else in this file would
  // notice it — every other broken figure here is wrong by thousands.
  const packet = goodPacket();
  packet.certificate.line6TotalEarnedLessRetainage = 3800025;   // $25 out
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Line 6 — Total Earned Less Retainage'), FAIL);
  assert.strictEqual(result.certifiable, false);
});

check('a mismatch inside a dollar is a note, not an issue', () => {
  const packet = goodPacket();
  packet.certificate.line6TotalEarnedLessRetainage = 3800000.75;
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Line 6 — Total Earned Less Retainage'), NOTE);
  assert.strictEqual(result.certifiable, true, 'a rounding artifact must not block certification');
});

console.log('\nThe schedule of values is reconciled to the summary page:');

check('scheduled values that do not total the Contract Sum are caught', () => {
  const packet = goodPacket();
  packet.sovRows[1].scheduledValue = 4900000;       // $100,000 dropped from the budget
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Schedule of values totals to the Contract Sum');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 100000);
  assert.ok(/Unallocated/.test(f.detail));
});

check('completed-to-date that does not total Line 4 is caught', () => {
  const packet = goodPacket();
  packet.sovRows[2].completedToDate = 1100000;
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Schedule of values totals to work completed'), FAIL);
});

check('a row whose columns do not add across is named', () => {
  const packet = goodPacket();
  packet.sovRows[0].completedToDate = 520000;       // previous + this period is 500,000
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Every schedule-of-values row adds up across its columns');
  assert.strictEqual(f.status, FAIL);
  assert.ok(f.detail.includes('General conditions'), 'the offending row must be named');
});

console.log('\nWhat was already paid:');

check('Line 7 is checked against the prior application when it is in the packet', () => {
  const packet = goodPacket({
    priorApplication: { applicationNumber: '6', line6TotalEarnedLessRetainage: 3090000 },
  });
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Line 7 carries forward from the previous application');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 50000);
});

check('a matching prior application passes', () => {
  const packet = goodPacket({
    priorApplication: { applicationNumber: '6', line6TotalEarnedLessRetainage: 3040000 },
  });
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Line 7 carries forward from the previous application'), PASS);
});

check('with no prior application, Line 7 falls back to the continuation sheet', () => {
  const packet = goodPacket();
  packet.certificate.line7LessPreviousCertificates = 3000000;   // sheet says 3,040,000
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Line 7 matches previous billing less retainage');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 40000);
});

check('a Line 7 that agrees with the continuation sheet passes', () => {
  const result = runChecks(goodPacket(), goodTerms());
  assert.strictEqual(statusOf(result, 'Line 7 matches previous billing less retainage'), PASS);
});

console.log('\nRetainage:');

check('retainage held above the contracted rate is caught', () => {
  const packet = goodPacket();
  packet.certificate.line5Retainage = 400000;       // 10% against a contracted 5%
  packet.certificate.line6TotalEarnedLessRetainage = 3600000;
  packet.certificate.line8CurrentPaymentDue = 560000;
  packet.certificate.line9BalanceToFinish = 6650000;
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Retainage is held at the contracted rate');
  assert.strictEqual(f.status, FAIL);
  assert.ok(/10%/.test(f.detail) && /5%/.test(f.detail));
});

check('with no contracted rate on file, retainage is reported unchecked rather than passed', () => {
  const result = runChecks(goodPacket(), goodTerms({ retainagePercent: null }));
  const f = find(result, 'Retainage is held at the contracted rate');
  assert.strictEqual(f.status, UNKNOWN);
  assert.ok(/internal consistency/.test(f.detail),
    'the report must say what it could not check, not imply it checked it');
});

check('a subcontractor held at a higher rate than the owner holds is caught', () => {
  const packet = goodPacket({
    subApplications: [{
      firmName: 'Sub One, Inc.',
      certificate: {
        line1OriginalContractSum: 500000,
        line3ContractSumToDate: 500000,
        line4CompletedAndStoredToDate: 200000,
        line5Retainage: 20000,
        line6TotalEarnedLessRetainage: 180000,
        line7LessPreviousCertificates: 100000,
        line8CurrentPaymentDue: 80000,
        line9BalanceToFinish: 320000,
        periodTo: '2026-07-31',
        certifiedDate: '2026-08-01',
      },
      retainagePercent: 10,
    }],
  });
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'No subcontractor is held at a higher retainage than the owner holds');
  assert.strictEqual(f.status, FAIL);
  assert.ok(f.detail.includes('Sub One, Inc.'));
});

console.log('\nDates and numbering:');

check('a certification signed before the period it covers is caught', () => {
  const packet = goodPacket();
  packet.certificate.certifiedDate = '2026-07-25';     // period runs to 7/31
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'No application is certified before the period it covers');
  assert.strictEqual(f.status, FAIL);
  assert.ok(/2026-07-25/.test(f.detail));
});

check('a subcontractor certifying early is caught by firm name', () => {
  const packet = goodPacket({
    subApplications: [{
      firmName: 'Early Bird Mechanical',
      certificate: {
        line1OriginalContractSum: 100000,
        line4CompletedAndStoredToDate: 50000,
        periodTo: '2026-07-31',
        certifiedDate: '2026-07-20',
      },
    }],
  });
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'No application is certified before the period it covers');
  assert.strictEqual(f.status, FAIL);
  assert.ok(f.detail.includes('Early Bird Mechanical'));
});

check('dates written differently still compare correctly', () => {
  const packet = goodPacket();
  packet.certificate.periodTo = '7/31/2026';
  packet.certificate.certifiedDate = '8/5/2026';
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'No application is certified before the period it covers'), PASS);
});

console.log('\nNotarization:');

check('a missing notary stamp is reported as an issue', () => {
  const packet = goodPacket();
  packet.notary.notaryStampPresent = false;
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'The contractor\'s certificate is properly notarized');
  assert.strictEqual(f.status, FAIL);
  assert.ok(/stamp/.test(f.detail));
});

check('a notary commission that expired before signing is caught', () => {
  const packet = goodPacket();
  packet.notary.commissionExpiryDate = '2026-06-30';   // signed 2026-08-05
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'The contractor\'s certificate is properly notarized');
  assert.strictEqual(f.status, FAIL);
  assert.ok(/expired/.test(f.detail));
});

console.log('\nSales tax:');

const taxTerms = () => goodTerms({
  taxExemptionClause: {
    present: true,
    section: '3.6.1',
    quote: 'The Owner is exempt from sales tax.',
    burdenOnContractor: true,
  },
});

check('tax on a tax-exempt job is totalled across every invoice, not just the large ones', () => {
  const packet = goodPacket({
    backupInvoices: [
      { vendor: 'Big Lumber Co', invoiceNumber: 'A1', total: 10825, taxAmount: 825 },
      { vendor: 'Site Security Ltd', invoiceNumber: 'S1', total: 268.75, taxAmount: 18.75 },
      { vendor: 'Site Security Ltd', invoiceNumber: 'S2', total: 268.75, taxAmount: 18.75 },
      { vendor: 'Dumpster Co', invoiceNumber: 'D1', total: 541.25, taxAmount: 41.25 },
    ],
  });
  const result = runChecks(packet, taxTerms());
  const f = find(result, 'Sales tax is not billed to a tax-exempt owner');
  assert.strictEqual(f.status, FAIL);
  // The small recurring invoices are exactly the ones a partial review misses.
  assert.strictEqual(result.tax.total, 903.75);
  assert.strictEqual(result.tax.taxed.length, 4);
  assert.ok(/not payable by the owner/.test(f.detail), 'the framing must be direct, not hedged');
});

check('the same vendor billing $0.00 tax elsewhere is cited as proof the exemption works', () => {
  const packet = goodPacket({
    backupInvoices: [
      { vendor: 'Big Lumber Co', invoiceNumber: 'A1', total: 10825, taxAmount: 825 },
      { vendor: 'Big Lumber Co', invoiceNumber: 'A2', total: 4000, taxAmount: 0, exemptionNoted: true },
    ],
  });
  const result = runChecks(packet, taxTerms());
  const f = find(result, 'Sales tax is not billed to a tax-exempt owner');
  assert.ok(/exemption certificate is usable/.test(f.detail),
    'the strongest evidence must be stated when it is present');
});

check('an ambiguous tax clause is hedged rather than asserted', () => {
  const packet = goodPacket({
    backupInvoices: [{ vendor: 'Big Lumber Co', invoiceNumber: 'A1', total: 10825, taxAmount: 825 }],
  });
  const result = runChecks(packet, goodTerms({
    taxExemptionClause: { present: true, section: '3.6.1', burdenOnContractor: false },
  }));
  const f = find(result, 'Sales tax is not billed to a tax-exempt owner');
  assert.strictEqual(f.status, NOTE, 'a clause that does not place the burden is not a hard finding');
  assert.ok(!/not payable by the owner/.test(f.detail));
});

check('no tax clause means tax in the backup is not flagged at all', () => {
  const packet = goodPacket({
    backupInvoices: [{ vendor: 'Big Lumber Co', invoiceNumber: 'A1', total: 10825, taxAmount: 825 }],
  });
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(result.tax.total, 0);
  assert.strictEqual(statusOf(result, 'Sales tax'), PASS);
});

console.log('\nChange orders:');

check('a change order approved this period with no contingency draw is caught', () => {
  const packet = goodPacket({
    subApplications: [{
      firmName: 'Sub One, Inc.',
      certificate: { line1OriginalContractSum: 500000, line4CompletedAndStoredToDate: 200000 },
      newChangeOrdersThisPeriod: 75000,
    }],
  });
  const result = runChecks(packet, goodTerms());
  const f = find(result, 'Change orders approved this period appear in the contingency draw');
  assert.strictEqual(f.status, FAIL);
  assert.ok(/Sub One, Inc./.test(f.detail));
});

check('a change order matched by a contingency draw passes', () => {
  const packet = goodPacket({
    subApplications: [{
      firmName: 'Sub One, Inc.',
      certificate: { line1OriginalContractSum: 500000, line4CompletedAndStoredToDate: 200000 },
      newChangeOrdersThisPeriod: 75000,
    }],
  });
  packet.sovRows[3].thisPeriod = 75000;     // the contingency row
  const result = runChecks(packet, goodTerms());
  assert.strictEqual(statusOf(result, 'Change orders approved this period appear in the contingency draw'), PASS);
});

check('cumulative change orders over a contract cap are caught', () => {
  const result = runChecks(goodPacket(), goodTerms({
    changeOrderCap: { present: true, percent: 2, section: 'Tex. Educ. Code 44.0411' },
  }));
  // 250,000 on 10,000,000 is 2.5%, over a 2% cap of 200,000.
  const f = find(result, 'Cumulative change orders are within the contract limit');
  assert.strictEqual(f.status, FAIL);
  assert.strictEqual(f.amount, 50000);
});

console.log('\nMath-only mode says what it did not check:');

check('with no contract, contract-dependent checks report unchecked rather than vanishing', () => {
  const result = runChecks(goodPacket(), null);
  const retainage = find(result, 'Retainage is held at the contracted rate');
  assert.strictEqual(retainage.status, UNKNOWN);
  // Tax produces no finding at all without a contract — there is nothing to measure against.
  assert.strictEqual(result.tax.total, 0);
});

check('arithmetic still runs in full without a contract', () => {
  const packet = goodPacket();
  packet.certificate.line6TotalEarnedLessRetainage = 3805000;
  const result = runChecks(packet, null);
  assert.strictEqual(statusOf(result, 'Line 6 — Total Earned Less Retainage'), FAIL);
});

console.log('\nSubcontractor reconciliation (the retainage-basis trap):');

// The figures below are the real ones from the Carver High School case in
// evals/gold-standard/cmar-001, where all four subcontractors reconcile exactly. Anything this
// reports as a variance is a false positive, and a reviewer that cries wolf on a clean application
// is worse than no reviewer — the PM stops reading, and the next finding is a real one.

check('a certified (net) figure is not compared against the prime\'s gross column', () => {
  // Sendero: certified 161,705.20 net, prime's schedule shows 170,216.00 gross. The naive
  // comparison invents a variance of 8,510.80 — exactly the 5% retainage.
  const out = reconcileSub({
    firmName: 'Sendero Industries, L.L.C.',
    subAmountCertified: 161705.20,
    sovThisPeriod: 170216,
  }, { retainagePercent: 5 });
  assert.strictEqual(out.ties, true, `expected a match, got variance ${out.variance}`);
  assert.strictEqual(out.variance, 0);
  assert.strictEqual(out.subGrossThisPeriod, 170216);
});

check('a gross figure given directly is compared as-is', () => {
  const out = reconcileSub({
    firmName: 'Sendero Industries, L.L.C.',
    subGrossThisPeriod: 170216,
    subAmountCertified: 161705.20,
    sovThisPeriod: 170216,
  }, { retainagePercent: 5 });
  assert.strictEqual(out.ties, true);
  assert.strictEqual(out.variance, 0);
});

check('one firm spread across four schedule-of-values rows still reconciles', () => {
  // IDR bills 36,735 gross across four rows drawing on three separate allowances, and certifies
  // 34,898.25 net. No single row equals either figure.
  const out = reconcileSub({
    firmName: 'Integrated Demolition and Remediation Inc.',
    subAmountCertified: 34898.25,
    sovThisPeriod: 18046 + 7040 + 6393 + 5256,
  }, { retainagePercent: 5 });
  assert.strictEqual(out.sovThisPeriod, 36735);
  assert.strictEqual(out.ties, true, `expected a match, got variance ${out.variance}`);
});

check('a real variance is still reported once the basis is right', () => {
  const out = reconcileSub({
    firmName: 'Overbilling Inc.',
    subGrossThisPeriod: 180216,          // $10,000 more than the prime carries
    sovThisPeriod: 170216,
  }, { retainagePercent: 5 });
  assert.strictEqual(out.ties, false);
  assert.strictEqual(out.variance, 10000);
});

check('a certified amount that is not gross less retainage is called out', () => {
  const out = reconcileSub({
    firmName: 'Odd Numbers LLC',
    subGrossThisPeriod: 170216,
    subAmountCertified: 150000,          // not 5% off 170,216
    sovThisPeriod: 170216,
  }, { retainagePercent: 5 });
  assert.strictEqual(out.ties, true, 'the gross comparison still ties');
  assert.ok(/worth confirming which figure is right/.test(out.basisNote),
    'the mismatched certified figure must still be surfaced');
});

check('with nothing comparable, it says so rather than guessing', () => {
  const out = reconcileSub({ firmName: 'Mystery Co', sovThisPeriod: 1000 }, {});
  assert.strictEqual(out.ties, null);
  assert.strictEqual(out.basis, 'not-comparable');
});

console.log('\nThe prime certificate from the gold-standard case:');

check('the real Carver High School application raises no arithmetic finding', () => {
  // Every figure read off page 1 of application 07. Its arithmetic is correct, so the expected
  // result is silence. Note Line 5 is 96,363.16 against a computed 96,363.158 — a half-cent that
  // the tolerance has to absorb — and Line 9 is balance to finish PLUS retainage, which is why it
  // is checked as Line 3 less Line 6 and never against the schedule's own balance column.
  const packet = {
    projectName: 'Carver High School Rebuild',
    ownerName: 'Aldine Independent School District',
    contractorName: 'Bartlett Cocke General Contractors, LLC',
    certificate: {
      applicationNumber: '7',
      periodTo: '2026-07-31',
      line1OriginalContractSum: 16408051,
      line2NetChangeByChangeOrders: 0,
      line3ContractSumToDate: 16408051,
      line4CompletedAndStoredToDate: 1927263.16,
      line5aCompletedWork: 96363.16,
      line5bStoredMaterial: 0,
      line5Retainage: 96363.16,
      line6TotalEarnedLessRetainage: 1830900,
      line7LessPreviousCertificates: 1467480,
      line8CurrentPaymentDue: 363420,
      line9BalanceToFinish: 14577151,
    },
    retainagePercent: 5,
    // Only the totals matter for this assertion; the full row set is not transcribed in the
    // fixture, so a single row carrying the totals stands in for the sheet.
    // NOTE THE BASIS. Line 7 (1,467,480) is what was previously CERTIFIED — already net of
    // retainage. The schedule's "previous applications" column is GROSS work completed, which is
    // 1,467,480 / 0.95 = 1,544,715.79. Putting the net figure in the gross column here was the
    // same mistake the reconciliation above exists to prevent, and the check caught it.
    sovRows: [{
      description: 'All work', scheduledValue: 16408051,
      previousApplications: 1544715.79, thisPeriod: 382547.37, storedMaterials: 0,
      completedToDate: 1927263.16, isSubtotal: false,
    }],
    notary: {
      signaturePresent: true, notaryStampPresent: true, notarySignaturePresent: true,
      notarySignedDate: '2026-08-05', commissionExpiryDate: '2028-06-30',
    },
    subApplications: [],
    backupInvoices: [],
  };
  const result = runChecks(packet, { retainagePercent: 5, taxExemptionClause: { present: false } });
  const fails = result.findings.filter(f => f.status === FAIL);
  assert.strictEqual(fails.length, 0,
    `a clean application must raise nothing; got: ${fails.map(f => `${f.title} — ${f.detail}`).join(' | ')}`);
  assert.strictEqual(result.certifiable, true);
});

console.log('\nThe report:');

const reportFor = (packet, terms, judgement = null) => {
  const checks = runChecks(packet, terms);
  return buildReport({
    header: { projectName: packet.projectName, contractorName: packet.contractorName },
    packet, checks, judgement, terms,
  });
};

check('all six headline questions are answered every time', () => {
  // A packet carrying almost nothing: the questions must still all be present, answered
  // "not checked" rather than silently dropped.
  const bare = {
    certificate: { line1OriginalContractSum: 100, line4CompletedAndStoredToDate: 50 },
    sovRows: [{ description: 'Work', scheduledValue: 100, isSubtotal: false }],
  };
  const report = reportFor(bare, null);
  assert.strictEqual(report.headline.length, HEADLINE_QUESTIONS.length);
  assert.strictEqual(report.headline.length, 6);
  for (const q of report.headline) {
    assert.ok(q.detail && q.detail.length > 0, `"${q.question}" has no answer`);
    assert.ok([PASS, FAIL, NOTE, UNKNOWN].includes(q.status));
  }
});

check('a failing check drives its headline question to failing', () => {
  const packet = goodPacket();
  packet.notary.notaryStampPresent = false;
  const report = reportFor(packet, goodTerms());
  const notary = report.headline.find(q => /notarization/i.test(q.question));
  assert.strictEqual(notary.status, FAIL);
});

check('the tax section appears only when tax was actually found', () => {
  assert.strictEqual(reportFor(goodPacket(), goodTerms()).tax, null);
  const withTax = reportFor(goodPacket({
    backupInvoices: [{ vendor: 'V', invoiceNumber: '1', total: 1080, taxAmount: 80 }],
  }), taxTerms());
  assert.ok(withTax.tax);
  assert.strictEqual(withTax.tax.total, 80);
});

check('the markdown carries the numbers and the findings', () => {
  const report = reportFor(goodPacket(), goodTerms());
  const md = report.markdown;
  assert.ok(md.includes('## Summary'));
  assert.ok(md.includes('## The Numbers'));
  assert.ok(md.includes('## Any Issues That Were Found'));
  assert.ok(md.includes('CURRENT PAYMENT DUE'));
  assert.ok(md.includes('$760,000'), 'the payment due figure must appear');
});

check('math-only mode is stated on the report, not left to be inferred', () => {
  const report = reportFor(goodPacket(), null);
  assert.strictEqual(report.summary.mathOnly, true);
  assert.ok(/no contract was provided/i.test(report.markdown));
});

// --- The PDF -----------------------------------------------------------------------------------

(async () => {
  console.log('\nThe PDF renders:');

  await (async () => {
    try {
      const report = reportFor(goodPacket({
        subApplications: [{
          firmName: 'Sub One, Inc.',
          scopeDescription: 'Mechanical',
          certificate: {
            line1OriginalContractSum: 500000, line3ContractSumToDate: 500000,
            line4CompletedAndStoredToDate: 200000, line8CurrentPaymentDue: 80000,
          },
        }],
        backupInvoices: [{ vendor: 'Big Lumber Co', invoiceNumber: 'A1', total: 10825, taxAmount: 825 }],
      }), taxTerms(), {
        summary: 'This application requests $760,000. The arithmetic ties, but $825 of sales tax '
          + 'has been billed to a tax-exempt owner and should be deducted before certifying.',
        subcontractorMatching: [{
          firmName: 'Sub One, Inc.', sovItems: ['Mechanical'], subBilledThisPeriod: 200000,
          sovThisPeriod: 200000, ties: true, explanation: 'Ties exactly.',
        }],
        untraceable: [],
        invoiceConcerns: [{ vendor: 'Big Lumber Co', invoiceNumber: 'A1', amount: 825, concern: 'Tax charged.', confidence: 'likely' }],
        worthNoting: ['The contingency has not been drawn against this period.'],
        actions: [
          { action: 'Deduct $825 of sales tax before certifying.', why: 'Owner is tax-exempt', amount: 825, blocking: true },
          { action: 'Request the July lien waiver from Sub One, Inc.', why: 'Not in the packet', blocking: false },
        ],
      });

      const pdf = await renderCmarReportPdf({ report });
      assert.ok(Buffer.isBuffer(pdf), 'a buffer should come back');
      assert.ok(pdf.length > 3000, `the PDF is suspiciously small (${pdf.length} bytes)`);
      assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
      console.log(`  PASS  a full report renders to a PDF (${(pdf.length / 1024).toFixed(1)} KB)`);
      passed += 1;
    } catch (err) {
      console.log('  FAIL  a full report renders to a PDF');
      console.log(`        ${err.message}`);
      failed += 1;
    }
  })();

  // Prose the model wrote is full of characters the standard PDF fonts cannot encode. One of them
  // used to be enough to fail the whole download.
  await (async () => {
    try {
      const report = reportFor(goodPacket(), goodTerms(), {
        summary: 'The contractor’s application — dated 31 July — bills 36" of clearance '
          + 'at £5,000 and a 2½" gap. Café fit-out ≥ 50% complete.',
        actions: [{ action: 'Confirm the 36" clearance — see § 5.1.7.', blocking: false }],
        subcontractorMatching: [],
        untraceable: [],
        invoiceConcerns: [],
        worthNoting: [],
      });
      const pdf = await renderCmarReportPdf({ report });
      assert.ok(pdf.length > 2000);
      console.log('  PASS  typographic characters in model prose do not break the download');
      passed += 1;
    } catch (err) {
      console.log('  FAIL  typographic characters in model prose do not break the download');
      console.log(`        ${err.message}`);
      failed += 1;
    }
  })();

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
