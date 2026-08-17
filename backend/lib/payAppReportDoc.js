// One shape, every output.
//
// The review is produced once by the engines and then has to appear in four places: the report
// on screen, the client PDF on letterhead, the Markdown export, and the marked-up copy of the
// contractor's own application. Before this module those came from different builders, and the
// marked-up PDF ended up showing findings from a check suite the rest of the app had already
// replaced — two review systems disagreeing in front of a client.
//
// So everything is derived here, from the engine result alone. If a finding is not in this
// object it appears nowhere, and if it is, it appears identically everywhere.
//
// The organising idea is the one the report is designed around: findings are grouped by what the
// reader would DO about them, not by which engine produced them or how severe a label says they
// are. Resolve, confirm, note. A PM triaging a pay application is deciding what to chase before
// certifying, and the grouping should answer that question directly.

const { SEVERITY } = require('./payAppInvariants');
const { money } = require('./money');
const { buildSiteVerificationChecklist } = require('./payAppChecklist');

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// A finding's first sentence is its headline and the rest is the explanation. The engines write
// detail as "claim. reasoning." precisely so this split works, and a long first sentence is cut
// at the turn — "…, but …" — rather than at a word count, so the headline stays a whole thought.
const HEADLINE_MAX = 108;

function split(detail) {
  const text = String(detail || '').trim();
  let end = text.search(/\.\s+(?=[A-Z$−])/);
  if (end === -1 || end > 220) end = text.length - 1;
  let head = text.slice(0, end + 1);
  let rest = text.slice(end + 1).trim();
  if (head.length > HEADLINE_MAX) {
    const turn = [', but ', ' — ', ', and ', ', which ', ', so '].reduce((best, sep) => {
      const at = head.indexOf(sep);
      return at > 24 && at < HEADLINE_MAX && (best === -1 || at < best) ? at : best;
    }, -1);
    if (turn !== -1) {
      const carried = head.slice(turn).replace(/^[,\s—]+/, '');
      head = `${head.slice(0, turn)}.`;
      rest = `${carried.charAt(0).toUpperCase()}${carried.slice(1)} ${rest}`.trim();
    }
  }
  return { head, rest };
}

// Rules identify a figure by the property name they check — "changeOrderAdditions", "line5aRate".
// Fine internally; in a document that goes to an owner it reads like a leaked variable. Split
// into words and let the sentence carry it.
const humanField = f => String(f || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .trim();

function place(f) {
  const w = f.where || {};
  return [w.itemNo ? `Item ${w.itemNo}` : null,
    w.description || humanField(w.field) || null,
    w.vendor || null, w.ref ? `ref ${w.ref}` : null, w.page ? `p.${w.page}` : null]
    .filter(Boolean).join(' · ');
}

function decorate(f) {
  const parts = split(f.detail);
  const amount = isNum(f.difference) ? f.difference : (isNum(f.actual) ? f.actual : null);
  return {
    ...f,
    ...parts,
    where: place(f),
    amount,
    // Suppressed when the headline already states it. A finding that opens "Scheduled value is
    // -$7,000.00" does not need "-$7,000.00" set again beside it.
    showAmount: amount != null && !parts.head.includes(money(Math.abs(amount)).replace('$', '')),
    // What the amount IS, in one word. The rule's own title is far too long for the slot beside a
    // dollar figure, and setting it there in three lines of uppercase is noise dressed as detail.
    amountLabel: isNum(f.difference) ? 'Difference'
      : isNum(f.expected) && isNum(f.actual) ? 'Billed' : 'Amount',
  };
}

const VERDICT_LABEL = {
  'do-not-certify': 'Do not certify',
  'certify-with-corrections': 'Certify with corrections',
  'no-issues-found': 'No issues found',
};

// The one sentence for a reader who reads nothing else.
function headlineFor(result, resolve, confirm, noted) {
  const st = result.stats;
  if (resolve.length) {
    return `${resolve.length === 1 ? 'One figure does not hold' : `${resolve.length} figures do not hold`}. `
      + 'Everything else on this application adds up.';
  }
  if (confirm.length) {
    return `The arithmetic is sound. ${confirm.length} item${confirm.length === 1 ? '' : 's'} `
      + `need${confirm.length === 1 ? 's' : ''} an answer from the contractor before this is certified.`;
  }
  // Notes do not hold up a certificate, but claiming "nothing was found to question" while
  // printing observations underneath would make the report contradict itself on the same page.
  if (noted.length) {
    return `${st.passed} of ${st.checksRun} checks passed and nothing needs an answer before `
      + `certifying. ${noted.length} observation${noted.length === 1 ? ' is' : 's are'} noted below.`;
  }
  return `${st.passed} of ${st.checksRun} checks passed and nothing was found to question.`;
}

function buildReportDoc({ result, data, projectName, contractor }) {
  const current = data?.current || {};
  const s = current.summary || {};
  const findings = (result?.findings || []).map(decorate);

  const resolve = findings.filter(f => f.severity === SEVERITY.CRITICAL);
  const confirm = findings.filter(f => f.severity === SEVERITY.MATERIAL);
  const noted = findings.filter(f => f.severity === SEVERITY.NOTE);

  const doc = {
    header: {
      projectName: projectName || s.projectName || 'Pay Application',
      contractor: contractor || s.contractor || null,
      applicationNumber: s.applicationNumber ?? null,
      periodTo: s.periodTo || null,
      appliedFor: s.line8 ?? null,
      thisPeriod: result?.thisPeriod ?? null,
      retainage: s.line5 ?? s.line5Total ?? null,
      pctComplete: isNum(s.line3) && s.line3 ? s.line4 / s.line3 : null,
    },
    verdict: result?.verdict || 'no-issues-found',
    verdictLabel: VERDICT_LABEL[result?.verdict] || VERDICT_LABEL['no-issues-found'],
    headline: headlineFor(result, resolve, confirm, noted),
    resolve,
    confirm,
    noted,
    findings,
    subMatch: result?.subMatch || null,
    vendorRollup: result?.vendorRollup || null,
    tax: result?.tax || null,
    contracts: result?.contracts || null,
    deliveryMethod: result?.deliveryMethod || null,
    // A single figure, and the only one in this document that is an instruction rather than an
    // observation: what to take off the cheque because the contract says the contractor owes it.
    taxToDeduct: result?.taxToDeduct ?? null,
    waivers: result?.waivers || null,
    coverage: result?.coverage || null,
    notChecked: result?.notChecked || [],
    stats: result?.stats || { checksRun: 0, passed: 0 },
    // Not a check — a list of what to look at on site this period. It survives the retirement of
    // the old suite because it answers a different question: not "is this right" but "what
    // should I go and see before I certify it".
    checklist: buildSiteVerificationChecklist(current, data?.previous),
  };
  doc.markdown = renderMarkdown(doc);
  return doc;
}

// --- Markdown -------------------------------------------------------------------------------

function renderMarkdown(doc) {
  const h = doc.header;
  const L = [];
  const push = (...lines) => L.push(...lines);

  push(`# Pay Application Review`, '');
  push(`**${h.projectName}**  `);
  push([h.contractor, h.applicationNumber != null ? `Application ${h.applicationNumber}` : null,
    h.periodTo ? `Period to ${h.periodTo}` : null,
    doc.deliveryMethod ? `${doc.deliveryMethod} delivery` : null].filter(Boolean).join(' · '), '');

  push(`| | |`, `|---|---|`);
  push(`| Applied for | ${money(h.appliedFor)} |`);
  push(`| This period | ${money(h.thisPeriod)} |`);
  push(`| Retainage | ${money(h.retainage)} |`);
  if (h.pctComplete != null) push(`| Complete | ${(h.pctComplete * 100).toFixed(2)}% |`);
  push('');

  push(`## ${doc.verdictLabel}`, '', doc.headline, '');

  const section = (title, items) => {
    if (!items.length) return;
    push(`## ${title} — ${items.length} item${items.length === 1 ? '' : 's'}`, '');
    for (const f of items) {
      push(`- **${f.head}**${f.showAmount ? `  *(${money(f.amount)})*` : ''}`);
      if (f.rest) push(`  ${f.rest}`);
      if (f.where) push(`  _${f.where}_`);
      push('');
    }
  };
  // Same order as the on-screen report and the PDF. Three renderings of one document that disagree
  // about what comes first are three documents.
  section('What to resolve', doc.resolve);
  section('To confirm', doc.confirm);

  if (doc.subMatch?.rows?.length) {
    push('## Subcontractor billing', '');
    push('| Subcontractor | They billed | Passed through | Billed to owner | Markup | Match |');
    push('|---|---|---|---|---|---|');
    for (const r of doc.subMatch.rows) {
      push(`| ${r.vendor} | ${money(r.theyBilled)} | ${money(r.passedThrough)} | `
        + `${r.toOwner == null ? '—' : money(r.toOwner)} | `
        + `${Math.abs(r.markup) < 0.005 ? 'none' : money(r.markup)} | ${r.status} |`);
    }
    push('');
  }

  // Which schedule lines carry each subcontractor's scope. A separate question from the table
  // above, and the only place a reader can see that one subcontract is billed across two lines.
  if (doc.vendorRollup?.length) {
    push('## Subcontractor scope on the schedule', '');
    push('| Subcontractor | Lines carrying their scope | They billed | Contractor billed | Difference | Columns agreeing |');
    push('|---|---|---|---|---|---|');
    for (const r of doc.vendorRollup) {
      const diff = r.difference == null ? '—'
        : `${money(r.difference)}${r.exceeds ? ' — billed above the sub' : r.short ? ' — sub billed more' : ''}`;
      push(`| ${r.vendor} | ${r.lines.length ? r.lines.join('; ') : '—'} | `
        + `${r.theyBilled == null ? '—' : money(r.theyBilled)} | `
        + `${r.onSchedule == null ? '—' : money(r.onSchedule)} | ${diff} | `
        + `${r.columnsCompared ? `${r.columnsMatched} of ${r.columnsCompared} — ${r.status}` : r.status} |`);
    }
    push('');
  }

  // Who owes each tax, and why. The category is the whole finding — the same charge is a proper
  // job cost or the contractor's own depending on what was bought — so it is a column, not a note.
  if (doc.tax?.length) {
    push('## Sales tax — who owes it', '');
    push('| Vendor | What was bought | Tax | Under the contract |');
    push('|---|---|---|---|');
    for (const t of doc.tax) {
      push(`| ${t.vendor}${t.ref ? ` · ${t.ref}` : ''} | ${t.category}${t.inferred ? ` *(${t.why})*` : ''} `
        + `| ${money(t.amount)} | ${t.verdict} |`);
    }
    if (isNum(doc.taxToDeduct) && doc.taxToDeduct > 0) {
      push('', `**${money(doc.taxToDeduct)} of the tax billed is the contractor's own cost under `
        + 'this contract and should come off this payment.**');
    }
    push('');
  }

  // Which agreement each party was measured against. The claim worth printing is not that a
  // contract exists but that the right one was applied to the right biller.
  if (doc.contracts?.length) {
    push('## Contracts checked against', '');
    push('| Party | Scope | Value | Retainage | Matched to |');
    push('|---|---|---|---|---|');
    for (const c of doc.contracts) {
      push(`| ${c.party}${c.commitment ? ` · ${c.commitment}` : ''} | ${c.scope || '—'} `
        + `| ${c.value == null ? '—' : money(c.value)} `
        + `| ${c.retainageRate == null ? '—' : `${(c.retainageRate * 100).toFixed(2)}%`} `
        + `| ${c.matchedTo || '—'} *(${c.matchedHow})* |`);
    }
    push('');
  }

  section('Noted, no action expected', doc.noted);

  if (doc.waivers?.length) {
    push('## Lien waivers', '');
    push('| Party | Being paid | Release on file | Status |');
    push('|---|---|---|---|');
    for (const w of doc.waivers) {
      push(`| ${w.party} | ${money(w.amount)} | ${w.waivers.join(', ') || '—'} | ${w.status} |`);
    }
    push('');
  }

  if (doc.checklist?.length) {
    push('## To verify on site this period', '');
    for (const item of doc.checklist) push(`- ${item.description || item}`);
    push('');
  }

  push('## Checked and clean', '');
  push(`${doc.stats.passed} of ${doc.stats.checksRun} checks passed.`, '');
  if (doc.notChecked.length) {
    push('**Not checked.** ' + doc.notChecked.join(' '), '');
  }
  return L.join('\n');
}

// --- the marked-up copy of the contractor's application ---------------------------------------
//
// The annotator anchors each finding to the dollar figure it names, by matching the amounts in
// the text against the page. It only needs three fields, so rather than teach it about engine
// findings, the findings are presented in the shape it already understands.
function annotationsFor(doc) {
  return doc.findings.map(f => ({
    status: 'FAIL',
    critical: f.severity === SEVERITY.CRITICAL,
    description: f.head,
    detail: [f.rest, f.where ? `(${f.where})` : null].filter(Boolean).join(' ') || f.head,
  }));
}

module.exports = { buildReportDoc, annotationsFor, renderMarkdown };
