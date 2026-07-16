const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`The compliance scan could not be read back as valid data. (${err.message})`);
  }
}

function buildPrompt({ contractTerms, scopeBaseline, currentItems, coLog }) {
  const banned = contractTerms?.unallowableItems || [];
  const scopeSection = scopeBaseline
    ? `
For the scope comparison, the agreed schedule of values (${scopeBaseline.source === 'contract'
      ? 'from the executed contract'
      : "from the project's first pay application, which established the schedule"}):
${JSON.stringify(scopeBaseline.items, null, 2)}

The line items billed on the CURRENT application:
${JSON.stringify(currentItems, null, 2)}

${coLog?.length
      ? `Approved change orders on this project:\n${JSON.stringify(coLog, null, 2)}`
      : 'No change order log was provided.'}
`
    : '';

  return `You are auditing a contractor's pay application and its backup documentation
(receipts, invoices, lien waivers) against the executed contract, on behalf of the
owner's project manager.

${contractTerms ? `The contract's relevant terms, already verified by the PM:
${JSON.stringify(
    {
      taxExempt: contractTerms.taxExempt,
      taxExemptBasis: contractTerms.taxExemptBasis,
      unallowableItems: banned,
    },
    null, 2
  )}` : 'No contract terms are on file — skip the tax and unallowable-item review (return empty arrays for those) and perform only the scope comparison.'}
${scopeSection}
Return ONLY valid JSON in this exact shape:

{
  "scopeComparison": ${scopeBaseline ? `[
    {
      "itemNo": "<the current application's item number, as given above>",
      "description": "<the current application's line description>",
      "scheduledValue": <that line's scheduled value, number or null>,
      "status": "<\\"in_contract\\" | \\"changed\\" | \\"covered_by_co\\" | \\"not_in_contract\\">",
      "matchedTo": "<which schedule-of-values line it corresponds to, or null>",
      "coNumber": "<the change order that covers it, only when status is covered_by_co, else null>",
      "note": "<one plain-English sentence when status is not in_contract, else null>"
    }
  ]` : 'null'},
  "taxFindings": [
    {
      "where": "<which document/page/line this appears on>",
      "description": "<what is being taxed>",
      "amount": <number or null>,
      "detail": "<plain English: what you found and why it matters>"
    }
  ],
  "unallowableFindings": [
    {
      "contractItem": "<which unallowable item from the contract this matches>",
      "where": "<which document/page/line this appears on>",
      "amount": <number or null>,
      "detail": "<plain English: what is being billed and which contract term it conflicts with>"
    }
  ],
  "backupCoverage": "<plain English: what backup documentation was actually present, and what is billed but has no backup at all. Or null if you cannot tell.>",
  "notes": "<anything else a PM auditing this should look at, or null>"
}

Rules:
${scopeBaseline ? `- "scopeComparison": every line item on the CURRENT application must appear exactly once.
  Match lines to the schedule of values by meaning, not exact wording ("Elec rough-in" and
  "Electrical rough in" are the same item). "in_contract" = matches a scheduled line at the
  same value; "changed" = matches a scheduled line but its scheduled value differs from the
  agreed amount; "covered_by_co" = not in the original schedule but plausibly covered by one
  of the approved change orders listed (name it); "not_in_contract" = no scheduled match and
  no change order covers it — these are the ones the PM must challenge.
` : ''}- ${contractTerms?.taxExempt === true
    ? 'This project IS tax exempt. Report EVERY instance of sales/use tax you can find charged anywhere in these documents — on the pay application itself or on any receipt or invoice in the backup. This is the single most important thing to catch.'
    : contractTerms?.taxExempt === false
      ? 'This project is NOT tax exempt, so tax is expected. Only report tax that looks wrong (e.g. wrong rate, tax charged twice). Do not report ordinary correct tax.'
      : 'The contract does not state the tax status. Report any tax you find, and note that the PM must confirm whether it is allowed — do not assert that it is wrong.'}
- For "unallowableFindings", only report costs matching an item in the contract's
  unallowableItems list above. Do NOT invent unallowable items from general practice —
  if this contract does not forbid it, it is not a finding.
- Ground every finding in something actually visible in the documents. Quote or cite where
  you saw it. If you cannot point to it, leave it out.
- Dollar amounts are plain numbers (no "$", no commas).
- Return empty arrays if you find nothing. An empty result is a good, useful answer — a
  false flag costs the PM real time and erodes trust in every other finding.
- Write "detail" in plain English for a reader who is not in construction accounting.`;
}

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    // Raised from 8000 when the scope comparison was added — its table returns one
    // row per G703 line item.
    max_tokens: 12000,
    messages: [{ role: 'user', content }],
  });
}

// Scans the pay application and any separate backup documents against the project's
// stored contract terms. Runs as its own call rather than being folded into
// payAppExtract: that extraction already runs near its token ceiling on large
// continuation sheets, and making it also read backup would break extraction on
// exactly the biggest pay apps.
//
// Returns advisory findings — this is a model reading documents and exercising
// judgment, not arithmetic. The caller renders it separately from the math checks.
async function scanCompliance({ payAppBuffer, backupBuffers = [], contractTerms, scopeBaseline = null, currentItems = null, coLog = null }) {
  // Runs with contract terms (tax + unallowable review), a scope baseline (in/out-of-
  // contract comparison), or both. With neither there is nothing to audit against.
  if (!contractTerms && !scopeBaseline) return null;

  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: payAppBuffer.toString('base64') } },
  ];
  for (const buf of backupBuffers) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
  }
  content.push({ type: 'text', text: buildPrompt({ contractTerms, scopeBaseline, currentItems, coLog }) });

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
    // Don't fail the whole review over the advisory half — the math checks are the
    // load-bearing part and they have already run.
    return {
      scopeComparison: null, scopeSource: null,
      taxFindings: [], unallowableFindings: [], backupCoverage: null,
      notes: 'The contract compliance scan was cut off — there was more backup documentation than could be read in one pass. The math checks above are unaffected, but the compliance review is incomplete.',
      incomplete: true,
    };
  }

  const parsed = safeJsonFromText(response.content[0].text);
  if (response.usage) {
    console.log(`[compliance scan] in=${response.usage.input_tokens} out=${response.usage.output_tokens} tokens`);
  }
  return {
    scopeComparison: scopeBaseline && Array.isArray(parsed.scopeComparison)
      ? parsed.scopeComparison.filter(r => r && r.description)
      : null,
    scopeSource: scopeBaseline ? scopeBaseline.source : null,
    taxFindings: Array.isArray(parsed.taxFindings) ? parsed.taxFindings : [],
    unallowableFindings: Array.isArray(parsed.unallowableFindings) ? parsed.unallowableFindings : [],
    backupCoverage: parsed.backupCoverage || null,
    notes: parsed.notes || null,
    incomplete: false,
  };
}

module.exports = { scanCompliance };
