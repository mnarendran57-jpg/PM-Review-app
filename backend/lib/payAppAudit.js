const fs = require('fs');
const path = require('path');
const { splitPdf, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// The CMAR/GMP audit standard, read once at boot and sent verbatim with every review. Held
// whole rather than parsed into sections: an earlier version split it on headings and
// silently dropped the last one, which is a failure mode worth designing out entirely. If the
// file is missing the review still runs — it simply loses the doctrine, which is better than
// the module refusing to start.
const STANDARD_PATH = path.join(__dirname, '..', 'standards', 'cmar-pay-app-audit.md');
let STANDARD = '';
try {
  STANDARD = fs.readFileSync(STANDARD_PATH, 'utf8');
} catch (err) {
  console.warn(`[pay app audit] standard not found at ${STANDARD_PATH} — reviews will run without it`);
}

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const trimmed = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
};
const asArray = value => (Array.isArray(value) ? value : []);

// The six questions the standard requires a plain pass or fail on. Kept as data so the
// prompt, the report and the PDF cannot fall out of step about what was asked.
const VERDICT_QUESTIONS = [
  { key: 'budgetTotalsMatch', label: 'Does the total budget across all items match the contract total on the summary page?' },
  { key: 'billedToDateMatches', label: 'Does the total work billed to date across all items match the summary page?' },
  { key: 'previousPaymentsCorrect', label: 'Does this application correctly show what was already paid?' },
  { key: 'subBackupComplete', label: 'Do the subcontractors each provide the full backup?' },
  { key: 'applicationNumberCorrect', label: 'Is the pay application number correct and sequential across all forms?' },
  { key: 'notarizationValid', label: 'Is the notarization valid?' },
];

// The audit comes back through a tool call rather than as parsed text. This is the module
// where that matters most: findings quote the contract's own wording and the invoices' own
// line descriptions, both full of quotation marks and inch marks, and a single one of them
// used to lose the entire audit. See lib/aiJson.js.
//
// The scope-comparison block is only offered when there is a baseline to compare against —
// a schema that always asked for it would invite the model to invent one.
function auditTool(withScopeComparison) {
  const properties = {
    verdicts: {
      type: 'object',
      description: 'A plain pass or fail on each of the standard\'s six questions.',
      properties: Object.fromEntries(VERDICT_QUESTIONS.map(q => [q.key, {
        type: 'object',
        description: q.label,
        properties: {
          pass: { type: 'boolean', description: 'Omit if it cannot be determined.' },
          detail: {
            type: 'string',
            description: 'One or two sentences of evidence — the figures compared, or what was missing.',
          },
        },
        required: ['detail'],
      }])),
    },
    recomputedLines: {
      type: 'object',
      description: 'Your own recomputation of the G702 lines from the documents.',
      properties: Object.fromEntries([
        'line1_originalContractSum', 'line2_netChangeByChangeOrders', 'line3_contractSumToDate',
        'line4_totalCompletedAndStored', 'line5_retainage', 'line6_totalEarnedLessRetainage',
        'line7_lessPreviousCertificates', 'line8_currentPaymentDue', 'line9_balanceToFinish',
      ].map(k => [k, { type: 'number' }])),
    },
    recomputationDisagreements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Which figure.' },
          stated: { type: 'number', description: 'What the form says.' },
          recomputed: { type: 'number', description: 'What you calculated.' },
          difference: { type: 'number' },
          detail: { type: 'string', description: 'What is wrong and which input drives it.' },
        },
        required: ['field', 'detail'],
      },
    },
    notarization: {
      type: 'object',
      properties: {
        signaturePresent: { type: 'boolean' },
        notaryStampPresent: { type: 'boolean' },
        notaryDate: { type: 'string', description: 'YYYY-MM-DD.' },
        certificationDate: { type: 'string', description: 'YYYY-MM-DD.' },
        commissionExpires: { type: 'string', description: 'YYYY-MM-DD.' },
        valid: { type: 'boolean' },
        detail: {
          type: 'string',
          description: 'What you actually saw on the signature page. If you could not see it, '
            + 'say so — never infer that a block is blank.',
        },
      },
      required: ['detail'],
    },
    subcontractors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Firm name as printed.' },
          billedThisPeriod: { type: 'number' },
          matchedSovLines: { type: 'string', description: 'Which GC schedule-of-values line(s) this ties to.' },
          sovAmount: { type: 'number' },
          tiesToSov: { type: 'boolean' },
          retainagePct: { type: 'number', description: 'A decimal.' },
          retainageExceedsGc: { type: 'boolean' },
          certificationDate: { type: 'string', description: 'YYYY-MM-DD.' },
          periodTo: { type: 'string', description: 'YYYY-MM-DD.' },
          certifiedBeforePeriodEnd: {
            type: 'boolean',
            description: 'True if the certification predates the period being certified, which is a defect.',
          },
          changeOrderThisPeriod: { type: 'number' },
          changeOrderMappedToContingency: { type: 'boolean' },
          lienWaiverIncluded: { type: 'boolean' },
          issues: {
            type: 'array',
            description: "Each specific problem with this subcontractor's application.",
            items: { type: 'string' },
          },
        },
        required: ['name'],
      },
    },
    taxInvoices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          invoiceRef: { type: 'string', description: 'Invoice number or description.' },
          taxAmount: { type: 'number' },
          exemptionApplied: { type: 'boolean' },
          detail: { type: 'string', description: 'What the invoice shows.' },
        },
        required: ['taxAmount'],
      },
    },
    taxTotalCharged: {
      type: 'number',
      description: 'The total tax on invoices where the exemption was NOT applied, or 0.',
    },
    taxVerdict: {
      type: 'string',
      description: 'Plain English. Where the contract makes the owner exempt and puts the burden '
        + 'of claiming it on the contractor, state directly that this amount is not payable and '
        + 'should be deducted before certifying. Only hedge where the contract is genuinely '
        + 'ambiguous. Omit if no tax clause applies.',
    },
    untracedBilling: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'What was billed.' },
          amount: { type: 'number' },
          detail: { type: 'string', description: 'Why nothing in the backup supports it.' },
        },
        required: ['item'],
      },
    },
    backupMismatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'What was billed.' },
          detail: { type: 'string', description: 'The backup exists but does not tie — say by how much.' },
        },
        required: ['item'],
      },
    },
    contractFindings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'The contract requirement.' },
          detail: { type: 'string', description: 'How this application measures against it.' },
          compliant: { type: 'boolean' },
        },
        required: ['term'],
      },
    },
    worthNoting: {
      type: 'array',
      description: 'Smaller items that are not full findings but should not be lost: rounding, '
        + 'date inconsistencies, unusual-but-not-wrong entries.',
      items: { type: 'string' },
    },
    notCheckable: {
      type: 'array',
      description: 'Any check from the standard that could not be performed, and what document '
        + 'would be needed.',
      items: { type: 'string' },
    },
    summary: {
      type: 'string',
      description: '2-3 sentences: what is being requested, whether it is arithmetically sound, '
        + 'and the headline reasons it should not be certified as-is, if any.',
    },
  };

  if (withScopeComparison) {
    properties.scopeComparison = {
      type: 'array',
      description: 'Every line billed on the current application, classified against the agreed '
        + 'schedule of values. Each current line appears exactly once.',
      items: {
        type: 'object',
        properties: {
          itemNo: { type: 'string', description: "The current application's item number." },
          description: { type: 'string', description: 'The line description.' },
          scheduledValue: { type: 'number' },
          status: {
            type: 'string',
            enum: ['in_contract', 'changed', 'covered_by_co', 'not_in_contract'],
          },
          matchedTo: {
            type: 'string',
            description: 'Which schedule-of-values line it corresponds to.',
          },
          coNumber: {
            type: 'string',
            description: 'The change order covering it, only when covered_by_co.',
          },
          note: { type: 'string', description: 'One plain sentence when the status is not in_contract.' },
        },
        required: ['description', 'status'],
      },
    };
  }

  return {
    name: 'record_pay_app_audit',
    description: 'Record the audit of a construction pay application against the CMAR standard.',
    input_schema: { type: 'object', properties, required: ['verdicts', 'summary'] },
  };
}

function buildPrompt({ contractTerms, priorApplication, codeFigures, retainageRate, fileGuide, scopeBaseline }) {
  // Carried over from the review this standard replaces: classifying every billed line
  // against the agreed schedule of values is what surfaces work nobody agreed to pay for.
  // The standard does not describe it, but dropping it would be a silent regression. The
  // shape of that classification now lives in auditTool(), which offers the field only when
  // there is a baseline to classify against.
  return `${STANDARD}

---

You are auditing the construction pay application attached to this message, following the
standard above exactly. Work through its numbered sections in order and do not skip one
silently — where a check cannot be performed, say why.

${fileGuide}

${contractTerms ? `CONTRACT TERMS ON FILE (extracted from the executed contract and confirmed by the PM):
${JSON.stringify(contractTerms, null, 2)}`
  : 'NO CONTRACT IS ON FILE FOR THIS PROJECT. Per the standard, say so plainly: the tax, fee, change-order-cap and retainage-rate checks cannot be performed, and only internal consistency has been verified.'}

${retainageRate != null ? `The contracted retainage rate is ${(retainageRate * 100).toFixed(2)}%.` : 'The contracted retainage rate is not on file.'}

${scopeBaseline ? `THE AGREED SCHEDULE OF VALUES (${scopeBaseline.source === 'contract' ? 'from the executed contract' : "from this project's first application, which established the schedule"}):
${JSON.stringify(scopeBaseline.items, null, 2)}
Classify every line billed on the CURRENT application against it in "scopeComparison", matching by meaning rather than exact wording. Every current line must appear exactly once.` : ''}

${priorApplication ? `THE PRIOR APPLICATION ON THIS PROJECT (application #${priorApplication.applicationNumber}):
Line 6 (Total Earned Less Retainage) was ${priorApplication.line6}.
Check this application's Line 7 (Less Previous Certificates) against that figure directly,
as the standard requires, not merely for internal consistency.`
  : 'No prior application is on file, so Line 7 can only be checked for internal consistency.'}

FIGURES THIS APP COMPUTED IN CODE FROM THE EXTRACTED DATA:
${JSON.stringify(codeFigures, null, 2)}
Recompute the arithmetic yourself from the documents. Where your figure differs from the one
above, that disagreement is itself a finding — report it under "recomputationDisagreements"
with both numbers, rather than silently preferring either. Do not simply restate the figures
above as your own work.

Record the audit with the record_pay_app_audit tool.

Rules:
- Ground every finding in something visible in the documents. Cite the figure, the invoice, or
  the contract clause. If you cannot point to it, leave it out.
- Dollar amounts are plain numbers — no currency symbols, no thousands separators.
- Empty arrays are a good answer. A false finding costs the PM real time and undermines every
  true one in the same report.
- For the tax section, follow the standard's ordering: enumerate every invoice carrying a
  nonzero tax line into "taxInvoices" FIRST, including recurring vendors and rentals, and only
  then judge them. "taxTotalCharged" must reconcile with the entries you listed.
- Never state that a signature or notary block is absent unless you have looked at the page and
  it genuinely is. If the page was not legible, omit the field and say so in "detail".
- Write every "detail" in plain English for a reader who is not a construction accountant.`;
}

async function callClaude(content, { scopeBaseline, truncatedMessage, maxTokens = 12000 }) {
  const { data } = await askForJson({
    content,
    tool: auditTool(!!scopeBaseline),
    // The standard is identical on every review, so it is cached rather than re-billed and
    // re-counted against the per-minute allowance each time.
    system: [{
      type: 'text',
      text: 'You are a construction pay application auditor.',
      cache_control: { type: 'ephemeral' },
    }],
    maxTokens,
    label: 'pay app audit',
    truncatedMessage,
  });
  return data;
}

const normalizeVerdicts = raw => Object.fromEntries(VERDICT_QUESTIONS.map(q => {
  const found = raw?.[q.key] || {};
  return [q.key, {
    label: q.label,
    pass: found.pass === true ? true : found.pass === false ? false : null,
    detail: trimmed(found.detail),
  }];
}));

function normalize(parsed) {
  const taxInvoices = asArray(parsed.taxInvoices)
    .filter(t => t && (t.vendor || t.invoiceRef))
    .map(t => ({
      vendor: trimmed(t.vendor), invoiceRef: trimmed(t.invoiceRef),
      taxAmount: num(t.taxAmount) ?? 0,
      exemptionApplied: t.exemptionApplied === true,
      detail: trimmed(t.detail),
    }));

  // Recomputed from the listed invoices rather than trusted from the model's own total: the
  // standard is explicit that the figure must reconcile with every entry, and a total that
  // quietly covers only the largest few is the exact failure it warns about.
  const chargedTotal = taxInvoices
    .filter(t => !t.exemptionApplied)
    .reduce((sum, t) => sum + (t.taxAmount || 0), 0);

  return {
    verdicts: normalizeVerdicts(parsed.verdicts),
    recomputedLines: parsed.recomputedLines && typeof parsed.recomputedLines === 'object'
      ? Object.fromEntries(Object.entries(parsed.recomputedLines).map(([k, v]) => [k, num(v)]))
      : null,
    recomputationDisagreements: asArray(parsed.recomputationDisagreements).filter(d => d && d.field),
    notarization: parsed.notarization && typeof parsed.notarization === 'object' ? parsed.notarization : null,
    subcontractors: asArray(parsed.subcontractors).filter(s => s && s.name),
    taxInvoices,
    taxTotalCharged: Math.round(chargedTotal * 100) / 100,
    taxTotalReported: num(parsed.taxTotalCharged),
    taxVerdict: trimmed(parsed.taxVerdict),
    untracedBilling: asArray(parsed.untracedBilling).filter(u => u && u.item),
    backupMismatches: asArray(parsed.backupMismatches).filter(b => b && b.item),
    contractFindings: asArray(parsed.contractFindings).filter(c => c && c.term),
    scopeComparison: Array.isArray(parsed.scopeComparison)
      ? parsed.scopeComparison.filter(r => r && r.description) : null,
    worthNoting: asArray(parsed.worthNoting).filter(w => typeof w === 'string' && w.trim()),
    notCheckable: asArray(parsed.notCheckable).filter(n => typeof n === 'string' && n.trim()),
    summary: trimmed(parsed.summary),
    hasContract: undefined, // set by the caller
  };
}

// Audits a pay application against the CMAR standard. Returns the judgment half of the
// review: the six verdicts, the notary check, per-subcontractor findings, the tax sweep, and
// the model's own recomputation of the G702 lines together with anywhere it disagrees with
// the figures this app computed in code.
async function auditPayApp({
  payAppBuffer, backupBuffers = [], contractTerms = null, priorApplication = null,
  codeFigures = {}, retainageRate = null, scopeBaseline = null,
}) {
  const payAppParts = await splitPdf(payAppBuffer);
  const backupParts = (await Promise.all(backupBuffers.map(buf => splitPdf(buf)))).flat();
  const oversized = payAppParts.length > 1 || backupParts.length > backupBuffers.length;

  const fileGuide = backupBuffers.length
    ? `You have been given the pay application followed by ${backupBuffers.length} backup document(s) — subcontractor applications, invoices, job-cost reports and lien waivers.`
    : 'You have been given the pay application only. No separate backup was uploaded, so say what could not be verified for want of it.';

  const prompt = buildPrompt({ contractTerms, priorApplication, codeFigures, retainageRate, fileGuide, scopeBaseline });

  // A packet too large for one call is read in passes, the pay app travelling with each so
  // that backup can always be judged against the application it supports.
  if (oversized) {
    const passes = [
      ...payAppParts.map(part => ({ docs: [part.buffer], part })),
      ...backupParts.map(part => ({ docs: [payAppParts[0].buffer, part.buffer], part })),
    ];
    const results = [];
    for (const [index, pass] of passes.entries()) {
      const content = pass.docs.map(buf => ({
        type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
      }));
      content.push({
        type: 'text',
        text: prompt + partNotice({
          isPart: true, partNumber: index + 1, partCount: passes.length,
          startPage: pass.part.startPage, endPage: pass.part.endPage,
        }),
      });
      try {
        // A pass that runs out of room is skipped rather than sinking the packet — the other
        // passes still carry findings, which is the same tolerance the review already had.
        results.push(normalize(await callClaude(content, { scopeBaseline })));
      } catch (err) {
        console.error(`[pay app audit] pass ${index + 1}/${passes.length} failed:`, err.message);
      }
    }
    if (results.length === 0) throw new Error('The pay application could not be audited.');
    return mergeAudits(results, { hasContract: !!contractTerms, passes: passes.length, read: results.length });
  }

  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: payAppBuffer.toString('base64') } },
    ...backupBuffers.map(buf => ({
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    })),
    { type: 'text', text: prompt },
  ];

  const audit = normalize(await callClaude(content, {
    scopeBaseline,
    truncatedMessage: 'The audit was cut off — there was more documentation than could be read in one pass.',
  }));
  audit.hasContract = !!contractTerms;
  audit.coverage = { passes: 1, read: 1 };
  return audit;
}

// Combines passes over one oversized packet. A finding seen in two passes appears once; a
// verdict is only a pass if no pass found it failing, since one section proving a defect is
// not cancelled by another section not seeing it.
function mergeAudits(results, { hasContract, passes, read }) {
  const key = item => JSON.stringify(item).toLowerCase();
  const gather = field => {
    const seen = new Set();
    const out = [];
    for (const r of results) {
      for (const item of r[field] || []) {
        const k = key(item);
        if (!seen.has(k)) { seen.add(k); out.push(item); }
      }
    }
    return out;
  };

  const verdicts = Object.fromEntries(VERDICT_QUESTIONS.map(q => {
    const seen = results.map(r => r.verdicts[q.key]).filter(v => v && v.pass !== null);
    const failing = seen.find(v => v.pass === false);
    return [q.key, {
      label: q.label,
      pass: failing ? false : seen.length ? true : null,
      detail: (failing || seen[0])?.detail || null,
    }];
  }));

  const taxInvoices = gather('taxInvoices');
  return {
    verdicts,
    recomputedLines: results.find(r => r.recomputedLines)?.recomputedLines || null,
    recomputationDisagreements: gather('recomputationDisagreements'),
    notarization: results.find(r => r.notarization?.detail)?.notarization || null,
    subcontractors: gather('subcontractors'),
    taxInvoices,
    taxTotalCharged: Math.round(taxInvoices.filter(t => !t.exemptionApplied)
      .reduce((s, t) => s + (t.taxAmount || 0), 0) * 100) / 100,
    taxVerdict: results.map(r => r.taxVerdict).filter(Boolean).join(' ') || null,
    untracedBilling: gather('untracedBilling'),
    backupMismatches: gather('backupMismatches'),
    contractFindings: gather('contractFindings'),
    scopeComparison: results.some(r => r.scopeComparison) ? gather('scopeComparison') : null,
    worthNoting: gather('worthNoting'),
    notCheckable: gather('notCheckable'),
    summary: results.map(r => r.summary).filter(Boolean).join(' ') || null,
    hasContract,
    coverage: { passes, read },
  };
}

module.exports = { auditPayApp, VERDICT_QUESTIONS, STANDARD_PATH };
