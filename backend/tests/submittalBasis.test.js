const assert = require('assert');
const db = require('../database');
const { noDesignDocumentMessage } = require('../routes/submittals');
const { isDesign, DESIGN_TYPES, labelFor } = require('../lib/docTypes');

// What a submittal is measured against, and what we say when it is missing.
//
// WHY THIS EXISTS
//
// A PM reviewing a controls submittal on an HVAC replacement project got "nothing found in the
// specification" and reasonably read it as a broken feature. The project held an executed A133 and
// nothing else. The contract was the only document there, so it was the only thing the review could
// have been pointed at — and a contract contains no requirements, so the report was accurate and
// worthless.
//
// Two separate faults, both fixed here:
//
//   1. A contract was accepted as something to review a submittal against. It never is. A contract
//      sets price, schedule and procedure; the specification says what a product has to do.
//   2. The refusal said "No specification is on this project yet", which to someone looking at the
//      contract they had just uploaded reads as a lie.
//
// The test asserts on the WORDING, not just the status code, because the wording is the feature.

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

const TAG = 'submittal-basis-test.invalid';
const cleanup = () => {
  const ids = db.prepare('SELECT id FROM projects WHERE project_name = ?').all(TAG).map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM project_contracts WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
};
cleanup();

// A throwaway project holding documents of the given types.
function projectWith(types) {
  const id = db.prepare(
    `INSERT INTO projects (project_name, status) VALUES (?, 'Active')`,
  ).run(TAG).lastInsertRowid;
  // file_blob is NOT NULL; an empty buffer is what a row stored in object storage carries.
  const add = db.prepare(`
    INSERT INTO project_contracts (project_id, file_name, label, doc_type, is_primary, terms,
      file_blob)
    VALUES (?, ?, ?, ?, 0, '{}', ?)
  `);
  for (const t of types) add.run(id, `${t}.pdf`, `A ${t}`, t, Buffer.alloc(0));
  return id;
}

console.log('\nWhat a submittal is measured against:');

check('the specification, the drawings and the design documents all qualify', () => {
  for (const t of ['specifications', 'drawings', 'design']) {
    assert.ok(isDesign(t), `${t} is the engineer's own document and answers the question`);
  }
});

check('a contract does not, and neither does anything else commercial', () => {
  // The whole bug in one assertion. Each of these was previously accepted and read as though it
  // carried requirements.
  for (const t of ['contract', 'purchase-order', 'proposal', 'estimate', 'schedule', 'permit',
    'scope', 'other']) {
    assert.ok(!isDesign(t), `"${labelFor(t)}" cannot tell you whether a product complies`);
  }
});

check('nothing was quietly added to the design set', () => {
  assert.deepStrictEqual(DESIGN_TYPES, ['specifications', 'drawings', 'design'],
    'adding to this list makes that document the basis of a compliance review — a deliberate act');
});

console.log('\nThe refusal names what is actually on the project:');

check('a project holding only a contract is told the contract is not a substitute', () => {
  const id = projectWith(['contract']);
  const msg = noDesignDocumentMessage(id, []);

  // The sentence the PM was missing. Without it they are looking at a contract being told there
  // are no documents.
  assert.match(msg, /Contract on file/i, 'it must name what IS there, or it reads as a lie');
  assert.match(msg, /cannot be reviewed against a contract/i, 'it must say why that is not enough');
  assert.match(msg, /specification/i, 'it must name what is needed');
  assert.match(msg, /Shared Documents/i, 'it must say where to put it');
  assert.match(msg, /"Specifications"/, 'it must name the document type to choose');
  assert.ok(!/^No specification is on this project yet/.test(msg),
    'the old wording described an absence and told the PM nothing they could act on');
});

check('a project holding a purchase order is told the same, in its own words', () => {
  // A job below the client's contract threshold runs on a PO. The PM should not be told to go and
  // find a contract they never had.
  const id = projectWith(['purchase-order']);
  const msg = noDesignDocumentMessage(id, []);
  assert.match(msg, /Purchase Order on file/i, `said instead: ${msg}`);
});

check('a project with several commercial documents names them all', () => {
  const id = projectWith(['contract', 'estimate']);
  const msg = noDesignDocumentMessage(id, []);
  assert.match(msg, /Contract/i);
  assert.match(msg, /Cost Estimate/i, `said instead: ${msg}`);
});

check('an empty project is told so, and not told about a contract it does not have', () => {
  const id = projectWith([]);
  const msg = noDesignDocumentMessage(id, []);
  assert.match(msg, /Nothing is filed on this project yet/i);
  assert.ok(!/contract/i.test(msg), 'there is no contract to mention');
});

check('a project that already holds the spec is never sent down this path', () => {
  // Belt and braces: if a specification IS filed, the callers do not reach this function at all.
  // The message would be wrong if they did, so the condition that guards it is asserted here.
  const id = projectWith(['specifications', 'contract']);
  const filed = db.prepare('SELECT doc_type FROM project_contracts WHERE project_id=?').all(id);
  assert.ok(filed.some(d => isDesign(d.doc_type)), 'the review should run, not refuse');
});

console.log('\nChoosing the wrong document is a different mistake from having none:');

check('ticking the contract is answered by naming the contract, not the project', () => {
  const id = projectWith(['contract', 'specifications']);
  // The spec IS on the project here. The PM just ticked the wrong thing, so telling them to upload
  // a specification would be nonsense — it is already there.
  const msg = noDesignDocumentMessage(id, [{ label: 'CHS_A133 (1)', doc_type: 'contract' }]);
  assert.match(msg, /CHS_A133 \(1\)/, 'it must name the document they actually chose');
  assert.match(msg, /not what a submittal is measured against/i);
  assert.match(msg, /Choose one of those instead/i, 'the fix is to pick again, not to upload');
  assert.ok(!/Upload it under Shared Documents/i.test(msg),
    'the specification is already filed — telling them to upload it is the wrong instruction');
});

check('ticking several wrong documents lists the kinds, not every filename', () => {
  const id = projectWith(['contract']);
  const msg = noDesignDocumentMessage(id, [
    { label: 'a.pdf', doc_type: 'contract' },
    { label: 'b.pdf', doc_type: 'estimate' },
  ]);
  assert.match(msg, /Contract and Cost Estimate/i, `said instead: ${msg}`);
});

check('every message tells the PM what to do next', () => {
  const cases = [
    noDesignDocumentMessage(projectWith(['contract']), []),
    noDesignDocumentMessage(projectWith([]), []),
    noDesignDocumentMessage(projectWith(['contract']), [{ label: 'x', doc_type: 'contract' }]),
  ];
  for (const msg of cases) {
    assert.ok(/choose|upload|attach/i.test(msg), `no instruction in: ${msg}`);
    assert.ok(msg.length < 480, `too long to read in a red box: ${msg.length} chars`);
    // Written for a PM, not for us.
    assert.ok(!/doc_type|design document|null|undefined/i.test(msg), `leaked jargon: ${msg}`);
  }
});

console.log('\nOnly the design documents reach the reviewer:');

// Refusing the wrong document is half the fix. The other half is that a contract ticked ALONGSIDE
// the specification must not be read either — it would be treated as governing text, and it would
// spend pages of a reading budget that only stretches to about eighteen.
//
// Asserted against the source because the filtering happens inside two route handlers, which cannot
// be called without a request. Crude, but it is the mutation that otherwise survives: swapping
// `design` back to `documents` at either call site passes every other check in this file.
// tests/resilience.test.js reads server.js the same way and for the same reason.
check('both review paths hand over the filtered list, not everything chosen', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'submittals.js'), 'utf8');

  const calls = [...src.matchAll(/analyzeSubmittal\(\{([^}]*)\}/g)].map(m => m[1]);
  assert.strictEqual(calls.length, 2,
    `expected the preview and the re-run path; found ${calls.length} call(s) to analyzeSubmittal`);

  for (const args of calls) {
    assert.match(args, /documents:\s*design\b/,
      'this call passes the unfiltered list, so a ticked contract would be read as the '
      + `specification: analyzeSubmittal({${args.trim()}})`);
  }
});

cleanup();
check('the test cleans up after itself', () => {
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM projects WHERE project_name = ?').get(TAG).n, 0,
  );
});

console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
  + `${failed ? `, ${failed} FAILED` : '.'}`);
process.exit(failed === 0 ? 0 : 1);
