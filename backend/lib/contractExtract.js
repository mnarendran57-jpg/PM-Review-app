const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      'The contract terms could not be read back as valid data. This usually means the contract is ' +
      `longer or more complex than one pass can handle. (${err.message})`
    );
  }
}

const PROMPT = `You are reviewing an executed construction contract on behalf of the owner's
project manager. Extract only the terms needed to audit subcontractor pay applications
against this contract.

Return ONLY valid JSON in this exact shape:

{
  "taxExempt": <true | false | null>,
  "taxExemptBasis": "<short quote or clause reference showing why, or null>",
  "originalContractSum": <number or null>,
  "retainageRate": <decimal or null>,
  "unallowableItems": [
    {
      "item": "<short name of the cost that may NOT be billed, e.g. 'Sales tax'>",
      "basis": "<the clause or wording that makes it unallowable>"
    }
  ],
  "notes": "<anything a PM auditing pay apps should know, or null>"
}

Rules:
- "taxExempt" is true ONLY if the contract states the owner is a tax-exempt entity or that
  the work is exempt from sales/use tax. Many public entities (school districts, cities,
  universities) are exempt. If the contract is silent, return null — do NOT guess.
- "unallowableItems" means costs this contract forbids billing for. Typical examples: sales
  tax on an exempt project, markup above a stated cap, unapproved overtime, mobilization not
  in the schedule of values, costs without backup. Include ONLY items the contract actually
  addresses — do not invent standard-practice items that this contract does not mention.
- "basis" must be grounded in the contract's own wording. If you cannot point to wording,
  leave the item out entirely.
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (10% -> 0.10).
- If a field cannot be found with confidence, use null. Do not use the string "Not specified".
- Prefer returning fewer, well-grounded items over a long speculative list. A project manager
  will act on these, so a false flag costs them real time.`;

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content }],
  });
}

// Extracts the auditable terms from an executed contract in a single Claude call.
// Called once per project when the contract is uploaded — the result is stored on the
// project and reused by every later pay app review, so a long contract is never
// re-sent to the model period after period.
async function extractContractTerms(contractBuffer) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: contractBuffer.toString('base64') } },
    { type: 'text', text: PROMPT },
  ];

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
      'This contract is too long to read in one pass (the AI response was cut off). Try uploading ' +
      'just the sections covering tax status, allowable costs, and the schedule of values.'
    );
  }

  const parsed = safeJsonFromText(response.content[0].text);
  return {
    taxExempt: typeof parsed.taxExempt === 'boolean' ? parsed.taxExempt : null,
    taxExemptBasis: parsed.taxExemptBasis || null,
    originalContractSum: typeof parsed.originalContractSum === 'number' ? parsed.originalContractSum : null,
    retainageRate: typeof parsed.retainageRate === 'number' ? parsed.retainageRate : null,
    unallowableItems: Array.isArray(parsed.unallowableItems)
      ? parsed.unallowableItems.filter(i => i && i.item).map(i => ({ item: String(i.item), basis: i.basis || null }))
      : [],
    notes: parsed.notes || null,
    usage: response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null,
  };
}

module.exports = { extractContractTerms };
