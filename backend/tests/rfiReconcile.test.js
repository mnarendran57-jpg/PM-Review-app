// The two guards that stop an RFI panel showing a headline its own table contradicts.
//
// Both of them exist because the model occasionally settles the whole question in the summary field
// and then produces rows that say something else — and of the two, the reader believes the summary,
// because it is the line they forward. "The documents already answer this RFI" above a row saying
// the documents are silent would have the PM close an RFI that is actually a change order.
//
// Neither guard asks the model again: the rows are the evidence, so the summary is derived from
// them. That makes both pure functions, and pure functions on the safety path should be tested
// rather than reasoned about.
//
// Run: node tests/rfiReconcile.test.js

const assert = require('assert');
const { reconcileVerdict } = require('../lib/rfiAnalysis');
const { reconcileCoverage } = require('../lib/rfiComparison');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

const rows = (...statuses) => statuses.map((status, i) => ({ point: `p${i}`, status }));

console.log('\nreconcileVerdict — the RFI against the documents');

check('every point answered is "not_needed", whatever the model said', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'justified', points: rows('answered', 'answered') }),
    'not_needed');
});

check('a mistaken premise counts as settled, not as an open question', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'justified', points: rows('mistaken') }),
    'not_needed');
});

check('a silent document makes the RFI justified even if the model said otherwise', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'not_needed', points: rows('missing') }),
    'justified');
});

check('a conflict between documents is justified', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'not_needed', points: rows('conflict') }),
    'justified');
});

check('answered plus missing is partly justified, never one or the other', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'not_needed', points: rows('answered', 'missing') }),
    'partly_justified');
  assert.strictEqual(reconcileVerdict({ verdict: 'justified', points: rows('answered', 'missing') }),
    'partly_justified');
});

check('"cannot tell" survives the rows — it is about the read, not the points', () => {
  // The model saying it could not see the governing sheets must not be overwritten by a verdict
  // derived from rows it drew from the wrong drawings. That would turn "I do not know" into a
  // judgement of the contractor.
  assert.strictEqual(reconcileVerdict({ verdict: 'cannot_tell', points: rows('answered', 'missing') }),
    'cannot_tell');
  assert.strictEqual(reconcileVerdict({ verdict: 'cannot_tell', points: rows('answered') }),
    'cannot_tell');
});

check('no rows at all cannot be judged', () => {
  assert.strictEqual(reconcileVerdict({ verdict: 'not_needed', points: [] }), 'cannot_tell');
});

console.log('\nreconcileCoverage — whether the A/E answered what was asked');

const asked = (...statuses) => statuses.map((status, i) => ({ asked: `q${i}`, status }));

check('one unanswered question means the RFI is not fully answered', () => {
  assert.strictEqual(reconcileCoverage({ coverage: 'all', questions: asked('answered', 'unanswered') }),
    'most');
});

check('a partly answered question is enough to stop "all"', () => {
  assert.strictEqual(reconcileCoverage({ coverage: 'all', questions: asked('answered', 'partly') }),
    'most');
});

check('all answered is "all", even if the model undersold it', () => {
  assert.strictEqual(reconcileCoverage({ coverage: 'most', questions: asked('answered', 'answered') }),
    'all');
});

check('nothing answered at all is "none"', () => {
  assert.strictEqual(reconcileCoverage({ coverage: 'all', questions: asked('unanswered', 'unanswered') }),
    'none');
});

check('an outright refusal recorded against every question stays "none"', () => {
  // The A/E declining the RFI can legitimately be recorded as the answer to each question. The rows
  // then read as answered, but the RFI was not answered, so the model's "none" is left to stand.
  assert.strictEqual(reconcileCoverage({ coverage: 'none', questions: asked('answered', 'answered') }),
    'none');
});

check('no questions leaves the model\'s own reading alone', () => {
  assert.strictEqual(reconcileCoverage({ coverage: 'none', questions: [] }), 'none');
});

console.log(`\n${passed} check(s) passed${process.exitCode ? ' — with failures above' : ''}\n`);
