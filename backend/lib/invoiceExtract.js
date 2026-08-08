const { splitPdf, analyzeInPasses, partNotice, mergeExtracted } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Line descriptions on a materials invoice are full of dimensions written with inch marks, so
// this comes back through a tool call rather than as parsed text. See lib/aiJson.js.
const INVOICE_TOOL = {
  name: 'record_invoice_review',
  description: 'Record an invoice\'s figures and what is worth the PM\'s attention.',
  input_schema: {
    type: 'object',
    properties: {
      invoice: {
        type: 'object',
        properties: {
          vendor: { type: 'string', description: 'Who issued the invoice.' },
          invoiceNumber: { type: 'string' },
          invoiceDate: { type: 'string', description: 'YYYY-MM-DD.' },
          poNumber: { type: 'string', description: 'Referenced PO number.' },
          subtotal: { type: 'number' },
          taxAmount: { type: 'number' },
          taxRate: { type: 'number', description: 'A decimal — 8.25% is 0.0825.' },
          total: { type: 'number' },
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
                isReimbursable: { type: 'boolean' },
                hasBackup: {
                  type: 'boolean',
                  description: 'True if a matching backup receipt/invoice for this reimbursable '
                    + 'line is present among the uploaded documents; false if this is '
                    + 'reimbursable but no backup was found. Omit if the line is not reimbursable.',
                },
                backupNote: {
                  type: 'string',
                  description: 'Which uploaded document backs this line, or what is missing.',
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
          reimbursableBackup: {
            type: 'string',
            description: 'Plain English: which reimbursable line items have proper backup and '
              + 'which do not. Name the specific lines. Omit if there are no reimbursable lines.',
          },
          unallowable: {
            type: 'string',
            description: 'Plain English: does anything on the invoice bill for a cost the '
              + 'contract does not allow? Name the line and the contract basis.',
          },
          pricingSanity: {
            type: 'string',
            description: 'Plain English: based on general construction cost knowledge (which may '
              + 'be out of date), do any unit prices or totals look far outside the normal range? '
              + 'Be specific. This is a prompt for the PM to check, not a verdict.',
          },
        },
      },
    },
    required: ['invoice'],
  },
};

// The extraction returns two clearly separated things:
//  - "invoice": raw figures and structure, which feed the deterministic checks in
//    invoiceChecks.js (that math is done in code, not by the model)
//  - "observations": judgment calls only the model can make (whether a reimbursable
//    line has backup among the uploads, whether pricing looks reasonable). Advisory.
function buildPrompt({ fileCount, contractTerms }) {
  return `You are reviewing a vendor's invoice on behalf of the owner's project manager.
${fileCount > 1
  ? `${fileCount} documents were uploaded. ONE of them is the vendor's primary invoice — the document that requests payment. The others are backup documentation (subcontractor invoices, receipts, material tickets) that support "reimbursable" cost lines on the primary invoice.`
  : 'One document was uploaded: the vendor\'s invoice.'}

${contractTerms ? `The executed contract's relevant terms (already verified by the PM):
${JSON.stringify(contractTerms, null, 2)}
` : ''}A "reimbursable" (or "cost-plus" / "pass-through" / "T&M") line is a cost the vendor
paid and is passing through to the owner — travel, materials, equipment rental,
subcontractor cost, permits, etc. These normally require a backup receipt or invoice.
A line billed against a fixed contract amount, lump-sum, or unit price is NOT reimbursable.

Record what you find with the record_invoice_review tool.

Rules:
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (8.25% -> 0.0825).
- If a field cannot be found with confidence, omit it. Never invent a number.
- Read line items from the PRIMARY invoice only. Do not turn backup receipts into their own line items — instead use them to decide each reimbursable line's "hasBackup".
- Every priced line on the primary invoice must appear in "lineItems" — do not merge rows.
- In "observations", write plain English for a reader who is not in construction. No IDs,
  no jargon. Ground every concern in something visible in the documents.`;
}

const TOO_MANY_LINE_ITEMS = 'This invoice has more itemised detail than one response can hold. '
  + 'Try uploading it without its largest backup attachment.';

// Single Claude call: the invoice PDF(s) + the contract's stored terms as text. The
// contract PDF itself is deliberately NOT re-sent — its terms were extracted once at
// upload. All uploaded documents go in together so the model can match reimbursable
// lines on the primary invoice to their backup receipts.
async function callWithRetry(content) {
  const { data } = await askForJson({
    content,
    tool: INVOICE_TOOL,
    maxTokens: 12000,
    label: 'invoice extract',
    truncatedMessage: TOO_MANY_LINE_ITEMS,
  });
  return data;
}

async function analyzeInvoices({ invoiceBuffers, contractTerms }) {
  const parts = await Promise.all(invoiceBuffers.map(buf => splitPdf(buf)));
  const anyOversized = parts.some(p => p.length > 1);

  // Everything fits: keep the single call with all documents together, so the model can still
  // match reimbursable lines on the invoice to their backup receipts.
  if (!anyOversized) {
    const content = invoiceBuffers.map(buf => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    }));
    content.push({ type: 'text', text: buildPrompt({ fileCount: invoiceBuffers.length, contractTerms }) });

    const parsed = await callWithRetry(content);
    return { invoice: parsed.invoice || {}, observations: parsed.observations || {} };
  }

  // At least one document is too long to send whole. Each is read in page-range passes and
  // the extractions combined. Cross-document matching of receipts to invoice lines is weaker
  // here than in the single-call path — that is the cost of not refusing the upload.
  const readOne = async (buffer, context) => {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: buildPrompt({ fileCount: 1, contractTerms }) + partNotice(context) },
    ];
    return callWithRetry(content);
  };

  const results = [];
  for (const buffer of invoiceBuffers) results.push(await analyzeInPasses(buffer, readOne));
  const merged = mergeExtracted(results);

  return { invoice: merged.invoice || {}, observations: merged.observations || {} };
}

module.exports = { analyzeInvoices };
