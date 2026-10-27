const fs = require('fs');
const os = require('os');
const v8 = require('v8');

// Notes in the log about how much memory the service is using, and what it is doing.
//
// The service is restarted by its host when it passes its memory limit, and the host says only
// that — "ran out of memory". Which review was running, and whether memory climbed for an hour or
// jumped in a second, it does not say, and in October 2026 that cost a day of guessing. So:
//
//   at start   one line: the server's memory limit, and the ceiling Node was given for its own
//              heap — with a warning when that ceiling is not comfortably below the limit. That
//              mismatch is exactly what went unnoticed: a 1,500 MB ceiling on a 512 MB server,
//              which tells Node it never needs to tidy up before the host kills it.
//   each minute, while anything is running or memory is past 40% of the limit: memory in use,
//              and every piece of work holding one of the two places (lib/jobs.js) and for how long.
//   past 75%   the same line as a warning, so it stands out in the log just before any restart.
//
// Idle minutes write nothing.

const MB = 1024 * 1024;

// The container's limit, as the kernel enforces it. MEMORY_LIMIT_MB overrides; failing both, the
// machine's own memory, which on a shared host is far larger than this service is allowed.
function memoryLimitBytes() {
  const fromEnv = Number(process.env.MEMORY_LIMIT_MB);
  if (fromEnv > 0) return { bytes: fromEnv * MB, source: 'MEMORY_LIMIT_MB' };
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const n = Number(raw);
      // "max", or the huge number cgroup v1 uses for "no limit", means there is none set here.
      if (Number.isFinite(n) && n > 0 && n < os.totalmem() * 2 && n < 2 ** 50) return { bytes: n, source: file };
    } catch { /* not on this system */ }
  }
  return { bytes: os.totalmem(), source: 'the machine' };
}

const round = n => Math.round(n / MB);

function snapshot() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external + (m.arrayBuffers || 0) };
}

function describe(activity) {
  const busy = activity.running.map(r => `${r.label} ${r.seconds}s`).join(', ') || 'nothing';
  return `running: ${busy}${activity.waiting ? `; ${activity.waiting} waiting` : ''}`;
}

function start({ activity = () => ({ running: [], waiting: 0 }), everyMs = 60 * 1000 } = {}) {
  const limit = memoryLimitBytes();
  const heapCeiling = v8.getHeapStatistics().heap_size_limit;
  console.log(`[memory] server limit ${round(limit.bytes)} MB (from ${limit.source}); `
    + `Node heap ceiling ${round(heapCeiling)} MB`);
  if (limit.source !== 'the machine' && heapCeiling > limit.bytes * 0.8) {
    console.warn(`[memory] WARNING: the Node heap ceiling (${round(heapCeiling)} MB) is not below the `
      + `server's limit (${round(limit.bytes)} MB). Node will not tidy up before the host restarts the `
      + 'service. Lower --max-old-space-size in the start command to about 70% of the limit.');
  }

  const timer = setInterval(() => {
    const now = snapshot();
    const share = now.rss / limit.bytes;
    const act = activity();
    if (!act.running.length && share < 0.4) return;
    const line = `[memory] ${round(now.rss)} MB of ${round(limit.bytes)} MB (${Math.round(share * 100)}%) — `
      + `heap ${round(now.heapUsed)} MB, buffers ${round(now.external)} MB — ${describe(act)}`;
    if (share >= 0.75) console.warn(`${line} — HIGH`);
    else console.log(line);
  }, everyMs);
  timer.unref();
  return { limit, heapCeiling, stop: () => clearInterval(timer) };
}

module.exports = { start, memoryLimitBytes };
