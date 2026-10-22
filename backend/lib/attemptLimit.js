// How many times something may be tried in a period, by whom.
//
// Public sign-up puts three doors on the internet that anyone can knock on: sign up, sign in, and
// "send me another link". Each is limited per caller so that one machine cannot fill the database
// with fake accounts, guess a password by trying thousands, or turn Coaster into a way of
// sending email to strangers.
//
// Counted in memory. The service runs as one process, so this sees every request; a restart forgets
// the counts, which costs an attacker a restart they cannot cause. If the service ever runs as
// several processes, this is the piece to move into the database.

function createAttemptLimit({ max, windowMs }) {
  const hits = new Map();   // key -> [timestamps]

  const recent = (key, now) => (hits.get(key) || []).filter(t => now - t < windowMs);

  // Counts an attempt and says whether it is allowed. `retryAfterMs` is how long until the oldest
  // counted attempt falls out of the window, for a message that says when to try again.
  function hit(key, now = Date.now()) {
    const list = recent(key, now);
    if (list.length >= max) {
      hits.set(key, list);
      return { allowed: false, retryAfterMs: windowMs - (now - list[0]) };
    }
    list.push(now);
    hits.set(key, list);
    return { allowed: true, retryAfterMs: 0 };
  }

  // Whether the next attempt would be allowed, without counting one.
  function blocked(key, now = Date.now()) {
    const list = recent(key, now);
    return list.length >= max ? { blocked: true, retryAfterMs: windowMs - (now - list[0]) } : { blocked: false };
  }

  const reset = key => hits.delete(key);

  // Old keys are dropped now and then, so a long-running process does not keep every address that
  // ever knocked.
  setInterval(() => {
    const now = Date.now();
    for (const [key, list] of hits) if (!list.some(t => now - t < windowMs)) hits.delete(key);
  }, Math.max(windowMs, 60000)).unref();

  return { hit, blocked, reset };
}

// "Try again in 12 minutes", rounded up so it is never sooner than true.
const minutesFrom = ms => Math.max(1, Math.ceil(ms / 60000));

module.exports = { createAttemptLimit, minutesFrom };
