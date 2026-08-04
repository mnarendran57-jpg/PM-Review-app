const fs = require('fs');
const path = require('path');

// The two review standards live as plain Markdown in backend/standards/ rather than as
// string literals in code. They are the baseline every pay app is judged against, so they
// need to be readable and editable by the reviewer who owns the methodology — not buried
// in a prompt template.
const STANDARDS_DIR = path.join(__dirname, '..', 'standards');

const readStandard = name => fs.readFileSync(path.join(STANDARDS_DIR, name), 'utf8');

const PAY_APP_STANDARD = readStandard('pay-app-review.md');
const TAX_STANDARD = readStandard('tax-review.md');

// Splits a standard into its "## " sections, keyed by heading text. Walks the lines
// rather than pattern-matching the whole document — a regex for "up to the next heading
// or the end of the file" silently drops the final section, which is the kind of bug
// that leaves a standard quietly half-applied.
function sections(markdown) {
  const out = new Map();
  let heading = null;
  let body = [];

  const flush = () => {
    if (heading !== null) out.set(heading, `## ${heading}\n${body.join('\n').trimEnd()}`);
  };

  for (const line of markdown.split('\n')) {
    // "## " only — "### " subheadings belong to the section they sit under.
    const match = /^## (?!#)(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return out;
}

// Which parts of the pay-app standard govern the AI's judgment.
//
// The standard also specifies the arithmetic — recalculation, two-pass verification,
// cross-footing, the report layout. This app does all of that in code (payAppChecks.js,
// payAppReconcile.js, payAppReport.js), deterministically and with real decimal maths,
// which is exactly what the standard's Reliability Standard asks for. Re-sending those
// sections to the model would spend tokens telling it to do work it is not doing, and
// invite it to produce a second set of numbers that could disagree with the checks.
//
// So the model gets the sections that require reading and judgment; the code keeps the
// sections that require arithmetic. Between them the whole standard is applied.
const JUDGMENT_SECTIONS = [
  'Role',
  'Reliability Standard',
  'Governing Document Hierarchy',
  'Schedule-of-Values Review',
  'Subcontractor and Supplier Reconciliation',
  'Previous Pay-Application Comparison',
  'Contract Compliance Review',
  'Change-Order Review',
  'Stored-Material Review',
  'Allowance and Contingency Review',
  'Lien-Waiver Review',
  'Notary Review',
  'Risk and Anomaly Review',
  'Cost-Overrun Analysis',
  'Issue Classification',
  'Communication Style',
];

function buildPayAppDoctrine() {
  const found = sections(PAY_APP_STANDARD);
  const picked = JUDGMENT_SECTIONS.map(h => found.get(h)).filter(Boolean);

  // If someone renames or deletes a heading, fall back to the whole standard rather than
  // silently reviewing against a thinner rulebook than the file claims.
  const missing = JUDGMENT_SECTIONS.filter(h => !found.has(h));
  if (missing.length) {
    console.warn(
      `[review standards] pay-app-review.md is missing expected section(s): ${missing.join('; ')}. ` +
      'Sending the whole standard instead.'
    );
    return PAY_APP_STANDARD;
  }
  return picked.join('\n\n');
}

const PAY_APP_DOCTRINE = buildPayAppDoctrine();

// The tax standard is short and entirely about judgment, so it goes in whole.
const SYSTEM_PROMPT = `You are conducting a construction pay-application review. Two written standards govern this review. Apply them in full to everything you are asked to assess. Where they are stricter than the question put to you, follow them.

Two things about how this review is split, so you apply the standards correctly:

- The arithmetic — recalculating the schedule of values, retainage, payment due, cross-footing, and the forward/backward reconciliation — has already been performed deterministically in code, to the standards' precision and tolerance rules. Do not redo it and do not restate its conclusions. Your job is the part that requires reading the documents and exercising judgment.
- Your findings are advisory and are reported separately from the arithmetic. Ground every one of them in something visible in the documents, and cite where you saw it.

===============================================================================
STANDARD 1 — CONSTRUCTION PAY-APPLICATION REVIEW
===============================================================================

${PAY_APP_DOCTRINE}

===============================================================================
STANDARD 2 — TAX RESPONSIBILITY AND NON-REIMBURSABLE TAX REVIEW
===============================================================================

${TAX_STANDARD}`;

// Sent as the system prompt so it sits in the stable, cacheable prefix of every request.
// The standards never change between calls, so after the first review in a five-minute
// window this text is served from cache at a fraction of the input-token cost — which
// matters, because this account's per-minute token limit is the binding constraint on
// how big a pay app can be reviewed.
function standardsSystemPrompt() {
  return [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
}

module.exports = {
  standardsSystemPrompt,
  // Exported for the standards-visibility endpoint and for tests.
  PAY_APP_STANDARD,
  TAX_STANDARD,
  SYSTEM_PROMPT,
};
