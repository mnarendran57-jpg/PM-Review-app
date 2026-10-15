const { money } = require('./money');
const { citeLabel, clauseFor, sectionLike } = require('./contractClauses');

// Whose agreement the invoice was checked against, as the report names it. Null for a review from
// before the PM said, or one checked against an agreement without saying whose.
const AGREEMENT_NAMES = { architect: "the architect's contract or PO", contractor: "the contractor's contract or PO" };
const AGREEMENT_TITLES = { architect: "Architect's contract / PO", contractor: "Contractor's contract / PO" };

// The invoice review as somebody deciding whether to pay it reads it: one line saying whether it can
// be paid, a count of each kind of problem, and each problem with its numbers.
//
// The order is the order of consequence. A possible duplicate is an invoice that may already have
// been paid; wrong arithmetic is money nobody owes; a cost with no receipt is money nobody can show
// was spent; a contract or PO problem is money the agreement says is not owed, or not owed yet.
// Coaster's notes come last, because they are prompts for a question rather than reasons to hold
// payment.
//
// The contract and PO section only appears when an agreement was chosen. One that was not checked is
// left out rather than shown empty, which would read as "checked and clean".

const FINDING_TITLES = {
  M1: 'The total does not add up',
  M2: 'Line totals that do not match quantity × price',
  M3: 'The lines do not add up to the printed subtotal',
  T1: 'Tax charged where the contract does not allow it',
  C1: 'Costs the contract does not allow',
  PO1: 'Billed against a different PO',
  PO2: 'Billing goes past what the agreement is worth',
  R1: 'Reimbursable costs with no receipt',
  D1: 'This invoice may already have been reviewed',
};

// What each check is called in the one line listing what passed — a name, not a question.
const CHECK_NAMES = {
  M1: 'the total', M2: 'line totals', M3: 'the subtotal', T1: 'tax',
  C1: 'costs the contract forbids', PO1: 'the PO number', PO2: 'billing against the agreement value',
  R1: 'receipts for reimbursable costs', D1: 'earlier reviews for a duplicate',
};

// A review stored before checks had groups is placed by its check's id.
function groupOf(r) {
  if (r.group) return r.group;
  if (/^M/.test(r.id)) return 'math';
  if (r.id === 'R1') return 'backup';
  if (r.id === 'D1') return 'history';
  return 'contract';
}

const finding = r => ({
  id: r.id,
  title: FINDING_TITLES[r.id] || r.description,
  critical: !!r.critical,
  detail: r.detail,
  figures: r.figures || null,
});

// One row per Coaster finding, one per failed check however many lines it names.
const countOf = issues => issues.reduce((n, f) => n + (f.byCoaster ? (f.figures?.rows?.length || 1) : 1), 0);

function buildInvoiceReport({ data, results, observations, contractChosen = false, contractLabel = null, agreement = null }) {
  const inv = data.invoice || {};
  const o = observations || {};
  const inGroup = group => results.filter(r => groupOf(r) === group);

  const mathResults = inGroup('math');
  const backupResult = inGroup('backup')[0] || null;
  const historyResult = inGroup('history')[0] || null;
  const contractResults = contractChosen ? inGroup('contract') : [];

  const math = { issues: mathResults.filter(r => r.status === 'FAIL').map(finding) };
  const backup = backupResult?.status === 'FAIL' ? finding(backupResult) : null;
  const duplicate = historyResult?.status === 'FAIL' ? finding(historyResult) : null;

  // Costs the contract forbids that Coaster found by reading. Sales tax is dropped: the tax check
  // already covers it with the contract's own words, and the reading repeats it anyway.
  const coasterConcerns = (Array.isArray(o.contractConcerns) ? o.contractConcerns : [])
    .filter(c => c && c.item && c.rule)
    .filter(c => !/\b(tax|taxes)\b/i.test(c.item));
  const contractIssues = contractResults.filter(r => r.status === 'FAIL').map(finding);
  // A cost the checks already caught from the agreement's clauses is not flagged a second time as
  // Coaster's reading — the same clause, cited twice, would count as two problems.
  const caught = new Set(contractIssues.flatMap(f => (f.figures?.rows || []).map(r => r.clause?.quote)).filter(Boolean));
  const withClause = coasterConcerns.map(c => ({ ...c, clause: c.clause || clauseFor(c, data.contractTerms) }));
  const coasterOwn = withClause.filter(c => !(c.clause && caught.has(c.clause.quote)));
  if (contractChosen && coasterOwn.length) {
    contractIssues.push({
      id: 'COASTER',
      title: 'Also flagged by Coaster against the contract',
      critical: false,
      byCoaster: true,
      detail: null,
      figures: {
        kind: 'deviation',
        rows: coasterOwn.map(c => ({
          item: c.item, amount: typeof c.amount === 'number' ? c.amount : null, rule: c.rule,
          basis: c.clause ? null : sectionLike(c.section), clause: c.clause || null,
        })),
      },
    });
  }
  const contract = contractChosen ? {
    label: contractLabel,
    title: AGREEMENT_TITLES[agreement] || 'Contract and PO',
    issues: contractIssues,
    count: countOf(contractIssues),
    // Where the agreement stands after this invoice, shown whether or not it is over, because "how
    // much is left on this PO" is the question asked next.
    billing: (() => {
      const r = contractResults.find(x => x.id === 'PO2');
      return r?.status === 'PASS' ? r.detail : null;
    })(),
  } : null;

  const notes = [
    o.pricingSanity && { title: 'Pricing worth double-checking', body: o.pricingSanity },
    o.reimbursableBackup && { title: 'Backup', body: o.reimbursableBackup },
    // A review stored before the contract was read line by line kept its contract note as prose.
    o.unallowable && !o.contractConcerns && { title: 'Possible contract conflicts', body: o.unallowable },
  ].filter(Boolean);

  const all = [...math.issues, ...(backup ? [backup] : []), ...(duplicate ? [duplicate] : []), ...(contract?.issues || [])];
  const toResolve = all.filter(f => f.critical).length;
  const otherIssues = countOf(all.filter(f => !f.critical));

  const verdict = toResolve > 0
    ? { tone: 'red', headline: `${toResolve} issue${toResolve === 1 ? '' : 's'} to resolve before paying` }
    : otherIssues > 0
      ? { tone: 'amber', headline: `${otherIssues} thing${otherIssues === 1 ? '' : 's'} to check before paying` }
      : { tone: 'green', headline: 'No issues found' };
  verdict.sub = toResolve > 0 && otherIssues > 0
    ? `and ${otherIssues} more thing${otherIssues === 1 ? '' : 's'} to check` : null;

  const header = {
    vendor: inv.vendor || 'Unknown vendor',
    invoiceNumber: inv.invoiceNumber || null,
    invoiceDate: inv.invoiceDate || null,
    poNumber: inv.poNumber || null,
    total: inv.total,
    checkedAgainst: [
      'its own arithmetic', 'its receipts', 'earlier reviews',
      contract && `${AGREEMENT_NAMES[agreement] || 'the agreement'}${contractLabel ? ` (${contractLabel})` : ''}`,
    ].filter(Boolean),
  };

  const tiles = [
    { key: 'math', label: 'Math errors', count: math.issues.length },
    { key: 'backup', label: 'Missing receipts', count: backup ? (backup.figures?.rows?.length || 1) : 0 },
    { key: 'contract', label: 'Contract / PO issues', count: contract ? contract.count : null },
    { key: 'duplicate', label: 'Possible duplicates', count: duplicate ? (duplicate.figures?.rows?.length || 1) : (historyResult ? 0 : null) },
  ];

  const nameOf = r => CHECK_NAMES[r.id] || r.description;
  const ran = [...mathResults, ...(backupResult ? [backupResult] : []), ...(historyResult ? [historyResult] : []), ...contractResults];
  const passed = ran.filter(r => r.status === 'PASS').map(nameOf);
  // Only a check that could not run is reported as such; most skips mean it did not apply.
  const notChecked = ran
    .filter(r => r.status === 'SKIPPED' && /could not|couldn't|no invoice total/i.test(r.detail || ''))
    .map(r => ({ description: nameOf(r), detail: r.detail }));

  const report = { header, verdict, tiles, math, backup, duplicate, contract, notes, passed, notChecked };
  report.markdown = renderMarkdown(report);
  return report;
}

// Where in the agreement a row's finding comes from, as a line under it.
const citeLine = r => (r.clause ? [`    - Contract${citeLabel(r.clause) ? `, ${citeLabel(r.clause)}` : ''}: "${r.clause.quote}"`] : []);

function figureLines(f) {
  const rows = f.figures?.rows || [];
  const kind = f.figures?.kind;
  if (kind === 'compare') {
    return rows.map(r => `  - ${r.item}${r.working ? ` (${r.working})` : ''}: shows ${money(r.shown)}, should be ${money(r.computed)} — off by ${money(r.difference)}`);
  }
  if (kind === 'deviation') {
    return rows.flatMap(r => [`  - ${r.item}${typeof r.amount === 'number' ? ` — ${money(r.amount)}` : ''}: ${r.rule}${r.basis ? ` (${r.basis})` : ''}`, ...citeLine(r)]);
  }
  if (kind === 'billing' || kind === 'list') {
    return rows.flatMap(r => [`  - ${r.item}${typeof r.amount === 'number' ? ` — ${money(r.amount)}` : ''}${r.note ? ` (${r.note})` : ''}`, ...citeLine(r)]);
  }
  return [`  ${f.detail}`];
}

function renderMarkdown(report) {
  const { header: h, verdict, math, backup, duplicate, contract, notes, passed, notChecked } = report;
  const lines = [];
  lines.push(`# Invoice Review — ${h.vendor}${h.invoiceNumber ? ` (Invoice ${h.invoiceNumber})` : ''}`);
  lines.push('');
  lines.push(`**${money(h.total)}**${h.invoiceDate ? ` · ${h.invoiceDate}` : ''}${h.poNumber ? ` · PO ${h.poNumber}` : ''}  `);
  lines.push(`Checked against ${h.checkedAgainst.join(', ')}.`);
  lines.push('');
  lines.push(`## ${verdict.headline}${verdict.sub ? `, ${verdict.sub}` : ''}`);
  lines.push('');
  const section = (title, findings) => {
    lines.push(`### ${title}`);
    lines.push('');
    if (findings.length === 0) lines.push('None.');
    for (const f of findings) {
      lines.push(`- **${f.title}**${f.critical ? ' — resolve before paying' : ''}${f.byCoaster ? " (Coaster's reading — verify)" : ''}`);
      lines.push(...figureLines(f));
    }
    lines.push('');
  };
  if (duplicate) section('Possible duplicate', [duplicate]);
  section('Math errors', math.issues);
  if (backup) section('Missing receipts', [backup]);
  if (contract) {
    section(`${contract.title || 'Contract and PO'}${contract.label ? ` — ${contract.label}` : ''}`, contract.issues);
    if (contract.billing) { lines.push(contract.billing); lines.push(''); }
  }
  if (notes.length) {
    lines.push("### Coaster's notes — verify before acting");
    lines.push('');
    for (const n of notes) lines.push(`- **${n.title}:** ${n.body}`);
    lines.push('');
  }
  if (passed.length) lines.push(`**Checked and fine:** ${passed.join(', ')}.  `);
  if (notChecked.length) lines.push(`**Could not be checked:** ${notChecked.map(n => n.description).join(', ')}.`);
  return lines.join('\n');
}

module.exports = { buildInvoiceReport, FINDING_TITLES };
