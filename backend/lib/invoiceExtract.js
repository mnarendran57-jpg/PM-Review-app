const { splitPdf, analyzeInPasses, partNotice, mergeExtracted } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Line descriptions on a materials invoice are full of dimensions written with inch marks, so
// this comes back through a tool call rather than as parsed text. See lib/aiJson.js.
// `hasContract` adds the one observation that needs the contract's terms: costs it forbids that a
// wording match in code would miss.
function invoiceTool(hasContract) {
  const tool = {
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
            // A professional's invoice usually carries the whole engagement's history, not only this
            // month: the total fee, and what was billed before. Read so the billing check can tell
            // what was billed under THIS purchase order from what an earlier one already covered.
            feeTotal: {
              type: 'number',
              description: 'The total fee or contract amount for the whole engagement, if the invoice '
                + 'shows one (the "Total" of a fee column). Omit if not shown.',
            },
            previouslyBilled: {
              type: 'number',
              description: 'The total billed BEFORE this invoice, if the invoice shows it ("previous '
                + 'billing", "previously invoiced", "billed to date" less this invoice). Omit if not shown.',
            },
            // The fee table: one row per phase or task, as printed. Checked in code for arithmetic.
            phases: {
              type: 'array',
              description: 'If the invoice bills by phase or task with a fee table, one entry per row, '
                + 'exactly as printed. Omit the total row. Empty if there is no such table.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  fee: { type: 'number', description: 'The phase fee.' },
                  percentComplete: { type: 'number', description: 'A decimal — 25% is 0.25.' },
                  earned: { type: 'number', description: 'Earned to date, as printed.' },
                  previouslyBilled: { type: 'number', description: 'Billed before this invoice, as printed.' },
                  current: { type: 'number', description: 'Billed on this invoice, as printed.' },
                },
                required: ['name'],
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
              description: 'Plain English, at most two short sentences: anything about the backup '
                + 'worth knowing that the per-line backup answers above do not say — a receipt that '
                + 'does not match its line, a backup total that differs from what was billed. Omit '
                + 'when there is nothing beyond what the lines already record.',
            },
            secondLook: {
              type: 'array',
              description: 'Entries on the invoice that do not look right and are worth a second look '
                + 'before paying — for example a phase billed past its percent complete, the same '
                + 'charge billed twice, a service period that overlaps an earlier invoice or falls '
                + 'outside the contract, a lump sum with no explanation where the rest is itemised, a '
                + 'line that does not belong to this project. Only what is visible on the documents. '
                + 'NOT arithmetic (checked separately), NOT general contract or purchase-order '
                + 'conditions, and NOT ordinary billing for the work the invoice is for. NOT the fee '
                + 'total or the billing to date compared with the purchase order or contract amount: '
                + 'that is checked separately, and a fee larger than the PO is usually a PO that '
                + 'replaced an earlier one. Empty when nothing stands out, which is the usual case.',
              items: {
                type: 'object',
                properties: {
                  item: { type: 'string', description: 'The line or entry, as printed.' },
                  amount: { type: 'number' },
                  why: { type: 'string', description: 'In one short plain-English sentence.' },
                },
                required: ['item', 'why'],
              },
            },
            pricingSanity: {
              type: 'string',
              description: 'Plain English, at most two short sentences: based on general construction '
                + 'cost knowledge (which may be out of date), does any unit price or total look far '
                + 'outside the normal range? Name the line. This is a prompt for the PM to check, not '
                + 'a verdict. About price levels only — do not repeat tax or anything the contract '
                + 'allows or forbids. Omit entirely when nothing stands out.',
            },
          },
        },
      },
      required: ['invoice'],
    },
  };
  if (hasContract) {
    tool.input_schema.properties.observations.properties.contractConcerns = {
      type: 'array',
      description: 'Specific lines on the invoice that the contract terms you were given forbid or '
        + 'restrict — for example a reimbursable expense the contract does not allow, a reimbursable '
        + 'billed above its agreed multiplier, an hourly rate above the agreed rate schedule, or '
        + 'overtime billed without the written direction the contract requires. Leave out sales tax, '
        + 'and leave out GENERAL purchase-order conditions — that billing must match the items and '
        + 'amounts on the PO, or may not exceed the PO total. Those are not about any one line, and '
        + 'the billing total is checked separately, including any amount carried over from an '
        + 'earlier PO. Ordinary billing for the services the agreement is for is never a concern. '
        + 'Empty when nothing on the invoice goes against the contract, which is the usual case.',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The invoice line, by its description as printed.' },
          amount: { type: 'number', description: 'The amount on that line.' },
          rule: { type: 'string', description: 'What the contract says, in one short plain-English sentence.' },
          section: { type: 'string', description: 'The section or clause it comes from, if the terms name one.' },
          quote: {
            type: 'string',
            description: 'The contract wording behind it, copied exactly from a "quote" in the terms\' '
              + '"clauses". Omit when no quote there says it — never write one of your own.',
          },
        },
        required: ['item', 'rule'],
      },
    };
  }
  return tool;
}

// The extraction returns two clearly separated things:
//  - "invoice": raw figures and structure, which feed the deterministic checks in
//    invoiceChecks.js (that math is done in code, not by the model)
//  - "observations": judgment calls only the model can make (whether a reimbursable
//    line has backup among the uploads, whether pricing looks reasonable). Advisory.
// canSeeInvoice: false when this pass starts past page 1, so the primary invoice cannot be among
// the pages in front of the model. It then has no business reporting line items at all.
function buildPrompt({ fileCount, contractTerms, canSeeInvoice = true }) {
  return `You are reviewing a vendor's invoice on behalf of the owner's project manager.
${fileCount > 1
  ? `${fileCount} documents were uploaded. ONE of them is the vendor's primary invoice — the document that requests payment. The others are backup documentation (subcontractor invoices, receipts, material tickets) that support "reimbursable" cost lines on the primary invoice.`
  : `One PDF was uploaded, and it almost certainly contains MORE than the invoice. A vendor binds
its invoice together with the backup that supports it: subcontractor invoices, delivery tickets,
filing-fee receipts, petty-cash slips. The invoice is at the FRONT — usually page 1, occasionally
the first two or three. Everything after it is backup.

Getting this distinction right is the most important thing here. Treating the whole upload as "the
invoice" is what made an earlier review read a delivery company's own invoice, bound in as backup
on a later page, as another line on the vendor's invoice — and then report that the invoice did not
add up, short by exactly that amount, on an invoice that added up perfectly.`}

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
- Read line items from the PRIMARY invoice only. Do not turn backup receipts into their own line
  items — instead use them to decide each reimbursable line's "hasBackup".
- A backup document's own total is NOT a line item, however plainly it is printed. A bound-in
  delivery or subcontractor invoice totalling $1,058.50 belongs in the "hasBackup" reasoning for
  whichever reimbursable line it supports, never in "lineItems".
- Your line items must add up to the invoice's own printed total. If they do not, you have either
  missed a line or included something that is not on the invoice — and on a package with backup
  bound in, the second is far more likely. Re-read the invoice's own summary block before reporting
  a total that disagrees with it.
- Every priced line on the primary invoice must appear in "lineItems" — do not merge rows.${canSeeInvoice ? '' : `
- IMPORTANT: these pages begin PAST the front of the document, so the primary invoice is NOT among
  them. Return an EMPTY "lineItems" array. Read these pages only for what they support, and leave
  the invoice's own figures to the pass that can actually see them.`}
- In "observations", write plain English for a reader who is not in construction. No IDs,
  no jargon. Ground every concern in something visible in the documents. Be brief, and leave a
  note out rather than fill it with something unremarkable.`;
}

// Deliberately does not suggest removing an attachment. How much backup a vendor binds in must never
// decide whether the review works, and pdfChunk already halves a pass whose answer overflows.
const TOO_MANY_LINE_ITEMS = 'This invoice carries more itemised detail than one reply can hold. '
  + 'It is being read in smaller passes instead.';

// Single Claude call: the invoice PDF(s) + the contract's stored terms as text. The
// contract PDF itself is deliberately NOT re-sent — its terms were extracted once at
// upload. All uploaded documents go in together so the model can match reimbursable
// lines on the primary invoice to their backup receipts.
async function callWithRetry(content, hasContract) {
  const { data } = await askForJson({
    content,
    tool: invoiceTool(hasContract),
    maxTokens: 12000,
    label: 'invoice extract',
    truncatedMessage: TOO_MANY_LINE_ITEMS,
  });
  return data;
}

async function analyzeInvoices({ invoiceBuffers, contractTerms }) {
  // One file at a time: splitting parses the whole PDF, and parsing every upload at once — an invoice
  // and twenty receipts — put all of them in memory together for the sake of a page count.
  let anyOversized = false;
  for (const buf of invoiceBuffers) {
    if ((await splitPdf(buf)).length > 1) { anyOversized = true; break; }
  }

  // Everything fits: keep the single call with all documents together, so the model can still
  // match reimbursable lines on the invoice to their backup receipts.
  if (!anyOversized) {
    const content = invoiceBuffers.map(buf => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    }));
    content.push({ type: 'text', text: buildPrompt({ fileCount: invoiceBuffers.length, contractTerms }) });

    const parsed = await callWithRetry(content, !!contractTerms);
    return { invoice: parsed.invoice || {}, observations: parsed.observations || {} };
  }

  // At least one document is too long to send whole. Each is read in page-range passes and
  // the extractions combined. Cross-document matching of receipts to invoice lines is weaker
  // here than in the single-call path — that is the cost of not refusing the upload.
  const readOne = async (buffer, context) => {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: buildPrompt({
        fileCount: 1,
        contractTerms,
        // Only the pass that includes page 1 can be looking at the invoice itself. Without this,
        // every later pass over backup pages dutifully reported those documents as line items, and
        // mergeExtracted concatenated them onto the invoice.
        canSeeInvoice: (context?.startPage ?? 1) <= 1,
      }) + partNotice(context) },
    ];
    return callWithRetry(content, !!contractTerms);
  };

  // One file after another. Each file's own pages are still read in parallel passes (see
  // lib/pdfChunk.js), which is where the speed is; reading every file at once as well put every
  // file's parts and encoded copies in memory together, and on a package of large scans that was
  // enough to exhaust the server. Order is preserved so merged lists stay in the order given.
  const results = [];
  for (const buffer of invoiceBuffers) results.push(await analyzeInPasses(buffer, readOne));
  const merged = mergeExtracted(results);

  return { invoice: merged.invoice || {}, observations: merged.observations || {} };
}

module.exports = { analyzeInvoices };
