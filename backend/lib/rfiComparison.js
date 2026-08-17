const { askForJson } = require('./aiJson');

// Reads the A/E's actual answer against the one Coaster predicted, and tells the PM what the
// difference means.
//
// The prediction was made from the drawings alone, before anyone with authority had spoken.
// When the answer arrives, the question the PM actually has is not "what did the A/E say" —
// they can read that — but "is this what the documents said, and if not, what does that
// change?" An A/E who answers against the drawings is confirming the design. An A/E who
// answers around them has changed something, and that is usually where the money is.
//
// No documents are re-sent. Both sides of the comparison are already text, so this is a small
// call — which matters on an account limited to 10,000 input tokens a minute.

const VERDICTS = ['confirmed', 'partly_confirmed', 'contradicted', 'not_comparable'];

// What each row of the comparison is. Four kinds, because there are exactly four ways an answer
// can stand against the documents it was supposed to come from, and the PM does something
// different about each.
const STATUSES = ['agreed', 'differs', 'new_information', 'unanswered'];

// Field order is load-bearing. A tool call is generated top to bottom, so when the verdict and
// the headline came first the model would answer the whole question in the headline and then
// return empty arrays behind it — a panel showing a finding with nothing under it. Enumerating
// the detail first and summarising last means the headline describes work already done.
const COMPARISON_TOOL = {
  name: 'record_response_comparison',
  description: "Compare the A/E's actual answer with the one predicted from the documents.",
  input_schema: {
    type: 'object',
    properties: {
      // One array, not four.
      //
      // This was four separate fields — what agreed, what differed, what the A/E relied on that
      // the drawings did not contain, and what it might cost — each written as prose and stacked
      // down the panel. Everything a reader needed was there, and finding any of it meant
      // reading all of it. But every entry is the same shape of fact: a point, what the
      // documents showed, what the A/E answered. Written that way it is a table, read in one
      // glance instead of four paragraphs, and the distinction the four fields carried survives
      // as the status column that colours each row.
      points: {
        type: 'array',
        description: 'One row per point of substance, most consequential first. Together these '
          + 'are the whole comparison — every difference and every agreement worth the PM\'s '
          + 'attention, and nothing else. Omit anything you would include only for completeness.',
        items: {
          type: 'object',
          properties: {
            point: {
              type: 'string',
              description: 'What it is about: a noun phrase of 2 to 6 words, never a sentence. '
                + '"Duct clearance at beam", "VAV box size", "Who bears the cost".',
            },
            documentsSaid: {
              type: 'string',
              description: 'What the drawings and documents showed, in AT MOST 12 words — the '
                + 'value or the requirement itself, not a description of it. "10 feet 6 inches '
                + 'to underside, 6 inch clearance" beats "the drawings indicated a clearance '
                + 'requirement". Write "Silent" where they did not address it, and "Not in what '
                + 'was read" where the governing sheet was never reached.',
            },
            aeSaid: {
              type: 'string',
              description: "What the A/E actually answered, in AT MOST 12 words. Their words "
                + 'where they are short enough to use.',
            },
            status: {
              type: 'string',
              enum: STATUSES,
              description: '"agreed" — the A/E answered what the documents showed. '
                + '"differs" — the A/E answered differently from the documents. '
                + '"new_information" — the A/E relied on something not in the documents at all: '
                + 'a decision, a field condition, an intent never drawn. This is the row that is '
                + 'usually worth money, because it is a change arriving as an answer. '
                + '"unanswered" — the question, or part of it, was not addressed.',
            },
            note: {
              type: 'string',
              description: 'ONLY where there is a consequence in money or time — a change order, '
                + 'a delay, a drawing to have revised, another trade affected. Say on whose '
                + 'account where you can. At most 15 words. Omit it entirely on a row that just '
                + 'records agreement; a note on every row is a note on none.',
            },
          },
          required: ['point', 'aeSaid', 'status'],
        },
      },
      actionsForPm: {
        type: 'array',
        description: 'What the PM should do now, at most 4 entries, most urgent first. Each one '
          + 'starts with a verb and runs to at most 12 words: "Price the duct transition before '
          + 'fabrication." Empty ONLY if the answer simply confirms the documents and needs '
          + 'nothing.',
        items: { type: 'string' },
      },
      // Last on purpose: both of these summarise the fields above, so they are written once
      // the detail exists rather than in place of it.
      verdict: {
        type: 'string',
        enum: VERDICTS,
        description: 'Your overall read, consistent with the differences you listed above. '
          + '"confirmed" — the A/E said substantially what the documents said, and you listed '
          + 'no differences. "partly_confirmed" — the same broad answer with a material '
          + 'qualification or addition. "contradicted" — the A/E answered differently from '
          + 'what the documents showed. "not_comparable" — the A/E did not answer the question '
          + '(asked for more information, deferred it, or answered something else).',
      },
      headline: {
        type: 'string',
        description: 'ONE sentence, at most 25 words, and it must say something the table does '
          + 'not repeat: what the difference amounts to for this PM. No preamble, no restating '
          + 'the answer — it is printed beside this line.',
      },
    },
    required: ['actionsForPm', 'verdict', 'headline'],
  },
};

function buildPrompt({ rfi, discipline, analysis, sources, response }) {
  const read = (sources || []).map(s => {
    const what = s.wholeDocument ? 'read in full'
      : s.sheets?.length ? `sheets ${s.sheets.map(x => x.sheetNumber).join(', ')}`
      : `opening ${s.pagesUsed} pages`;
    return `  - ${s.label} (${what})`;
  }).join('\n') || '  (not recorded)';

  const basis = (analysis.basis || []).map(b =>
    `  - ${b.document}${b.sheet ? ` — ${b.sheet}` : ''}: ${b.shows}`).join('\n') || '  (none recorded)';

  return `You are advising the owner's project manager on a construction RFI that has just been
answered by the architect/engineer (A/E).

Before the answer came back, Coaster read the project documents and predicted how the RFI
would likely be answered. That prediction and the A/E's actual answer are both below. Compare
them and tell the PM what the difference means.

THE RFI
Number: ${rfi.rfi_number}
Subject: ${rfi.subject}
Discipline: ${discipline || 'not recorded'}
Question: ${rfi.question || '(no question text was recorded)'}

WHAT COASTER PREDICTED, FROM THE DOCUMENTS ALONE
Answer: ${analysis.shortAnswer || analysis.likelyAnswer || '(none recorded)'}
${analysis.likelyAnswer && analysis.likelyAnswer !== analysis.shortAnswer ? `Reasoning: ${analysis.likelyAnswer}\n` : ''}Confidence: ${analysis.confidence}${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}
Grounded in:
${basis}
${analysis.missingInformation ? `Noted as missing at the time: ${analysis.missingInformation}\n` : ''}${analysis.costScheduleFlag ? `Flagged then as cost/schedule exposure: ${analysis.costScheduleFlag}\n` : ''}
Documents that prediction was read from:
${read}

WHAT THE A/E ACTUALLY ANSWERED
Disposition: ${response.action}
${response.respondedBy ? `From: ${response.respondedBy}\n` : ''}${response.dateReturned ? `Dated: ${response.dateReturned}\n` : ''}Answer:
"""
${response.notes || '(no written answer was recorded — go by the disposition alone)'}
"""

Record your comparison as a TABLE, with the record_response_comparison tool. Every row is one
point; the three columns are what it is about, what the documents showed, and what the A/E
answered. The PM reads this at a glance between site visits, so write cells, not paragraphs.

Rules:
- The PM already knows what the A/E said. The value here is the gap: where the answer departs
  from what the contract documents showed, and what that costs them.
- Length is a feature. A cell over a dozen words stops being scannable and becomes something to
  read, which defeats the table. Give the value, not a description of the value: "10'-6" to
  underside, 6 inch clearance" beats "the drawings indicated a clearance was required".
- A short table beats a complete one. Rows the PM would not act on or forward do not earn their
  line. If the A/E simply confirmed the documents, a couple of "agreed" rows and no note is the
  right answer.
- The headline summarises; the rows carry the detail. Never state a difference in the headline
  that does not also appear as a row — the headline is one line in a panel and the rows are what
  the PM reads, forwards and prices.
- Only report differences of substance. A different way of phrasing the same instruction is
  not a difference; that row is "agreed".
- A row whose status is "new_information" is the most valuable thing on this page: work not in
  the contract documents is work somebody has to pay for, and the PM needs to see it the day the
  answer arrives, not at the pay application. Use it where the A/E relied on something the
  documents do not carry, and put the consequence in that row's note.
- Be careful about blame. Report what the documents showed and what the A/E directed. Whether
  that is a design change, a clarification or a contractor error is often a judgement the PM
  makes with information you do not have.
- If the A/E asked for more information rather than answering, the verdict is
  "not_comparable" — say what they still need.
- The prediction was advisory and may simply have been wrong. Where the A/E clearly had
  information the documents did not carry, say that rather than presenting it as a conflict.
- Write for a reader who is not a specialist in this trade.`;
}

// How each row reads in a document, where colour cannot carry the meaning.
const STATUS_LABEL = {
  agreed: 'Matches the documents',
  differs: 'Differs',
  new_information: 'Not in the documents',
  unanswered: 'Not answered',
};

// A pipe inside a cell would end the column early and shift every value after it one place
// left — so a duct noted as "24x12 | 30x8 oval" would silently corrupt its own row.
const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';

function renderMarkdown({ rfi, review, response }) {
  const VERDICT_LABEL = {
    confirmed: 'The A/E confirmed what the documents showed',
    partly_confirmed: 'The A/E broadly confirmed the documents, with a qualification',
    contradicted: 'The A/E answered differently from the documents',
    not_comparable: 'The A/E did not answer the question',
  };

  const lines = [];
  lines.push(`# Response review — ${rfi.rfi_number}: ${rfi.subject}`);
  lines.push('');
  lines.push('> How the A/E\'s answer compares with the reading Coaster made of the project documents before it arrived. Advisory: it is the PM\'s judgement that matters, not this comparison.');
  lines.push('');
  lines.push(`**Verdict:** ${VERDICT_LABEL[review.verdict] || review.verdict}  `);
  lines.push(`**A/E disposition:** ${response.action}${response.dateReturned ? ` on ${response.dateReturned}` : ''}`);
  lines.push('');
  lines.push(review.headline || '');
  lines.push('');

  if (review.points?.length) {
    lines.push('| | Point | The documents said | The A/E answered |');
    lines.push('|---|---|---|---|');
    for (const p of review.points) {
      lines.push(`| ${STATUS_LABEL[p.status] || ''} | ${cell(p.point)} | ${cell(p.documentsSaid)} `
        + `| ${cell(p.aeSaid)} |`);
    }
    lines.push('');
    // Notes sit under the table rather than in a fifth column: they are the one part that is a
    // sentence, and a column of sentences is what stops a table being scannable.
    const noted = review.points.filter(p => p.note);
    if (noted.length) {
      for (const p of noted) lines.push(`- **${p.point}** — ${p.note}`);
      lines.push('');
    }
  } else {
    lines.push('_No material differences between the answer and the contract documents._');
    lines.push('');
  }

  if (review.actionsForPm?.length) {
    lines.push('## What to do now');
    lines.push('');
    for (const a of review.actionsForPm) lines.push(`- ${a}`);
    lines.push('');
  }
  return lines.join('\n');
}

// A verdict saying the A/E departed from the documents, with no departure listed, is the one
// answer this must not pass on: the panel would show a finding with nothing underneath it, and
// the PM would have nothing to forward or price. It happens occasionally whatever the prompt
// says, so it is checked rather than hoped for.
const DEPARTURES = new Set(['contradicted', 'partly_confirmed']);

const isSelfContradictory = (data) => {
  const rows = Array.isArray(data?.points) ? data.points : [];
  return DEPARTURES.has(data?.verdict)
    && !rows.some(p => p && (p.status === 'differs' || p.status === 'new_information'));
};

const CORRECTION = `Your verdict says the A/E departed from the documents, but no row you gave
has status "differs" or "new_information". Those cannot both be right. Call the tool again:
either give each departure its own row — what it is about, what the documents showed, what the
A/E answered — or, if on reflection the answer sits within the documents, change the verdict to
match.`;

async function compareToResponse({ rfi, discipline, analysis, sources, response }) {
  const content = [{ type: 'text', text: buildPrompt({ rfi, discipline, analysis, sources, response }) }];
  const ask = blocks => askForJson({
    content: blocks,
    tool: COMPARISON_TOOL,
    maxTokens: 2000,
    label: 'rfi response review',
  });

  let { data } = await ask(content);
  if (isSelfContradictory(data)) {
    console.warn('[rfi response review] verdict claimed a departure but listed none — asking again');
    // One corrective pass, and only when it is actually needed: this runs on a rate-limited
    // account, so a second call has to earn itself. If the retry is no better the first answer
    // still stands — its headline and exposure notes are worth showing.
    try {
      const { data: second } = await ask([...content, { type: 'text', text: CORRECTION }]);
      if (!isSelfContradictory(second)) data = second;
    } catch (err) {
      console.warn(`[rfi response review] corrective pass failed, keeping the first: ${err.message}`);
    }
  }

  const review = {
    verdict: VERDICTS.includes(data.verdict) ? data.verdict : 'not_comparable',
    headline: data.headline || null,
    points: (Array.isArray(data.points) ? data.points : [])
      .filter(p => p && p.point && p.aeSaid)
      .map(p => ({
        point: p.point,
        documentsSaid: p.documentsSaid || null,
        aeSaid: p.aeSaid,
        // An unrecognised status would render as an uncoloured row with no label, which reads
        // as "nothing to see here" — the wrong default for a comparison.
        status: STATUSES.includes(p.status) ? p.status : 'differs',
        note: p.note || null,
      })),
    actionsForPm: Array.isArray(data.actionsForPm) ? data.actionsForPm.filter(Boolean) : [],
  };

  return { review, markdown: renderMarkdown({ rfi, review, response }) };
}

module.exports = { compareToResponse, VERDICTS, STATUSES, STATUS_LABEL };
