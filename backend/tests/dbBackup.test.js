const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  writeSnapshot, verifySnapshot, expired, keyFor, dayFromKey, KEEP_DAYS,
} = require('../lib/dbBackup');

// The daily copy of the database that goes to object storage.
//
// A backup is never read until the day it is needed, which makes it the easiest thing in an
// application to get wrong without anybody noticing: a corrupt copy and a good one look identical
// from the outside, and the difference only surfaces at the worst possible moment. So the checks
// below are mostly about the snapshot being a REAL, OPENABLE database — not about it existing.
//
// Nothing here touches the network or the live database.

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coaster-backup-test-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ } };

// A stand-in for the real database, with enough tables to pass the sanity check.
function makeDatabase(file, { tables = 12, users = 3 } = {}) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  for (let i = 0; i < tables - 1; i++) db.exec(`CREATE TABLE filler_${i} (id INTEGER PRIMARY KEY)`);
  const insert = db.prepare('INSERT INTO users (email) VALUES (?)');
  for (let i = 0; i < users; i++) insert.run(`person${i}@example.com`);
  db.close();
  return file;
}

console.log('\nThe snapshot is a real database:');

check('a snapshot can be taken and opened', () => {
  const live = makeDatabase(path.join(tmp, 'live.db'));
  const snap = path.join(tmp, 'snap.db');

  const original = process.env.DB_PATH;
  process.env.DB_PATH = live;
  try {
    writeSnapshot(snap);
  } finally {
    if (original === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = original;
  }

  assert.ok(fs.existsSync(snap), 'a snapshot file should exist');
  const { tables, users } = verifySnapshot(snap);
  assert.ok(tables >= 12, `expected the tables to come across, got ${tables}`);
  assert.strictEqual(users, 3, 'and the rows in them');
});

check('the snapshot is taken while the database is open, not after closing it', () => {
  // The live application never stops to be backed up. A copy taken from a database that is being
  // written to is the whole reason this uses VACUUM INTO instead of copying the file.
  const live = makeDatabase(path.join(tmp, 'busy.db'));
  const open = new DatabaseSync(live);
  open.exec('INSERT INTO users (email) VALUES (\'mid-write@example.com\')');

  const snap = path.join(tmp, 'busy-snap.db');
  const original = process.env.DB_PATH;
  process.env.DB_PATH = live;
  try {
    writeSnapshot(snap);
  } finally {
    if (original === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = original;
    open.close();
  }
  const { users } = verifySnapshot(snap);
  assert.strictEqual(users, 4, 'the committed write should be in the snapshot');
});

console.log('\nA snapshot that is not a database is refused:');

check('a corrupt file is rejected, not uploaded', () => {
  // This is the check the whole module exists for. Without it, the thing uploaded every night for
  // a year could be rubbish and nobody would find out until a restore.
  const bad = path.join(tmp, 'corrupt.db');
  fs.writeFileSync(bad, Buffer.from('this is definitely not a sqlite database'));
  assert.throws(() => verifySnapshot(bad), /.*/, 'garbage must not pass verification');
});

check('a truncated database is rejected', () => {
  const live = makeDatabase(path.join(tmp, 'trunc-src.db'));
  const bad = path.join(tmp, 'trunc.db');
  const bytes = fs.readFileSync(live);
  fs.writeFileSync(bad, bytes.subarray(0, Math.floor(bytes.length / 3)));
  assert.throws(() => verifySnapshot(bad), /.*/, 'half a database must not pass');
});

check('a database that opens but is damaged inside is rejected', () => {
  // The case ONLY the integrity check catches, and the one that matters most. The header is
  // intact so the file opens, the schema is intact so every table is listed, the early pages are
  // intact so the row counts answer — and the pages holding the bulk of the data are rubbish.
  // Nothing short of asking SQLite to check itself notices.
  //
  // The damage is confined to the last quarter of the file, which is where the table written last
  // lives, so it cannot accidentally hit the schema or the users table and be caught by something
  // weaker than the check being tested.
  const live = path.join(tmp, 'rot-src.db');
  const src = new DatabaseSync(live);
  src.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  const addUser = src.prepare('INSERT INTO users (email) VALUES (?)');
  for (let i = 0; i < 5; i++) addUser.run(`person${i}@example.com`);
  for (let i = 0; i < 13; i++) src.exec(`CREATE TABLE filler_${i} (id INTEGER PRIMARY KEY)`);
  src.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, payload TEXT)');
  const addBulk = src.prepare('INSERT INTO bulk (payload) VALUES (?)');
  for (let i = 0; i < 3000; i++) addBulk.run('x'.repeat(200));
  src.close();

  const bytes = fs.readFileSync(live);
  for (let i = Math.floor(bytes.length * 0.75); i < bytes.length; i += 11) bytes[i] = 0xff;
  const rotten = path.join(tmp, 'rotten.db');
  fs.writeFileSync(rotten, bytes);

  // Everything weaker than the integrity check is satisfied by this file.
  const open = new DatabaseSync(rotten, { readOnly: true });
  assert.ok(open.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n >= 10,
    'the table count must NOT be what catches this');
  assert.strictEqual(open.prepare('SELECT COUNT(*) n FROM users').get().n, 5,
    'the row counts must NOT be what catches this either');
  open.close();

  assert.throws(() => verifySnapshot(rotten), /integrity check said/,
    'a file that opens but fails its integrity check must never be uploaded as a backup');
});

check('an empty but valid database is rejected', () => {
  // Structurally fine, integrity-check clean, and completely useless. The table count is what
  // catches it.
  const empty = path.join(tmp, 'empty.db');
  new DatabaseSync(empty).close();
  assert.throws(() => verifySnapshot(empty), /not the Coaster database/,
    'a database with no tables must not pass as a backup');
});

console.log('\nBackups are named by the day, so they can be found without an index:');

check('a key round-trips to its date', () => {
  assert.strictEqual(keyFor('2026-10-06'), 'backups/pm_review-2026-10-06.db');
  assert.strictEqual(dayFromKey('backups/pm_review-2026-10-06.db'), '2026-10-06');
});

check('something that is not a backup is not mistaken for one', () => {
  assert.strictEqual(dayFromKey('ve/some-uploaded-estimate.pdf'), null);
  assert.strictEqual(dayFromKey('backups/notes.txt'), null);
});

console.log('\nOld copies are aged out, recent ones are kept:');

const dayAgo = n => {
  const d = new Date('2026-10-06T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const obj = day => ({ key: keyFor(day), size: 1, modified: new Date() });
const TODAY = new Date('2026-10-06T12:00:00Z');

check('a backup past the retention window expires', () => {
  const old = obj(dayAgo(KEEP_DAYS + 5));
  assert.deepStrictEqual(expired([old], TODAY).map(o => o.key), [old.key]);
});

check('a backup inside the window is kept', () => {
  assert.strictEqual(expired([obj(dayAgo(1)), obj(dayAgo(KEEP_DAYS - 1))], TODAY).length, 0);
});

check('today is never expired', () => {
  assert.strictEqual(expired([obj(dayAgo(0))], TODAY).length, 0,
    'deleting the backup just taken would be the worst possible bug here');
});

check('a file that is not a backup is never deleted', () => {
  // list() is given a prefix, but a stray object under it must not be swept up — these keys are
  // handed to a delete call.
  const stray = { key: 'backups/README.txt', size: 1, modified: new Date() };
  assert.strictEqual(expired([stray], TODAY).length, 0,
    'anything whose name is not a dated backup must be left alone');
});

cleanup();

console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
  + `${failed ? `, ${failed} FAILED` : '.'}`);
process.exit(failed === 0 ? 0 : 1);
