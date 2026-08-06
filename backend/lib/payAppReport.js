const { money } = require('./payAppChecks');
const { buildSiteVerificationChecklist } = require('./payAppChecklist');

function buildReport({ data, results, compliance = null, contractTerms = null, subReconciliation = [] }) {
  const s = data.current.summary;
  // N-series checks are "missed and worth noting" observations, not calculation
  // errors — they get their own section rather than being mixed into the math.
  const isWorthNoting = r => String(r.id || '').startsWith('N');
  const critical = results.filter(r => r.critical && r.status === 'FAIL' && !isWorthNoting(r));
  const mathErrors = results.filter(r => !r.critical && r.status === 'FAIL' && !isWorthNoting(r));
  const worthNoting = results.filter(r => r.status === 'FAIL' && isWorthNoting(r));
  const warnings = results.filter(r => r.status === 'SKIPPED');
  const cleanBill = results.filter(r => r.status === 'PASS');
  const checklist = buildSiteVerificationChecklist(data.current, data.previous);
  const complianceCount =
    (compliance?.taxFindings?.length || 0) + (compliance?.unallowableFindings?.length || 0);
  const outOfContract = (compliance?.scopeComparison || []).filter(r => r.status === 'not_in_contract');

  const billedPct = s.line3 ? (s.line4 / s.line3) * 100 : null;
  const retainedPct = s.line4 ? (s.line5 / s.line4) * 100 : null;

  let plainEnglish;
  if (critical.length === 0 && mathErrors.length === 0) {
    plainEnglish = `This application requests ${money(s.line8)}. Math checks out — no issues found.`;
  } else {
    const total = critical.length + mathErrors.length;
    plainEnglish = `This application requests ${money(s.line8)}. ${total} issue${total === 1 ? '' : 's'} found` +
      (critical.length ? ` (${critical.length} critical).` : '.');
  }
  if (billedPct != null) {
    plainEnglish += ` Overall billing is at ${billedPct.toFixed(1)}% of contract sum` +
      (retainedPct != null ? `, ${retainedPct.toFixed(1)}% retained.` : '.');
  }
  if (checklist.length > 0) {
    plainEnglish += ` ${checklist.length} item${checklist.length === 1 ? '' : 's'} to verify on site this period.`;
  }
  if (worthNoting.length > 0) {
    plainEnglish += ` ${worthNoting.length} item${worthNoting.length === 1 ? '' : 's'} worth noting.`;
  }
  if (complianceCount > 0) {
    plainEnglish += ` ${complianceCount} possible contract conflict${complianceCount === 1 ? '' : 's'} flagged for review.`;
  }
  if (outOfContract.length > 0) {
    plainEnglish += ` ${outOfContract.length} billed line${outOfContract.length === 1 ? '' : 's'} appear${outOfContract.length === 1 ? 's' : ''} to be outside the contract scope.`;
  }

  const header = {
    projectName: s.projectName || 'Not specified',
    applicationNumber: s.applicationNumber ?? 'Not specified',
    periodTo: s.periodTo || 'Not specified',
    currentPaymentDue: s.line8,
    totalCompletedToDate: s.line4,
    balanceToFinish: s.line9,
    contractSumToDate: s.line3,
    billedPct, retainedPct,
  };

  const markdown = renderMarkdown({ header, plainEnglish, critical, mathErrors, worthNoting, warnings, cleanBill, checklist, compliance, contractTerms, subReconciliation });

  return { header, plainEnglish, critical, mathErrors, worthNoting, warnings, cleanBill, checklist, compliance, contractTerms, subReconciliation, markdown };
}

function section(lines, title, items, emptyText) {
  lines.push(`## ${title}`, '');
  if (!items || items.length === 0) lines.push(emptyText);
  else for (const r of items) lines.push(`- **${r.description}**`, `  ${r.detail}`);
  lines.push('');
}

// The report follows the order set out in backend/standards/cmar-pay-app-audit.md, because
// that order is what the findings need to answer rather than an arbitrary template: what is
// being asked for, the numbers, the explicit pass/fail questions, then the softer notes, the
// subcontractor reconciliation, the tax deduction, and finally one action checklist.
//
// Reviews stored before the audit existed carry no `compliance.audit`, so every section drawn
// from it is written to disappear rather than render empty.
function renderMarkdown({ header, plainEnglish, critical, mathErrors, worthNoting, warnings, cleanBill, checklist, compliance, contractTerms, subReconciliation }) {
  const lines = [];
  const audit = compliance?.audit && !compliance.audit.unavailable ? compliance.audit : null;
  const push = (...ls) => lines.push(...ls);

  push(`# Pay Application Review — ${header.projectName}`, '');
  push(`**Application #:** ${header.applicationNumber}  `);
  push(`**Period To:** ${header.periodTo}  `);
  push('');

  // --- 1. Summary ----------------------------------------------------------------------
  push('## Summary', '');
  push(audit?.summary || plainEnglish, '');
  if (audit && !audit.hasContract) {
    push('> **No contract is on file for this project.** Only the internal consistency of the figures has been verified — the tax, fee, change-order-cap and retainage-rate checks could not be performed.', '');
  }
  if (audit?.coverage && audit.coverage.read < audit.coverage.passes) {
    push(`> **This audit is partial.** ${audit.coverage.read} of ${audit.coverage.passes} sections of the packet could be read.`, '');
  }

  // --- 2. The Numbers ------------------------------------------------------------------
  push('## The Numbers', '');
  push('| | Amount |', '|---|---:|');
  push(`| Current payment requested (Line 8) | ${money(header.currentPaymentDue)} |`);
  push(`| Total completed & stored to date (Line 4) | ${money(header.totalCompletedToDate)} |`);
  push(`| Contract sum to date (Line 3) | ${money(header.contractSumToDate)} |`);
  push(`| Balance remaining to finish (Line 9) | ${money(header.balanceToFinish)} |`);
  if (header.billedPct != null) push(`| Percent of contract billed | ${header.billedPct.toFixed(1)}% |`);
  if (header.retainedPct != null) push(`| Percent retained | ${header.retainedPct.toFixed(1)}% |`);
  push('');

  // Where the audit's own recomputation disagrees with the figures computed in code, both are
  // shown. One of them is wrong, and that is not something to resolve silently.
  if (audit?.recomputationDisagreements?.length) {
    push('### Recomputation disagreements', '');
    push('> The audit recalculated these from the documents and did not reach the same number as the extraction. Resolve each before certifying.', '');
    push('| Figure | On the form | Recomputed | Difference |', '|---|---:|---:|---:|');
    for (const d of audit.recomputationDisagreements) {
      push(`| ${d.field} | ${money(d.stated)} | ${money(d.recomputed)} | **${money(d.difference)}** |`);
    }
    push('');
    for (const d of audit.recomputationDisagreements) if (d.detail) push(`- **${d.field}:** ${d.detail}`);
    push('');
  }

  // --- 3. Any Issues That Were Found ----------------------------------------------------
  push('## Any Issues That Were Found', '');
  if (audit?.verdicts) {
    push('| | Question | Finding |', '|---|---|---|');
    for (const v of Object.values(audit.verdicts)) {
      const mark = v.pass === true ? 'PASS' : v.pass === false ? '**FAIL**' : 'Not determined';
      push(`| ${mark} | ${v.label} | ${v.detail || '—'} |`);
    }
    push('');
  }
  const issues = [...critical, ...mathErrors];
  if (issues.length === 0) {
    push('_Every figure checked was internally consistent and within contract limits._', '');
  } else {
    for (const r of issues) push(`- **${r.description}**`, `  ${r.detail}`);
    push('');
  }

  if (audit?.notarization) {
    const n = audit.notarization;
    const state = n.valid === true ? 'Valid' : n.valid === false ? 'NOT VALID' : 'Could not be determined';
    push('### Notarization', '', `**${state}.** ${n.detail || ''}`.trim(), '');
    const facts = [
      ['Signature present', n.signaturePresent], ['Notary stamp present', n.notaryStampPresent],
      ['Notary date', n.notaryDate], ['Certification date', n.certificationDate],
      ['Commission expires', n.commissionExpires],
    ].filter(([, v]) => v !== null && v !== undefined);
    if (facts.length) {
      push('| | |', '|---|---|');
      for (const [k, v] of facts) push(`| ${k} | ${v === true ? 'Yes' : v === false ? 'No' : v} |`);
      push('');
    }
  }

  if (audit?.contractFindings?.length) {
    push('### Against the contract', '');
    for (const c of audit.contractFindings) {
      const bold = c.compliant === false;
      push(`- ${bold ? '**' : ''}${c.term}${bold ? '**' : ''}: ${c.detail}`);
    }
    push('');
  }

  // Every billed line classified against the agreed scope.
  if (compliance?.scopeComparison?.length) {
    push(`### Billed Scope vs. ${compliance.scopeSource === 'contract' ? 'the Contract' : 'the Original Schedule (App #1)'}`, '');
    push('| Item | Scheduled value | Status | Notes |', '|---|---:|---|---|');
    for (const r of compliance.scopeComparison) {
      const status = r.status === 'in_contract' ? 'In contract'
        : r.status === 'changed' ? 'In contract — value changed'
        : r.status === 'covered_by_co' ? `Approved change${r.coNumber ? ` (${r.coNumber})` : ''}`
        : '**NOT IN CONTRACT**';
      const note = r.status === 'not_in_contract'
        ? (r.note || 'No scheduled line or change order covers this — challenge before approving.')
        : (r.matchedTo && r.status !== 'in_contract' ? r.matchedTo : '');
      push(`| ${r.itemNo ? `#${r.itemNo} ` : ''}${r.description} | ${r.scheduledValue != null ? money(r.scheduledValue) : '—'} | ${status} | ${note} |`);
    }
    push('');
  }

  // --- 4. Missed or Worth Noting --------------------------------------------------------
  push('## Missed or Worth Noting', '');
  const noted = [];
  for (const r of worthNoting) noted.push(`**${r.description}** — ${r.detail}`);
  for (const u of audit?.untracedBilling || []) {
    noted.push(`**Billed with no traceable backup: ${u.item}${u.amount != null ? ` (${money(u.amount)})` : ''}** — ${u.detail}`);
  }
  for (const b of audit?.backupMismatches || []) noted.push(`**Backup does not tie: ${b.item}** — ${b.detail}`);
  for (const w of audit?.worthNoting || []) noted.push(w);
  if (noted.length === 0) push('_Nothing missing or unusual stood out._', '');
  else { for (const n of noted) push(`- ${n}`); push(''); }

  // --- 5. Subcontractor Billing vs. Cost Breakdown --------------------------------------
  push('## Subcontractor Billing vs. Cost Breakdown', '');
  if (subReconciliation?.length) {
    push('| Subcontractor | Billed on summary | Their breakdown | Difference | Status |', '|---|---:|---:|---:|---|');
    for (const r of subReconciliation) {
      const status = r.status === 'match' ? 'Matches'
        : r.status === 'mismatch' ? '**MISMATCH**' : 'No matching billing line';
      push(`| ${r.subName}${r.comparedTo ? ` (${r.comparedTo})` : ''} | ${r.g703Amount != null ? money(r.g703Amount) : '—'} | ${money(r.breakdownTotal)} | ${r.difference ? money(r.difference) : '—'} | ${status} |`);
    }
    push('');
  }
  for (const s of audit?.subcontractors || []) {
    push(`### ${s.name}`, '');
    const facts = [
      ['Billed this period', s.billedThisPeriod != null ? money(s.billedThisPeriod) : null],
      ['Ties to GC schedule of values', s.tiesToSov === true ? `Yes — ${s.matchedSovLines || 'matched'}`
        : s.tiesToSov === false ? `**No** — ${s.matchedSovLines || 'no matching line found'}` : null],
      ['Retainage held', s.retainagePct != null
        ? `${(s.retainagePct * 100).toFixed(1)}%${s.retainageExceedsGc ? ' — **higher than the owner holds from the GC**' : ''}` : null],
      ['Certification date', s.certificationDate
        ? `${s.certificationDate}${s.certifiedBeforePeriodEnd ? ` — **predates the period ending ${s.periodTo}**` : ''}` : null],
      ['Change order this period', s.changeOrderThisPeriod != null
        ? `${money(s.changeOrderThisPeriod)}${s.changeOrderMappedToContingency === false ? ' — **not shown in the GC contingency/allowance section**' : ''}` : null],
      ['Lien waiver', s.lienWaiverIncluded === true ? 'Included'
        : s.lienWaiverIncluded === false ? '**Not included**' : null],
    ].filter(([, v]) => v);
    if (facts.length) {
      push('| | |', '|---|---|');
      for (const [k, v] of facts) push(`| ${k} | ${v} |`);
      push('');
    }
    for (const issue of s.issues || []) push(`- ${issue}`);
    if (s.issues?.length) push('');
  }
  if (!subReconciliation?.length && !audit?.subcontractors?.length) {
    push('_No subcontractor applications were found in this packet._', '');
  }

  // --- 6. Items Where Tax Was Charged Unwantedly ----------------------------------------
  // Reviews stored before the audit hold their tax findings in the older, flatter shape.
  // Rendering them here keeps reopening an old review from quietly losing its findings.
  if (!audit && compliance?.taxFindings?.length) {
    push('## Items Where Tax Was Charged Unwantedly', '');
    for (const f of compliance.taxFindings) {
      push(`- **${f.description}**${f.amount != null ? ` — ${money(f.amount)}` : ''}${f.where ? ` (${f.where})` : ''}`);
      if (f.detail) push(`  ${f.detail}`);
    }
    push('');
  }
  if (!audit && compliance?.unallowableFindings?.length) {
    push('## Costs the Contract Does Not Allow', '');
    for (const f of compliance.unallowableFindings) {
      push(`- **${f.contractItem}**${f.amount != null ? ` — ${money(f.amount)}` : ''}${f.where ? ` (${f.where})` : ''}`);
      if (f.detail) push(`  ${f.detail}`);
    }
    push('');
  }
  if (audit?.taxInvoices?.length) {
    const charged = audit.taxInvoices.filter(t => !t.exemptionApplied);
    const exempt = audit.taxInvoices.filter(t => t.exemptionApplied);
    push('## Items Where Tax Was Charged Unwantedly', '');
    if (charged.length === 0) {
      push('_Every invoice carrying a tax line had the exemption correctly applied._', '');
    } else {
      push('| Vendor | Invoice | Tax charged |', '|---|---|---:|');
      for (const t of charged) push(`| ${t.vendor || '—'} | ${t.invoiceRef || '—'} | ${money(t.taxAmount)} |`);
      push(`| | **Total** | **${money(audit.taxTotalCharged)}** |`, '');
      if (exempt.length) {
        push('For contrast, the exemption *was* applied on these — which shows the certificate is usable:', '');
        for (const t of exempt) push(`- ${t.vendor || '—'}${t.invoiceRef ? ` (${t.invoiceRef})` : ''} — $0.00 tax`);
        push('');
      }
      if (audit.taxVerdict) push(`**${audit.taxVerdict}**`, '');
    }
  }

  // --- 7. Items to Verify Before Approving ----------------------------------------------
  push('## Items to Verify Before Approving, or Needing Correction', '');
  const actions = [];
  for (const r of critical) actions.push(`${r.description} — ${r.detail}`);
  for (const d of audit?.recomputationDisagreements || []) {
    actions.push(`Resolve the ${d.field} disagreement: the form shows ${money(d.stated)}, recomputation gives ${money(d.recomputed)}.`);
  }
  if (audit?.notarization?.valid === false) {
    // The detail is a sentence the model wrote and usually ends in a full stop already.
    const why = (audit.notarization.detail || 'the notary block is not valid').replace(/\.\s*$/, '');
    actions.push(`Return the application for proper notarization — ${why}.`);
  }
  for (const s of audit?.subcontractors || []) {
    for (const issue of s.issues || []) actions.push(`${s.name}: ${issue}`);
  }
  if (audit?.taxTotalCharged > 0) {
    actions.push(`Deduct ${money(audit.taxTotalCharged)} of sales tax from this application before certifying.`);
  }
  for (const u of audit?.untracedBilling || []) {
    actions.push(`Obtain backup for ${u.item}, or remove it from this application.`);
  }
  for (const item of checklist) actions.push(`Confirm on site: ${item.description} (${money(item.amount)}).`);
  for (const n of audit?.notCheckable || []) actions.push(n);

  if (actions.length === 0) push('_Nothing outstanding. This application is ready to certify._', '');
  else { actions.forEach((a, i) => push(`${i + 1}. ${a}`)); push(''); }

  // Kept below the checklist: useful as an audit trail, not part of the decision.
  section(lines, 'Checks We Couldn\'t Fully Complete', warnings, '_None._');
  section(lines, 'Everything Else Checked Out Fine', cleanBill, '_None passed._');

  return lines.join('\n');
}

module.exports = { buildReport };
