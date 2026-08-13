// Finding the scope language in a set of documents, for nothing.
//
// This is the half of the proposal comparison that costs no API calls at all, and it exists
// because of one fact: a drawing set is 300 pages and the part that decides what is in the
// contract is about six paragraphs. Reading all 300 to find them would cost twenty times what
// the whole review costs today, take an hour against the account's rate limit, and produce a
// WORSE answer — the signal is a few scope notes and 300 pages of dimensions is noise around it.
//
// A PDF made by CAD or a word processor carries its text as characters. Searching it is free
// and takes about a second. So this module does the locating, and lib/preconCompare.js spends
// one small call judging only what was found.
//
// It also earns its keep on its own. Some discrepancies need no judgement whatsoever: a drawing
// note saying a scope is BY OTHERS, and a proposal line pricing that same scope, is a finding
// that arithmetic-grade certainty can reach. Those are reported here, free, on every review.
//
// The honest limit, stated wherever this is used: a SCANNED drawing set has no text layer. This
// finds nothing in one, and must say so rather than reporting "no discrepancies".

const EXCLUSION = [
  // What the documents say somebody else is doing. The most valuable phrases in a drawing set,
  // and the ones a proposal most often prices anyway.
  { key: 'by others', re: /\bby\s+others\b/gi },
  { key: 'not in contract', re: /\bnot\s+in\s+contract\b/gi },
  // The abbreviations stay case-SENSITIVE and separate. Written out, the phrase must match
  // however it is capitalised — a drawing note shouts "NOT IN CONTRACT" — but "nic" and "etr"
  // are ordinary letter runs in lower case and would fire on half the words in a specification.
  // Sharing one regex meant the phrase inherited the abbreviation's case sensitivity, and a note
  // reading "Fire alarm interface devices are NOT IN CONTRACT" was walked straight past.
  { key: 'not in contract', re: /\bN\.?I\.?C\.?\b(?!\w)/g },
  { key: 'by owner', re: /\b(?:furnished|provided|supplied)\s+by\s+owner\b|\bby\s+owner\b/gi },
  { key: 'existing to remain', re: /\bexisting\s+to\s+remain\b/gi },
  { key: 'existing to remain', re: /\bE\.?T\.?R\.?\b(?!\w)/g },
  { key: 'future', re: /\bfuture\s+(?:work|phase|by)\b/gi },
  { key: 'excluded', re: /\bexclusion[s]?\b|\bexcluded\s+from\b|\bnot\s+included\b/gi },
  { key: 'deferred', re: /\bdeferred\s+submittal\b|\bunder\s+separate\s+(?:contract|permit)\b/gi },
];

const INCLUSION = [
  { key: 'scope of work', re: /\bscope\s+of\s+work\b/gi },
  { key: 'contractor shall', re: /\bcontractor\s+shall\s+(?:provide|furnish|install|include)\b/gi },
  { key: 'included', re: /\bshall\s+include\b|\bwork\s+includes\b|\bincluded\s+in\s+(?:the\s+)?(?:contract|base\s+bid)\b/gi },
  { key: 'general notes', re: /\bgeneral\s+notes?\b/gi },
  { key: 'base bid', re: /\bbase\s+bid\b|\balternate\s+no\.?\s*\d+/gi },
  { key: 'allowance', re: /\ballowance[s]?\b/gi },
];

const ALL_PATTERNS = [...EXCLUSION, ...INCLUSION];
const EXCLUSION_KEYS = new Set(EXCLUSION.map(p => p.key));

// How much text either side of a hit is kept. A scope note is a sentence or two; a paragraph is
// enough to know what it is about and short enough that fifty of them still cost nothing.
const CONTEXT = 260;
// Pages worth sending on to the model. Set by the token allowance: fifteen drawing pages is
// about 30,000 input tokens, one request, and comfortably inside a minute's budget.
const MAX_PAGES = 15;
// Below this a page's hits are not worth a page of a model's attention.
const MIN_HITS_TO_SEND = 1;

const normalise = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Words that carry no scope meaning, so a proposal line matching a drawing note on "the" or
// "system" alone is not a match at all.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'all', 'with', 'per', 'shall', 'work', 'system', 'systems', 'new',
  'provide', 'install', 'furnish', 'include', 'included', 'including', 'this', 'that', 'from',
  'each', 'any', 'other', 'others', 'not', 'contract', 'owner', 'general', 'note', 'notes',
  'scope', 'existing', 'required', 'requirements', 'complete', 'items', 'item', 'total',
]);

const contentWords = text => [...new Set(normalise(text).split(' '))]
  .filter(w => w.length >= 4 && !STOPWORDS.has(w));

// --- reading the text out, free ------------------------------------------------------------------

// One entry per page: its number and its text. pdfjs reports positioned fragments, which are
// joined in reading order — good enough to search, and no API call is involved.
async function readPages(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ page: p, text });
  }
  await doc.destroy();
  return pages;
}

// The single statement a phrase belongs to.
//
// This exists because of a false positive that would have wrecked the feature. Drawing general
// notes are a numbered list, and a 260-character window around "BY OTHERS" swallows the notes
// either side of it. On the first test that meant note 2 ("temporary heating is BY OTHERS")
// dragged in note 1's list of everything the contractor DOES provide — and five proposal lines
// were reported as excluded when only one was.
//
// So a match is scoped to its own note. Numbered notes are split on their markers; prose falls
// back to sentences. The wide window is still kept for DISPLAY, because a reader wants the
// surrounding text — but nothing is ever matched against it.
function enclosingStatement(text, at) {
  // "1. ", "2. ", "A. " — the shape of a general-note list.
  const markers = [...text.matchAll(/(?:^|\s)(?:\d{1,2}|[A-Z])\.\s+(?=[A-Z])/g)].map(m => m.index);
  if (markers.length >= 2) {
    const start = markers.filter(i => i <= at).pop() ?? 0;
    const end = markers.find(i => i > at) ?? text.length;
    return text.slice(start, end).trim();
  }
  // Prose: the sentence it sits in.
  const before = text.lastIndexOf('. ', at);
  const after = text.indexOf('. ', at + 1);
  return text.slice(before === -1 ? 0 : before + 2, after === -1 ? text.length : after + 1).trim();
}

// Every scope phrase on one page, with the statement it belongs to and a wider window to read it in.
function passagesIn(pageText) {
  const found = [];
  for (const { key, re } of ALL_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(pageText);
    while (m) {
      const from = Math.max(0, m.index - CONTEXT / 2);
      const to = Math.min(pageText.length, m.index + m[0].length + CONTEXT);
      found.push({
        key,
        kind: EXCLUSION_KEYS.has(key) ? 'exclusion' : 'inclusion',
        phrase: m[0],
        // What the phrase actually governs. Matching happens against this and only this.
        statement: enclosingStatement(pageText, m.index),
        text: (from > 0 ? '…' : '') + pageText.slice(from, to).trim() + (to < pageText.length ? '…' : ''),
      });
      // A drawing sheet repeats "by others" a dozen times in one legend. Three is plenty to
      // establish what the page says, and stops one page swamping the budget.
      if (found.filter(f => f.key === key).length >= 3) break;
      m = re.exec(pageText);
    }
  }
  return found;
}

// --- the free cross-check --------------------------------------------------------------------------
//
// Where certainty is available without judgement. A proposal line whose distinctive words appear
// inside a drawing note that says BY OTHERS is a real finding, reachable by matching alone. It is
// reported as something to check rather than as a fact, because the words matching does not prove
// the scopes are the same one — but it puts the reader on the exact page.

function crossCheck({ passages, proposalLines }) {
  const exclusions = passages.filter(p => p.kind === 'exclusion');
  if (!exclusions.length || !proposalLines.length) return [];

  const findings = [];
  for (const line of proposalLines) {
    const words = contentWords(line.description || line.text || '');
    if (words.length < 2) continue;                       // too generic to match on

    for (const p of exclusions) {
      // The exclusion's OWN statement, never the display window. See enclosingStatement above:
      // matching against the wider text reported work as excluded because an adjacent note
      // happened to mention it.
      const hay = normalise(p.statement || p.text);
      const hit = words.filter(w => hay.includes(w));
      // Most of the distinctive words, not just two of them. "Temporary heating and cooling
      // during construction" against a note excluding exactly that scores five of five; "HVAC
      // equipment, ductwork and piping" against the same note scores nothing once the note is
      // read on its own. A high bar here is what keeps a free check from crying wolf.
      const ratio = hit.length / words.length;
      const strong = (hit.length >= 2 && ratio >= 0.6) || (hit.length >= 4);
      if (!strong) continue;
      findings.push({
        proposalLine: line.description || line.text,
        amount: line.amount ?? null,
        documentLabel: p.documentLabel,
        page: p.page,
        phrase: p.phrase,
        statement: p.statement,
        passage: p.text,
        matchedOn: hit,
        matchStrength: Math.round(ratio * 100),
      });
      break;                                              // one finding per proposal line
    }
  }
  return findings;
}

// --- the public call ---------------------------------------------------------------------------------

// documents: [{ label, buffer }] — the drawings, contract and anything else chosen.
// proposalLines: [{ description, amount }] — what the proposal prices, if it has been read.
//
// Returns the passages worth sending on, which pages they are on, the free findings, and an
// honest account of what could not be read.
async function locateScope({ documents = [], proposalLines = [] }) {
  const passages = [];
  const read = [];
  const unreadable = [];

  for (const doc of documents) {
    let pages;
    try {
      pages = await readPages(doc.buffer);
    } catch (err) {
      unreadable.push({ label: doc.label, why: err.message });
      continue;
    }

    const withText = pages.filter(p => p.text.length > 40);
    // A scanned set: pdfjs returns pages with no characters on them. Saying so matters — a
    // silent "no discrepancies found" on a document nobody could read is the worst outcome here.
    if (!withText.length) {
      unreadable.push({
        label: doc.label,
        why: 'no text layer — this looks like a scan, so its scope notes could not be searched',
      });
      continue;
    }

    const hitPages = [];
    for (const p of withText) {
      const found = passagesIn(p.text);
      if (found.length < MIN_HITS_TO_SEND) continue;
      hitPages.push({ page: p.page, hits: found.length });
      for (const f of found) passages.push({ ...f, documentLabel: doc.label, page: p.page });
    }

    read.push({
      label: doc.label,
      pagesTotal: pages.length,
      pagesWithText: withText.length,
      pagesWithScopeLanguage: hitPages.length,
      // Ranked by how much scope language is on them, so the budget goes to the densest pages.
      pages: hitPages.sort((a, b) => b.hits - a.hits).map(h => h.page),
    });
  }

  // Share the page budget across documents rather than letting the first one take it all: the
  // contract's scope article matters as much as the drawings' general notes.
  const perDocument = read.length ? Math.max(2, Math.floor(MAX_PAGES / read.length)) : 0;
  const selected = read.map(r => ({
    label: r.label,
    pages: r.pages.slice(0, perDocument).sort((a, b) => a - b),
  })).filter(r => r.pages.length);

  return {
    passages,
    selected,
    read,
    unreadable,
    findings: crossCheck({ passages, proposalLines }),
    // True when there is genuinely nothing to hand on — every document was a scan, or none of
    // them said anything about scope.
    empty: !passages.length,
  };
}

// What the proposal prices, read off its own text layer. Free, like everything else here.
//
// The free cross-check needs the proposal's line items to match against the documents' exclusion
// notes, and asking a model to list them would spend a call on something a regular expression can
// do. A priced line is a description followed by money — that is what a proposal IS — so lines
// carrying a currency amount are taken and the words before it are the description.
//
// Deliberately loose about what it collects and strict about what it keeps: a line with no
// describable text is dropped rather than matched on its number.
const MONEY_LINE = /^(.*?)[\s.]*\$?\s*([\d,]+(?:\.\d{2})?)\s*$/;

async function proposalLinesFrom(buffer, { maxLines = 120 } = {}) {
  let pages;
  try {
    pages = await readPages(buffer);
  } catch {
    return [];
  }
  const lines = [];
  for (const p of pages) {
    // pdfjs joins a page into one run, so it is split on the shapes a priced line ends with.
    for (const raw of p.text.split(/(?<=\d)\s{2,}|(?<=\.\d{2})\s+(?=[A-Z])|\s{4,}/)) {
      const m = MONEY_LINE.exec(raw.trim());
      if (!m) continue;
      // pdfjs joins a page into one run, so the first priced line can arrive with the letterhead
      // still attached to it. A line item's description is the words immediately before the
      // money, so a long run is trimmed to its tail rather than matched with a page of header
      // dragging its word count down.
      const description = m[1].replace(/[|·•\-–—]+/g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ').slice(-12).join(' ');
      const amount = Number(m[2].replace(/,/g, ''));
      // A bare number, a page number, or a total with no scope in it is not a line item.
      if (description.length < 6 || !Number.isFinite(amount) || amount <= 0) continue;
      if (contentWords(description).length < 1) continue;
      lines.push({ description, amount, page: p.page });
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

module.exports = { locateScope, readPages, passagesIn, crossCheck, proposalLinesFrom, MAX_PAGES };
