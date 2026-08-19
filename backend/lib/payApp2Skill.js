const { askForJson } = require('./aiJson');
const { SEVERITY } = require('./payAppInvariants');

// THE CSP PAY APPLICATION REVIEW, as the whole review logic for Pay App Reviewer 2.
//
// A CSP package is one prime contractor billing an owner against a stipulated sum, checked the way
// a construction auditor checks one: verify the arithmetic, tie the cover sheet to the continuation
// sheets, tie this month to last month, and check it all against what the contract actually says.
//
// THE GOVERNING PRINCIPLE: money math never happens in the model's head. Every figure below is
// recomputed in JavaScript from the transcription. A model doing mental arithmetic across ninety
// line items will be wrong occasionally and confident always, which is the worst possible failure
// mode for a document that authorizes payment. The model's job is perception and judgment.
//
// THE ORDER OF WORK, and the part that matters most:
//
//   1. Transcribe.
//   2. CROSS-CHECK THE READING against the form's own redundancy.
//   3. Re-read the cells that fail, from the page.
//   4. Only then validate.
//
// Step 2 exists because of a failure that has actually happened here. On a scanned form one misread
// digit produces a cascade of confident, wrong dollar findings, and nothing downstream can tell
// "the contractor made an error" from "we misread the page". A single scheduled value read as
// 65,000 instead of 85,000 produced three findings — a wrong balance to finish, a wrong percent
// complete, and a column total off by 20,000 — none of which were errors by anyone. Reporting a
// misreading as a finding destroys trust in the whole review faster than missing one does.
//
// A figure the cross-check cannot corroborate and the re-read cannot settle is NOT a finding. It is
// reported as unverified. A gap named is recoverable; a wrong dollar delta stated with confidence
// is not.
//
// WHAT IS NOT CHECKED HERE. Subcontractor schedules of values, subcontractor invoices and their
// backup, GC markup, and contingency draws against a GMP are CMAR concerns and are deliberately
// absent. A CMAR package run through this gets an honest CSP review of its prime application and
// says nothing about its subs — which is better than a half-answer that reads like a whole one.

// --- the skill's severities, and how they reach a report that has three ------------------------
//
// The skill grades CRITICAL / HIGH / MEDIUM / LOW / INFO. This app's report has three levels. The
// mapping reproduces the skill's own recommendation thresholds, where any CRITICAL means DO NOT
// CERTIFY and HIGH alone means APPROVE WITH CORRECTIONS. The skill's grade travels with the finding
// so the report can still print it.
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

// Dollar tolerance. Cent-level rounding is acceptable; anything larger is a finding. Retainage and
// the adjusted sum get looser tolerances because they compound rounding across every line.
const TOL = 0.01;
const RET_TOL = 0.02;
const SUM_TOL = 0.05;

// Cross-check tolerances. Exact-arithmetic derivations (G+H, D+E+F, C-H) must agree to the cent;
// percent-derived values carry the rounding of a figure printed to the nearest whole percent.
const XC_ABS_TOL = 0.01;
const XC_REL_TOL = 0.006;

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
// The cross-checker needs "absent" to stay absent rather than becoming zero, because a derivation
// built from a missing cell is not evidence about anything.
function maybe(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
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

// Where a finding sits, said once. A schedule whose item numbers ARE descriptions ("GMP 2 Work
// Remaining to be Procured") otherwise prints the same phrase twice with a dash between it.
function rowLocation(row) {
  const itemNo = String(row.item_no ?? '').trim();
  const desc = String(row.description || '').trim().slice(0, 60);
  if (!itemNo) return desc ? `Schedule line — ${desc}` : 'Schedule line';
  if (!desc || desc.toLowerCase() === itemNo.toLowerCase()) return `Schedule line ${itemNo}`;
  return `Schedule line ${itemNo} — ${desc}`;
}

// ================================================================================================
// STEP 2 — THE CROSS-CHECK. Does the reading agree with itself?
// ================================================================================================
//
// A G703 carries the same information several times over:
//
//   C can be derived from   stated | G + H | G / (pct/100)
//   G can be derived from   stated | D + E + F | C - H | retainage / rate
//   every column total      from   the sum of its own rows
//   the column C total      from   the contract sum
//
// When two INDEPENDENT derivations agree with each other and disagree with what was transcribed,
// the transcription is very likely wrong. That cell is flagged for a targeted re-read rather than
// reported as a finding.

const xcAgree = (a, b, rel = false) => {
  if (a === null || b === null) return false;
  if (rel) return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * XC_REL_TOL;
  return Math.abs(a - b) <= XC_ABS_TOL;
};

// Returns the value two or more derivations agree on, when that value contradicts what was read.
// Two agreeing derivations outvote one transcription; a single derivation proves nothing, because
// it could as easily be built on the misread cell itself.
function vote(stated, candidates) {
  const usable = candidates.filter(c => c.value !== null);
  if (usable.length < 2) return null;

  for (const a of usable) {
    const agreeing = usable.filter(b => b !== a && xcAgree(a.value, b.value, a.rel || b.rel));
    if (!agreeing.length) continue;
    if (stated === null || !xcAgree(a.value, stated, a.rel)) {
      return { consensus: a.value, sources: [a.source, ...agreeing.map(b => b.source)] };
    }
  }
  return null;
}

function crossCheck(cur, profile) {
  const rate = profile ? profile.retainage_rate : null;
  const suspects = [];
  const flag = (location, cell, stated, consensus, note) => {
    suspects.push({ location, cell, stated, consensus: round2(consensus), note });
  };

  for (const row of cur.g703?.line_items || []) {
    const loc = rowLocation(row);
    const C = maybe(row.scheduled_value);
    const D = maybe(row.prior_completed);
    const E = maybe(row.this_period);
    const F = maybe(row.materials_stored);
    const G = maybe(row.total_to_date);
    const H = maybe(row.balance_to_finish);
    const P = maybe(row.pct_complete);
    const R = maybe(row.retainage);

    const cForC = [];
    if (G !== null && H !== null) cForC.push({ source: 'G+H', value: G + H, rel: false });
    if (G !== null && P !== null && P !== 0) cForC.push({ source: 'G/pct', value: G / (P / 100), rel: true });
    const cVote = vote(C, cForC);
    if (cVote) {
      flag(loc, 'scheduled value', C, cVote.consensus,
        `${cVote.sources.join(' and ')} both indicate ${money(cVote.consensus)}.`);
    }

    const cForG = [];
    if (D !== null || E !== null || F !== null) {
      cForG.push({ source: 'D+E+F', value: (D || 0) + (E || 0) + (F || 0), rel: false });
    }
    if (C !== null && H !== null) cForG.push({ source: 'C-H', value: C - H, rel: false });
    if (R !== null && rate) cForG.push({ source: 'retainage/rate', value: R / rate, rel: false });
    const gVote = vote(G, cForG);
    if (gVote) {
      flag(loc, 'total completed to date', G, gVote.consensus,
        `${gVote.sources.join(' and ')} both indicate ${money(gVote.consensus)}.`);
    }
  }

  // The totals row is a single line every downstream figure depends on, so a misreading there does
  // far more damage than a misreading in one row.
  const rows = cur.g703?.line_items || [];
  const totals = cur.g703?.totals || {};
  const COLUMNS = [
    ['scheduled_value', 'scheduled value'], ['prior_completed', 'previously completed'],
    ['this_period', 'completed this period'], ['materials_stored', 'materials stored'],
    ['total_to_date', 'total completed to date'], ['balance_to_finish', 'balance to finish'],
  ];
  for (const [key, label] of COLUMNS) {
    const stated = maybe(totals[key]);
    if (stated === null) continue;
    const vals = rows.map(r => maybe(r[key]));
    if (vals.every(v => v === null)) continue;
    const computed = vals.reduce((s, v) => s + (v || 0), 0);
    if (!xcAgree(stated, computed)) {
      flag('Schedule grand total row', label, stated, computed,
        `The ${rows.length} line items sum to ${money(computed)}. Re-read the total row and `
        + 'confirm no line was missed.');
    }
  }

  // An independent anchor that owes nothing to the schedule: column C should be the contract sum
  // to date.
  const statedC = maybe(totals.scheduled_value);
  const contractSum = profile ? profile.contract_sum : null;
  if (isNum(contractSum) && statedC !== null) {
    const expected = contractSum + num(cur.g702?.line2_net_change_orders);
    if (!xcAgree(statedC, expected)) {
      flag('Schedule grand total row', 'scheduled value against the contract', statedC, expected,
        'Column C must equal the contract sum to date. A mismatch means either a misreading or a '
        + 'change order that is not on the form.');
    }
  }

  const L4 = maybe(cur.g702?.line4_total_completed_stored);
  if (L4 !== null && rows.length) {
    const vals = rows.map(r => maybe(r.total_to_date));
    if (!vals.every(v => v === null)) {
      const computed = vals.reduce((s, v) => s + (v || 0), 0);
      if (!xcAgree(L4, computed)) {
        flag('Cover sheet line 4', 'total completed and stored', L4, computed,
          'Line 4 should equal the column G total. Re-read both before treating this as a '
          + "contractor's error.");
      }
    }
  }

  return suspects;
}

// --- G703 row-level ----------------------------------------------------------------------------

function checkG703Rows(cur, f) {
  for (const row of cur.g703?.line_items || []) {
    const loc = rowLocation(row);
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

    // Overbilling reconciles at the total level — the erroneous figure flows consistently into
    // every total, so the footing, the tie and the retainage sum all still pass. Only the row sees
    // it.
    //
    // A negative balance to finish is THE SAME FACT stated a second way, so it is only reported
    // when the overbill check did not already fire. Two findings for one problem makes a report
    // harder to act on, not more thorough.
    const overbilled = !isCredit && G - C > TOL;
    if (overbilled) {
      const pct = Math.abs(C) > TOL ? (G / C * 100).toFixed(1) : '0.0';
      f.add(CRITICAL, 'G703_OVERBILL',
        `Billed to date exceeds the scheduled value for this line (${pct}% complete). `
        + `Balance to finish is ${money(H)}.`,
        { expected: C, found: G, delta: G - C, location: loc });
    } else if (!isCredit && present(row.balance_to_finish) && H < -TOL) {
      f.add(CRITICAL, 'G703_NEGATIVE_BALANCE',
        'Balance to finish is negative — this line is billed past completion.',
        { found: H, location: loc });
    }

    // Credits carry negative scheduled values legitimately, so sign checks skip C < 0. A negative
    // in column E on a POSITIVE line means a prior over-billing is being reversed.
    if (E < -TOL && !isCredit) {
      f.add(MEDIUM, 'G703_NEGATIVE_PERIOD',
        'Negative amount billed this period on a non-credit line. Confirm this is an intentional correction.',
        { found: E, location: loc });
    }
  }
}

// --- has the reading put the columns in the right fields? ----------------------------------------
//
// Continuation sheets do not agree on column order. One layout prints "% (G / C)" then "Balance to
// Finish (C - G)"; another prints them the other way round. A reading that maps by position rather
// than by header text transposes the two on the second kind, and NOTHING ELSE HERE CATCHES IT.
//
// The cross-check can't: it derives the scheduled value from G+H and from G/pct, and with the two
// swapped both derivations are nonsense, so they disagree with each other, no consensus forms, and
// no cell is ever flagged. The row checks can't either — they just fail on every line at once and
// blame the contractor for it.
//
// So this is checked directly, on what the figures LOOK like. A percent-complete column holds
// numbers between roughly zero and a hundred; a balance-to-finish column holds dollars. When the
// percentages are in the thousands and the balances are all under a hundred, across most of a
// schedule, the two columns have been read the wrong way round.
//
// Deliberately hard to trigger: a real schedule can carry a nearly-finished line with $50 left on
// it, so this needs a sample and a strong majority before it will say anything.
const MIN_ROWS_TO_JUDGE = 5;
const LOOKS_LIKE_MONEY = 200;   // a percent complete never runs to the hundreds
const LOOKS_LIKE_PERCENT = 100; // a balance to finish rarely sits under a hundred dollars

function transposedRows(cur) {
  const rows = (cur.g703?.line_items || [])
    .filter(r => present(r.pct_complete) && present(r.balance_to_finish));
  if (rows.length < MIN_ROWS_TO_JUDGE) return null;
  const swapped = rows.filter(r => num(r.pct_complete) > LOOKS_LIKE_MONEY
    && Math.abs(num(r.balance_to_finish)) <= LOOKS_LIKE_PERCENT);
  return swapped.length >= rows.length * 0.6 ? { swapped: swapped.length, of: rows.length } : null;
}

function checkColumnOrientation(cur, f) {
  const t = transposedRows(cur);
  if (!t) return;
  f.add(HIGH, 'COLUMNS_TRANSPOSED',
    `On ${t.swapped} of ${t.of} schedule lines the percent-complete column holds what looks like a `
    + 'dollar amount and the balance-to-finish column holds what looks like a percentage. These two '
    + 'columns appear to have been read the wrong way round — on this form the balance to finish '
    + 'sits to the right of the percentage. Nothing below can be relied on until the reading is '
    + 'corrected; this is a fault in the reading, not a finding about the contractor.',
    { location: 'Schedule column headers' });
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
  for (const [key, col] of FOOTING_COLUMNS) {
    if (!present(totals[key])) continue;
    const stated = num(totals[key]);
    const computed = rows.reduce((s, r) => s + num(r[key]), 0);
    if (!close(stated, computed)) {
      f.add(HIGH, 'G703_FOOTING', `Column ${col} rows do not sum to the stated total.`,
        { expected: computed, found: stated, delta: stated - computed, location: `Schedule column ${col} total` });
    }
  }
}

// --- contingency and credits -------------------------------------------------------------------

function checkContingencyAndCredits(cur, f) {
  const rows = cur.g703?.line_items || [];
  const credits = rows.filter(r => num(r.scheduled_value) < 0);

  for (const r of credits) {
    const C = num(r.scheduled_value);
    const G = num(r.total_to_date);
    if (G > TOL) {
      f.add(HIGH, 'CREDIT_SIGN',
        'Credit line carries a positive amount in column G. Credits must reduce the total, not add to it.',
        { expected: C, found: G, location: rowLocation(r) });
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
        { expected: authorized, found: drawn, delta: drawn - authorized, location: 'Contingency on the schedule' });
    } else if (authorized) {
      f.add(INFO, 'CONTINGENCY_STATUS',
        `Contingency: ${money(drawn)} drawn of ${money(authorized)} authorized (${money(authorized - drawn)} remaining).`);
    }
  }
}

// --- G702 internal -----------------------------------------------------------------------------

// Line 9 is checked against Line 3 − Line 6, so it INCLUDES retainage. It will not equal the G703
// column H total, which excludes it. The two differing by exactly the retainage amount is correct.
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
        { expected: exp, found: got, delta: got - exp, location: `Cover sheet ${key.replace('line', 'line ')}` });
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
      { expected: G, found: L4, delta: L4 - G, location: 'Cover sheet line 4 against the schedule total' });
  }
}

// --- retainage ---------------------------------------------------------------------------------

// The single most error-prone figure on the form.
//
// NO RATE, NO CHECK. Where the contract profile has no retainage rate this reports that retainage
// could not be verified and stops. It does not fall back to 5% — an assumed rate produces
// confident, wrong findings on every application for the life of the project.
//
// The check anchors to LINE 4, which is the retainage basis printed on the form. Rebuilding that
// basis by re-adding the D and E totals only inherits any error in those totals, and then a single
// schedule mistake resurfaces here as a phantom retainage discrepancy. Line 4 is separately tied to
// the column G total, so an error there still surfaces — once, in the right place.
function checkRetainage(cur, profile, f) {
  const g = cur.g702 || {};
  const totals = cur.g703?.totals || {};

  const rate = profile ? profile.retainage_rate : null;
  if (rate === null || rate === undefined) {
    f.add(HIGH, 'RETAINAGE_RATE_UNKNOWN',
      'No retainage rate available from the contract profile. Retainage cannot be verified — do not assume 5%.',
      { citation: 'contract profile: retainage_rate' });
    return;
  }

  const cite = profile.citations?.retainage_rate;
  const ratePct = `${+(rate * 100).toFixed(4)}%`;
  const L4 = num(g.line4_total_completed_stored);
  const L5 = num(g.line5_total_retainage);
  const L5a = num(g.line5a_retainage_completed_work);
  const L5b = num(g.line5b_retainage_stored_material);

  let basis = L4;
  let basisLabel = 'Line 4';
  if (!present(g.line4_total_completed_stored)) {
    basis = num(totals.total_to_date);
    basisLabel = 'the column G total';
    if (!present(totals.total_to_date)) {
      f.add(MEDIUM, 'RETAINAGE_NO_BASIS',
        'Neither Line 4 nor the column G total was captured; retainage could not be verified.');
      return;
    }
  }

  const statedTotal = present(g.line5_total_retainage) ? L5
    : (present(g.line5a_retainage_completed_work) ? L5a : null);

  // A final application releasing retainage shows Line 6 equal to Line 4 with nothing withheld.
  // That is correct behaviour, not a shortfall, so the rate check does not apply to it.
  const L6 = num(g.line6_total_earned_less_retainage);
  const releasing = present(g.line6_total_earned_less_retainage)
    && basis > TOL && close(L6, basis, RET_TOL) && Math.abs(L5) <= TOL;

  if (statedTotal !== null && basis > TOL && !releasing) {
    const exp = basis * rate;
    if (!close(statedTotal, exp, RET_TOL)) {
      const eff = statedTotal / basis;
      f.add(CRITICAL, 'RETAINAGE_AMOUNT',
        `Retainage is ${(eff * 100).toFixed(2)}% of ${basisLabel} (${money(basis)}); the contract `
        + `specifies ${ratePct}.`,
        { expected: exp, found: statedTotal, delta: statedTotal - exp, location: 'Cover sheet line 5', citation: cite });
    }
  }

  // Only check the 5a/5b split when both are stated as actual figures. Many forms write "included
  // in above" against 5b, in which case 5a legitimately covers the whole basis and a separate check
  // would be a false positive.
  if (present(g.line5a_retainage_completed_work) && present(g.line5b_retainage_stored_material)
    && present(g.line5_total_retainage) && !close(L5a + L5b, L5, RET_TOL)) {
    f.add(HIGH, 'RETAINAGE_SPLIT', 'Line 5a plus Line 5b does not equal Line 5.',
      { expected: L5a + L5b, found: L5, delta: L5 - (L5a + L5b), location: 'Cover sheet line 5', citation: cite });
  }

  const exempt = profile.retainage_exempt_items || [];
  if (exempt.length) {
    f.add(INFO, 'RETAINAGE_EXEMPT_ITEMS',
      `Contract exempts these from retainage: ${exempt.join(', ')}. Verify they were excluded from the retainage basis.`,
      { citation: cite });
  }
}

// Each line's period billing net of retainage should sum to Line 8 — the tie between the schedule
// and the cash actually requested, and the check that catches a line moving without the cover sheet
// following.
function checkRetainageAdjustedSum(cur, profile, f) {
  const rate = profile ? profile.retainage_rate : null;
  if (rate === null || rate === undefined) return;
  const rows = cur.g703?.line_items || [];
  if (!rows.length) return;
  if (!present(cur.g702?.line8_current_payment_due)) return;

  const period = rows.reduce((s, r) => s + num(r.this_period), 0);
  const L8 = num(cur.g702.line8_current_payment_due);
  const L4 = num(cur.g702.line4_total_completed_stored);
  const L6 = num(cur.g702.line6_total_earned_less_retainage);

  // A final or retainage-release application bills no new work: column E is empty and the payment
  // IS the retainage coming back. Comparing zero against Line 8 there would flag the entire payment
  // as a discrepancy.
  if (Math.abs(period) <= TOL) {
    if (L8 > TOL) {
      f.add(INFO, 'RETAINAGE_RELEASE',
        `No new work was billed this period, so the ${money(L8)} requested appears to be released `
        + 'retainage. Confirm the release is authorized — typically at substantial completion.');
    }
    return;
  }
  if (L4 > TOL && close(L4, L6, RET_TOL)) {
    f.add(INFO, 'RETAINAGE_RELEASE',
      'Line 6 equals Line 4, so no retainage is being withheld. This is expected on a final '
      + 'application releasing retainage.');
  }

  const periodNet = period * (1 - rate);
  if (!close(periodNet, L8, SUM_TOL)) {
    f.add(HIGH, 'RETAINAGE_ADJUSTED_SUM',
      `Sum of this-period billings x ${(1 - rate).toFixed(2)} does not equal Line 8. This usually `
      + 'means a line moved without the cover sheet following, or retainage was applied unevenly.',
      { expected: periodNet, found: L8, delta: L8 - periodNet, location: 'Schedule column E against cover sheet line 8' });
  }
}

// --- pay-app-to-pay-app continuity ---------------------------------------------------------------

const rowKey = row => String(row.item_no ?? '').trim()
  || String(row.description ?? '').trim().toLowerCase();

// Column D is definitionally what was billed through the previous application, so it must equal the
// prior application's column G on every line. A mismatch means work was re-billed, silently
// reversed, or the schedule shifted underneath.
//
// THREE STATES, NOT ONE. "No prior application", "a prior application was supplied but nothing came
// out of it", and "it was read but has no schedule" look identical to a truthiness test and mean
// completely different things to the reader. Telling someone their file was not supplied when they
// supplied it is worse than saying nothing: it sends them looking in the wrong place, and it hides
// a pipeline fault behind a sentence that reads like a fact about their paperwork.
function checkContinuity(cur, prior, f, { supplied = false } = {}) {
  if (!prior) {
    if (supplied) {
      f.add(HIGH, 'PRIOR_EMPTY',
        'A previous pay application was supplied but nothing could be read from it, so continuity '
        + 'was NOT checked. This is a fault in the reading, not a finding about the contractor.');
    } else {
      f.add(INFO, 'NO_PRIOR', 'No prior pay application supplied; continuity checks skipped.');
    }
    return;
  }

  if (!(prior.g703?.line_items || []).length) {
    f.add(HIGH, 'PRIOR_NO_SCHEDULE',
      'The previous pay application was supplied and read, but no schedule lines came out of it, so '
      + 'continuity was NOT checked. Re-read the previous application before relying on this review.');
    return;
  }

  const curN = cur.application_number;
  const priN = prior.application_number;
  if (isNum(curN) && isNum(priN) && curN !== priN + 1) {
    f.add(MEDIUM, 'SEQUENCE_GAP',
      `Application #${curN} follows #${priN}; expected consecutive numbering. Continuity across a `
      + 'gap is weaker evidence — confirm no intervening application is missing.');
  }

  const priRows = new Map();
  for (const r of prior.g703?.line_items || []) priRows.set(rowKey(r), r);
  const curRows = cur.g703?.line_items || [];

  for (const r of curRows) {
    const loc = rowLocation(r);
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
        { expected: num(p.total_to_date), location: `Last month's ${rowLocation(p)}` });
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
      { expected: pL6, found: L7, delta: L7 - pL6, location: 'Cover sheet line 7' });
  }
}

// --- contract-derived ----------------------------------------------------------------------------

function checkContractTerms(cur, profile, f) {
  if (!profile) {
    f.add(HIGH, 'NO_CONTRACT_PROFILE',
      'No contract profile supplied. Retainage rate, tax treatment and required documents could not '
      + 'be verified against the contract.');
    return;
  }

  const cs = profile.contract_sum;
  if (cs !== null && cs !== undefined && present(cur.g702?.line1_original_contract_sum)) {
    const L1 = num(cur.g702.line1_original_contract_sum);
    if (!close(num(cs), L1)) {
      f.add(CRITICAL, 'CONTRACT_SUM_MISMATCH', 'G702 Line 1 does not match the executed contract sum.',
        { expected: num(cs), found: L1, delta: L1 - num(cs), location: 'Cover sheet line 1',
          citation: profile.citations?.contract_sum });
    }
  }

  // Public owners are typically exempt from sales and use tax, and the exemption usually extends to
  // RENTAL AND LEASE of equipment, not just purchase. Contracts commonly add that a contractor who
  // fails to use the exemption certificate absorbs the tax without reimbursement — so tax billed to
  // an exempt owner is non-reimbursable regardless of whether the contractor actually paid it.
  //
  // CITE THE CLAUSE, NOT THE INFERENCE. Whether an owner is exempt can be guessed from its name —
  // a school district, a city — and that guess tells you nothing about the billing rule. Without
  // the clause, the honest report is "we did not find it", which is actionable. The alternative,
  // "confirm no tax is embedded, including on rented equipment", is a worry dressed as a finding,
  // and it implies the contract was read and found ambiguous when it was never read at all.
  if (profile.owner_tax_exempt) {
    const tax = cur.tax_billed;
    const cite = profile.citations?.owner_tax_exempt;
    const rule = profile.tax_rule_summary;
    if (tax && num(tax) > TOL) {
      f.add(CRITICAL, 'TAX_BILLED_TO_EXEMPT_OWNER',
        `Sales/use tax of ${money(num(tax))} is billed to a tax-exempt owner. Not reimbursable — the `
        + 'contractor absorbs tax it failed to avoid with the exemption certificate.',
        { expected: 0, found: num(tax), delta: num(tax), location: 'tax line', citation: cite });
    } else if (!cite) {
      f.add(MEDIUM, 'TAX_CLAUSE_NOT_LOCATED',
        "Owner is tax-exempt, but the contract's tax clause was not located, so the billing rule is "
        + 'unverified. Locate it before relying on this review for tax.');
    } else {
      // The title already says no tax is billed, so the message is the RULE and nothing else —
      // repeating the fact in both halves wastes the one sentence a reader is most likely to read.
      f.add(INFO, 'TAX_EXEMPT_OWNER', rule || 'Tax is not reimbursable by this owner.',
        { citation: cite });
    }
  }

  if (profile.stored_materials_require_offsite_consent) {
    const stored = num(cur.g703?.totals?.materials_stored);
    if (stored > TOL) {
      f.add(MEDIUM, 'STORED_MATERIALS_BACKUP',
        `${money(stored)} billed as stored materials. Contract requires bills of sale and, for `
        + 'off-site storage, written Owner and Surety consent plus a bonded warehouse.',
        { citation: profile.citations?.stored_materials });
    }
  }
}

function checkG702Completeness(cur, profile, f) {
  if (!profile?.g702_all_blanks_required) return;
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
      { citation: profile.citations?.g702_requirements });
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
// If it is below Line 8, the owner pays more than it is released against. An expired commission
// voids the notarization, and with it the waiver's enforceability.
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
    f.add(HIGH, 'LIEN_WAIVER_UNSIGNED', "Lien waiver is not signed by the contractor's representative.");
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

function validate(cur, prior, profile, { priorSupplied = false } = {}) {
  const f = new Findings();
  // First, because if the columns went into the wrong fields then every check after this is
  // measuring the wrong figures and the report needs to say so once rather than fail on every line.
  checkColumnOrientation(cur, f);
  checkG702Internal(cur, f);
  checkG702ToG703(cur, f);
  checkG703Rows(cur, f);
  checkG703Footing(cur, f);
  checkContingencyAndCredits(cur, f);
  checkRetainage(cur, profile, f);
  checkRetainageAdjustedSum(cur, profile, f);
  checkContinuity(cur, prior, f, { supplied: priorSupplied });
  checkLine7(cur, prior, f);
  checkContractTerms(cur, profile, f);
  checkG702Completeness(cur, profile, f);
  checkLienWaiver(cur, f);
  return f;
}

// --- transcription: this app's extraction, in the skill's schema ---------------------------------
//
// The skill transcribes the G702 and G703 into its own schema by reading the pages. This module is
// handed an extraction the app has already made, so it maps that across.
//
// The one thing the mapping must not lose is BLANK versus ZERO. The validator skips checks on null
// and runs them on 0, so flattening a blank cell to zero invents findings about figures nobody
// wrote down.
const orNull = v => (v === undefined || v === '' ? null : v ?? null);

// A grouped schedule prints its own group totals as rows. The skill's transcription rule is that
// per-page and per-group subtotals are skipped and only the grand total is captured — without which
// every column sums to roughly twice its stated total and the footing findings are all false.
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

  // Only an identifiable tax amount belongs here. Where the extraction listed taxed invoices, their
  // sum IS identifiable and is totalled in code — the model never adds it up.
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
      // Filled in from the page by the reading pass. A signature and a seal are images; the text
      // layer reports an executed form as blank, so these must never be read from it.
      contractor_signature_present: null,
      notarized: null,
    },
    g703: { line_items: lineItems, totals, contingency: null },
    lien_waiver: null,
  };
}

// --- the contract profile ------------------------------------------------------------------------
//
// RECORD A FIELD AS NULL WHEN IT IS NOT THERE. Never default a missing retainage rate to 5%.
function toContractProfile(contractTerms, contracts) {
  if (!contractTerms) return null;
  const t = contractTerms;
  const primary = (contracts || []).find(c => c.isPrimary) || (contracts || [])[0] || null;

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
    // The operative rule in a sentence, carried verbatim so it can be quoted straight into a
    // report. It comes from the CLAUSE — the contract term about taxes — and from nowhere else.
    tax_rule_summary: taxItem?.basis || null,
    stored_materials_require_offsite_consent: null,
    g702_all_blanks_required: null,
    citations: {
      contract_sum: primary?.label ? `${primary.label} (contract on file)` : null,
      retainage_rate: null,
      // ONLY the tax clause counts as a citation here. `taxExemptBasis` is how the contract read
      // concluded the owner is exempt, and on a real agreement it came back as "Owner is Aldine
      // Independent School District … per Section 1.1.8 and signature block" — an inference from
      // who the owner is, which says nothing about the billing rule. Accepting it as the citation
      // made the review look as though it had read a tax clause it had never found, and made the
      // "clause not located" finding unreachable.
      owner_tax_exempt: taxItem?.basis || null,
      stored_materials: null,
      g702_requirements: null,
    },
    unallowable_items: t.unallowableItems || [],
    confirmed_by: null,
  };
}

// --- the one pass over the pages -------------------------------------------------------------
//
// Two jobs in a single call, because both need the pages and neither needs the other's answer:
//
//   THE RE-READ. The cross-check has already named the cells whose transcription contradicts the
//   form's own arithmetic. This reads those specific cells off the page again. Targeted, not a
//   re-extraction: only what was flagged.
//
//   THE PERCEPTION. Signatures, seals, the notary block, contingency headings, stored-material
//   backup, where tax could be hiding, and which lines a PM should walk the job to confirm.
const READING_TOOL = {
  name: 'record_payapp_reading',
  input_schema: {
    type: 'object',
    properties: {
      cellReadings: {
        type: 'array',
        description: 'One entry for EVERY cell listed in the re-read request, in the same order. '
          + 'Find the cell on the page and read what is printed there. Do not calculate it, do not '
          + 'reconcile it against anything, and do not copy the value the request says was '
          + 'transcribed — the whole point is an independent second reading. Where the cell is '
          + 'genuinely illegible or you cannot locate it, say so and leave the value out.',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The exact reference string from the request.' },
            page: { type: 'number', description: 'Page the cell was found on.' },
            valueOnPage: { type: 'number', description: 'What is printed in that cell. Omit if illegible.' },
            legible: { type: 'boolean' },
            note: { type: 'string', description: 'Only if something about the cell needs saying.' },
          },
          required: ['ref', 'legible'],
        },
      },
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
          contractorSignaturePresent: { type: 'boolean' },
          notarized: { type: 'boolean', description: 'A notary block completed AND sealed.' },
          allBlanksCompleted: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['contractorSignaturePresent', 'notarized'],
      },
      lienWaiver: {
        type: 'object',
        description: 'Omit entirely if no lien waiver is in the package — do not invent an empty one.',
        properties: {
          type: { type: 'string' },
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
          drawnToDate: { type: 'number' },
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
        },
      },
      progressToVerify: {
        type: 'array',
        description: 'Lines a PM should walk the job and confirm: the percentage moved sharply, a '
          + 'trade appears out of sequence, or a large amount is claimed in one period. THESE ARE '
          + 'NOT FINDINGS and must never be written as though they were — the arithmetic on them is '
          + 'fine, which is exactly why they belong on a checklist someone carries round a site '
          + 'rather than in a list someone adjudicates at a desk. One line each, no speculation.',
        items: {
          type: 'object',
          properties: {
            itemNo: { type: 'string' },
            description: { type: 'string', description: 'The line as printed on the schedule.' },
            claimedPct: { type: 'number' },
            thisPeriod: { type: 'number' },
            why: { type: 'string', description: 'At most one short clause on why it is on the list.' },
          },
          required: ['description'],
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

// Each cell gets a short opaque tag rather than a descriptive sentence. The first version asked the
// model to echo back "1. Schedule line 4 — General Conditions → scheduled value", and it came back
// worded differently every time, so nothing matched and every re-read was silently lost — the run
// reported three cells as "not re-read" while the model had in fact looked at the pages. A tag of
// four characters can be echoed exactly.
const suspectTag = i => `C${i + 1}`;

function rereadRequest(suspects) {
  if (!suspects.length) return 'No cells need re-reading. Return an empty cellReadings array.';
  const lines = suspects.map((s, i) => (
    `[${suspectTag(i)}] ${s.location} — the "${s.cell}" cell\n`
    + `    transcribed as ${money(s.stated)}; the form's own arithmetic indicates `
    + `${money(s.consensus)}. ${s.note}`
  ));
  return 'FIND EACH CELL BY ITS COLUMN HEADER, not by counting columns across the row. Continuation '
    + 'sheets do not agree on column order — some print the percentage before the balance to finish '
    + 'and some after — so locate the header that matches the cell named below and read the figure '
    + 'underneath it. A figure read from the neighbouring column looks perfectly plausible and is '
    + 'the one mistake this step exists to prevent.\n\n'
    + 'RE-READ THESE CELLS FIRST. Each disagrees with what the rest of the form says it should '
    + 'be, which means EITHER the transcription is wrong OR the form is inconsistent. Only a second '
    + 'reading of the page can tell those apart, and every finding below depends on knowing which '
    + 'it is.\n\nReturn one cellReadings entry per cell, with "ref" set to the bracketed tag '
    + `exactly as written (${suspects.map((_, i) => suspectTag(i)).join(', ')}) and "valueOnPage" `
    + 'set to what is actually printed in that cell.\n\n' + lines.join('\n\n');
}

function readingPrompt(profile, suspects) {
  return `You are reading a CSP (competitive sealed proposal) construction pay application: one
prime contractor billing an owner against a stipulated sum.

Every figure on this application has ALREADY been recomputed in code. Do not check arithmetic, do
not add anything up, and do not report a total. You are being asked for two things only: a second
reading of specific cells, and what cannot be calculated at all.

${rereadRequest(suspects)}

THEN, from the whole package:

1. CLASSIFY EVERY PAGE — G702, G703, contractor invoices, lien waivers, change orders, bills of
   sale, certified payroll. An absent lien waiver matters, so an absence must show as one.

2. THE G702's EXECUTION, from the page. Signatures and notary seals are images. Text extraction
   reports an executed form as blank, so judge this visually and never from a text reading.

3. THE LIEN WAIVER's notary block: the amount named, the date sworn, the commission expiry, whether
   the seal is legible and whether the notary's name matches it. Dates as YYYY-MM-DD.

4. CONTINGENCY, if the schedule carries one: the authorized amount from its heading, and what has
   been drawn against it.

5. STORED MATERIALS: whether a bill of sale is actually attached for anything in column F.

6. EMBEDDED TAX${profile?.owner_tax_exempt ? ' — THE OWNER IS TAX-EXEMPT' : ''}. Tax is rarely a
   labelled line; it is folded into material costs. Say where it could be hiding. Do not total it.

7. PROGRESS TO VERIFY ON SITE — lines whose progress this month deserves someone walking the job.
   One line each. These are not findings and must not read like accusations.
${profile ? `
THE CONTRACT'S TERMS, already extracted:
${JSON.stringify({
    contractor: profile.contractor,
    contract_sum: profile.contract_sum,
    retainage_rate: profile.retainage_rate,
    owner_tax_exempt: profile.owner_tax_exempt,
    tax_exemption_scope: profile.tax_exemption_scope,
    tax_rule_summary: profile.tax_rule_summary,
  }, null, 2)}
` : '\nNo contract was available. Record what you see and leave every conclusion to the report.\n'}
Where a page is too poor to read, say so. A gap you flag is recoverable; a guess presented as a
reading is not.`;
}

// Applies a confirmed re-read back onto the extraction. Returns what was actually changed, because
// a reader who learns later that a figure was silently amended will not trust the next report.
const CELL_FIELD = {
  'scheduled value': 'scheduled_value',
  'total completed to date': 'total_to_date',
  'previously completed': 'prior_completed',
  'completed this period': 'this_period',
  'materials stored': 'materials_stored',
  'balance to finish': 'balance_to_finish',
  'total completed and stored': 'line4_total_completed_stored',
};

function applyRereads(cur, suspects, readings) {
  // Matching is deliberately forgiving about the brackets and the case, and about nothing else. A
  // tag that cannot be resolved leaves the cell unverified, which is the safe direction: an
  // unmatched reading loses a correction, while a mismatched one would apply a figure read off a
  // different cell.
  const byRef = new Map();
  for (const r of readings || []) {
    const key = String(r.ref || '').replace(/[[\]\s.]/g, '').toUpperCase();
    if (key) byRef.set(key, r);
  }
  const corrections = [];
  const unverified = [];

  suspects.forEach((s, i) => {
    const read = byRef.get(suspectTag(i)) || null;
    const field = CELL_FIELD[s.cell];

    if (!read || read.legible === false || !isNum(read.valueOnPage) || !field) {
      unverified.push({ ...s, reason: read ? 'the cell could not be read from the page' : 'the cell was not re-read' });
      return;
    }
    if (close(read.valueOnPage, s.stated, 0.01)) {
      // The re-read confirms the transcription, so the form itself is inconsistent. That is a
      // genuine finding rather than a reading problem, and the checks below will surface it.
      return;
    }

    let target = null;
    if (s.location === 'Cover sheet line 4') target = cur.g702;
    else if (s.location === 'Schedule grand total row') target = cur.g703.totals;
    else target = (cur.g703.line_items || []).find(r => rowLocation(r) === s.location) || null;
    if (!target) { unverified.push({ ...s, reason: 'the cell could not be located to correct' }); return; }

    const before = target[field];
    target[field] = read.valueOnPage;
    corrections.push({ location: s.location, cell: s.cell, from: round2(num(before)), to: round2(read.valueOnPage) });
  });

  return { corrections, unverified };
}

// --- assembling the review -----------------------------------------------------------------------

// One bad figure trips several checks. The direction matters and is easy to get backwards: a wrong
// figure in a ROW is the cause; the column that then fails to foot is the symptom.
const ROW_CHECK_COLUMN = { G703_ROW_G: 'G', G703_ROW_H: 'H' };

function groupByRootCause(items) {
  // A transposed pair of columns fails the balance and percentage checks on every line at once.
  // Those are one problem with many symptoms, and the symptoms point at the contractor while the
  // problem is in the reading.
  if (items.some(it => it.check === 'COLUMNS_TRANSPOSED')) {
    for (const it of items) {
      if (it.check === 'G703_ROW_H' || it.check === 'G703_ROW_PCT') {
        it.rootCause = 'the percentage and balance columns being read the wrong way round';
      }
    }
  }

  const columnsWithRowFailures = new Set(
    items.filter(it => ROW_CHECK_COLUMN[it.check]).map(it => ROW_CHECK_COLUMN[it.check]),
  );
  for (const it of items) {
    if (it.check === 'G703_FOOTING') {
      const col = /column (\w)/i.exec(it.message)?.[1];
      if (col && columnsWithRowFailures.has(col)) it.rootCause = `the column ${col} row errors`;
    }
    if ((it.check === 'RETAINAGE_ADJUSTED_SUM' || it.check === 'G702_G703_TIE')
      && items.some(o => o.check === 'G703_FOOTING')) {
      it.rootCause = 'the schedule columns not footing';
    }
  }
  return items;
}

// A finding that rests on a figure nobody could corroborate is not a finding — but the withholding
// has to be as narrow as the doubt, or it swallows checks that had nothing to do with the doubtful
// cell.
//
// The first version treated any unsettled cell outside a schedule line as "the totals are shaky"
// and suppressed six checks. On a real package the single unsettled cell was the comparison between
// the column C total and the contract sum — which is not a claim that anything was misread at all,
// only that the two do not match, quite possibly because of a change order that is not on the form.
// Silencing the cover-sheet tie and the retainage checks over that hid more than it protected.
//
// So doubt about a cell now suppresses only the checks that actually read that cell.
const CHECKS_RESTING_ON_ROW = new Set([
  'G703_ROW_G', 'G703_ROW_H', 'G703_ROW_PCT', 'G703_OVERBILL', 'G703_NEGATIVE_BALANCE',
  'CONTINUITY_D', 'SOV_DRIFT',
]);

// Which checks read which totals cell. A cell not listed here — the contract comparison, for one —
// suppresses nothing, because it names no figure that any check depends on.
const CHECKS_BY_TOTALS_CELL = {
  'scheduled value': ['G703_FOOTING:C'],
  'previously completed': ['G703_FOOTING:D'],
  'completed this period': ['G703_FOOTING:E', 'RETAINAGE_ADJUSTED_SUM'],
  'materials stored': ['G703_FOOTING:F'],
  'total completed to date': ['G703_FOOTING:G', 'G702_G703_TIE', 'RETAINAGE_AMOUNT'],
  'balance to finish': ['G703_FOOTING:H'],
  'total completed and stored': ['G702_G703_TIE', 'RETAINAGE_AMOUNT'],
};

function withholdUnverified(items, unverified) {
  if (!unverified.length) return { kept: items, withheld: [] };

  const shakyRows = new Set(
    unverified.filter(u => String(u.location).startsWith('Schedule line')).map(u => u.location),
  );
  const shakyChecks = new Set();
  for (const u of unverified) {
    if (String(u.location).startsWith('Schedule line')) continue;
    for (const c of CHECKS_BY_TOTALS_CELL[u.cell] || []) shakyChecks.add(c);
  }

  const kept = [];
  const withheld = [];
  for (const it of items) {
    const onShakyRow = it.location && shakyRows.has(it.location) && CHECKS_RESTING_ON_ROW.has(it.check);
    // Footing is per column, so the column has to match too — a doubtful column C total says
    // nothing about whether column G foots.
    const col = it.check === 'G703_FOOTING' ? /column (\w)/i.exec(it.message)?.[1] : null;
    const key = col ? `G703_FOOTING:${col}` : it.check;
    if (onShakyRow || shakyChecks.has(key)) withheld.push(it); else kept.push(it);
  }
  return { kept, withheld };
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
  COLUMNS_TRANSPOSED: 'The percentage and balance columns look like they were read the wrong way round',
  G703_ROW_G: 'A schedule line does not add across',
  G703_ROW_H: "A schedule line's balance does not follow from its own figures",
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
  RETAINAGE_NO_BASIS: 'Retainage could not be verified — the amount it is taken from was not captured',
  RETAINAGE_AMOUNT: 'Retainage withheld is not the percentage the contract requires',
  RETAINAGE_SPLIT: 'The two retainage lines do not add up to the total',
  RETAINAGE_RELEASE: 'This looks like retainage being released',
  RETAINAGE_ADJUSTED_SUM: 'The schedule and the amount requested do not tie through retainage',
  RETAINAGE_EXEMPT_ITEMS: 'Some items are exempt from retainage under the contract',
  NO_PRIOR: 'No previous application was supplied',
  PRIOR_EMPTY: 'The previous application could not be read, so nothing was compared against it',
  PRIOR_NO_SCHEDULE: 'The previous application had no schedule lines to compare against',
  SEQUENCE_GAP: 'An application number appears to be missing',
  CONTINUITY_D: "What was billed before does not match last month's application",
  SOV_DRIFT: 'A scheduled value changed without a change order',
  NEW_LINE_ITEM: "A new line appeared that was not on last month's application",
  DROPPED_LINE_ITEM: 'A line billed last month has disappeared',
  LINE7_CONTINUITY: "Previous payments do not match last month's application",
  NO_CONTRACT_PROFILE: 'No contract was available, so nothing was checked against one',
  CONTRACT_SUM_MISMATCH: 'The contract sum on the cover sheet is not the executed contract sum',
  TAX_BILLED_TO_EXEMPT_OWNER: 'Sales tax was billed to an owner that does not pay it',
  TAX_EXEMPT_OWNER: 'No tax is billed on this application, and the owner does not pay it',
  TAX_CLAUSE_NOT_LOCATED: "The contract's tax clause was not found, so the tax rule is unverified",
  STORED_MATERIALS_BACKUP: 'Stored materials need a bill of sale behind them',
  G702_INCOMPLETE: 'The cover sheet has blanks the contract requires filled',
  G702_UNSIGNED: 'The cover sheet is not signed',
  G702_NOT_NOTARIZED: 'The cover sheet is not notarized',
  LIEN_WAIVER_MISSING: 'No lien waiver came with this application',
  LIEN_WAIVER_AMOUNT: 'The lien waiver does not cover the amount being paid',
  LIEN_WAIVER_UNSIGNED: 'The lien waiver is not signed',
  NOTARY_NO_SEAL: 'The notary seal is missing',
  NOTARY_UNSIGNED: 'The notary did not sign',
  NOTARY_COMMISSION_EXPIRED: "The notary's commission had expired",
  NOTARY_NO_ID: "The notary's ID number could not be read",
  NOTARY_DATE_UNPARSED: 'The notary dates could not be read',
};

// HOW A FINDING REACHES THE PAGE. Every rendering — screen, PDF, Markdown — takes the FIRST
// SENTENCE of `detail` as the headline and sets the rest underneath. Nothing reads `title`. So the
// first sentence IS the title, and the auditor's statement of the rule follows it.
function toAppFinding(item) {
  const title = TITLES[item.check] || item.check;
  const parts = [`${title.replace(/[.\s]+$/, '')}.`];

  const letters = t => String(t || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (item.message && letters(item.message) !== letters(title)) parts.push(item.message);

  if (isNum(item.expected) && isNum(item.found)) {
    parts.push(`Expected ${money(item.expected)}, found ${money(item.found)}`
      + (isNum(item.delta) ? `, a difference of ${money(item.delta)}.` : '.'));
  }
  if (item.citation) parts.push(`Contract: ${item.citation}`);
  if (item.rootCause) {
    parts.push(`This is likely a consequence of ${item.rootCause} rather than a separate problem.`);
  }

  return {
    id: item.check,
    severity: APP_SEVERITY[item.severity] || SEVERITY.NOTE,
    title,
    detail: parts.join(' '),
    expected: isNum(item.expected) ? item.expected : undefined,
    actual: isNum(item.found) ? item.found : undefined,
    difference: isNum(item.delta) ? item.delta : undefined,
    // The report prints the location on its own line from this object rather than from prose.
    where: item.location ? { description: item.location } : undefined,
    skillSeverity: item.severity,
    check: item.check,
    location: item.location,
    citation: item.citation,
  };
}

function recommendation(counts) {
  if (counts[CRITICAL]) return 'DO NOT CERTIFY';
  if (counts[HIGH]) return 'APPROVE WITH CORRECTIONS';
  return 'APPROVE';
}

function buildHeadline({ cur, counts, rec, note }) {
  const L8 = num(cur.g702?.line8_current_payment_due);
  const parts = [`${rec}. Application ${cur.application_number ?? '—'} requests ${money(L8)}`
    + (cur.period_to ? ` for the period ending ${cur.period_to}` : '') + '.'];

  const tally = [
    counts[CRITICAL] && `${counts[CRITICAL]} critical`,
    counts[HIGH] && `${counts[HIGH]} high`,
    counts[MEDIUM] && `${counts[MEDIUM]} medium`,
  ].filter(Boolean);
  parts.push(tally.length ? `${tally.join(', ')}.`
    : 'The arithmetic reconciles and nothing was found to question.');
  if (note) parts.push(note);
  return parts.join(' ');
}

async function reviewPayApp({
  current, previous, previousSupplied, contractTerms, contracts, deliveryMethod, files,
}) {
  const cur = toExtraction(current);
  if (!cur) return null;
  const prior = toExtraction(previous);
  const profile = toContractProfile(contractTerms, contracts);
  // Whether a previous application was HANDED to this review, which is a different question from
  // whether anything came out of it. The caller says so explicitly; the fallback covers an older
  // caller that does not.
  const priorSupplied = previousSupplied ?? !!previous;

  // STEP 2 — cross-check the reading before anything is validated against it.
  const suspects = crossCheck(cur, profile);

  // THE PRIOR APPLICATION'S READING IS CHECKED TOO. A misread figure in last month's schedule
  // produces false continuity findings against a current application that is perfectly correct —
  // and the finding points at this month's numbers, when the error is in last month's reading. The
  // prior application's PDF is not in front of us at review time, so nothing here can be re-read;
  // a prior cell that fails is unverifiable by definition, and the continuity checks that rest on
  // it are held back rather than published.
  const priorSuspects = prior ? crossCheck(prior, profile) : [];

  // The single pass over the pages: the targeted re-read AND everything no calculation can settle.
  let reading = null;
  const buffer = files?.current?.buffer;
  if (buffer) {
    const { data } = await askForJson({
      content: [asDocument(buffer), { type: 'text', text: readingPrompt(profile, suspects) }],
      tool: READING_TOOL,
      maxTokens: 8000,
      label: 'payapp2 csp reading',
    });
    reading = data;
  }

  let corrections = [];
  let unverified = suspects.map(s => ({ ...s, reason: 'the pay application PDF was not available' }));

  if (reading) {
    ({ corrections, unverified } = applyRereads(cur, suspects, reading.cellReadings));

    const ex = reading.g702Execution || {};
    cur.g702.contractor_signature_present = ex.contractorSignaturePresent ?? null;
    cur.g702.notarized = ex.notarized ?? null;

    // A waiver is recorded only where one was classified as a page of the package. The schema says
    // to omit the object when there is none, and a run on a package without one returned a hollow
    // one anyway — every field false. Trusting that shape produced four findings about a document
    // that does not exist, one of them CRITICAL, where the truth is the single finding that no
    // waiver was supplied.
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

    const sm = reading.storedMaterials;
    if (profile && sm && isNum(sm.amountBilled) && sm.amountBilled > TOL && sm.billOfSaleAttached === false) {
      profile.stored_materials_require_offsite_consent = true;
    }
  }

  // Corrections change the figures, so the cross-check runs again over the corrected reading. What
  // survives a second pass is either still misread or a genuine inconsistency in the form itself.
  const residual = corrections.length ? crossCheck(cur, profile) : [];
  const stillUnsettled = [
    ...unverified,
    ...residual.filter(r => !unverified.some(u => u.location === r.location && u.cell === r.cell)),
    // Last month's doubtful cells travel with a note saying so, because "schedule line 4" in a
    // report otherwise reads as a line on the application in front of the reader.
    ...priorSuspects.map(s => ({
      ...s,
      reason: "it is a figure in LAST MONTH'S application, whose pages are not part of this review",
    })),
  ];

  const f = validate(cur, prior, profile, { priorSupplied });
  groupByRootCause(f.items);
  const { kept, withheld } = withholdUnverified(f.items, stillUnsettled);

  const findings = kept.map(toAppFinding);

  // ONE SUBJECT, ONE ENTRY. There used to be a second tax entry here, built from where the model
  // thought tax might be hiding. Two notes about tax is one note, and that one was the weaker of
  // the pair: "tax may be buried in the line items" names no figure, cites no clause, and sends the
  // reader to the same place the tax finding above already sends them. Where it says something
  // specific about the package it now rides on that finding instead of competing with it.
  const hiding = profile?.owner_tax_exempt ? reading?.embeddedTax?.whereItCouldHide : null;
  if (hiding) {
    const taxEntry = findings.find(x => /^TAX_/.test(x.check));
    if (taxEntry) taxEntry.detail += ` Where it could be hiding: ${hiding}`;
  }

  // PROGRESS JUDGMENTS GO ON THE SITE CHECKLIST, NOT IN THE FINDINGS LIST. A line jumping 5% to 85%
  // is arithmetically fine; whether the work happened is a question for someone standing on the
  // site. Paragraphs of speculation per line bury the real findings and give the reader nothing to
  // act on. One checklist line each, and the findings list stays for figures that are actually
  // wrong.
  const siteChecklist = (reading?.progressToVerify || []).map(p => ({
    itemNo: p.itemNo || null,
    description: p.description,
    amount: isNum(p.thisPeriod) ? p.thisPeriod : 0,
    isNew: false,
    detail: [
      isNum(p.claimedPct) ? `${p.claimedPct}% complete claimed` : null,
      isNum(p.thisPeriod) ? `${money(p.thisPeriod)} billed this period` : null,
      p.why || null,
    ].filter(Boolean).join(' · ') + '. Walk the line and confirm the progress claimed.',
  }));

  const counts = {
    [CRITICAL]: kept.filter(i => i.severity === CRITICAL).length,
    [HIGH]: kept.filter(i => i.severity === HIGH).length,
    [MEDIUM]: kept.filter(i => i.severity === MEDIUM).length,
    [LOW]: kept.filter(i => i.severity === LOW).length,
    [INFO]: kept.filter(i => i.severity === INFO).length,
  };
  const rec = recommendation(counts);

  // WHAT WAS NOT CHECKED, stated rather than left as an inference from silence. A reader who
  // assumes retainage was verified because the report did not mention it has been misled by
  // omission.
  const notChecked = [];

  // The reading, first, because a review of a scanned document is a reading plus arithmetic and the
  // reader is entitled to know how much of it is which.
  const cellCount = (cur.g703.line_items || []).length * 6 + 6;
  if (!buffer) {
    notChecked.push('The reading could not be verified against the page — the pay application PDF '
      + 'was not available, so only the extracted figures were checked.');
  } else if (!suspects.length) {
    notChecked.push(`Reading verified: about ${cellCount} figures were cross-checked against the `
      + "form's own internal arithmetic and none contradicted it.");
  } else {
    notChecked.push(`Reading verified: ${suspects.length} figure(s) contradicted the form's own `
      + `arithmetic and were re-read from the page. `
      + (corrections.length
        ? `${corrections.length} were corrected before any check ran (`
          + `${corrections.map(c => `${c.location} ${c.cell}: ${money(c.from)} to ${money(c.to)}`).join('; ')}).`
        : 'None needed correcting.'));
  }
  for (const u of stillUnsettled) {
    notChecked.push(`${u.location} — ${u.cell}: could not be corroborated (${u.reason || 'the form '
      + 'disagrees with itself here'}). Reported as unverified rather than as a finding.`);
  }
  if (withheld.length) {
    notChecked.push(`${withheld.length} check(s) were held back because they rest on a figure above `
      + 'that could not be verified. They will run once the reading is settled.');
  }

  // WHAT THIS REVIEW WAS ACTUALLY HANDED. "Continuity was checked and passed" and "continuity was
  // never checked" are indistinguishable in a findings list that contains neither, so the inputs
  // are stated rather than inferred — and the sentence changes depending on whether a previous
  // application was supplied, because telling someone their file was missing when they supplied it
  // sends them looking in the wrong place.
  if (!prior && priorSupplied) {
    notChecked.push('Continuity against the previous application — one was supplied, but nothing '
      + 'could be read from it, so re-billing and silent reversals were NOT checked. This is a '
      + 'fault in the reading rather than anything about the contractor.');
  } else if (!prior) {
    notChecked.push('Continuity against the previous application — none was supplied, so re-billing '
      + 'and silent reversals could not be checked.');
  } else if (!(prior.g703?.line_items || []).length) {
    notChecked.push('Continuity against the previous application — it was read but produced no '
      + 'schedule lines, so re-billing and silent reversals were NOT checked.');
  } else {
    notChecked.push(`Continuity was checked line by line against application `
      + `${prior.application_number ?? '(number not read)'}, which contributed `
      + `${prior.g703.line_items.length} schedule lines.`);
  }
  if (!profile) {
    notChecked.push('Everything the contract governs — retainage rate, tax treatment and required '
      + 'documents — because no contract was available.');
  } else if (profile.retainage_rate === null) {
    notChecked.push('Retainage — the contract on file does not state a rate, and it was not assumed.');
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
    // Merged into the report's own site checklist. Progress judgments belong here.
    siteChecklist,
    stats: {
      checksRun: CHECK_COUNT,
      passed: Math.max(0, CHECK_COUNT - new Set(kept.map(i => i.check)).size),
      critical,
      failed: critical + material,
      lineItems: (cur.g703.line_items || []).length,
      codesTied: 0,
      codesTotal: 0,
      enginesRun: reading
        ? ['reading cross-check', 'G702', 'G703', 'retainage', 'continuity', 'contract', 'lien waiver', 'page reading']
        : ['reading cross-check', 'G702', 'G703', 'retainage', 'continuity', 'contract', 'lien waiver'],
      enginesTotal: 8,
    },
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
      reading: {
        crossChecked: cellCount,
        suspect: suspects.length,
        corrected: corrections,
        unverified: stillUnsettled,
        checksWithheld: withheld.map(w => ({ check: w.check, location: w.location })),
        priorSuspect: priorSuspects.length,
      },
      // What the review was handed, recorded rather than inferred. A findings list containing no
      // continuity findings looks the same whether continuity passed or never ran, and this is the
      // only thing that tells the two apart.
      inputsReceived: {
        previousSupplied: priorSupplied,
        previousRead: !!prior,
        previousLineItems: (prior?.g703?.line_items || []).length,
        previousApplicationNumber: prior?.application_number ?? null,
        contractSupplied: !!profile,
        retainageRate: profile ? profile.retainage_rate : null,
        payApplicationPdfAvailable: !!buffer,
      },
    },
    subcontractorRows: [],
  };
}

// The number of distinct checks the validator can raise, used only to say how many ran.
const CHECK_COUNT = 38;

module.exports = { reviewPayApp };
