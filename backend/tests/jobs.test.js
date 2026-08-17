// The job lifecycle, without an API call: start, poll, finish, fail, and the restart case.
const jobs = require('../lib/jobs');
const db = require('../database');

const OWNER = { orgId: 14, userId: 1 };
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };

(async () => {
  console.log('\njobs — work that outlives its request');

  // 1. A slow job returns an id at once and finishes later.
  const started = Date.now();
  const id = jobs.start({ ...OWNER, kind: 'test-slow' }, async () => {
    await wait(1200);
    return { read: 'a very long document', pages: 400 };
  });
  check('start returns immediately', Date.now() - started < 100);
  check('and the job is running', jobs.view(jobs.get(id, OWNER)).status === 'running');
  check('carrying no result yet', jobs.view(jobs.get(id, OWNER)).result === null);

  await wait(1600);
  const done = jobs.view(jobs.get(id, OWNER));
  check('finishes on its own', done.status === 'done');
  check('and hands back the result', done.result?.pages === 400);

  // 2. A failing job records the friendly message, not the stack.
  const bad = jobs.start({ ...OWNER, kind: 'test-fail' }, async () => {
    const err = new Error('raw internal detail');
    err.friendlyMessage = 'The service is busy. Try again in a minute.';
    throw err;
  });
  await wait(200);
  const failed = jobs.view(jobs.get(bad, OWNER));
  check('a failure is recorded as failed', failed.status === 'failed');
  check('with the readable message', failed.error === 'The service is busy. Try again in a minute.');

  // 3. Another user cannot read someone else's job — it holds a whole pay application.
  check('not visible to another user', jobs.get(id, { orgId: 14, userId: 999 }) === null);
  check('not visible to another org', jobs.get(id, { orgId: 1, userId: 1 }) === null);
  check('an unknown id is not found', jobs.get('made-up-id', OWNER) === null);

  // 4. A job whose process died is reported, not polled for ever.
  const stuck = jobs.start({ ...OWNER, kind: 'test-stuck' }, () => new Promise(() => {}));
  db.prepare(`UPDATE ai_jobs SET updated_at = datetime('now', '-90 minutes') WHERE id=?`).run(stuck);
  const swept = jobs.view(jobs.get(stuck, OWNER));
  check('a stale job is reported as failed', swept.status === 'failed');
  check('and says the work was lost', /restarted/.test(swept.error || ''));

  // 5. Finished jobs are cleared; a running one is never swept away.
  db.prepare(`UPDATE ai_jobs SET updated_at = datetime('now', '-12 hours') WHERE id IN (?, ?)`).run(id, bad);
  const live = jobs.start({ ...OWNER, kind: 'test-live' }, () => new Promise(() => {}));
  jobs.sweep();
  check('old finished jobs are swept', jobs.get(id, OWNER) === null && jobs.get(bad, OWNER) === null);
  check('a running job survives the sweep', jobs.get(live, OWNER)?.status === 'running');

  db.prepare(`DELETE FROM ai_jobs WHERE kind LIKE 'test-%'`).run();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
