const { planPasses, passLabel } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// A finding about a duct or a pipe carries its dimension, written with an inch mark, so the
// review comes back through a tool call rather than as parsed text. See lib/aiJson.js.
const FINDING_LIST = description => ({
  type: 'array',
  description,
  items: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      basis: {
        type: 'string',
        enum: ['confirmed', 'assumption'],
        description: '"confirmed" means directly supported by something explicitly stated or '
          + 'shown in the documents. "assumption" means a reasonable concern based on typical '
          + 'construction practice or an inference — be honest about which is which.',
      },
    },
    required: ['text', 'basis'],
  },
});

const REVIEW_TOOL = {
  name: 'record_precon_review',
  description: 'Record a pre-construction review of a project document set.',
  input_schema: {
    type: 'object',
    properties: {
      documentSummary: {
        type: 'string',
        description: '2-5 sentence summary of what the documents appear to cover (scope, '
          + 'discipline, project type).',
      },
      insufficientInfo: {
        type: 'boolean',
        description: 'True if the documents genuinely do not contain enough information to do '
          + 'a meaningful review.',
      },
      insufficientInfoNote: {
        type: 'string',
        description: 'If insufficientInfo is true, a short note on what else is needed.',
      },
      risks: FINDING_LIST('Scope gaps, unclear design intent, missing information, coordination '
        + 'issues, constructability concerns, schedule impact, procurement concerns, site '
        + 'constraints, code/permitting concerns, or operational disruptions.'),
      highCostItems: FINDING_LIST('Items that may significantly affect cost: major '
        + 'electrical/mechanical equipment, switchgear, HVAC units, structural work, specialty '
        + 'finishes, long-lead items, demolition, phasing, utility shutdowns, fire/life safety '
        + 'work, complex installation requirements.'),
      changeOrderAreas: FINDING_LIST('Areas that could reasonably lead to a change order: vague '
        + 'scope, incomplete details, conflicts between drawings/specs, unknown field '
        + 'conditions, allowance items, exclusions, deferred design, missing quantities, '
        + 'unclear trade responsibility.'),
      missingInfo: {
        type: 'array',
        description: 'Specific questions the PM should ask the architect, engineer, contractor '
          + 'or owner before bidding or construction.',
        items: { type: 'string' },
      },
      actionItems: {
        type: 'array',
        description: 'Specific, practical next steps: an RFI to issue, a clarification to '
          + 'request, a site walk to schedule, a cost item to verify, an approval needed, a '
          + 'document to request.',
        items: { type: 'string' },
      },
    },
    required: ['documentSummary', 'risks', 'highCostItems', 'changeOrderAreas', 'missingInfo', 'actionItems'],
  },
};

function fileToContentBlock(file) {
  const mimeType = file.mimetype;
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } };
  }
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: file.buffer.toString('base64') } };
  }
  // Unsupported type (e.g. Word/Excel/CAD) — note it so the model knows it exists but can't be read directly.
  return {
    type: 'text',
    text: `[Note: File "${file.originalname}" (${mimeType}) was uploaded but its content could not be rendered directly. ` +
      'Treat this as a document whose content is unknown, and mention in "Missing or Unclear Information" that it should be reviewed separately or converted to PDF.]'
  };
}

const PROMPT_TEMPLATE = ({ projectName, reviewFocus }) => `You are assisting a Construction Project Manager with a pre-construction document review. The PM has uploaded one or more construction drawings, design documents, specifications, proposals, sketches, narratives, reports, or contractor/architect/engineer documents for a project${projectName ? ` called "${projectName}"` : ''}.${reviewFocus ? `\n\nThe PM has asked you to pay particular attention to: ${reviewFocus}` : ''}

Analyze all the documents together as one project package and produce a structured pre-construction review, recorded with the record_precon_review tool.

Rules:
- Do not invent details that are not supported by the documents. If you are not confident about something, mark it as an assumption or leave it out.
- If the documents genuinely don't contain enough information for a meaningful review, set insufficientInfo to true and still fill in whatever partial findings are possible in the arrays (they can be short or empty), explaining the gap in insufficientInfoNote.
- Keep each bullet concise, practical, and specific to these documents — not generic boilerplate.
- Prioritize issues that could affect cost, schedule, scope, constructability, or change orders.
- Every array should be present (use an empty array if genuinely nothing applies to that section).`;

async function analyzeOnePass(entries, { projectName, reviewFocus, passNumber, passTotal }) {
  const contentBlocks = entries.map(e => fileToContentBlock(e.file));
  let prompt = PROMPT_TEMPLATE({ projectName, reviewFocus });

  // Tell the model it is reading an extract. Without this it reports the pages it cannot
  // see as missing from the submission, which would fill the report with false gaps.
  if (passTotal > 1) {
    const names = entries.map(passLabel).join(', ');
    prompt += `\n\nIMPORTANT — this is part ${passNumber} of ${passTotal} of a larger document set, covering only: ${names}. ` +
      'Review ONLY what is in front of you. Do not report other sections, drawings, or pages as missing — ' +
      'they are being reviewed separately and will be combined with your findings.';
  }

  // A long set is read in several passes, and the account's allowance (10,000 input tokens and
  // 5 requests a minute) is comfortably exceeded by two dense drawing passes back to back. So a
  // rate-limit answer is expected here, not exceptional, and is waited out rather than treated
  // as a failure — hence four attempts where most callers take the default two.
  const { data } = await askForJson({
    content: [...contentBlocks, { type: 'text', text: prompt }],
    tool: REVIEW_TOOL,
    maxTokens: 8192,
    attempts: 4,
    label: `precon pass ${passNumber}/${passTotal}`,
    truncatedMessage: 'The review was too large to complete in one pass. Try again with fewer documents at once.',
  });
  return data;
}

// Same finding reported against two parts of one document should appear once. Compared on
// wording alone, since that is what the PM reads.
const dedupeKey = item => String(item?.text ?? item).trim().toLowerCase().replace(/\s+/g, ' ');

function mergeAnalyses(results) {
  if (results.length === 1) return results[0];

  const merged = {
    documentSummary: '',
    // Only genuinely insufficient if no pass found enough to review.
    insufficientInfo: results.every(r => r.insufficientInfo),
    insufficientInfoNote: null,
    risks: [], highCostItems: [], changeOrderAreas: [], missingInfo: [], actionItems: [],
  };

  for (const key of ['risks', 'highCostItems', 'changeOrderAreas', 'missingInfo', 'actionItems']) {
    const seen = new Set();
    for (const result of results) {
      for (const item of result[key] || []) {
        const k = dedupeKey(item);
        if (k && !seen.has(k)) { seen.add(k); merged[key].push(item); }
      }
    }
  }

  merged.documentSummary = results.map(r => r.documentSummary).filter(Boolean).join(' ');
  if (merged.insufficientInfo) {
    merged.insufficientInfoNote = results.map(r => r.insufficientInfoNote).filter(Boolean).join(' ') || null;
  }
  return merged;
}

// A long document is read in several passes and the findings combined, so no upload is
// refused for being too long. Passes run one at a time rather than in parallel: the account's
// per-minute token allowance is low enough that concurrent passes would rate-limit each other.
//
// A pass that still fails after its retries no longer sinks the review. On a 300-page set
// that is eight calls, and throwing away seven good ones because the eighth failed is the
// worst possible outcome for the PM — an incomplete review that says which pages are missing
// is far more use than no review at all.
async function analyzePreconDocuments(files, { projectName, reviewFocus }) {
  const passes = await planPasses(files);
  const results = [];
  const failed = [];

  for (const [index, entries] of passes.entries()) {
    try {
      results.push(await analyzeOnePass(entries, {
        projectName, reviewFocus, passNumber: index + 1, passTotal: passes.length,
      }));
    } catch (err) {
      console.error(`[precon] pass ${index + 1}/${passes.length} failed:`, err.message);
      failed.push({ label: entries.map(passLabel).join(', '), reason: err.message });
    }
  }

  // Every pass failed — there is nothing to report, so surface the reason rather than an
  // empty review that looks like a considered "nothing found".
  if (results.length === 0) {
    const err = new Error(failed[0]?.reason || 'The documents could not be analyzed.');
    err.status = 502;
    throw err;
  }

  const merged = mergeAnalyses(results);
  merged.coverage = {
    passesTotal: passes.length,
    passesRead: results.length,
    skipped: failed,
  };
  // Said in the report itself, not only in the metadata, because a PM reading the findings
  // needs to know they are partial at the point they are reading them.
  if (failed.length > 0) {
    merged.insufficientInfoNote = [
      merged.insufficientInfoNote,
      `Only ${results.length} of ${passes.length} sections of this document set could be read — ` +
      `${failed.map(f => f.label).join('; ')} could not be processed. The findings below cover the rest.`,
    ].filter(Boolean).join(' ');
  }
  return merged;
}

module.exports = { analyzePreconDocuments, SUPPORTED_IMAGE_TYPES };
