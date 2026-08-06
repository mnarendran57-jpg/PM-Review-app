const Anthropic = require('@anthropic-ai/sdk');
const { splitPdf } = require('./pdfChunk');
const { RESPONSE_ACTIONS, DISCIPLINES } = require('./rfiLog');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// An RFI form is one or two pages, but contractors routinely staple photographs, marked-up
// sketches and catalogue cuts behind it. Everything being read here — the number, the
// question, who asked — is on the form at the front, so only the opening pages are sent.
const FORM_PAGES = 4;

async function frontPages(buffer) {
  const parts = await splitPdf(buffer, FORM_PAGES);
  return parts[0].buffer;
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

const isoDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

const RFI_PROMPT = `You are reading a contractor's RFI (Request for Information) so it can be
entered into the owner's project RFI log.

Return ONLY valid JSON in this exact shape:

{
  "rfiNumber": "<the RFI number exactly as printed, e.g. \\"RFI-014\\", or null>",
  "subject": "<a short title for the log, under about 80 characters — what the RFI is about. Never null: if no subject line is printed, write one from the question.>",
  "question": "<the contractor's question, in full. Keep the substance; drop letterhead and boilerplate.>",
  "discipline": "<one of: ${DISCIPLINES.join(' | ')} — which trade the question is really about. \\"Contract\\" for commercial or scope questions that no drawing answers.>",
  "submittedBy": "<the contractor or subcontractor who raised it, or null>",
  "dateSubmitted": "<the date the contractor dated it, YYYY-MM-DD, or null>",
  "referencedDocuments": ["<any drawing sheet, specification section or contract clause the RFI itself cites, e.g. \\"M-401\\" or \\"Spec 23 05 00\\">"],
  "suggestedByContractor": "<the contractor's own proposed solution if the form has one — these forms usually do — or null>",
  "notes": "<anything else on the form the PM should know: a stated deadline, a claimed cost or schedule impact, an urgency flag — or null>"
}

Rules:
- Read only what is printed. Use null where a field is not shown; never invent an RFI number.
- Choose "discipline" from the question's substance, not from who sent it: a general
  contractor asking about duct routing is Mechanical.
- Dates must be YYYY-MM-DD. A date without a year is null.
- Keep "question" faithful. It is what the analysis will be run against, so a paraphrase that
  drops a condition changes the answer.`;

// Reads a contractor's RFI so the log entry opens pre-filled. Everything is shown to the PM
// for confirmation before it is saved — a first draft of the record, not the record.
async function extractRfi(pdfBuffer) {
  const parsed = await callClaude(await frontPages(pdfBuffer), RFI_PROMPT);
  const discipline = trimmed(parsed.discipline);
  return {
    rfiNumber: trimmed(parsed.rfiNumber),
    subject: trimmed(parsed.subject),
    question: trimmed(parsed.question),
    // Anything outside the known list is dropped: the discipline steers which drawings the
    // analysis reads, and an unrecognised one would leave it with no steer at all.
    discipline: DISCIPLINES.includes(discipline) ? discipline : null,
    submittedBy: trimmed(parsed.submittedBy),
    dateSubmitted: isoDate(parsed.dateSubmitted),
    referencedDocuments: Array.isArray(parsed.referencedDocuments)
      ? parsed.referencedDocuments.filter(d => typeof d === 'string' && d.trim()).slice(0, 12)
      : [],
    suggestedByContractor: trimmed(parsed.suggestedByContractor),
    notes: trimmed(parsed.notes),
  };
}

const RESPONSE_PROMPT = `You are reading the architect/engineer's (A/E) written response to a
contractor's RFI, so it can be recorded in the owner's RFI log.

Return ONLY valid JSON in this exact shape:

{
  "responseAction": "<exactly one of: ${RESPONSE_ACTIONS.join(' | ')} — or null if the document does not make the disposition clear>",
  "answer": "<the A/E's answer, in full. Keep every instruction the contractor must act on.>",
  "respondedBy": "<the responding firm or the individual who signed it, or null>",
  "dateReturned": "<the date of the response, YYYY-MM-DD, or null>",
  "impactNoted": "<any cost or schedule impact the A/E acknowledges, or null>",
  "directsChangeOrder": <true if the response tells the contractor to submit a change order or pricing, false if it does not, null if unclear>
}

Rules:
- Map the A/E's wording onto the closest allowed "responseAction". Common equivalents:
  a direct answer, "proceed as clarified", "see attached sketch" -> Answered.
  an answer that attaches a condition or a proviso -> Answered with Conditions.
  "insufficient information", "clarify and resubmit", a question back -> Needs More Information.
  "withdrawn", "not applicable", "duplicate of RFI-xxx" -> Void / Withdrawn.
- If the disposition is genuinely unclear, return null for "responseAction" and explain why in
  "answer". A wrong action closes an RFI that is still live, so say nothing rather than guess.
- "directsChangeOrder" matters: an RFI answer that asks for pricing is the start of a change
  order, and the PM needs to see that immediately.
- Dates must be YYYY-MM-DD.`;

// Reads the A/E's response. The action comes back as a suggestion the PM confirms, because a
// misread disposition would either close a live RFI or hold a finished one open.
async function extractRfiResponse(pdfBuffer) {
  const parsed = await callClaude(await frontPages(pdfBuffer), RESPONSE_PROMPT);
  const action = trimmed(parsed.responseAction);
  return {
    responseAction: RESPONSE_ACTIONS.includes(action) ? action : null,
    answer: trimmed(parsed.answer),
    respondedBy: trimmed(parsed.respondedBy),
    dateReturned: isoDate(parsed.dateReturned),
    impactNoted: trimmed(parsed.impactNoted),
    directsChangeOrder: parsed.directsChangeOrder === true ? true
      : parsed.directsChangeOrder === false ? false : null,
  };
}

module.exports = { extractRfi, extractRfiResponse, FORM_PAGES };
