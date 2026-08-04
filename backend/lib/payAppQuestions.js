// The clarifying questions the reviewer is asked before a pay app is analysed.
//
// Both standards have a "User Questions" rule, and it is a restraint as much as a
// prompt: ask only when the missing information materially prevents a reliable review
// and cannot be determined from the documents, and never hold up the whole review
// waiting for an answer. So these are derived from what is actually absent — the
// contract on file, the extracted application, the inputs already typed on the form —
// rather than asked every time from a fixed list.
//
// Deriving them in code rather than with a second AI call is deliberate: it costs no
// tokens against a tight per-minute limit, returns instantly, and asks the same
// question for the same gap every time, which is what makes the answers worth storing.

const has = v => v !== null && v !== undefined && v !== '';

// Wording note: every question is phrased for a project manager, not an accountant, and
// says plainly what it changes about the review. A question a reviewer cannot see the
// point of gets a guess for an answer, which is worse than no answer at all.
function buildQuestions({ current, contractTerms = null, retainagePolicy = null, originalContractSum = null, coLog = null, hasBackup = false } = {}) {
  const summary = current?.summary || {};
  const terms = contractTerms || {};
  const questions = [];

  const ask = q => questions.push(q);

  // Tax status drives the single most consequential finding the scan makes — on an exempt
  // job every tax charged anywhere in the backup is reportable. Guessing it wrong either
  // floods the report with false flags or misses real money.
  if (terms.taxExempt !== true && terms.taxExempt !== false) {
    ask({
      id: 'taxStatus',
      question: 'Is this project tax exempt?',
      why: 'The contract on file does not say. On an exempt job, any sales or use tax charged in the backup is money back to the owner.',
      type: 'choice',
      options: [
        { value: 'exempt', label: 'Yes — tax exempt' },
        { value: 'not_exempt', label: 'No — tax applies' },
        { value: 'unknown', label: "I don't know" },
      ],
    });
  }

  // The contractor-absorbed tax test in the tax standard turns entirely on this.
  if (terms.taxExempt !== true && !has(terms.taxTreatment)) {
    ask({
      id: 'taxInclusive',
      question: 'Does the contract price already include all taxes?',
      why: 'If it does, tax billed as a separate line is being charged twice — the contractor has to absorb it.',
      type: 'choice',
      options: [
        { value: 'inclusive', label: 'Yes — the price includes tax' },
        { value: 'separate', label: 'No — tax is billed separately and reimbursed' },
        { value: 'unknown', label: "I don't know" },
      ],
    });
  }

  // Contract type sets what the standard's hierarchy treats as billable at all.
  if (!has(terms.contractType)) {
    ask({
      id: 'contractType',
      question: 'What kind of contract is this?',
      why: 'Cost-plus and GMP jobs allow costs to be billed that a lump-sum job does not.',
      type: 'choice',
      options: [
        { value: 'lump_sum', label: 'Lump sum / stipulated sum' },
        { value: 'gmp', label: 'Guaranteed maximum price (GMP)' },
        { value: 'cost_plus', label: 'Cost plus fee' },
        { value: 'unit_price', label: 'Unit price' },
        { value: 'tm', label: 'Time and materials' },
        { value: 'unknown', label: "I don't know" },
      ],
    });
  }

  // Retainage: only ask when neither the contract, the form, nor the application itself
  // gives a rate. If the application prints one, the checks already have it.
  const rateOnForm = has(summary.line5aRate) || has(summary.line5bRate);
  if (!retainagePolicy && terms.retainageRate == null && !rateOnForm) {
    ask({
      id: 'retainageRate',
      question: 'What retainage percentage does this contract hold?',
      why: 'Neither the contract nor this application states it, so retainage cannot be independently checked without it.',
      type: 'number',
      unit: '%',
      placeholder: '10',
    });
  }

  // Markup rules are what the subcontractor reconciliation measures GC billing against.
  if (!has(terms.markupLimits) && !has(terms.overheadProfitRate)) {
    ask({
      id: 'markupLimits',
      question: 'What markup is the contractor allowed on subcontractor work?',
      why: 'Without it, the difference between what a sub billed and what the GC billed cannot be judged as allowed or excessive.',
      type: 'text',
      placeholder: 'e.g. 10% overhead and profit, 1.5% bond — or "not stated"',
    });
    ask({
      id: 'markupOnMarkup',
      question: "Can the contractor mark up a subcontractor's own markup?",
      why: 'Compounded markup through several tiers is a common overcharge, and most contracts forbid it.',
      type: 'choice',
      options: [
        { value: 'no', label: 'No — markup on direct cost only' },
        { value: 'yes', label: 'Yes — the contract allows it' },
        { value: 'unknown', label: "I don't know" },
      ],
    });
  }

  // Pending change orders billed as if approved is a Critical finding under the standard,
  // but only when the contract does not permit it.
  ask({
    id: 'pendingCos',
    question: 'Can pending or unapproved change orders be billed on this application?',
    why: 'If not, anything billed against an unexecuted change order should be held.',
    type: 'choice',
    options: [
      { value: 'no', label: 'No — approved changes only' },
      { value: 'yes', label: 'Yes — the owner has authorised it' },
      { value: 'unknown', label: "I don't know" },
    ],
  });

  // Retainage release without written authorisation is a High finding. Only worth asking
  // when the application actually shows retainage being reduced.
  if (has(summary.line5) && has(summary.line4) && summary.line4 > 0) {
    const retainedPct = (summary.line5 / summary.line4) * 100;
    const expected = retainagePolicy?.rate != null
      ? retainagePolicy.rate * 100
      : terms.retainageRate != null ? terms.retainageRate * 100 : null;
    if (expected != null && retainedPct < expected - 0.5) {
      ask({
        id: 'retainageRelease',
        question: `This application holds ${retainedPct.toFixed(1)}% retainage where the contract calls for ${expected.toFixed(1)}%. Has a release been authorised in writing?`,
        why: 'Releasing retainage without written authorisation is one of the more expensive things to miss.',
        type: 'choice',
        options: [
          { value: 'yes', label: 'Yes — authorised in writing' },
          { value: 'no', label: 'No — not that I know of' },
          { value: 'unknown', label: "I don't know" },
        ],
      });
    }
  }

  // Notary and tax treatment are both jurisdiction-specific; the standard is explicit that
  // the project's location does not by itself establish the notary's commissioning state.
  if (hasBackup && !has(terms.jurisdiction)) {
    ask({
      id: 'jurisdiction',
      question: 'Which state governs this project for tax and notary purposes?',
      why: 'Lien waivers and notarisations are judged against state rules, and they are not always the state the job sits in.',
      type: 'text',
      placeholder: 'e.g. Texas',
    });
  }

  // The standard defaults the tolerance to a cent, but a reviewer who knows this
  // contractor rounds to the dollar will not want cent-level noise.
  //
  // This governs the document review only. The arithmetic checks keep their own fixed
  // tolerances (two cents per line, a dollar in aggregate) because those exist to catch
  // a form that does not add up, which is true regardless of what anyone considers
  // material — so the question says "flag" rather than implying it loosens the maths.
  ask({
    id: 'tolerance',
    question: 'How large does a difference have to be before it is worth flagging?',
    why: 'Applies to the document review. Raise it if this contractor rounds and you do not want cent-level noise.',
    type: 'choice',
    options: [
      { value: '0.01', label: '$0.01 — flag everything (default)' },
      { value: '1', label: '$1' },
      { value: '100', label: '$100' },
      { value: '1000', label: '$1,000' },
    ],
    default: '0.01',
  });

  // A catch-all. The standards cannot enumerate what a PM knows about their own job —
  // a disputed line, a side agreement, an owner-approved exception that is nowhere in
  // the documents — and that context is often what makes a finding right or wrong.
  ask({
    id: 'notes',
    question: 'Anything else about this application we should know?',
    why: 'Owner-approved exceptions, disputes, or side agreements that are not in the documents.',
    type: 'text',
    placeholder: 'Optional',
  });

  return questions;
}

const CHOICE_LABEL = (question, value) =>
  question.options?.find(o => o.value === value)?.label || value;

// Turns the reviewer's answers into a block for the prompt. Unanswered and explicitly
// "I don't know" questions are dropped rather than passed through — telling the model
// the reviewer does not know something adds nothing it could not already see, and a
// wall of "unknown" dilutes the answers that do carry information.
function formatAnswers(questions, answers) {
  if (!answers) return '';
  const lines = [];
  for (const q of questions) {
    const raw = answers[q.id];
    if (!has(raw) || raw === 'unknown') continue;
    const value = q.type === 'choice' ? CHOICE_LABEL(q, raw) : raw;
    lines.push(`- ${q.question}\n  ${q.unit === '%' ? `${value}%` : value}`);
  }
  if (!lines.length) return '';

  return `
The project manager reviewing this application was asked about the things the documents
do not settle, and answered:

${lines.join('\n')}

Treat these as established fact about this contract — they come from the reviewer, who
has seen the job. Where an answer conflicts with what a document appears to say, say so
rather than silently picking one.
`;
}

// A retainage rate given in answer to a question is a real contract term, so it should
// drive the arithmetic the same way a rate typed into the form does.
function retainageFrom(answers) {
  const raw = answers?.retainageRate;
  const parsed = raw != null ? parseFloat(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return null;
  return { rate: parsed / 100, reductionMilestonePct: null, reducedRate: null };
}

module.exports = { buildQuestions, formatAnswers, retainageFrom };
