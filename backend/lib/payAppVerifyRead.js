// Checking the transcription against the document it came from.
//
// A continuation sheet is read by a language model, which is the right tool for finding the
// figures in an unfamiliar layout and the wrong tool for copying them. On a real application it
// read a balance-to-finish of $96,360.71 as $76,360.71 — one digit — and every check downstream
// then did correct arithmetic on a wrong number and reported the contractor.
//
// The important thing about that failure: the page had a TEXT LAYER. The figure was sitting in
// the PDF as characters, exactly right, and nobody looked. So this module looks.
//
// It is a verifier rather than a parser, deliberately. A general table parser has to work out
// which column is which, and gets that wrong on unfamiliar forms in ways that are hard to
// notice. This takes the model's transcription as the question — "you say this line reads
// 484,339.00, 342,439.16, 45,539.13…" — and asks the page whether those numbers are on that row.
// It needs no idea what any column means.
//
// What it does about a mismatch is deliberately narrow:
//
//   every figure found          the row is confirmed, nothing changes
//   one figure missing, and
//     exactly one number on
//     the row unaccounted for   that number is the answer; the transcription is corrected
//   anything else               left alone and REPORTED, because a row that cannot be
//                               reconciled is exactly the row nobody should quietly fix
//
// A correction is only ever made when the document leaves no choice about what the value is.

const { eachPage } = require('./pdfTextLayer');

const MONEY = /^\(?-?\$?[\d,]+\.\d{2}\)?$/;
const ROW_TOLERANCE = 2.5;        // points; a wrapped cell sits a fraction off its row

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Cents matter, so figures are compared as integer cents rather than floats.
const cents = n => Math.round(n * 100);

function parseMoney(text) {
  const t = String(text).trim();
  if (!MONEY.test(t)) return null;
  const negative = t.startsWith('(') || t.startsWith('-');
  const v = Number(t.replace(/[($,)\s-]/g, ''));
  return Number.isFinite(v) ? (negative ? -v : v) : null;
}

const normalise = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Positioned text, one entry per page, in the coordinates the page is actually LOOKED at in.
//
// This matters more than it sounds. A continuation sheet is usually landscape, achieved by
// rotating a portrait page, and the raw coordinates in the file are then rotated too: reading
// them directly transposes the table, so every visual row comes back as a column. The first
// version of this did exactly that and reconciled nothing on the wider of the two forms.
// Applying the page's own viewport transform puts x across and y down, whatever the rotation.
function readPages(buffer) {
  return eachPage(buffer, async (page, _p, pdfjs) => {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return content.items.map((i) => {
      const [x, y] = pdfjs.Util.applyTransform([i.transform[4], i.transform[5]], viewport.transform);
      return { str: (i.str || '').trim(), x, y };
    }).filter(i => i.str);
  });
}

// Group a page's text into visual rows, left to right. Viewport y grows downward, so the top of
// the page sorts first.
function rowsOf(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= ROW_TOLERANCE) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map(i => i.str).join(' ');
    r.key = normalise(r.text);
    r.numbers = r.items.map(i => parseMoney(i.str)).filter(v => v != null);
  }
  return rows;
}

// The numeric fields a continuation sheet line carries. Order does not matter — the row's
// numbers are treated as a bag, which is what makes this independent of column layout.
const FIELDS = ['originalValue', 'changeOrders', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'retainage'];

const figuresOf = li => FIELDS.map(f => li[f]).filter(isNum);

// Which row is this line item?
//
// Naming alone is not enough. A cost code appears on the continuation sheet AND again in the
// contractor's own summary pages, and a description like "General Conditions" can appear on
// several lines of the same schedule. So candidates are gathered by name and then SCORED by how
// many of the line's own figures they contain — the real row will hold nearly all of them, a
// namesake elsewhere in the package will hold one or two.
//
// A tie is treated as no match. Verifying against the wrong row is worse than not verifying:
// it would "correct" a good figure to a number from somewhere else in the document.
function findRow(rows, li) {
  const itemNo = li.itemNo == null ? '' : String(li.itemNo).trim();
  const want = normalise(li.description);

  let candidates = itemNo ? rows.filter(r => r.items.some(i => i.str === itemNo)) : [];
  if (!candidates.length && want.length >= 6) candidates = rows.filter(r => r.key.includes(want));

  // A long description wraps, and the figures sit on the line with the TAIL of it:
  //
  //     Allowance #1 - Assistance with Removal of Loose
  //     Furniture          20,000.00   (1,954.00)   18,046.00  ...
  //
  // Searching for the whole description finds neither row. So a second pass looks for any
  // substantial word from it, which puts every fragment of the wrap in the running, and the
  // figure-scoring below picks the one actually holding this line's numbers. That ordering is what
  // keeps it safe: a common word like "allowance" nominates several rows, and a nomination is
  // worth nothing until the figures agree.
  if (!candidates.length) {
    const words = [...new Set(String(li.description || '').toLowerCase().match(/[a-z]{6,}/g) || [])];
    if (words.length) candidates = rows.filter(r => words.some(w => r.key.includes(w)));
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const figures = figuresOf(li).map(cents);
  if (!figures.length) return null;
  const score = (row) => {
    const bag = new Map();
    for (const n of row.numbers) bag.set(cents(n), (bag.get(cents(n)) || 0) + 1);
    let hit = 0;
    for (const f of figures) if (bag.get(f)) { bag.set(f, bag.get(f) - 1); hit += 1; }
    return hit;
  };
  const ranked = candidates.map(r => ({ r, s: score(r) })).sort((a, b) => b.s - a.s);
  if (ranked[0].s === 0) return null;
  if (ranked[1] && ranked[1].s === ranked[0].s) return null;    // ambiguous
  return ranked[0].r;
}

// Is `candidate` what `read` was MEANT to be — the same figure with a digit misread?
//
// This guard exists because of a false correction this module made on its first run against a
// real document. A blank change-order column had been recorded as 0, no "0.00" was on the page to
// match it, and an extra column the transcription does not record was sitting unclaimed — so the
// two paired up and it confidently "corrected" 0 to $283,027.83.
//
// A misread digit changes a digit. It does not turn a zero into a six-figure sum. So a
// correction is only allowed between numbers of the same length differing in at most two
// positions, which is what a slipped digit or a transposition actually looks like.
// A wrong digit, a transposition, or a dropped digit — all of which happen — but not a different
// number. Length may differ by one (a digit lost or gained) and no more.
const MAX_DIGIT_EDITS = 2;

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,                                        // deletion
        row[j - 1] + 1,                                     // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),      // substitution
      );
    }
    prev = row;
  }
  return prev[b.length];
}

function looksLikeMisreadOf(read, candidate) {
  const a = String(cents(Math.abs(read)));
  const b = String(cents(Math.abs(candidate)));
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  // Short figures are excluded: almost any two of them are within two edits of each other, so a
  // match would mean nothing.
  if (Math.min(a.length, b.length) < 4) return false;
  return editDistance(a, b) <= MAX_DIGIT_EDITS;
}

function reconcileLine(li, row) {
  const bag = new Map();                          // value in cents -> how many times on the row
  for (const n of row.numbers) bag.set(cents(n), (bag.get(cents(n)) || 0) + 1);

  const missing = [];
  for (const field of FIELDS) {
    const v = li[field];
    if (!isNum(v)) continue;
    // A zero is unverifiable and must never be treated as missing. Forms print it as "-", as an
    // em dash, as "0.00", or by leaving the cell empty, so there is frequently no token to match
    // — and counting it as absent is what let a zero get "corrected" into a real figure.
    if (cents(v) === 0) continue;
    const k = cents(v);
    if (bag.get(k)) bag.set(k, bag.get(k) - 1);
    else missing.push({ field, value: v });
  }
  const leftover = [];
  for (const [k, count] of bag) for (let i = 0; i < count; i++) leftover.push(k / 100);

  return { missing, leftover };
}

// --- the public call ---------------------------------------------------------------------------

async function verifyRead(pdfBuffer, current) {
  const lineItems = current?.lineItems || [];
  const out = {
    available: false, rowsChecked: 0, confirmed: 0,
    corrections: [], unverified: [], findings: [],
  };
  if (!lineItems.length) return out;

  let pages;
  try {
    pages = await readPages(pdfBuffer);
  } catch (err) {
    out.note = `The document's text layer could not be read (${err.message}), so the transcription `
      + 'was not verified against it.';
    return out;
  }

  const allRows = pages.flatMap(rowsOf);
  // A scan has no text layer worth speaking of. Saying so is the honest outcome: the figures are
  // unverified, and the report should not imply otherwise.
  if (allRows.reduce((a, r) => a + r.numbers.length, 0) < lineItems.length) {
    out.note = 'This application has no usable text layer — it is a scan — so the figures could '
      + 'not be checked against the page and rest entirely on the reading.';
    return out;
  }
  out.available = true;

  for (const li of lineItems) {
    const row = findRow(allRows, li);
    if (!row) {
      out.unverified.push({ itemNo: li.itemNo, description: li.description, why: 'row not located' });
      continue;
    }
    out.rowsChecked += 1;
    const { missing, leftover } = reconcileLine(li, row);

    if (!missing.length) { out.confirmed += 1; continue; }

    if (missing.length === 1) {
      const { field, value } = missing[0];
      // Only figures that could plausibly BE this one, misread. A continuation sheet carries
      // columns the transcription does not record — "previous and this", a per-page subtotal —
      // so there is often something unclaimed on the row that has nothing to do with the gap.
      // Distinct values, not distinct tokens. A figure that appears in several columns of the
      // same row — a line billed in full shows the same amount four or five times — would
      // otherwise look like several competing candidates when they are all the same answer.
      const candidates = [...new Set(leftover.filter(v => looksLikeMisreadOf(value, v)).map(cents))];
      if (candidates.length === 1) {
        const actual = candidates[0] / 100;
        li[field] = actual;                                 // the page wins
        out.corrections.push({
          itemNo: li.itemNo, description: li.description, field, was: value, now: actual,
        });
        out.confirmed += 1;
        continue;
      }
    }

    // More than one figure adrift, or no single candidate for the one that is. Correcting here
    // would be guessing, and a wrong correction is worse than a wrong reading because it looks
    // authoritative. So it is reported instead.
    out.unverified.push({
      itemNo: li.itemNo,
      description: li.description,
      why: `${missing.length} figure(s) on this line are not on the page`,
      missing: missing.map(m => m.value),
      onPage: leftover,
    });
  }

  if (out.corrections.length) {
    out.findings.push({
      id: 'X1',
      severity: 'note',
      detail: `${out.corrections.length} figure(s) were transcribed incorrectly and have been `
        + `corrected from the document's own text: `
        + `${out.corrections.slice(0, 4).map(c =>
          `${c.description || `item ${c.itemNo}`} ${c.field} read as ${c.was}, actually ${c.now}`).join('; ')}`
        + `${out.corrections.length > 4 ? `, and ${out.corrections.length - 4} more` : ''}. `
        + 'The checks below ran on the corrected figures.',
    });
  }
  if (out.unverified.length) {
    out.findings.push({
      id: 'X2',
      severity: 'note',
      detail: `${out.unverified.length} line(s) could not be reconciled against the page, so their `
        + 'figures rest on the reading alone rather than on the document. Nothing was changed on '
        + 'them, and any finding about those lines is worth checking against the original before '
        + 'it is sent to the contractor.',
    });
  }
  return out;
}

module.exports = { verifyRead, readPages, rowsOf, parseMoney, findRow, reconcileLine };
