const { splitPdf, analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// One pay-application's worth of fields (used for both "current" and "previous" below).
// NOTE: summary fields are nested under "summary" — payAppChecks.js, payAppReport.js, and
// the frontend all read e.g. current.summary.line8, so this nesting must stay in sync with them.
//
// Declared as a tool schema rather than described in the prompt: a continuation-sheet
// description like '6" CW piping' would otherwise end the JSON string on the inch mark and
// lose the whole extraction. See lib/aiJson.js.
const COLUMN_ROW = extra => ({
  type: 'object',
  properties: {
    ...extra,
    c: { type: 'number' }, d: { type: 'number' }, e: { type: 'number' },
    f: { type: 'number' }, g: { type: 'number' }, h: { type: 'number' },
  },
});

function payAppShape(withSubBreakdowns) {
  const shape = {
    type: 'object',
    properties: {
      summary: {
        type: 'object',
        properties: {
          applicationNumber: { type: 'integer' },
          periodTo: {
            type: 'string',
            description: 'The date the application period ends, YYYY-MM-DD if possible, else as printed.',
          },
          projectName: { type: 'string' },
          contractDate: { type: 'string' },
          line1: { type: 'number', description: 'Original Contract Sum.' },
          line2: { type: 'number', description: 'Net change by Change Orders. Can be negative.' },
          line3: { type: 'number', description: 'Contract Sum to Date.' },
          line4: { type: 'number', description: 'Total Completed & Stored to Date.' },
          line5aRate: { type: 'number', description: 'Retainage rate on completed work, a decimal — 10% is 0.10.' },
          line5aAmount: { type: 'number', description: 'Line 5a dollar amount.' },
          line5bRate: { type: 'number', description: 'Retainage rate on stored materials, a decimal.' },
          line5bAmount: { type: 'number', description: 'Line 5b dollar amount.' },
          line5: { type: 'number', description: 'Total Retainage.' },
          line6: { type: 'number', description: 'Total Earned Less Retainage.' },
          line7: { type: 'number', description: 'Less Previous Certificates for Payment.' },
          line8: { type: 'number', description: 'Current Payment Due.' },
          line9: { type: 'number', description: 'Balance to Finish Including Retainage.' },
          changeOrderSummary: {
            type: 'object',
            description: 'Omit if the form shows no change-order summary block.',
            properties: {
              additions: { type: 'number' },
              deductions: { type: 'number' },
              net: { type: 'number' },
            },
          },
        },
      },
      lineItems: {
        type: 'array',
        items: COLUMN_ROW({
          itemNo: { type: 'string', description: 'Item number as printed.' },
          description: { type: 'string' },
          pctComplete: {
            type: 'number',
            description: 'The %(G/C) column as printed, a number like 65 for 65%.',
          },
          retainage: {
            type: 'number',
            description: 'The per-line retainage column I amount, if a variable rate is used.',
          },
        }),
      },
      grandTotalRow: {
        ...COLUMN_ROW({}),
        description: 'Omit if no explicit grand-total row exists separate from the line items.',
      },
      pageSubtotals: {
        type: 'array',
        description: 'Omit if the document is a single page or per-page subtotals are not printed.',
        items: COLUMN_ROW({ page: { type: 'number' } }),
      },
      coBreakdown: {
        type: 'array',
        description: 'Omit if there is no itemized change-order breakdown section.',
        items: {
          type: 'object',
          properties: { coNumber: { type: 'string' }, amount: { type: 'number' } },
        },
      },
    },
    required: ['summary', 'lineItems'],
  };

  // Subcontractor cost-breakdown sections appear after the continuation sheet in many pay
  // apps: a per-sub page detailing the amount that appears as a single line on the G703.
  // Only extracted for the CURRENT application — the previous app's breakdowns feed nothing.
  if (withSubBreakdowns) {
    shape.properties.subBreakdowns = {
      type: 'array',
      description: 'Empty if the document contains no subcontractor cost-breakdown sections.',
      items: {
        type: 'object',
        properties: {
          subName: {
            type: 'string',
            description: 'Name of the subcontractor or vendor this breakdown belongs to.',
          },
          matchesItemNo: {
            type: 'string',
            description: 'The continuation-sheet item number this breakdown supports, if stated '
              + 'or inferable.',
          },
          matchesDescription: {
            type: 'string',
            description: 'The continuation-sheet line description it supports.',
          },
          basis: {
            type: 'string',
            enum: ['this-period', 'to-date', 'unclear'],
            description: '"this-period" if the breakdown covers the amount billed this period, '
              + '"to-date" if it covers the total billed to date.',
          },
          statedTotal: { type: 'number', description: 'The total printed on the breakdown itself.' },
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                amount: { type: 'number' },
                vendor: {
                  type: 'string',
                  description: 'The vendor or subcontractor named on this row, if one is named.',
                },
                ref: {
                  type: 'string',
                  description: 'The invoice or draw number printed on the row, exactly as shown — '
                    + '"225020-003-2", "64328", "AR847666". Copy it character for character; the '
                    + 'FORMAT of this reference is itself checked, so a tidied-up version is worse '
                    + 'than none.',
                },
                category: {
                  type: 'string',
                  description: 'The heading this row sits under on the breakdown — SUBCONTRACTS, '
                    + 'LABOR, MATERIAL PURCHASES, EQUIPMENT, OTHER. Copy the heading as printed.',
                },
                date: { type: 'string', description: 'Row date, YYYY-MM-DD if possible.' },
              },
            },
          },
        },
        required: ['subName'],
      },
    };

    // The contractor's own invoice summary — the block that states the cost base, the fee and its
    // rate, the total and the retainage. Every figure on it is recomputed, so it is worth having.
    shape.properties.contractorInvoice = {
      type: 'object',
      description: 'Omit unless the contractor encloses its own invoice with a summary block.',
      properties: {
        feeBase: { type: 'number', description: 'The cost figure the fee is calculated on.' },
        feeRate: { type: 'number', description: 'Fee rate as a decimal — 1.90% is 0.019.' },
        fee: { type: 'number' },
        invoiceTotal: { type: 'number' },
        retainage: { type: 'number' },
        currentDue: { type: 'number' },
      },
    };

    // Subcontractor applications enclosed in the package. These are what let a schedule line be
    // traced to the company that actually did the work.
    shape.properties.subApplications = {
      type: 'array',
      description: "Empty if the package encloses no subcontractor applications of their own.",
      items: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          applicationNumber: { type: 'string' },
          commitment: {
            type: 'string',
            description: 'The commitment or subcontract number, e.g. "225020-003". Exactly as printed.',
          },
          contractFor: { type: 'string', description: 'The scope named on their application.' },
          contractSum: { type: 'number', description: 'Their contract sum to date, including changes.' },
          previous: { type: 'number', description: 'Their line 7 / from-previous-applications figure.' },
          thisPeriod: { type: 'number', description: 'What they billed for THIS period only.' },
          totalToDate: { type: 'number' },
          retainage: { type: 'number', description: 'Total retainage withheld from them to date.' },
          retainageRate: { type: 'number', description: 'As a decimal.' },
          balanceToFinish: { type: 'number', description: 'Their balance to finish, if their sheet prints one.' },
          currentDue: { type: 'number' },
          // The subcontractor's own sheet is frequently divided — base contract rows under one
          // cost code, an approved change under another — and that division is usually the same
          // division as the owner's schedule. Capturing the group totals lets the review say WHICH
          // piece of a subcontract is billed where, rather than only that the whole ties.
          groups: {
            type: 'array',
            description: 'If their continuation sheet separates its rows into groups — by cost '
              + 'code, contract-change number, or a subtotal line — give one entry per group with '
              + "that group's column totals. Omit entirely if the sheet is one undivided list. Do "
              + 'not list individual rows here; only groups.',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'The cost code or change number the group carries.' },
                description: { type: 'string' },
                scheduledValue: { type: 'number' },
                previous: { type: 'number' },
                thisPeriod: { type: 'number' },
                totalToDate: { type: 'number' },
                retainage: { type: 'number' },
              },
            },
          },
        },
        required: ['vendor'],
      },
    };

    // Lien waivers. What the owner is buying with the payment is the release of a lien, so which
    // parties released, for how much, and through what date is checked as closely as the money.
    shape.properties.waivers = {
      type: 'array',
      description: 'Empty if the package encloses no lien waivers or releases.',
      items: {
        type: 'object',
        properties: {
          party: { type: 'string', description: 'The company releasing its liens.' },
          role: { type: 'string', enum: ['contractor', 'subcontractor', 'supplier'] },
          type: {
            type: 'string',
            description: 'What the document actually does, from its own wording. "conditional-*" '
              + 'releases the lien only WHEN payment is received; "unconditional-*" states payment '
              + 'HAS been received; "affidavit-of-bills-paid" swears everyone downstream is paid. '
              + 'One document often does two of these at once — a Texas contractor\'s release '
              + 'commonly swears bills are paid AND releases conditionally on the new payment — so '
              + 'join both with "+", e.g. "conditional-progress+affidavit-of-bills-paid".',
          },
          through: {
            type: 'string',
            description: 'The through/payment date — liens are released only for work before it. '
              + 'YYYY-MM-DD if possible.',
          },
          amount: { type: 'number', description: 'The amount the release covers.' },
          schedule: {
            type: 'object',
            description: 'Omit unless the release prints its own schedule for payment.',
            properties: {
              contractAmount: { type: 'number' },
              completedToDate: { type: 'number' },
              retainage: { type: 'number' },
              earnedLessRetainage: { type: 'number' },
              previousPayments: { type: 'number' },
              amountNowPayable: { type: 'number' },
            },
          },
          signedBy: { type: 'string', description: 'Name on the signature line. Omit if unsigned.' },
          signedTitle: { type: 'string' },
          signedOn: { type: 'string' },
          notarised: { type: 'boolean', description: 'True only if a notary actually acknowledged it.' },
          notaryDate: { type: 'string' },
          onRecordOnly: {
            type: 'boolean',
            description: 'True when the package only PROVES a waiver exists — an audit trail '
              + 'listing it as uploaded — without reproducing the document. Say so rather than '
              + 'inventing its figures: a waiver that cannot be read is not a waiver that passed.',
          },
          page: { type: 'number' },
        },
        required: ['party'],
      },
    };

    // Sales tax on backup invoices, which matters when the owner is a public body.
    shape.properties.taxes = {
      type: 'array',
      description: 'Empty if no backup invoice shows a separate sales tax line.',
      items: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          ref: { type: 'string', description: 'Invoice number.' },
          amount: { type: 'number', description: 'The tax amount only, not the invoice total.' },
          // Whether the owner owes a tax depends on what was bought, not on the tax itself. Two
          // identical $412.50 charges get opposite answers when one is a rented lift and the
          // other is office furniture, and the only thing that can tell them apart is what the
          // invoice says it is selling.
          description: {
            type: 'string',
            description: 'What the invoice is charging for, in its own words — "Crane rental '
              + '4/1-4/30", "Office furniture", "Diesel fuel". This decides who owes the tax, so '
              + 'copy the wording rather than summarising it.',
          },
          category: {
            type: 'string',
            enum: ['consumable', 'furnishing', 'material', 'rental', 'labor', 'freight'],
            description: 'Only when the DOCUMENT makes it plain — a rental agreement, a line '
              + 'under a "Consumables" heading, a delivery ticket. Omit when you are inferring '
              + 'from the description alone; the review infers too, and says so when it does, '
              + 'which a stated category would wrongly suppress.',
          },
          taxableBase: {
            type: 'number',
            description: 'The amount the tax was charged on, if the invoice states it separately.',
          },
          rate: { type: 'number', description: 'The tax rate as a decimal — 8.25% is 0.0825.' },
          code: { type: 'string', description: 'Cost code the charge is booked to, if shown.' },
          inFeeBase: {
            type: 'boolean',
            description: "True only if the contractor's fee is visibly calculated on a total that "
              + 'includes this tax.',
          },
        },
      },
    };

    // THE BACKUP ITSELF.
    //
    // Everything the contractor encloses to prove a cost: invoices, receipts, rental statements,
    // permit fees. Two whole review passes read this and nothing else, so when it is missing they
    // stand down and the report says nothing was submitted — which, for a package with fifty
    // pages of invoices bound into it, is simply false.
    shape.properties.backupDocuments = {
      type: 'array',
      description: 'Every invoice, receipt or statement enclosed as backup. Empty only if the '
        + 'package genuinely contains none.',
      items: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          ref: { type: 'string', description: 'Invoice or receipt number, exactly as printed.' },
          date: { type: 'string', description: 'YYYY-MM-DD if possible.' },
          amount: { type: 'number', description: 'The document total.' },
          tax: { type: 'number', description: 'Sales tax shown separately, if any.' },
          description: { type: 'string', description: 'What was bought, in the document\'s words.' },
          supportsItemNo: {
            type: 'string',
            description: 'The schedule-of-values item number or cost code this document supports, '
              + 'if the package makes it clear — a cost code stamped on it, or the breakdown '
              + 'section it sits under. Omit rather than guess: a document tied to the wrong line '
              + 'produces a confident finding about a line that is perfectly fine.',
          },
          supportsLine: {
            type: 'string',
            description: 'The schedule-of-values line description it supports, if stated.',
          },
          excludedThisPeriod: {
            type: 'boolean',
            description: 'True if the document is annotated as NOT billed on this application — '
              + '"not included this month", "next pay app", or similar.',
          },
          excludedAmount: { type: 'number', description: 'The part excluded, if only part is.' },
          note: { type: 'string', description: 'Any handwritten annotation, transcribed.' },
          page: { type: 'number' },
        },
      },
    };

    // A job-cost transaction report, when the contractor encloses one. It prints its own total,
    // which is what makes a complete read provable rather than assumed.
    shape.properties.costReports = {
      type: 'array',
      description: 'Empty unless the package encloses a job-cost or transaction report.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'What the report covers, short — "GC", "Cost of Work", "General Conditions".',
          },
          printedTotal: {
            type: 'number',
            description: 'The grand total the report prints for itself. Important: it is what '
              + 'proves every row was read.',
          },
          transactions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: {
                  type: 'string',
                  description: 'The posting type column — AP, PY, JC, EM. Copy it as printed; it '
                    + 'distinguishes a vendor invoice from an internal allocation.',
                },
                date: { type: 'string' },
                vendor: { type: 'string' },
                ref: { type: 'string', description: 'Invoice or draw reference, exactly as printed.' },
                description: { type: 'string' },
                amount: { type: 'number' },
                quantity: { type: 'number', description: 'Hours or units, when the row shows them.' },
                costCode: { type: 'string' },
                costCodeName: { type: 'string' },
                removed: {
                  type: 'boolean',
                  description: 'True if the row or its cost code is annotated as removed from '
                    + 'this billing ("Cost Removed").',
                },
              },
            },
          },
        },
      },
    };

    // How much of the package is backup at all. Without it, "no backup was submitted" and "the
    // backup could not be read" are indistinguishable in the report — and they are completely
    // different statements to put in front of a contractor.
    shape.properties.backupPageCount = {
      type: 'number',
      description: 'Roughly how many pages after the pay application itself are backup of any '
        + 'kind — invoices, receipts, cost reports, subcontractor applications, lien waivers. '
        + '0 if the package is the application alone.',
    };
  }
  return shape;
}

function payAppTool(hasPrevious) {
  const properties = { current: payAppShape(true) };
  if (hasPrevious) properties.previous = payAppShape(false);
  return {
    name: 'record_pay_application',
    description: 'Transcribe a contractor pay application exactly as printed.',
    input_schema: { type: 'object', properties, required: ['current'] },
  };
}

function buildPrompt(hasPrevious) {
  return `You are reading contractor Application(s) and Certificate(s) for Payment (AIA G702-style summary sheet plus G703-style continuation sheet, or an equivalent format) for a construction project.

${hasPrevious
    ? 'You are given TWO documents: the FIRST is the CURRENT (most recent) pay application, the SECOND is the PREVIOUS pay application. Extract both, fully and independently.'
    : 'You are given ONE document: the CURRENT pay application. No previous application was supplied.'}

Extract every field exactly as it appears — do not compute, correct, or round anything, just transcribe the numbers. Be thorough: process every page of the continuation sheet and include every line item, even if there are many. Do not summarize, skip, or truncate line items to save space.

Lines 1-9 on the summary/cover sheet are almost always printed explicitly somewhere on the page — look carefully for all of them, even if the exact wording or layout differs slightly from a standard AIA G702 form (for example "Total Earned to Date" or "Total Completed to Date" both mean the same thing as Line 4; "Amount Due This Application" or "Current Payment Due" both mean Line 8; "Balance to Finish" or "Remaining Balance" both mean Line 9). Only omit a line if it truly does not appear anywhere on the page — do not give up early on these nine fields, they matter more than any other field on the document.

Transcribe it with the record_pay_application tool.

Rules:
- If a field cannot be found with confidence, omit it (never write "Not specified" — this data feeds arithmetic checks, so a missing number must be missing, not a string).
- All dollar amounts are plain numbers (no "$", no commas).
- Rates are decimals (10% -> 0.10), not the number 10.
- If a continuation sheet spans multiple pages, include every line item from every page in that application's single "lineItems" array, in order.
- Do not skip any line item, including subtotal-only rows unless they are clearly a page subtotal (put those in pageSubtotals, not lineItems) or the final grand total (put that in grandTotalRow, not lineItems).
- Never merge or average line items to shorten the response — every row on the continuation sheet must appear.
- "subBreakdowns" (current application only): capture EVERY subcontractor or vendor cost-breakdown section that appears after the continuation sheet — these detail the amount shown as a single line on the G703. Read "basis" from the breakdown's own wording (a heading like "this period" or "billed to date"); use "unclear" rather than guessing. Include every component row. If the document has no such sections, use [].
- On every component row, copy the invoice or draw reference EXACTLY as printed — "225020-003-2", "64328", "AR847666". The format of that reference is itself checked (a commitment draw looks different from a vendor invoice number), so a cleaned-up or reformatted reference is worse than no reference at all. Record the heading each row sits under as "category".
- "subApplications": if the package encloses subcontractors' OWN applications for payment — their G702/G703 addressed to the contractor rather than to the owner — record each one. These are usually behind the contractor's invoice. Take "thisPeriod" from their THIS PERIOD column only, never their total to date. Record EVERY column total their sheet prints — contract sum, previous, this period, to date, balance to finish and retainage — even when some repeat figures you have already recorded elsewhere. The review adds a subcontractor's columns up against the owner's schedule to find scope that is billed in two separate places, and it can only do that with the whole row; a missing column is a check that cannot run.
- "contractorInvoice": if the contractor encloses its own invoice with a summary block stating a cost base, a fee and its rate, a total and retainage, record those figures.
- "taxes": if any backup invoice or subcontractor breakdown shows a separate sales or use tax line, record the tax amount only — not the invoice total — and record WHAT THE CHARGE IS FOR in its own words. That description decides who owes the tax: on most contracts the tax on equipment RENTED for the job (a crane, a tractor, a lift, portable toilets) is a reimbursable job cost, while the tax on things bought and consumed or kept (fuel, blades, safety supplies, furniture, tools) is the contractor's or subcontractor's own cost. The review makes that call, and it can only make it from the wording. Record the taxable base and rate whenever the invoice prints them.
- "waivers": record every lien waiver, release or affidavit of bills paid in the package. Read "type" from what the document DOES, not its title — a page headed "Release of Liens" that swears all bills are paid AND releases on disbursement is both, so name both. If the package contains only an audit trail or transmittal showing a waiver was submitted, record it with onRecordOnly true and no amount; do not invent figures for a document you cannot see.
- "backupDocuments": record EVERY invoice, receipt and statement enclosed as backup, one entry each — these are usually bound in behind the pay application rather than sent separately. Set "supportsItemNo" only when the package actually says which line a document belongs to (a cost code stamped on it, or the breakdown section it sits under); omit it rather than guessing, because a document tied to the wrong line produces a confident finding about a line that is perfectly correct. Transcribe any handwritten annotation into "note", and set "excludedThisPeriod" when the annotation says the cost is not being billed this month.
- "costReports": if a job-cost or transaction report is enclosed, record its rows and — this matters more than any single row — the grand total it prints for itself, which is what proves the read was complete.
- "backupPageCount": roughly how many pages of the package are backup rather than the application itself. This is how the review tells "no backup was submitted" apart from "backup was submitted and could not be read", which are very different things to tell a contractor.`;
}

const TOO_MANY_LINE_ITEMS = 'These pay applications have too many line items to extract in one '
  + 'pass (the AI response was cut off). Try again, or split the continuation sheet into a '
  + 'smaller PDF.';

// Extracts the current (and optionally previous) pay application in a SINGLE Claude call —
// sending both PDFs as separate document blocks in one message uses one API request and one
// prompt instead of two, which matters a lot given how tight per-minute rate limits can be.
//
// One automatic retry after a short wait — this account's rate limit window is narrow
// (requests/min), so a brief pause often clears it without bothering the user.
async function callClaudeWithRetry(content, hasPrevious) {
  const { data } = await askForJson({
    content,
    tool: payAppTool(hasPrevious),
    maxTokens: 20000,
    label: 'pay app extract',
    truncatedMessage: TOO_MANY_LINE_ITEMS,
  });
  return data;
}

async function analyzePayApps(currentBuffer, previousBuffer) {
  const currentParts = await splitPdf(currentBuffer);
  const previousParts = previousBuffer ? await splitPdf(previousBuffer) : [];

  // Both fit: keep the single two-document call. It costs one request instead of two, which
  // matters given how narrow this account's per-minute limit is.
  if (currentParts.length === 1 && previousParts.length <= 1) {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: currentBuffer.toString('base64') } },
    ];
    if (previousBuffer) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: previousBuffer.toString('base64') } });
    }
    content.push({ type: 'text', text: buildPrompt(!!previousBuffer) });

    const parsed = await callClaudeWithRetry(content, !!previousBuffer);
    return { current: parsed.current, previous: parsed.previous || null };
  }

  // A pay app long enough to need splitting (usually a big continuation sheet or attached
  // backup) is read one document at a time, in page-range passes. Header values come from
  // whichever pass shows them; continuation-sheet line items concatenate in page order.
  const readOne = async (buffer, context) => {
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: buildPrompt(false) + partNotice(context) },
    ];
    return (await callClaudeWithRetry(content, false)).current;
  };

  return {
    current: await analyzeInPasses(currentBuffer, readOne),
    previous: previousBuffer ? await analyzeInPasses(previousBuffer, readOne) : null,
  };
}

module.exports = { analyzePayApps };
