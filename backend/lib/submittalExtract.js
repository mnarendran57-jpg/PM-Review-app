const { splitPdf, pageCount } = require('./pdfChunk');
const { askForJson, FAST_MODEL } = require('./aiJson');
const { REVIEW_ACTIONS } = require('./submittalLog');

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

// Read back through a tool call rather than by parsing the reply as text — a stamp comment
// quoting a dimension would otherwise end the JSON string on the inch mark. See lib/aiJson.js.
async function callClaude(pdfBuffer, prompt, tool, label) {
  const { data } = await askForJson({
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { type: 'text', text: prompt },
    ],
    tool,
    maxTokens: 2000,
    label,
    // Copying fields off a cover sheet is transcription, not judgement: the number, the spec
    // section, who sent it. Every value lands in a form the PM is looking at and can correct
    // before anything is saved, so the cheaper model is the right tool — and it keeps the
    // reviewing model's per-minute allowance free for the review itself.
    model: FAST_MODEL,
  });
  return data;
}

const trimmed = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
};

// A date the model read off a stamp is only useful if it is a real calendar date — anything
// else would be written straight into a date column and quietly corrupt the log's arithmetic.
const isoDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

const SUBMITTAL_TYPES = [
  'Product Data', 'Shop Drawings', 'Samples', 'Test Reports', 'Certificates',
  'O&M Manuals', 'Closeout', 'Other',
];

const SUBMITTAL_TOOL = {
  name: 'record_submittal',
  description: 'Record a submittal cover sheet for the project\'s submittal log.',
  input_schema: {
    type: 'object',
    properties: {
      submittalNumber: {
        type: 'string',
        description: 'The submittal or transmittal number exactly as printed, e.g. S-001 or 23 05 00-001.',
      },
      revisionNumber: {
        type: 'integer',
        description: 'The revision number if this is a resubmittal (Rev 1, Rev 2…), 0 for a '
          + 'first submission. Omit if not stated.',
      },
      // The whole point of reading the cover sheet before anything else: work out what this
      // package has to be judged against, so the PM can hand over that one document instead of a
      // thousand-page manual. A section number is worth more than a summary here.
      needs: {
        type: 'array',
        description: 'The documents a reviewer would need in order to judge this submittal, most '
          + 'important first. Normally the specification section it was submitted under, plus any '
          + 'drawing sheet or standard it cites. Name each as printed — "23 05 93", "M-401", '
          + '"AWWA C900" — because the PM will go and find it by that name.',
        items: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description: 'The section, sheet or standard number as printed. This is what the PM '
                + 'searches for, so copy it exactly.',
            },
            title: { type: 'string', description: 'Its title, if the submittal gives one.' },
            kind: {
              type: 'string',
              enum: ['specification', 'drawing', 'standard', 'contract', 'other'],
              description: 'What kind of document holds it.',
            },
            why: {
              type: 'string',
              description: 'One short clause on what it would settle — "states the required '
                + 'pressure rating", "lists what must be submitted".',
            },
          },
          required: ['ref'],
        },
      },
      specSection: {
        type: 'string',
        description: 'The CSI spec section, number and title if both are shown, e.g. '
          + '"23 05 00 — Common Work Results for HVAC".',
      },
      description: {
        type: 'string',
        description: 'What the submittal is FOR, in a short phrase a PM would recognise, e.g. '
          + '"VAV boxes — product data". Always give one: if nothing else is available, '
          + 'describe what the document visibly contains.',
      },
      vendor: {
        type: 'string',
        description: 'The subcontractor, supplier or manufacturer who prepared or sent it.',
      },
      submittalType: { type: 'string', enum: SUBMITTAL_TYPES },
      dateSubmitted: {
        type: 'string',
        description: 'The date the contractor dated or transmitted it, YYYY-MM-DD.',
      },
      notes: {
        type: 'string',
        description: 'Anything on the cover the PM should know: a stated deadline, a '
          + 'substitution request, a partial submission.',
      },
    },
    required: ['description'],
  },
};

const SUBMITTAL_PROMPT = `You are reading the cover sheet of a construction submittal that a
contractor has sent to the owner's project manager, so it can be entered into the project's
submittal log.

Record what you find with the record_submittal tool.

Rules:
- Read only what is printed. If a field is not shown, omit it — never guess a submittal
  number or a spec section, because a wrong one files it against the wrong work.
- Dates must be YYYY-MM-DD. If a date is shown without a year, omit it.
- "description" is what appears in the log, so keep it under about 80 characters and make it
  read as a title, not a sentence.
- "needs" is what makes this reading worth doing. Before anything can be judged, somebody has
  to know WHICH documents to judge it against, and the package itself normally says: the
  section it was submitted under, the sheets it references, the standards it claims to meet.
  Name each one as printed. The PM will go and find it by that name, and a section number is
  worth more to them than any amount of description.
- Put the specification section it was submitted under first, where there is one. That is the
  document that decides the outcome; everything else is supporting.
- Do not pad the list with standards that merely appear on a manufacturer's data sheet unless
  the submittal is claiming compliance with them.`;

// Reads a contractor's submittal package so the log entry opens pre-filled. Everything it
// returns is shown to the PM for confirmation before anything is saved — this is a first
// draft of the record, not the record.
async function extractSubmittal(pdfBuffer) {
  const { buffer, totalPages } = await coverPages(pdfBuffer);
  const parsed = await callClaude(buffer, SUBMITTAL_PROMPT, SUBMITTAL_TOOL, 'submittal read');

  const revision = Number(parsed.revisionNumber);
  return {
    submittalNumber: trimmed(parsed.submittalNumber),
    revisionNumber: Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : null,
    specSection: trimmed(parsed.specSection),
    needs: Array.isArray(parsed.needs)
      ? parsed.needs.filter(n => n && typeof n.ref === 'string' && n.ref.trim()).slice(0, 8)
      : [],
    description: trimmed(parsed.description),
    vendor: trimmed(parsed.vendor),
    submittalType: trimmed(parsed.submittalType),
    dateSubmitted: isoDate(parsed.dateSubmitted),
    notes: trimmed(parsed.notes),
    totalPages,
  };
}

const RESPONSE_TOOL = {
  name: 'record_review_stamp',
  description: 'Record the A/E\'s review decision from a returned submittal.',
  input_schema: {
    type: 'object',
    properties: {
      reviewAction: {
        type: 'string',
        enum: REVIEW_ACTIONS,
        description: 'The decision. Omit if no stamp or decision is visible.',
      },
      stampText: { type: 'string', description: 'The wording actually printed on the stamp, verbatim.' },
      reviewedBy: { type: 'string', description: 'The reviewing firm or the individual who signed it.' },
      dateReturned: { type: 'string', description: 'The date on the stamp or signature, YYYY-MM-DD.' },
      comments: {
        type: 'string',
        description: 'The A/E\'s review comments in plain English. Summarise if long, but keep '
          + 'every instruction the contractor must act on.',
      },
    },
    required: [],
  },
};

const RESPONSE_PROMPT = `You are reading a submittal that the architect/engineer (A/E) has
reviewed and returned to the owner's project manager. It is normally the contractor's own
document with a review stamp applied, plus any written comments.

Your job is to read the A/E's decision off the stamp so it can be recorded in the submittal log.

Record it with the record_review_stamp tool.

Rules:
- Map the stamp's own wording onto the closest allowed "reviewAction". Common equivalents:
  "No Exceptions Taken" / "Reviewed" -> Approved.
  "Make Corrections Noted" / "Furnish as Corrected" / "Reviewed as Noted" -> Approved as Noted.
  "Revise and Resubmit" / "Amend and Resubmit" -> Revise and Resubmit.
  "Rejected" / "Not Approved" -> Rejected.
  "For Information Only" / "Received for Record" -> For Record Only.
- Put the literal stamp wording in "stampText" regardless, so the PM can check the mapping.
- If more than one box is marked, or the stamp is illegible, omit "reviewAction"
  and say so in "comments". A wrong action here silently closes a submittal that is still
  open, so say nothing rather than guess.
- Dates must be YYYY-MM-DD.`;

// Reads the A/E's stamp off a returned submittal. Returns the action as a suggestion: the PM
// confirms or overrides it before the revision is closed, because an action read wrongly
// would either close a live submittal or hold a finished one open.
async function extractResponse(pdfBuffer) {
  const { buffer } = await coverPages(pdfBuffer);
  const parsed = await callClaude(buffer, RESPONSE_PROMPT, RESPONSE_TOOL, 'submittal stamp read');

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
