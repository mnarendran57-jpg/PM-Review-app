const { analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Reads a project document once, on upload, and keeps what the review modules keep asking for.
//
// Until now only a contract was read this way. Everything else — the drawing set, the project
// manual, the scope letter — was re-read on every review that touched it: an AI call to find the
// section in the manual for each submittal, another to read the drawing index for each RFI, the
// whole document re-parsed for each pre-construction comparison. The same answer, bought again
// every time, and none of it inspectable between runs.
//
// What is kept is deliberately narrow. Not a summary of the document — a summary is the one
// thing a review can never act on. Two things a module actually needs:
//
//   1. The INDEX. Which sheet or section is on which page. This is what the per-review search
//      calls exist to rediscover, and it is the same answer every time, so it is worth storing
//      on its own.
//   2. The KEY FACTS. The statements a review has to measure something against — scope that is
//      by others, exclusions, allowances, standards, responsibilities, quantities. Each carries
//      its page, so a PM can turn to it and a report can cite it.
//
// Everything here is a reading, not a ruling. It is stored so it can be corrected once rather
// than re-derived differently on every run.

const KEY_FACTS_TOOL = {
  name: 'record_document_key_facts',
  description: 'Record what a construction project document contains and what it requires.',
  input_schema: {
    type: 'object',
    properties: {
      index: {
        type: 'array',
        description: 'The document\'s own index of its parts, as printed on these pages: drawing '
          + 'sheets by sheet number, specification sections by section number, chapters by '
          + 'heading. One entry each. This is what lets a later review open the right page '
          + 'without searching the whole document again, so it is the most valuable field here.',
        items: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description: 'The sheet number, section number or clause number as printed — '
                + '"M-101", "23 05 93", "Article 7". Copy it exactly; it is matched against what '
                + 'a submittal or RFI cites.',
            },
            title: { type: 'string', description: 'Its title as printed.' },
            page: {
              type: 'integer',
              description: 'The page of THIS document it starts on, counting the first page you '
                + 'were given as 1. Omit if you are reading it from a contents list and the '
                + 'document does not say.',
            },
          },
          required: ['ref'],
        },
      },
      keyFacts: {
        type: 'array',
        description: 'Statements a review would have to measure something against. Scope included '
          + 'or excluded, work by others, allowances, unit prices, quantities, standards and codes '
          + 'cited, required certificates and submittals, responsibilities, deadlines and '
          + 'notice periods. Quote or closely paraphrase — "the specification requires 16 gauge" '
          + 'is usable and "discusses materials" is not. An empty list is right for a page that '
          + 'states nothing of the sort.',
        items: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'What it is about, in a few words — "duct gauge", "excavation by others".',
            },
            fact: { type: 'string', description: 'What the document actually says.' },
            category: {
              type: 'string',
              enum: ['scope-included', 'scope-excluded', 'by-others', 'allowance', 'quantity',
                'standard', 'submittal-required', 'responsibility', 'schedule', 'commercial', 'other'],
              description: 'Which kind of statement this is. "by-others" is for work the document '
                + 'places outside this contractor\'s scope, which is what a proposal gets checked '
                + 'against most often.',
            },
            ref: { type: 'string', description: 'The sheet, section or clause it appears under.' },
            page: { type: 'integer', description: 'Page of this document, counting from 1.' },
          },
          required: ['topic', 'fact'],
        },
      },
      documentTitle: { type: 'string', description: 'The document\'s own title, as printed.' },
      documentNumber: { type: 'string', description: 'Project, job or drawing-set number, if shown.' },
      revision: { type: 'string', description: 'Revision or issue marking, if shown.' },
      documentDate: { type: 'string', description: 'The date on it — YYYY-MM-DD where possible.' },
      issuedBy: { type: 'string', description: 'The firm that issued it — architect, engineer, contractor.' },
      summary: {
        type: 'string',
        description: 'ONE sentence saying what this document is and what it governs. Not a '
          + 'précis of its contents.',
      },
    },
    required: ['index', 'keyFacts'],
  },
};

const PROMPT = `You are cataloguing a construction project document so that later reviews can use
it without reading it again.

Record what these pages contain with the record_document_key_facts tool.

Rules:
- You are not reviewing anything and not judging compliance. Report what the document says.
- Copy references and figures exactly as printed — sheet numbers, section numbers, gauges,
  pressure ratings, dimensions, standards. A tidied-up reference will not match what a submittal
  or an RFI cites, and an approximated figure cannot be checked against anything.
- Page numbers are the page of what you were given, counting the first page as 1. They are
  renumbered against the whole document afterwards, so count from 1 every time.
- If this document IS one specification section or one drawing sheet rather than a book of
  them, make its OWN number the first index entry, at page 1 — "23 05 93", "M-101". A section
  handed over on its own indexes its subsections and forgets to name itself, and a later review
  looking for that section by number then fails to find it in its own document.
- "keyFacts" is for statements that could decide a review: what is in scope, what is excluded,
  what is by others, allowances, required submittals and certificates, standards, quantities,
  deadlines. Not narrative, not boilerplate, not a description of what a section is about.
- Where a drawing note says work is by another party, or not in contract, record it — those
  notes are what a contractor's proposal gets measured against.
- Empty lists are correct answers for pages that carry nothing of the kind. Do not pad.`;

// A field the document does not state draws "<UNKNOWN>" or "not specified" out of the model, and
// storing that reads later as though the document named a revision called Not Specified. Nothing
// is the honest record of nothing.
const BLANKS = /^(<?\s*unknown\s*>?|not\s+(specified|listed|given|provided|stated|shown)|unspecified|none|n\/?a|-+)$/i;
const said = v => (typeof v === 'string' && v.trim() && !BLANKS.test(v.trim()) ? v.trim() : null);

// One reading of one document, whole. Long documents are read in passes and merged, so length
// changes only how many passes it takes.
async function extractDocumentFacts(buffer, { label = 'document' } = {}) {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let pagesRead = 0;

  const readPass = async (partBuffer, context) => {
    const first = context.startPage || 1;
    const { data, usage: u } = await askForJson({
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: partBuffer.toString('base64') } },
        { type: 'text', text: `The document is "${label}".${partNotice(context)}` },
      ],
      // The instructions are identical on every pass, so they travel in the cached prefix with
      // the schema. On their own neither clears the caching minimum; together they do.
      system: PROMPT,
      tool: KEY_FACTS_TOOL,
      cacheTool: true,
      maxTokens: 8000,
      label: 'document key facts',
    });
    if (u) {
      usage = {
        inputTokens: usage.inputTokens + (u.input_tokens || 0),
        outputTokens: usage.outputTokens + (u.output_tokens || 0),
      };
    }
    if (context.endPage) pagesRead = Math.max(pagesRead, context.endPage);

    // Each pass counts its own pages from 1. Left as they are, an entry from the third pass
    // points at a page near the front of the document.
    const offset = row => {
      const within = Number(row.page);
      return Number.isInteger(within) && within >= 1 ? first + within - 1 : null;
    };
    return {
      ...data,
      index: (data.index || []).filter(r => r && r.ref).map(r => ({ ...r, page: offset(r) })),
      keyFacts: (data.keyFacts || []).filter(r => r && r.topic && r.fact).map(r => ({ ...r, page: offset(r) })),
    };
  };

  const merged = (await analyzeInPasses(buffer, readPass)) || {};

  // A contents list at the front and the sections themselves later produce the same ref twice.
  // The one carrying a page wins, because that is the one a reader can act on.
  const byRef = new Map();
  for (const row of merged.index || []) {
    const key = String(row.ref).trim().toLowerCase();
    const seen = byRef.get(key);
    if (!seen || (row.page && !seen.page)) byRef.set(key, row);
  }

  return {
    kind: 'key-facts',
    documentTitle: said(merged.documentTitle),
    documentNumber: said(merged.documentNumber),
    revision: said(merged.revision),
    documentDate: said(merged.documentDate),
    issuedBy: said(merged.issuedBy),
    summary: said(merged.summary),
    index: [...byRef.values()].sort((a, b) => (a.page || 0) - (b.page || 0)),
    keyFacts: merged.keyFacts || [],
    pagesRead,
    usage,
  };
}

module.exports = { extractDocumentFacts };
