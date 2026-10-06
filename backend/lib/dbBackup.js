const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const storage = require('./storage');

// A copy of the database, somewhere Render does not control.
//
// WHY THIS EXISTS
//
// Everything a customer would grieve over is in one SQLite file on one disk: accounts, projects,
// every review ever run and every finding in it. Render snapshots that disk nightly and keeps the
// snapshots about a week, which is real protection and not nothing — but all of it sits with one
// company, a failure in the afternoon loses the day, and a problem noticed three weeks late has no
// good copy left to go back to.
//
// So a second copy goes to Cloudflare R2 every day: a different company, a retention we choose, and
// a file somebody can download and hand to a customer's IT department when they ask. The uploaded
// documents already live there, so this adds a destination that is already paid for and already
// has working credentials.
//
// WHY NOT JUST COPY THE FILE
//
// Because the database is in use. SQLite keeps recent changes in a write-ahead log, and copying the
// main file while a write is in flight produces something that looks like a database and is not
// one. `VACUUM INTO` asks SQLite itself for a consistent snapshot — it waits for a clean read,
// writes a complete copy, and compacts it on the way (measured: a 1.7 MB live file became a 512 KB
// backup in 24 ms). A backup that cannot be opened is worse than no backup, because it is believed.
//
// WHY ONE PER CALENDAR DAY, NAMED BY DATE
//
// The list of backups must not live in the database being backed up — on the day you need it, that
// is the thing you have lost. A predictable key means yesterday's copy can be found by name alone,
// by anyone with the bucket, without Coaster running at all.

const PREFIX = 'backups';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);

// Nightly, in the server's own clock. The exact hour matters far less than that it happens; see
// scheduleBackups for why a missed night catches up rather than being lost.
const HOUR = Number(process.env.BACKUP_HOUR || 3);
const CHECK_EVERY_MS = 60 * 60 * 1000;

const dayOf = date => date.toISOString().slice(0, 10);
const keyFor = day => `${PREFIX}/pm_review-${day}.db`;
const dayFromKey = key => (key.match(/pm_review-(\d{4}-\d{2}-\d{2})\.db$/) || [])[1] || null;

const livePath = () => process.env.DB_PATH || path.join(__dirname, '..', 'pm_review.db');

// A consistent copy of the live database, written beside it.
//
// Written to the same disk on purpose: it is the one with room reserved for the database, and the
// snapshot is smaller than the original. It is removed again whatever happens — see runBackup.
function writeSnapshot(toPath) {
  const db = new DatabaseSync(livePath(), { readOnly: true });
  try {
    // Quoted for SQL, with the separator SQLite expects on every platform.
    const quoted = toPath.replace(/\\/g, '/').replace(/'/g, "''");
    db.exec(`VACUUM INTO '${quoted}'`);
  } finally {
    db.close();
  }
}

// Open the snapshot and ask it something, before it is trusted enough to upload.
//
// This is the whole value of the exercise. A backup is never read until the day it is needed, so a
// silently corrupt one is indistinguishable from a good one until the worst possible moment. Thirty
// milliseconds here is the difference between having a backup and believing you do.
function verifySnapshot(snapPath) {
  const db = new DatabaseSync(snapPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = integrity && Object.values(integrity)[0];
    if (verdict !== 'ok') throw new Error(`integrity check said: ${verdict}`);

    // A structurally valid but empty file would also pass the check above.
    const tables = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'",
    ).get().n;
    if (tables < 10) throw new Error(`only ${tables} tables — this is not the Coaster database`);

    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    return { tables, users };
  } finally {
    db.close();
  }
}

// Backups older than the retention window. Worked out from the name rather than the upload time,
// so a re-uploaded day keeps its own date.
function expired(objects, today = new Date()) {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const oldest = dayOf(cutoff);
  return objects.filter(o => {
    const day = dayFromKey(o.key);
    return day && day < oldest;
  });
}

// Take one, upload it, and age the old ones out.
async function runBackup({ day = dayOf(new Date()) } = {}) {
  if (!storage.isEnabled()) {
    return { skipped: 'Object storage is not configured, so there is nowhere to put a backup.' };
  }

  // Beside the database where there is reserved room, falling back to the system temp directory
  // if that disk will not take it.
  let snapPath = path.join(path.dirname(livePath()), `.backup-${day}.db`);
  try {
    fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  } catch {
    snapPath = path.join(os.tmpdir(), `coaster-backup-${day}.db`);
  }

  try {
    try { fs.unlinkSync(snapPath); } catch { /* nothing to clear */ }

    const started = Date.now();
    writeSnapshot(snapPath);
    const { tables, users } = verifySnapshot(snapPath);
    const bytes = fs.statSync(snapPath).size;

    const key = keyFor(day);
    await storage.putAt(key, fs.readFileSync(snapPath), 'application/x-sqlite3');

    const pruned = expired(await storage.list(PREFIX));
    if (pruned.length) await storage.remove(pruned.map(o => o.key));

    const result = {
      key,
      day,
      bytes,
      tables,
      users,
      prunedCount: pruned.length,
      ms: Date.now() - started,
    };
    console.log(`[backup] ${key} — ${(bytes / 1024).toFixed(0)}KB, ${tables} tables, `
      + `${users} users, ${result.ms}ms`
      + (pruned.length ? `, ${pruned.length} older copies removed` : ''));
    return result;
  } finally {
    // The snapshot never outlives the upload. Leaving it would quietly consume the same small disk
    // the live database depends on.
    try { fs.unlinkSync(snapPath); } catch { /* already gone */ }
  }
}

async function listBackups() {
  if (!storage.isEnabled()) return [];
  return (await storage.list(PREFIX)).map(o => ({ ...o, day: dayFromKey(o.key) }));
}

// Make sure today has a backup, taking one if it does not.
//
// NOT a 24-hour timer. This service restarts often — on every deploy, and whenever it runs out of
// memory — and a timer that long would rarely survive to fire. Asking "has today been done?" every
// hour is indifferent to restarts, and a night the service spent down is caught up on the morning
// it comes back rather than being lost.
async function ensureTodaysBackup({ force = false } = {}) {
  const now = new Date();
  const today = dayOf(now);
  if (!force && now.getHours() < HOUR) return null;

  const existing = await listBackups();
  if (!force && existing.some(o => o.day === today)) return null;

  return runBackup({ day: today });
}

function scheduleBackups() {
  if (!storage.isEnabled()) {
    console.log('[backup] no object storage configured — the database is NOT being backed up');
    return null;
  }
  const tick = () => ensureTodaysBackup().catch(err => {
    // Never throws into the process. A failed backup is serious and must be loud, but it is not a
    // reason to take the application down.
    console.error('[backup] FAILED:', err.message);
  });
  tick();
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();                        // never holds the process open by itself
  console.log(`[backup] on — a daily copy goes to object storage, ${KEEP_DAYS} days kept`);
  return timer;
}

module.exports = {
  runBackup, listBackups, ensureTodaysBackup, scheduleBackups,
  writeSnapshot, verifySnapshot, expired, keyFor, dayFromKey,
  PREFIX, KEEP_DAYS, HOUR,
};
