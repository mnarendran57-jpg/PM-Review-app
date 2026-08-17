const { PDFDocument } = require('pdf-lib');
const { pageCount } = require('./pdfChunk');
const { askForJson } = require('./aiJson');
const { locateSection } = require('./specLocator');
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
// The submittal itself is the other half of the comparison and is never truncated away to
// nothing: a product data sheet with its schedule page missing cannot be reviewed at all.
const MIN_SUBMITTAL_PAGES = 6;
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

// Choosing between the sections of one division.
//
// A submittal that cites only "Division 23" has named a trade, not a requirement, and the
// division may hold twenty sections. But those twenty are already known by name and title from
// the text layer, so the question is not "search the manual" — it is "which of these twenty
// titles governs ductwork insulation", which is a list of a few hundred tokens and no page
// images at all. The cheapest useful call in the app.
const SECTION_CHOICE_TOOL = {
  name: 'choose_governing_section',
  description: 'Choose which specification section governs a submittal, from a list of sections.',
  input_schema: {
    type: 'object',
    properties: {
      sectionNumber: {
        type: 'string',
        description: 'The number of the section that governs, copied exactly from the list. '
          + 'Omit it if none of them plausibly govern this submittal — a wrong section is worse '
          + 'than none, because the review then measures the work against the wrong requirements.',
      },
      alsoRelevant: {
        type: 'array',
        description: 'At most 2 further numbers from the list that also bear on it — a general '
          + 'requirements section on submittal procedures, or a closely related product section. '
          + 'Empty is a good answer.',
        items: { type: 'string' },
      },
      why: { type: 'string', description: 'One short sentence.' },
    },
    required: [],
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

// Which of a division's sections governs this submittal. One small text-only call.
async function chooseFromCandidates({ submittal, candidates, scope }) {
  const list = candidates.slice(0, 40)
    .map(c => `  ${c.label}${c.title ? ` — ${c.title}` : ''}`).join('\n');

  const prompt = `A contractor's submittal has to be checked against the specification section
that governs it, and the submittal did not name that section precisely enough to find it.

THE SUBMITTAL
Number: ${submittal.submittal_number}
Described as: ${submittal.description}
Type: ${submittal.submittal_type || 'not recorded'}
Supplier: ${submittal.vendor || 'not recorded'}
Section cited on the submittal: ${submittal.spec_section || '(none given)'}

THE SECTIONS AVAILABLE IN ${String(scope || 'the specification').toUpperCase()}
${list}

Choose the one section that governs this submittal, with the choose_governing_section tool.
Copy its number exactly as printed above. If none of them plausibly govern it, omit
sectionNumber rather than choosing the closest — the review is only worth having if it is
measured against the right requirements.`;

  const { data } = await askForJson({
    content: [{ type: 'text', text: prompt }],
    tool: SECTION_CHOICE_TOOL,
    maxTokens: 400,
    label: 'submittal section choice',
  });
  return data;
}

// Turns a located page range into the selection the reviewing call is given.
async function takeRange({ doc, located, extra, budget, note }) {
  const wanted = [];
  for (let p = located.startPage; p <= located.endPage; p++) wanted.push(p);
  for (const other of extra) {
    for (let p = other.startPage; p <= other.endPage; p++) wanted.push(p);
  }

  const extracted = await extractPages(doc.buffer, wanted.slice(0, budget));
  if (!extracted) return null;

  const sections = [located, ...extra].map(s => ({
    sectionNumber: s.section.label,
    sectionTitle: s.section.title,
    startPage: s.startPage,
  }));

  return {
    label: doc.label,
    docType: doc.doc_type,
    buffer: extracted.buffer,
    pagesUsed: extracted.pages.length,
    wholeDocument: false,
    sections,
    note: wanted.length > budget
      ? `${note ? `${note} ` : ''}Only the first ${budget} pages of it fitted in one reading.`
      : note || null,
  };
}

// Decides what of one specification document reaches the reviewing call.
//
// The order matters, and it is cheapest-first. A specification is typeset, so the section
// headings are in its text layer and the governing section can be found by searching for its
// number — no call, no guesswork, and the actual PDF page rather than the printed page number
// a contents page would have given. Only when that fails does anything get sent to the model.
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

  // 1. Find the cited section by number, for nothing.
  let located = null;
  try {
    located = await locateSection(doc.buffer, submittal.spec_section);
  } catch (err) {
    console.warn(`[submittal analysis] could not search ${doc.label}: ${err.message}`);
  }

  if (located?.found) {
    const byNumber = await takeRange({
      doc, located, extra: [], budget,
      note: located.matchedOn === 'division'
        ? `Division ${located.section.division} holds one section, ${located.section.label}, `
          + 'which was read in full.'
        : null,
    });
    if (byNumber) return byNumber;
  }

  // 2. The right division but several sections in it. The titles are already known, so one
  //    small text-only call settles which of them governs.
  if (located && !located.found && located.candidates?.length > 1) {
    try {
      const chosen = await chooseFromCandidates({
        submittal, candidates: located.candidates, scope: located.scope,
      });
      const digits = t => String(t || '').replace(/\D/g, '');
      const find = ref => located.candidates.find(c => c.number === digits(ref)
        || c.number.slice(0, 6) === digits(ref).slice(0, 6));

      const main = chosen.sectionNumber && find(chosen.sectionNumber);
      if (main) {
        const all = located.candidates;
        const rangeOf = (entry) => {
          const i = all.indexOf(entry);
          const next = all[i + 1];
          return {
            section: entry,
            startPage: entry.page,
            endPage: Math.min(next ? next.page - 1 : located.totalPages, entry.page + 23),
          };
        };
        const extra = (chosen.alsoRelevant || []).slice(0, 2)
          .map(find).filter(s => s && s !== main).map(rangeOf);

        const byChoice = await takeRange({
          doc, located: rangeOf(main), extra, budget,
          note: `The submittal cited ${submittal.spec_section || 'no section'}, so `
            + `${main.label}${main.title ? ` (${main.title})` : ''} was read as the governing section.`,
        });
        if (byChoice) return byChoice;
      }
    } catch (err) {
      console.warn(`[submittal analysis] could not choose a section in ${doc.label}: ${err.message}`);
    }
  }

  // 3. No text layer to search — a scanned manual. Fall back to reading its contents page.
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

function buildReviewPrompt({ submittal, selections, submittalPages }) {
  const read = selections.map((s) => {
    const what = s.wholeDocument ? 'read in full'
      : s.sections?.length ? `section${s.sections.length === 1 ? '' : 's'} ${s.sections.map(x => x.sectionNumber).filter(Boolean).join(', ')}`
        : `opening ${s.pagesUsed} pages`;
    return `  - ${s.label} (${what})${s.note ? ` — ${s.note}` : ''}`;
  }).join('\n') || '  (none)';

  return `You are advising the owner's project manager on a construction submittal that is about
to go to the architect/engineer (A/E) for review.

The contractor's submittal is attached first, followed by the specification pages that govern
it. Read the submittal against the specification and predict how the A/E will review it.

THE SUBMITTAL
Number: ${submittal.submittal_number}
Description: ${submittal.description}
Specification section: ${submittal.spec_section || 'not recorded'}
Type: ${submittal.submittal_type || 'not recorded'}
Supplier / manufacturer: ${submittal.vendor || 'not recorded'}
${submittal.notes ? `PM's notes: ${submittal.notes}\n` : ''}
The contractor's package is the first ${submittalPages || 'few'} page(s) attached.

SPECIFICATION READ AGAINST IT
${read}

Record your prediction with the report_predicted_review tool.

Rules:
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

  // The contractor's own package comes first and gets its pages before the specification does.
  // A review that read the whole spec and none of the submittal has nothing to compare.
  const packageBlocks = [];
  let submittalPages = 0;
  for (const f of submittalFiles.slice(0, 2)) {
    const total = await pageCount(f.buffer);
    if (total != null && total > MIN_SUBMITTAL_PAGES) {
      const cut = await extractPages(f.buffer, Array.from({ length: MIN_SUBMITTAL_PAGES }, (_, i) => i + 1));
      if (cut) {
        packageBlocks.push(asDocument(cut.buffer));
        submittalPages += cut.pages.length;
        budget -= cut.pages.length;
        selections.push({
          label: `${f.label} (the contractor's package)`, docType: 'submittal',
          pagesUsed: cut.pages.length, wholeDocument: false, sections: [],
          note: `only the first ${MIN_SUBMITTAL_PAGES} pages were read`,
        });
        continue;
      }
    }
    packageBlocks.push(asDocument(f.buffer));
    submittalPages += total || 0;
    budget -= total || 1;
    selections.push({
      label: `${f.label} (the contractor's package)`, docType: 'submittal',
      pagesUsed: total, wholeDocument: true, sections: [], note: null,
    });
  }

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

  if (!packageBlocks.length && !specBlocks.length) {
    const err = new Error('There was nothing to read — attach the submittal, or choose a '
      + 'specification for it to be read against.');
    err.status = 400;
    throw err;
  }

  const prompt = buildReviewPrompt({ submittal, selections, submittalPages });
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
