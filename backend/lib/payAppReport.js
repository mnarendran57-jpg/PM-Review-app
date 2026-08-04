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

function renderMarkdown({ header, plainEnglish, critical, mathErrors, worthNoting, warnings, cleanBill, checklist, compliance, contractTerms, subReconciliation }) {
  const lines = [];
  lines.push(`# Pay Application Review — ${header.projectName}`);
  lines.push('');
  lines.push('> This tool validates that the numbers on this application are internally consistent and within contract limits. It does **not** verify that billed work was physically completed on site — that remains a manual step (see the checklist below).');
  lines.push('');
  lines.push(`**Application #:** ${header.applicationNumber}  `);
  lines.push(`**Period To:** ${header.periodTo}  `);
  lines.push(`**Current Payment Due (Line 8):** ${money(header.currentPaymentDue)}  `);
  lines.push(`**Total Completed & Stored to Date (Line 4):** ${money(header.totalCompletedToDate)}  `);
  lines.push(`**Balance to Finish (Line 9):** ${money(header.balanceToFinish)}  `);
  lines.push('');
  lines.push(`**Summary:** ${plainEnglish}`);
  lines.push('');

  const section = (title, items, emptyText) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (items.length === 0) {
      lines.push(emptyText);
    } else {
      for (const r of items) {
        lines.push(`- **${r.description}**`);
        lines.push(`  ${r.detail}`);
      }
    }
    lines.push('');
  };

  section('Issues to Resolve Before Approving', critical, '_None._');
  section('Other Calculation Problems Found', mathErrors, '_None._');
  section('Missed or Worth Noting', worthNoting, '_Nothing missing or unusual stood out._');

  // Chart 1: each subcontractor's own cost breakdown reconciled against the billing
  // summary line it supports. Shown whenever breakdowns exist — matches included,
  // because the reconciliation itself is the deliverable.
  if (subReconciliation && subReconciliation.length > 0) {
    lines.push('## Subcontractor Billing vs. Their Cost Breakdown');
    lines.push('');
    lines.push('| Subcontractor | Billed on summary | Their breakdown | Difference | Status |');
    lines.push('|---|---:|---:|---:|---|');
    for (const r of subReconciliation) {
      const status = r.status === 'match' ? 'Matches'
        : r.status === 'mismatch' ? '**MISMATCH**'
        : 'No matching billing line';
      lines.push(`| ${r.subName}${r.comparedTo ? ` (${r.comparedTo})` : ''} | ${r.g703Amount != null ? money(r.g703Amount) : '—'} | ${money(r.breakdownTotal)} | ${r.difference ? money(r.difference) : '—'} | ${status} |`);
    }
    lines.push('');
  }

  lines.push('## Site Verification Checklist — confirm on site before approving');
  lines.push('');
  if (checklist.length === 0) {
    lines.push('_No new period activity to verify — this period shows no new completed work, stored materials, or change orders._');
  } else {
    for (const item of checklist) {
      lines.push(`- [ ] **${item.description}** (${money(item.amount)})${item.isNew ? ' — NEW THIS PERIOD' : ''}`);
      lines.push(`  ${item.detail}`);
    }
  }
  lines.push('');

  // Compliance findings are the AI's reading of the documents against the contract —
  // kept in their own section, and worded as things to check rather than as proven
  // errors, because unlike the arithmetic above they can be wrong.
  if (compliance) {
    lines.push('## Contract Compliance — checked against the executed contract');
    lines.push('');
    lines.push('> These are read from the documents rather than calculated, so treat them as items to verify before approving, not as proven errors.');
    lines.push('');

    // Chart 2: every billed line classified against the agreed scope.
    if (compliance.scopeComparison?.length) {
      lines.push(`### Billed Scope vs. ${compliance.scopeSource === 'contract' ? 'the Contract' : 'the Original Schedule (App #1)'}`);
      lines.push('');
      lines.push('| Item | Scheduled value | Status | Notes |');
      lines.push('|---|---:|---|---|');
      for (const r of compliance.scopeComparison) {
        const status = r.status === 'in_contract' ? 'In contract'
          : r.status === 'changed' ? 'In contract — value changed'
          : r.status === 'covered_by_co' ? `Approved change${r.coNumber ? ` (${r.coNumber})` : ''}`
          : '**NOT IN CONTRACT**';
        const note = r.status === 'not_in_contract' ? (r.note || 'No scheduled line or change order covers this — challenge before approving.')
          : (r.matchedTo && r.status !== 'in_contract' ? r.matchedTo : '');
        lines.push(`| ${r.itemNo ? `#${r.itemNo} ` : ''}${r.description} | ${r.scheduledValue != null ? money(r.scheduledValue) : '—'} | ${status} | ${note} |`);
      }
      lines.push('');
    }

    if (compliance.taxFindings?.length) {
      lines.push(`### Tax found${contractTerms?.taxExempt === true ? ' on a tax-exempt project' : ''}`);
      lines.push('');
      for (const f of compliance.taxFindings) {
        lines.push(`- **${f.description}**${f.amount != null ? ` — ${money(f.amount)}` : ''}${f.where ? ` (${f.where})` : ''}`);
        lines.push(`  ${f.detail}`);
      }
      lines.push('');
    }

    if (compliance.unallowableFindings?.length) {
      lines.push('### Costs the contract does not allow');
      lines.push('');
      for (const f of compliance.unallowableFindings) {
        lines.push(`- **${f.contractItem}**${f.amount != null ? ` — ${money(f.amount)}` : ''}${f.where ? ` (${f.where})` : ''}`);
        lines.push(`  ${f.detail}`);
      }
      lines.push('');
    }

    if (!compliance.taxFindings?.length && !compliance.unallowableFindings?.length) {
      lines.push('_Nothing on this application conflicts with the contract terms on file._');
      lines.push('');
    }

    if (compliance.backupCoverage) {
      lines.push(`**Backup documentation:** ${compliance.backupCoverage}`);
      lines.push('');
    }
    if (compliance.notes) {
      lines.push(`**Note:** ${compliance.notes}`);
      lines.push('');
    }
  }

  section('Checks We Couldn\'t Fully Complete', warnings, '_None._');
  section('Everything Else Checked Out Fine', cleanBill, '_None passed._');

  return lines.join('\n');
}

module.exports = { buildReport };
