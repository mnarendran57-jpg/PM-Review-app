// Reading a contract, off the request.
//
// A contract is read once per project and its terms drive every later review. That reading is the
// longest AI job in the product: a long agreement is split into page ranges and each range is a
// separate call, and this account's rate limit (5 requests and 10,000 input tokens a minute) puts
// a wait between them. A 200-page contract is minutes of work.
//
// It used to happen inside the upload request, which meant the browser held a connection open for
// the whole thing and gave up at three minutes. So uploading a big contract failed — and worse, it
// failed in a way that made the SIZE OF THE DOCUMENT decide whether the feature worked at all. A
// user cannot do anything about the length of a contract they have been sent.
//
// So the upload now does the one thing that is genuinely fast — store the file — and hands the
// reading to this queue. Three consequences, all of them the point:
//
//   * No request is held open, so no timeout can kill the work. A contract of any length is read.
//   * Several contracts can be uploaded one after another; they queue rather than collide, which
//     also keeps them from tripping the rate limit against each other.
//   * The reading survives the user navigating away or closing the tab.
//
// One job at a time, deliberately. Running two in parallel would double the token rate against a
// limit that is already the binding constraint, and the second would spend its life being retried.

const db = require('../database');
const storage = require('./storage');
const { extractContractTerms } = require('./contractExtract');

const STATUS = { PENDING: 'pending', READING: 'reading', READY: 'ready', FAILED: 'failed' };

const queue = [];
let running = false;

const setStatus = (id, status, error = null) =>
  db.prepare(`UPDATE project_contracts SET terms_status=?, terms_error=?, updated_at=datetime('now') WHERE id=?`)
    .run(status, error, id);

// The file may live in object storage or in the row itself, depending on how the deployment is
// configured. By the time this runs the request that carried the bytes is long gone, so they are
// fetched back rather than kept in memory — a queue holding several hundred megabytes of PDFs
// would be its own outage.
const bytesFor = row => storage.readFile({ key: row.file_key, blob: row.file_blob });

async function runOne(contractId) {
  const row = db.prepare(`SELECT * FROM project_contracts WHERE id=?`).get(contractId);
  if (!row) return;                                  // deleted while queued — nothing to do
  if (row.doc_type !== 'contract') return;

  setStatus(contractId, STATUS.READING);
  try {
    const buffer = await bytesFor(row);
    if (!buffer || !buffer.length) throw new Error('the stored file could not be read back');

    const terms = await extractContractTerms(buffer);
    const { usage, ...rest } = terms;
    if (usage) {
      console.log(`[contract extract] contract=${contractId} in=${usage.inputTokens} out=${usage.outputTokens} tokens`);
    }

    // A party named by hand at upload outranks anything read off a signature block: a person
    // saying who the contract is with is better evidence than a page that names the owner, the
    // contractor and a surety together.
    const party = row.party || rest.party || null;
    const partyRole = row.party_role || rest.partyRole || null;

    db.prepare(`
      UPDATE project_contracts
      SET terms=?, party=?, party_role=?, terms_status=?, terms_error=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(JSON.stringify(rest), party, partyRole, STATUS.READY, contractId);
  } catch (err) {
    // Failure is recorded, not thrown away. The contract is still on file and still downloadable;
    // what is missing is its terms, and the page says so rather than showing a contract that
    // silently governs nothing.
    console.error(`[contract extract] contract=${contractId} failed:`, err.message);
    setStatus(contractId, STATUS.FAILED, err.message || 'The contract could not be read.');
  }
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await runOne(id);
    }
  } finally {
    running = false;
  }
}

// Hands a stored contract to the queue. Returns immediately; the work happens after the response
// has gone out.
function enqueue(contractId) {
  if (!queue.includes(contractId)) queue.push(contractId);
  setImmediate(drain);
}

// A restart in the middle of a read would otherwise leave a contract stuck saying "reading" for
// ever, with nothing to move it along. Anything unfinished is picked back up on boot, which is
// also what makes a deploy mid-upload harmless.
function resumePending() {
  const stuck = db.prepare(`
    SELECT id FROM project_contracts
    WHERE doc_type='contract' AND terms_status IN (?, ?)
    ORDER BY created_at ASC
  `).all(STATUS.PENDING, STATUS.READING);
  if (!stuck.length) return 0;
  console.log(`[contract extract] resuming ${stuck.length} unfinished contract read(s)`);
  for (const r of stuck) enqueue(r.id);
  return stuck.length;
}

const queueDepth = () => queue.length + (running ? 1 : 0);

module.exports = { enqueue, resumePending, queueDepth, STATUS };
