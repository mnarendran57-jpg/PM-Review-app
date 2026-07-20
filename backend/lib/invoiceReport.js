const { money } = require('./payAppChecks');

// Assembles the invoice review into the same shape the PCO/pay app reports use: a
// plain-English summary, the deterministic findings grouped by severity, and — kept
// deliberately separate — the model's advisory observations, which are judgment.
function buildInvoiceReport({ data, results, observations }) {
  const inv = data.invoice;
  const critical = results.filter(r => r.critical && r.status === 'FAIL');
  const mathErrors = results.filter(r => !r.critical && r.status === 'FAIL');
  const warnings = results.filter(r => r.status === 'SKIPPED');
  const cleanBill = results.filter(r => r.status === 'PASS');

  const total = critical.length + mathErrors.length;
  let plainEnglish = `This invoice requests ${money(inv.total)}.`;
  plainEnglish += total === 0
    ? ' The math, tax, backup, and contract checks found no issues.'
    : ` ${total} issue${total === 1 ? '' : 's'} found${critical.length ? ` (${critical.length} need${critical.length === 1 ? 's' : ''} resolving before paying)` : ''}.`;

  const header = {
    vendor: inv.vendor || 'Not specified',
    invoiceNumber: inv.invoiceNumber || 'Not specified',
    invoiceDate: inv.invoiceDate || 'Not specified',
    poNumber: inv.poNumber || null,
    total: inv.total,
  };

  const markdown = renderMarkdown({ header, plainEnglish, critical, mathErrors, warnings, cleanBill, observations });
  return { header, plainEnglish, critical, mathErrors, warnings, cleanBill, observations, markdown };
}

function renderMarkdown({ header, plainEnglish, critical, mathErrors, warnings, cleanBill, observations }) {
  const lines = [];
  lines.push(`# Invoice Review — ${header.vendor}${header.invoiceNumber !== 'Not specified' ? ` (Invoice ${header.invoiceNumber})` : ''}`);
  lines.push('');
  lines.push('> The math, tax, backup, and contract checks below are computed from the figures on the documents. The review notes further down are the AI\'s reading of the documents — treat those as prompts to verify, not verdicts.');
  lines.push('');
  lines.push(`**Vendor:** ${header.vendor}  `);
  lines.push(`**Invoice #:** ${header.invoiceNumber}  `);
  lines.push(`**Date:** ${header.invoiceDate}  `);
  if (header.poNumber) lines.push(`**PO #:** ${header.poNumber}  `);
  lines.push(`**Amount requested:** ${money(header.total)}  `);
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

  section('Issues to Resolve Before Paying', critical, '_None._');
  section('Other Problems Found', mathErrors, '_None._');

  const notes = [];
  if (observations?.reimbursableBackup) {
    notes.push({ title: 'Reimbursable costs and their backup', body: observations.reimbursableBackup });
  }
  if (observations?.unallowable) {
    notes.push({ title: 'Possible contract conflicts', body: observations.unallowable });
  }
  if (observations?.pricingSanity) {
    notes.push({ title: 'Pricing worth double-checking', body: observations.pricingSanity });
  }
  lines.push('## Review Notes — the AI\'s read, verify before acting');
  lines.push('');
  if (notes.length === 0) {
    lines.push('_Nothing stood out beyond the checks above._');
  } else {
    for (const n of notes) {
      lines.push(`- **${n.title}**`);
      lines.push(`  ${n.body}`);
    }
  }
  lines.push('');

  section('Checks We Couldn\'t Fully Complete', warnings, '_None._');
  section('Everything Else Checked Out Fine', cleanBill, '_None passed._');

  return lines.join('\n');
}

module.exports = { buildInvoiceReport };
