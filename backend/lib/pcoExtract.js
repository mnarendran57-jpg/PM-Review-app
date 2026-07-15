const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      'The PCO could not be read back as valid data — it may be longer or more complex than one ' +
      `pass can handle. Try again, or upload just the PCO pricing pages. (${err.message})`
    );
  }
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
` : ''}Return ONLY valid JSON in this exact shape:

{
  "pco": {
    "pcoNumber": "<string or null>",
    "title": "<short title or null>",
    "contractor": "<who submitted it, or null>",
    "date": "<YYYY-MM-DD or null>",
    "totalAmount": <number or null>,
    "referencesRfi": "<RFI/ASI number this PCO cites, or null>",
    "isAllowance": <true | false | null>,
    "taxAmount": <number or null>,
    "taxRate": <decimal or null>,
    "markups": [
      { "party": "<who takes this markup, e.g. 'GC' or 'Sub' or 'Second-tier sub'>",
        "tier": "<\\"gc\\" | \\"sub\\" | \\"second-tier\\" | null>",
        "label": "<the line's own wording, e.g. 'Overhead & Profit 15%'>",
        "rate": <decimal or null>,
        "base": <number the markup is applied to, or null>,
        "amount": <number or null> }
    ],
    "lineItems": [
      { "description": "<string>",
        "qty": <number or null>,
        "unit": "<string or null>",
        "unitPrice": <number or null>,
        "total": <number or null>,
        "hasBreakdown": <true if qty/unit/unitPrice are given, false if it is a bare lump sum> }
    ]
  },
  "reference": ${hasReference ? `{
    "type": "<\\"RFI\\" | \\"ASI\\" | null>",
    "number": "<string or null>",
    "subject": "<string or null>",
    "scopeSummary": "<2-3 sentences: what work the RFI/ASI actually calls for>"
  }` : 'null'},
  "observations": {
    "scopeAlignment": ${hasReference ? `{
      "aligned": <true | false | null>,
      "notes": "<plain-English: does the PCO price the work the RFI/ASI describes, nothing more, nothing less? Name anything in the PCO that the RFI/ASI does not call for.>"
    }` : 'null'},
    "lumpSumConcerns": "<plain-English: which amounts are lump sums a PM should ask to see broken down, and why — or null if none>",
    "pricingSanity": "<plain-English: based on general construction cost knowledge (which may be out of date), do any unit prices or totals look far outside the normal range? Be specific about which line and why. Say nothing definitive — this is a prompt for the PM to check, not a verdict. Or null.>"
  }
}

Rules:
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (15% -> 0.15).
- If a field cannot be found with confidence, use null. Never invent a number.
- "isAllowance" is true only if the PCO or its reference explicitly presents this as an
  allowance (an owner's set-aside amount), not ordinary changed work.
- Every markup/OH&P/fee line on the PCO must appear in "markups", each tagged with the
  party taking it and your best read of their tier.
- Every priced line must appear in "lineItems" — do not merge rows.
- In "observations", write plain English for a reader who is not in construction. No IDs,
  no jargon. Ground every concern in something visible in the documents.`;
}

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 12000,
    messages: [{ role: 'user', content }],
  });
}

// Single Claude call: PCO PDF + optional RFI/ASI PDF + the contract's stored terms as
// text. The contract PDF itself is deliberately NOT re-sent — its terms were extracted
// once at upload and re-billing a long contract every PCO would swamp the review cost.
async function analyzePco({ pcoBuffer, referenceBuffer, contractTerms }) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pcoBuffer.toString('base64') } },
  ];
  if (referenceBuffer) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: referenceBuffer.toString('base64') } });
  }
  content.push({ type: 'text', text: buildPrompt({ hasReference: !!referenceBuffer, contractTerms }) });

  let response;
  try {
    response = await callClaude(content);
  } catch (err) {
    if (err.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 20000));
      response = await callClaude(content);
    } else {
      throw err;
    }
  }

  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      'This PCO has too many line items to read in one pass (the AI response was cut off). ' +
      'Try uploading just the pricing pages.'
    );
  }

  const parsed = safeJsonFromText(response.content[0].text);
  if (response.usage) {
    console.log(`[pco extract] in=${response.usage.input_tokens} out=${response.usage.output_tokens} tokens`);
  }
  return {
    pco: parsed.pco || {},
    reference: parsed.reference || null,
    observations: parsed.observations || {},
  };
}

module.exports = { analyzePco };
