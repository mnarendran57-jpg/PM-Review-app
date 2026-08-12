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
      // Tax is the one term where a single boolean is not enough to review anything. The same
      // sales tax is a proper reimbursable cost or a charge the contractor must eat depending on
      // WHAT WAS BOUGHT — a rented crane and a bought desk are treated differently by most
      // contracts — and the pay app review cannot make that call without the contract's own words.
      taxRules: {
        type: 'object',
        description: 'How this contract allocates tax by type of purchase. Omit any category the '
          + 'contract does not address; silence is a valid and useful answer.',
        properties: {
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  enum: ['consumable', 'furnishing', 'material', 'rental', 'labor', 'freight'],
                  description: '"consumable" = supplies used up on the job (fuel, blades, safety '
                    + 'supplies). "furnishing" = equipment or furniture bought and kept. '
                    + '"material" = goods built into the work. "rental" = equipment hired for a '
                    + 'period and returned. ',
                },
                treatment: {
                  type: 'string',
                  enum: ['reimbursable', 'contractor-absorbs', 'exempt'],
                  description: '"reimbursable" = the owner pays this tax. "contractor-absorbs" = '
                    + 'the contractor or its subcontractor pays it and may not bill it on. '
                    + '"exempt" = the contract says no tax should arise on this at all.',
                },
                basis: {
                  type: 'string',
                  description: "The contract's own wording, quoted. Required — a treatment with "
                    + 'no wording behind it must not be recorded.',
                },
              },
              required: ['category', 'treatment', 'basis'],
            },
          },
          markupOnTaxAllowed: {
            type: 'boolean',
            description: 'Whether the contract permits the fee or markup to be taken on tax. Omit '
              + 'if silent.',
          },
          taxIncludedInContractSum: {
            type: 'boolean',
            description: 'True if the contract sum is stated to be tax-inclusive, which means tax '
              + 'billed separately on top of it is being charged twice. Omit if silent.',
          },
          exemptionCertificate: {
            type: 'boolean',
            description: 'True if the contract requires the contractor to purchase on the owner\'s '
              + 'exemption certificate. Omit if silent.',
          },
        },
      },
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
- "taxRules" is the most useful thing on this list and the most often skipped. Construction
  contracts routinely allocate sales and use tax differently depending on what was bought:
  supplies consumed on the job and equipment bought and kept are commonly the contractor's or
  subcontractor's own cost, while tax on equipment RENTED for the work is commonly a reimbursable
  job cost. Look for this in the tax article, the general conditions, the cost-of-the-work and
  reimbursable-cost clauses, and any exhibit listing allowable and non-allowable costs — it is
  frequently not in the article headed "Taxes". Record a category ONLY when you can quote the
  wording that decides it, and put that wording in "basis" verbatim. If the contract addresses tax
  in general but never distinguishes by type of purchase, record nothing here rather than spreading
  one general sentence across every category — a reviewer will act on these, and a treatment
  attributed to a clause that does not say it is worse than no treatment at all.
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

// A long contract is read in page-range passes and the results concatenated, so the same category
// can arrive twice — once from the tax article and once from the allowable-costs exhibit. Agreeing
// duplicates are harmless. Ones that DISAGREE are not: taking whichever arrived first would make
// the review quote one clause while the contract also says the opposite somewhere else. Those are
// dropped, which puts the charge back in front of a human, where a genuinely ambiguous contract
// belongs.
function dedupeCategories(list) {
  if (!Array.isArray(list)) return [];
  const clean = list
    .filter(c => c && c.category && c.treatment && c.basis)
    .map(c => ({ category: String(c.category), treatment: String(c.treatment), basis: String(c.basis) }));
  const byCategory = new Map();
  for (const c of clean) {
    const seen = byCategory.get(c.category);
    if (!seen) byCategory.set(c.category, c);
    else if (seen.treatment !== c.treatment) byCategory.set(c.category, null);   // contradiction
  }
  return [...byCategory.values()].filter(Boolean);
}

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
    // A category is kept only if it carries the contract's own wording. The review quotes that
    // wording back at the contractor, so a treatment with nothing behind it is not a rule — it is
    // an assertion the PM would have to defend without support.
    taxRules: parsed.taxRules ? {
      categories: dedupeCategories(parsed.taxRules.categories),
      markupOnTaxAllowed: typeof parsed.taxRules.markupOnTaxAllowed === 'boolean'
        ? parsed.taxRules.markupOnTaxAllowed : null,
      taxIncludedInContractSum: typeof parsed.taxRules.taxIncludedInContractSum === 'boolean'
        ? parsed.taxRules.taxIncludedInContractSum : null,
      exemptionCertificate: typeof parsed.taxRules.exemptionCertificate === 'boolean'
        ? parsed.taxRules.exemptionCertificate : null,
    } : null,
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
