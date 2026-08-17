const { askForJson } = require('./aiJson');
const { RFI_STATUS_LABEL } = require('./rfiAnalysis');

// Checks the A/E's answer against the questions the contractor actually asked, and closes the RFI
// out with a list of what to do.
//
// This used to compare the A/E's answer with the one Coaster predicted, row by row. That was
// interesting but it was not the PM's problem. An A/E answering four questions with three answers
// is the thing that costs a job a fortnight, because nobody notices until the work stops at the
// fourth — and the RFI is closed by then, so re-opening it is a favour rather than a right. So the
// only question asked here is coverage: was every question answered? Everything else the PM needs
// is in the To Do underneath.
//
// No documents are re-sent. Both the RFI and the answer are already text, so this is a small call —
// which matters on an account limited to about 10,000 input tokens a minute.

// Whether one question the contractor asked came back answered.
const COVERAGE_STATUSES = ['answered', 'partly', 'unanswered'];

// The kinds of thing a closed-out RFI leaves behind. A change order is called out on its own
// because it is the one with a deadline attached that nobody sets.
const TODO_KINDS = [
  'change_order', 'revise_drawings', 'press_ae', 'instruct_contractor', 'schedule', 'record',
];

const COVERAGE = ['all', 'most', 'none'];

// Field order is load-bearing. A tool call is generated top to bottom, so when the verdict and the
// headline came first the model would settle the whole question in the headline and then return
// empty arrays behind it — a panel showing a finding with nothing under it. Enumerating the detail
// first and summarising last means the summary describes work already done.
const COVERAGE_TOOL = {
  name: 'record_ae_response_coverage',
  description: "Report whether the A/E's answer addressed every question the contractor asked, "
    + 'and what is left to do.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'One row per question the CONTRACTOR asked, in the order the RFI asks them. '
          + 'Read the RFI for what it actually asks — an RFI that reads as one question often '
          + 'contains two or three, and a buried one is exactly the one that comes back unanswered. '
          + 'Do not invent questions the RFI does not ask, and do not merge two into one.',
        items: {
          type: 'object',
          properties: {
            asked: {
              type: 'string',
              description: 'The question, in AT MOST 14 words. The contractor\'s own words where '
                + 'they are short enough to use. A question, not a topic.',
            },
            aeSaid: {
              type: 'string',
              description: 'What the A/E said about THIS question, in AT MOST 14 words. Where they '
                + 'said nothing about it, write "Nothing" rather than filling the cell with the '
                + 'nearest thing they did say.',
            },
            status: {
              type: 'string',
              enum: COVERAGE_STATUSES,
              description: '"answered" — the A/E gave a clear answer this question can be closed '
                + 'on. "partly" — they addressed it but left something open, or answered a '
                + 'narrower question than the one asked. "unanswered" — they did not address it at '
                + 'all, or deferred it.',
            },
          },
          required: ['asked', 'aeSaid', 'status'],
        },
      },
      todo: {
        type: 'array',
        description: 'What has to happen now that this answer is in, most urgent first, at most 5 '
          + 'entries. This is the closing list for the whole RFI, so draw on everything above: the '
          + 'answer, what the documents showed, and any question that came back unanswered. Empty '
          + 'ONLY where the answer settles the RFI and genuinely leaves nothing behind.',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'Starts with a verb, runs to at most 14 words, and names the thing to '
                + 'be done: "Price the duct transition before the sheet metal is fabricated." Not '
                + 'a topic, not an observation — something a person can do and then tick off.',
            },
            kind: {
              type: 'string',
              enum: TODO_KINDS,
              description: '"change_order" — this needs pricing or a change order raised, because '
                + 'the answer directs work the contract documents do not carry. '
                + '"revise_drawings" — the A/E has to revise or reissue a drawing to match what '
                + 'they just said. '
                + '"press_ae" — go back to the A/E: a question was not answered, or the answer is '
                + 'too vague to build to. '
                + '"instruct_contractor" — the contractor needs telling to proceed, to correct '
                + 'something, or that the answer was already in the documents. '
                + '"schedule" — there is a time impact to record or to claim. '
                + '"record" — nothing to chase; note it and close.',
            },
            why: {
              type: 'string',
              description: 'ONLY where the reason is not obvious from the action itself — the '
                + 'consequence in money or time, or who bears it. At most 15 words. Omit it '
                + 'entirely on an item that explains itself; a why on every item is a why on none.',
            },
          },
          required: ['action', 'kind'],
        },
      },
      // Last on purpose: these summarise the rows above, so they are written once the detail
      // exists rather than in place of it.
      coverage: {
        type: 'string',
        enum: COVERAGE,
        description: 'Consistent with the rows above. "all" — every question came back answered. '
          + '"most" — at least one question is partly answered or unanswered. "none" — the A/E did '
          + 'not answer the RFI at all: they asked for more information, deferred it, or answered '
          + 'a different question.',
      },
      explanation: {
        type: 'string',
        description: 'One or two sentences in plain English on whether the A/E answered what was '
          + 'asked. Name what was left open, if anything, and say nothing else — the questions are '
          + 'tabled above and the actions are listed below, so do not repeat either. If everything '
          + 'was answered, say that plainly in one sentence rather than padding it.',
      },
    },
    required: ['questions', 'todo', 'coverage', 'explanation'],
  },
};

function buildPrompt({ rfi, discipline, analysis, response }) {
  // The documents reading, where one was run. It is what makes the difference between "the A/E
  // answered the question" and "the A/E answered it with something the contract does not carry",
  // and the second is what the To Do is written against.
  const documentsRead = analysis?.points?.length
    ? (analysis.points.map(p =>
        `  - ${p.point}: the documents show "${p.documentsShow || '—'}"; the RFI asks `
        + `"${p.rfiAsks || '—'}" (${RFI_STATUS_LABEL[p.status] || p.status})`
      ).join('\n')
      + `\n  Overall: ${analysis.headline || '(none recorded)'}`
      + `\n  Confidence in that reading: ${analysis.confidence}`
        + `${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}`)
    : null;

  return `You are advising the OWNER's project manager on a construction RFI that the
architect/engineer (A/E) has just answered.

The PM can read the answer for themselves. What they cannot easily see, and what costs them when
they miss it, is a question that went unanswered — an RFI answered four-fifths of the way is closed
in the log and stops the work a fortnight later at the part nobody replied to. So your job is to
check the answer against the questions, and then say what is left to do.

THE RFI, AS THE CONTRACTOR ASKED IT
Number: ${rfi.rfi_number}
Subject: ${rfi.subject}
Discipline: ${discipline || 'not recorded'}
Question as recorded:
"""
${rfi.question || '(no question text was recorded — go by the subject alone, and say so in the explanation)'}
"""

WHAT THE A/E ANSWERED
Disposition: ${response.action}
${response.respondedBy ? `From: ${response.respondedBy}\n` : ''}${response.dateReturned ? `Dated: ${response.dateReturned}\n` : ''}Answer:
"""
${response.notes || '(no written answer was recorded — go by the disposition alone)'}
"""
${documentsRead ? `
WHAT COASTER FOUND IN THE PROJECT DOCUMENTS BEFORE THE ANSWER CAME
${documentsRead}
` : `
No reading of the project documents was run on this RFI, so judge the answer against the question
alone and do not assume what the drawings show.
`}
Report with the record_ae_response_coverage tool.

Rules:
- Coverage is the whole point. Split the RFI into the questions it actually asks and check each one
  off against the answer. A contractor who writes one paragraph has often asked three things.
- "unanswered" is a finding, not a failure of yours to look harder. If the A/E did not address
  something, say so in that row and put "press_ae" in the To Do. This is the single most useful
  thing on the page.
- Length is a feature. These are cells in a table, read at a glance between site visits, not
  paragraphs. Give the substance, not a description of it.
- The To Do is the closing list for the entire RFI and it is what the PM works from tomorrow
  morning. Every item starts with a verb and is something a person can finish.
- Raise "change_order" where the A/E's answer directs work the contract documents do not carry —
  where the reading above shows the documents were silent, or where the answer relies on something
  never drawn. An instruction that arrives as an answer to an RFI is still a change, and it is far
  cheaper to price it now than to argue it at the pay application.
- Be careful about blame. Report what was asked, what was answered, and what has to happen. Whether
  something is a design change, a clarification or a contractor error is a judgement the PM makes
  with information you do not have.
- Do not pad. A clean answer to a simple RFI is one row, "all", and a single "record" item. That is
  a good outcome and it should read like one.
- Write for a reader who is not a specialist in this trade.`;
}

// How each row reads in a document, where colour cannot carry the meaning.
const COVERAGE_STATUS_LABEL = {
  answered: 'Answered',
  partly: 'Partly answered',
  unanswered: 'Not answered',
};

const COVERAGE_LABEL = {
  all: 'The A/E answered every question asked',
  most: 'The A/E left part of the RFI unanswered',
  none: 'The A/E did not answer the RFI',
};

const TODO_LABEL = {
  change_order: 'Change order',
  revise_drawings: 'Drawing revision',
  press_ae: 'Back to the A/E',
  instruct_contractor: 'Tell the contractor',
  schedule: 'Schedule',
  record: 'Record and close',
};

// A pipe inside a cell would end the column early and shift every value after it one place left,
// so a duct noted as "24x12 | 30x8 oval" would silently corrupt its own row.
const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';

function renderMarkdown({ rfi, review, response }) {
  const lines = [];
  lines.push(`# Response review — ${rfi.rfi_number}: ${rfi.subject}`);
  lines.push('');
  lines.push('> Whether the A/E answered what the contractor asked, and what is left to do. Advisory: it is the PM\'s judgement that closes an RFI, not this review.');
  lines.push('');
  lines.push(`**${COVERAGE_LABEL[review.coverage] || review.coverage}**  `);
  lines.push(`**A/E disposition:** ${response.action}${response.dateReturned ? ` on ${response.dateReturned}` : ''}`);
  lines.push('');
  if (review.explanation) {
    lines.push(review.explanation);
    lines.push('');
  }

  if (review.questions?.length) {
    lines.push('| | The contractor asked | The A/E said |');
    lines.push('|---|---|---|');
    for (const q of review.questions) {
      lines.push(`| ${COVERAGE_STATUS_LABEL[q.status] || ''} | ${cell(q.asked)} | ${cell(q.aeSaid)} |`);
    }
    lines.push('');
  }

  if (review.todo?.length) {
    lines.push('## To do');
    lines.push('');
    for (const t of review.todo) {
      lines.push(`- **${TODO_LABEL[t.kind] || t.kind}** — ${t.action}${t.why ? ` _(${t.why})_` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// A coverage line saying every question was answered, above a row saying one was not, is the one
// answer this must not pass on: the PM reads the line, closes the RFI, and the unanswered question
// surfaces when the work stops. It is settled from the rows rather than by asking again, because
// the rows ARE the evidence and a second call on a rate-limited account has to earn itself.
function reconcileCoverage({ coverage, questions }) {
  if (!questions.length) return coverage;
  if (questions.every(q => q.status === 'unanswered')) return 'none';
  if (questions.some(q => q.status !== 'answered')) return 'most';
  // Every question answered. "none" can still be right where the A/E refused the RFI outright and
  // the model recorded that as the answer to each question, so it is left to stand.
  return coverage === 'none' ? 'none' : 'all';
}

async function compareToResponse({ rfi, discipline, analysis, response }) {
  const content = [{ type: 'text', text: buildPrompt({ rfi, discipline, analysis, response }) }];

  const { data } = await askForJson({
    content,
    tool: COVERAGE_TOOL,
    maxTokens: 2000,
    label: 'rfi response review',
  });

  const review = {
    coverage: COVERAGE.includes(data.coverage) ? data.coverage : 'most',
    explanation: data.explanation || null,
    questions: (Array.isArray(data.questions) ? data.questions : [])
      .filter(q => q && q.asked)
      .map(q => ({
        asked: q.asked,
        aeSaid: q.aeSaid || null,
        // An unrecognised status would render as an uncoloured row with no label, which reads as
        // "answered, nothing to see here" — the wrong default for a coverage check.
        status: COVERAGE_STATUSES.includes(q.status) ? q.status : 'partly',
      })),
    todo: (Array.isArray(data.todo) ? data.todo : [])
      .filter(t => t && t.action)
      .map(t => ({
        action: t.action,
        kind: TODO_KINDS.includes(t.kind) ? t.kind : 'record',
        why: t.why || null,
      })),
    // Recorded so the panel can say the reading was never run, rather than leaving the reader to
    // wonder why the To Do says nothing about the drawings.
    hadDocumentReading: Boolean(analysis?.points?.length),
  };
  review.coverage = reconcileCoverage(review);

  return { review, markdown: renderMarkdown({ rfi, review, response }) };
}

module.exports = {
  compareToResponse,
  COVERAGE, COVERAGE_LABEL, COVERAGE_STATUSES, COVERAGE_STATUS_LABEL,
  TODO_KINDS, TODO_LABEL,
  // Exported for tests/rfiReconcile.test.js. This is the guard that stops "every question answered"
  // appearing above a row saying one was not, so it is worth exercising without an API call.
  reconcileCoverage,
};
