const { askForJson } = require('./aiJson');
const { SEVERITY } = require('./payAppInvariants');

// THE CSP PAY APPLICATION REVIEW, as the whole review logic for Pay App Reviewer 2.
//
// Everything that was in this file before — the CMAR audit — has been removed. This is the CSP
// skill and nothing else: a single prime contractor billing an owner against a stipulated sum,
// checked the way a construction auditor checks one. Verify the arithmetic, tie the cover sheet to
// the continuation sheets, tie this month to last month, check it all against what the contract
// actually says.
//
// THE GOVERNING PRINCIPLE, and the reason the file is shaped this way: money math never happens in
// the model's head. Every figure below is recomputed in JavaScript from the transcription. A model
// doing mental arithmetic across ninety line items will be wrong occasionally and confident always,
// which is the worst possible failure mode for a document that authorizes payment. The model's job
// is perception and judgment; this file's job is arithmetic.
//
// The checks, their tolerances and their severities are a direct port of the skill's validate.py.
// Check ids are kept verbatim (G703_OVERBILL, CONTINUITY_D, RETAINAGE_COMPLETED …) so a finding
// here and a finding from the skill run by hand are the same finding, and so the rules can be read
// in the skill's own validation-rules.md rather than reverse-engineered from this code.
//
// WHAT IS NOT CHECKED HERE. CSP is the scope: one prime, one stipulated sum. Subcontractor
// schedules of values, subcontractor invoices and their backup, GC markup, and contingency draws
// against a GMP are CMAR concerns and are deliberately absent. A CMAR package run through this will
// get an honest CSP review of its prime application and will say nothing about its subs — which is
// better than a half-answer that reads like a whole one.

// --- the skill's severities, and how they reach a report that has three ------------------------
//
// The skill grades CRITICAL / HIGH / MEDIUM / LOW / INFO. This app's report has three levels. The
// mapping is not a convenience: it is chosen to reproduce the skill's own recommendation
// thresholds, where any CRITICAL means DO NOT CERTIFY and HIGH alone means APPROVE WITH
// CORRECTIONS. The skill's grade travels with the finding so the report can still print it.
const CRITICAL = 'CRITICAL';
const HIGH = 'HIGH';
const MEDIUM = 'MEDIUM';
const LOW = 'LOW';
const INFO = 'INFO';

const APP_SEVERITY = {
  [CRITICAL]: SEVERITY.CRITICAL,
  [HIGH]: SEVERITY.MATERIAL,
  [MEDIUM]: SEVERITY.NOTE,
  [LOW]: SEVERITY.NOTE,
  [INFO]: SEVERITY.NOTE,
};

// Dollar tolerance. Cent-level rounding is acceptable; anything larger is a finding. The
// retainage-adjusted sum gets its own looser tolerance because it compounds rounding across every
// line on the schedule.
const TOL = 0.01;
const SUM_TOL = 0.05;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const money = n => (isNum(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : 'n/a');

// Blank, dash and null all read as zero for arithmetic. present() is the separate question of
// whether the contractor reported anything at all, and it decides which checks run — a blank cell
// means not reported, a zero means reported as nothing, and treating the first as the second
// invents findings about figures nobody wrote down.
function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return 0;
  if (typeof v === 'string') {
    let s = v.replace(/[$,]/g, '').trim();
    const neg = s.startsWith('(') && s.endsWith(')');
    if (neg) s = s.slice(1, -1);
    const f = parseFloat(s);
    if (!Number.isFinite(f)) return 0;
    return neg ? -f : f;
  }
  return Number(v) || 0;
}
const present = v => v !== null && v !== undefined && v !== '' && v !== '-';
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const round2 = v => (isNum(v) ? Math.round(v * 100) / 100 : v);

// --- findings ----------------------------------------------------------------------------------

class Findings {
  constructor() { this.items = []; }

  add(severity, check, message, { expected, found, delta, location, citation } = {}) {
    this.items.push({
      severity, check, message,
      expected: round2(expected), found: round2(found), delta: round2(delta),
      location: location || null, citation: citation || null,
    });
  }

  count(sev) { return this.items.filter(f => f.severity === sev).length; }
}

// --- G703 row-level ----------------------------------------------------------------------------

// Run against every line item. These are the checks that catch errors surviving total-level
// reconciliation, which is the most dangerous class of error in a pay app: the wrong figure flows
// consistently into every total, so the footing, the tie and the retainage sum all still pass, and
// only the row sees it.
function checkG703Rows(cur, f) {
  for (const row of cur.g703?.line_items || []) {
    const loc = `G703 item ${row.item_no ?? '?'} — ${String(row.description || '').slice(0, 45)}`;
    const C = num(row.scheduled_value);
    const D = num(row.prior_completed);
    const E = num(row.this_period);
    const F = num(row.materials_stored);
    const G = num(row.total_to_date);
    const H = num(row.balance_to_finish);
    const I = num(row.pct_complete);
    const isCredit = C < 0;

    if (present(row.total_to_date)) {
      const exp = D + E + F;
      if (!close(G, exp)) {
        f.add(HIGH, 'G703_ROW_G', 'Column G must equal D+E+F.',
          { expected: exp, found: G, delta: G - exp, location: loc });
      }
    }

    if (present(row.balance_to_finish)) {
      const exp = C - G;
      if (!close(H, exp)) {
        f.add(HIGH, 'G703_ROW_H', 'Column H must equal C-G.',
          { expected: exp, found: H, delta: H - exp, location: loc });
      }
    }

    if (present(row.pct_complete) && Math.abs(C) > TOL) {
      const exp = (G / C) * 100;
      if (Math.abs(I - exp) > 1.0) {
        f.add(MEDIUM, 'G703_ROW_PCT', 'Column I must equal (G/C)*100.',
          { expected: Math.round(exp * 10) / 10, found: I, location: loc });
      }
    }

    if (!isCredit && G - C > TOL) {
      const pct = Math.abs(C) > TOL ? (G / C * 100).toFixed(1) : '0.0';
      f.add(CRITICAL, 'G703_OVERBILL',
        `Billed to date exceeds scheduled value (${pct}% complete).`,
        { expected: C, found: G, delta: G - C, location: loc });
    }

    if (!isCredit && present(row.balance_to_finish) && H < -TOL) {
      f.add(CRITICAL, 'G703_NEGATIVE_BALANCE',
        'Balance to finish is negative — line is overbilled.', { found: H, location: loc });
    }

    // Credits carry negative scheduled values legitimately, so sign checks skip C < 0. A negative
    // in column E on a POSITIVE line means a prior over-billing is being reversed, which is worth
    // someone confirming was intentional.
    if (E < -TOL && !isCredit) {
      f.add(MEDIUM, 'G703_NEGATIVE_PERIOD',
        'Negative amount billed this period on a non-credit line. Confirm this is an intentional correction.',
        { found: E, location: loc });
    }
  }
}

// --- G703 column footing -----------------------------------------------------------------------

const FOOTING_COLUMNS = [
  ['scheduled_value', 'C'], ['prior_completed', 'D'], ['this_period', 'E'],
  ['materials_stored', 'F'], ['total_to_date', 'G'], ['balance_to_finish', 'H'],
];

function checkG703Footing(cur, f) {
  const rows = cur.g703?.line_items || [];
  const totals = cur.g703?.totals;
  if (!totals || !Object.keys(totals).length) {
    f.add(MEDIUM, 'G703_NO_TOTALS',
      'No G703 grand total row captured; column footing not verified.');
    return;
  }
  // A footing failure usually means a transcription miss rather than a contractor error — a line
  // dropped, or a page of a multi-page G703 not captured. The wording says so, because a reader who
  // takes it to the contractor before re-checking the extraction wastes the conversation.
  for (const [key, col] of FOOTING_COLUMNS) {
    if (!present(totals[key])) continue;
    const stated = num(totals[key]);
    const computed = rows.reduce((s, r) => s + num(r[key]), 0);
    if (!close(stated, computed)) {
      f.add(HIGH, 'G703_FOOTING', `Column ${col} rows do not sum to the stated total.`,
        { expected: computed, found: stated, delta: stated - computed, location: `G703 column ${col} total` });
    }
  }
}

// --- contingency and credits -------------------------------------------------------------------

function checkContingencyAndCredits(cur, f) {
  const rows = cur.g703?.line_items || [];
  const credits = rows.filter(r => num(r.scheduled_value) < 0);

  for (const r of credits) {
    const loc = `G703 item ${r.item_no ?? '?'} — ${String(r.description || '').slice(0, 45)}`;
    const C = num(r.scheduled_value);
    const G = num(r.total_to_date);
    if (G > TOL) {
      f.add(HIGH, 'CREDIT_SIGN',
        'Credit line carries a positive amount in column G. Credits must reduce the total, not add to it.',
        { expected: C, found: G, location: loc });
    }
  }
  if (credits.length) {
    const total = credits.reduce((s, r) => s + num(r.scheduled_value), 0);
    f.add(INFO, 'CREDITS_PRESENT', `${credits.length} credit line(s) totalling ${money(total)}.`);
  }

  // Contingency is owner money held for changes. Drawing beyond the authorized allowance means
  // changes were billed without the authority to spend against them. The INFO line goes in every
  // report — remaining contingency is what owners track month over month.
  const cont = cur.g703?.contingency;
  if (cont) {
    const authorized = num(cont.authorized_amount);
    const drawn = num(cont.drawn_to_date);
    if (authorized && drawn - authorized > TOL) {
      f.add(CRITICAL, 'CONTINGENCY_EXCEEDED', 'Contingency drawn exceeds the authorized allowance.',
        { expected: authorized, found: drawn, delta: drawn - authorized, location: 'G703 contingency' });
    } else if (authorized) {
      f.add(INFO, 'CONTINGENCY_STATUS',
        `Contingency: ${money(drawn)} drawn of ${money(authorized)} authorized (${money(authorized - drawn)} remaining).`);
    }
  }
}

// --- G702 internal -----------------------------------------------------------------------------

// Line 9 is checked against Line 3 − Line 6, so it INCLUDES retainage. It will not equal the G703
// column H total, which excludes it. The two differing by exactly the retainage amount is correct
// and is not a finding.
function checkG702Internal(cur, f) {
  const g = cur.g702;
  if (!g || !Object.keys(g).length) {
    f.add(CRITICAL, 'G702_MISSING', 'No G702 cover sheet data captured.');
    return;
  }
  const L1 = num(g.line1_original_contract_sum);
  const L2 = num(g.line2_net_change_orders);
  const L3 = num(g.line3_contract_sum_to_date);
  const L4 = num(g.line4_total_completed_stored);
  const L5a = num(g.line5a_retainage_completed_work);
  const L5b = num(g.line5b_retainage_stored_material);
  const L5 = num(g.line5_total_retainage);
  const L6 = num(g.line6_total_earned_less_retainage);
  const L7 = num(g.line7_less_previous_certificates);
  const L8 = num(g.line8_current_payment_due);
  const L9 = num(g.line9_balance_to_finish);

  const lines = [
    ['line3', 'Line 3 must equal Line 1 + Line 2.', L1 + L2, L3],
    ['line5', 'Line 5 must equal Line 5a + Line 5b.', L5a + L5b, L5],
    ['line6', 'Line 6 must equal Line 4 - Line 5.', L4 - L5, L6],
    ['line8', 'Line 8 must equal Line 6 - Line 7.', L6 - L7, L8],
    ['line9', 'Line 9 must equal Line 3 - Line 6.', L3 - L6, L9],
  ];
  for (const [key, label, exp, got] of lines) {
    if (!close(exp, got)) {
      f.add(HIGH, `G702_${key.toUpperCase()}`, label,
        { expected: exp, found: got, delta: got - exp, location: `G702 ${key}` });
    }
  }
}

// The seam between the cover sheet and the detail. A break means the two halves of the application
// describe different amounts of work, and the certified figure is not supported by the schedule of
// values behind it.
function checkG702ToG703(cur, f) {
  const L4 = num(cur.g702?.line4_total_completed_stored);
  const totals = cur.g703?.totals || {};
  if (!present(totals.total_to_date)) {
    f.add(MEDIUM, 'G702_G703_TIE_SKIPPED',
      'G703 column G grand total not captured; Line 4 tie not verified.');
    return;
  }
  const G = num(totals.total_to_date);
  if (!close(L4, G)) {
    f.add(CRITICAL, 'G702_G703_TIE', 'G702 Line 4 must equal the G703 column G grand total.',
      { expected: G, found: L4, delta: L4 - G, location: 'G702 line 4 / G703 column G' });
  }
}

// --- retainage ---------------------------------------------------------------------------------

// The most error-prone figure on the form, and the checks are correspondingly aggressive.
//
// NO RATE, NO CHECK. Where the contract profile has no retainage rate this reports that retainage
// could not be verified and stops. It does not fall back to 5%. An assumed rate produces confident,
// wrong findings on every application for the life of the project, and a reader has no way to tell
// them from real ones.
function checkRetainage(cur, contract, f) {
  const g = cur.g702 || {};
  const totals = cur.g703?.totals || {};

  const rate = contract ? contract.retainage_rate : null;
  if (rate === null || rate === undefined) {
    f.add(HIGH, 'RETAINAGE_RATE_UNKNOWN',
      'No retainage rate available from the contract profile. Retainage cannot be verified — do not assume 5%.',
      { citation: 'contract profile: retainage_rate' });
    return;
  }

  const completed = num(totals.prior_completed) + num(totals.this_period);
  const stored = num(totals.materials_stored);
  const cite = contract.citations?.retainage_rate;
  const ratePct = `${+(rate * 100).toFixed(4)}%`;

  const L5a = num(g.line5a_retainage_completed_work);
  if (present(g.line5a_retainage_completed_work) && completed) {
    const exp = completed * rate;
    if (!close(L5a, exp)) {
      f.add(CRITICAL, 'RETAINAGE_COMPLETED', `Retainage on completed work must be ${ratePct} of (D+E).`,
        { expected: exp, found: L5a, delta: L5a - exp, location: 'G702 line 5a', citation: cite });
    }
  }

  const L5b = num(g.line5b_retainage_stored_material);
  if (stored > TOL && present(g.line5b_retainage_stored_material)) {
    const exp = stored * rate;
    if (!close(L5b, exp)) {
      f.add(HIGH, 'RETAINAGE_STORED', `Retainage on stored material must be ${ratePct} of F.`,
        { expected: exp, found: L5b, delta: L5b - exp, location: 'G702 line 5b', citation: cite });
    }
  }

  // Catches the case where 5a and 5b are individually plausible but the total does not come to the
  // contract percentage of Line 4 — which happens when retainage is applied to some lines and not
  // others.
  const L4 = num(g.line4_total_completed_stored);
  const L5 = num(g.line5_total_retainage);
  if (L4 > TOL && L5 > TOL) {
    const eff = L5 / L4;
    if (Math.abs(eff - rate) > 0.001) {
      f.add(HIGH, 'RETAINAGE_EFFECTIVE_RATE',
        `Total retainage is ${(eff * 100).toFixed(2)}% of Line 4; contract specifies ${ratePct}.`,
        { expected: L4 * rate, found: L5, delta: L5 - L4 * rate, location: 'G702 line 5', citation: cite });
    }
  }

  const exempt = contract.retainage_exempt_items || [];
  if (exempt.length) {
    f.add(INFO, 'RETAINAGE_EXEMPT_ITEMS',
      `Contract exempts these from retainage: ${exempt.join(', ')}. Verify they were excluded from the retainage basis.`,
      { citation: cite });
  }
}

// Each line's period billing net of retainage should sum to Line 8. This is the tie between the
// schedule of values and the cash actually being requested, and it is the check that catches a line
// moving without the cover sheet following.
function checkRetainageAdjustedSum(cur, contract, f) {
  const rate = contract ? contract.retainage_rate : null;
  if (rate === null || rate === undefined) return;
  const rows = cur.g703?.line_items || [];
  if (!rows.length) return;
  if (!present(cur.g702?.line8_current_payment_due)) return;

  const periodNet = rows.reduce((s, r) => s + num(r.this_period), 0) * (1 - rate);
  const L8 = num(cur.g702.line8_current_payment_due);

  if (!close(periodNet, L8, SUM_TOL)) {
    f.add(HIGH, 'RETAINAGE_ADJUSTED_SUM',
      `Sum of this-period billings x ${(1 - rate).toFixed(2)} does not equal Line 8. This usually `
      + 'means a line moved without the cover sheet following, or retainage was applied unevenly.',
      { expected: periodNet, found: L8, delta: L8 - periodNet, location: 'G703 column E -> G702 line 8' });
  }
}

// --- pay-app-to-pay-app continuity ---------------------------------------------------------------

const rowKey = row => String(row.item_no ?? '').trim()
  || String(row.description ?? '').trim().toLowerCase();

// Column D is definitionally what was billed through the previous application, so it must equal the
// prior application's column G on every line. A mismatch means work was re-billed, silently
// reversed, or the schedule of values shifted underneath.
function checkContinuity(cur, prior, f) {
  if (!prior) {
    f.add(INFO, 'NO_PRIOR', 'No prior pay application supplied; continuity checks skipped.');
    return;
  }

  const curN = cur.application_number;
  const priN = prior.application_number;
  if (isNum(curN) && isNum(priN) && curN !== priN + 1) {
    f.add(MEDIUM, 'SEQUENCE_GAP',
      `Application #${curN} follows #${priN}; expected consecutive numbering. Confirm no intervening application is missing.`);
  }

  const priRows = new Map();
  for (const r of prior.g703?.line_items || []) priRows.set(rowKey(r), r);
  const curRows = cur.g703?.line_items || [];

  for (const r of curRows) {
    const loc = `G703 item ${r.item_no ?? '?'} — ${String(r.description || '').slice(0, 45)}`;
    const p = priRows.get(rowKey(r));
    if (!p) {
      // MEDIUM rather than HIGH: new lines are routine on projects with active change orders. This
      // is a prompt to confirm the backing change order exists, not an accusation.
      if (Math.abs(num(r.scheduled_value)) > TOL) {
        f.add(MEDIUM, 'NEW_LINE_ITEM',
          'Line item not present in the prior application. Confirm it is backed by an approved change order.',
          { found: num(r.scheduled_value), location: loc });
      }
      continue;
    }

    const D = num(r.prior_completed);
    const pG = num(p.total_to_date);
    if (present(r.prior_completed) && !close(D, pG)) {
      f.add(CRITICAL, 'CONTINUITY_D',
        "Column D must equal the prior application's column G for this line.",
        { expected: pG, found: D, delta: D - pG, location: loc });
    }

    const C = num(r.scheduled_value);
    const pC = num(p.scheduled_value);
    if (!close(C, pC)) {
      f.add(HIGH, 'SOV_DRIFT',
        'Scheduled value changed from the prior application. This requires an approved change order.',
        { expected: pC, found: C, delta: C - pC, location: loc });
    }
  }

  const curKeys = new Set(curRows.map(rowKey));
  for (const [k, p] of priRows) {
    if (curKeys.has(k)) continue;
    if (Math.abs(num(p.total_to_date)) > TOL) {
      f.add(HIGH, 'DROPPED_LINE_ITEM', 'Line item billed in the prior application is absent here.',
        { expected: num(p.total_to_date), location: `prior G703 item ${p.item_no ?? '?'}` });
    }
  }
}

function checkLine7(cur, prior, f) {
  if (!prior) return;
  const priorL6 = prior.g702?.line6_total_earned_less_retainage;
  if (!present(priorL6)) return;
  const L7 = num(cur.g702?.line7_less_previous_certificates);
  const pL6 = num(priorL6);
  if (!close(L7, pL6)) {
    f.add(CRITICAL, 'LINE7_CONTINUITY', "Line 7 must equal the prior application's Line 6.",
      { expected: pL6, found: L7, delta: L7 - pL6, location: 'G702 line 7' });
  }
}

// --- contract-derived ----------------------------------------------------------------------------

function checkContractTerms(cur, contract, f) {
  if (!contract) {
    f.add(HIGH, 'NO_CONTRACT_PROFILE',
      'No contract profile supplied. Retainage rate, tax treatment and required documents could not '
      + 'be verified against the contract.');
    return;
  }

  const cs = contract.contract_sum;
  if (cs !== null && cs !== undefined && present(cur.g702?.line1_original_contract_sum)) {
    const L1 = num(cur.g702.line1_original_contract_sum);
    if (!close(num(cs), L1)) {
      f.add(CRITICAL, 'CONTRACT_SUM_MISMATCH', 'G702 Line 1 does not match the executed contract sum.',
        { expected: num(cs), found: L1, delta: L1 - num(cs), location: 'G702 line 1',
          citation: contract.citations?.contract_sum });
    }
  }

  // Public owners are typically exempt from sales and use tax, and the exemption usually extends to
  // RENTAL AND LEASE of equipment, not just purchase. Contracts commonly add that a contractor who
  // fails to use the exemption certificate absorbs the tax without reimbursement — so tax billed to
  // an exempt owner is non-reimbursable regardless of whether the contractor actually paid it.
  //
  // The hard part is that tax is rarely a labelled line; it is folded into a material cost. This
  // check only catches an identifiable amount. The INFO finding exists to prompt the manual look.
  if (contract.owner_tax_exempt) {
    const tax = cur.tax_billed;
    const cite = contract.citations?.owner_tax_exempt;
    if (tax && num(tax) > TOL) {
      f.add(CRITICAL, 'TAX_BILLED_TO_EXEMPT_OWNER',
        `Sales/use tax of ${money(num(tax))} billed to a tax-exempt owner. Under the contract the `
        + 'contractor absorbs tax it failed to avoid via the exemption certificate.',
        { expected: 0, found: num(tax), delta: num(tax), location: 'tax line', citation: cite });
    } else {
      f.add(INFO, 'TAX_EXEMPT_OWNER',
        'Owner is tax-exempt. Confirm no sales/use tax is embedded in line items, including on '
        + 'rented or leased equipment.', { citation: cite });
    }
  }

  if (contract.stored_materials_require_offsite_consent) {
    const stored = num(cur.g703?.totals?.materials_stored);
    if (stored > TOL) {
      f.add(MEDIUM, 'STORED_MATERIALS_BACKUP',
        `${money(stored)} billed as stored materials. Contract requires bills of sale and, for `
        + 'off-site storage, written Owner and Surety consent plus a bonded warehouse.',
        { citation: contract.citations?.stored_materials });
    }
  }
}

function checkG702Completeness(cur, contract, f) {
  if (!contract?.g702_all_blanks_required) return;
  const g = cur.g702 || {};
  const required = [
    'line1_original_contract_sum', 'line3_contract_sum_to_date', 'line4_total_completed_stored',
    'line5_total_retainage', 'line6_total_earned_less_retainage',
    'line7_less_previous_certificates', 'line8_current_payment_due', 'line9_balance_to_finish',
  ];
  const blank = required.filter(k => !present(g[k]));
  if (blank.length) {
    f.add(MEDIUM, 'G702_INCOMPLETE',
      `Contract requires all G702 blanks completed. Missing: ${blank.map(k => k.split('_')[0]).join(', ')}.`,
      { citation: contract.citations?.g702_requirements });
  }
  if (!g.contractor_signature_present) {
    f.add(HIGH, 'G702_UNSIGNED', 'G702 contractor signature not present.');
  }
  if (!g.notarized) {
    f.add(HIGH, 'G702_NOT_NOTARIZED',
      'G702 is not notarized; contract requires original contractor and notary signatures on the form.');
  }
}

// --- lien waiver ---------------------------------------------------------------------------------

// Amount mismatch is CRITICAL because the waiver releases lien rights only up to the sum it names.
// If it is below Line 8, the owner pays more than it is released against and retains exposure on the
// difference. An expired commission voids the notarization, and with it the waiver's enforceability.
function checkLienWaiver(cur, f) {
  const lw = cur.lien_waiver;
  if (!lw) {
    f.add(HIGH, 'LIEN_WAIVER_MISSING', 'No lien waiver captured with this application.');
    return;
  }

  if (present(lw.amount) && present(cur.g702?.line8_current_payment_due)) {
    const amt = num(lw.amount);
    const L8 = num(cur.g702.line8_current_payment_due);
    if (!close(amt, L8)) {
      f.add(CRITICAL, 'LIEN_WAIVER_AMOUNT',
        'Lien waiver amount must equal G702 Line 8 (current payment due).',
        { expected: L8, found: amt, delta: amt - L8, location: 'lien waiver' });
    }
  }

  if (!lw.signature_present) {
    f.add(HIGH, 'LIEN_WAIVER_UNSIGNED',
      "Lien waiver is not signed by the contractor's representative.");
  }

  const notary = lw.notary || {};
  if (!notary.stamp_or_seal_present) f.add(HIGH, 'NOTARY_NO_SEAL', 'Notary seal or stamp is not present.');
  if (!notary.notary_signature_present) f.add(HIGH, 'NOTARY_UNSIGNED', 'Notary signature is not present.');

  const exp = notary.commission_expires;
  const sworn = lw.date_sworn;
  if (exp && sworn) {
    const dExp = new Date(String(exp));
    const dSworn = new Date(String(sworn));
    if (Number.isNaN(dExp.getTime()) || Number.isNaN(dSworn.getTime())) {
      f.add(LOW, 'NOTARY_DATE_UNPARSED', `Could not parse notary dates (expires=${exp}, sworn=${sworn}).`);
    } else if (dSworn > dExp) {
      f.add(CRITICAL, 'NOTARY_COMMISSION_EXPIRED',
        `Notary commission expired ${String(exp)} but the document was sworn ${String(sworn)}. `
        + 'The notarization is invalid.',
        { expected: String(exp), found: String(sworn), location: 'lien waiver notary block' });
    }
  }

  if (!notary.notary_id) f.add(LOW, 'NOTARY_NO_ID', 'Notary ID number not legible or absent.');
}

// --- the validator driver ------------------------------------------------------------------------

function validate(cur, prior, contract) {
  const f = new Findings();
  checkG702Internal(cur, f);
  checkG702ToG703(cur, f);
  checkG703Rows(cur, f);
  checkG703Footing(cur, f);
  checkContingencyAndCredits(cur, f);
  checkRetainage(cur, contract, f);
  checkRetainageAdjustedSum(cur, contract, f);
  checkContinuity(cur, prior, f);
  checkLine7(cur, prior, f);
  checkContractTerms(cur, contract, f);
  checkG702Completeness(cur, contract, f);
  checkLienWaiver(cur, f);
  return f;
}

// --- transcription: this app's extraction, in the skill's schema ---------------------------------
//
// The skill transcribes the G702 and G703 into its own schema by reading the pages. This module is
// handed an extraction the app has already made and already reconciled against the PDF's text layer
// line by line, so it maps that across rather than paying for a second reading of the same pages.
//
// The one thing the mapping must not lose is BLANK versus ZERO. The validator skips checks on null
// and runs them on 0, so flattening a blank cell to zero invents findings about figures nobody
// wrote down. Every field below passes null through untouched for that reason.
const orNull = v => (v === undefined || v === '' ? null : v ?? null);

// A grouped schedule of values prints its own group totals as rows. The skill's transcription rule
// is explicit that per-page and per-group subtotals are skipped and only the grand total is
// captured, and the reason shows up immediately if they are not: on the real package the eight
// group-total rows made every column sum to exactly twice its stated total, producing five footing
// findings that all said the same thing and none of which were true. Column G ties to the penny
// once they are out.
const SUBTOTAL = /(^|\s)(sub)?totals?\b|\btotals?\s*:/i;
const isSubtotal = li => SUBTOTAL.test(String(li.description || ''));

function toExtraction(payApp) {
  if (!payApp?.summary) return null;
  const s = payApp.summary;

  const lineItems = (payApp.lineItems || []).filter(li => !isSubtotal(li)).map(li => ({
    item_no: orNull(li.itemNo),
    description: li.description || '',
    scheduled_value: orNull(li.c),
    prior_completed: orNull(li.d),
    this_period: orNull(li.e),
    materials_stored: orNull(li.f),
    total_to_date: orNull(li.g),
    balance_to_finish: orNull(li.h),
    pct_complete: orNull(li.pctComplete),
    retainage: orNull(li.retainage),
  }));

  const gt = payApp.grandTotalRow || null;
  const totals = gt ? {
    scheduled_value: orNull(gt.c),
    prior_completed: orNull(gt.d),
    this_period: orNull(gt.e),
    materials_stored: orNull(gt.f),
    total_to_date: orNull(gt.g),
    balance_to_finish: orNull(gt.h),
    pct_complete: orNull(gt.pctComplete),
  } : {};

  // Only an identifiable tax amount belongs here. Where the extraction listed taxed invoices in the
  // backup, their sum IS identifiable and is totalled in code — the model never adds it up.
  const taxRows = (payApp.taxes || []).filter(t => isNum(t.amount) && t.amount > 0);
  const taxBilled = taxRows.length
    ? Math.round(taxRows.reduce((sum, t) => sum + t.amount, 0) * 100) / 100
    : null;

  return {
    application_number: orNull(s.applicationNumber),
    period_to: orNull(s.periodTo),
    project: orNull(s.projectName),
    contractor: orNull(s.contractor),
    owner: orNull(s.owner),
    tax_billed: taxBilled,
    _tax_rows: taxRows,
    _subtotal_rows_excluded: (payApp.lineItems || []).filter(isSubtotal).length,
    g702: {
      line1_original_contract_sum: orNull(s.line1),
      line2_net_change_orders: orNull(s.line2),
      line3_contract_sum_to_date: orNull(s.line3),
      line4_total_completed_stored: orNull(s.line4),
      line5a_retainage_completed_work: orNull(s.line5aAmount),
      line5b_retainage_stored_material: orNull(s.line5bAmount),
      line5_total_retainage: orNull(s.line5),
      line6_total_earned_less_retainage: orNull(s.line6),
      line7_less_previous_certificates: orNull(s.line7),
      line8_current_payment_due: orNull(s.line8),
      line9_balance_to_finish: orNull(s.line9),
      // Filled in from the page by the perception pass below. A signature and a seal are images;
      // the text layer reports an executed form as blank, so these must never be read from it.
      contractor_signature_present: null,
      notarized: null,
    },
    g703: { line_items: lineItems, totals, contingency: null },
    lien_waiver: null,
  };
}

// --- the contract profile ------------------------------------------------------------------------
//
// The skill's profile turns a long contract into a dozen fields the validator can act on. The app
// has already read the contract into its own terms object, so this maps that across.
//
// RECORD A FIELD AS NULL WHEN IT IS NOT THERE. Never default a missing retainage rate to 5%. The
// validator then refuses to verify retainage rather than verifying it against a guess, which is the
// correct outcome — a wrong rate produces confidently wrong findings on every pay app for the life
// of the project.
function toContractProfile(contractTerms, contracts) {
  if (!contractTerms) return null;
  const t = contractTerms;
  const primary = (contracts || []).find(c => c.isPrimary) || (contracts || [])[0] || null;

  // The contract's own citation for the tax position, where its unallowable-items list carries one.
  // "Retainage should be 5% per §5.1.7.1 (p.7), billed at 4.2%" survives a conversation with the
  // contractor; "retainage looks wrong" does not.
  const taxItem = (t.unallowableItems || [])
    .find(u => /tax/i.test(u.item || '') || /tax/i.test(u.basis || ''));

  return {
    project: t.partyScope || null,
    owner: null,
    contractor: t.party || null,
    contract_form: primary?.label || primary?.fileName || null,
    contract_sum: isNum(t.originalContractSum) ? t.originalContractSum : null,
    retainage_rate: isNum(t.retainageRate) ? t.retainageRate : null,
    retainage_exempt_items: null,
    owner_tax_exempt: t.taxExempt === true,
    tax_exemption_scope: t.taxExemptBasis || null,
    // Whether the contractor absorbs tax it failed to avoid is the sentence that decides the
    // finding, so it is carried verbatim from the clause rather than paraphrased.
    tax_failure_consequence: taxItem?.basis || null,
    stored_materials_require_offsite_consent: null,
    g702_all_blanks_required: null,
    citations: {
      contract_sum: primary?.label ? `${primary.label} (contract on file)` : null,
      retainage_rate: null,
      owner_tax_exempt: t.taxExemptBasis || taxItem?.basis || null,
      stored_materials: null,
      g702_requirements: null,
    },
    unallowable_items: t.unallowableItems || [],
    confirmed_by: null,
  };
}

// --- perception: the judgment the script cannot apply ---------------------------------------------

// The validator handles arithmetic. Several things need a reading of the actual page, and the skill
// is explicit that these are where a review earns its keep. Two of them also FEED the validator —
// the notary block and the contingency heading are inputs to checks, not just observations — which
// is why this call happens before validation rather than after.
const PERCEPTION_TOOL = {
  name: 'record_payapp_reading',
  description: 'Record what can only be seen on the pages of a CSP pay application package.',
  input_schema: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        description: 'Every page classified. A package with a G702 but no lien waiver is a finding '
          + 'in itself, so an absent document type must be visible as an absence.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['g702', 'g703', 'contractor_invoice', 'lien_waiver', 'change_order',
                'stored_material_bill_of_sale', 'certified_payroll', 'other'],
            },
            pages: { type: 'string', description: 'e.g. "1" or "2-6".' },
            note: { type: 'string', description: 'One phrase: what it is and its condition.' },
          },
          required: ['type', 'pages'],
        },
      },
      g702Execution: {
        type: 'object',
        description: 'Judged from the PAGE, never from extracted text. A signature and a seal are '
          + 'images; text extraction reports an executed form as blank, and calling an executed '
          + 'application unsigned is the worst error this review can make.',
        properties: {
          contractorSignaturePresent: { type: 'boolean', description: 'Is a handwritten or electronic signature actually visible?' },
          notarized: { type: 'boolean', description: 'Is a notary block completed AND sealed on the G702?' },
          allBlanksCompleted: { type: 'boolean' },
          note: { type: 'string', description: 'One sentence on what is or is not there.' },
        },
        required: ['contractorSignaturePresent', 'notarized'],
      },
      lienWaiver: {
        type: 'object',
        description: 'Omit entirely if no lien waiver is in the package — do not invent an empty one.',
        properties: {
          type: { type: 'string', description: 'e.g. conditional_progress, unconditional_final.' },
          amount: { type: 'number', description: 'The sum the waiver names, exactly as printed.' },
          dateSworn: { type: 'string', description: 'YYYY-MM-DD if legible.' },
          signaturePresent: { type: 'boolean' },
          signerName: { type: 'string' },
          notarySealPresent: { type: 'boolean' },
          notarySignaturePresent: { type: 'boolean' },
          notaryName: { type: 'string' },
          notaryId: { type: 'string' },
          commissionExpires: { type: 'string', description: 'YYYY-MM-DD if legible.' },
        },
      },
      contingency: {
        type: 'object',
        description: 'Only where the schedule shows an owner or construction contingency heading.',
        properties: {
          authorizedAmount: { type: 'number' },
          drawnToDate: { type: 'number', description: 'Sum of column G across the change-order lines beneath the heading.' },
          lineItems: { type: 'array', items: { type: 'string' } },
        },
      },
      storedMaterials: {
        type: 'object',
        description: 'A large column F entry with no bill of sale attached is a common way to pull '
          + 'money forward. Only answer where column F carries an amount.',
        properties: {
          amountBilled: { type: 'number' },
          billOfSaleAttached: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      embeddedTax: {
        type: 'object',
        description: 'For a tax-exempt owner, tax is rarely a labelled line — it is folded into a '
          + 'material cost. Name the exposure and where it could hide; do not total it.',
        properties: {
          taxLineVisible: { type: 'boolean' },
          whereItCouldHide: { type: 'string' },
          note: { type: 'string' },
        },
      },
      plausibility: {
        type: 'array',
        description: 'Lines whose progress is arithmetically fine and still questionable — a line '
          + 'jumping 5% to 85% in one month, against what the project could reasonably have '
          + 'produced. Judgment, not proof. Leave empty where nothing stands out.',
        items: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'G703 item number and description.' },
            observation: { type: 'string' },
          },
          required: ['location', 'observation'],
        },
      },
      recommendationNote: {
        type: 'string',
        description: 'Two sentences at most, written last: what drives the payment decision, in '
          + 'plain English a reader outside construction would follow. State no figure that is not '
          + 'printed on the document.',
      },
    },
    required: ['documents', 'g702Execution'],
  },
};

const asDocument = buffer => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
});

function perceptionPrompt(profile) {
  return `You are reviewing a CSP (competitive sealed proposal) construction pay application: one
prime contractor billing an owner against a stipulated sum.

Every figure on this application has ALREADY been recomputed and reconciled in code. Do not check
arithmetic, do not add anything up, and do not report a total. You are being asked only for what
cannot be calculated — what is actually on the pages.

Read the whole package before answering. In particular:

1. CLASSIFY EVERY PAGE. G702 cover sheet, G703 continuation sheets, contractor invoices, lien
   waivers, change orders, bills of sale, certified payroll. An absent lien waiver matters, so an
   absence must show as one.

2. THE G702's EXECUTION, from the page. Signatures and notary seals are images. Text extraction
   reports an executed form as blank, so judge this visually and never from a text reading.

3. THE LIEN WAIVER's notary block: the amount named, the date sworn, the commission expiry, whether
   the seal is legible and whether the notary's name matches it. Dates as YYYY-MM-DD.

4. CONTINGENCY, if the schedule carries one: the authorized amount from its heading, and what has
   been drawn against it.

5. STORED MATERIALS: whether a bill of sale is actually attached for anything in column F.

6. EMBEDDED TAX${profile?.owner_tax_exempt ? ' — THE OWNER IS TAX-EXEMPT' : ''}. Tax is rarely a
   labelled line; it is folded into material costs. Say where it could be hiding. Do not total it.

7. PLAUSIBILITY: any line whose progress this month is arithmetically fine and still looks wrong
   against what the project could have produced.
${profile ? `
THE CONTRACT'S TERMS, already extracted:
${JSON.stringify({
    contractor: profile.contractor,
    contract_sum: profile.contract_sum,
    retainage_rate: profile.retainage_rate,
    owner_tax_exempt: profile.owner_tax_exempt,
    tax_exemption_scope: profile.tax_exemption_scope,
    tax_failure_consequence: profile.tax_failure_consequence,
  }, null, 2)}
` : '\nNo contract was available. Record what you see and leave every conclusion to the report.\n'}
Where a page is too poor to read, say so. A gap you flag is recoverable; a guess presented as a
reading is not.`;
}

// --- assembling the review -----------------------------------------------------------------------

// One bad figure trips several checks: a wrong column E fails the row check, the footing check, the
// retainage check and the tie. Four findings, one cause. Findings that share a root are grouped so
// the report reads as one problem with four symptoms rather than four independent problems, which is
// the difference that matters to whoever has to act on it.
// The direction matters and is easy to get backwards. A wrong figure in a ROW is the cause; the
// column that then fails to foot is the symptom. Written the other way round on a real package,
// three misread balance cells were each labelled a consequence of the footing failure they had
// themselves produced, which points the reader at the wrong page.
const ROW_CHECK_COLUMN = { G703_ROW_G: 'G', G703_ROW_H: 'H' };

function groupByRootCause(items) {
  // Which columns have row-level failures behind them.
  const columnsWithRowFailures = new Set(
    items.filter(it => ROW_CHECK_COLUMN[it.check]).map(it => ROW_CHECK_COLUMN[it.check]),
  );

  for (const it of items) {
    if (it.check === 'G703_FOOTING') {
      const col = /column (\w)/.exec(it.message)?.[1];
      if (col && columnsWithRowFailures.has(col)) it.rootCause = `the column ${col} row errors`;
    }
    // The tie and the retainage sum both read the same totals, so a footing failure explains them.
    if ((it.check === 'RETAINAGE_ADJUSTED_SUM' || it.check === 'G702_G703_TIE')
      && items.some(o => o.check === 'G703_FOOTING')) {
      it.rootCause = 'the schedule columns not footing';
    }
  }
  return items;
}

const TITLES = {
  G702_MISSING: 'The cover sheet could not be read',
  G702_LINE3: 'The cover sheet does not add up (line 3)',
  G702_LINE5: 'The cover sheet does not add up (line 5)',
  G702_LINE6: 'The cover sheet does not add up (line 6)',
  G702_LINE8: 'The amount requested does not follow from the lines above it',
  G702_LINE9: 'The balance to finish does not add up',
  G702_G703_TIE: 'The cover sheet and the schedule disagree on the total billed',
  G702_G703_TIE_SKIPPED: 'The schedule total was not captured, so the cover sheet tie was not checked',
  G703_ROW_G: 'A schedule line does not add across',
  G703_ROW_H: 'A schedule line\'s balance does not follow from its own figures',
  G703_ROW_PCT: 'A percentage complete does not match the figures beside it',
  G703_OVERBILL: 'A line is billed above the value the contract allocates to it',
  G703_NEGATIVE_BALANCE: 'A line has been billed past completion',
  G703_NEGATIVE_PERIOD: 'A line was billed a negative amount this month',
  G703_FOOTING: 'The schedule columns do not sum to their own totals',
  G703_NO_TOTALS: 'No schedule grand total was captured',
  CREDIT_SIGN: 'A credit line is adding to the total instead of reducing it',
  CREDITS_PRESENT: 'Credit lines on this application',
  CONTINGENCY_EXCEEDED: 'More contingency has been drawn than was authorized',
  CONTINGENCY_STATUS: 'Contingency remaining',
  RETAINAGE_RATE_UNKNOWN: 'Retainage could not be verified — the contract does not state a rate',
  RETAINAGE_COMPLETED: 'Retainage on completed work is not the contract percentage',
  RETAINAGE_STORED: 'Retainage on stored material is not the contract percentage',
  RETAINAGE_EFFECTIVE_RATE: 'Total retainage is not the contract percentage of the amount billed',
  RETAINAGE_ADJUSTED_SUM: 'The schedule and the amount requested do not tie through retainage',
  RETAINAGE_EXEMPT_ITEMS: 'Some items are exempt from retainage under the contract',
  NO_PRIOR: 'No previous application was supplied',
  SEQUENCE_GAP: 'An application number appears to be missing',
  CONTINUITY_D: 'What was billed before does not match last month\'s application',
  SOV_DRIFT: 'A scheduled value changed without a change order',
  NEW_LINE_ITEM: 'A new line appeared that was not on last month\'s application',
  DROPPED_LINE_ITEM: 'A line billed last month has disappeared',
  LINE7_CONTINUITY: 'Previous payments do not match last month\'s application',
  NO_CONTRACT_PROFILE: 'No contract was available, so nothing was checked against one',
  CONTRACT_SUM_MISMATCH: 'The contract sum on the cover sheet is not the executed contract sum',
  TAX_BILLED_TO_EXEMPT_OWNER: 'Sales tax was billed to an owner that does not pay it',
  TAX_EXEMPT_OWNER: 'The owner is tax-exempt — check for tax buried in the line items',
  STORED_MATERIALS_BACKUP: 'Stored materials need a bill of sale behind them',
  G702_INCOMPLETE: 'The cover sheet has blanks the contract requires filled',
  G702_UNSIGNED: 'The cover sheet is not signed',
  G702_NOT_NOTARIZED: 'The cover sheet is not notarized',
  LIEN_WAIVER_MISSING: 'No lien waiver came with this application',
  LIEN_WAIVER_AMOUNT: 'The lien waiver does not cover the amount being paid',
  LIEN_WAIVER_UNSIGNED: 'The lien waiver is not signed',
  NOTARY_NO_SEAL: 'The notary seal is missing',
  NOTARY_UNSIGNED: 'The notary did not sign',
  NOTARY_COMMISSION_EXPIRED: 'The notary\'s commission had expired',
  NOTARY_NO_ID: 'The notary\'s ID number could not be read',
  NOTARY_DATE_UNPARSED: 'The notary dates could not be read',
  PLAUSIBILITY: 'Progress this month is worth a second look',
  EMBEDDED_TAX: 'Tax may be buried in the line items',
  DOCUMENTS: 'What was in the package',
};

function toAppFinding(item) {
  const detailParts = [item.message];
  if (item.location) detailParts.push(`Location: ${item.location}.`);
  if (isNum(item.expected) && isNum(item.found)) {
    detailParts.push(`Expected ${money(item.expected)}, found ${money(item.found)}`
      + (isNum(item.delta) ? `, a difference of ${money(item.delta)}.` : '.'));
  }
  if (item.citation) detailParts.push(`Contract: ${item.citation}`);
  if (item.rootCause) {
    detailParts.push(`This is likely a consequence of ${item.rootCause} rather than a separate problem.`);
  }

  return {
    id: item.check,
    severity: APP_SEVERITY[item.severity] || SEVERITY.NOTE,
    title: TITLES[item.check] || item.check,
    detail: detailParts.join(' '),
    expected: isNum(item.expected) ? item.expected : undefined,
    actual: isNum(item.found) ? item.found : undefined,
    difference: isNum(item.delta) ? item.delta : undefined,
    // The skill's own grade, kept so a report can print CRITICAL / HIGH / MEDIUM / LOW / INFO as
    // the skill grades them rather than only this app's three levels.
    skillSeverity: item.severity,
    check: item.check,
    location: item.location,
    citation: item.citation,
  };
}

// Lead with the decision. A reader who stops after the first sentence should still know whether to
// pay and how much.
function recommendation(counts) {
  if (counts[CRITICAL]) return 'DO NOT CERTIFY';
  if (counts[HIGH]) return 'APPROVE WITH CORRECTIONS';
  if (counts[MEDIUM]) return 'APPROVE';
  return 'APPROVE';
}

function buildHeadline({ cur, counts, rec, note }) {
  const L8 = num(cur.g702?.line8_current_payment_due);
  const app = cur.application_number;
  const parts = [];
  parts.push(`${rec}. Application ${app ?? '—'} requests ${money(L8)}`
    + (cur.period_to ? ` for the period ending ${cur.period_to}` : '') + '.');

  const tally = [
    counts[CRITICAL] && `${counts[CRITICAL]} critical`,
    counts[HIGH] && `${counts[HIGH]} high`,
    counts[MEDIUM] && `${counts[MEDIUM]} medium`,
  ].filter(Boolean);
  parts.push(tally.length
    ? `${tally.join(', ')} finding${tally.length === 1 && counts[CRITICAL] === 1 ? '' : 's'}.`
    : 'The arithmetic reconciles and nothing was found to question.');

  if (note) parts.push(note);
  return parts.join(' ');
}

async function reviewPayApp({ current, previous, contractTerms, contracts, deliveryMethod, files }) {
  const cur = toExtraction(current);
  if (!cur) return null;
  const prior = toExtraction(previous);
  const profile = toContractProfile(contractTerms, contracts);

  // The perception pass runs FIRST because two of its answers are validator inputs, not commentary:
  // the notary block decides the lien-waiver checks and the contingency heading decides the draw
  // check. Reading them after validating would leave those checks looking at nothing.
  let reading = null;
  const buffer = files?.current?.buffer;
  if (buffer) {
    const { data } = await askForJson({
      content: [asDocument(buffer), { type: 'text', text: perceptionPrompt(profile) }],
      tool: PERCEPTION_TOOL,
      maxTokens: 6000,
      label: 'payapp2 csp reading',
    });
    reading = data;
  }

  if (reading) {
    const ex = reading.g702Execution || {};
    cur.g702.contractor_signature_present = ex.contractorSignaturePresent ?? null;
    cur.g702.notarized = ex.notarized ?? null;

    // A waiver is recorded only where one was actually classified as a page of the package. The
    // schema says to omit the object when there is no waiver, and a run on a package with none
    // returned a hollow one anyway — every field false or absent. Trusting that shape produced four
    // findings about a document that does not exist, one of them CRITICAL, where the truth is the
    // single HIGH finding that no waiver was supplied. An absent document must read as absent.
    const waiverPages = (reading.documents || []).some(d => d.type === 'lien_waiver');
    const lw = reading.lienWaiver;
    if (waiverPages && lw && (isNum(lw.amount) || lw.signerName || lw.notaryName)) {
      cur.lien_waiver = {
        type: lw.type || null,
        amount: orNull(lw.amount),
        date_sworn: orNull(lw.dateSworn),
        signature_present: lw.signaturePresent ?? false,
        signer_name: orNull(lw.signerName),
        notary: {
          stamp_or_seal_present: lw.notarySealPresent ?? false,
          notary_signature_present: lw.notarySignaturePresent ?? false,
          notary_name: orNull(lw.notaryName),
          notary_id: orNull(lw.notaryId),
          commission_expires: orNull(lw.commissionExpires),
        },
      };
    }

    const c = reading.contingency;
    if (c && (isNum(c.authorizedAmount) || isNum(c.drawnToDate))) {
      cur.g703.contingency = {
        authorized_amount: orNull(c.authorizedAmount),
        drawn_to_date: orNull(c.drawnToDate),
        line_items: c.lineItems || [],
      };
    }

    // A profile field the contract read did not settle, answered from the package instead: where a
    // bill of sale is visibly absent behind a column F amount, the backup check has something to
    // say. Where nothing is stored it stays quiet.
    const sm = reading.storedMaterials;
    if (profile && sm && isNum(sm.amountBilled) && sm.amountBilled > TOL && sm.billOfSaleAttached === false) {
      profile.stored_materials_require_offsite_consent = true;
    }
  }

  const f = validate(cur, prior, profile);
  groupByRootCause(f.items);

  const findings = f.items.map(toAppFinding);

  // The judgment items the validator has no opinion about. They are NOTE severity by construction:
  // a plausibility observation is a prompt to look, not a proof, and grading it higher would put an
  // unprovable claim where a reader expects an arithmetic one.
  for (const p of reading?.plausibility || []) {
    findings.push({
      id: 'PLAUSIBILITY', severity: SEVERITY.NOTE, skillSeverity: MEDIUM, check: 'PLAUSIBILITY',
      title: TITLES.PLAUSIBILITY,
      detail: `${p.location}: ${p.observation} The arithmetic on this line is fine — this is a `
        + 'judgement about the progress it claims, worth putting to the contractor.',
      location: p.location,
    });
  }
  const et = reading?.embeddedTax;
  if (profile?.owner_tax_exempt && et?.whereItCouldHide) {
    findings.push({
      id: 'EMBEDDED_TAX', severity: SEVERITY.NOTE, skillSeverity: INFO, check: 'EMBEDDED_TAX',
      title: TITLES.EMBEDDED_TAX,
      detail: `${et.whereItCouldHide}${et.note ? ` ${et.note}` : ''} Verifying this needs backup the `
        + 'pay application does not include, so it is recorded as an exposure rather than an amount.',
    });
  }

  const counts = {
    [CRITICAL]: f.count(CRITICAL), [HIGH]: f.count(HIGH), [MEDIUM]: f.count(MEDIUM),
    [LOW]: f.count(LOW), [INFO]: f.count(INFO),
  };
  const rec = recommendation(counts);

  // What was NOT checked, stated rather than left as an inference from silence. A reader who
  // assumes retainage was verified because the report did not mention it has been misled by
  // omission, and this section is the skill's answer to that.
  const notChecked = [];
  if (!prior) {
    notChecked.push('Continuity against the previous application — no previous application was '
      + 'supplied, so re-billing and silent reversals could not be checked.');
  }
  if (!profile) {
    notChecked.push('Everything the contract governs — retainage rate, tax treatment and required '
      + 'documents — because no contract was available.');
  } else if (profile.retainage_rate === null) {
    notChecked.push('Retainage — the contract on file does not state a rate, and it was not assumed.');
  }
  if (!reading) {
    notChecked.push('Signatures, the notary block, lien waivers and contingency — the pay '
      + 'application PDF was not available, so only the extracted figures were checked.');
  }
  notChecked.push('Subcontractor billings, GC markup and contingency draws against a GMP — these '
    + 'are CMAR checks and are outside this review.');

  const critical = findings.filter(x => x.severity === SEVERITY.CRITICAL).length;
  const material = findings.filter(x => x.severity === SEVERITY.MATERIAL).length;

  return {
    findings,
    verdict: critical ? 'do-not-certify' : material ? 'certify-with-corrections' : 'no-issues-found',
    headline: buildHeadline({ cur, counts, rec, note: reading?.recommendationNote }),
    thisPeriod: num(cur.g702?.line8_current_payment_due) || null,
    deliveryMethod: deliveryMethod || null,
    subMatch: null,
    vendorRollup: null,
    tax: null,
    contracts: null,
    waivers: null,
    coverage: null,
    notChecked,
    stats: {
      // Every check the validator ran, and how many of them had nothing to say. A check that found
      // nothing is the majority of a healthy review and the number is what makes "nothing found"
      // mean something.
      checksRun: CHECK_COUNT,
      passed: Math.max(0, CHECK_COUNT - new Set(f.items.map(i => i.check)).size),
      // The route stores these two and the history badge is built from them. Omitting them binds
      // undefined into SQLite and loses the whole review after the reading has been paid for.
      critical,
      failed: critical + material,
      lineItems: (cur.g703.line_items || []).length,
      codesTied: 0,
      codesTotal: 0,
      enginesRun: reading
        ? ['G702', 'G703', 'retainage', 'continuity', 'contract', 'lien waiver', 'page reading']
        : ['G702', 'G703', 'retainage', 'continuity', 'contract', 'lien waiver'],
      enginesTotal: 7,
    },
    // The skill's own sections, carried whole for anything that wants to render the review as the
    // skill lays it out rather than as a flat finding list.
    cspReview: {
      recommendation: rec,
      amountRequested: num(cur.g702?.line8_current_payment_due),
      severityCounts: counts,
      contractProfileUsed: !!profile,
      priorApplication: prior?.application_number ?? null,
      documents: reading?.documents || [],
      taxRows: cur._tax_rows || [],
      taxBilled: cur.tax_billed,
      subtotalRowsExcluded: cur._subtotal_rows_excluded || 0,
    },
    subcontractorRows: [],
  };
}

// The number of distinct checks the validator can raise. Kept beside the check list so the two move
// together; it is only ever used to say how many checks ran.
const CHECK_COUNT = 38;

module.exports = { reviewPayApp };
