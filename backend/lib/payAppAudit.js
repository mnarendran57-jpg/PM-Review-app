const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { splitPdf, partNotice } = require('./pdfChunk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`The audit could not be read back as valid data. (${err.message})`);
  }
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

function buildPrompt({ contractTerms, priorApplication, codeFigures, retainageRate, fileGuide, scopeBaseline }) {
  // Carried over from the review this standard replaces: classifying every billed line
  // against the agreed schedule of values is what surfaces work nobody agreed to pay for.
  // The standard does not describe it, but dropping it would be a silent regression.
  const scopeBlock = scopeBaseline ? `[
    {
      "itemNo": "<the current application's item number>",
      "description": "<the line description>",
      "scheduledValue": <number or null>,
      "status": "<\\"in_contract\\" | \\"changed\\" | \\"covered_by_co\\" | \\"not_in_contract\\">",
      "matchedTo": "<which schedule-of-values line it corresponds to, or null>",
      "coNumber": "<the change order covering it, only when covered_by_co, else null>",
      "note": "<one plain sentence when the status is not in_contract, else null>"
    }
  ]` : 'null';

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

Return ONLY valid JSON in this exact shape:

{
  "verdicts": {
${VERDICT_QUESTIONS.map(q => `    "${q.key}": { "pass": <true|false|null if it cannot be determined>, "detail": "<one or two sentences of evidence — the figures compared, or what was missing>" }`).join(',\n')}
  },
  "recomputedLines": {
    "line1_originalContractSum": <number or null>,
    "line2_netChangeByChangeOrders": <number or null>,
    "line3_contractSumToDate": <number or null>,
    "line4_totalCompletedAndStored": <number or null>,
    "line5_retainage": <number or null>,
    "line6_totalEarnedLessRetainage": <number or null>,
    "line7_lessPreviousCertificates": <number or null>,
    "line8_currentPaymentDue": <number or null>,
    "line9_balanceToFinish": <number or null>
  },
  "recomputationDisagreements": [
    { "field": "<which figure>", "stated": <what the form says>, "recomputed": <what you calculated>, "difference": <number>, "detail": "<what is wrong and which input drives it>" }
  ],
  "notarization": {
    "signaturePresent": <true|false|null>,
    "notaryStampPresent": <true|false|null>,
    "notaryDate": "<YYYY-MM-DD or null>",
    "certificationDate": "<YYYY-MM-DD or null>",
    "commissionExpires": "<YYYY-MM-DD or null>",
    "valid": <true|false|null>,
    "detail": "<what you actually saw on the signature page. If you could not see it, say so — never infer that a block is blank.>"
  },
  "subcontractors": [
    {
      "name": "<firm name as printed>",
      "billedThisPeriod": <number or null>,
      "matchedSovLines": "<which GC schedule-of-values line(s) this ties to, or null>",
      "sovAmount": <number or null>,
      "tiesToSov": <true|false|null>,
      "retainagePct": <decimal or null>,
      "retainageExceedsGc": <true|false|null>,
      "certificationDate": "<YYYY-MM-DD or null>",
      "periodTo": "<YYYY-MM-DD or null>",
      "certifiedBeforePeriodEnd": <true if the certification predates the period being certified, which is a defect>,
      "changeOrderThisPeriod": <number or null>,
      "changeOrderMappedToContingency": <true|false|null>,
      "lienWaiverIncluded": <true|false|null>,
      "issues": ["<each specific problem with this subcontractor's application>"]
    }
  ],
  "taxInvoices": [
    { "vendor": "<vendor>", "invoiceRef": "<invoice number or description>", "taxAmount": <number>, "exemptionApplied": <true|false>, "detail": "<what the invoice shows>" }
  ],
  "taxTotalCharged": <the total tax on invoices where the exemption was NOT applied, or 0>,
  "taxVerdict": "<plain English. Where the contract makes the owner exempt and puts the burden of claiming it on the contractor, state directly that this amount is not payable and should be deducted before certifying. Only hedge where the contract is genuinely ambiguous. Null if no tax clause applies.>",
  "untracedBilling": [
    { "item": "<what was billed>", "amount": <number or null>, "detail": "<why nothing in the backup supports it>" }
  ],
  "backupMismatches": [
    { "item": "<what was billed>", "detail": "<the backup exists but does not tie — say by how much>" }
  ],
  "contractFindings": [
    { "term": "<the contract requirement>", "detail": "<how this application measures against it>", "compliant": <true|false|null> }
  ],
  "scopeComparison": ${scopeBlock},
  "worthNoting": ["<smaller items that are not full findings but should not be lost: rounding, date inconsistencies, unusual-but-not-wrong entries>"],
  "notCheckable": ["<any check from the standard that could not be performed, and what document would be needed>"],
  "summary": "<2-3 sentences: what is being requested, whether it is arithmetically sound, and the headline reasons it should not be certified as-is, if any>"
}

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
  it genuinely is. If the page was not legible, set the field to null and say so.
- Write every "detail" in plain English for a reader who is not a construction accountant.`;
}

async function callClaude(content, maxTokens = 12000) {
  const send = () => client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    // The standard is identical on every review, so it is cached rather than re-billed and
    // re-counted against the per-minute allowance each time.
    system: [{ type: 'text', text: 'You are a construction pay application auditor.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });

  let response;
  try {
    response = await send();
  } catch (err) {
    if (err.status !== 429 && err.status !== 529 && err.status !== 503) throw err;
    await new Promise(resolve => setTimeout(resolve, 20000));
    response = await send();
  }
  if (response.usage) {
    console.log(`[pay app audit] in=${response.usage.input_tokens} out=${response.usage.output_tokens} cached=${response.usage.cache_read_input_tokens ?? 0}`);
  }
  return response;
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
        const response = await callClaude(content);
        if (response.stop_reason !== 'max_tokens') results.push(normalize(safeJsonFromText(response.content[0].text)));
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

  const response = await callClaude(content);
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The audit was cut off — there was more documentation than could be read in one pass.');
  }
  const audit = normalize(safeJsonFromText(response.content[0].text));
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
