const Anthropic = require('@anthropic-ai/sdk');
const { splitPdf, pageCount } = require('./pdfChunk');
const { REVIEW_ACTIONS } = require('./submittalLog');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// A submittal package is a cover sheet followed by the actual content — often hundreds of
// pages of shop drawings or a product catalogue. Everything being extracted here (who sent
// it, its number, the spec section, the A/E's stamp) is on the front of the package, so only
// the opening pages are sent. Reading the whole package would cost a great deal of the
// account's per-minute token allowance to learn nothing further, and would rate-limit a PM
// entering a stack of submittals one after another.
const COVER_PAGES = 5;

async function coverPages(buffer) {
  const parts = await splitPdf(buffer, COVER_PAGES);
  return { buffer: parts[0].buffer, totalPages: await pageCount(buffer) };
}

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`The document could not be read back as valid data. (${err.message})`);
  }
}

async function callClaude(pdfBuffer, prompt) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
    { type: 'text', text: prompt },
  ];
  const send = () => client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content }],
  });

  let response;
  try {
    response = await send();
  } catch (err) {
    if (err.status !== 429) throw err;
    await new Promise(resolve => setTimeout(resolve, 20000));
    response = await send();
  }
  return safeJsonFromText(response.content[0].text);
}

const trimmed = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
};

// A date the model read off a stamp is only useful if it is a real calendar date — anything
// else would be written straight into a date column and quietly corrupt the log's arithmetic.
const isoDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

const SUBMITTAL_PROMPT = `You are reading the cover sheet of a construction submittal that a
contractor has sent to the owner's project manager, so it can be entered into the project's
submittal log.

Return ONLY valid JSON in this exact shape:

{
  "submittalNumber": "<the submittal or transmittal number exactly as printed, e.g. \\"S-001\\", \\"23 05 00-001\\", or null>",
  "revisionNumber": <the revision number if this is a resubmittal (Rev 1, Rev 2...), 0 for a first submission, or null if not stated>,
  "specSection": "<the CSI spec section, number and title if both are shown, e.g. \\"23 05 00 — Common Work Results for HVAC\\", or null>",
  "description": "<what the submittal is FOR, in a short phrase a PM would recognise, e.g. \\"VAV boxes — product data\\" or \\"Ductwork shop drawings\\". Never null: if nothing else is available, describe what the document visibly contains.>",
  "vendor": "<the subcontractor, supplier or manufacturer who prepared or sent it, or null>",
  "submittalType": "<one of: Product Data, Shop Drawings, Samples, Test Reports, Certificates, O&M Manuals, Closeout, Other — or null if it cannot be told>",
  "dateSubmitted": "<the date the contractor dated or transmitted it, YYYY-MM-DD, or null>",
  "notes": "<anything on the cover the PM should know: a stated deadline, a substitution request, a partial submission — or null>"
}

Rules:
- Read only what is printed. If a field is not shown, use null — never guess a submittal
  number or a spec section, because a wrong one files it against the wrong work.
- Dates must be YYYY-MM-DD. If a date is shown without a year, return null.
- "description" is what appears in the log, so keep it under about 80 characters and make it
  read as a title, not a sentence.`;

// Reads a contractor's submittal package so the log entry opens pre-filled. Everything it
// returns is shown to the PM for confirmation before anything is saved — this is a first
// draft of the record, not the record.
async function extractSubmittal(pdfBuffer) {
  const { buffer, totalPages } = await coverPages(pdfBuffer);
  const parsed = await callClaude(buffer, SUBMITTAL_PROMPT);

  const revision = Number(parsed.revisionNumber);
  return {
    submittalNumber: trimmed(parsed.submittalNumber),
    revisionNumber: Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : null,
    specSection: trimmed(parsed.specSection),
    description: trimmed(parsed.description),
    vendor: trimmed(parsed.vendor),
    submittalType: trimmed(parsed.submittalType),
    dateSubmitted: isoDate(parsed.dateSubmitted),
    notes: trimmed(parsed.notes),
    totalPages,
  };
}

const RESPONSE_PROMPT = `You are reading a submittal that the architect/engineer (A/E) has
reviewed and returned to the owner's project manager. It is normally the contractor's own
document with a review stamp applied, plus any written comments.

Your job is to read the A/E's decision off the stamp so it can be recorded in the submittal log.

Return ONLY valid JSON in this exact shape:

{
  "reviewAction": "<exactly one of: ${REVIEW_ACTIONS.join(' | ')} — or null if no stamp or decision is visible>",
  "stampText": "<the wording actually printed on the stamp, verbatim, or null>",
  "reviewedBy": "<the reviewing firm or the individual who signed it, or null>",
  "dateReturned": "<the date on the stamp or signature, YYYY-MM-DD, or null>",
  "comments": "<the A/E's review comments in plain English. Summarise if long, but keep every instruction the contractor must act on. Null if there are none.>"
}

Rules:
- Map the stamp's own wording onto the closest allowed "reviewAction". Common equivalents:
  "No Exceptions Taken" / "Reviewed" -> Approved.
  "Make Corrections Noted" / "Furnish as Corrected" / "Reviewed as Noted" -> Approved as Noted.
  "Revise and Resubmit" / "Amend and Resubmit" -> Revise and Resubmit.
  "Rejected" / "Not Approved" -> Rejected.
  "For Information Only" / "Received for Record" -> For Record Only.
- Put the literal stamp wording in "stampText" regardless, so the PM can check the mapping.
- If more than one box is marked, or the stamp is illegible, return null for "reviewAction"
  and say so in "comments". A wrong action here silently closes a submittal that is still
  open, so say nothing rather than guess.
- Dates must be YYYY-MM-DD.`;

// Reads the A/E's stamp off a returned submittal. Returns the action as a suggestion: the PM
// confirms or overrides it before the revision is closed, because an action read wrongly
// would either close a live submittal or hold a finished one open.
async function extractResponse(pdfBuffer) {
  const { buffer } = await coverPages(pdfBuffer);
  const parsed = await callClaude(buffer, RESPONSE_PROMPT);

  const action = trimmed(parsed.reviewAction);
  return {
    // Anything outside the known set is dropped rather than stored — the log's status logic
    // only understands these five, and an unrecognised action would strand the submittal.
    reviewAction: REVIEW_ACTIONS.includes(action) ? action : null,
    stampText: trimmed(parsed.stampText),
    reviewedBy: trimmed(parsed.reviewedBy),
    dateReturned: isoDate(parsed.dateReturned),
    comments: trimmed(parsed.comments),
  };
}

module.exports = { extractSubmittal, extractResponse, COVER_PAGES };
