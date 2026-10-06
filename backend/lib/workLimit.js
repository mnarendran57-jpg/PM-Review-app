// How much heavy work may happen at the same time.
//
// WHY A LIMIT AT ALL
//
// Nothing in Coaster bounded this. Every request began its work the moment it arrived, so five
// people uploading drawing sets within a minute of each other meant five documents held in memory
// at once — and the instance has a fixed amount. Past it, Render does not slow the service down or
// fail one request: it kills the process and starts a new one, which ends EVERY request in flight.
// Four people lose work they had waited minutes for because a fifth arrived.
//
// That is the shape of the complaint "it was slow and then it crashed". The slowness and the crash
// are the same event seen from either side of the limit.
//
// WHAT THIS DOES INSTEAD
//
// Work past the limit waits its turn rather than being started anyway. The fifth person's review
// takes longer; nobody's fails. A queue is a far better failure than a restart, because waiting is
// something a person can understand and a lost review is not.
//
// The limit is deliberately generous — the common case is one or two people working at once, and
// this should be invisible until the day it is the only thing keeping the service alive.

const DEFAULT_LIMIT = Number(process.env.AI_CONCURRENCY || 6);

// Long enough that a genuinely slow document is not refused, short enough that a queue cannot grow
// without end behind one stuck task.
const MAX_WAIT_MS = Number(process.env.AI_QUEUE_WAIT_MS || 10 * 60 * 1000);

function createLimiter({ limit = DEFAULT_LIMIT, name = 'work', waitMs = MAX_WAIT_MS } = {}) {
  let active = 0;
  const waiting = [];

  const next = () => {
    if (active >= limit || waiting.length === 0) return;
    const task = waiting.shift();
    if (task.settled) return next();         // gave up waiting; move on to the next
    task.settled = true;
    clearTimeout(task.timer);
    active += 1;
    task.resolve();
  };

  const release = () => {
    active = Math.max(0, active - 1);
    next();
  };

  // Resolves when it is this caller's turn. The returned function MUST be called when the work is
  // finished — run() below does that in a finally, which is why callers should prefer it.
  function acquire() {
    if (active < limit) {
      active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const task = { settled: false };
      task.resolve = () => resolve(release);
      task.timer = setTimeout(() => {
        if (task.settled) return;
        task.settled = true;
        const err = new Error(
          'Coaster is working through several documents at the moment and could not get to this '
          + 'one. Nothing was saved or charged — try again shortly.',
        );
        err.queueTimeout = true;
        reject(err);
      }, waitMs);
      task.timer.unref?.();
      waiting.push(task);
      if (waiting.length === 1 || waiting.length % 5 === 0) {
        console.log(`[${name}] ${active} running, ${waiting.length} waiting`);
      }
    });
  }

  async function run(fn) {
    const done = await acquire();
    try {
      return await fn();
    } finally {
      done();
    }
  }

  const stats = () => ({ active, waiting: waiting.length, limit });

  return { run, acquire, stats };
}

// The one limiter the AI calls share. A single pool rather than one per module, because the memory
// and the money are shared too — ten modules each politely allowing three at a time is thirty.
const aiLimiter = createLimiter({ name: 'ai' });

module.exports = { createLimiter, aiLimiter, DEFAULT_LIMIT, MAX_WAIT_MS };
