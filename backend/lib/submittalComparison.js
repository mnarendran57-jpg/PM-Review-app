const { askForJson } = require('./aiJson');

// Reads the A/E's actual review against the one Coaster predicted, and tells the PM what the
// difference means.
//
// The same idea as lib/rfiComparison.js, and the PM's question is the same shape: not "what
// did the A/E say" — the stamp is right there — but "is this what the specification said, and
// if not, what does that change?" On a submittal, three answers are worth money:
//
//   * The A/E marked something the specification does not require. That is a design change
//     arriving as a review comment, and it is the cheapest change order in the world to miss.
//   * The A/E approved something that departs from the specification. Approval is not a waiver,
//     but it is evidence, and the PM should know they now hold it.
//   * The A/E sent it back for something Coaster saw first and nobody fixed. That is a
//     resubmittal the project paid three weeks for and did not have to.
//
// No documents are re-sent. Both sides are already text, so this is a small call — which
// matters on an account limited to 10,000 input tokens a minute.

const VERDICTS = ['as_expected', 'stricter', 'more_lenient', 'different_grounds', 'not_comparable'];

// Field order is load-bearing. A tool call is generated top to bottom, so the detail is
// enumerated first and the verdict and headline are written last, once that detail exists.
const COMPARISON_TOOL = {
  name: 'record_submittal_review_comparison',
  description: "Compare the A/E's actual review of a submittal with the one predicted from the specification.",
  input_schema: {
    type: 'object',
    properties: {
      confirmed: {
        type: 'array',
        description: 'Deviations Coaster predicted that the A/E also picked up. Short phrases. '
          + 'Empty if the A/E raised none of them.',
        items: { type: 'string' },
      },
      missedByPrediction: {
        type: 'array',
        description: 'Things the A/E raised that the prediction did not. One entry each. This '
          + 'is how the reader calibrates how much to trust the next prediction, so do not '
          + 'soften it.',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string', description: 'What the A/E raised, in a few words.' },
            aeComment: { type: 'string', description: "The A/E's comment, quoted or closely paraphrased." },
            inTheSpecification: {
              type: 'string',
              description: 'Whether the specification actually required this, so far as can be '
                + 'told from the prediction\'s recorded basis. Say "not in what was read" if '
                + 'the prediction never saw the governing text.',
            },
          },
          required: ['point', 'aeComment'],
        },
      },
      // The finding that pays for this whole feature.
      notInTheContract: {
        type: 'array',
        description: 'Comments the A/E made that the specification does NOT appear to require '
          + '— a preference, a tightened tolerance, an added item, a product change. One entry '
          + 'each. Only where the prediction recorded what the specification requires and this '
          + 'goes beyond it. Empty is common and correct; do not manufacture entries.',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            aeDirected: { type: 'string', description: 'What the A/E asked for.' },
            specificationSaid: { type: 'string', description: 'What the specification required instead, or that it was silent.' },
            whyItMatters: {
              type: 'string',
              description: 'The practical consequence — added cost, a longer lead time, a '
                + 'resubmittal, a change to another trade.',
            },
          },
          required: ['point', 'aeDirected'],
        },
      },
      approvedDespite: {
        type: 'array',
        description: 'Deviations the prediction found that the A/E approved anyway, or did not '
          + 'mention. Worth recording: approval is not a waiver of the specification, and the '
          + 'PM should know what they are now holding.',
        items: { type: 'string' },
      },
      actionsForPm: {
        type: 'array',
        description: 'What the PM should do now. Specific and practical: a price to ask for, a '
          + 'comment to push back on, a record to make, an item to chase before resubmittal. '
          + 'Empty ONLY when the A/E approved it cleanly and nothing needs doing.',
        items: { type: 'string' },
      },
      // Last on purpose: both summarise the fields above.
      verdict: {
        type: 'string',
        enum: VERDICTS,
        description: '"as_expected" — the A/E landed where the prediction did, for the same '
          + 'reasons. "stricter" — the A/E asked for more than the specification requires, or '
          + 'marked things the prediction found compliant. "more_lenient" — the A/E accepted '
          + 'departures the prediction flagged. "different_grounds" — the same stamp, but for '
          + 'reasons the prediction did not find. "not_comparable" — the A/E did not review it '
          + 'on the merits (returned for procedure, wrong section, incomplete package).',
      },
      headline: {
        type: 'string',
        description: 'ONE sentence for the PM, summarising what you set out above: did the A/E '
          + 'review it the way the specification suggested, and if not, what changed? No preamble.',
      },
    },
    required: ['verdict', 'headline', 'actionsForPm'],
  },
};

function buildPrompt({ submittal, analysis, sources, response }) {
  const read = (sources || []).map((s) => {
    const what = s.wholeDocument ? 'read in full'
      : s.sections?.length ? `sections ${s.sections.map(x => x.sectionNumber).filter(Boolean).join(', ')}`
        : `${s.pagesUsed} pages`;
    return `  - ${s.label} (${what})`;
  }).join('\n') || '  (not recorded)';

  const deviations = (analysis.deviations || []).map(d =>
    `  - ${d.item} [${d.severity}]: specification requires ${d.required}; submitted ${d.submitted}`)
    .join('\n') || '  (none found)';

  const basis = (analysis.basis || []).map(b =>
    `  - ${b.document}${b.section ? ` — ${b.section}` : ''}: ${b.requires}`).join('\n') || '  (none recorded)';

  return `You are advising the owner's project manager on a construction submittal that the
architect/engineer (A/E) has just reviewed and returned.

Before it went out, Coaster read the submittal against the specification and predicted how it
would be reviewed. That prediction and the A/E's actual review are both below. Compare them and
tell the PM what the difference means.

THE SUBMITTAL
Number: ${submittal.submittal_number}
Description: ${submittal.description}
Specification section: ${submittal.spec_section || 'not recorded'}
Supplier: ${submittal.vendor || 'not recorded'}

WHAT COASTER PREDICTED, FROM THE SPECIFICATION
Likely action: ${analysis.likelyAction}
Confidence: ${analysis.confidence}${analysis.confidenceReason ? ` — ${analysis.confidenceReason}` : ''}
Summary: ${analysis.headline || '(none recorded)'}
Departures found:
${deviations}
${(analysis.missingSubmittalItems || []).length ? `Required but not in the package:\n${analysis.missingSubmittalItems.map(m => `  - ${m}`).join('\n')}\n` : ''}Grounded in:
${basis}
${analysis.missingInformation ? `Noted as not read at the time: ${analysis.missingInformation}\n` : ''}
Documents that prediction was read from:
${read}

WHAT THE A/E ACTUALLY RETURNED
Action: ${response.action}
${response.reviewedBy ? `Reviewed by: ${response.reviewedBy}\n` : ''}${response.dateReturned ? `Returned: ${response.dateReturned}\n` : ''}Comments:
"""
${response.notes || '(no written comments were recorded — go by the action alone)'}
"""

Record your comparison with the record_submittal_review_comparison tool.

Rules:
- The PM already knows what the A/E stamped. The value here is the gap.
- "notInTheContract" is the most valuable field on this page. An A/E comment asking for
  something the specification does not require is a change to the work, and the day it arrives
  is the day to price it — not at the pay application three months later. But only say so when
  the prediction actually recorded what the specification requires. If the governing section
  was never read, you cannot know it is not in there: say that instead.
- Be fair to the A/E. They hold the design and often know things the specification does not
  say. Report what the specification required and what they directed; whether that is a design
  change, a clarification or a contractor error is a judgement the PM makes.
- "missedByPrediction" must be honest. The prediction was advisory and read only part of the
  documents; where the A/E caught something real that it did not, say so plainly. A comparison
  that only ever flatters the prediction is worthless.
- If the A/E approved the submittal while the prediction found a real departure, say so in
  "approvedDespite". Approval is not a waiver of the specification.
- If the A/E returned it without reviewing the merits — wrong package, incomplete, wrong
  section — the verdict is "not_comparable" and the action is simply what they need.
- Never state something in the headline that is not also in one of the fields. The headline is
  one line in a panel; the entries are what the PM reads, forwards and prices.
- Write for a project manager who is not a specialist in this trade.`;
}

const VERDICT_LABEL = {
  as_expected: 'The A/E reviewed it as the specification suggested',
  stricter: 'The A/E asked for more than the specification requires',
  more_lenient: 'The A/E accepted departures from the specification',
  different_grounds: 'The same outcome, on grounds the prediction did not find',
  not_comparable: 'The A/E did not review it on the merits',
};

function renderMarkdown({ submittal, review, analysis, response }) {
  const L = [];
  L.push(`# Review comparison — ${submittal.submittal_number}: ${submittal.description}`);
  L.push('');
  L.push('> How the A/E\'s review compares with the reading Coaster made of the specification '
    + 'before it was sent. Advisory: it is the PM\'s judgement that matters, not this comparison.');
  L.push('');
  L.push(`**Verdict:** ${VERDICT_LABEL[review.verdict] || review.verdict}  `);
  L.push(`**A/E action:** ${response.action}${response.dateReturned ? ` on ${response.dateReturned}` : ''}  `);
  L.push(`**Predicted:** ${analysis.likelyAction}`);
  L.push('');
  L.push(review.headline || '');
  L.push('');

  if (review.notInTheContract?.length) {
    L.push('## Asked for, but not in the specification');
    L.push('');
    for (const n of review.notInTheContract) {
      L.push(`### ${n.point}`);
      L.push('');
      L.push(`- **The A/E directed:** ${n.aeDirected}`);
      if (n.specificationSaid) L.push(`- **The specification said:** ${n.specificationSaid}`);
      if (n.whyItMatters) L.push(`- **Why it matters:** ${n.whyItMatters}`);
      L.push('');
    }
  }
  if (review.confirmed?.length) {
    L.push('## Predicted, and the A/E agreed');
    L.push('');
    for (const c of review.confirmed) L.push(`- ${c}`);
    L.push('');
  }
  if (review.missedByPrediction?.length) {
    L.push('## Raised by the A/E, not by the prediction');
    L.push('');
    for (const m of review.missedByPrediction) {
      L.push(`- **${m.point}** — ${m.aeComment}${m.inTheSpecification ? ` _(${m.inTheSpecification})_` : ''}`);
    }
    L.push('');
  }
  if (review.approvedDespite?.length) {
    L.push('## Approved despite a departure the prediction found');
    L.push('');
    for (const a of review.approvedDespite) L.push(`- ${a}`);
    L.push('');
    L.push('_Approval is not a waiver of the specification. Worth a record._');
    L.push('');
  }
  if (review.actionsForPm?.length) {
    L.push('## What to do now');
    L.push('');
    for (const a of review.actionsForPm) L.push(`- ${a}`);
    L.push('');
  }
  return L.join('\n');
}

// A verdict claiming the A/E went beyond the specification, with nothing listed under it, is
// the one answer this must not pass on: the panel would announce a change order with nothing
// to price. Checked rather than hoped for, exactly as in lib/rfiComparison.js.
const isSelfContradictory = d =>
  d?.verdict === 'stricter'
  && !(Array.isArray(d.notInTheContract) && d.notInTheContract.length)
  && !(Array.isArray(d.missedByPrediction) && d.missedByPrediction.length);

const CORRECTION = `Your answer said the A/E asked for more than the specification requires but
listed nothing under "notInTheContract" or "missedByPrediction". Those cannot both be right.
Call the tool again: either list each thing the A/E asked for that the specification does not
require — with what they directed, what the specification said, and why it matters — or, if on
reflection they were applying the specification, change the verdict to match.`;

// analysis / sources: the stored prediction, as saved by lib/submittalAnalysis.
// response: { action, notes, reviewedBy, dateReturned } — the A/E's review as logged.
async function compareToReview({ submittal, analysis, sources, response }) {
  const content = [{ type: 'text', text: buildPrompt({ submittal, analysis, sources, response }) }];
  const ask = blocks => askForJson({
    content: blocks,
    tool: COMPARISON_TOOL,
    maxTokens: 2000,
    label: 'submittal review comparison',
  });

  let { data } = await ask(content);
  if (isSelfContradictory(data)) {
    console.warn('[submittal review comparison] verdict claimed a departure but listed none — asking again');
    try {
      const { data: second } = await ask([...content, { type: 'text', text: CORRECTION }]);
      if (!isSelfContradictory(second)) data = second;
    } catch (err) {
      console.warn(`[submittal review comparison] corrective pass failed, keeping the first: ${err.message}`);
    }
  }

  const review = {
    verdict: VERDICTS.includes(data.verdict) ? data.verdict : 'not_comparable',
    headline: data.headline || null,
    confirmed: Array.isArray(data.confirmed) ? data.confirmed.filter(Boolean) : [],
    missedByPrediction: Array.isArray(data.missedByPrediction) ? data.missedByPrediction.filter(m => m && m.point) : [],
    notInTheContract: Array.isArray(data.notInTheContract) ? data.notInTheContract.filter(n => n && n.point) : [],
    approvedDespite: Array.isArray(data.approvedDespite) ? data.approvedDespite.filter(Boolean) : [],
    actionsForPm: Array.isArray(data.actionsForPm) ? data.actionsForPm.filter(Boolean) : [],
    // Kept so the panel can show "predicted X, got Y" without re-reading the analysis row.
    predictedAction: analysis.likelyAction || null,
    actualAction: response.action || null,
  };

  return { review, markdown: renderMarkdown({ submittal, review, analysis, response }) };
}

module.exports = { compareToReview, VERDICTS, VERDICT_LABEL };
