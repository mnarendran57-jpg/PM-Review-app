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

// What each row of the comparison is. Four kinds, because there are exactly four ways the
// prediction and the A/E can differ, and the PM does something different about each.
const STATUSES = ['agreed', 'ae_only', 'beyond_spec', 'waived'];

// Field order is load-bearing. A tool call is generated top to bottom, so the detail is
// enumerated first and the verdict and headline are written last, once that detail exists.
const COMPARISON_TOOL = {
  name: 'record_submittal_review_comparison',
  description: "Compare the A/E's actual review of a submittal with the one predicted from the specification.",
  input_schema: {
    type: 'object',
    properties: {
      // One array, not four.
      //
      // This used to be four separate lists of prose — what was confirmed, what the prediction
      // missed, what went beyond the specification, what was waived — each written as full
      // sentences and stacked down the panel. Everything a reader needed was in there, and
      // finding any of it meant reading all of it. But every one of those entries is the same
      // shape of fact: a point, what the specification said about it, what the A/E said about
      // it. Written that way it is a table, and a table is read in one glance instead of four
      // paragraphs. The distinction the four lists carried is not lost — it is the status
      // column, which is also what colours the row.
      points: {
        type: 'array',
        description: 'One row per point of substance, most consequential first. Together these '
          + 'are the whole comparison — every difference and every agreement worth the PM\'s '
          + 'attention, and nothing else. Omit anything you would only include for completeness.',
        items: {
          type: 'object',
          properties: {
            point: {
              type: 'string',
              description: 'What it is about: a noun phrase of 2 to 6 words, never a sentence. '
                + '"Gate valve seat type", "Manufacturer certificates", "Hanger spacing".',
            },
            specSaid: {
              type: 'string',
              description: 'What the specification required, in AT MOST 12 words — the value or '
                + 'the requirement itself, not a description of it. "AWWA C515, resilient '
                + 'seated" beats "the specification requires that valves be resilient seated". '
                + 'Write "Silent" if it did not address this, and "Not in what was read" if the '
                + 'governing text was never reached.',
            },
            aeSaid: {
              type: 'string',
              description: "What the A/E said or directed, in AT MOST 12 words. Their words "
                + 'where they are short enough to use.',
            },
            status: {
              type: 'string',
              enum: STATUSES,
              description: '"agreed" — the prediction raised this and so did the A/E. '
                + '"ae_only" — the A/E raised it and the prediction did not. '
                + '"beyond_spec" — the A/E asked for something the specification does not '
                + 'require. This is the row that is worth money, so use it only where the '
                + 'prediction actually recorded what the specification requires. '
                + '"waived" — the prediction found a departure and the A/E let it through.',
            },
            note: {
              type: 'string',
              description: 'ONLY where there is a consequence in money or time — a price to '
                + 'ask for, a lead time, a resubmittal, another trade affected. At most 15 '
                + 'words. Omit it entirely on a row that just records agreement; a note on '
                + 'every row is a note on none.',
            },
          },
          required: ['point', 'aeSaid', 'status'],
        },
      },
      actionsForPm: {
        type: 'array',
        description: 'What the PM should do now, at most 4 entries, most urgent first. Each one '
          + 'starts with a verb and runs to at most 12 words: "Price the added isolation valves '
          + 'before resubmittal." Empty ONLY when the A/E approved it cleanly and nothing needs '
          + 'doing.',
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
        description: 'ONE sentence, at most 25 words, and it must say something the table does '
          + 'not repeat: what the difference amounts to for this PM. No preamble, no restating '
          + 'the stamp — it is printed beside this line.',
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

Record your comparison as a TABLE. Every row is one point; the three columns are what it is
about, what the specification said, and what the A/E said. The PM reads this at a glance
between site visits, so write cells, not paragraphs.

Rules:
- The PM already knows what the A/E stamped. The value here is the gap.
- Length is a feature. A cell over a dozen words stops being scannable and becomes something
  to read, which defeats the table. Give the value, not a description of the value: "250 psig
  at 180F" beats "the specification called for a rating of 250 psig at 180 degrees".
- A short table beats a complete one. Rows the PM would not act on or forward do not earn
  their line. If the A/E and the prediction simply agreed on everything, a handful of "agreed"
  rows and no note is the right answer.
- "beyond_spec" is the most valuable row on the page. An A/E comment asking for something the
  specification does not require is a change to the work, and the day it arrives is the day to
  price it — not at the pay application three months later. But only use it where the
  prediction actually recorded what the specification requires. If the governing section was
  never read, you cannot know it is not in there — put "Not in what was read" in specSaid and
  use "ae_only" instead.
- Be fair to the A/E. They hold the design and often know things the specification does not
  say. Report what the specification required and what they directed; whether that is a design
  change, a clarification or a contractor error is a judgement the PM makes.
- "ae_only" must be honest. The prediction was advisory and read only part of the documents;
  where the A/E caught something real that it did not, give it its row. A comparison that only
  ever flatters the prediction is worthless.
- If the A/E approved the submittal while the prediction found a real departure, that row is
  "waived". Approval is not a waiver of the specification.
- If the A/E returned it without reviewing the merits — wrong package, incomplete, wrong
  section — the verdict is "not_comparable", the table is short or empty, and the action is
  simply what they need.
- Never state something in the headline that is not also in a row. The headline is one line in
  a panel; the rows are what the PM reads, forwards and prices.
- Write for a project manager who is not a specialist in this trade.`;
}

const VERDICT_LABEL = {
  as_expected: 'The A/E reviewed it as the specification suggested',
  stricter: 'The A/E asked for more than the specification requires',
  more_lenient: 'The A/E accepted departures from the specification',
  different_grounds: 'The same outcome, on grounds the prediction did not find',
  not_comparable: 'The A/E did not review it on the merits',
};

// How each row reads in a document, where colour is not available to carry the meaning.
const STATUS_LABEL = {
  agreed: 'Both flagged it',
  ae_only: 'A/E only',
  beyond_spec: 'Beyond the spec',
  waived: 'Let through',
};

// A pipe inside a cell would end the column early and shift every value after it one place to
// the left — so a valve rated "250 psig | 180F" would silently corrupt the row it sits in.
const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';

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

  if (review.points?.length) {
    L.push('| | Point | The specification said | The A/E said |');
    L.push('|---|---|---|---|');
    for (const p of review.points) {
      L.push(`| ${STATUS_LABEL[p.status] || ''} | ${cell(p.point)} | ${cell(p.specSaid)} | ${cell(p.aeSaid)} |`);
    }
    L.push('');
    // Notes sit under the table rather than in a fifth column: they are the one part that is
    // a sentence, and a column of sentences is what stops a table being scannable.
    const noted = review.points.filter(p => p.note);
    if (noted.length) {
      for (const p of noted) L.push(`- **${p.point}** — ${p.note}`);
      L.push('');
    }
    if (review.points.some(p => p.status === 'waived')) {
      L.push('_Approval is not a waiver of the specification. Worth a record._');
      L.push('');
    }
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
const isSelfContradictory = (d) => {
  const rows = Array.isArray(d?.points) ? d.points : [];
  return d?.verdict === 'stricter'
    && !rows.some(p => p && (p.status === 'beyond_spec' || p.status === 'ae_only'));
};

const CORRECTION = `Your answer said the A/E asked for more than the specification requires but
gave no row with status "beyond_spec" or "ae_only". Those cannot both be right. Call the tool
again: either give each thing the A/E asked for its own row — what it is about, what the
specification said, what they directed — or, if on reflection they were applying the
specification, change the verdict to match.`;

// analysis / sources: the stored prediction, as saved by lib/submittalAnalysis.
// response: { action, notes, reviewedBy, dateReturned } — the A/E's review as logged.
async function compareToReview({ submittal, analysis, sources, response }) {
  const content = [{ type: 'text', text: buildPrompt({ submittal, analysis, sources, response }) }];
  const ask = blocks => askForJson({
    content: blocks,
    tool: COMPARISON_TOOL,
    // 1,250 tokens of schema, and asked twice whenever the first answer contradicts itself — see
    // the corrective pass below. Cached, the second ask costs a tenth.
    cacheTool: true,
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
    points: (Array.isArray(data.points) ? data.points : [])
      .filter(p => p && p.point && p.aeSaid)
      .map(p => ({
        point: p.point,
        specSaid: p.specSaid || null,
        aeSaid: p.aeSaid,
        // An unrecognised status would otherwise render as an uncoloured row with no label,
        // which reads as "nothing to see here" — the wrong default for a comparison.
        status: STATUSES.includes(p.status) ? p.status : 'ae_only',
        note: p.note || null,
      })),
    actionsForPm: Array.isArray(data.actionsForPm) ? data.actionsForPm.filter(Boolean) : [],
    // Kept so the panel can show "predicted X, got Y" without re-reading the analysis row.
    predictedAction: analysis.likelyAction || null,
    actualAction: response.action || null,
  };

  return { review, markdown: renderMarkdown({ submittal, review, analysis, response }) };
}

module.exports = { compareToReview, VERDICTS, VERDICT_LABEL, STATUSES, STATUS_LABEL };
