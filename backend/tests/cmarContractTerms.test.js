const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { contractTermsFor } = require('../lib/cmarContractTerms');

// The contract is read once and kept. What is proven here is the keeping, not the reading: every
// case hands in its own reader and counts how often it was asked, so no API call is made anywhere
// in this file.

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE project_contracts (
    id INTEGER PRIMARY KEY, file_name TEXT, terms TEXT, cmar_terms TEXT, cmar_terms_key TEXT
  )`);
  db.prepare(`INSERT INTO project_contracts (id, file_name, terms) VALUES (1, 'agreement.pdf', '{"other":"reading"}')`).run();
  const row = () => db.prepare(`SELECT * FROM project_contracts WHERE id=1`).get();
  let calls = 0;
  const read = async () => { calls += 1; return { retainagePercent: 5, taxExemptionClause: { present: true } }; };
  return { db, row, read, calls: () => calls };
}

const BYTES = Buffer.from('the agreement');

(async () => {
  await check('the first audit reads the contract and keeps the reading', async () => {
    const f = fixture();
    const terms = await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    assert.strictEqual(terms.retainagePercent, 5);
    assert.strictEqual(f.calls(), 1);
    assert.deepStrictEqual(JSON.parse(f.row().cmar_terms), terms);
  });

  await check('a later audit of the same contract does not read it again', async () => {
    const f = fixture();
    const first = await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    const second = await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    assert.strictEqual(f.calls(), 1);
    assert.deepStrictEqual(second, first);
  });

  await check('a different file under the same row is read afresh', async () => {
    const f = fixture();
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: Buffer.from('an amended agreement'), read: f.read });
    assert.strictEqual(f.calls(), 2);
  });

  await check('a failed reading is not kept, so the next audit tries again', async () => {
    const f = fixture();
    const failing = async () => { throw new Error('the read failed'); };
    await assert.rejects(() => contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: failing }));
    assert.strictEqual(f.row().cmar_terms, null);
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    assert.strictEqual(f.calls(), 1);
  });

  await check('a stored reading that cannot be parsed is read again rather than trusted', async () => {
    const f = fixture();
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    f.db.prepare(`UPDATE project_contracts SET cmar_terms='{not json' WHERE id=1`).run();
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    assert.strictEqual(f.calls(), 2);
  });

  await check("the other modules' reading of the contract is left alone", async () => {
    const f = fixture();
    await contractTermsFor({ db: f.db, contractRow: f.row(), bytes: BYTES, read: f.read });
    assert.strictEqual(f.row().terms, '{"other":"reading"}');
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
