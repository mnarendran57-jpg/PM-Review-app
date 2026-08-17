const { PDFDocument } = require('pdf-lib');
const { pageCount } = require('./pdfChunk');
const { askForJson } = require('./aiJson');
const { locateSheets, sheetsNamedIn } = require('./sheetLocator');
const { DISCIPLINE_SHEET_HINTS } = require('./rfiLog');

// Reads a contractor's RFI against the project documents the PM selected, and reports whether
// those documents already answer it. Advisory only: it exists so the PM knows what they are
// holding before the A/E answers, and it never touches the log's status.
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

// Choosing between sheets that are already known by name.
//
// Once the index has been read out of the text layer, the question is no longer "search a
// 200-sheet set" but "which of these titles answers a duct clearance question" — a list of a
// few hundred tokens and no page images at all. The old route sent the front of the set as
// images to have the index read aloud, then asked for page numbers to be inferred from it; this
// asks only the part that needs judgement.
const SHEET_CHOICE_TOOL = {
  name: 'choose_relevant_sheets',
  description: 'Choose which drawing sheets answer a contractor\'s question, from a list of sheets.',
  input_schema: {
    type: 'object',
    properties: {
      sheetNumbers: {
        type: 'array',
        description: 'At most 4 sheet numbers, copied exactly from the list, most useful first. '
          + 'Fewer is better: a plan and its detail beat six loosely related sheets. Empty if '
          + 'none of them bear on the question — a wrong sheet produces a confident answer '
          + 'drawn from the wrong drawing.',
        items: { type: 'string' },
      },
      why: { type: 'string', description: 'One short sentence on what you expect to find there.' },
    },
    required: ['sheetNumbers'],
  },
};

// Whether the RFI needed to be asked at all.
//
// This used to produce a suggested answer with its reasoning, its grounds, its conflicts, what
// was missing and what to press the A/E on — six blocks of prose, of which the PM read the first
// line. The question they actually have on the day an RFI lands is narrower and harder: does the
// contract answer this already, or does it not? An RFI whose answer is on the drawing costs the
// A/E a fee and the job a week for nothing. An RFI the documents genuinely do not settle is a gap
// in the design, and the gap is what a change order gets written against later.
//
// So the output is one comparison — what the documents show against what the RFI asks — and each
// row says which of those two it is.
const RFI_STATUSES = ['answered', 'unclear', 'missing', 'conflict', 'mistaken'];

// Four ways to read the RFI as a whole, and the PM does something different about each.
const RFI_VERDICTS = ['not_needed', 'partly_justified', 'justified', 'cannot_tell'];

// Field order is load-bearing. A tool call is generated top to bottom, so when the verdict came
// first the model settled the whole question in it and then returned an empty table behind it.
// Enumerating the rows first and judging last means the verdict describes work already done.
const VALIDITY_TOOL = {
  name: 'report_rfi_against_documents',
  description: "Compare what the project documents show with what the contractor's RFI asks, and "
    + 'say whether the RFI needed to be asked.',
  input_schema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description: 'One row per thing the RFI actually asks, most consequential first. Together '
          + 'these are the whole analysis. Most RFIs raise one or two points; an RFI with six rows '
          + 'usually means the rows are being padded with things the PM would not act on.',
        items: {
          type: 'object',
          properties: {
            point: {
              type: 'string',
              description: 'What it is about: a noun phrase of 2 to 6 words, never a sentence. '
                + '"Duct clearance at beam", "VAV box size", "Ceiling height in corridor 2".',
            },
            documentsShow: {
              type: 'string',
              description: 'What the documents actually show on this point, in AT MOST 12 words — '
                + 'the value or the requirement itself, not a description of it. "10 feet 6 inches '
                + 'to underside, 6 inch clearance required" beats "the drawings indicate a '
                + 'clearance requirement". Write "Silent" where they do not address it at all, and '
                + '"Not on the sheets read" where the governing sheet was never reached.',
            },
            rfiAsks: {
              type: 'string',
              description: "What the RFI asks or asserts on this point, in AT MOST 12 words. The "
                + "contractor's own words where they are short enough to use.",
            },
            where: {
              type: 'string',
              description: 'Where in the documents you saw it: the sheet number PRINTED IN THE '
                + 'TITLE BLOCK of the page you read, or the specification clause. The pages were '
                + 'selected by searching for sheet numbers and the selection can be off, so report '
                + 'the sheet you actually saw, not the one you expected. Omit on a "Silent" row.',
            },
            status: {
              type: 'string',
              enum: RFI_STATUSES,
              description: '"answered" — the documents already settle this plainly; the RFI did '
                + 'not need to be raised for it. '
                + '"unclear" — the documents touch on it but are genuinely open to more than one '
                + 'reading, so it was fair to ask. '
                + '"missing" — the documents are silent; this is a gap in the design and usually '
                + 'the row that turns into a change order. '
                + '"conflict" — two documents or sheets disagree with each other. This is the '
                + 'strongest kind of RFI and often the real reason it was raised. '
                + '"mistaken" — the RFI has misread the documents: it asserts something they do '
                + 'not say, or asks about a condition that is not what is drawn.',
            },
          },
          required: ['point', 'documentsShow', 'rfiAsks', 'status'],
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      confidenceReason: {
        type: 'string',
        description: 'One short sentence on what you could and could not see. Say plainly if a '
          + 'page turned out not to be the sheet that was expected — the whole comparison is worth '
          + 'nothing if it was read off the wrong drawing.',
      },
      // Last on purpose: both of these summarise the rows above, so they are written once the
      // detail exists rather than in place of it.
      verdict: {
        type: 'string',
        enum: RFI_VERDICTS,
        description: 'Your overall read, and it must be consistent with the rows above. '
          + '"not_needed" — the documents answer every point; this RFI asks what the contract '
          + 'already says. '
          + '"partly_justified" — some of it is answered in the documents and some of it is not. '
          + '"justified" — the documents do not settle it; the RFI had to be asked. '
          + '"cannot_tell" — the sheets that govern this were not among the ones read, so the '
          + 'question cannot be judged. Use this rather than guessing.',
      },
      headline: {
        type: 'string',
        description: 'ONE sentence, at most 25 words, saying something the table does not repeat: '
          + 'what this RFI amounts to for the PM. No preamble, no restating the question.',
      },
    },
    required: ['points', 'confidence', 'verdict', 'headline'],
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
  });
  return {
    hasSheetIndex: parsed.hasSheetIndex === true,
    sheets: Array.isArray(parsed.relevantSheets) ? parsed.relevantSheets : [],
  };
}

// Decides what of one document reaches the answering call.
// Which of a set's sheets bear on the question. One small text-only call.
async function chooseSheets({ rfi, discipline, sheets }) {
  const list = sheets.slice(0, 120)
    .map(s => `  ${s.label}${s.title ? ` — ${s.title}` : ''}`).join('\n');

  const prompt = `A contractor has raised an RFI and it has to be answered from the drawings.
The set's own index is below, so the sheets are already known by name — the question is which of
them the answer is on.

THE RFI
Subject: ${rfi.subject}
Question: ${rfi.question || '(no question text was recorded — go by the subject)'}
Discipline: ${discipline} — sheets for this trade usually carry the prefix ${DISCIPLINE_SHEET_HINTS[discipline] || 'any'}.

THE SHEETS IN THIS SET
${list}

Choose with the choose_relevant_sheets tool. Prefer the sheet type that answers the question
being asked: a dimension question needs a plan, a connection or assembly question needs a
detail, a capacity question needs a schedule. Copy the numbers exactly as printed above.`;

  const { data } = await askForJson({
    content: [{ type: 'text', text: prompt }],
    tool: SHEET_CHOICE_TOOL,
    maxTokens: 400,
    label: 'rfi sheet choice',
  });
  return Array.isArray(data.sheetNumbers) ? data.sheetNumbers : [];
}

// Decides what of one document reaches the answering call.
//
// Cheapest first, and the first two steps cost nothing. A drawing set is drafted, so every
// sheet's number is in its own title block and therefore in the text layer: the map from sheet
// number to PDF page is a search. That map is exact, where inferring a page from an index's
// printed position is a guess that a bound cover sheet quietly breaks.
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

  let located = null;
  try {
    located = await locateSheets(doc.buffer);
  } catch (err) {
    console.warn(`[rfi analysis] could not search ${doc.label}: ${err.message}`);
  }

  if (located?.index?.length) {
    const known = new Set(located.index.map(s => s.key));
    const byLabel = new Map(located.index.map(s => [s.key, s]));
    const take = [];

    // 1. Sheets the RFI names itself. A contractor who writes "see M-401" has already done
    //    the locating, and there is nothing to pay for or to get wrong.
    for (const s of sheetsNamedIn(`${rfi.subject || ''} ${rfi.question || ''}`, known)) {
      if (located.pageOf.has(s.key)) take.push(byLabel.get(s.key));
    }

    // 2. Otherwise the titles are known, so one small call chooses among them.
    if (!take.length) {
      try {
        const refs = await chooseSheets({ rfi, discipline, sheets: located.index });
        for (const ref of refs) {
          // A returned number may carry its title or a stray bracket, so it is reduced to the
          // same shape the index keys use rather than compared literally.
          const key = String(ref).toUpperCase().replace(/[^A-Z0-9.]/g, '');
          // A returned "M-502 — VAV Box Schedules" reduces to a key with the title stuck on the
          // end, so a returned key that STARTS WITH an index key is that sheet. The reverse is
          // not safe and is deliberately not allowed: "M-5" is a prefix of M-501, M-502 and
          // M-503, and resolving it to whichever comes first would read a confidently wrong
          // drawing. An unmatched sheet is reported; a mismatched one is not detectable.
          const hit = byLabel.get(key) || located.index.find(s => key.startsWith(s.key));
          if (hit && located.pageOf.has(hit.key) && !take.includes(hit)) take.push(hit);
        }
        // Worth saying out loud: sheets were chosen and none of them could be tied to a page,
        // which sends the whole read down the expensive fallback for no visible reason.
        if (refs.length && !take.length) {
          console.warn(`[rfi analysis] chose ${JSON.stringify(refs)} in ${doc.label} but matched `
            + `none of ${located.index.length} indexed sheets`);
        }
      } catch (err) {
        console.warn(`[rfi analysis] could not choose sheets in ${doc.label}: ${err.message}`);
      }
    }

    if (take.length) {
      const chosen = take.slice(0, 4);
      const wanted = [];
      for (const s of chosen) {
        const page = located.pageOf.get(s.key);
        // A window either side only where the page was inferred from index order rather than
        // found on the sheet itself. An exact hit needs no hedging.
        const slack = located.positional ? PAGE_WINDOW : 0;
        for (let p = page - slack; p <= page + slack; p++) wanted.push(p);
      }
      const extracted = await extractPages(doc.buffer, wanted.slice(0, budget));
      if (extracted) {
        return {
          label: doc.label,
          docType: doc.doc_type,
          buffer: extracted.buffer,
          pagesUsed: extracted.pages.length,
          wholeDocument: false,
          sheets: chosen.map(s => ({
            sheetNumber: s.label, sheetTitle: s.title,
            estimatedPdfPage: located.pageOf.get(s.key),
          })),
          note: located.positional
            ? 'Sheet pages were inferred from the index order, so a page either side of each '
              + 'was read as well.'
            : null,
        };
      }
    }
  }

  // 3. No text layer to search — a scanned set. Fall back to reading the index as images.
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

  return `You are an experienced MEP construction project manager, acting for the OWNER, reading a
contractor's RFI (Request for Information) against the project documents before the
architect/engineer answers it. The owner pays for every RFI twice — the A/E's fee to answer it and
the time the work waits — so the PM's first question is not "what is the answer" but "did the
contract already answer this?"

THE RFI
Number: ${rfi.rfi_number}
Subject: ${rfi.subject}
Question: ${rfi.question || '(no question text was recorded — go by the subject and the attached RFI document)'}
Discipline: ${discipline}

THE DOCUMENTS YOU HAVE BEEN GIVEN
${inventory}${extraCount ? `\n${extraCount} further document(s) attached to this RFI by the PM.` : ''}

Report your comparison as a TABLE, with the report_rfi_against_documents tool. Every row is one
point the RFI raises; the two columns are what the documents show and what the RFI asks.

Rules:
- Judge the RFI, do not answer it. The output is not an answer the PM can send — it is whether the
  question needed asking, and what the documents say about it.
- Length is a feature. A cell over a dozen words stops being scannable and becomes something to
  read, which defeats the table. Give the value, not a description of the value.
- Ground every row in something visible on the pages provided. If you cannot point to the note,
  the dimension or the schedule value, the row's status is "missing" or "cannot_tell" — never
  construct what the documents "probably" intended.
- IMPORTANT: in "where", report the sheet number ACTUALLY PRINTED in the title block of the page
  you read, not the one you expected to be given. The pages were selected by searching the set for
  sheet numbers and that selection can be off. A comparison read off the wrong drawing is worse
  than no comparison, so if a page is not the sheet expected, say so in "confidenceReason".
- Be fair, and be direct. If the answer is plainly on the drawing, say so — that is worth real
  money to the owner and it is the finding they are paying you for. But an RFI is not frivolous
  merely because an expert could have worked it out: "answered" means the documents settle it
  plainly, not that the answer is derivable by someone who knows the trade.
- A "missing" or "conflict" row is the most valuable thing on this page. Work the contract does not
  cover is work somebody has to pay for, and the PM needs to know on the day the RFI arrives, not
  when the change order lands.
- "cannot_tell" is the honest verdict more often than it is comfortable. Say it when the sheets
  provided do not govern the question, rather than judging the RFI on drawings that do not bear
  on it.
- Do not speculate about what the A/E intended, and do not apportion blame. Report what the
  documents show and what the RFI asks; whose fault that is, is the PM's call with information you
  do not have.
- Write for a reader who is not a specialist in this trade.`;
}

// How each row and each verdict reads in a document, where colour cannot carry the meaning.
const RFI_STATUS_LABEL = {
  answered: 'Already in the documents',
  unclear: 'Documents are open to reading',
  missing: 'Documents are silent',
  conflict: 'Documents disagree',
  mistaken: 'RFI has it wrong',
};

const RFI_VERDICT_LABEL = {
  not_needed: 'The documents already answer this RFI',
  partly_justified: 'Partly answered in the documents already',
  justified: 'The documents do not settle this — the RFI had to be asked',
  cannot_tell: 'Cannot be judged from the sheets that were read',
};

// A pipe inside a cell would end the column early and shift every value after it one place left,
// so a duct noted as "24x12 | 30x8 oval" would silently corrupt its own row.
const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';

// Renders the analysis for reading and export. Kept beside the prompt so the two stay in
// step when a field is added.
function renderMarkdown({ rfi, discipline, analysis, sources }) {
  const lines = [];
  lines.push(`# RFI against the documents — ${rfi.rfi_number}: ${rfi.subject}`);
  lines.push('');
  lines.push('> Coaster\'s reading of the project documents, produced before the A/E replied. It says whether the documents answer this RFI — it is not an answer to it, and it carries no authority.');
  lines.push('');
  lines.push(`**${RFI_VERDICT_LABEL[analysis.verdict] || analysis.verdict}**  `);
  lines.push(`**Discipline:** ${discipline}  `);
  lines.push(`**Confidence:** ${analysis.confidence}${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}`);
  lines.push('');
  if (analysis.headline) {
    lines.push(analysis.headline);
    lines.push('');
  }

  if (analysis.points?.length) {
    lines.push('| | Point | The documents show | The RFI asks | Where |');
    lines.push('|---|---|---|---|---|');
    for (const p of analysis.points) {
      lines.push(`| ${RFI_STATUS_LABEL[p.status] || ''} | ${cell(p.point)} `
        + `| ${cell(p.documentsShow)} | ${cell(p.rfiAsks)} | ${cell(p.where)} |`);
    }
    lines.push('');
  } else {
    lines.push('_Nothing in this RFI could be compared with the documents provided._');
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

// A verdict the table does not support is the one answer this must not pass on. "The documents
// already answer this RFI" printed above a row saying the documents are silent is worse than no
// verdict at all: the PM forwards the verdict, and the row is what the A/E would have to answer to.
//
// It is settled from the rows rather than by asking again, because the rows ARE the evidence and a
// second call on a rate-limited account has to earn itself. Where they agree, nothing changes.
function reconcileVerdict({ verdict, points }) {
  if (!points.length) return 'cannot_tell';
  // "I could not see the sheets that govern this" is a statement about the quality of the read,
  // not about the rows, so the rows cannot overrule it. Deriving a verdict over the top of it
  // would turn "I do not know" into a judgement of the contractor.
  if (verdict === 'cannot_tell') return 'cannot_tell';

  const kinds = new Set(points.map(p => p.status));
  const open = ['missing', 'conflict', 'unclear'].some(k => kinds.has(k));
  const settled = kinds.has('answered') || kinds.has('mistaken');
  if (open && settled) return 'partly_justified';
  if (open) return 'justified';
  return 'not_needed';
}

// documents: [{ label, doc_type, buffer }] — the Shared Documents the PM selected.
// extraFiles: [{ label, buffer }] — anything attached to this RFI alone.
async function analyzeRfi({ rfi, discipline, documents = [], extraFiles = [] }) {
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
    content, tool: VALIDITY_TOOL, maxTokens: 2000, label: 'rfi analysis',
  });

  const analysis = {
    verdict: RFI_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'cannot_tell',
    headline: parsed.headline || null,
    points: (Array.isArray(parsed.points) ? parsed.points : [])
      .filter(p => p && p.point)
      .map(p => ({
        point: p.point,
        documentsShow: p.documentsShow || null,
        rfiAsks: p.rfiAsks || null,
        where: p.where || null,
        // An unrecognised status would render as an uncoloured row with no label, which reads as
        // "nothing to see here" — the wrong default. "unclear" is the neutral one of the five.
        status: RFI_STATUSES.includes(p.status) ? p.status : 'unclear',
      })),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    confidenceReason: parsed.confidenceReason || null,
  };
  analysis.verdict = reconcileVerdict(analysis);

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

module.exports = {
  analyzeRfi, renderMarkdown, MAX_ANALYSIS_PAGES, SMALL_DOC_PAGES,
  RFI_STATUSES, RFI_STATUS_LABEL, RFI_VERDICTS, RFI_VERDICT_LABEL,
  // Exported for tests/rfiReconcile.test.js. This is the guard that stops a verdict the table does
  // not support reaching the PM, so it is worth being able to exercise without an API call.
  reconcileVerdict,
};
