// The pay application review, as a PM reads it.
//
// The design brief was "the naked eye should catch the actual inference" — so the whole page is
// arranged around how long a reader gives it. Four facts and one sentence for someone with ten
// seconds. Findings split by what you would DO about them, not by severity label, each one bold
// line and one sentence. The subcontractor table below that, arranged so overbilling and hidden
// markup are visible by reading across a row rather than by doing arithmetic.
//
// The section that looks decorative is not. "Checked and clean" carries the count of what passed,
// and it is what earns the findings their weight — four findings could mean four problems or four
// hundred unexamined lines, and only the passing count tells you which.
//
// Typography is the ledger the figures came from: a serif for headings, mono with tabular figures
// for every number, hairline rules instead of cards. It prints to one or two pages because these
// get forwarded to contractors.

const { SEVERITY } = require('./payAppInvariants');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const money = n => (isNum(n)
  ? `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : '—');
const pct = n => (isNum(n) ? `${(n * 100).toFixed(2)}%` : '—');

const TAG = { [SEVERITY.CRITICAL]: ['c', 'Critical'], [SEVERITY.MATERIAL]: ['r', 'Review'], [SEVERITY.NOTE]: ['n', 'Note'] };

// A finding's headline is the first sentence of its detail; the rest is the explanation. The
// engines already write detail as "claim. reasoning." for exactly this reason, so the split is a
// property of how they are worded rather than a guess made here.

function findingRow(f) {
  const [cls, label] = TAG[f.severity] || TAG[SEVERITY.NOTE];
  const { head, rest, where } = f;
  return `
      <div class="find">
        <span class="tag ${cls}">${label}</span>
        <div>
          <h3>${esc(head)}</h3>
          ${rest ? `<p>${esc(rest)}</p>` : ''}
          ${where ? `<span class="where">${esc(where)}</span>` : ''}
        </div>
        <div class="amt">${f.showAmount ? `${money(f.amount)}<small>${esc(f.amountLabel)}</small>` : ''}</div>
      </div>`;
}

function findingSection(title, list, limit = 6) {
  if (!list.length) return '';
  const shown = list.slice(0, limit);
  const hidden = list.length - shown.length;
  return `
    <section class="sec">
      <h2>${esc(title)} — ${list.length} item${list.length === 1 ? '' : 's'}</h2>
      ${shown.map(findingRow).join('')}
      ${hidden ? `<p class="more">and ${hidden} more of the same kind — see the full findings export.</p>` : ''}
    </section>`;
}

function subMatchSection(match) {
  if (!match || !match.rows.length) return '';
  const cell = (v, extra = '') => `<td>${money(v)}${extra}</td>`;
  const rows = match.rows.map(r => `
          <tr>
            <td><span class="who">${esc(r.vendor)}</span>${r.note ? `<span class="meta">${esc(r.note)}</span>` : ''}</td>
            ${cell(r.theyBilled)}
            ${cell(r.passedThrough)}
            ${cell(r.toOwner)}
            <td>${r.retainageSub == null ? '—' : money(r.retainageSub)}${
  r.retainageOwner == null ? '' : `<span class="meta">owner ${money(r.retainageOwner)}</span>`}</td>
            <td>${Math.abs(r.markup) < 0.005 ? 'none' : `<span class="flag">${money(r.markup)}</span>`}</td>
            <td class="${r.status === 'exact' ? 'yes' : 'no'}">${esc(r.status)}</td>
          </tr>`).join('');

  const feeNote = isNum(match.fee)
    ? `No subcontractor billing is marked up. The contractor's fee is billed separately as
       <b>${pct(match.feeRate)} on all costs — ${money(match.fee)}</b>${
  isNum(match.feeBase) ? `, taken on a base of ${money(match.feeBase)}` : ''}, on its own schedule line.`
    : 'The table shows what each subcontractor billed, what the contractor passed through, and what reached the owner. Anything added in between appears in the markup column.';

  return `
    <section class="sec">
      <h2>Subcontractor billing — does it match?</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Subcontractor</th><th>They billed</th><th>Passed through</th><th>Billed to owner</th>
                <th>Retainage held</th><th>Markup</th><th>Match</th></tr>
          </thead>
          <tbody>${rows}
            <tr class="total">
              <td>${match.rows.length} subcontract charge${match.rows.length === 1 ? '' : 's'}</td>
              ${cell(match.totals.theyBilled)}
              ${cell(match.totals.passedThrough)}
              <td>—</td><td>—</td>
              <td>${Math.abs(match.totals.markup) < 0.005 ? money(0) : `<span class="flag">${money(match.totals.markup)}</span>`}</td>
              <td class="${Math.abs(match.totals.markup) < 0.005 ? 'yes' : 'no'}">${
  Math.abs(match.totals.markup) < 0.005 ? 'ties' : 'differs'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="quiet">${feeNote}</p>
    </section>`;
}

// Which schedule lines carry each subcontractor's scope, and whether those lines add up to what
// the subcontractor billed. The table above asks whether anything was added on the way through;
// this asks whether the pieces have been found at all. A subcontract split across a base line and
// an allowance draw ties only when both are counted, and that is a thing no other section shows.
function vendorRollupSection(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map(r => `
          <tr>
            <td><span class="who">${esc(r.vendor)}</span>${r.note ? `<span class="meta">${esc(r.note)}</span>` : ''}</td>
            <td>${r.lines.length ? r.lines.map(esc).join('<br>') : '—'}</td>
            <td>${r.theyBilled == null ? '—' : money(r.theyBilled)}</td>
            <td>${r.onSchedule == null ? '—' : money(r.onSchedule)}</td>
            <td class="${r.status === 'ties exactly' ? 'yes' : 'no'}">${
  r.columnsCompared ? `${r.columnsMatched} of ${r.columnsCompared}<span class="meta">${esc(r.status)}</span>`
    : esc(r.status)}</td>
          </tr>`).join('');

  return `
    <section class="sec">
      <h2>Subcontractor scope on the schedule</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Subcontractor</th><th>Lines carrying their scope</th><th>They billed</th>
                <th>On the schedule</th><th>Columns agreeing</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="quiet">Each subcontractor's own totals are added up against every schedule line
        billing their work — contract sum, previously billed, this period, to date and retainage at
        once. Columns agreeing on every count means the lines listed are that subcontract and
        nothing is billed twice or left out. Anything less is named in the findings above.</p>
    </section>`;
}

// Sales tax, and who owes each charge under this contract.
//
// The category column is the finding, not decoration. The same $412.50 is a proper reimbursable
// job cost on a rented lift and the contractor's own money on a desk, and a reader who cannot see
// which one they are looking at has no way to check the answer. Where the category was read from
// the wording rather than stated by the document, the wording is shown too, so a PM can overrule
// it in one glance.
function taxSection(rows, deduct) {
  if (!rows || !rows.length) return '';
  const body = rows.map(r => `
          <tr>
            <td><span class="who">${esc(r.vendor)}</span>${r.ref ? `<span class="meta">${esc(r.ref)}</span>` : ''}</td>
            <td>${esc(r.category)}${r.inferred ? `<span class="meta">${esc(r.why)}</span>` : ''}</td>
            <td>${money(r.amount)}</td>
            <td class="${r.verdict === 'owner pays' ? 'yes' : 'no'}">${esc(r.verdict)}${
  r.basis ? `<span class="meta">${esc(r.basis)}</span>` : ''}</td>
          </tr>`).join('');

  return `
    <section class="sec">
      <h2>Sales tax — who owes it</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Vendor</th><th>What was bought</th><th>Tax</th><th>Under the contract</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${isNum(deduct) && deduct > 0
    ? `<p class="quiet"><b>${money(deduct)} of the tax billed is the contractor's own cost under
         this contract and should come off this payment.</b></p>`
    : `<p class="quiet">Tax on equipment rented for the job is normally a reimbursable cost; tax
         on things bought and consumed or kept is normally the contractor's. Which applies here
         comes from this contract's own wording, quoted above where it decided a charge.</p>`}
    </section>`;
}

// Which agreement each party was measured against.
//
// The point of the table is the last column. A subcontractor's retainage checked against the
// CONTRACTOR's rate is a confident finding about nothing, so a reader has to be able to see that
// each party was measured against their own agreement, and by what — a commitment number is
// certainty, a name match is a judgement they may want to overrule.
function contractsSection(rows, method) {
  if (!rows || !rows.length) return '';
  const body = rows.map(r => `
          <tr>
            <td><span class="who">${esc(r.party)}</span>${r.commitment ? `<span class="meta">${esc(r.commitment)}</span>` : ''}</td>
            <td>${esc(r.scope || '—')}${r.role ? `<span class="meta">${esc(r.role)}</span>` : ''}</td>
            <td>${r.value == null ? '—' : money(r.value)}</td>
            <td>${r.retainageRate == null ? '—' : pct(r.retainageRate)}</td>
            <td class="${r.matchedTo ? 'yes' : 'no'}">${r.matchedTo ? esc(r.matchedTo) : 'not matched'}
              <span class="meta">${esc(r.matchedHow)}</span></td>
          </tr>`).join('');

  return `
    <section class="sec">
      <h2>Contracts checked against</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Party</th><th>Scope</th><th>Value</th><th>Retainage</th><th>Matched to</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="quiet">${method === 'CSP'
    ? `Reviewed as a CSP application: the contractor bills the owner directly, so no subcontractor
       applications were expected and none were looked for.`
    : method === 'CMAR'
      ? `Reviewed as a CMAR application: every subcontractor billing through the contractor is
         expected to have their own contract on file, and each is measured against theirs rather
         than against the contractor's terms.`
      : `Each party's billing is measured against the contract signed with that party. A contract
         that could not be tied to anyone billing here was not applied to anybody.`}</p>
    </section>`;
}

// Who could put a lien on this job, what they are owed, and what is on file for them. Findings
// name what is wrong; this is how a reader satisfies themselves that nobody is missing — the one
// question about waivers that a list of findings genuinely cannot answer.
function waiverSection(rows) {
  if (!rows || !rows.length) return '';
  const CLS = {
    'none on file': 'no', 'conditional only': 'flag',
    'on record, not enclosed': '', complete: 'yes', 'unconditional only': 'yes',
  };
  // A release that does two jobs is recorded as one type joined with "+". Set on one line it is
  // wide enough to push the status column off the table, and status is the column a reader is
  // actually scanning — so each job gets its own line.
  const kinds = r => (r.waivers.length
    ? r.waivers.flatMap(w => String(w).split('+')).map(w => esc(w.trim())).join('<br>')
    : '—');
  const body = rows.map(r => `
          <tr>
            <td><span class="who">${esc(r.party)}</span><span class="meta">${esc(r.role)}</span></td>
            <td>${money(r.amount)}</td>
            <td class="wrap">${kinds(r)}</td>
            <td>${esc(r.through || '—')}</td>
            <td class="${CLS[r.status] ?? ''}">${esc(r.status)}</td>
          </tr>`).join('');
  return `
    <section class="sec">
      <h2>Lien waivers — is it safe to pay?</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Party</th><th>Being paid</th><th>Release on file</th><th>Through</th><th>Status</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="quiet">A release from the contractor binds the contractor only. A subcontractor's
        lien rights are their own and survive the owner paying up the chain, so every party billing
        this period needs its own. <b>Conditional</b> releases the lien when payment arrives;
        <b>unconditional</b> confirms it already did.</p>
    </section>`;
}

// Takes the report document built by payAppReportDoc — the same object the client PDF and the
// Markdown export render. This page used to derive its own headlines, groupings and placements
// from the raw engine result, which meant two renderers quietly interpreting the same findings
// their own way. Now it only lays out what it is given.
function buildReportHtml({ report }) {
  const doc = report;
  const h = doc.header;
  const st = doc.stats;

  const VERDICT_CLASS = {
    'do-not-certify': 'crit', 'certify-with-corrections': 'warn', 'no-issues-found': 'ok',
  };
  const vcls = VERDICT_CLASS[doc.verdict] || 'ok';

  const facts = [
    ['Applied for', money(h.appliedFor), true],
    ['This period', money(h.thisPeriod)],
    ['Retainage', money(h.retainage)],
    ['Complete', h.pctComplete == null ? '—' : pct(h.pctComplete)],
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay Application Review${h.applicationNumber != null ? ` — Application ${esc(h.applicationNumber)}` : ''}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --paper:#fbfbfc;--panel:#fff;--ink:#14171c;--ink-2:#535b67;--ink-3:#7b8492;
    --rule:#dde1e8;--rule-strong:#b7bfcb;--accent:#1f3c73;
    --critical:#a8322a;--review:#8a5a0c;--note:#5b6472;--ok:#2c6a52;
    --crit-wash:#faf0ef;--warn-wash:#faf5ea;--ok-wash:#eff5f2;
    --display:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
    --mono:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --paper:#101317;--panel:#171b21;--ink:#e9ebef;--ink-2:#a2abb8;--ink-3:#79828f;
    --rule:#272d36;--rule-strong:#3d4653;--accent:#8dabe8;
    --critical:#e08578;--review:#d5a45c;--note:#98a1ae;--ok:#74c3a0;
    --crit-wash:#241a19;--warn-wash:#241f16;--ok-wash:#17211d;}}
  body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
  .sheet{max-width:900px;margin:0 auto;padding:40px 26px 64px;display:flex;flex-direction:column;gap:36px}
  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
  .masthead{border-top:3px solid var(--accent);padding-top:16px}
  .masthead h1{font-family:var(--display);font-weight:600;font-size:26px;line-height:1.2;text-wrap:balance;margin-bottom:5px}
  .sub{color:var(--ink-2);font-size:14px}
  .facts{margin-top:20px;display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule);grid-template-columns:repeat(4,1fr)}
  .fact{background:var(--panel);padding:11px 13px;display:flex;flex-direction:column;gap:4px}
  .fact .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:15px}
  .fact .v.big{font-size:17px}
  .verdict{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;padding:14px 16px;border:1px solid var(--rule)}
  .verdict.crit{background:var(--crit-wash);border-left:3px solid var(--critical)}
  .verdict.warn{background:var(--warn-wash);border-left:3px solid var(--review)}
  .verdict.ok{background:var(--ok-wash);border-left:3px solid var(--ok)}
  .verdict .call{font-family:var(--mono);font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
  .verdict.crit .call{color:var(--critical)} .verdict.warn .call{color:var(--review)} .verdict.ok .call{color:var(--ok)}
  .verdict p{font-size:14.5px;flex:1;min-width:250px}
  .sec>h2{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);padding-bottom:7px;border-bottom:1px solid var(--rule-strong)}
  .find{display:grid;grid-template-columns:82px 1fr 122px;gap:16px;padding:13px 2px;border-bottom:1px solid var(--rule);align-items:baseline}
  .tag{font-family:var(--mono);font-size:10px;letter-spacing:.11em;text-transform:uppercase;font-weight:600}
  .tag.c{color:var(--critical)}.tag.r{color:var(--review)}.tag.n{color:var(--note)}
  .find h3{font-size:15px;font-weight:600;line-height:1.35;margin-bottom:3px;text-wrap:balance}
  .find p{font-size:13.5px;color:var(--ink-2)}
  .find .amt{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;font-size:14.5px}
  .find .amt small{display:block;font-size:10px;color:var(--ink-3);letter-spacing:.05em;margin-top:3px;text-transform:uppercase;font-family:var(--mono)}
  .where{font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
  .more{font-size:13px;color:var(--ink-3);padding:11px 2px}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:500;text-align:right;padding:9px 10px;border-bottom:1px solid var(--rule-strong);white-space:nowrap}
  th:first-child,td:first-child{text-align:left;padding-left:2px}
  td{padding:11px 10px;text-align:right;border-bottom:1px solid var(--rule);font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
  td:first-child{font-family:var(--sans);white-space:normal}
  td.wrap{white-space:normal;text-align:left;line-height:1.45}
  td .who{font-weight:600}
  td .meta{display:block;font-size:11.5px;color:var(--ink-3);font-family:var(--mono)}
  tr.total td{border-bottom:none;border-top:2px solid var(--rule-strong);font-weight:600;padding-top:12px}
  tr.total td:first-child{font-family:var(--sans)}
  .flag{color:var(--review)} .yes{color:var(--ok);font-family:var(--mono);font-size:12px} .no{color:var(--review);font-family:var(--mono);font-size:12px}
  .clean{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}
  .clean div{background:var(--panel);padding:12px 13px;display:flex;flex-direction:column;gap:5px}
  .clean .n{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:19px;color:var(--ok)}
  .clean .l{font-size:12.5px;color:var(--ink-2);line-height:1.4}
  .quiet{font-size:13px;color:var(--ink-3);line-height:1.55;margin-top:12px}
  .quiet b{color:var(--ink-2);font-weight:600}
  footer{border-top:1px solid var(--rule);padding-top:14px;font-size:12px;color:var(--ink-3)}
  @media (max-width:640px){.facts{grid-template-columns:repeat(2,1fr)}.find{grid-template-columns:1fr;gap:5px}.find .amt{text-align:left}}
  @media print{body{background:#fff}.sheet{padding:0;gap:24px}.find,tr{break-inside:avoid}}
</style></head><body>
<div class="sheet">

  <header class="masthead">
    <div class="eyebrow">Pay Application Review</div>
    <h1>${esc(h.projectName)}</h1>
    <div class="sub">${[h.contractor,
    h.applicationNumber != null ? `Application ${h.applicationNumber}` : null,
    h.periodTo ? `Period to ${h.periodTo}` : null].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="facts">
      ${facts.map(([l, v, big]) => `<div class="fact"><span class="eyebrow">${esc(l)}</span><span class="v${big ? ' big' : ''}">${v}</span></div>`).join('')}
    </div>
  </header>

  <div class="verdict ${vcls}">
    <span class="call">${esc(doc.verdictLabel)}</span>
    <p>${esc(doc.headline)}</p>
  </div>

  ${findingSection('What to resolve', doc.resolve)}
  ${findingSection('To confirm', doc.confirm)}
  ${findingSection('Noted, no action expected', doc.noted, 4)}

  ${subMatchSection(doc.subMatch)}
  ${vendorRollupSection(doc.vendorRollup)}
  ${taxSection(doc.tax, doc.taxToDeduct)}
  ${contractsSection(doc.contracts, doc.deliveryMethod)}

  ${waiverSection(doc.waivers)}

  <section class="sec">
    <h2>Checked and clean</h2>
    <div class="clean">
      <div><span class="n">${st.passed}</span><span class="l">of ${st.checksRun} checks passed</span></div>
      ${st.codesTotal ? `<div><span class="n">${st.codesTied}/${st.codesTotal}</span><span class="l">cost codes tie to the schedule of values</span></div>` : ''}
      <div><span class="n">${st.lineItems}</span><span class="l">schedule lines read and recalculated</span></div>
      <div><span class="n">${st.enginesRun.length}</span><span class="l">of ${st.enginesTotal} review passes had documents to work with</span></div>
    </div>
    ${doc.notChecked.length ? `<p class="quiet"><b>Not checked.</b> ${doc.notChecked.map(esc).join(' ')}</p>` : ''}
  </section>

  <footer>
    ${st.checksRun} deterministic checks. Every figure is recalculated from the submitted documents —
    nothing here is an estimate or an opinion.
  </footer>

</div></body></html>`;
}

module.exports = { buildReportHtml };
