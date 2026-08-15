const { PDFDocument } = require('pdf-lib');
const { pageCount } = require('./pdfChunk');
const { askForJson, FAST_MODEL } = require('./aiJson');
const { DISCIPLINE_SHEET_HINTS } = require('./rfiLog');

// Predicts how the A/E is likely to answer an RFI, by reading it against the project
// documents the PM selected. Advisory only: it exists so the PM understands the question
// before the answer comes back, and it never touches the log's status.
//
// The hard constraint is that a drawing set is 200+ pages and the account allows about
// 10,000 input tokens a minute, so the set cannot be sent. The way through is to read the
// sheet index first — a few pages that name every sheet — decide from that which sheets the
// question actually turns on, and then read only those. Two small calls instead of one
// impossible one.

// A document at or under this length is read whole: contracts, specification sections and
// sketches have no sheet index to consult, and splitting them would lose the context that
// answers the question.
const SMALL_DOC_PAGES = 12;
// Where a drawing set's index lives. Always the front.
const INDEX_PAGES = 6;
// The ceiling on what reaches the answering call, across every document together. Set by the
// per-minute token allowance rather than by the model's page limit — dense drawing pages are
// far more expensive than prose.
const MAX_ANALYSIS_PAGES = 16;
// Sheets are picked by name but extracted by page number, and that mapping is inferred. A
// page either side covers an index that is off by one, which is common when a set has an
// unnumbered cover.
const PAGE_WINDOW = 1;

// The two shapes this module asks for. Declared as tool schemas rather than described in the
// prompt, because a suggested answer about ductwork is full of inch marks and quoted spec
// notes — see lib/aiJson.js for why that used to break the reply.
const SHEET_PICKER_TOOL = {
  name: 'report_relevant_sheets',
  description: 'Report which sheets of this drawing set bear on the contractor\'s question.',
  input_schema: {
    type: 'object',
    properties: {
      hasSheetIndex: {
        type: 'boolean',
        description: 'True if these pages contain a drawing index or sheet list.',
      },
      totalSheetsListed: {
        type: 'integer',
        description: 'How many sheets the index names. Omit if there is no index.',
      },
      firstSheetPdfPage: {
        type: 'integer',
        description: 'The PDF page number where the first sheet in the index appears.',
      },
      relevantSheets: {
        type: 'array',
        description: 'At most 4 sheets, the ones most likely to actually answer the question.',
        items: {
          type: 'object',
          properties: {
            sheetNumber: { type: 'string', description: 'The sheet number as printed, e.g. M-401.' },
            sheetTitle: { type: 'string', description: 'Its title from the index.' },
            indexPosition: { type: 'integer', description: 'Its 1-based position in the sheet list.' },
            estimatedPdfPage: { type: 'integer', description: 'Which PDF page you expect it on.' },
            why: { type: 'string', description: 'One short sentence on why this sheet bears on the question.' },
          },
          required: ['sheetNumber', 'estimatedPdfPage'],
        },
      },
    },
    required: ['hasSheetIndex', 'relevantSheets'],
  },
};

const ANSWER_TOOL = {
  name: 'report_suggested_answer',
  description: 'Report what the project documents appear to say about the contractor\'s question.',
  input_schema: {
    type: 'object',
    properties: {
      shortAnswer: {
        type: 'string',
        description: 'The answer in ONE sentence, two at the very most. Plain English, no '
          + 'preamble, no hedging phrases like "based on the documents provided". This is the '
          + 'only line most readers will read, so it must carry the actual answer — or say '
          + 'plainly that the documents do not settle it.',
      },
      likelyAnswer: {
        type: 'string',
        description: 'The same answer with the reasoning, in plain English, based only on what '
          + 'these documents show. 2-5 sentences. If the documents do not answer it, say '
          + 'exactly that instead of constructing an answer.',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      confidenceReason: {
        type: 'string',
        description: 'One sentence on why — what you could and could not see.',
      },
      basis: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            document: { type: 'string', description: 'Which document.' },
            sheet: {
              type: 'string',
              description: 'The sheet number printed in the title block of the page you used. '
                + 'Omit if this is not a drawing.',
            },
            shows: {
              type: 'string',
              description: 'What that sheet or clause actually shows, specifically — dimensions, '
                + 'notes, schedule values.',
            },
          },
          required: ['document', 'shows'],
        },
      },
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            between: { type: 'string', description: 'Which documents or sheets disagree.' },
            detail: {
              type: 'string',
              description: 'What the discrepancy is — often the real reason the RFI was raised.',
            },
          },
          required: ['between', 'detail'],
        },
      },
      missingInformation: {
        type: 'string',
        description: 'What you would need in order to answer properly. Omit if the documents '
          + 'were sufficient.',
      },
      questionsForAE: {
        type: 'array',
        description: 'Specific questions the PM should press the A/E on if their answer is vague.',
        items: { type: 'string' },
      },
      costScheduleFlag: {
        type: 'string',
        description: 'Plain English: does this look like it will turn into a change order or a '
          + 'delay claim, and why? Omit if it looks like a straightforward clarification.',
      },
    },
    required: ['shortAnswer', 'likelyAnswer', 'confidence'],
  },
};

const asDocument = buffer => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

// Builds a new PDF from the given 1-based page numbers of the source. Out-of-range and
// duplicate pages are dropped rather than throwing, because the numbers are inferred from a
// sheet index and can legitimately point past the end.
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

// Pass one, for a long document only. Reads the front of the set and decides which sheets
// bear on the question. The model is given the page count so it can work out where a sheet
// sits: sheets appear in the PDF in index order, so if the index names N sheets and the file
// has M pages, the first sheet is usually at page M - N + 1.
async function pickSheets({ doc, rfi, discipline, totalPages }) {
  const front = await extractPages(doc.buffer, Array.from({ length: INDEX_PAGES }, (_, i) => i + 1));
  if (!front) return null;

  const prompt = `You are helping a construction project manager find which drawing sheets
answer a contractor's RFI (Request for Information).

You are looking at the FIRST ${INDEX_PAGES} pages of "${doc.label}" — a document of
${totalPages} pages in total. These front pages normally carry the drawing index or sheet
list, which names every sheet in the set.

The RFI:
Subject: ${rfi.subject}
Question: ${rfi.question || '(no question text was recorded — go by the subject)'}
Discipline: ${discipline} — the sheets to look for usually carry the prefix ${DISCIPLINE_SHEET_HINTS[discipline] || 'any'}.

Report your findings with the report_relevant_sheets tool.

Rules:
- Choose at most 4 sheets, the ones most likely to actually answer the question. Fewer is
  better: a plan sheet and its detail sheet beat six loosely-related ones.
- To work out "estimatedPdfPage": the sheets appear in the PDF in the same order as the
  index. If the index lists N sheets and the whole file is ${totalPages} pages, the first
  sheet is usually at page ${totalPages} - N + 1. Add the sheet's position minus one to that.
  Show that reasoning in "firstSheetPdfPage".
- If these pages have no index, set "hasSheetIndex" to false and return an empty
  "relevantSheets" — do not guess sheet numbers you have not seen.
- Prefer the sheet type that answers the question being asked: a dimension question needs a
  plan, a connection or assembly question needs a detail, a capacity question needs a
  schedule.`;

  const { data: parsed } = await askForJson({
    content: [asDocument(front.buffer), { type: 'text', text: prompt }],
    tool: SHEET_PICKER_TOOL,
    maxTokens: 1500,
    label: 'rfi sheet pick',
    // Finding a section in a contents list is a lookup, not a judgement — and whichever pages
    // it lands on are named back to the PM in the sources, so a bad pick is visible and can be
    // corrected by choosing the document again. Measured against the reviewing model on a real
    // drawing set it produced the same reasoning, the same page arithmetic and the same leading
    // sheets, in a fifth of the time.
    model: FAST_MODEL,
  });
  return {
    hasSheetIndex: parsed.hasSheetIndex === true,
    sheets: Array.isArray(parsed.relevantSheets) ? parsed.relevantSheets : [],
  };
}

// Decides what of one document reaches the answering call.
async function selectFrom({ doc, rfi, discipline, budget }) {
  const totalPages = await pageCount(doc.buffer);

  // Short enough to read whole — a contract or a spec section, where there is no index to
  // consult and the surrounding clauses are the context.
  if (totalPages == null || totalPages <= SMALL_DOC_PAGES) {
    return {
      label: doc.label,
      docType: doc.doc_type,
      buffer: doc.buffer,
      pagesUsed: totalPages,
      wholeDocument: true,
      sheets: [],
      note: null,
    };
  }

  let picked = null;
  try {
    picked = await pickSheets({ doc, rfi, discipline, totalPages });
  } catch (err) {
    // A failed sheet pick shouldn't sink the whole analysis — fall back to the front of the
    // document, which at least carries the index and general notes.
    picked = null;
  }

  const wanted = [];
  const sheets = (picked?.sheets || []).slice(0, 4);
  for (const sheet of sheets) {
    const page = Number(sheet.estimatedPdfPage);
    if (!Number.isInteger(page)) continue;
    for (let p = page - PAGE_WINDOW; p <= page + PAGE_WINDOW; p++) wanted.push(p);
  }

  // Nothing identifiable: read the front of the set rather than nothing at all, and say so,
  // because an answer drawn only from an index deserves to be treated with suspicion.
  if (wanted.length === 0) {
    const front = await extractPages(doc.buffer, Array.from({ length: Math.min(INDEX_PAGES, budget) }, (_, i) => i + 1));
    return front && {
      label: doc.label, docType: doc.doc_type, buffer: front.buffer,
      pagesUsed: front.pages.length, wholeDocument: false, sheets: [],
      note: picked && !picked.hasSheetIndex
        ? 'No drawing index was found in this document, so only its opening pages were read.'
        : 'No sheet in this document could be tied to the question, so only its opening pages were read.',
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
    sheets,
    note: null,
  };
}

function buildAnswerPrompt({ rfi, discipline, selections, extraCount }) {
  const inventory = selections.map((s, i) => {
    const what = s.wholeDocument
      ? 'read in full'
      : s.sheets.length
        ? `sheets ${s.sheets.map(x => x.sheetNumber).join(', ')} (${s.pagesUsed} pages)`
        : `opening ${s.pagesUsed} pages`;
    return `${i + 1}. "${s.label}" — ${what}${s.note ? ` — ${s.note}` : ''}`;
  }).join('\n');

  return `You are an experienced MEP construction project manager reviewing a contractor's
RFI (Request for Information) before the architect/engineer answers it. Your job is to tell
the owner's PM what the documents appear to say, so they understand the question and can
judge the A/E's answer when it arrives.

THE RFI
Number: ${rfi.rfi_number}
Subject: ${rfi.subject}
Question: ${rfi.question || '(no question text was recorded — go by the subject and the attached RFI document)'}
Discipline: ${discipline}

WHAT YOU HAVE BEEN GIVEN
${inventory}${extraCount ? `\n${extraCount} further document(s) attached to this RFI by the PM.` : ''}

Report your reading with the report_suggested_answer tool.

Rules:
- "shortAnswer" is the whole point of this. The PM reads it between meetings. One sentence
  that answers the question, or one sentence saying the documents do not answer it. Never
  restate the question back, never describe your process.
- Ground every statement in something visible on the pages provided. Quote the note, the
  dimension or the schedule value you are relying on. If you cannot point to it, leave it out.
- IMPORTANT: for each entry in "basis", report the sheet number ACTUALLY PRINTED in the title
  block of the page you read. The pages were selected from a drawing index and the selection
  can be off. If a page is not the sheet that was expected, say so plainly in
  "confidenceReason" — a wrong sheet read confidently is worse than no answer.
- "low" confidence is the right answer more often than not. Say so when the sheets provided
  do not settle the question. The PM is using this to prepare, not to decide.
- Do not speculate about what the A/E intended. Report what the documents show.
- Write for a reader who is not a specialist in this trade.`;
}

// Renders the analysis for reading and export. Kept beside the prompt so the two stay in
// step when a field is added.
function renderMarkdown({ rfi, discipline, analysis, sources }) {
  const lines = [];
  lines.push(`# Suggested answer — ${rfi.rfi_number}: ${rfi.subject}`);
  lines.push('');
  lines.push('> This is Coaster\'s reading of the project documents, produced before the A/E replied. It is for the PM\'s understanding only — it is not an answer to the RFI and carries no authority.');
  lines.push('');
  lines.push(`**Discipline:** ${discipline}  `);
  lines.push(`**Confidence:** ${analysis.confidence}${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}`);
  lines.push('');
  if (analysis.shortAnswer) {
    lines.push('## In short');
    lines.push('');
    lines.push(`**${analysis.shortAnswer}**`);
    lines.push('');
  }
  lines.push('## What the documents appear to say');
  lines.push('');
  lines.push(analysis.likelyAnswer || '_No answer could be drawn from the documents provided._');
  lines.push('');

  if (analysis.basis?.length) {
    lines.push('## What that is based on');
    lines.push('');
    for (const b of analysis.basis) {
      lines.push(`- **${b.document}${b.sheet ? ` — ${b.sheet}` : ''}**: ${b.shows}`);
    }
    lines.push('');
  }
  if (analysis.conflicts?.length) {
    lines.push('## Conflicts found between documents');
    lines.push('');
    for (const c of analysis.conflicts) lines.push(`- **${c.between}**: ${c.detail}`);
    lines.push('');
  }
  if (analysis.missingInformation) {
    lines.push('## What is missing');
    lines.push('');
    lines.push(analysis.missingInformation);
    lines.push('');
  }
  if (analysis.questionsForAE?.length) {
    lines.push('## Press the A/E on');
    lines.push('');
    for (const q of analysis.questionsForAE) lines.push(`- ${q}`);
    lines.push('');
  }
  if (analysis.costScheduleFlag) {
    lines.push('## Cost or schedule exposure');
    lines.push('');
    lines.push(analysis.costScheduleFlag);
    lines.push('');
  }
  if (sources?.length) {
    lines.push('## Documents read');
    lines.push('');
    for (const s of sources) {
      const what = s.wholeDocument ? 'read in full'
        : s.sheets?.length ? `sheets ${s.sheets.map(x => x.sheetNumber).join(', ')}`
        : `opening ${s.pagesUsed} pages`;
      lines.push(`- ${s.label} — ${what}${s.note ? ` (${s.note})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// documents: [{ label, doc_type, buffer }] — the Shared Documents the PM selected.
// extraFiles: [{ label, buffer }] — anything attached to this RFI alone.
// fresh: pay for a new reading rather than reusing the stored one. Set when the PM has asked
// for this again, which they only do when they doubted the answer.
async function analyzeRfi({ rfi, discipline, documents = [], extraFiles = [], fresh = false }) {
  if (documents.length === 0 && extraFiles.length === 0) {
    throw new Error('Choose at least one document for the RFI to be read against.');
  }

  // The page budget is shared across documents, so selecting four drawing sets does not
  // quietly send four times as much as selecting one.
  let budget = MAX_ANALYSIS_PAGES;
  const selections = [];
  for (const doc of documents) {
    if (budget <= 0) break;
    const selection = await selectFrom({ doc, rfi, discipline, budget });
    if (!selection) continue;
    selections.push(selection);
    budget -= selection.pagesUsed || 0;
  }

  const content = [];
  for (const s of selections) content.push(asDocument(s.buffer));
  for (const extra of extraFiles) content.push(asDocument(extra.buffer));
  content.push({
    type: 'text',
    text: buildAnswerPrompt({ rfi, discipline, selections, extraCount: extraFiles.length }),
  });

  const { data: parsed } = await askForJson({
    content, tool: ANSWER_TOOL, maxTokens: 3000, label: 'rfi analysis', fresh,
  });

  const analysis = {
    // The one-line version leads every display of this. Falling back to the long answer
    // keeps an older stored analysis, produced before this field existed, readable.
    shortAnswer: parsed.shortAnswer || parsed.likelyAnswer || null,
    likelyAnswer: parsed.likelyAnswer || null,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    confidenceReason: parsed.confidenceReason || null,
    basis: Array.isArray(parsed.basis) ? parsed.basis : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    missingInformation: parsed.missingInformation || null,
    questionsForAE: Array.isArray(parsed.questionsForAE) ? parsed.questionsForAE : [],
    costScheduleFlag: parsed.costScheduleFlag || null,
  };

  // The buffers are dropped: what is worth keeping is the record of what was read, so the PM
  // can judge the answer and re-run against a different selection if it read the wrong sheets.
  const sources = selections.map(s => ({
    label: s.label, docType: s.docType, pagesUsed: s.pagesUsed,
    wholeDocument: s.wholeDocument, sheets: s.sheets, note: s.note,
  }));
  if (extraFiles.length) {
    sources.push(...extraFiles.map(f => ({ label: f.label, docType: 'attachment', wholeDocument: true })));
  }

  return { analysis, sources, markdown: renderMarkdown({ rfi, discipline, analysis, sources }) };
}

module.exports = { analyzeRfi, renderMarkdown, MAX_ANALYSIS_PAGES, SMALL_DOC_PAGES };
