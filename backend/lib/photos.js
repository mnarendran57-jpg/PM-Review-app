const path = require('path');
const { Worker } = require('worker_threads');
const { readJpeg, DEFAULT_MAX_EDGE } = require('./imageOrientation');

// Turning a photo upright and fitting it to the page, without stopping the server to do it.
//
// WHY THIS EXISTS
//
// Decoding a JPEG is pure arithmetic and cannot be interrupted. A twelve-megapixel phone photo
// took about half a second on a developer laptop and about 230 MB while it was open, and a site
// visit is twenty or thirty of them. Done on the thread that answers requests, that is the whole
// service standing still for as long as the photos take: nobody else's page loads, and the host's
// health check goes unanswered. A host that gets no answer for long enough assumes the process is
// dead and replaces it — which ends every review in flight. From the outside that is a crash, and
// a larger instance does nothing for it, because the problem is not how much memory there is.
//
// So the decoding happens on a thread of its own. The request thread hands a photo over and goes
// back to answering; the result comes back when it is ready.
//
// ONE AT A TIME, ON PURPOSE
//
// A single worker, taking photos in turn. Several at once would be faster on a machine with cores
// to spare, but the instance has one, and each open photo is a couple of hundred megabytes. In turn,
// the most that is ever open is one photo, however many were uploaded and by however many people.
//
// A PHOTO THAT CANNOT BE PROCESSED COMES BACK AS IT ARRIVED
//
// The same promise lib/imageOrientation.js makes, kept here for the failures that are new: a worker
// that dies or takes far too long. A report with one photo sideways, or larger than it needed to
// be, is a far better outcome than a report that could not be produced.

const WORKER_FILE = path.join(__dirname, 'photoWorker.js');

// Far longer than any real photo takes, so it only ever ends a worker that is genuinely stuck.
const TASK_TIMEOUT_MS = Number(process.env.PHOTO_TASK_TIMEOUT_MS || 60 * 1000);

let worker = null;
let current = null;          // the task the worker is on
const queue = [];
let nextId = 1;

function startWorker() {
  const w = new Worker(WORKER_FILE);
  // Never the reason the process stays alive: a test, or a shutdown, should not wait on it.
  w.unref();
  w.on('message', (message) => {
    if (!current || message.id !== current.id) return;
    settle(message.ok ? { message } : { error: new Error(message.error) });
  });
  // Either of these means the worker is gone. It is replaced by the next task that needs one.
  w.on('error', (err) => { if (worker === w) { worker = null; settle({ error: err }); } });
  w.on('exit', () => {
    if (worker === w) { worker = null; settle({ error: new Error('the photo worker stopped') }); }
  });
  return w;
}

function settle({ message, error }) {
  const task = current;
  if (!task) return;
  current = null;
  clearTimeout(task.timer);
  if (error) task.reject(error); else task.resolve(message);
  pump();
}

function pump() {
  if (current || queue.length === 0) return;
  current = queue.shift();
  if (!worker) worker = startWorker();
  current.timer = setTimeout(() => {
    // The only way to stop arithmetic that will not stop is to end the thread it is running on.
    const stuck = worker;
    worker = null;
    stuck?.terminate();
    settle({ error: new Error('the photo took too long to process') });
  }, TASK_TIMEOUT_MS);
  current.timer.unref?.();
  // Copied across rather than given away: the caller keeps its photo, which it needs whenever the
  // answer is "unchanged".
  worker.postMessage({ id: current.id, op: current.op, bytes: current.bytes, options: current.options });
}

function send(op, buffer, options) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, op, bytes: buffer, options, resolve, reject });
    pump();
  });
}

const asBuffer = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// The photo, upright. Same answer as imageOrientation.uprightJpeg, including handing back the very
// buffer it was given when nothing needed turning.
async function upright(buffer) {
  const { orientation, width, height } = readJpeg(buffer);
  // Already upright, which is the common case, and known from the header alone — no reason to
  // wake the worker for it.
  if (orientation === 1) return { buffer, width, height, rotated: false };
  try {
    const reply = await send('upright', buffer);
    if (!reply.changed) return { buffer, width: reply.width, height: reply.height, rotated: false };
    return { buffer: asBuffer(reply.bytes), width: reply.width, height: reply.height, rotated: true };
  } catch (err) {
    console.warn('[photo] could not be turned upright, using it as it arrived:', err.message);
    return { buffer, width, height, rotated: false };
  }
}

// A copy no larger than the size it is printed at. Same answer as imageOrientation.fitJpeg,
// including handing back the very buffer it was given when there was nothing to gain — callers
// compare against it to decide whether a second copy is worth storing.
async function fit(buffer, options) {
  // Already small enough, known from the header alone.
  const { width, height } = readJpeg(buffer);
  if (!width || !height) return buffer;
  if (Math.max(width, height) <= (options?.maxEdge ?? DEFAULT_MAX_EDGE)) return buffer;
  try {
    const reply = await send('fit', buffer, options);
    return reply.changed ? asBuffer(reply.bytes) : buffer;
  } catch (err) {
    console.warn('[photo] could not be resized, using it at full size:', err.message);
    return buffer;
  }
}

const stats = () => ({ waiting: queue.length, busy: !!current });

module.exports = { upright, fit, stats };
