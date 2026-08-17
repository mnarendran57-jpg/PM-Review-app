const { PDFDocument } = require('pdf-lib');

// The model refuses a PDF outright past a hard page ceiling — 100 pages on the model this
// app uses — and that refusal is what a 100-page pre-construction set ran into. Splitting a
// long document and reading it in passes removes the ceiling from the user's side, so no
// upload is rejected for being long.
//
// Well under the ceiling on purpose: smaller passes also fail smaller — one can be retried
// without redoing the whole document.
//
// Small on purpose, now that passes run at the same time rather than one after another.
//
// Forty pages a pass minimised the NUMBER of requests, which was the scarce thing when the account
// allowed five a minute. It now allows five thousand, and the scarce thing is wall-clock time —
// which is dominated by the model writing its answer at roughly a hundred tokens a second. Smaller
// passes mean more of that writing happens simultaneously, so twelve pages a pass reads a
// sixty-page package in five concurrent passes instead of two long ones.
const MAX_PAGES_PER_PASS = 12;

// The other ceiling, which pages alone do not catch. A request carries the PDF base64-encoded,
// which inflates it by a third, and the API refuses an oversized request outright. A scanned
// pay app of twenty pages can be sixty megabytes while a hundred-page text pay app is two — so
// a splitter that counts only pages sends the first one whole and it is rejected.
//
// Four megabytes of raw PDF is about five and a half encoded, comfortably inside the request
// limit, and it also keeps a single pass inside the account's per-minute token allowance.
const MAX_BYTES_PER_PASS = 4 * 1024 * 1024;

const isPdf = file => file?.mimetype === 'application/pdf';

// pdf-lib throws on an encrypted or malformed file. Returning null lets callers treat it as
// a single pass and surface the model's own error, which reads better than a parser trace.
async function pageCount(buffer) {
  try {
    return (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
  } catch {
    return null;
  }
}

// Builds one page-range document, a valid PDF in its own right.
async function slice(source, startPage, endPage) {
  const part = await PDFDocument.create();
  const pages = await part.copyPages(
    source, Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i));
  pages.forEach(p => part.addPage(p));
  return { buffer: Buffer.from(await part.save()), startPage, endPage };
}

// Splits into documents that fit BOTH ceilings — page count and request size. A file that
// already fits comes back as one part, so callers need only one code path.
//
// Pages first, evenly, then bytes only where they bite. Every pass is an AI call, so the number
// of them is the cost of reading a document and it is worth being exact about.
//
// Halving from the whole document was the obvious way to satisfy both ceilings at once, and it
// overshoots: halves land on powers of two, so a 1,065-page manual came out as 32 parts of 34
// pages where 27 of 40 would do. Five calls of pure waste on one document, and every module that
// reads in passes paid it.
//
// Size still has to be checked AFTER slicing rather than predicted before it, because a PDF's
// weight is not spread evenly across its pages: one scanned photograph in an otherwise text
// document carries most of the file. So the even split comes first, and only a part that is
// still too heavy gets halved — which on a text document never happens at all.
async function splitPdf(buffer, maxPages = MAX_PAGES_PER_PASS, maxBytes = MAX_BYTES_PER_PASS) {
  const total = await pageCount(buffer);
  if (total == null) return [{ buffer, startPage: 1, endPage: total, partCount: 1 }];
  if (total <= maxPages && buffer.length <= maxBytes) {
    return [{ buffer, startPage: 1, endPage: total, partCount: 1 }];
  }

  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const parts = [];

  // Only ever called on a part that is already within the page ceiling and still too heavy.
  const halveOnWeight = async (startPage, endPage) => {
    const part = await slice(source, startPage, endPage);
    // A single page over the ceiling cannot be divided further. It is sent as it is: one page
    // is small enough to be accepted in practice, and refusing it here would be the upload
    // rejected for its size that this splitter exists to prevent.
    if (endPage > startPage && part.buffer.length > maxBytes) {
      const mid = startPage + Math.floor((endPage - startPage) / 2);
      await halveOnWeight(startPage, mid);
      await halveOnWeight(mid + 1, endPage);
      return;
    }
    parts.push(part);
  };

  const add = async (startPage, endPage) => {
    // Even runs of maxPages, the same as before the byte ceiling existed.
    for (let first = startPage; first <= endPage; first += maxPages) {
      await halveOnWeight(first, Math.min(first + maxPages - 1, endPage));
    }
  };

  await add(1, total);
  return parts.map(p => ({ ...p, partCount: parts.length }));
}

// Groups uploaded files into the passes needed to read all of them: everything that fits
// travels together in one pass (so an ordinary upload stays a single call), and each part of
// an oversized PDF gets a pass of its own.
async function planPasses(files, maxPages = MAX_PAGES_PER_PASS) {
  const fitting = [];
  const oversized = [];

  for (const file of files) {
    if (!isPdf(file)) { fitting.push({ file, part: null }); continue; }
    const parts = await splitPdf(file.buffer, maxPages);
    if (parts.length === 1) { fitting.push({ file, part: parts[0] }); continue; }
    for (const part of parts) {
      oversized.push({ file: { ...file, buffer: part.buffer }, part });
    }
  }

  return [...(fitting.length ? [fitting] : []), ...oversized.map(entry => [entry])];
}

// Names the document for the prompt. A part says so explicitly, so the model doesn't report
// the pages it cannot see as missing from the submission.
function passLabel({ file, part }) {
  if (!part || part.partCount === 1) return file.originalname;
  return `${file.originalname} — pages ${part.startPage}-${part.endPage}`;
}

// Combines the extractions from several passes over one document. The rule matches how these
// documents are actually laid out: a header field (vendor, invoice number, contract sum)
// appears once and is null everywhere else, so the first pass that found it wins; itemised
// lists (line items, schedule of values, exclusions) run across pages, so they concatenate in
// page order. Numbers are never summed — a total restated on a continuation page would
// otherwise be double-counted.
function mergeExtracted(results) {
  const present = results.filter(r => r && typeof r === 'object');
  if (present.length <= 1) return present[0] ?? results[0] ?? null;

  const merged = Array.isArray(present[0]) ? [] : {};
  if (Array.isArray(merged)) return present.flat();

  for (const result of present) {
    for (const [key, value] of Object.entries(result)) {
      const existing = merged[key];
      if (Array.isArray(value)) {
        merged[key] = [...(Array.isArray(existing) ? existing : []), ...value];
      } else if (value && typeof value === 'object') {
        merged[key] = mergeExtracted([existing, value].filter(v => v != null));
      } else if (existing == null || existing === '') {
        merged[key] = value;
      }
      // else: keep the first non-null scalar — later passes restate, they don't correct.
    }
  }
  return merged;
}

// Runs an extraction over a document that may be too long for one call, and merges the
// result. `analyze(buffer, context)` is called once per part, in order — sequentially,
// because the account's per-minute token allowance would rate-limit parallel passes.
async function analyzeInPasses(buffer, analyze, maxPages = MAX_PAGES_PER_PASS) {
  const parts = await splitPdf(buffer, maxPages);
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true }).catch(() => null);

  // A pass can fit the request and still overflow the ANSWER: forty pages of a continuation
  // sheet carrying three hundred line items produce more JSON than one reply holds. That used
  // to end the whole extraction with a message telling the PM to split the PDF by hand — the
  // document's size deciding whether the feature worked at all. A cut-off answer now halves
  // its own pages and reads both halves, as far down as a single page.
  const run = async (part, context) => {
    try {
      return await analyze(part.buffer, context);
    } catch (err) {
      const pages = (part.endPage ?? 0) - (part.startPage ?? 0) + 1;
      if (!err?.truncated || pages <= 1 || !source) throw err;
      const mid = part.startPage + Math.floor((part.endPage - part.startPage) / 2);
      console.warn(`[pdfChunk] pages ${part.startPage}-${part.endPage} overflowed one answer; `
        + 'reading them in two halves');
      const halves = [await slice(source, part.startPage, mid), await slice(source, mid + 1, part.endPage)];
      const out = [];
      for (const half of halves) {
        out.push(await run(half, { ...context, startPage: half.startPage, endPage: half.endPage, isPart: true }));
      }
      return mergeExtracted(out);
    }
  };

  // Passes run CONCURRENTLY, and the wall clock is the slowest pass rather than the sum of all of
  // them. They used to run one after another for a specific reason: the account allowed about
  // 10,000 input tokens a minute and five requests a minute, so two passes at once simply failed.
  // Measured on 2026-08-17 the same account allows 5,000,000 input tokens, 1,000,000 output tokens
  // and 5,000 requests a minute. Every wait this loop imposed was paying a toll that no longer
  // exists — and the toll was expensive, because what makes a pass slow is the model WRITING the
  // transcription, about a hundred tokens a second, which is time no amount of input allowance
  // shortens. Four passes of five thousand output tokens is three minutes in series and fifty
  // seconds in parallel.
  //
  // Capped rather than unbounded: a three-hundred-page package would otherwise open sixty
  // simultaneous requests, which is neither kind to the API nor necessary — past a handful, the
  // slowest pass dominates anyway.
  const results = await inParallel(parts, (part, index) => run(part, {
    isPart: parts.length > 1,
    partNumber: index + 1,
    partCount: parts.length,
    startPage: part.startPage,
    endPage: part.endPage,
  }));
  return mergeExtracted(results);
}

// Runs at most CONCURRENCY of them at a time, preserving order in the result. Order matters:
// mergeExtracted concatenates line items, and a continuation sheet read out of order would come
// back with its rows shuffled.
const CONCURRENCY = 6;

async function inParallel(items, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// Wording for the prompt so the model treats a part as an extract rather than the whole
// document — otherwise it reports the pages it cannot see as missing or contradictory.
function partNotice({ isPart, partNumber, partCount, startPage, endPage }) {
  if (!isPart) return '';
  return `\n\nIMPORTANT — you are reading pages ${startPage}-${endPage} (part ${partNumber} of ${partCount}) ` +
    'of a longer document. Extract only what these pages actually show. Use null for any field ' +
    'whose value is not on these pages — do not infer it, and do not report the rest of the ' +
    'document as missing. The parts are combined afterwards.';
}

module.exports = {
  MAX_PAGES_PER_PASS, MAX_BYTES_PER_PASS, pageCount, splitPdf, planPasses, passLabel, isPdf,
  mergeExtracted, analyzeInPasses, partNotice,
};
