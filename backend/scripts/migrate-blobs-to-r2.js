// One-time migration: copy every file currently stored as a SQLite blob up to
// Cloudflare R2, record the object key, and blank the blob. Safe to re-run — it only
// touches rows that still have a blob and no key yet.
//
// Usage (from the backend/ directory, with the R2_* env vars set):
//   node scripts/migrate-blobs-to-r2.js
//
// Nothing is deleted from R2 and no keys are cleared, so if it's interrupted you can
// just run it again; already-migrated rows are skipped.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const db = require('../database');
const storage = require('../lib/storage');

// Each blob column, with the key column that will point at its R2 object, the column
// holding the original filename, an optional mime column, and a key prefix.
const TARGETS = [
  { table: 'proposal_intakes', prefix: 'proposal', blob: 'proposal_file', key: 'proposal_file_key', name: 'proposal_file_name' },
  { table: 'proposal_intakes', prefix: 'proposal', blob: 'po_file', key: 'po_file_key', name: 'po_file_name' },
  { table: 'proposal_intakes', prefix: 'proposal', blob: 'merged_pdf', key: 'merged_pdf_key', name: 'merged_file_name' },
  { table: 'pay_app_reviews', prefix: 'pay-app', blob: 'current_file', key: 'current_file_key', name: 'current_file_name' },
  { table: 'project_contracts', prefix: 'contract', blob: 'file_blob', key: 'file_key', name: 'file_name' },
  { table: 'pco_reviews', prefix: 'pco', blob: 'pco_file', key: 'pco_file_key', name: 'pco_file_name' },
  { table: 'pco_reviews', prefix: 'pco', blob: 'reference_file', key: 'reference_file_key', name: 'reference_file_name' },
  { table: 'preconstruction_review_files', prefix: 'precon', blob: 'file_blob', key: 'file_key', name: 'file_name', mime: 'mime_type' },
  { table: 'invoice_review_files', prefix: 'invoice', blob: 'file_blob', key: 'file_key', name: 'file_name', mime: 'mime_type' },
  { table: 'progress_report_files', prefix: 'progress', blob: 'file_blob', key: 'file_key', name: 'file_name', mime: 'mime_type' },
];

async function run() {
  if (!storage.isEnabled()) {
    console.error('R2 is not configured — set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and retry.');
    process.exit(1);
  }

  let moved = 0, bytes = 0;
  for (const t of TARGETS) {
    const cols = [`id`, `${t.blob} AS blob`, `${t.name} AS name`];
    if (t.mime) cols.push(`${t.mime} AS mime`);
    const rows = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${t.table} WHERE ${t.key} IS NULL AND ${t.blob} IS NOT NULL AND length(${t.blob}) > 0`
    ).all();

    if (rows.length) console.log(`${t.table}.${t.blob}: ${rows.length} file(s) to move`);
    for (const row of rows) {
      const buffer = Buffer.from(row.blob);
      const key = await storage.put(t.prefix, buffer, row.mime || 'application/pdf', row.name || '');
      db.prepare(`UPDATE ${t.table} SET ${t.key} = ?, ${t.blob} = ? WHERE id = ?`).run(key, Buffer.alloc(0), row.id);
      moved++; bytes += buffer.length;
      process.stdout.write('.');
    }
    if (rows.length) process.stdout.write('\n');
  }

  console.log(`\nDone. Moved ${moved} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB to R2.`);
  console.log('Tip: run `VACUUM` on the database to reclaim the space the blobs used.');
  process.exit(0);
}

run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
