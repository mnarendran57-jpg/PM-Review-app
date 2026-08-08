const { splitPdf, analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Change-order line descriptions carry dimensions written with inch marks, so this comes back
// through a tool call rather than as parsed text. See lib/aiJson.js.
//
// The reference block is only offered when an RFI/ASI was uploaded: a schema that always
// asked for it would invite the model to invent one.
function pcoTool(hasReference) {
  const properties = {
    pco: {
      type: 'object',
      properties: {
        pcoNumber: { type: 'string' },
        title: { type: 'string', description: 'A short title.' },
        contractor: { type: 'string', description: 'Who submitted it.' },
        date: { type: 'string', description: 'YYYY-MM-DD.' },
        totalAmount: { type: 'number' },
        referencesRfi: { type: 'string', description: 'The RFI/ASI number this PCO cites.' },
        isAllowance: { type: 'boolean' },
        taxAmount: { type: 'number' },
        taxRate: { type: 'number', description: 'A decimal.' },
        markups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              party: { type: 'string', description: "Who takes this markup, e.g. 'GC' or 'Sub'." },
              tier: { type: 'string', enum: ['gc', 'sub', 'second-tier'] },
              label: { type: 'string', description: "The line's own wording, e.g. 'Overhead & Profit 15%'." },
              rate: { type: 'number', description: 'A decimal.' },
              base: { type: 'number', description: 'The number the markup is applied to.' },
              amount: { type: 'number' },
            },
            required: ['label'],
          },
        },
        lineItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              qty: { type: 'number' },
              unit: { type: 'string' },
              unitPrice: { type: 'number' },
              total: { type: 'number' },
              hasBreakdown: {
                type: 'boolean',
                description: 'True if qty/unit/unitPrice are given, false if it is a bare lump sum.',
              },
            },
            required: ['description'],
          },
        },
      },
      required: ['lineItems'],
    },
    observations: {
      type: 'object',
      properties: {
        lumpSumConcerns: {
          type: 'string',
          description: 'Plain English: which amounts are lump sums a PM should ask to see '
            + 'broken down, and why.',
        },
        pricingSanity: {
          type: 'string',
          description: 'Plain English: based on general construction cost knowledge (which may '
            + 'be out of date), do any unit prices or totals look far outside the normal range? '
            + 'Be specific about which line and why. Say nothing definitive — this is a prompt '
            + 'for the PM to check, not a verdict.',
        },
      },
    },
  };

  if (hasReference) {
    properties.reference = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['RFI', 'ASI'] },
        number: { type: 'string' },
        subject: { type: 'string' },
        scopeSummary: {
          type: 'string',
          description: '2-3 sentences: what work the RFI/ASI actually calls for.',
        },
      },
    };
    properties.observations.properties.scopeAlignment = {
      type: 'object',
      properties: {
        aligned: { type: 'boolean' },
        notes: {
          type: 'string',
          description: 'Plain English: does the PCO price the work the RFI/ASI describes, '
            + 'nothing more, nothing less? Name anything in the PCO that the RFI/ASI does not '
            + 'call for.',
        },
      },
    };
  }

  return {
    name: 'record_pco_review',
    description: 'Record a potential change order\'s figures and what is worth the PM\'s attention.',
    input_schema: { type: 'object', properties, required: ['pco'] },
  };
}

// The extraction returns two clearly separated things:
//  - "pco": raw figures and structure, which feed the deterministic checks in
//    pcoChecks.js (that math is done in code, not by the model)
//  - "observations": judgment calls only the model can make (scope vs the RFI,
//    pricing reasonableness). These are advisory and rendered as such.
function buildPrompt({ hasReference, contractTerms }) {
  return `You are reviewing a construction Potential Change Order (PCO) on behalf of the
owner's project manager.${hasReference ? ' The second document is the RFI or ASI that generated this PCO.' : ''}

${contractTerms ? `The executed contract's relevant terms (already verified by the PM):
${JSON.stringify(contractTerms, null, 2)}
` : ''}Record what you find with the record_pco_review tool.

Rules:
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (15% -> 0.15).
- If a field cannot be found with confidence, omit it. Never invent a number.
- "isAllowance" is true only if the PCO or its reference explicitly presents this as an
  allowance (an owner's set-aside amount), not ordinary changed work.
- Every markup/OH&P/fee line on the PCO must appear in "markups", each tagged with the
  party taking it and your best read of their tier.
- Every priced line must appear in "lineItems" — do not merge rows.
- In "observations", write plain English for a reader who is not in construction. No IDs,
  no jargon. Ground every concern in something visible in the documents.`;
}

const TOO_MANY_LINE_ITEMS = 'This change order has more pricing detail than one response can '
  + 'hold. Try uploading it without its largest backup attachment.';

// Single Claude call: PCO PDF + optional RFI/ASI PDF + the contract's stored terms as
// text. The contract PDF itself is deliberately NOT re-sent — its terms were extracted
// once at upload and re-billing a long contract every PCO would swamp the review cost.
async function callWithRetry(content, hasReference) {
  const { data } = await askForJson({
    content,
    tool: pcoTool(hasReference),
    maxTokens: 12000,
    label: 'pco extract',
    truncatedMessage: TOO_MANY_LINE_ITEMS,
  });
  return data;
}

async function analyzePco({ pcoBuffer, referenceBuffer, contractTerms }) {
  const pcoParts = await splitPdf(pcoBuffer);
  const refParts = referenceBuffer ? await splitPdf(referenceBuffer) : [];

  // Both fit: keep the single two-document call, which costs one request rather than two.
  if (pcoParts.length === 1 && refParts.length <= 1) {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pcoBuffer.toString('base64') } },
    ];
    if (referenceBuffer) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: referenceBuffer.toString('base64') } });
    }
    content.push({ type: 'text', text: buildPrompt({ hasReference: !!referenceBuffer, contractTerms }) });

    const parsed = await callWithRetry(content, !!referenceBuffer);
    return {
      pco: parsed.pco || {},
      reference: parsed.reference || null,
      observations: parsed.observations || {},
    };
  }

  // Long change order (usually thick pricing backup): each document is read in page-range
  // passes and the results combined, so length never blocks the review.
  const readPco = async (buffer, context) => {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: buildPrompt({ hasReference: false, contractTerms }) + partNotice(context) },
    ];
    return callWithRetry(content, false);
  };

  const main = await analyzeInPasses(pcoBuffer, readPco);
  const ref = referenceBuffer ? await analyzeInPasses(referenceBuffer, readPco) : null;

  return {
    pco: main.pco || {},
    // The RFI/ASI is a separate document, so its own extraction stands in for the reference.
    reference: ref ? (ref.reference || ref.pco || null) : null,
    observations: main.observations || {},
  };
}

module.exports = { analyzePco };
