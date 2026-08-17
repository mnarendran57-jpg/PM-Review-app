const db = require('../database');
const storage = require('./storage');
const { extractContractTerms } = require('./contractExtract');
const { isGoverning } = require('./docTypes');

// Reads a contract's terms the first time a review actually needs them, and never before.
//
// Uploading used to start the read. That put a bill on an action that produces nothing a user
// asked for: a contract added to a project on Monday was read on Monday whether or not anybody
// reviewed anything against it, and a contract uploaded and then replaced was read twice for one
// answer. Uploading is filing. It should cost nothing.
//
// So the read happens on the first pay app, invoice or change order review that measures against
// that contract, and the result is stored. Every review after that reads the stored terms and
// spends nothing — which is the property worth keeping from the old design. What changes is only
// WHEN the one read happens, and whether it happens at all.
//
// STATUS, which the UI reads:
//   pending  stored, not read yet — costs nothing, and stays this way until a review needs it
//   reading  being read right now, inside a review
//   ready    read; terms are on the row
//   failed   read and failed; the file is still on file and downloadable

const setStatus = (id, status, error = null) =>
  db.prepare(`UPDATE project_contracts SET terms_status=?, terms_error=?, updated_at=datetime('now') WHERE id=?`)
    .run(status, error, id);

// row: a project_contracts row (or at least id, doc_type, terms, terms_status, file_key,
// file_blob, party, party_role). Returns the terms object, or null if it could not be read.
async function ensureTermsRead(row) {
  if (!row || !isGoverning(row.doc_type)) return null;
  if (row.terms_status === 'ready') {
    try { return JSON.parse(row.terms || '{}'); } catch { return {}; }
  }
  // A previous attempt failed. Retrying it on every review would spend the same money to reach
  // the same failure, so it stays failed until the document is replaced.
  if (row.terms_status === 'failed') return null;

  setStatus(row.id, 'reading');
  try {
    const buffer = await storage.readFile({ key: row.file_key, blob: row.file_blob });
    if (!buffer || !buffer.length) throw new Error('the stored file could not be read back');

    const terms = await extractContractTerms(buffer);
    const { usage, ...rest } = terms;
    if (usage) {
      console.log(`[contract extract] contract=${row.id} in=${usage.inputTokens} out=${usage.outputTokens} tokens`);
    }

    // A party named by hand outranks anything read off a signature block: a person saying who the
    // contract is with is better evidence than a page naming the owner, the contractor and a
    // surety together.
    const party = row.party || rest.party || null;
    const partyRole = row.party_role || rest.partyRole || null;

    db.prepare(`
      UPDATE project_contracts
      SET terms=?, party=?, party_role=?, terms_status='ready', terms_error=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(JSON.stringify(rest), party, partyRole, row.id);

    return rest;
  } catch (err) {
    // Recorded, not thrown. A contract that cannot be read must not stop the review: the
    // arithmetic, retainage and continuity checks do not need it, and the report says which
    // checks stood down.
    console.error(`[contract extract] contract=${row.id} failed:`, err.message);
    setStatus(row.id, 'failed', err.message || 'The contract could not be read.');
    return null;
  }
}

// Reads every governing document a review is about to measure against, all at once.
//
// These were read one after another because the account's per-minute allowance would have
// rate-limited parallel reads into retries — five requests a minute, when a single contract can be
// several passes on its own. Measured on 2026-08-17 the same account allows five thousand requests
// and five million input tokens a minute, so the reason is gone and the cost of keeping it was the
// worst kind: a CMAR job with a prime contract and four subcontracts read them in series, and the
// PM waited for the sum of five reads to do work that has no order to it. Each contract is
// independent — nothing in one informs another.
//
// ensureTermsRead records its own failures and returns null rather than throwing, so one unreadable
// contract cannot reject the others through Promise.all.
async function ensureAllRead(rows) {
  await Promise.all(rows.map(row => ensureTermsRead(row)));
}

module.exports = { ensureTermsRead, ensureAllRead };
