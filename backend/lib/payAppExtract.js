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
              properties: { description: { type: 'string' }, amount: { type: 'number' } },
            },
          },
        },
        required: ['subName'],
      },
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
- "subBreakdowns" (current application only): capture EVERY subcontractor or vendor cost-breakdown section that appears after the continuation sheet — these detail the amount shown as a single line on the G703. Read "basis" from the breakdown's own wording (a heading like "this period" or "billed to date"); use "unclear" rather than guessing. Include every component row. If the document has no such sections, use [].`;
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
