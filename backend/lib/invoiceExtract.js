const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      'The invoice could not be read back as valid data — it may be longer or more complex than one ' +
      `pass can handle. Try again, or upload just the invoice pages. (${err.message})`
    );
  }
}

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

Return ONLY valid JSON in this exact shape:

{
  "invoice": {
    "vendor": "<who issued the invoice, or null>",
    "invoiceNumber": "<string or null>",
    "invoiceDate": "<YYYY-MM-DD or null>",
    "poNumber": "<referenced PO number, or null>",
    "subtotal": <number or null>,
    "taxAmount": <number or null>,
    "taxRate": <decimal or null>,
    "total": <number or null>,
    "lineItems": [
      { "description": "<string>",
        "qty": <number or null>,
        "unit": "<string or null>",
        "unitPrice": <number or null>,
        "total": <number or null>,
        "isReimbursable": <true | false | null>,
        "hasBackup": <true if a matching backup receipt/invoice for this reimbursable line is present among the uploaded documents; false if this is reimbursable but no backup was found; null if the line is not reimbursable>,
        "backupNote": "<which uploaded document backs this line, or what is missing — or null>" }
    ]
  },
  "observations": {
    "reimbursableBackup": "<plain-English: which reimbursable line items have proper backup and which do not. Name the specific lines. Or null if there are no reimbursable lines.>",
    "unallowable": "<plain-English: does anything on the invoice bill for a cost the contract does not allow? Name the line and the contract basis. Or null.>",
    "pricingSanity": "<plain-English: based on general construction cost knowledge (which may be out of date), do any unit prices or totals look far outside the normal range? Be specific. This is a prompt for the PM to check, not a verdict. Or null.>"
  }
}

Rules:
- Dollar amounts are plain numbers (no "$", no commas). Rates are decimals (8.25% -> 0.0825).
- If a field cannot be found with confidence, use null. Never invent a number.
- Read line items from the PRIMARY invoice only. Do not turn backup receipts into their own line items — instead use them to decide each reimbursable line's "hasBackup".
- Every priced line on the primary invoice must appear in "lineItems" — do not merge rows.
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

// Single Claude call: the invoice PDF(s) + the contract's stored terms as text. The
// contract PDF itself is deliberately NOT re-sent — its terms were extracted once at
// upload. All uploaded documents go in together so the model can match reimbursable
// lines on the primary invoice to their backup receipts.
async function analyzeInvoices({ invoiceBuffers, contractTerms }) {
  const content = invoiceBuffers.map(buf => ({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
  }));
  content.push({ type: 'text', text: buildPrompt({ fileCount: invoiceBuffers.length, contractTerms }) });

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
      'This invoice has too many line items to read in one pass (the AI response was cut off). ' +
      'Try uploading just the itemized pages.'
    );
  }

  const parsed = safeJsonFromText(response.content[0].text);
  if (response.usage) {
    console.log(`[invoice extract] in=${response.usage.input_tokens} out=${response.usage.output_tokens} tokens`);
  }
  return {
    invoice: parsed.invoice || {},
    observations: parsed.observations || {},
  };
}

module.exports = { analyzeInvoices };
