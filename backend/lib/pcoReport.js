const { money } = require('./money');
const { citeLabel, clauseFor, sectionLike } = require('./contractClauses');

// The change order review as somebody approving it reads it: one line saying whether it can be
// approved, a count of each kind of problem, and then each problem with its numbers. Nothing a reader
// has to wade through to find the finding.
//
// The order is the order of consequence. Wrong arithmetic is money nobody owes; a contract deviation
// is money the contract says nobody owes; work the RFI did not ask for is money for something nobody
// asked for. Coaster's notes and the cheaper alternatives come after, because they are prompts for a
// conversation rather than reasons to send the change order back.
//
// What was checked is decided by the PM — the math always, the contract and the RFI/ASI when they
// were chosen — and a section that was not checked is left out entirely rather than shown empty,
// which would read as "checked and clean".

// What each failed check is called in the report. The checks themselves are written as questions,
// which is right for a checklist and wrong for a finding: a reader wants "the total does not add up",
// not "do the items add up to the total?".
const FINDING_TITLES = {
  P1: 'The total does not add up',
  P2: 'Line totals that do not match quantity × price',
  P3: 'Markups that do not match their stated rate',
  T1: 'Tax charged where the contract does not allow it',
  A1: 'Overhead and profit taken on an allowance',
  A2: 'Subcontractor markup above the limit',
  A3: 'Second-tier markup above the limit',
  C1: 'Costs the contract does not allow',
};

// What each check is called in the one line listing what passed — a name, not a question.
const CHECK_NAMES = {
  P1: 'the total', P2: 'line totals', P3: 'markup amounts', T1: 'tax',
  A1: 'allowance markup', A2: 'subcontractor markup', A3: 'second-tier markup',
  C1: 'costs the contract forbids', L1: 'lump sums',
};

const finding = r => ({
  id: r.id,
  title: FINDING_TITLES[r.id] || r.description,
  critical: !!r.critical,
  detail: r.detail,
  figures: r.figures || null,
});

// Which checks a stored review ran, for one saved before the PM could choose: the contract was
// checked if one was named, the RFI/ASI if one was read.
function checkedAgainstFor({ checkedAgainst, contractChosen, reference }) {
  if (checkedAgainst) return { contract: !!checkedAgainst.contract, reference: !!checkedAgainst.reference };
  return { contract: !!contractChosen, reference: !!reference };
}

function buildPcoReport({
  data, results, observations, reference, alternatives = null,
  checkedAgainst = null, contractLabel = null, contractChosen = false,
}) {
  const p = data.pco || {};
  const o = observations || {};
  const against = checkedAgainstFor({ checkedAgainst, contractChosen, reference });
  const inGroup = (r, group) => (r.group ? r.group === group
    // A review stored before checks had groups: placed by id.
    : (group === 'math' ? /^P/.test(r.id) : group === 'backup' ? r.id === 'L1' : /^[TAC]/.test(r.id)));

  const mathResults = results.filter(r => inGroup(r, 'math'));
  const contractResults = against.contract ? results.filter(r => inGroup(r, 'contract')) : [];
  const backup = results.find(r => inGroup(r, 'backup'));

  const math = {
    issues: mathResults.filter(r => r.status === 'FAIL').map(finding),
    passed: mathResults.filter(r => r.status === 'PASS').length,
  };

  // Costs the contract forbids that Coaster found by reading, which a wording match in code misses
  // ("overtime without written direction"). Shown with the contract's other deviations, marked as
  // Coaster's reading, and never counted as one of the checks that must be resolved.
  //
  // Tax and markup lines are dropped: the checks above already cover them with the contract's own
  // figures, and the reading was told so — this is for when it says them anyway, which it does.
  const coasterConcerns = (Array.isArray(o.contractConcerns) ? o.contractConcerns : [])
    .filter(c => c && c.item && c.rule)
    .filter(c => !/\b(tax|markup|mark-up|overhead|profit|o\s*&\s*p)\b/i.test(c.item));
  const contractIssues = contractResults.filter(r => r.status === 'FAIL').map(finding);
  // A cost the checks already caught from the contract's clauses is not flagged a second time as
  // Coaster's reading — the same clause, cited twice, would count as two deviations.
  const caught = new Set(contractIssues.flatMap(f => (f.figures?.rows || []).map(r => r.clause?.quote)).filter(Boolean));
  const coasterOwn = coasterConcerns.filter(c => {
    const clause = c.clause || clauseFor(c, data.contractTerms);
    return !(clause && caught.has(clause.quote));
  });
  if (against.contract && coasterOwn.length) {
    contractIssues.push({
      id: 'COASTER',
      title: 'Also flagged by Coaster against the contract',
      critical: false,
      byCoaster: true,
      detail: null,
      figures: {
        kind: 'deviation',
        rows: coasterOwn.map(c => {
          const clause = c.clause || clauseFor(c, data.contractTerms);
          return {
            item: c.item, amount: typeof c.amount === 'number' ? c.amount : null,
            rule: c.rule, basis: clause ? null : sectionLike(c.section), clause,
          };
        }),
      },
    });
  }
  // Each of Coaster's rows is a deviation of its own; each failed check is one however many lines
  // it names. One number, used by the tile and the section alike.
  const contract = against.contract ? {
    label: contractLabel,
    issues: contractIssues,
    count: contractIssues.reduce((n, f) => n + (f.byCoaster ? (f.figures?.rows?.length || 1) : 1), 0),
    passed: contractResults.filter(r => r.status === 'PASS').length,
  } : null;

  // What the RFI/ASI asked for against what was priced. Only a reading that compared the two can
  // say either way; one that could not is reported as not compared, never as matching.
  const scope = against.reference ? {
    reference: reference ? {
      type: reference.type || null, number: reference.number || null,
      subject: reference.subject || null, summary: reference.scopeSummary || null,
      // "RFI-031", not "RFI RFI-031": the number usually carries its own type.
      label: [
        reference.number && reference.type && !String(reference.number).toUpperCase().startsWith(String(reference.type).toUpperCase())
          ? `${reference.type} ${reference.number}` : (reference.number || reference.type),
        reference.subject,
      ].filter(Boolean).join(' — ') || null,
    } : null,
    compared: typeof o.scopeAlignment?.aligned === 'boolean',
    aligned: o.scopeAlignment?.aligned === true,
    note: o.scopeAlignment?.notes || null,
    extraItems: Array.isArray(o.scopeAlignment?.extraItems) ? o.scopeAlignment.extraItems.filter(Boolean) : [],
  } : null;

  const askFor = backup?.status === 'FAIL' ? (backup.figures?.rows || []) : [];

  const notes = [
    o.pricingSanity && { title: 'Pricing worth double-checking', body: o.pricingSanity },
    // Already listed as amounts to ask a breakdown for, by the check itself; the note adds the why.
    o.lumpSumConcerns && { title: 'Lump sums', body: o.lumpSumConcerns },
  ].filter(Boolean);

  const toResolve = [...math.issues, ...(contract?.issues || [])].filter(f => f.critical).length;
  const otherIssues = [...math.issues, ...(contract?.issues || [])]
    .filter(f => !f.critical)
    .reduce((n, f) => n + (f.byCoaster ? (f.figures?.rows?.length || 1) : 1), 0)
    + (scope?.compared && !scope.aligned ? 1 : 0);

  const verdict = toResolve > 0
    ? { tone: 'red', headline: `${toResolve} issue${toResolve === 1 ? '' : 's'} to resolve before approving` }
    : otherIssues > 0
      ? { tone: 'amber', headline: `${otherIssues} thing${otherIssues === 1 ? '' : 's'} to check before approving` }
      : { tone: 'green', headline: 'No issues found' };
  verdict.sub = toResolve > 0 && otherIssues > 0
    ? `and ${otherIssues} more thing${otherIssues === 1 ? '' : 's'} to check`
    : null;

  const header = {
    pcoNumber: p.pcoNumber || 'Not specified',
    title: p.title || null,
    contractor: p.contractor || null,
    date: p.date || null,
    totalAmount: p.totalAmount,
    isAllowance: !!p.isAllowance,
    reference: reference ? { type: reference.type, number: reference.number, subject: reference.subject } : null,
    // What it was checked against, in words, so the reader knows what "no issues" covers.
    checkedAgainst: [
      'its own arithmetic',
      contract && (contractLabel ? `the contract (${contractLabel})` : 'the contract'),
      scope && 'the RFI/ASI that generated it',
    ].filter(Boolean),
  };

  const alternativeCount = alternatives?.optionCount || 0;
  const tiles = [
    { key: 'math', label: 'Math errors', count: math.issues.length },
    { key: 'contract', label: 'Contract deviations', count: contract ? contract.count : null },
    { key: 'scope', label: 'Outside the RFI/ASI', count: scope ? (scope.compared ? scope.extraItems.length || (scope.aligned ? 0 : 1) : null) : null },
    { key: 'savings', label: 'VE options', count: alternatives ? alternativeCount : null },
  ];

  // What passed and what could not be checked, by name, for the reader who wants to know what was
  // looked at — a line, not a list of questions.
  const nameOf = r => CHECK_NAMES[r.id] || r.description;
  const passed = [...mathResults, ...contractResults, ...(backup ? [backup] : [])]
    .filter(r => r.status === 'PASS').map(nameOf);
  // Only a check that could not run is reported as such. Most skips mean the check did not apply —
  // no tax on the change order, no second-tier markup, not an allowance — and listing those as
  // "could not be checked" would read as a gap where there is none.
  const notChecked = [...mathResults, ...contractResults]
    .filter(r => r.status === 'SKIPPED' && /could not|couldn't|no total amount/i.test(r.detail || ''))
    .map(r => ({ description: nameOf(r), detail: r.detail }));

  const report = {
    header, verdict, tiles, math, contract, scope, askFor, notes,
    alternatives, passed, notChecked,
  };
  report.markdown = renderMarkdown(report);
  return report;
}

function figureLines(f) {
  const rows = f.figures?.rows || [];
  if (f.figures?.kind === 'compare') {
    return rows.map(r => `  - ${r.item}${r.working ? ` (${r.working})` : ''}: shows ${money(r.shown)}, should be ${money(r.computed)} — off by ${money(r.difference)}`);
  }
  if (f.figures?.kind === 'deviation') {
    return rows.flatMap(r => [
      `  - ${r.item}${typeof r.amount === 'number' ? ` — ${money(r.amount)}` : ''}: ${r.rule}${r.basis ? ` (${r.basis})` : ''}`,
      ...(r.clause ? [`    - Contract${citeLabel(r.clause) ? `, ${citeLabel(r.clause)}` : ''}: "${r.clause.quote}"`] : []),
    ]);
  }
  return [`  ${f.detail}`];
}

function renderMarkdown(report) {
  const { header: h, verdict, math, contract, scope, askFor, notes, alternatives, passed, notChecked } = report;
  const lines = [];
  lines.push(`# Change Order Review — PCO ${h.pcoNumber}${h.title ? `: ${h.title}` : ''}`);
  lines.push('');
  lines.push(`**${money(h.totalAmount)} requested**${h.contractor ? ` by ${h.contractor}` : ''}${h.date ? ` · ${h.date}` : ''}${h.isAllowance ? ' · presented as an allowance' : ''}  `);
  lines.push(`Checked against ${h.checkedAgainst.join(', ')}.`);
  lines.push('');
  lines.push(`## ${verdict.headline}${verdict.sub ? `, ${verdict.sub}` : ''}`);
  lines.push('');

  const section = (title, findings) => {
    lines.push(`### ${title}`);
    lines.push('');
    for (const f of findings) {
      lines.push(`- **${f.title}**${f.critical ? ' — resolve before approving' : ''}`);
      lines.push(...figureLines(f));
    }
    if (findings.length === 0) lines.push('None.');
    lines.push('');
  };

  section('Math errors', math.issues);
  if (contract) section(`Contract deviations${contract.label ? ` — ${contract.label}` : ''}`, contract.issues);

  if (scope) {
    lines.push('### Against the RFI/ASI');
    lines.push('');
    if (!scope.compared) lines.push('Could not be compared — the documents were too long to read side by side.');
    else if (scope.aligned) lines.push('The change order prices the work the RFI/ASI asked for.');
    else {
      lines.push(scope.note || 'The change order prices work the RFI/ASI does not call for.');
      for (const item of scope.extraItems) lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (askFor.length) {
    lines.push('### Ask for a breakdown');
    lines.push('');
    for (const r of askFor) lines.push(`- ${r.item} — ${money(r.amount)}`);
    lines.push('');
  }

  if (alternatives?.lines?.length) {
    lines.push("### Value engineering options — Coaster's suggestions, not prices");
    lines.push('');
    for (const line of alternatives.lines) {
      lines.push(`- **${line.description}**${typeof line.amount === 'number' ? ` (${money(line.amount)})` : ''}`);
      if (line.options.length === 0) lines.push(`  No alternative suggested. ${line.noOptionsReason || ''}`.trimEnd());
      for (const option of line.options) {
        lines.push(`  - ${option.name} — ${option.costDifference}. ${option.whatItIs}${option.note ? ` ${option.note}` : ''}`);
      }
    }
    lines.push('');
  }

  if (notes.length) {
    lines.push('### Coaster\'s notes — verify before acting');
    lines.push('');
    for (const n of notes) lines.push(`- **${n.title}:** ${n.body}`);
    lines.push('');
  }

  if (passed.length) lines.push(`**Checked and fine:** ${passed.join(', ')}.  `);
  if (notChecked.length) lines.push(`**Could not be checked:** ${notChecked.map(n => n.description).join(', ')}.`);
  return lines.join('\n');
}

module.exports = { buildPcoReport, FINDING_TITLES };
