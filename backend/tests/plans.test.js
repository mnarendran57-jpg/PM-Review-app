const assert = require('assert');
const db = require('../database');
const { featuresForOrg, orgHasFeature, PLANS, PLAN_KEYS, ALWAYS_INCLUDED } = require('../lib/plans');

// Who can see which tools.
//
// WHY THIS EXISTS
//
// A customer reported that the only pay application reviewer they could see was the old one. The
// cause was here: Pay App Reviewer 3 had been added to the Pro tier and nowhere else, so anybody on
// Lite or Standard opened Coaster and found NO way to review a pay application — the one thing most
// of them came for — while the two older reviewers had already been withdrawn from the interface.
//
// It is the kind of mistake that is invisible from the inside: the person who builds it is always
// an administrator of an organization with no plan set, which gets everything.

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

const TAG = 'plans-test.invalid';
const cleanup = () => db.prepare('DELETE FROM organizations WHERE name = ?').run(TAG);
cleanup();

// A throwaway organization on a given plan.
function orgOn(plan, chosen = null) {
  const id = db.prepare(
    'INSERT INTO organizations (name, plan, plan_features) VALUES (?, ?, ?)',
  ).run(TAG, plan, chosen ? JSON.stringify(chosen) : null).lastInsertRowid;
  return id;
}

console.log('\nEvery paying customer can review a pay application:');

for (const plan of PLAN_KEYS) {
  check(`a customer on "${plan}" can see Pay App Reviewer 3`, () => {
    const id = orgOn(plan, plan === 'custom' ? ['invoice-review'] : null);
    assert.ok(orgHasFeature(id, 'cmar-pay-app-audit'),
      `"${plan}" cannot reach the only pay application reviewer there is`);
  });
}

check('an organization with no plan recorded still gets it', () => {
  // Existing customers from before pricing existed. They keep everything.
  const id = orgOn(null);
  assert.ok(orgHasFeature(id, 'cmar-pay-app-audit'));
});

check('a custom plan with an empty list still gets it', () => {
  // A hand-picked plan agreed before this module existed could not have mentioned it.
  const id = orgOn('custom', []);
  assert.ok(orgHasFeature(id, 'cmar-pay-app-audit'));
});

check('a custom plan with unreadable settings still gets it', () => {
  const id = db.prepare(
    "INSERT INTO organizations (name, plan, plan_features) VALUES (?, 'custom', 'not json')",
  ).run(TAG).lastInsertRowid;
  assert.ok(orgHasFeature(id, 'cmar-pay-app-audit'));
});

console.log('\nThe plans still mean something:');

check('Lite does not quietly become Pro', () => {
  const id = orgOn('lite');
  assert.ok(!orgHasFeature(id, 've-analyzer'), 'Lite must not get the VE Analyzer');
  assert.ok(!orgHasFeature(id, 'precon-review'), 'Lite must not get Pre-Construction Review');
  assert.ok(orgHasFeature(id, 'invoice-review'), 'but it does get what it pays for');
});

check('a custom plan still only gets what was ticked, plus what everyone gets', () => {
  const id = orgOn('custom', ['rfi-log']);
  const features = featuresForOrg(id);
  assert.ok(features.includes('rfi-log'), 'what was agreed');
  assert.ok(features.includes('cmar-pay-app-audit'), 'and what everyone gets');
  assert.ok(!features.includes('progress-report'), 'but nothing else');
});

check('Shared Documents keeps working on every plan', () => {
  // Shared Documents is served from /api/pay-app-review and gated on that key. It is the project's
  // filing cabinet and Pay App Reviewer 3 reads the contract from it, so a plan that lost the key
  // would lose the contract for every tool — not just the withdrawn reviewer it is named after.
  for (const plan of ['lite', 'standard', 'pro']) {
    const id = orgOn(plan);
    assert.ok(orgHasFeature(id, 'pay-app-review'),
      `"${plan}" lost the key that Shared Documents is gated on`);
  }
});

check('the published tiers list it, so the plan descriptions are honest', () => {
  for (const plan of PLANS) {
    if (plan.key === 'custom') continue;
    assert.ok(plan.features.includes('cmar-pay-app-audit'),
      `the "${plan.key}" tier does not list the reviewer its customers will see`);
  }
});

check('nothing else was quietly made free', () => {
  assert.deepStrictEqual(ALWAYS_INCLUDED, ['cmar-pay-app-audit'],
    'adding to this list gives it away to every customer — it should be a deliberate act');
});

cleanup();
check('the test cleans up after itself', () => {
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE name = ?').get(TAG).n, 0,
  );
});

console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
  + `${failed ? `, ${failed} FAILED` : '.'}`);
process.exit(failed === 0 ? 0 : 1);
