const crypto = require('crypto');
const db = require('../database');

// AI work that outlives the request that asked for it.
//
// Reading a pay application is minutes of work: several passes over the document, a contract read
// on the first review of a project, and a rate limit that forces a wait between calls. All of that
// used to happen inside one HTTP request, which meant the request had to stay open for the whole
// thing — and every wall along that path gets a vote. The browser gives up at its timeout. A proxy
// or load balancer gives up at its own, which no client setting can raise. The user is told the
// server took too long and to split the PDF into smaller parts, which is exactly the answer this
// application is not allowed to give: how big a document is must never decide whether it works.
//
// The worst part was not the error. The server did not stop — it finished the work, several minutes
// and several paid API calls later, and handed the result to a connection nobody was listening on.
// The document was read, correctly, and thrown away.
//
// So the request no longer waits. It starts a job and returns an id; the work carries on; the page
// asks how it is getting on. Nothing in the middle can time it out because nothing in the middle is
// held open.
//
// This is deliberately the simplest thing that removes the wall: jobs run in this process, and the
// row is the only state. That has one real consequence, handled below — a job cannot survive the
// process dying — and one real virtue: no broker, no worker, nothing else to deploy or go wrong.

const RUNNING = 'running';
const DONE = 'done';
const FAILED = 'failed';

// Beyond this a job that still says "running" is not running: the process it belonged to is gone.
// Generous, because the whole point is that legitimate work here takes a long time — this is a
// backstop against a restart, not a timeout in disguise.
const STALE_AFTER_MINUTES = 45;

// How long a finished job's result is kept. Long enough that a reviewer who wandered off mid-read
// still finds it; short enough that extracted pay applications are not accumulating in the database
// for ever.
const KEEP_HOURS = 6;

function create({ orgId, userId, kind }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO ai_jobs (id, org_id, user_id, kind, status) VALUES (?, ?, ?, ?, ?)
  `).run(id, orgId, userId, kind, RUNNING);
  return id;
}

// Starts the work and returns immediately. The promise is deliberately not returned or awaited: the
// caller's request is finishing now, and awaiting it here is the very thing being removed.
function start({ orgId, userId, kind }, work) {
  const id = create({ orgId, userId, kind });

  Promise.resolve()
    .then(work)
    .then((result) => {
      db.prepare(`
        UPDATE ai_jobs SET status=?, result_json=?, updated_at=datetime('now') WHERE id=?
      `).run(DONE, JSON.stringify(result ?? null), id);
    })
    .catch((err) => {
      // The message reaches the user, so it is the friendly one where the caller supplied it.
      console.error(`[job ${kind} ${id}] failed:`, err.stack || err.message);
      db.prepare(`
        UPDATE ai_jobs SET status=?, error=?, updated_at=datetime('now') WHERE id=?
      `).run(FAILED, err.friendlyMessage || err.message || 'The work could not be completed.', id);
    });

  return id;
}

// A job the caller is allowed to see. Scoped by organization AND by the user who started it: a job
// holds a whole extracted pay application, which is not something to hand to anyone who guesses an
// id — and ids are UUIDs precisely so that they cannot be walked.
function get(id, { orgId, userId }) {
  const row = db.prepare(`SELECT * FROM ai_jobs WHERE id=?`).get(id);
  if (!row || row.org_id !== orgId || row.user_id !== userId) return null;

  // A job whose process died would otherwise say "running" for ever, and the page would poll it for
  // ever. Marked failed on the way past rather than by a sweeper, because the only moment anyone
  // cares whether a job is stale is when they ask about it.
  if (row.status === RUNNING) {
    const age = db.prepare(
      `SELECT (julianday('now') - julianday(updated_at)) * 24 * 60 AS minutes FROM ai_jobs WHERE id=?`
    ).get(id)?.minutes;
    if (age != null && age > STALE_AFTER_MINUTES) {
      const error = 'The server restarted while this was being read, so the work was lost. '
        + 'Nothing was saved — run it again.';
      db.prepare(`UPDATE ai_jobs SET status=?, error=?, updated_at=datetime('now') WHERE id=?`)
        .run(FAILED, error, id);
      return { ...row, status: FAILED, error };
    }
  }
  return row;
}

// The shape the page polls. The result travels only once it is finished, so a poll while the work
// runs stays cheap however large the document turns out to be.
function view(row) {
  return {
    id: row.id,
    status: row.status,
    error: row.error || null,
    result: row.status === DONE && row.result_json ? JSON.parse(row.result_json) : null,
  };
}

// Old jobs, cleared opportunistically. A finished job is a copy of an extracted pay application and
// there is no reason to keep it once the review it fed has been saved.
function sweep() {
  db.prepare(`
    DELETE FROM ai_jobs WHERE status IN (?, ?) AND updated_at < datetime('now', ?)
  `).run(DONE, FAILED, `-${KEEP_HOURS} hours`);
}

module.exports = { start, get, view, sweep, RUNNING, DONE, FAILED, STALE_AFTER_MINUTES };
