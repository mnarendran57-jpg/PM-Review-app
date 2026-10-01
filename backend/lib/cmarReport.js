const { money } = require('./money');
const { workRows, reconcileSub, PASS, FAIL, NOTE, UNKNOWN } = require('./cmarChecks');

// The findings, arranged the way somebody deciding whether to release payment needs to read them.
//
// The section order is not a template chosen for tidiness — it is the order the questions get asked
// in. What is being asked for, then whether the numbers are sound, then what is wrong with them,
// then the smaller things, then the subcontractor detail, then tax, then what to actually do. A
// reader who stops after the first two sections has still got the answer.
//
// One structure feeds the screen, the markdown and the PDF, so the three cannot drift apart.

// The six questions section 3 has to answer out loud, each tied to the check that answers it.
// Written as a list rather than assembled from whatever findings happen to exist, because the point
// is that each one is answered EVERY time — including with "could not be checked", which is an
// answer. A question that quietly vanished because its check did not run is the failure this
// guards against.
const HEADLINE_QUESTIONS = [
  {
    question: 'Does the total budget across all items match the contract total on the summary page?',
    matches: 'Schedule of values totals to the Contract Sum',
  },
  {
    question: 'Does the total work billed to date across all items match the summary page?',
    matches: 'Schedule of values totals to work completed',
  },
  {
    question: 'Does this application correctly show what was already paid before?',
    section: 'previous',
  },
  {
    question: 'Do the subcontractors each provide the full backup?',
    matches: 'Lien waivers are included where the contract requires them',
    fallbackSection: 'subs',
  },
  {
    question: 'Is the pay application number correct and consistent across the packet?',
    matches: 'The application number is consistent across the packet',
  },
  {
    question: 'Is the notarization correct?',
    section: 'notary',
  },
];

const UNANSWERED = {
  status: UNKNOWN,
  detail: 'This could not be checked from what the packet contained.',
};

function answerFor(q, findings) {
  const byTitle = q.matches && findings.find(f => f.title === q.matches);
  if (byTitle) return byTitle;
  const section = q.section || q.fallbackSection;
  const bySection = section && findings.filter(f => f.section === section);
  if (!bySection || !bySection.length) return UNANSWERED;
  // Worst status wins — a section with one failure is not a pass.
  const order = { [FAIL]: 0, [UNKNOWN]: 1, [NOTE]: 2, [PASS]: 3 };
  return [...bySection].sort((a, b) => order[a.status] - order[b.status])[0];
}

// The nine lines, as a table.
function numbersTable(cert) {
  const row = (n, label, key) => ({ line: n, label, amount: cert?.[key] ?? null });
  return [
    row(1, 'Original Contract Sum', 'line1OriginalContractSum'),
    row(2, 'Net Change by Change Orders', 'line2NetChangeByChangeOrders'),
    row(3, 'Contract Sum to Date', 'line3ContractSumToDate'),
    row(4, 'Total Completed and Stored to Date', 'line4CompletedAndStoredToDate'),
    row(5, 'Retainage', 'line5Retainage'),
    row(6, 'Total Earned Less Retainage', 'line6TotalEarnedLessRetainage'),
    row(7, 'Less Previous Certificates for Payment', 'line7LessPreviousCertificates'),
    row(8, 'CURRENT PAYMENT DUE', 'line8CurrentPaymentDue'),
    row(9, 'Balance to Finish Including Retainage', 'line9BalanceToFinish'),
  ];
}

// This application broken out by the categories the continuation sheet uses, so a reader can see
// where the money is going without reading two hundred rows. A flat sheet groups under one heading.
function byCategory(sovRows) {
  const groups = new Map();
  for (const row of workRows(sovRows)) {
    if (!row.thisPeriod) continue;
    const key = row.category || (row.isContingencyOrAllowance ? 'Contingency and allowances' : 'Work');
    const current = groups.get(key) || { category: key, thisPeriod: 0, items: 0 };
    current.thisPeriod += row.thisPeriod;
    current.items += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.thisPeriod - a.thisPeriod);
}

function buildReport({ header, packet, checks, judgement, terms }) {
  const cert = packet.certificate || {};
  const findings = checks.findings;

  const headline = HEADLINE_QUESTIONS.map(q => {
    const answer = answerFor(q, findings);
    return {
      question: q.question,
      status: answer.status,
      detail: answer.detail,
      amount: answer.amount ?? null,
    };
  });

  // Everything that failed, wherever it came from, so the reader does not have to assemble it.
  const issues = findings.filter(f => f.status === FAIL);
  const notes = findings.filter(f => f.status === NOTE);
  const unchecked = findings.filter(f => f.status === UNKNOWN);

  const report = {
    header,
    // 1
    summary: {
      text: judgement?.summary || '',
      paymentDue: cert.line8CurrentPaymentDue ?? null,
      certifiable: checks.certifiable,
      issueCount: issues.length,
      mathOnly: !terms,
    },
    // 2
    numbers: {
      lines: numbersTable(cert),
      categories: byCategory(packet.sovRows),
      thisPeriodTotal: byCategory(packet.sovRows).reduce((t, c) => t + c.thisPeriod, 0),
    },
    // 3
    headline,
    issues,
    // 4
    worthNoting: {
      findings: notes,
      unchecked,
      untraceable: judgement?.untraceable || [],
      observations: judgement?.worthNoting || [],
      unreadablePages: packet.unreadablePages || [],
    },
    // 5
    subcontractors: (judgement?.subcontractorMatching || []).map(raw => {
      const sub = (packet.subApplications || [])
        .find(s => s.firmName === raw.firmName) || {};
      // Whether a firm's billing ties is decided here, from the gross pair, never taken from the
      // model. See reconcileSub — comparing a certified (net) figure with the prime's gross column
      // invents a variance of exactly the retainage rate on every subcontractor at once.
      const match = reconcileSub(raw, {
        retainagePercent: terms?.retainagePercent ?? packet.retainagePercent ?? sub.retainagePercent ?? null,
        // The transcription itself, so both sides of the comparison are added up from rows rather
        // than taken as totals from the model.
        sub,
        primeRows: packet.sovRows,
      });
      return {
        ...match,
        scopeDescription: sub.scopeDescription || null,
        contractToDate: sub.certificate?.line3ContractSumToDate ?? null,
        completedToDate: sub.certificate?.line4CompletedAndStoredToDate ?? null,
        paymentDue: sub.certificate?.line8CurrentPaymentDue ?? null,
        newChangeOrders: sub.newChangeOrdersThisPeriod ?? null,
        lienWaiverIncluded: sub.lienWaiverIncluded ?? null,
        // Every arithmetic finding about this firm specifically.
        checks: findings.filter(f => f.subject === match.firmName),
      };
    }),
    // 6 — only where the contract actually has a tax clause and something was found.
    tax: checks.tax.total > 0 ? {
      total: checks.tax.total,
      clause: terms?.taxExemptionClause || null,
      charged: checks.tax.taxed,
      exempt: checks.tax.exempt,
      finding: findings.find(f => f.section === 'tax') || null,
    } : null,
    // 7
    actions: judgement?.actions || [],
    invoiceConcerns: judgement?.invoiceConcerns || [],
    counts: checks.counts,
  };

  return { ...report, markdown: toMarkdown(report) };
}

// --- Markdown --------------------------------------------------------------------------------

const MARK = { [PASS]: 'OK', [FAIL]: 'ISSUE', [NOTE]: 'Minor', [UNKNOWN]: 'Not checked' };

function toMarkdown(r) {
  const out = [];
  const h = r.header || {};

  out.push(`# Pay Application Audit`);
  out.push('');
  if (h.projectName) out.push(`**Project:** ${h.projectName}  `);
  if (h.contractorName) out.push(`**Contractor:** ${h.contractorName}  `);
  if (h.applicationNumber) out.push(`**Application No.:** ${h.applicationNumber}  `);
  if (h.periodTo) out.push(`**Period to:** ${h.periodTo}  `);
  out.push(`**Reviewed against:** ${r.summary.mathOnly ? 'the packet only — no contract was provided' : h.contractName || 'the contract on file'}`);
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push(r.summary.text || '_No summary was produced._');
  out.push('');

  out.push('## The Numbers');
  out.push('');
  out.push('| | | Amount |');
  out.push('|---:|---|---:|');
  for (const line of r.numbers.lines) {
    const bold = line.line === 8;
    const label = bold ? `**${line.label}**` : line.label;
    const amount = bold ? `**${money(line.amount)}**` : money(line.amount);
    out.push(`| ${line.line} | ${label} | ${amount} |`);
  }
  out.push('');

  if (r.numbers.categories.length) {
    out.push('### This application, by category');
    out.push('');
    out.push('| Category | Items | This period |');
    out.push('|---|---:|---:|');
    for (const c of r.numbers.categories) {
      out.push(`| ${c.category} | ${c.items} | ${money(c.thisPeriod)} |`);
    }
    out.push(`| **Total** | | **${money(r.numbers.thisPeriodTotal)}** |`);
    out.push('');
  }

  out.push('## Any Issues That Were Found');
  out.push('');
  for (const q of r.headline) {
    out.push(`**${MARK[q.status]} — ${q.question}**`);
    out.push('');
    out.push(q.detail);
    out.push('');
  }

  const otherIssues = r.issues.filter(f => !r.headline.some(q => q.detail === f.detail));
  if (otherIssues.length) {
    out.push('### Also found');
    out.push('');
    for (const f of otherIssues) {
      out.push(`- **${f.subject ? `${f.subject} — ` : ''}${f.title}.** ${f.detail}`);
    }
    out.push('');
  }

  const wn = r.worthNoting;
  if (wn.findings.length || wn.unchecked.length || wn.untraceable.length
    || wn.observations.length || wn.unreadablePages.length) {
    out.push('## Missed or Worth Noting');
    out.push('');
    for (const u of wn.untraceable) {
      out.push(`- **No backup found — ${u.item}${u.amount ? ` (${money(u.amount)})` : ''}.** ${u.note || ''}`);
    }
    for (const f of wn.findings) {
      out.push(`- **${f.subject ? `${f.subject} — ` : ''}${f.title}.** ${f.detail}`);
    }
    for (const o of wn.observations) out.push(`- ${o}`);
    for (const f of wn.unchecked) {
      out.push(`- **Not checked — ${f.title}.** ${f.detail}`);
    }
    if (wn.unreadablePages.length) {
      out.push(`- **Pages that could not be read confidently:** ${wn.unreadablePages.join(', ')}.`);
    }
    out.push('');
  }

  if (r.subcontractors.length) {
    out.push('## Subcontractor Billing vs Cost Breakdown');
    out.push('');
    for (const s of r.subcontractors) {
      out.push(`### ${s.firmName}${s.scopeDescription ? ` — ${s.scopeDescription}` : ''}`);
      out.push('');
      out.push('| | Amount |');
      out.push('|---|---:|');
      out.push(`| Contract to date | ${money(s.contractToDate)} |`);
      out.push(`| Completed to date | ${money(s.completedToDate)} |`);
      out.push(`| Billed this period (gross) | ${money(s.subGrossThisPeriod)} |`);
      out.push(`| Matched schedule-of-values items | ${money(s.sovThisPeriod)} |`);
      if (s.variance != null && s.variance !== 0) out.push(`| Variance | ${money(s.variance)} |`);
      out.push('');
      const verdict = s.ties === null ? 'Could not be compared'
        : (s.ties ? 'Ties' : 'Does not tie');
      out.push(`**${verdict}.** ${[s.basisNote, s.explanation].filter(Boolean).join(' ')}`);
      if ((s.sovItems || []).length) {
        out.push('');
        out.push(`Matched against: ${s.sovItems.map(i => `_${i}_`).join(', ')}.`);
      }
      if (s.newChangeOrders) {
        out.push('');
        out.push(`Change orders newly approved this period: ${money(s.newChangeOrders)}.`);
      }
      const failed = (s.checks || []).filter(c => c.status === FAIL);
      if (failed.length) {
        out.push('');
        for (const c of failed) out.push(`- **${c.title}.** ${c.detail}`);
      }
      out.push('');
    }
  }

  if (r.tax) {
    out.push('## Items Where Tax Was Charged Unwantedly');
    out.push('');
    if (r.tax.finding) {
      out.push(r.tax.finding.detail);
      out.push('');
    }
    out.push('| Vendor | Invoice | Date | Total | Tax charged |');
    out.push('|---|---|---|---:|---:|');
    for (const i of r.tax.charged) {
      out.push(`| ${i.vendor} | ${i.invoiceNumber || '—'} | ${i.invoiceDate || '—'} | ${money(i.total)} | **${money(i.taxAmount)}** |`);
    }
    out.push(`| | | | **Total tax** | **${money(r.tax.total)}** |`);
    out.push('');
    if (r.tax.exempt.length) {
      out.push('For contrast, the exemption *was* applied on these:');
      out.push('');
      out.push('| Vendor | Invoice | Total | Tax |');
      out.push('|---|---|---:|---:|');
      for (const i of r.tax.exempt) {
        out.push(`| ${i.vendor} | ${i.invoiceNumber || '—'} | ${money(i.total)} | ${money(i.taxAmount)} |`);
      }
      out.push('');
    }
  }

  if (r.invoiceConcerns.length) {
    out.push('## Invoices Worth a Second Look');
    out.push('');
    for (const c of r.invoiceConcerns) {
      out.push(`- **${c.vendor}${c.invoiceNumber ? ` #${c.invoiceNumber}` : ''}`
        + `${c.amount ? ` — ${money(c.amount)}` : ''}** (${c.confidence || 'possible'}). ${c.concern}`);
    }
    out.push('');
  }

  if (r.actions.length) {
    out.push('## Items to Verify Before Approving');
    out.push('');
    r.actions.forEach((a, i) => {
      out.push(`${i + 1}. ${a.blocking ? '**' : ''}${a.action}${a.blocking ? '**' : ''}`
        + `${a.amount ? ` — ${money(a.amount)}` : ''}`
        + `${a.why ? `  \n   _${a.why}_` : ''}`);
    });
    out.push('');
  }

  return out.join('\n');
}

module.exports = { buildReport, toMarkdown, HEADLINE_QUESTIONS, numbersTable, byCategory };
