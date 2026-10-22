const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { diskUpload, spill, fromUpload, sweep, DIR } = require('../lib/uploads');
const jobs = require('../lib/jobs');

// Uploads wait on disk rather than in memory, are read when something reads them, and are gone once
// nothing needs them — at the end of the request, or of the job that outlives it.
//
//   DB_PATH=<scratch>/t.db node tests/uploads.test.js

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failed += 1; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.existsSync(p);

(async () => {
  const app = express();
  const upload = diskUpload({ limits: { fileSize: 10 * 1024 * 1024, files: 4 } });
  const seen = {};

  // A request that reads its files and answers.
  app.post('/now', upload.fields([{ name: 'a' }, { name: 'b' }]), (req, res) => {
    seen.now = req.files.a.map(f => ({ path: f.path, text: f.buffer.toString(), onDisk: exists(f.path) }));
    // Assigning replaces the file's bytes, as it did when uploads were kept in memory.
    req.files.a[0].buffer = Buffer.from('replaced');
    seen.replaced = req.files.a[0].buffer.toString();
    res.json({ ok: true });
  });

  // A request that hands its file to a job, which reads it after the response has gone.
  app.post('/later', upload.single('file'), (req, res) => {
    req.orgId = 1; req.user = { id: 1 };
    const item = fromUpload(req.file, { label: 'x' });
    const stored = spill(req, { label: 'from storage', buffer: Buffer.from('stored document') });
    seen.laterPath = req.file.path;
    seen.spilledInMemory = Object.getOwnPropertyDescriptor(stored, 'buffer').get !== undefined;
    const jobId = jobs.startFrom(req, 'upload-test', async () => {
      await wait(150);
      seen.inJob = { text: item.buffer.toString(), stored: stored.buffer.toString(), onDisk: exists(seen.laterPath) };
      return null;
    });
    res.status(202).json({ jobId });
  });

  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, files) => {
    const fd = new FormData();
    for (const [field, name, text] of files) fd.append(field, new Blob([text]), name);
    return fetch(url + route, { method: 'POST', body: fd });
  };

  await check('an upload is on disk, not in memory, and reads back whole', async () => {
    await post('/now', [['a', 'one.pdf', 'first file'], ['a', 'two.pdf', 'second file'], ['b', 'three.pdf', 'third']]);
    assert.deepStrictEqual(seen.now.map(f => f.text), ['first file', 'second file']);
    assert.ok(seen.now.every(f => f.onDisk && f.path.startsWith(DIR)));
    assert.strictEqual(seen.replaced, 'replaced');
  });

  await check('the files are deleted once the response is over', async () => {
    await wait(100);
    assert.ok(seen.now.every(f => !exists(f.path)), 'left on disk');
  });

  await check('a job keeps its files until it is done, then they go', async () => {
    const res = await post('/later', [['file', 'package.pdf', 'the package']]);
    assert.strictEqual(res.status, 202);
    await wait(50);
    assert.ok(exists(seen.laterPath), 'deleted while the job still needed it');
    await wait(400);
    assert.deepStrictEqual(seen.inJob, { text: 'the package', stored: 'stored document', onDisk: true });
    assert.ok(!exists(seen.laterPath), 'left on disk after the job');
    assert.ok(seen.spilledInMemory, 'a document from storage waits on disk too');
  });

  await check('a document from storage is left in memory when there is no request to clean up after', () => {
    const item = spill(null, { buffer: Buffer.from('x') });
    assert.ok(Buffer.isBuffer(Object.getOwnPropertyDescriptor(item, 'buffer').value));
  });

  await check('files left by a stopped process are swept', () => {
    const orphan = path.join(DIR, 'left-behind');
    fs.writeFileSync(orphan, 'x');
    const old = (Date.now() - 4 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(orphan, old, old);
    const fresh = path.join(DIR, 'still-wanted');
    fs.writeFileSync(fresh, 'y');
    sweep();
    assert.ok(!exists(orphan) && exists(fresh));
    sweep({ all: true });
    assert.ok(!exists(fresh));
  });

  server.close();
  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
