const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      'The AI response could not be parsed as JSON — this usually means the pay application has ' +
      'so many line items that the extraction was cut off. Try again, or split the continuation sheet ' +
      `into a smaller PDF. (${err.message})`
    );
  }
}

// One pay-application's worth of fields (used for both "current" and "previous" below).
// NOTE: summary fields are nested under "summary" — payAppChecks.js, payAppReport.js, and
// the frontend all read e.g. current.summary.line8, so this nesting must stay in sync with them.
const PAY_APP_SHAPE = `{
    "summary": {
      "applicationNumber": <integer>,
      "periodTo": "<date the application period ends, ISO format YYYY-MM-DD if possible, else as printed>",
      "projectName": "<project name>",
      "contractDate": "<contract date if shown, else null>",
      "line1": <Original Contract Sum, number>,
      "line2": <Net change by Change Orders, number, can be negative>,
      "line3": <Contract Sum to Date, number>,
      "line4": <Total Completed & Stored to Date, number>,
      "line5aRate": <retainage rate on completed work as a decimal e.g. 0.10 for 10%, or null>,
      "line5aAmount": <Line 5a dollar amount, or null>,
      "line5bRate": <retainage rate on stored materials as a decimal, or null>,
      "line5bAmount": <Line 5b dollar amount, or null>,
      "line5": <Total Retainage, number>,
      "line6": <Total Earned Less Retainage, number>,
      "line7": <Less Previous Certificates for Payment, number>,
      "line8": <Current Payment Due, number>,
      "line9": <Balance to Finish Including Retainage, number>,
      "changeOrderSummary": { "additions": <number|null>, "deductions": <number|null>, "net": <number|null> } or null if not present
    },
    "lineItems": [
      {
        "itemNo": "<item number as printed, string>",
        "description": "<description>",
        "c": <Scheduled Value>,
        "d": <Work Completed From Previous Application>,
        "e": <Work Completed This Period>,
        "f": <Materials Presently Stored>,
        "g": <Total Completed and Stored to Date>,
        "pctComplete": <the %(G/C) column as printed, a number like 65 for 65%, or null>,
        "h": <Balance to Finish>,
        "retainage": <the per-line retainage column I amount if a variable rate is used, else null>
      }
    ],
    "grandTotalRow": { "c": <number>, "d": <number>, "e": <number>, "f": <number>, "g": <number>, "h": <number> } or null if no explicit grand-total row exists separate from the line items,
    "pageSubtotals": [ { "page": <number>, "c": <number>, "d": <number>, "e": <number>, "f": <number>, "g": <number>, "h": <number> } ] or null if the document is a single page or subtotals per page are not printed,
    "coBreakdown": [ { "coNumber": "<CO number>", "amount": <number> } ] or null if there is no itemized change-order breakdown section
  }`;

function buildPrompt(hasPrevious) {
  return `You are reading contractor Application(s) and Certificate(s) for Payment (AIA G702-style summary sheet plus G703-style continuation sheet, or an equivalent format) for a construction project.

${hasPrevious
    ? 'You are given TWO documents: the FIRST is the CURRENT (most recent) pay application, the SECOND is the PREVIOUS pay application. Extract both, fully and independently.'
    : 'You are given ONE document: the CURRENT pay application. No previous application was supplied.'}

Extract every field exactly as it appears — do not compute, correct, or round anything, just transcribe the numbers. Be thorough: process every page of the continuation sheet and include every line item, even if there are many. Do not summarize, skip, or truncate line items to save space.

Lines 1-9 on the summary/cover sheet are almost always printed explicitly somewhere on the page — look carefully for all of them, even if the exact wording or layout differs slightly from a standard AIA G702 form (for example "Total Earned to Date" or "Total Completed to Date" both mean the same thing as Line 4; "Amount Due This Application" or "Current Payment Due" both mean Line 8; "Balance to Finish" or "Remaining Balance" both mean Line 9). Only use null for a line if it truly does not appear anywhere on the page — do not give up early on these nine fields, they matter more than any other field on the document.

Respond with ONLY a raw JSON object (no markdown, no commentary) matching this exact shape:

{
  "current": ${PAY_APP_SHAPE},
  "previous": ${hasPrevious ? PAY_APP_SHAPE : 'null'}
}

Rules:
- If a field cannot be found with confidence, use null (not "Not specified" — this data feeds arithmetic checks, so nulls must be real nulls, not strings).
- All dollar amounts are plain numbers (no "$", no commas).
- Rates are decimals (10% -> 0.10), not the number 10.
- If a continuation sheet spans multiple pages, include every line item from every page in that application's single "lineItems" array, in order.
- Do not skip any line item, including subtotal-only rows unless they are clearly a page subtotal (put those in pageSubtotals, not lineItems) or the final grand total (put that in grandTotalRow, not lineItems).
- Never merge or average line items to shorten the response — every row on the continuation sheet must appear.`;
}

async function callClaude(content) {
  return client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 20000,
    messages: [{ role: 'user', content }]
  });
}

async function callClaudeWithRetry(content) {
  try {
    return await callClaude(content);
  } catch (err) {
    if (err.status === 429) {
      // One automatic retry after a short wait — this account's rate limit window is
      // narrow (requests/min), so a brief pause often clears it without bothering the user.
      await new Promise(resolve => setTimeout(resolve, 20000));
      return callClaude(content);
    }
    throw err;
  }
}

// Extracts the current (and optionally previous) pay application in a SINGLE Claude call —
// sending both PDFs as separate document blocks in one message uses one API request and one
// prompt instead of two, which matters a lot given how tight per-minute rate limits can be.
async function analyzePayApps(currentBuffer, previousBuffer) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: currentBuffer.toString('base64') } },
  ];
  if (previousBuffer) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: previousBuffer.toString('base64') } });
  }
  content.push({ type: 'text', text: buildPrompt(!!previousBuffer) });

  const response = await callClaudeWithRetry(content);

  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      'These pay applications have too many line items to extract in one pass (the AI response was cut off). ' +
      'Try again, or split the continuation sheet into a smaller PDF.'
    );
  }

  const parsed = safeJsonFromText(response.content[0].text);
  return { current: parsed.current, previous: parsed.previous || null };
}

module.exports = { analyzePayApps };
