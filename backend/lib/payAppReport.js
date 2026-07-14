const { money } = require('./payAppChecks');
const { buildSiteVerificationChecklist } = require('./payAppChecklist');

function buildReport({ data, results }) {
  const s = data.current.summary;
  const critical = results.filter(r => r.critical && r.status === 'FAIL');
  const mathErrors = results.filter(r => !r.critical && r.status === 'FAIL');
  const warnings = results.filter(r => r.status === 'SKIPPED');
  const cleanBill = results.filter(r => r.status === 'PASS');
  const checklist = buildSiteVerificationChecklist(data.current, data.previous);

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

  const markdown = renderMarkdown({ header, plainEnglish, critical, mathErrors, warnings, cleanBill, checklist });

  return { header, plainEnglish, critical, mathErrors, warnings, cleanBill, checklist, markdown };
}

function renderMarkdown({ header, plainEnglish, critical, mathErrors, warnings, cleanBill, checklist }) {
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

  section('Checks We Couldn\'t Fully Complete', warnings, '_None._');
  section('Everything Else Checked Out Fine', cleanBill, '_None passed._');

  return lines.join('\n');
}

module.exports = { buildReport };
