const { PDFDocument } = require('pdf-lib');
const { pageCount } = require('./pdfChunk');
const { askForJson } = require('./aiJson');
const { REVIEW_ACTIONS } = require('./submittalLog');

// Predicts how the A/E is likely to review a submittal, by reading it against the
// specification. Advisory only: it exists so the PM knows what is coming — and what to fix
// before it goes out — and it never touches the log's status.
//
// The same shape as lib/rfiAnalysis.js, and for the same reason, but the question is a
// different one. An RFI asks "what do the documents say?" A submittal asks "does what the
// contractor sent comply with what the documents require?" — which means the two things being
// compared are both in front of us. That makes this the more checkable of the two: a spec
// paragraph and a product data sheet either agree on a value or they do not.
//
// The hard constraint is unchanged. A project manual runs to a thousand pages and the account
// allows about 10,000 input tokens a minute, so the book cannot be sent. The way through is
// the same: read the table of contents first, work out where the section lives, then read only
// that section. Two small calls instead of one impossible one.
//
// What the PM gets out of it, in order of value:
//
//   1. The DEVIATIONS — where the submitted product misses a requirement. This is the whole
//      point: found now, it costs a resubmittal; found after fabrication, it costs the job.
//   2. The likely A/E action, from the same five stamps the A/E will actually use.
//   3. What to fix before it goes out, which is what makes the prediction worth having while
//      the submittal is still on the PM's desk.

const SMALL_DOC_PAGES = 12;
// A project manual's contents live at the front, and so does a spec section's own header.
const INDEX_PAGES = 8;
// The ceiling on what reaches the reviewing call, across every document together. Set by the
// per-minute token allowance rather than the model's page limit.
const MAX_ANALYSIS_PAGES = 18;
// The contractor's package is the thing being reviewed, so ALL of it is read.
//
// It used to be cut to its first 6 pages, under a constant named as a minimum but used as a
// maximum. On a real 28-page water-line package — cover sheet, four pages of the specification
// reprinted, then thirteen product data sheets for pipe, fittings, restraints, valves and a
// hydrant — the cut landed exactly at the end of the spec reprint. Every data sheet in the
// package was invisible, and the review reported them "not provided" with complete confidence
// and a Rejected stamp. A wrong answer delivered confidently is worse than no answer.
//
// A package short enough to send whole is sent whole. A longer one is read in chunks, each
// chunk producing a compact inventory of what is actually in it, and the reviewing call is
// given every chunk's inventory alongside the specification. Length changes how the package is
// read; it never changes whether a page is read at all.
//
// No page is dropped on a guess about its content, either. A near-empty page looks like a tab
// divider and looks identical to a scanned page with no text layer — and dropping the second
// kind is the very mistake being fixed here.
const PACKAGE_DIRECT_PAGES = 12;
const PACKAGE_CHUNK_PAGES = 12;
// A ceiling exists because the per-minute allowance is real, but it is stated in the report
// rather than applied quietly. Silent truncation is what produced the wrong answer above.
const MAX_PACKAGE_CHUNKS = 40;
// Sections are found by name and extracted by page number, and that mapping is inferred.
const PAGE_WINDOW = 1;

const SECTION_PICKER_TOOL = {
  name: 'report_specification_pages',
  description: 'Report where in this document the specification section for a submittal lives.',
  input_schema: {
    type: 'object',
    properties: {
      hasContents: {
        type: 'boolean',
        description: 'True if these pages contain a table of contents or an index of sections.',
      },
      sectionFound: {
        type: 'boolean',
        description: 'True if you located the section the submittal is for.',
      },
      sectionNumber: { type: 'string', description: 'The section number as printed, e.g. "23 05 93".' },
      sectionTitle: { type: 'string', description: 'Its title from the contents.' },
      startPage: {
        type: 'integer',
        description: 'The PDF page the section starts on. Your best estimate is useful; a '
          + 'page either side is read as well.',
      },
      pageCountEstimate: {
        type: 'integer',
        description: 'Roughly how many pages the section runs to. Omit if you cannot tell.',
      },
      alsoRelevant: {
        type: 'array',
        description: 'At most 2 other sections that also govern this submittal — a general '
          + 'requirements section on submittal procedures, or a related products section. '
          + 'Empty is a perfectly good answer.',
        items: {
          type: 'object',
          properties: {
            sectionNumber: { type: 'string' },
            startPage: { type: 'integer' },
            why: { type: 'string', description: 'One short sentence.' },
          },
          required: ['sectionNumber', 'startPage'],
        },
      },
    },
    required: ['hasContents', 'sectionFound'],
  },
};

// What a slice of the contractor's package actually contains. Deliberately a plain listing and
// not a judgement: this call is not asked whether anything complies, only what is on the pages,
// so that the one call that does judge can see the whole package at once instead of a twelfth
// of it. The page numbers make the answer checkable — a PM can turn to the page and look.
const PACKAGE_INVENTORY_TOOL = {
  name: 'report_package_contents',
  description: 'List what these pages of a contractor submittal package actually contain.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Every product, material or component these pages carry data for, one '
          + 'entry each. Include a product even when its data sheet is partial.',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'What it is — "4in PVC water pipe", "gate valve".' },
            manufacturer: { type: 'string' },
            model: { type: 'string', description: 'Model, series or catalogue number as printed.' },
            standards: {
              type: 'array',
              description: 'Standards and specifications the page cites — "AWWA C900", "ASTM D2241", "SDR 21".',
              items: { type: 'string' },
            },
            ratingsAndSizes: {
              type: 'string',
              description: 'Pressure ratings, sizes, classes, dimensions and materials as printed. '
                + 'Copy the figures; they are what the specification gets compared against.',
            },
            page: { type: 'integer', description: 'Page of this document where it appears.' },
          },
          required: ['item'],
        },
      },
      certificates: {
        type: 'array',
        description: 'Certificates, manufacturer letters, test reports, warranties and approval '
          + 'stamps present on these pages, named as printed. Empty if there are none.',
        items: { type: 'string' },
      },
      otherContent: {
        type: 'string',
        description: 'Anything on these pages that is not product data — a cover or transmittal '
          + 'sheet, a reprint of the specification, a tab divider, a drawing. One line.',
      },
    },
    required: ['items'],
  },
};

// Field order is load-bearing here exactly as it is in lib/rfiComparison.js: a tool call is
// generated top to bottom, so the deviations are enumerated BEFORE the predicted action and
// the headline. Asked the other way round the model answers in the headline and then returns
// an empty list behind it — a panel announcing a problem with nothing underneath it.
const REVIEW_TOOL = {
  name: 'report_predicted_review',
  description: 'Report how the A/E is likely to review this submittal, and why.',
  input_schema: {
    type: 'object',
    properties: {
      compliance: {
        type: 'array',
        description: 'Requirements the submitted product or drawing plainly MEETS, one entry '
          + 'each. Short phrases. This matters as much as the deviations: it tells the PM what '
          + 'has already been checked, so a quiet submittal is quiet because it was read.',
        items: { type: 'string' },
      },
      deviations: {
        type: 'array',
        description: 'Every place the submittal departs from what the specification requires, '
          + 'one entry per departure. This is the most valuable field on the call. Only real '
          + 'departures — a different manufacturer offering the same specified performance is '
          + 'not a deviation unless the section names an approved-manufacturer list. An empty '
          + 'list is correct and common when the submittal complies.',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'What the deviation is about, in a few words.' },
            required: { type: 'string', description: 'What the specification requires, quoted or closely paraphrased.' },
            submitted: { type: 'string', description: 'What the submittal actually offers.' },
            severity: {
              type: 'string',
              enum: ['minor', 'material', 'critical'],
              description: '"minor" — the A/E would note it and approve. "material" — likely '
                + 'to draw "Revise and Resubmit". "critical" — a rejection, or something that '
                + 'would not perform.',
            },
            whyItMatters: {
              type: 'string',
              description: 'The practical consequence — what fails to fit, fails to perform, '
                + 'costs more, or delays the job.',
            },
          },
          required: ['item', 'required', 'submitted', 'severity'],
        },
      },
      missingSubmittalItems: {
        type: 'array',
        description: 'Things the specification requires to be SUBMITTED that are not in this '
          + 'package — a certificate, a test report, a sample, a warranty, dimensions. The '
          + 'single most common cause of a resubmittal, and the easiest to fix before sending.',
        items: { type: 'string' },
      },
      fixBeforeSending: {
        type: 'array',
        description: 'What the PM should get corrected before this goes to the A/E, in the '
          + 'order worth doing. Specific and practical. Empty only if the package is ready.',
        items: { type: 'string' },
      },
      coordinationNotes: {
        type: 'string',
        description: 'Anything on this submittal that affects another trade or another '
          + 'submittal — a clearance, a weight, a rough-in, a lead time. Omit if there is none.',
      },
      basis: {
        type: 'array',
        description: 'What this reading is grounded in: the document, the section or sheet, '
          + 'and what it says. A prediction with no basis is an opinion.',
        items: {
          type: 'object',
          properties: {
            document: { type: 'string' },
            section: { type: 'string', description: 'Spec section or sheet number.' },
            requires: { type: 'string', description: 'What it requires, in one line.' },
          },
          required: ['document', 'requires'],
        },
      },
      missingInformation: {
        type: 'string',
        description: 'What you could not read that would have changed this — a section not in '
          + 'the documents supplied, an illegible page, a schedule referenced but not attached. '
          + 'Omit if nothing is missing.',
      },
      // Last on purpose: these summarise the fields above, so they are written once the detail
      // exists rather than in place of it.
      likelyAction: {
        type: 'string',
        enum: REVIEW_ACTIONS,
        description: 'The stamp you expect the A/E to apply, consistent with the deviations '
          + 'you listed. No deviations means "Approved". Minor ones mean "Approved as Noted". '
          + 'Material ones mean "Revise and Resubmit". A product that cannot comply means '
          + '"Rejected".',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: '"high" only when you read the governing section itself and it addresses '
          + 'the point directly. "low" when the section could not be found.',
      },
      confidenceReason: { type: 'string', description: 'One line on what limits it.' },
      headline: {
        type: 'string',
        description: 'ONE sentence for the PM: what the A/E is likely to do with this, and '
          + 'why. No preamble.',
      },
    },
    required: ['deviations', 'likelyAction', 'confidence', 'headline'],
  },
};

const asDocument = buffer => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

// Builds a new PDF from the given 1-based page numbers. Out-of-range and duplicate pages are
// dropped rather than throwing, because the numbers are inferred from a contents page and can
// legitimately point past the end.
async function extractPages(buffer, pageNumbers) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = source.getPageCount();
  const wanted = [...new Set(pageNumbers)]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= total)
    .sort((a, b) => a - b);
  if (wanted.length === 0) return null;

  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, wanted.map(n => n - 1));
  copied.forEach(p => out.addPage(p));
  return { buffer: Buffer.from(await out.save()), pages: wanted };
}

// Pass one, for a long document only. Finds where the governing specification section lives.
async function pickSection({ doc, submittal, totalPages }) {
  const front = await extractPages(doc.buffer, Array.from({ length: INDEX_PAGES }, (_, i) => i + 1));
  if (!front) return null;

  const prompt = `You are helping a construction project manager find the specification section
that governs a submittal.

You are looking at the FIRST ${INDEX_PAGES} pages of "${doc.label}" — a document of
${totalPages} pages in total. These front pages normally carry the table of contents, which
lists every specification section and often the page each one starts on.

THE SUBMITTAL
Number: ${submittal.submittal_number}
Specification section given by the contractor: ${submittal.spec_section || '(none given)'}
Description: ${submittal.description}
Type: ${submittal.submittal_type || 'not recorded'}
Supplier: ${submittal.vendor || 'not recorded'}

Report your findings with the report_specification_pages tool.

Rules:
- If the contents page gives a page number for the section, use it. If it does not, estimate
  from the surrounding sections and say so by giving your best "startPage" anyway — a page
  either side is read as well, so a near miss still works.
- The contractor's stated section number can be wrong or absent. If the description clearly
  belongs to a different section than the one given, report the section you actually believe
  governs it and put its number in "sectionNumber".
- "alsoRelevant" is for a general-requirements section on submittal procedures, or a closely
  related products section. At most 2, and empty is a good answer.
- If these pages carry no contents list, set "hasContents" false and "sectionFound" false.
  Do not invent page numbers you have not seen.`;

  const { data: parsed } = await askForJson({
    content: [asDocument(front.buffer), { type: 'text', text: prompt }],
    tool: SECTION_PICKER_TOOL,
    maxTokens: 1200,
    label: 'submittal section pick',
  });
  return parsed;
}

// Decides what of one specification document reaches the reviewing call.
async function selectFrom({ doc, submittal, budget }) {
  const totalPages = await pageCount(doc.buffer);

  // Short enough to read whole — a single spec section handed over on its own, which is the
  // best case and needs no searching.
  if (totalPages == null || totalPages <= SMALL_DOC_PAGES) {
    return {
      label: doc.label,
      docType: doc.doc_type,
      buffer: doc.buffer,
      pagesUsed: totalPages,
      wholeDocument: true,
      sections: [],
      note: null,
    };
  }

  let picked = null;
  try {
    picked = await pickSection({ doc, submittal, totalPages });
  } catch {
    // A failed section pick should not sink the whole review — fall back to the front of the
    // document, which at least carries the contents and the general requirements.
    picked = null;
  }

  const wanted = [];
  const sections = [];
  const take = (entry, span) => {
    const start = Number(entry.startPage);
    if (!Number.isInteger(start)) return;
    sections.push(entry);
    for (let p = start - PAGE_WINDOW; p < start + span; p++) wanted.push(p);
  };

  if (picked?.sectionFound) {
    // A spec section runs to several pages and the requirement can be on any of them, so the
    // whole section is taken rather than its first page. Capped, because a section that claims
    // to be forty pages long is a section whose start page was misread.
    const span = Math.min(Number(picked.pageCountEstimate) || 6, 10);
    take({ sectionNumber: picked.sectionNumber, sectionTitle: picked.sectionTitle, startPage: picked.startPage }, span);
    for (const other of (picked.alsoRelevant || []).slice(0, 2)) take(other, 3);
  }

  if (wanted.length === 0) {
    const front = await extractPages(doc.buffer, Array.from({ length: Math.min(INDEX_PAGES, budget) }, (_, i) => i + 1));
    return front && {
      label: doc.label, docType: doc.doc_type, buffer: front.buffer,
      pagesUsed: front.pages.length, wholeDocument: false, sections: [],
      note: picked && !picked.hasContents
        ? 'No table of contents was found in this document, so only its opening pages were read.'
        : `Section ${submittal.spec_section || 'for this submittal'} could not be located in this `
          + 'document, so only its opening pages were read.',
    };
  }

  const extracted = await extractPages(doc.buffer, wanted.slice(0, budget));
  if (!extracted) return null;
  return {
    label: doc.label,
    docType: doc.doc_type,
    buffer: extracted.buffer,
    pagesUsed: extracted.pages.length,
    wholeDocument: false,
    sections,
    note: null,
  };
}

// Reads one file of the contractor's package end to end, a chunk at a time, and returns what is
// in it. Every page reaches a call; only how many calls it takes varies with length.
// A data-sheet-dense chunk can list more than fits in one answer. Twelve pages of Westlake and
// Star Pipe tables ran out of room at 2,000 tokens and the whole chunk was thrown away — the
// same blindness this file exists to remove, arriving by a different door. So a truncated answer
// halves the slice and reads both halves rather than giving up on either.
const INVENTORY_MAX_TOKENS = 4000;
const truncated = err => !!err?.truncated || /cut off before it finished/i.test(err?.message || '');

async function inventoryPackage({ file, submittal, totalPages, startChunk }) {
  const inventory = { items: [], certificates: [], notes: [] };
  let chunks = 0;

  const readSlice = async (first, last) => {
    if (first > last) return;
    const slice = await extractPages(
      file.buffer, Array.from({ length: last - first + 1 }, (_, i) => first + i));
    if (!slice) return;
    chunks += 1;

    const prompt = `You are cataloguing part of a contractor's submittal package so that it can be
reviewed against the specification.

These are pages ${first} to ${last} of "${file.label}" — a package of ${totalPages} pages for
submittal ${submittal.submittal_number}: ${submittal.description}.

List what is on THESE pages with the report_package_contents tool.

Rules:
- You are not judging compliance and not comparing anything to a specification. Only report
  what is here. Something else reads the whole package at once and does the judging.
- Copy figures as printed — pressure ratings, classes, SDR and DR numbers, sizes, standards.
  Those exact values are what the specification is measured against later, so a paraphrase
  loses the answer.
- Number the pages you were given 1, 2, 3 ... in the order they appear here. They are
  renumbered against the whole package afterwards, so count from 1 every time.
- A cover sheet, a transmittal, a tab divider or a reprint of the specification is not a
  product: put it in "otherContent" and leave "items" for actual products.
- An empty "items" list is the right answer for pages that carry no product data.`;

    try {
      const { data } = await askForJson({
        content: [asDocument(slice.buffer), { type: 'text', text: prompt }],
        tool: PACKAGE_INVENTORY_TOOL,
        maxTokens: INVENTORY_MAX_TOKENS,
        label: `submittal package pages ${first}-${last}`,
      });
      for (const it of (data.items || [])) {
        if (!it || !it.item) continue;
        // The model counts from 1 within its own slice; the PM counts from 1 within the package.
        // Left unconverted, a hydrant on page 26 was reported as being on page 2.
        const within = Number(it.page);
        const page = Number.isInteger(within) && within >= 1 && within <= (last - first + 1)
          ? first + within - 1
          : first;
        inventory.items.push({ ...it, page });
      }
      for (const c of (data.certificates || [])) if (c) inventory.certificates.push(c);
      if (data.otherContent) inventory.notes.push(`pp. ${first}-${last}: ${data.otherContent}`);
    } catch (err) {
      if (truncated(err) && last > first) {
        const mid = Math.floor((first + last) / 2);
        await readSlice(first, mid);
        await readSlice(mid + 1, last);
        return;
      }
      // One unreadable page must not cost the rest of the package. It is recorded so the review
      // can say what it did not see, rather than assuming it saw everything.
      console.warn(`[submittal analysis] pages ${first}-${last} of ${file.label} could not be read: ${err.message}`);
      inventory.notes.push(`pp. ${first}-${last}: could not be read (${err.message}).`);
    }
  };

  for (let first = 1; first <= totalPages; first += PACKAGE_CHUNK_PAGES) {
    if (startChunk + chunks >= MAX_PACKAGE_CHUNKS) {
      inventory.stoppedAt = first - 1;
      break;
    }
    await readSlice(first, Math.min(first + PACKAGE_CHUNK_PAGES - 1, totalPages));
  }

  inventory.items.sort((a, b) => a.page - b.page);
  return { inventory, chunks };
}

// The inventory as the reviewing call sees it. Plain text, because it is evidence handed to the
// model rather than a schema it fills in.
// A page that does not print a manufacturer draws "not specified" or "<UNKNOWN>" out of the
// model, and passing that on reads as though the package named a product called Not Specified.
// Saying nothing is the honest rendering of nothing.
const BLANKS = /^(<?\s*unknown\s*>?|not\s+(specified|listed|given|provided|stated)|unspecified|none|n\/?a|-+)$/i;
const said = v => (typeof v === 'string' && v.trim() && !BLANKS.test(v.trim()) ? v.trim() : null);

function renderInventory(entries) {
  const L = [];
  for (const { label, totalPages, inventory } of entries) {
    L.push(`"${label}" — ${totalPages} pages, all of them read.`);
    if (inventory.items.length) {
      L.push('  Products with data in the package:');
      for (const it of inventory.items) {
        const bits = [said(it.manufacturer), said(it.model)].filter(Boolean).join(' ');
        const std = (it.standards || []).map(said).filter(Boolean).join(', ');
        const ratings = said(it.ratingsAndSizes);
        L.push(`    - p.${it.page} ${it.item}${bits ? ` — ${bits}` : ''}`
          + `${std ? ` [${std}]` : ''}${ratings ? ` — ${ratings}` : ''}`);
      }
    } else {
      L.push('  No product data was found anywhere in this file.');
    }
    if (inventory.certificates.length) {
      L.push(`  Certificates and letters present: ${inventory.certificates.join('; ')}`);
    } else {
      L.push('  No certificates, manufacturer letters or test reports were found.');
    }
    for (const n of inventory.notes) L.push(`  ${n}`);
    if (inventory.stoppedAt) {
      L.push(`  NOT READ: pages after ${inventory.stoppedAt} — the package exceeded what one `
        + 'review can read in a single pass.');
    }
  }
  return L.join('\n');
}

function buildReviewPrompt({ submittal, selections, submittalPages, inventoryText }) {
  const read = selections.map((s) => {
    const what = s.wholeDocument ? 'read in full'
      : s.sections?.length ? `section${s.sections.length === 1 ? '' : 's'} ${s.sections.map(x => x.sectionNumber).filter(Boolean).join(', ')}`
        : `opening ${s.pagesUsed} pages`;
    return `  - ${s.label} (${what})${s.note ? ` — ${s.note}` : ''}`;
  }).join('\n') || '  (none)';

  // Two ways the package reaches this call: attached as pages when it is short enough, or as a
  // catalogue of its whole contents when it is not. The prompt has to say which, because
  // "not in the attachments" and "not in the package" are different statements and only the
  // second one belongs in a report.
  const packageSection = inventoryText
    ? `WHAT IS IN THE CONTRACTOR'S PACKAGE
The package was too long to attach whole, so every page of it was read and catalogued first.
This is the complete catalogue — treat it as the package itself:

${inventoryText}

Only the specification pages are attached below.`
    : `The contractor's package is the first ${submittalPages || 'few'} page(s) attached, in full.`;

  return `You are advising the owner's project manager on a construction submittal that is about
to go to the architect/engineer (A/E) for review.

Read the submittal against the specification and predict how the A/E will review it.

THE SUBMITTAL
Number: ${submittal.submittal_number}
Description: ${submittal.description}
Specification section: ${submittal.spec_section || 'not recorded'}
Type: ${submittal.submittal_type || 'not recorded'}
Supplier / manufacturer: ${submittal.vendor || 'not recorded'}
${submittal.notes ? `PM's notes: ${submittal.notes}\n` : ''}
${packageSection}

SPECIFICATION READ AGAINST IT
${read}

Record your prediction with the report_predicted_review tool.

Rules:
- What you were given IS the package, all of it. Do not report a product data sheet, a cut
  sheet or a certificate as missing when it is listed above — that is the single most damaging
  mistake this review can make, because it sends the PM back to a contractor who already
  supplied the thing. If something genuinely is absent, say so; if you are unsure whether it
  is absent or merely unclear, say that instead.
- The value of this is the DEVIATIONS, and they are worth more the earlier they are found. A
  missing certificate found today costs an email; found after the A/E stamps it, it costs a
  resubmittal and three weeks. List every real departure, with the requirement and what was
  actually submitted, so the PM can hand it straight to the contractor.
- Quote or closely paraphrase the requirement. "The specification requires 16 gauge" is
  actionable; "does not meet the specification" is not.
- Do not invent requirements. If the section you needed was not in the pages you were given,
  say so in "missingInformation" and set confidence to "low". A confident review of a
  specification nobody read is the one outcome that would make this feature harmful.
- An equal product from a different manufacturer is NOT a deviation unless the section names
  approved manufacturers or requires prior approval of substitutions. Say which it is.
- "missingSubmittalItems" is the most commonly useful field. Specifications list what must be
  submitted — certificates, test reports, samples, warranties, dimensioned drawings — and
  packages routinely arrive without them.
- The likely action must follow from what you listed. Do not predict "Revise and Resubmit"
  with no material deviation behind it, and do not predict "Approved" while listing one.
- Write for a project manager who is not a specialist in this trade. No jargon that the
  specification did not use first.
- This is advisory. The A/E decides, and they may have information you do not.`;
}

function renderMarkdown({ submittal, analysis, sources }) {
  const L = [];
  L.push(`# Predicted review — ${submittal.submittal_number}: ${submittal.description}`);
  L.push('');
  L.push('> What the specification appears to require, read against what the contractor '
    + 'submitted, before it goes to the A/E. Advisory: the A/E decides.');
  L.push('');
  L.push(`**Likely A/E action:** ${analysis.likelyAction}  `);
  L.push(`**Confidence:** ${analysis.confidence}${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}`);
  L.push('');
  L.push(analysis.headline || '');
  L.push('');

  if (analysis.deviations?.length) {
    L.push('## Where it departs from the specification');
    L.push('');
    for (const d of analysis.deviations) {
      L.push(`### ${d.item} — ${d.severity}`);
      L.push('');
      L.push(`- **The specification requires:** ${d.required}`);
      L.push(`- **The submittal offers:** ${d.submitted}`);
      if (d.whyItMatters) L.push(`- **Why it matters:** ${d.whyItMatters}`);
      L.push('');
    }
  } else {
    L.push('_No departures from the specification were found in what was read._');
    L.push('');
  }

  if (analysis.missingSubmittalItems?.length) {
    L.push('## Required but not in this package');
    L.push('');
    for (const m of analysis.missingSubmittalItems) L.push(`- ${m}`);
    L.push('');
  }
  if (analysis.fixBeforeSending?.length) {
    L.push('## Fix before sending');
    L.push('');
    for (const f of analysis.fixBeforeSending) L.push(`- ${f}`);
    L.push('');
  }
  if (analysis.compliance?.length) {
    L.push('## Checked and compliant');
    L.push('');
    for (const c of analysis.compliance) L.push(`- ${c}`);
    L.push('');
  }
  if (analysis.coordinationNotes) {
    L.push('## Coordination');
    L.push('');
    L.push(analysis.coordinationNotes);
    L.push('');
  }
  if (analysis.basis?.length) {
    L.push('## Read from');
    L.push('');
    for (const b of analysis.basis) {
      L.push(`- **${b.document}${b.section ? ` — ${b.section}` : ''}:** ${b.requires}`);
    }
    L.push('');
  }
  if (analysis.missingInformation) {
    L.push('## Not read');
    L.push('');
    L.push(analysis.missingInformation);
    L.push('');
  }

  L.push('## What was read');
  L.push('');
  for (const s of sources) {
    const what = s.wholeDocument ? 'read in full'
      : s.sections?.length ? `sections ${s.sections.map(x => x.sectionNumber).filter(Boolean).join(', ')}`
        : `${s.pagesUsed} pages`;
    L.push(`- ${s.label} — ${what}${s.note ? ` (${s.note})` : ''}`);
  }
  return L.join('\n');
}

// A predicted action that contradicts the deviations listed is the one answer this must not
// pass on: the PM would be told to expect a resubmittal with nothing to hand the contractor,
// or told it will be approved while a critical deviation sits underneath. It happens
// occasionally whatever the prompt says, so it is checked rather than hoped for.
const NEEDS_FIX = new Set(['Revise and Resubmit', 'Rejected']);
const isSelfContradictory = (d) => {
  const deviations = Array.isArray(d?.deviations) ? d.deviations : [];
  const serious = deviations.some(x => x.severity === 'material' || x.severity === 'critical');
  if (NEEDS_FIX.has(d?.likelyAction) && !deviations.length) return true;
  return d?.likelyAction === 'Approved' && serious;
};

const CORRECTION = `Your answer's predicted action does not match the deviations you listed.
Call the tool again and make them agree: either list each departure in "deviations" — with what
the specification requires, what was submitted, and how serious it is — or set "likelyAction"
to the stamp those deviations actually justify. "Approved" means nothing material was found;
"Revise and Resubmit" and "Rejected" both require at least one deviation behind them.`;

// documents: [{ label, doc_type, buffer }] — the project's shared documents to read against.
// submittalFiles: [{ label, buffer }] — the contractor's package. Sent first and never dropped.
async function analyzeSubmittal({ submittal, documents = [], submittalFiles = [] }) {
  const selections = [];
  let budget = MAX_ANALYSIS_PAGES;

  // The contractor's own package comes first and is read end to end. A short one is attached
  // whole; a long one is catalogued chunk by chunk and the catalogue stands in for it. Either
  // way every page is read — what changes with length is the route, not the coverage.
  const packageBlocks = [];
  const inventories = [];
  let submittalPages = 0;
  let chunksSpent = 0;

  for (const f of submittalFiles.slice(0, 2)) {
    const total = await pageCount(f.buffer);

    if (total == null || total <= PACKAGE_DIRECT_PAGES) {
      packageBlocks.push(asDocument(f.buffer));
      submittalPages += total || 0;
      budget -= total || 1;
      selections.push({
        label: `${f.label} (the contractor's package)`, docType: 'submittal',
        pagesUsed: total, wholeDocument: true, sections: [], note: null,
      });
      continue;
    }

    const { inventory, chunks } = await inventoryPackage({
      file: f, submittal, totalPages: total, startChunk: chunksSpent,
    });
    chunksSpent += chunks;
    inventories.push({ label: f.label, totalPages: total, inventory });
    selections.push({
      label: `${f.label} (the contractor's package)`, docType: 'submittal',
      pagesUsed: inventory.stoppedAt || total, wholeDocument: !inventory.stoppedAt, sections: [],
      note: inventory.stoppedAt
        ? `pages 1-${inventory.stoppedAt} of ${total} were read and catalogued; the rest could `
          + 'not be reached in one pass'
        : `all ${total} pages were read and catalogued (${chunks} passes), and the catalogue was `
          + 'read against the specification',
    });
  }

  const inventoryText = inventories.length ? renderInventory(inventories) : null;

  const specBlocks = [];
  for (const doc of documents) {
    if (budget <= 0) break;
    let selection = null;
    try {
      selection = await selectFrom({ doc, submittal, budget });
    } catch (err) {
      console.warn(`[submittal analysis] could not read ${doc.label}: ${err.message}`);
    }
    if (!selection) continue;
    budget -= selection.pagesUsed || 1;
    specBlocks.push(asDocument(selection.buffer));
    const { buffer, ...rest } = selection;
    selections.push(rest);
  }

  if (!packageBlocks.length && !inventories.length && !specBlocks.length) {
    const err = new Error('There was nothing to read — attach the submittal, or choose a '
      + 'specification for it to be read against.');
    err.status = 400;
    throw err;
  }

  const prompt = buildReviewPrompt({ submittal, selections, submittalPages, inventoryText });
  const ask = blocks => askForJson({
    content: blocks,
    tool: REVIEW_TOOL,
    maxTokens: 3000,
    label: 'submittal review prediction',
  });

  const content = [...packageBlocks, ...specBlocks, { type: 'text', text: prompt }];
  let { data } = await ask(content);
  if (isSelfContradictory(data)) {
    console.warn('[submittal analysis] predicted action disagreed with the deviations — asking again');
    try {
      const { data: second } = await ask([...content, { type: 'text', text: CORRECTION }]);
      if (!isSelfContradictory(second)) data = second;
    } catch (err) {
      console.warn(`[submittal analysis] corrective pass failed, keeping the first: ${err.message}`);
    }
  }

  const analysis = {
    likelyAction: REVIEW_ACTIONS.includes(data.likelyAction) ? data.likelyAction : 'Revise and Resubmit',
    confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'low',
    confidenceReason: data.confidenceReason || null,
    headline: data.headline || null,
    deviations: Array.isArray(data.deviations) ? data.deviations.filter(d => d && d.item) : [],
    missingSubmittalItems: Array.isArray(data.missingSubmittalItems) ? data.missingSubmittalItems.filter(Boolean) : [],
    fixBeforeSending: Array.isArray(data.fixBeforeSending) ? data.fixBeforeSending.filter(Boolean) : [],
    compliance: Array.isArray(data.compliance) ? data.compliance.filter(Boolean) : [],
    coordinationNotes: data.coordinationNotes || null,
    basis: Array.isArray(data.basis) ? data.basis.filter(b => b && b.document) : [],
    missingInformation: data.missingInformation || null,
  };

  return { analysis, sources: selections, markdown: renderMarkdown({ submittal, analysis, sources: selections }) };
}

module.exports = { analyzeSubmittal, renderMarkdown, MAX_ANALYSIS_PAGES, SMALL_DOC_PAGES };
