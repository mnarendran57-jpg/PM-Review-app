const assert = require('assert');
const { createLimiter } = require('../lib/workLimit');

// The things that turn one bad request into everybody's outage.
//
// Three failures have been reported repeatedly from real use: the service restarting, a document
// being rejected for its size, and "it was slow and then it crashed". The third is the other two
// seen from the inside — work piles up, memory runs out, Render kills the process, and every
// request in flight dies with it, including the ones that were nearly finished.
//
// Nothing here can prove the service never falls over. What it can prove is that the specific
// mechanisms meant to stop one request taking the rest down actually work.

let passed = 0;
let failed = 0;

const check = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for async checks');
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
};

const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\nHeavy work queues instead of piling up:');

  await checkAsync('never more than the limit run at once', async () => {
    const lim = createLimiter({ limit: 3, name: 'test' });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => lim.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
    })));
    assert.strictEqual(peak, 3, `twelve tasks, limit of three, peak was ${peak}`);
  });

  await checkAsync('every queued task still runs — nothing is dropped', async () => {
    const lim = createLimiter({ limit: 2, name: 'test' });
    const done = [];
    await Promise.all(Array.from({ length: 10 }, (_, i) => lim.run(async () => {
      await sleep(5);
      done.push(i);
    })));
    assert.strictEqual(done.length, 10, 'waiting must mean later, never never');
  });

  await checkAsync('a task that throws still gives up its slot', async () => {
    // The failure that would be worst here: one error leaks a slot, then another, and the service
    // silently stops doing any work at all while appearing healthy.
    const lim = createLimiter({ limit: 1, name: 'test' });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => lim.run(async () => { throw new Error('boom'); }));
    }
    assert.strictEqual(lim.stats().active, 0, 'the slot must come back after a failure');
    let ran = false;
    await lim.run(async () => { ran = true; });
    assert.ok(ran, 'work must still be possible after repeated failures');
  });

  await checkAsync('work is let through immediately when nothing is queued', async () => {
    const lim = createLimiter({ limit: 4, name: 'test' });
    const started = Date.now();
    await lim.run(async () => {});
    assert.ok(Date.now() - started < 50, 'the common case must not be slowed down by the limiter');
  });

  await checkAsync('a caller that waits too long is told, not left hanging', async () => {
    // Better than queueing for ever behind something stuck: the person is told that nothing was
    // saved or charged and can try again, rather than watching a spinner until they give up.
    const lim = createLimiter({ limit: 1, name: 'test', waitMs: 40 });
    const holding = lim.run(() => sleep(400));
    await assert.rejects(() => lim.run(async () => {}), /could not get to this one/);
    await holding;
  });

  await checkAsync('giving up waiting does not break the queue behind it', async () => {
    const lim = createLimiter({ limit: 1, name: 'test', waitMs: 40 });
    const holding = lim.run(() => sleep(200));
    await assert.rejects(() => lim.run(async () => {}), /could not get to this one/);
    await holding;
    let ran = false;
    await lim.run(async () => { ran = true; });
    assert.ok(ran, 'the limiter must still work after somebody gave up waiting');
    assert.strictEqual(lim.stats().active, 0, 'and no slot is left held');
  });

  console.log('\nThe limiter reports what it is doing:');

  await checkAsync('it can say how busy it is', async () => {
    const lim = createLimiter({ limit: 2, name: 'test' });
    const held = [lim.run(() => sleep(60)), lim.run(() => sleep(60)), lim.run(() => sleep(60))];
    await sleep(10);
    const s = lim.stats();
    assert.strictEqual(s.active, 2, 'two running');
    assert.strictEqual(s.waiting, 1, 'one waiting');
    assert.strictEqual(s.limit, 2);
    await Promise.all(held);
  });

  console.log('\nThe process survives what used to kill it:');

  check('an unhandled promise rejection is handled, not fatal', () => {
    // Node's default is to end the process, which ends every other request in flight. server.js
    // installs a handler; this proves one is installed rather than trusting that it is.
    const path = require('path');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/process\.on\('unhandledRejection'/.test(src),
      'server.js must survive an uncaught promise rejection');
    assert.ok(/process\.on\('uncaughtException'/.test(src),
      'and must at least name an uncaught exception in the log before going down');
  });

  check('a request that throws gets an answer, not a hanging connection', () => {
    const path = require('path');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/app\.use\(\(err, req, res, next\)/.test(src),
      'an Express error handler must be installed');
    assert.ok(/LIMIT_FILE_SIZE|entity\.too\.large/.test(src),
      'an over-sized upload must be explained rather than dropped');
  });

  check('no upload ceiling is larger than the instance can hold', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'routes');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/fileSize:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/g)) {
        if (Number(m[1]) > 100) offenders.push(`${f}: ${m[1]}MB`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      `an upload larger than the box can hold takes every other user down with it: ${offenders.join(', ')}`);
  });

  check('the request body ceiling is survivable too', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const limits = [...src.matchAll(/limit:\s*'(\d+)mb'/g)].map(m => Number(m[1]));
    assert.ok(limits.length >= 2, 'the body limits should be set explicitly');
    assert.ok(limits.every(n => n <= 100), `a body limit of ${Math.max(...limits)}MB is larger than the instance`);
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
