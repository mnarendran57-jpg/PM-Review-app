const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

// Cloudflare R2 is S3-compatible, so this is the AWS S3 client pointed at the R2 endpoint.
// Storage is OPTIONAL: if the four R2_* env vars aren't set, isEnabled() is false and the
// callers fall back to storing/serving files from the SQLite blob columns exactly as before.
// That keeps local dev (and any deploy without R2 configured) working with no changes.
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

const enabled = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

let client = null;
if (enabled) {
  client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  console.log(`[storage] Cloudflare R2 enabled (bucket: ${R2_BUCKET})`);
} else {
  console.log('[storage] R2 not configured — files are stored in the database (set R2_* env vars to use object storage)');
}

function isEnabled() {
  return enabled;
}

// Stores a buffer in R2 under a unique key beneath the given prefix, and returns the key.
// The original filename is kept as the tail of the key only for human-readability.
async function put(prefix, buffer, contentType, originalName = '') {
  const safeName = String(originalName).replace(/[^a-z0-9.\-_]+/gi, '_').slice(-60);
  const key = `${prefix}/${crypto.randomUUID()}${safeName ? `-${safeName}` : ''}`;
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

// Stores a buffer at an EXACT key, rather than generating one.
//
// put() above adds a UUID so two uploads of the same filename cannot collide. A backup wants the
// opposite: one object per day at a predictable key, so that yesterday's can be found by name
// without consulting an index — and the index for a database backup must not live inside the
// database being backed up.
async function putAt(key, buffer, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

// What is stored under a prefix, newest first. Used to age backups out and to show what exists.
async function list(prefix) {
  if (!enabled) return [];
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents || []) {
      out.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => (b.key > a.key ? 1 : -1));
}

// Reads an object from R2 back into a Buffer.
async function getBuffer(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Deletes objects by key. Missing keys are ignored. No-op when R2 isn't enabled.
async function remove(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!enabled || list.length === 0) return;
  await client.send(new DeleteObjectsCommand({
    Bucket: R2_BUCKET, Delete: { Objects: list.map(Key => ({ Key })), Quiet: true },
  }));
}

// High-level write used by routes: when R2 is on, upload and return { key }; otherwise
// signal the caller to keep the buffer as a DB blob by returning { key: null }.
async function storeFile(prefix, buffer, contentType, originalName) {
  if (!enabled) return { key: null };
  const key = await put(prefix, buffer, contentType, originalName);
  return { key };
}

// High-level read used by routes: prefer the R2 object when a key exists, else the DB blob.
async function readFile({ key, blob }) {
  if (key && enabled) return getBuffer(key);
  if (blob) return Buffer.from(blob);
  return null;
}

module.exports = { isEnabled, put, putAt, list, getBuffer, remove, storeFile, readFile };
