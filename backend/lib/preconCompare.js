const { PDFDocument } = require('pdf-lib');
const { askForJson } = require('./aiJson');
const { locateScope } = require('./scopeLocator');

// The proposal against the documents it is supposed to price.
//
// The precon review already reads a proposal on its own terms and reports what is risky about
// it. This asks a different and more answerable question: does what the contractor priced match
// what the drawings and the contract actually asked for?
//
// Three findings are worth money, in this order:
//
//   OUTSIDE THE CONTRACT   priced, but the documents exclude it or never asked for it. The owner
//                          is being quoted for work they are not buying.
//   DIFFERS                priced, but differently from what is drawn, scheduled or specified.
//   NOT PRICED             the documents require it and the proposal is silent. The most
//                          expensive of the three, because it surfaces as a change order later.
//
// What makes this affordable is that it does not read the design set. lib/scopeLocator.js finds
// the pages that carry scope language — for free, from the PDF's own text — and only those pages
// are sent. Fifteen pages is one request and about 30,000 input tokens; the whole set would be
// three quarters of a million and an hour of waiting on the rate limit.

const MAX_PROPOSAL_PAGES = 12;

const FINDING = (title, extra = {}) => ({
  type: 'array',
  description: title,
  items: {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'What the finding is about, in a few words.' },
      proposalSays: { type: 'string', description: 'What the proposal prices or states. Quote the line where you can.' },
      documentsSay: {
        type: 'string',
        description: 'What the drawings or contract say, quoted or closely paraphrased, WITH the '
          + 'sheet or clause it came from. A finding with no source is an opinion.',
      },
      source: { type: 'string', description: 'The document and page or sheet the quote came from.' },
      amount: { type: 'number', description: 'The money at stake, if the proposal states it.' },
      confidence: {
        type: 'string',
        enum: ['certain', 'likely', 'worth_checking'],
        description: '"certain" — the documents say it plainly and the proposal plainly differs. '
          + '"likely" — a reasonable reading of both. "worth_checking" — the wording is '
          + 'ambiguous, or the relevant page may not have been among those read.',
      },
      whyItMatters: { type: 'string', description: 'The practical consequence for the owner.' },
      ...extra,
    },
    required: ['item', 'proposalSays', 'confidence'],
  },
});

const COMPARE_TOOL = {
  name: 'record_proposal_comparison',
  description: 'Compare a contractor proposal against the scope the project documents define.',
  input_schema: {
    type: 'object',
    properties: {
      outsideContract: FINDING(
        'Work the proposal prices that the documents exclude, assign to somebody else, or never '
        + 'ask for. Each entry MUST quote the exclusion — "by others", "not in contract", '
        + '"furnished by owner" — from the pages you were given. If you cannot point to the '
        + 'wording, it does not belong here; put it in "worthAsking" instead.'
      ),
      differsFromDocuments: FINDING(
        'Work priced differently from what the documents show — a different product, quantity, '
        + 'extent, or standard. Quote both sides.'
      ),
      notPriced: FINDING(
        'Work the documents require that the proposal does not appear to price. The most '
        + 'expensive kind of gap, because it arrives later as a change order. Be careful: a '
        + 'proposal often prices work in a lump without listing it, so only report this where '
        + 'the documents call for something specific and nothing in the proposal covers it.'
      ),
      worthAsking: {
        type: 'array',
        description: 'Questions to put to the contractor where the documents are ambiguous or '
          + 'the pages read did not settle it. Plain sentences, not findings.',
        items: { type: 'string' },
      },
      couldNotCheck: {
        type: 'string',
        description: 'What you could not compare, and why — a scope area the pages you were '
          + 'given did not cover, a proposal that prices in a lump with no breakdown, a drawing '
          + 'reference to a sheet not among those read. Omit only if nothing was in the way.',
      },
      // Last on purpose: it summarises the fields above.
      headline: {
        type: 'string',
        description: 'ONE sentence for the PM: does this proposal match what the documents ask '
          + 'for, and if not, where is the biggest gap? No preamble.',
      },
    },
    required: ['outsideContract', 'differsFromDocuments', 'notPriced', 'headline'],
  },
};

const asDocument = buffer => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

async function extractPages(buffer, pageNumbers) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = source.getPageCount();
  const wanted = [...new Set(pageNumbers)]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= total)
    .sort((a, b) => a - b);
  if (!wanted.length) return null;
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, wanted.map(n => n - 1));
  copied.forEach(p => out.addPage(p));
  return { buffer: Buffer.from(await out.save()), pages: wanted };
}

function buildPrompt({ projectName, located, sentPages }) {
  const found = located.selected.map(s =>
    `  - ${s.label}: pages ${s.pages.join(', ')}`).join('\n') || '  (none)';

  const quoted = located.passages.slice(0, 40).map(p =>
    `  [${p.documentLabel} p.${p.page}] "${p.text}"`).join('\n') || '  (none found)';

  const skipped = located.unreadable.map(u => `  - ${u.label}: ${u.why}`).join('\n');

  return `You are advising the owner's project manager. A contractor has submitted a proposal, and
the question is whether what they priced matches what the project documents actually ask for.

${projectName ? `Project: ${projectName}\n` : ''}
The contractor's proposal is attached first. After it are ONLY the pages of the project documents
that carry scope language — they were found by searching the documents' text for phrases like
"scope of work", "by others", "not in contract" and "general notes". You are not seeing the whole
design set, and you must not pretend otherwise.

PAGES YOU HAVE BEEN GIVEN
${found}
${sentPages ? `(${sentPages} pages of project documents in total, after the proposal.)\n` : ''}
${skipped ? `\nDOCUMENTS THAT COULD NOT BE SEARCHED\n${skipped}\n` : ''}
SCOPE LANGUAGE FOUND BY THE TEXT SEARCH
These passages were extracted automatically from those documents. They are here so you can see
what the search found even where the page image is hard to read:
${quoted}

Record your comparison with the record_proposal_comparison tool.

Rules:
- Quote the documents. Every entry in "outsideContract" and "differsFromDocuments" must carry the
  wording it rests on and the sheet or page it came from. A finding the PM cannot forward to the
  contractor with the drawing note attached is not worth making.
- "outsideContract" is the highest-value field and the easiest to get wrong. It means the
  documents positively exclude the work or give it to somebody else — quote that exclusion. Work
  that is simply not mentioned on the pages you were given is NOT outside the contract; you did
  not see the whole set. Put that in "worthAsking".
- Be conservative on "notPriced". A proposal that prices "HVAC systems, complete" has priced the
  ductwork even though it never says "ductwork". Only report a gap where the documents call for
  something specific and identifiable and nothing in the proposal plausibly covers it.
- You are reading a fraction of the documents on purpose. Say so in "couldNotCheck" wherever it
  limits an answer. An honest "the pages read did not cover the electrical scope" is far more
  useful than a confident finding drawn from a page you never saw.
- Use "confidence" properly. "certain" is for a plain exclusion against a plain proposal line.
  Most real findings are "likely". Use "worth_checking" freely.
- Write for a project manager who is not a specialist in this trade, and who will forward this
  to the contractor as it stands.`;
}

function renderMarkdown({ projectName, comparison, located }) {
  const L = [];
  L.push(`# Proposal against the project documents${projectName ? ` — ${projectName}` : ''}`);
  L.push('');
  L.push('> What the contractor priced, read against the scope the drawings and contract define. '
    + 'Only the pages carrying scope language were read — see "What was read" at the end.');
  L.push('');
  L.push(comparison.headline || '');
  L.push('');

  const section = (title, items, aeLabel) => {
    if (!items?.length) return;
    L.push(`## ${title}`);
    L.push('');
    for (const f of items) {
      L.push(`### ${f.item}${f.amount != null ? ` — $${Number(f.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}`);
      L.push('');
      L.push(`- **The proposal:** ${f.proposalSays}`);
      if (f.documentsSay) L.push(`- **${aeLabel}:** ${f.documentsSay}`);
      if (f.source) L.push(`- **Source:** ${f.source}`);
      if (f.whyItMatters) L.push(`- **Why it matters:** ${f.whyItMatters}`);
      L.push(`- **Confidence:** ${f.confidence}`);
      L.push('');
    }
  };
  section('Outside the contract', comparison.outsideContract, 'The documents say');
  section('Differs from the design documents', comparison.differsFromDocuments, 'The documents show');
  section('Required, but not priced', comparison.notPriced, 'The documents require');

  if (comparison.freeFindings?.length) {
    L.push('## Exclusions matched by text search');
    L.push('');
    L.push('_Found by matching the proposal\'s own line items against exclusion language in the '
      + 'documents. Matched on wording, so check the passage before acting._');
    L.push('');
    for (const f of comparison.freeFindings) {
      L.push(`- **${f.proposalLine}** — ${f.documentLabel} p.${f.page} says "${f.phrase}": ${f.passage}`);
    }
    L.push('');
  }
  if (comparison.worthAsking?.length) {
    L.push('## Worth asking the contractor');
    L.push('');
    for (const q of comparison.worthAsking) L.push(`- ${q}`);
    L.push('');
  }
  if (comparison.couldNotCheck) {
    L.push('## Not checked');
    L.push('');
    L.push(comparison.couldNotCheck);
    L.push('');
  }

  L.push('## What was read');
  L.push('');
  for (const r of located.read || []) {
    L.push(`- **${r.label}** — ${r.pagesTotal} pages, ${r.pagesWithScopeLanguage} carrying scope `
      + `language; the densest ${(located.selected.find(s => s.label === r.label)?.pages || []).length} were read.`);
  }
  for (const u of located.unreadable || []) {
    L.push(`- **${u.label}** — not searched: ${u.why}`);
  }
  return L.join('\n');
}

// proposalFiles: [{ label, buffer }] — what the contractor submitted.
// documents:     [{ label, buffer }] — drawings, contract, whatever was chosen.
// proposalLines: [{ description, amount }] — the proposal's priced items, if already read.
async function compareProposal({ projectName, proposalFiles = [], documents = [], proposalLines = [] }) {
  // --- A, free: find the scope language and take what certainty is available without a call.
  const located = await locateScope({ documents, proposalLines });

  // Nothing to compare against. Reported rather than hidden: a review that quietly says "no
  // discrepancies" after failing to read a scanned drawing set is worse than no review.
  if (located.empty) {
    return {
      comparison: {
        headline: located.unreadable.length
          ? 'The chosen documents could not be searched, so the proposal was not compared against them.'
          : 'No scope language was found in the chosen documents, so there was nothing to compare the proposal against.',
        outsideContract: [], differsFromDocuments: [], notPriced: [],
        worthAsking: [], freeFindings: [],
        couldNotCheck: located.unreadable.length
          ? located.unreadable.map(u => `${u.label}: ${u.why}`).join('; ')
          : 'The documents carry no recognisable scope, exclusion or general-note language.',
        ranAiPass: false,
      },
      located,
      markdown: renderMarkdown({ projectName, comparison: { headline: 'Nothing to compare.', freeFindings: [] }, located }),
    };
  }

  // --- B, one call: judge only the pages A found.
  const blocks = [];
  for (const f of proposalFiles.slice(0, 2)) {
    const cut = await extractPages(f.buffer, Array.from({ length: MAX_PROPOSAL_PAGES }, (_, i) => i + 1));
    blocks.push(asDocument(cut ? cut.buffer : f.buffer));
  }

  let sentPages = 0;
  const byLabel = new Map(documents.map(d => [d.label, d]));
  for (const sel of located.selected) {
    const doc = byLabel.get(sel.label);
    if (!doc) continue;
    const cut = await extractPages(doc.buffer, sel.pages);
    if (!cut) continue;
    sentPages += cut.pages.length;
    blocks.push(asDocument(cut.buffer));
  }

  const { data } = await askForJson({
    content: [...blocks, { type: 'text', text: buildPrompt({ projectName, located, sentPages }) }],
    tool: COMPARE_TOOL,
    maxTokens: 4000,
    attempts: 3,
    label: 'proposal vs documents',
  });

  const list = v => (Array.isArray(v) ? v.filter(x => x && x.item) : []);
  const comparison = {
    headline: data.headline || null,
    outsideContract: list(data.outsideContract),
    differsFromDocuments: list(data.differsFromDocuments),
    notPriced: list(data.notPriced),
    worthAsking: Array.isArray(data.worthAsking) ? data.worthAsking.filter(Boolean) : [],
    couldNotCheck: data.couldNotCheck || null,
    // The free pass travels with the AI one so the report can show both, and so a reader can see
    // which findings needed judgement and which are plain text matches.
    freeFindings: located.findings,
    ranAiPass: true,
    pagesRead: sentPages,
  };

  return { comparison, located, markdown: renderMarkdown({ projectName, comparison, located }) };
}

module.exports = { compareProposal, renderMarkdown };
