// Finding the one section of a project manual that governs a submittal.
//
// A submittal says what it is made under — "23 05 93", "Section 22 11 16", sometimes only
// "Division 23". The specification it has to be judged against is one section of a manual that
// runs to hundreds of pages. Everything hard about reviewing a submittal cheaply comes down to
// getting from that reference to those few pages without reading the book.
//
// This does it for nothing. A specification is a typeset document, so its section headings are
// in the PDF's own text layer, and finding "SECTION 23 05 93" in a text layer is a search, not
// a judgement. No API call is involved and no page is sent anywhere. What comes back is a page
// range the reviewing call can be handed directly.
//
// The previous approach sent the manual's first eight pages to the model as images and asked it
// to read the table of contents and estimate where the section began. That cost a call, and it
// was an estimate — the contents page gives the printed page number, which is not the PDF page
// number once a cover and a divider are bound in front of it. Searching the text layer finds
// the actual page the section starts on, because it looks at the section itself rather than at
// a list of promises about it.

// A CSI MasterFormat number: two digits, two digits, two digits, occasionally a fourth pair.
// Separators vary by publisher — "23 05 93", "23.05.93", "230593" all occur in the same manual.
const { readTextPages: readPages } = require('./pdfTextLayer');

const NUMBER = '(\\d{2})[\\s.\\-]?(\\d{2})[\\s.\\-]?(\\d{2})(?:[\\s.\\-]?(\\d{2}))?';

// "SECTION 23 05 93" — the heading a section actually starts with. This is the reliable signal,
// because the word is there precisely to mark the start.
const HEADING = new RegExp(`SECTION\\s+${NUMBER}`, 'gi');

// The same number with no "SECTION" in front, used only at the very top of a page. Some
// publishers set the number as a running head instead.
const BARE = new RegExp(`^\\s*${NUMBER}\\b`, 'i');

// Any occurrence at all, for counting how many sections a page mentions.
const ANY = new RegExp(NUMBER, 'g');

// Digits only, so "23 05 93", "23.05.93" and "230593" compare equal.
const digitsOf = text => String(text || '').replace(/\D/g, '');

// Telling a contents page from a section.
//
// This is the distinction the whole search rests on, because a contents page names the section
// being looked for, in the right format, near the top — everything a naive match wants. Landing
// on it returns page 2 of the manual instead of page 412, and the review then reads a list of
// titles instead of the requirements.
//
// A count alone is not enough. The first attempt skipped a page naming more than six sections,
// and the contents page of the test manual named exactly six — so it passed, and the section
// was reported as starting on the contents page. Any single threshold has a manual that sits
// just under it.
//
// So three independent signals, any one of which is decisive. Two of them are things a contents
// page cannot avoid being: it says what it is, and it is a list with page numbers on the right.
const CONTENTS_WORDS = /\b(TABLE OF CONTENTS|SECTION INDEX|INDEX OF SECTIONS|LIST OF SECTIONS|CONTENTS)\b/i;
// Dot leaders — the row of dots running to a page number. Two of them make a list.
const LEADERS = /\.{4,}/g;
// A section's own text cites a handful of others at most; a list names them by the dozen.
const MANY_SECTIONS = 4;

function looksLikeContents(text) {
  if (CONTENTS_WORDS.test(text.slice(0, 400))) return true;
  if ((text.match(LEADERS) || []).length >= 2) return true;
  return false;
}

// How much of a page counts as "the top", for a heading set without the word SECTION.
const TOP_CHARS = 240;

// A section this long is a misread heading rather than a genuinely long section, so the range
// is capped and the caller is told it was.
const MAX_SECTION_PAGES = 24;

// Reads the reference a submittal gave and works out what was actually specified.
//
// Returns { number, division, hasSection }. "23 05 93 — Variable Frequency Drives" gives a full
// number; "Division 23" or "23" gives only a division, which is still worth having — it narrows
// a thousand-page manual to one trade.
function parseReference(reference) {
  const text = String(reference || '');

  const full = text.match(new RegExp(NUMBER));
  if (full) {
    const number = digitsOf(full[0]).slice(0, 8);
    // Six digits is a section; a bare two or four is a division or a subsection heading.
    if (number.length >= 6) {
      return { number, division: number.slice(0, 2), hasSection: true };
    }
  }

  const division = text.match(/\bDIVISION\s+(\d{1,2})\b/i) || text.match(/^\s*(\d{2})\b/);
  if (division) {
    return { number: null, division: String(division[1]).padStart(2, '0'), hasSection: false };
  }
  return { number: null, division: null, hasSection: false };
}

// The title printed after a section number, where there is one. Cut at the first thing that
// reads like the start of the body rather than part of the heading.
function titleAfter(text, at) {
  const tail = text.slice(at, at + 120)
    .replace(/^[\s.\-—:]+/, '')
    .split(/\s(?:PART|GENERAL|1\.0|1\.1)\b/i)[0]
    .trim();
  return tail.length >= 3 ? tail.slice(0, 80) : null;
}

// Every section heading in the document, in page order.
//
// Exported because the list itself is useful even when the exact section is not found: a
// submittal that names only a division can be resolved against the handful of sections that
// division actually contains, which is a far smaller question than searching the manual.
function sectionStarts(pages) {
  const starts = [];

  for (const { page, text } of pages) {
    if (!text) continue;

    // A contents page names the section being looked for, in the right format, near the top.
    // It is excluded first, before anything is matched against it.
    if (looksLikeContents(text)) continue;
    const mentions = new Set((text.match(ANY) || []).map(digitsOf));
    if (mentions.size >= MANY_SECTIONS) continue;

    let found = null;

    HEADING.lastIndex = 0;
    const heading = HEADING.exec(text);
    if (heading && heading.index <= TOP_CHARS) {
      found = {
        number: digitsOf(heading[0]).slice(0, 8),
        title: titleAfter(text, heading.index + heading[0].length),
      };
    } else {
      const bare = text.slice(0, TOP_CHARS).match(BARE);
      if (bare) {
        found = {
          number: digitsOf(bare[0]).slice(0, 8),
          title: titleAfter(text, bare[0].length),
        };
      }
    }

    if (!found || found.number.length < 6) continue;

    // The same section runs over several pages and repeats its number in the running head, so
    // only the first page of a run is a start.
    const previous = starts[starts.length - 1];
    if (previous && previous.number === found.number) continue;

    starts.push({
      number: found.number,
      label: found.number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})?/, (_, a, b, c, d) =>
        [a, b, c, d].filter(Boolean).join(' ')),
      title: found.title,
      division: found.number.slice(0, 2),
      page,
    });
  }

  return starts;
}

// Where a section ends: the page before the next section begins.
function rangeFor(starts, index, totalPages) {
  const start = starts[index].page;
  const next = starts[index + 1]?.page;
  const end = next ? next - 1 : totalPages;
  const capped = Math.min(end, start + MAX_SECTION_PAGES - 1);
  return { startPage: start, endPage: Math.max(start, capped), truncated: capped < end };
}

// Locate the section a submittal was made under.
//
// Returns null when the document has no usable text layer at all — a scanned manual — which is
// the one case where searching cannot help and the caller has to fall back to reading it.
// Otherwise returns:
//   { found: true,  startPage, endPage, section, matchedOn: 'section' | 'division' }
//   { found: false, candidates: [...], reason }
// where candidates are the sections of the right division, for a caller that wants to choose
// between them rather than give up.
async function locateSection(buffer, reference) {
  const wanted = parseReference(reference);
  const pages = await readPages(buffer);
  const withText = pages.filter(p => p.text.length > 40).length;

  if (!pages.length || withText === 0) {
    return null;
  }

  const starts = sectionStarts(pages);
  const totalPages = pages.length;

  if (!starts.length) {
    return { found: false, candidates: [], totalPages, reason: 'no section headings were found in this document' };
  }

  // The exact section, which is the case that matters and the common one.
  if (wanted.number) {
    const exact = starts.findIndex(s => s.number === wanted.number
      || s.number.slice(0, 6) === wanted.number.slice(0, 6));
    if (exact >= 0) {
      return {
        found: true, matchedOn: 'section', totalPages,
        section: starts[exact], ...rangeFor(starts, exact, totalPages),
      };
    }
  }

  // Failing that, the division — which still narrows a manual to one trade. A division holding
  // exactly one section answers the question outright.
  const division = wanted.division;
  const inDivision = division ? starts.filter(s => s.division === division) : [];
  if (inDivision.length === 1) {
    const only = starts.indexOf(inDivision[0]);
    return {
      found: true, matchedOn: 'division', totalPages,
      section: starts[only], ...rangeFor(starts, only, totalPages),
    };
  }

  return {
    found: false,
    totalPages,
    candidates: inDivision.length ? inDivision : starts,
    scope: inDivision.length ? `division ${division}` : 'the whole document',
    reason: wanted.number
      ? `section ${wanted.number.replace(/(\d{2})(\d{2})(\d{2}).*/, '$1 $2 $3')} was not found`
      : division ? `division ${division} holds ${inDivision.length} sections`
        : 'the submittal did not name a specification section',
  };
}

module.exports = { locateSection, sectionStarts, readPages, parseReference };
