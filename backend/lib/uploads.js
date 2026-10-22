const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Uploaded files kept on disk, not in memory, and read only when something reads them.
//
// WHY
//
// The service has a fixed amount of memory, and a document review used to hold every file it was
// given in it from the moment the upload arrived until the review was finished — including the whole
// time the review waited its turn in the job queue (lib/jobs.js). A submittal review accepts up to
// sixteen files of up to 100 MB; a few of those arriving together, each with a specification read
// from storage beside it, filled the instance, and the host replaced the process — losing every
// review in flight, not just the large one. Measured on an 84 MB, 800-page document: one review
// peaks near 470 MB, so it is never one file that does it. It is files that are merely waiting.
//
// A file on disk costs no memory while it waits. It is read when the review reaches the step that
// needs it, and dropped when that step is done. So how many files are uploaded, and how large they
// are, no longer decides whether the service stays up — which is the rule this application keeps:
// the size of a document must never decide whether a feature works. Nothing here limits a size.
//
// HOW
//
// Each file multer hands a route still has `buffer`, as it did when uploads were kept in memory, so
// no route had to change how it reads one. `buffer` is now a getter that reads the file from disk
// each time it is asked — a step that reads a document gets it, and once the step lets go of it the
// memory is free again. Anything assigned to `buffer` replaces it, as before.
//
// The files are deleted when the request is over, or — for a review that runs as a background job —
// when the job is done (see jobs.startFrom). A sweep clears anything a crash left behind.

const DIR = path.join(os.tmpdir(), 'coaster-uploads');
fs.mkdirSync(DIR, { recursive: true });

// A file older than this is left from a process that died before it could clean up. Longer than any
// job may run (jobs.STALE_AFTER_MINUTES is 45) with room to spare.
const ORPHAN_AFTER_MS = 3 * 60 * 60 * 1000;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}`),
});

// `buffer` on `target`, read from `filePath` whenever it is asked for.
function lazyBuffer(target, filePath) {
  Object.defineProperty(target, 'buffer', {
    configurable: true,
    enumerable: true,
    get() { return fs.readFileSync(filePath); },
    set(value) {
      Object.defineProperty(target, 'buffer', { value, writable: true, configurable: true, enumerable: true });
    },
  });
  return target;
}

const remove = paths => {
  for (const p of paths || []) fs.rm(p, { force: true }, () => {});
};

// The files a request has on disk, deleted when the response is over — unless a job has taken
// them, in which case the job deletes them when it is done.
function track(req, res, filePath) {
  if (!req._diskFiles) {
    req._diskFiles = [];
    res?.once('close', () => { if (!req._diskFilesHeld) remove(req._diskFiles); });
  }
  req._diskFiles.push(filePath);
}

// Keeps a request's files for the life of a job that outlives the request. Returns the function
// that lets them go. Files added to the request after this — a document a job puts on disk while
// it runs — are let go with the rest.
function holdFiles(req) {
  if (!req) return () => {};
  req._diskFilesHeld = true;
  return () => remove(req._diskFiles);
}

// Puts an item's `buffer` on disk, for a document loaded from storage that would otherwise sit in
// memory while its review waits its turn. Returns the same item, now reading `buffer` from disk.
// Without a request to clean up after, it is left in memory as it was.
function spill(req, item) {
  if (!req || !item || !Buffer.isBuffer(item.buffer)) return item;
  const filePath = path.join(DIR, `${Date.now()}-${crypto.randomUUID()}`);
  fs.writeFileSync(filePath, item.buffer);
  track(req, req.res, filePath);
  return lazyBuffer(item, filePath);
}

// An item naming an uploaded file, whose `buffer` is the file's own — read from disk when asked for,
// not copied into memory now. For a route that hands uploads on as { label, buffer } to work that
// may wait its turn.
function fromUpload(file, extra = {}) {
  return Object.defineProperty({ ...extra }, 'buffer', {
    configurable: true, enumerable: true, get() { return file.buffer; },
  });
}

// What multer gave the request, as one list.
const filesOf = req => [
  ...(req.file ? [req.file] : []),
  ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
];

function afterUpload(req, res, next) {
  for (const file of filesOf(req)) {
    track(req, res, file.path);
    lazyBuffer(file, file.path);
  }
  next();
}

// A drop-in for multer({ storage: multer.memoryStorage(), ...options }). Each method returns the
// upload middleware and the step that gives every file its `buffer`; Express takes the pair as one.
function diskUpload(options = {}) {
  const m = multer({ ...options, storage });
  return {
    single: name => [m.single(name), afterUpload],
    array: (name, maxCount) => [m.array(name, maxCount), afterUpload],
    fields: fields => [m.fields(fields), afterUpload],
    any: () => [m.any(), afterUpload],
    none: () => m.none(),
  };
}

// Clears files left by a process that stopped before it could. Called on start, when nothing can be
// using any of them, and then every hour for anything older than a job could still need.
function sweep({ all = false } = {}) {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  const cutoff = Date.now() - ORPHAN_AFTER_MS;
  for (const name of names) {
    const p = path.join(DIR, name);
    try {
      if (all || fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    } catch { /* already gone */ }
  }
}

module.exports = { diskUpload, holdFiles, spill, fromUpload, sweep, lazyBuffer, DIR };
