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
      agreements: {
        type: 'array',
        description: 'Points where the prediction and the A/E agree. Short phrases, not '
          + 'sentences. Empty if they do not agree on anything substantive.',
        items: { type: 'string' },
      },
      differences: {
        type: 'array',
        description: 'Each material difference, one entry per difference. Only real '
          + 'differences of substance — not differences of wording, emphasis or detail that do '
          + 'not change what gets built. If the verdict is "contradicted" or '
          + '"partly_confirmed" this MUST contain at least one entry: the difference the '
          + 'verdict is referring to. An empty list is only correct when the verdict is '
          + '"confirmed" or "not_comparable".',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string', description: 'What the difference is about, in a few words.' },
            predicted: { type: 'string', description: 'What the documents indicated.' },
            actual: { type: 'string', description: 'What the A/E actually said.' },
            whyItMatters: {
              type: 'string',
              description: 'The practical consequence for the PM — what gets built differently, '
                + 'costs more, or takes longer.',
            },
          },
          required: ['point', 'predicted', 'actual'],
        },
      },
      newInformation: {
        type: 'string',
        description: 'Anything the A/E relied on that was not in the documents read — a '
          + 'decision, a field condition, a revision, an intent not drawn. Omit if there is none.',
      },
      changeOrderRisk: {
        type: 'string',
        description: 'Plain English: does the gap between the documents and this answer look '
          + 'like a change order or a delay claim, and on whose account? Omit if the answer '
          + 'sits squarely within the contract documents.',
      },
      actionsForPm: {
        type: 'array',
        description: 'What the PM should do now, given the difference. Specific and practical: '
          + 'a drawing to have revised, a price to ask for, a position to take, a record to '
          + 'make. Empty ONLY if the answer simply confirms the documents and needs nothing — '
          + 'wherever there is a difference there is something to do, if only to record the '
          + 'direction and get it priced.',
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
        description: 'ONE sentence for the PM, summarising what you set out above: did the A/E '
          + 'answer the way the documents suggested, and if not, what changed? No preamble.',
      },
    },
    required: ['differences', 'actionsForPm', 'verdict', 'headline'],
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

Record your comparison with the record_response_comparison tool.

Rules:
- The PM already knows what the A/E said. The value here is the gap: where the answer departs
  from what the contract documents showed, and what that costs them.
- The headline summarises; the fields carry the detail. Never state a difference in the
  headline that does not also appear as an entry in "differences" — the headline is one line
  in a panel and the entries are what the PM reads, forwards and prices.
- Only report differences of substance. A different way of phrasing the same instruction is
  not a difference. If the A/E confirmed the documents, say so plainly and return no
  differences — that is a useful and common answer.
- Where the A/E has directed something the drawings do not show, say so directly. That is the
  single most valuable thing on this page: work not in the contract documents is work somebody
  has to pay for, and the PM needs to see it the day the answer arrives, not at the pay
  application.
- Be careful about blame. Report what the documents showed and what the A/E directed. Whether
  that is a design change, a clarification or a contractor error is often a judgement the PM
  makes with information you do not have.
- If the A/E asked for more information rather than answering, the verdict is
  "not_comparable" — say what they still need.
- The prediction was advisory and may simply have been wrong. Where the A/E clearly had
  information the documents did not carry, say that rather than presenting it as a conflict.
- Write for a reader who is not a specialist in this trade.`;
}

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

  if (review.differences?.length) {
    lines.push('## Where the answer differs from the documents');
    lines.push('');
    for (const d of review.differences) {
      lines.push(`### ${d.point}`);
      lines.push('');
      lines.push(`- **The documents showed:** ${d.predicted}`);
      lines.push(`- **The A/E directed:** ${d.actual}`);
      if (d.whyItMatters) lines.push(`- **Why it matters:** ${d.whyItMatters}`);
      lines.push('');
    }
  } else {
    lines.push('_No material differences between the answer and the contract documents._');
    lines.push('');
  }

  if (review.agreements?.length) {
    lines.push('## Where they agree');
    lines.push('');
    for (const a of review.agreements) lines.push(`- ${a}`);
    lines.push('');
  }
  if (review.newInformation) {
    lines.push('## Information the A/E had that the documents did not carry');
    lines.push('');
    lines.push(review.newInformation);
    lines.push('');
  }
  if (review.changeOrderRisk) {
    lines.push('## Change order or delay exposure');
    lines.push('');
    lines.push(review.changeOrderRisk);
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
const isSelfContradictory = data =>
  DEPARTURES.has(data?.verdict) && !(Array.isArray(data.differences) && data.differences.length);

const CORRECTION = `Your answer said the A/E departed from the documents but listed no entry in
"differences". Those two cannot both be right. Call the tool again: either list each departure
as its own entry in "differences" — with what the documents showed, what the A/E directed, and
why it matters — or, if on reflection the A/E did confirm the documents, set the verdict to
"confirmed".`;

// analysis / sources: the stored prediction, as saved by lib/rfiAnalysis.
// response: { action, notes, respondedBy, dateReturned } — the A/E's answer as logged.
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
    agreements: Array.isArray(data.agreements) ? data.agreements.filter(Boolean) : [],
    differences: Array.isArray(data.differences) ? data.differences.filter(d => d && d.point) : [],
    newInformation: data.newInformation || null,
    changeOrderRisk: data.changeOrderRisk || null,
    actionsForPm: Array.isArray(data.actionsForPm) ? data.actionsForPm.filter(Boolean) : [],
  };

  return { review, markdown: renderMarkdown({ rfi, review, response }) };
}

module.exports = { compareToResponse, VERDICTS };
