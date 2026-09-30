const { askForJson } = require('./aiJson');
const { money } = require('./money');
const { workRows } = require('./cmarChecks');

// The half of the audit that is not arithmetic.
//
// Whether a subcontractor's billing ties to the right line of the schedule of values, whether an
// invoice looks inflated or duplicated, whether a charge is even in the scope of the work being
// paid for — none of that is a subtraction, and none of it can be decided from a figure alone.
//
// WHY THIS DOES NOT SEE THE PDF AGAIN
//
// It reads the transcription instead. The packet has already been read once, carefully, with the
// pages in front of the model; sending the whole thing a second time to ask "does anything look
// duplicated" would double the most expensive part of the review to answer a question that the
// transcription answers just as well. What matters here is the relationship between figures, and
// the figures are all present.
//
// The deterministic findings go in too, so the summary can lead with what was actually wrong rather
// than re-deciding it. Nothing here can overturn an arithmetic finding — the model is being asked
// to explain and prioritise, not to re-audit.

const JUDGEMENT_TOOL = {
  name: 'record_judgement',
  description: 'Record the judgement calls on a pay application that arithmetic cannot settle.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Two or three sentences: what is being asked for, whether it is arithmetically '
          + 'sound, and the headline reasons it should not be certified as it stands. Write for '
          + 'someone deciding whether to release money, not for a contractor. If there is nothing '
          + 'wrong, say that plainly rather than manufacturing concern.',
      },
      subcontractorMatching: {
        type: 'array',
        description: 'One entry per subcontractor whose application is in the packet.',
        items: {
          type: 'object',
          properties: {
            firmName: { type: 'string', description: 'The firm, exactly as named in the packet.' },
            sovItems: {
              type: 'array',
              description: 'The schedule-of-values line item description(s) this firm\'s billing '
                + 'should land in. A firm\'s billing is often split across several — base scope in '
                + 'one, change-order draws in a contingency or allowance bucket. List them all.',
              items: { type: 'string' },
            },
            // THE RETAINAGE-BASIS TRAP.
            //
            // A subcontractor's G702 "AMOUNT CERTIFIED" is the payment due — NET of retainage. The
            // prime's G703 "THIS APPLICATION" column is GROSS. Compared directly, every
            // subcontractor on a 5% job shows a variance of exactly 5% of their billing, and a PM
            // shown four phantom variances stops reading the ones that are real.
            //
            // So both figures are asked for separately and named by their basis, and whether they
            // tie is decided in code from the gross pair. The model is not asked to hold the
            // distinction in its head while also doing the subtraction.
            subGrossThisPeriod: {
              type: 'number',
              description: 'What this firm billed this period BEFORE retainage — the total of their '
                + 'own G703 "this period" column, or their G702 Line 4 progression. Gross, not the '
                + 'amount certified.',
            },
            subAmountCertified: {
              type: 'number',
              description: 'The AMOUNT CERTIFIED / payment due on this firm\'s own G702 — which is '
                + 'normally NET of their retainage. Record it as printed; it is cross-checked '
                + 'against the gross figure rather than compared to the prime\'s schedule directly.',
            },
            sovThisPeriod: {
              type: 'number',
              description: 'What the matched schedule-of-values item(s) on the PRIME\'s continuation '
                + 'sheet show this period, added up. This column is gross.',
            },
            explanation: {
              type: 'string',
              description: 'What the relationship between this firm and those line items is, in one '
                + 'or two sentences — including when you could not find a matching line at all, '
                + 'which is a different problem from one that disagrees. Do not state whether the '
                + 'figures tie; that is worked out from the numbers you record.',
            },
          },
          required: ['firmName', 'ties'],
        },
      },
      untraceable: {
        type: 'array',
        description: 'Amounts billed this period with NO traceable backup at all — no invoice, no '
          + 'job-cost entry, no subcontractor application. This is distinct from backup that exists '
          + 'but does not tie exactly; do not list those here.',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'The schedule-of-values item or charge.' },
            amount: { type: 'number', description: 'The amount with no backup.' },
            note: { type: 'string', description: 'One sentence on what is missing.' },
          },
          required: ['item'],
        },
      },
      invoiceConcerns: {
        type: 'array',
        description: 'Invoices that look inflated, duplicated, billed twice under different '
          + 'descriptions, or outside the scope of the work being paid for. This is a judgement '
          + 'call — say so. An empty list is a perfectly good answer and is better than a list of '
          + 'things that are merely unusual.',
        items: {
          type: 'object',
          properties: {
            vendor: { type: 'string', description: 'The vendor.' },
            invoiceNumber: { type: 'string', description: 'The invoice number.' },
            amount: { type: 'number', description: 'The amount in question.' },
            concern: { type: 'string', description: 'What looks wrong, in one or two sentences.' },
            confidence: {
              type: 'string',
              description: 'One of "likely" or "possible". Use "possible" where you cannot prove it '
                + 'and the PM should simply look.',
            },
          },
          required: ['vendor', 'concern'],
        },
      },
      worthNoting: {
        type: 'array',
        description: 'Smaller things that do not rise to an issue but should not get lost — date '
          + 'inconsistencies, unusual-but-not-wrong items, a figure that is right but surprising.',
        items: { type: 'string' },
      },
      actions: {
        type: 'array',
        description: 'The checklist, in the order a reviewer should work through it. Every issue '
          + 'raised anywhere in this review gets an entry, each with a concrete next action — '
          + '"ask the contractor to reissue the G703 with the rows corrected", not "look into this".',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'What to do, as an instruction.' },
            why: { type: 'string', description: 'The finding it comes from, in a few words.' },
            amount: { type: 'number', description: 'The dollar amount at stake, where there is one.' },
            blocking: {
              type: 'boolean',
              description: 'True when the application should not be certified until this is resolved.',
            },
          },
          required: ['action', 'blocking'],
        },
      },
    },
    required: ['summary', 'actions'],
  },
};

const SYSTEM = 'You are a construction project manager reviewing a pay application before certifying '
  + 'payment. You have already had the arithmetic checked — those results are given to you and are '
  + 'correct. Your job is the part arithmetic cannot settle.\n\n'
  + 'Be direct about what is wrong. Where the contract language supports it, "this is not payable" '
  + 'beats "this may warrant review". But every claim must rest on a specific figure or a specific '
  + 'contract section, and where you are guessing, say you are guessing. The report is persuasive '
  + 'because it is precise, not because it is alarmist.\n\n'
  + 'Write in plain English for a reader who is not a cost accountant. No jargon where an ordinary '
  + 'word will do.';

// The transcription, flattened into something readable. The model reads this better than it reads
// raw JSON, and it costs a fraction of re-sending the document.
function describePacket(packet, checks, terms) {
  const cert = packet.certificate || {};
  const lines = [
    `PROJECT: ${packet.projectName || 'not stated'}`,
    `OWNER: ${packet.ownerName || 'not stated'}`,
    `CONTRACTOR: ${packet.contractorName || 'not stated'}`,
    `APPLICATION NO: ${cert.applicationNumber || 'not stated'}, period to ${cert.periodTo || 'not stated'}`,
    '',
    'THE CERTIFICATE',
    `  Line 1 Original Contract Sum       ${money(cert.line1OriginalContractSum)}`,
    `  Line 2 Net Change by Change Orders ${money(cert.line2NetChangeByChangeOrders)}`,
    `  Line 3 Contract Sum to Date        ${money(cert.line3ContractSumToDate)}`,
    `  Line 4 Completed and Stored        ${money(cert.line4CompletedAndStoredToDate)}`,
    `  Line 5 Retainage                   ${money(cert.line5Retainage)}`,
    `  Line 6 Earned Less Retainage       ${money(cert.line6TotalEarnedLessRetainage)}`,
    `  Line 7 Less Previous Certificates  ${money(cert.line7LessPreviousCertificates)}`,
    `  Line 8 CURRENT PAYMENT DUE         ${money(cert.line8CurrentPaymentDue)}`,
    `  Line 9 Balance to Finish           ${money(cert.line9BalanceToFinish)}`,
    '',
    'SCHEDULE OF VALUES (work rows, this period only shown where nonzero)',
  ];

  for (const row of workRows(packet.sovRows)) {
    const active = row.thisPeriod || row.completedToDate;
    if (!active) continue;
    lines.push(`  ${row.description}${row.isContingencyOrAllowance ? ' [contingency/allowance]' : ''}`
      + ` — scheduled ${money(row.scheduledValue)}, this period ${money(row.thisPeriod)}, `
      + `to date ${money(row.completedToDate)}`);
  }

  if ((packet.subApplications || []).length) {
    lines.push('', 'SUBCONTRACTOR APPLICATIONS');
    for (const sub of packet.subApplications) {
      const c = sub.certificate || {};
      const thisPeriod = (sub.sovRows || []).reduce((t, r) => t + (r.thisPeriod || 0), 0);
      lines.push(`  ${sub.firmName} — ${sub.scopeDescription || 'scope not stated'}`);
      lines.push(`    contract to date ${money(c.line3ContractSumToDate)}, completed ${money(c.line4CompletedAndStoredToDate)}, `
        + `this period ${money(thisPeriod)}, payment due ${money(c.line8CurrentPaymentDue)}`);
      if (sub.newChangeOrdersThisPeriod) {
        lines.push(`    change orders newly approved this period: ${money(sub.newChangeOrdersThisPeriod)}`);
      }
      if (sub.lienWaiverIncluded === false) lines.push('    no lien waiver in the packet');
    }
  }

  if ((packet.backupInvoices || []).length) {
    lines.push('', 'BACKUP INVOICES');
    for (const inv of packet.backupInvoices) {
      lines.push(`  ${inv.vendor} #${inv.invoiceNumber || '—'} ${inv.invoiceDate || ''} — ${money(inv.total)}`
        + (inv.taxAmount ? ` (tax ${money(inv.taxAmount)})` : (inv.taxAmount === 0 ? ' (tax $0.00)' : ''))
        + (inv.description ? ` — ${inv.description}` : '')
        + (inv.billedUnder ? ` — billed under ${inv.billedUnder}` : ''));
    }
  }

  if (terms) {
    lines.push('', 'THE CONTRACT');
    lines.push(`  Form: ${terms.contractForm || 'not identified'}`);
    if (terms.gmp) lines.push(`  GMP: ${money(terms.gmp)}`);
    if (terms.retainagePercent != null) lines.push(`  Retainage: ${terms.retainagePercent}% ${terms.retainageClause || ''}`);
    if (terms.cmFeePercent != null) lines.push(`  CM fee: ${terms.cmFeePercent}% ${terms.cmFeeClause || ''}`);
    if (terms.taxExemptionClause?.present) {
      lines.push(`  Tax exemption: ${terms.taxExemptionClause.section || ''} — "${terms.taxExemptionClause.quote || ''}"`);
    }
    for (const t of terms.otherRelevantTerms || []) {
      lines.push(`  ${t.topic} (${t.section || 'section not stated'}): ${t.requirement}`);
    }
    if ((terms.figuresNotStated || []).length) {
      lines.push(`  NOT STATED in this document: ${terms.figuresNotStated.join(', ')}`);
    }
  } else {
    lines.push('', 'THE CONTRACT: not provided. This is an arithmetic check only — nothing here has '
      + 'been checked against contracted rates, tax exemption, or change-order limits.');
  }

  lines.push('', 'ARITHMETIC ALREADY CHECKED (these results are correct; do not re-derive them)');
  for (const f of checks.findings) {
    const mark = { pass: 'OK', fail: 'ISSUE', note: 'minor', unknown: 'not checkable' }[f.status];
    lines.push(`  [${mark}] ${f.subject ? `${f.subject}: ` : ''}${f.title} — ${f.detail}`);
  }

  return lines.join('\n');
}

async function judge({ packet, checks, terms }) {
  const text = describePacket(packet, checks, terms);
  return askForJson({
    content: [{
      type: 'text',
      text: `${text}\n\n---\n\nRecord your judgement using the tool.\n\n`
        + 'Match each subcontractor to the schedule-of-values line items their billing should land '
        + 'in, by firm name and scope. Remember that one firm\'s billing is often split across '
        + 'several items. Then look at the invoices for anything inflated, duplicated or out of '
        + 'scope, and write the action checklist.\n\n'
        + (terms ? '' : 'No contract was provided. Say so in the summary, and do not speculate about '
          + 'contracted rates, tax exemption or change-order limits — note them as unchecked instead.'),
    }],
    tool: JUDGEMENT_TOOL,
    system: SYSTEM,
    cacheTool: true,
    maxTokens: 8000,
    label: 'cmar judgement',
  });
}

module.exports = { judge, describePacket, JUDGEMENT_TOOL };
