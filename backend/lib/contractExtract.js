const { analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// A contract clause quoted as the basis for a finding will carry the contract's own
// punctuation, quotation marks included, so this comes back through a tool call rather than
// as parsed text. See lib/aiJson.js.
const CONTRACT_TOOL = {
  name: 'record_contract_terms',
  description: 'Record the contract terms needed to audit pay applications against it.',
  input_schema: {
    type: 'object',
    properties: {
      taxExempt: { type: 'boolean', description: 'Omit if the contract is silent.' },
      taxExemptBasis: { type: 'string', description: 'Short quote or clause reference showing why.' },
      originalContractSum: { type: 'number' },
      retainageRate: { type: 'number', description: 'A decimal — 10% is 0.10.' },
      unallowableItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: {
              type: 'string',
              description: 'Short name of the cost that may NOT be billed, e.g. "Sales tax".',
            },
            basis: { type: 'string', description: 'The clause or wording that makes it unallowable.' },
          },
          required: ['item'],
        },
      },
      scheduleOfValues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            itemNo: { type: 'string', description: 'Item number as printed.' },
            description: { type: 'string', description: 'Scope line description.' },
            amount: { type: 'number' },
          },
          required: ['description'],
        },
      },
      notes: { type: 'string', description: 'Anything a PM auditing pay apps should know.' },
    },
    required: [],
  },
};

const PROMPT = `You are reviewing an executed construction contract on behalf of the owner's
project manager. Extract only the terms needed to audit subcontractor pay applications
against this contract.

Record the terms with the record_contract_terms tool.

Rules:
- "taxExempt" is true ONLY if the contract states the owner is a tax-exempt entity or that
  the work is exempt from sales/use tax. Many public entities (school districts, cities,
  universities) are exempt. If the contract is silent, omit it — do NOT guess.
- "unallowableItems" means costs this contract forbids billing for. Typical examples: sales
  tax on an exempt project, markup above a stated cap, unapproved overtime, mobilization not
  in the schedule of values, costs without backup. Include ONLY items the contract actually
  addresses — do not invent standard-practice items that this contract does not mention.
- "basis" must be grounded in the contract's own wording. If you cannot point to wording,
  leave the item out entirely.
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (10% -> 0.10).
- If a field cannot be found with confidence, omit it. Do not use the string "Not specified".
- Prefer returning fewer, well-grounded items over a long speculative list. A project manager
  will act on these, so a false flag costs them real time.
- "scheduleOfValues": ONLY if the contract includes a schedule of values, exhibit, or scope
  breakdown listing the priced items of work. Transcribe every line of it. If the contract has
  no such list, return [] — do not reconstruct one from prose scope descriptions.`;

// Extracts the auditable terms from an executed contract in a single Claude call.
// Called once per project when the contract is uploaded — the result is stored on the
// project and reused by every later pay app review, so a long contract is never
// re-sent to the model period after period.
async function readOnePass(buffer, context, usages) {
  const { data, usage } = await askForJson({
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT + partNotice(context) },
    ],
    tool: CONTRACT_TOOL,
    // Raised from 8000 when schedule-of-values extraction was added — a long SOV
    // exhibit is the largest thing this call can now be asked to transcribe.
    maxTokens: 16000,
    label: 'contract extract',
    truncatedMessage: 'A section of this contract produced more detail than one response can '
      + 'hold — most often a very long schedule of values. Try uploading the contract without '
      + 'its largest exhibit.',
  });
  if (usage) usages.push(usage);
  return data;
}

// A long contract is read in page-range passes and the terms combined, so contract length
// never blocks a project. Header terms (tax status, contract sum, retainage) come from
// whichever pass finds them; the schedule of values concatenates across passes in page order.
async function extractContractTerms(contractBuffer) {
  // Reported usage is the total across passes — a long contract genuinely costs several calls,
  // and showing only the last one would understate it.
  const usages = [];
  const parsed = await analyzeInPasses(contractBuffer, (buffer, context) =>
    readOnePass(buffer, context, usages));
  return {
    taxExempt: typeof parsed.taxExempt === 'boolean' ? parsed.taxExempt : null,
    taxExemptBasis: parsed.taxExemptBasis || null,
    originalContractSum: typeof parsed.originalContractSum === 'number' ? parsed.originalContractSum : null,
    retainageRate: typeof parsed.retainageRate === 'number' ? parsed.retainageRate : null,
    unallowableItems: Array.isArray(parsed.unallowableItems)
      ? parsed.unallowableItems.filter(i => i && i.item).map(i => ({ item: String(i.item), basis: i.basis || null }))
      : [],
    scheduleOfValues: Array.isArray(parsed.scheduleOfValues)
      ? parsed.scheduleOfValues
          .filter(i => i && i.description)
          .map(i => ({
            itemNo: i.itemNo != null ? String(i.itemNo) : null,
            description: String(i.description),
            amount: typeof i.amount === 'number' ? i.amount : null,
          }))
      : [],
    notes: parsed.notes || null,
    usage: usages.length
      ? {
          inputTokens: usages.reduce((sum, u) => sum + (u.input_tokens || 0), 0),
          outputTokens: usages.reduce((sum, u) => sum + (u.output_tokens || 0), 0),
        }
      : null,
  };
}

module.exports = { extractContractTerms };
