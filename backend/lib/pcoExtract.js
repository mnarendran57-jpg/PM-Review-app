const { splitPdf, analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Change-order line descriptions carry dimensions written with inch marks, so this comes back
// through a tool call rather than as parsed text. See lib/aiJson.js.
//
// The reference block is only offered when an RFI/ASI was uploaded: a schema that always
// asked for it would invite the model to invent one.
// `hasContract` adds the one observation that needs the contract's terms: costs the contract
// forbids that a wording match in code would miss.
function pcoTool(hasReference, hasContract = false) {
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
              kind: {
                type: 'string',
                enum: ['material', 'equipment', 'labor', 'other'],
                description: 'What the line pays for. "material" is a product that stays in the '
                  + 'building — pipe, duct, fixtures, panels, finishes. "equipment" is a manufactured '
                  + 'unit that is installed — an air handler, a pump, a switchboard. "labor" is '
                  + 'hours, crews or installation with no product in it. "other" is everything else: '
                  + 'rentals, permits, fees, freight, general conditions, a lump sum that mixes '
                  + 'several of these. When a line is plainly both a product and its installation, '
                  + 'call it by the product.',
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
          description: 'Plain English, at most two short sentences: which lump sums a PM should '
            + 'ask to see broken down, and why. Omit entirely when nothing stands out — an empty '
            + 'answer is a good answer.',
        },
        pricingSanity: {
          type: 'string',
          description: 'Plain English, at most two short sentences: based on general construction '
            + 'cost knowledge (which may be out of date), does any unit price or total look far '
            + 'outside the normal range? Name the line and the reason. Say nothing definitive — '
            + 'this is a prompt for the PM to check, not a verdict. Omit entirely when nothing '
            + 'stands out. About price levels only: do not repeat tax, markup or anything the '
            + 'contract allows or forbids — those are reported separately.',
        },
      },
    },
  };

  if (hasContract) {
    properties.observations.properties.contractConcerns = {
      type: 'array',
      description: 'Lines on the PCO that the contract terms you were given forbid or restrict — '
        + 'for example overtime billed without the written direction the contract requires, or a '
        + 'cost the contract lists as not reimbursable. Leave out sales tax and markup percentages; '
        + 'those are checked separately. Empty when nothing on the PCO goes against the contract.',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The PCO line, by its description as printed.' },
          amount: { type: 'number', description: 'The amount on that line.' },
          rule: { type: 'string', description: 'What the contract says, in one short plain-English sentence.' },
          section: { type: 'string', description: 'The section or clause it comes from, if the terms name one.' },
        },
        required: ['item', 'rule'],
      },
    };
  }

  if (hasReference) {
    properties.reference = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['RFI', 'ASI'] },
        number: { type: 'string' },
        subject: { type: 'string' },
        scopeSummary: {
          type: 'string',
          description: 'One or two sentences: what work the RFI/ASI actually calls for.',
        },
      },
    };
    properties.observations.properties.scopeAlignment = {
      type: 'object',
      properties: {
        aligned: { type: 'boolean' },
        notes: {
          type: 'string',
          description: 'Plain English, at most two short sentences: does the PCO price the work '
            + 'the RFI/ASI describes, nothing more, nothing less? Name anything in the PCO that '
            + 'the RFI/ASI does not call for.',
        },
        extraItems: {
          type: 'array',
          description: 'The PCO lines that price work the RFI/ASI does not call for, by their '
            + 'description as printed. Empty when everything priced was asked for.',
          items: { type: 'string' },
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
owner's project manager.${hasReference ? ' The documents after the first are the RFI(s) or ASI(s) that generated this PCO.' : ''}

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
- Every priced line must appear in "lineItems" — do not merge rows. Give each one its "kind".
- In "observations", write plain English for a reader who is not in construction. No IDs,
  no jargon. Ground every concern in something visible in the documents. Be brief: the PM reads
  this between site visits. Leave a note out rather than fill it with something unremarkable.`;
}

const TOO_MANY_LINE_ITEMS = 'This change order has more pricing detail than one response can '
  + 'hold. Try uploading it without its largest backup attachment.';

// Single Claude call: PCO PDF + optional RFI/ASI PDF + the contract's stored terms as
// text. The contract PDF itself is deliberately NOT re-sent — its terms were extracted
// once at upload and re-billing a long contract every PCO would swamp the review cost.
async function callWithRetry(content, hasReference, hasContract) {
  const { data } = await askForJson({
    content,
    tool: pcoTool(hasReference, hasContract),
    maxTokens: 12000,
    label: 'pco extract',
    truncatedMessage: TOO_MANY_LINE_ITEMS,
  });
  return data;
}

// referenceBuffers: the RFI(s) or ASI(s) the PCO is measured against, as many as the PM chose.
// referenceBuffer is the single one a caller from before that choice passes.
async function analyzePco({ pcoBuffer, referenceBuffers = [], referenceBuffer, contractTerms }) {
  const references = [...referenceBuffers, ...(referenceBuffer ? [referenceBuffer] : [])];
  const pcoParts = await splitPdf(pcoBuffer);
  const refParts = await Promise.all(references.map(buffer => splitPdf(buffer)));
  const hasReference = references.length > 0;

  // Everything fits: keep the single call that reads them all together, which costs one request
  // and is the only way the scope comparison can see the PCO and its RFI side by side.
  if (pcoParts.length === 1 && refParts.every(parts => parts.length === 1)) {
    const asDoc = buffer => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
    const content = [asDoc(pcoBuffer), ...references.map(asDoc)];
    content.push({ type: 'text', text: buildPrompt({ hasReference, contractTerms }) });

    const parsed = await callWithRetry(content, hasReference, !!contractTerms);
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
    return callWithRetry(content, false, !!contractTerms);
  };

  const main = await analyzeInPasses(pcoBuffer, readPco);
  // Only the first reference stands in on this path. Each is a separate document, so its own
  // extraction is what is known about it; the scope comparison needs them read together, which a
  // document too long for one request cannot be.
  const ref = references.length ? await analyzeInPasses(references[0], readPco) : null;

  return {
    pco: main.pco || {},
    reference: ref ? (ref.reference || ref.pco || null) : null,
    observations: main.observations || {},
  };
}

module.exports = { analyzePco };
