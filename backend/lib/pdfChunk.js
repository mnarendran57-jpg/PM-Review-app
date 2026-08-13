const { PDFDocument } = require('pdf-lib');

// The model refuses a PDF outright past a hard page ceiling — 100 pages on the model this
// app uses — and that refusal is what a 100-page pre-construction set ran into. Splitting a
// long document and reading it in passes removes the ceiling from the user's side, so no
// upload is rejected for being long.
//
// Well under the ceiling on purpose: a page of dense drawings costs far more tokens than a
// page of prose, and the account's per-minute token allowance binds sooner than the page
// count does. Smaller passes also fail smaller — one can be retried without redoing the
// whole document.
const MAX_PAGES_PER_PASS = 40;

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
// Size is checked after the split rather than predicted before it, because a PDF's weight is
// not spread evenly across its pages: one scanned photograph in an otherwise text document
// carries most of the file. So an oversized part is halved and each half measured again, down
// to a single page, which is as far as splitting can go.
async function splitPdf(buffer, maxPages = MAX_PAGES_PER_PASS, maxBytes = MAX_BYTES_PER_PASS) {
  const total = await pageCount(buffer);
  if (total == null) return [{ buffer, startPage: 1, endPage: total, partCount: 1 }];
  if (total <= maxPages && buffer.length <= maxBytes) {
    return [{ buffer, startPage: 1, endPage: total, partCount: 1 }];
  }

  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const parts = [];

  const add = async (startPage, endPage) => {
    const part = await slice(source, startPage, endPage);
    const pages = endPage - startPage + 1;
    // A single page over the ceiling cannot be divided further. It is sent as it is: one page
    // is small enough to be accepted in practice, and refusing it here would be the upload
    // rejected for its size that this splitter exists to prevent.
    if (pages > 1 && (pages > maxPages || part.buffer.length > maxBytes)) {
      const mid = startPage + Math.floor((endPage - startPage) / 2);
      await add(startPage, mid);
      await add(mid + 1, endPage);
      return;
    }
    parts.push(part);
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
  const results = [];

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

  for (const [index, part] of parts.entries()) {
    results.push(await run(part, {
      isPart: parts.length > 1,
      partNumber: index + 1,
      partCount: parts.length,
      startPage: part.startPage,
      endPage: part.endPage,
    }));
  }
  return mergeExtracted(results);
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
