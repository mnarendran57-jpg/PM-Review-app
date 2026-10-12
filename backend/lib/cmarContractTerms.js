const crypto = require('crypto');
const { readContractTerms, CONTRACT_TOOL } = require('./cmarRead');

// The contract's terms, read once and kept.
//
// The audit used to read the agreement again on every run. It is the same document every period —
// that is the reason it lives in Shared Documents — and a 170-page contract is the better part of a
// hundred thousand tokens each time, paid monthly for an answer that cannot have changed. It also
// meant two audits of the same project could disagree about what the contract says, which is a
// worse fault than the cost.
//
// Kept in its own columns rather than in `terms`. That column belongs to lib/contractTerms.js and
// holds a different reading in a different shape; this module shares no code with the other pay
// application tools, and borrowing their reading would be sharing it by the back door.
//
// The fingerprint covers the file's bytes and the questions asked of it. A document row is never
// rewritten in place today, so the bytes cannot change under a stored reading — but nothing
// enforces that, and a reading kept past a change to the schema would silently answer the old
// questions. Either one moving makes the stored reading unusable, and the contract is read again.
function fingerprint(bytes) {
  return crypto.createHash('sha256')
    .update(bytes)
    .update(JSON.stringify(CONTRACT_TOOL))
    .digest('hex');
}

function stored(row, key) {
  if (!row?.cmar_terms || row.cmar_terms_key !== key) return null;
  try {
    return JSON.parse(row.cmar_terms);
  } catch {
    return null;
  }
}

// `read` is injectable so the keeping can be proven without an API call.
async function contractTermsFor({ db, contractRow, bytes, read = readContractTerms }) {
  const key = fingerprint(bytes);
  const kept = stored(contractRow, key);
  if (kept) {
    console.log(`[cmar contract] using the stored reading of contract ${contractRow.id}`);
    return kept;
  }

  const terms = await read(bytes, contractRow.file_name);
  // Only a reading that came back is kept. A failure throws past this, so the next audit tries
  // again rather than inheriting it.
  if (terms && typeof terms === 'object') {
    db.prepare(`UPDATE project_contracts SET cmar_terms=?, cmar_terms_key=? WHERE id=?`)
      .run(JSON.stringify(terms), key, contractRow.id);
  }
  return terms;
}

module.exports = { contractTermsFor, fingerprint };
