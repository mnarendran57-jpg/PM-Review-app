const { splitPdf } = require('./pdfChunk');
const { askForJson } = require('./aiJson');
const { RESPONSE_ACTIONS, DISCIPLINES } = require('./rfiLog');

// An RFI form is one or two pages, but contractors routinely staple photographs, marked-up
// sketches and catalogue cuts behind it. Everything being read here — the number, the
// question, who asked — is on the form at the front, so only the opening pages are sent.
const FORM_PAGES = 4;

async function frontPages(buffer) {
  const parts = await splitPdf(buffer, FORM_PAGES);
  return parts[0].buffer;
}

// Read back through a tool call rather than by parsing the reply as text. An RFI question
// quoting a duct size — "the 36" main above the corridor" — would otherwise end the JSON
// string on the inch mark and fail the whole read. See lib/aiJson.js.
async function callClaude(pdfBuffer, prompt, tool, label) {
  const { data } = await askForJson({
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { type: 'text', text: prompt },
    ],
    tool,
    maxTokens: 2000,
    label,
  });
  return data;
}

const trimmed = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
};

const isoDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

const RFI_TOOL = {
  name: 'record_rfi',
  description: 'Record the contents of a contractor\'s RFI form for the owner\'s log.',
  input_schema: {
    type: 'object',
    properties: {
      rfiNumber: { type: 'string', description: 'The RFI number exactly as printed, e.g. RFI-014. Omit if none is shown.' },
      subject: {
        type: 'string',
        description: 'A short title for the log, under about 80 characters — what the RFI is '
          + 'about. Always give one: if no subject line is printed, write one from the question.',
      },
      question: {
        type: 'string',
        description: 'The contractor\'s question, in full. Keep the substance; drop letterhead '
          + 'and boilerplate.',
      },
      discipline: {
        type: 'string',
        enum: DISCIPLINES,
        description: 'Which trade the question is really about. "Contract" for commercial or '
          + 'scope questions that no drawing answers.',
      },
      submittedBy: { type: 'string', description: 'The contractor or subcontractor who raised it.' },
      dateSubmitted: { type: 'string', description: 'The date the contractor dated it, YYYY-MM-DD.' },
      referencedDocuments: {
        type: 'array',
        description: 'Any drawing sheet, specification section or contract clause the RFI itself '
          + 'cites, e.g. M-401 or Spec 23 05 00.',
        items: { type: 'string' },
      },
      suggestedByContractor: {
        type: 'string',
        description: 'The contractor\'s own proposed solution if the form has one — these forms '
          + 'usually do.',
      },
      notes: {
        type: 'string',
        description: 'Anything else on the form the PM should know: a stated deadline, a claimed '
          + 'cost or schedule impact, an urgency flag.',
      },
    },
    required: ['subject'],
  },
};

const RFI_PROMPT = `You are reading a contractor's RFI (Request for Information) so it can be
entered into the owner's project RFI log.

Record what you find with the record_rfi tool.

Rules:
- Read only what is printed. Omit a field that is not shown; never invent an RFI number.
- Choose "discipline" from the question's substance, not from who sent it: a general
  contractor asking about duct routing is Mechanical.
- Dates must be YYYY-MM-DD. Omit a date that has no year.
- Keep "question" faithful. It is what the analysis will be run against, so a paraphrase that
  drops a condition changes the answer.`;

// Reads a contractor's RFI so the log entry opens pre-filled. Everything is shown to the PM
// for confirmation before it is saved — a first draft of the record, not the record.
async function extractRfi(pdfBuffer) {
  const parsed = await callClaude(await frontPages(pdfBuffer), RFI_PROMPT, RFI_TOOL, 'rfi read');
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

const RESPONSE_TOOL = {
  name: 'record_ae_response',
  description: 'Record the A/E\'s written response to an RFI for the owner\'s log.',
  input_schema: {
    type: 'object',
    properties: {
      responseAction: {
        type: 'string',
        enum: RESPONSE_ACTIONS,
        description: 'The disposition. Omit if the document does not make it clear.',
      },
      answer: {
        type: 'string',
        description: 'The A/E\'s answer, in full. Keep every instruction the contractor must act on.',
      },
      respondedBy: { type: 'string', description: 'The responding firm or the individual who signed it.' },
      dateReturned: { type: 'string', description: 'The date of the response, YYYY-MM-DD.' },
      impactNoted: { type: 'string', description: 'Any cost or schedule impact the A/E acknowledges.' },
      directsChangeOrder: {
        type: 'boolean',
        description: 'True if the response tells the contractor to submit a change order or '
          + 'pricing, false if it plainly does not. Omit if unclear.',
      },
    },
    required: ['answer'],
  },
};

const RESPONSE_PROMPT = `You are reading the architect/engineer's (A/E) written response to a
contractor's RFI, so it can be recorded in the owner's RFI log.

Record it with the record_ae_response tool.

Rules:
- Map the A/E's wording onto the closest allowed "responseAction". Common equivalents:
  a direct answer, "proceed as clarified", "see attached sketch" -> Answered.
  an answer that attaches a condition or a proviso -> Answered with Conditions.
  "insufficient information", "clarify and resubmit", a question back -> Needs More Information.
  "withdrawn", "not applicable", "duplicate of RFI-xxx" -> Void / Withdrawn.
- If the disposition is genuinely unclear, omit "responseAction" and explain why in "answer". A wrong action closes an RFI that is still live, so say nothing rather than guess.
- "directsChangeOrder" matters: an RFI answer that asks for pricing is the start of a change
  order, and the PM needs to see that immediately.
- Dates must be YYYY-MM-DD.`;

// Reads the A/E's response. The action comes back as a suggestion the PM confirms, because a
// misread disposition would either close a live RFI or hold a finished one open.
async function extractRfiResponse(pdfBuffer) {
  const parsed = await callClaude(await frontPages(pdfBuffer), RESPONSE_PROMPT, RESPONSE_TOOL, 'rfi response read');
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
