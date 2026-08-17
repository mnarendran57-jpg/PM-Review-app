// Finding which pages of a drawing set are which sheets.
//
// An RFI is answered from drawings, and a set runs to hundreds of sheets. Getting from "the
// corridor duct conflicts with the beam" to the two sheets that settle it is the whole problem,
// and the expensive way to do it is to send the front of the set to the model as images and ask
// it to read the index. That costs a call, and what it returns is an estimate: the index gives
// the sheet's position in a list, and the position has to be translated into a PDF page by
// assuming the set is bound in index order with nothing in front of it. A cover sheet or an
// addendum breaks that assumption silently.
//
// A drawing set is drafted, not scanned, so every sheet's number is in its own title block and
// therefore in the PDF's text layer. That makes the mapping from sheet number to page a search
// rather than an inference — free, exact, and immune to whatever is bound in front.
//
// The same idea as lib/specLocator.js, against a different kind of document. A specification is
// found by a heading that says SECTION; a drawing is found by its number appearing on the sheet
// itself, which is why the two need different rules despite the identical purpose.

// A sheet number: one to three letters, an optional separator, digits, sometimes a decimal.
// "M-401", "A101", "E-2.1", "FP-101", "MD1.02" all occur, and often in the same set.
const { readTextPages: readPages } = require('./pdfTextLayer');

const SHEET = '\\b([A-Z]{1,3})[-. ]?(\\d{1,3}(?:\\.\\d{1,2})?[A-Z]?)\\b';
const SHEET_RE = new RegExp(SHEET, 'g');

// Short words that precede a number in ordinary English and are not sheet prefixes. Without
// this, the sentence `the 36" main above the corridor` yields a sheet called THE-36, and the
// answer goes looking for a drawing that does not exist. Everything a real set uses as a
// prefix is a discipline code, so a stop list is safe where a whitelist would not be —
// consultants invent prefixes (FA, FP, MD, AV, LS) and a whitelist would drop them.
const NOT_A_PREFIX = new Set([
  'THE', 'AND', 'FOR', 'PER', 'SEE', 'ALL', 'ARE', 'WAS', 'HAS', 'CAN', 'MAY', 'ITS', 'OUR',
  'NEW', 'OLD', 'TOP', 'END', 'ADD', 'REF', 'TYP', 'NTS', 'EA', 'AT', 'BY', 'IN', 'OF', 'ON',
  'TO', 'IS', 'IT', 'AS', 'OR', 'NO', 'DO', 'UP', 'RE', 'SF', 'LF', 'CY', 'GA', 'DIA', 'MIN',
  'MAX', 'NIC', 'AFF', 'BOD', 'GC', 'AE', 'PM', 'RFI', 'CO',
]);

// A page naming this many different sheets is a drawing index, not a drawing.
const INDEX_SHEET_COUNT = 5;

// Words that mark the index page, for the sets that label it.
const INDEX_WORDS = /\b(DRAWING\s+INDEX|SHEET\s+INDEX|DRAWING\s+LIST|SHEET\s+LIST|INDEX\s+OF\s+DRAWINGS)\b/i;

// A drawing's text layer is sparse — a title block, some callouts, a note or two. A page with
// this much text is prose (a specification bound into the set, a general-notes page), and its
// title block number should not be trusted as "this is sheet X" the way a drawing's is.
const PROSE_CHARS = 1200;

const upper = text => String(text || '').toUpperCase();

// Normalised so "M-401", "M401" and "M 401" compare equal.
const keyOf = (prefix, number) => `${prefix}${number}`.replace(/[^A-Z0-9.]/g, '');

// Every sheet number a piece of text mentions, in order of appearance.
function sheetsIn(text) {
  const out = [];
  SHEET_RE.lastIndex = 0;
  let m;
  while ((m = SHEET_RE.exec(text)) !== null) {
    if (NOT_A_PREFIX.has(m[1])) continue;
    out.push({ key: keyOf(m[1], m[2]), label: `${m[1]}-${m[2]}`, at: m.index, raw: m[0] });
  }
  return out;
}

// The drawing index, if the set has one: the page listing the most sheets.
//
// Returned as a list of { key, label, title } in the order printed, which is also the order the
// sheets are bound — useful as a fallback when a sheet's own page cannot be found.
function readIndex(pages) {
  let best = null;
  for (const { page, text } of pages) {
    const up = upper(text);
    const found = sheetsIn(up);
    const distinct = new Set(found.map(s => s.key));
    if (distinct.size < INDEX_SHEET_COUNT) continue;
    const score = distinct.size + (INDEX_WORDS.test(up) ? 100 : 0);
    if (!best || score > best.score) best = { page, score, found, text: up };
  }
  if (!best) return null;

  // Titles are whatever sits between one sheet number and the next. The last entry has no next
  // number to stop at, so it runs on into whatever else is on the page — a project name, the
  // words "DRAWING INDEX", a title block. Those are cut off explicitly.
  const listed = [];
  const seen = new Set();
  for (let i = 0; i < best.found.length; i++) {
    const s = best.found[i];
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const from = s.at + s.raw.length;
    const to = best.found[i + 1]?.at ?? Math.min(best.text.length, from + 90);
    const title = best.text.slice(from, to)
      .replace(/[.\s]{2,}/g, ' ')
      .replace(/^[\s\-—:]+/, '')
      .replace(/\s*\d{1,3}\s*$/, '')
      .split(INDEX_WORDS)[0]
      .trim()
      .slice(0, 70) || null;
    listed.push({ key: s.key, label: s.label, title });
  }
  return { page: best.page, sheets: listed };
}

// Which page each sheet actually sits on.
//
// A drawing repeats its own number in the title block and almost nowhere else, so the page
// whose sparse text carries a number IS that sheet. Index pages are excluded, and so are prose
// pages, where a number in the running head means something else.
function mapSheetsToPages(pages, indexPage, known) {
  const map = new Map();
  for (const { page, text } of pages) {
    if (page === indexPage) continue;
    if (text.length > PROSE_CHARS) continue;

    // Only numbers the set actually contains are candidates. This is what the index is for:
    // a section drawing that references four other sheets used to be skipped as "too many
    // numbers to be a sheet", which lost the very sheet an RFI about a duct section needs.
    // Knowing which numbers are real turns a guess into a lookup.
    const found = sheetsIn(upper(text)).filter(s => !known || known.has(s.key));
    if (!found.length) continue;

    // The sheet's own number is the one printed most often on it — the title block, usually
    // the revision block too. References to other sheets appear once each.
    const tally = new Map();
    for (const s of found) tally.set(s.key, (tally.get(s.key) || 0) + 1);
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    // A tie means nothing repeats, so fall back to the one printed last: the title block sits
    // in the bottom corner and comes last in reading order.
    const own = ranked[0][1] > (ranked[1]?.[1] || 0)
      ? ranked[0][0]
      : found[found.length - 1].key;
    if (!map.has(own)) map.set(own, page);
  }
  return map;
}

// Sheet numbers named in the RFI itself. The cheapest answer of all: a contractor who writes
// "see sheet M-401" has already done the locating.
//
// `known` is the set the drawings actually contain, and passing it is what makes this safe.
// Contractors write in prose full of dimensions and equipment tags, and any of those can read
// as a sheet number to a pattern match. Keeping only numbers the set really has turns a guess
// into a lookup, and costs nothing because the index was already read.
function sheetsNamedIn(text, known = null) {
  const out = [];
  const seen = new Set();
  for (const s of sheetsIn(upper(text || ''))) {
    if (seen.has(s.key)) continue;
    if (known && !known.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

// Locate the sheets of a drawing set.
//
// Returns null when there is no usable text layer — a scanned set, where searching cannot help
// and the caller has to fall back to reading it. Otherwise:
//   { totalPages, index: [{key,label,title}] | [], pageOf: Map(key -> page), mapped }
// `mapped` is how many of the indexed sheets were found on a page of their own, which is what
// tells the caller whether to trust the map or fall back to index order.
async function locateSheets(buffer) {
  const pages = await readPages(buffer);
  if (!pages.length || pages.every(p => p.text.length < 20)) return null;

  const index = readIndex(pages);
  const known = index ? new Set(index.sheets.map(s => s.key)) : null;
  const pageOf = mapSheetsToPages(pages, index?.page, known);

  // An entry with neither a title nor a page of its own is an artifact of reading the index —
  // the index page's own title block, or a number caught in a header. Keeping it would offer
  // the model a sheet that does not exist.
  const listed = (index?.sheets || []).filter(s => s.title || pageOf.has(s.key));
  const mapped = listed.filter(s => pageOf.has(s.key)).length;

  // With an index but no sheet found on its own page, fall back to position: sheets are bound
  // in the order the index lists them, starting after whatever precedes the first one.
  if (listed.length && mapped === 0) {
    const first = Math.min(...pages.map(p => p.page).filter(p => p > (index?.page || 0)));
    if (Number.isFinite(first)) {
      listed.forEach((s, i) => pageOf.set(s.key, first + i));
    }
  }

  return {
    totalPages: pages.length,
    indexPage: index?.page || null,
    index: listed,
    pageOf,
    mapped,
    positional: !!(listed.length && mapped === 0),
  };
}

module.exports = { locateSheets, sheetsNamedIn, readIndex, readPages, sheetsIn };
