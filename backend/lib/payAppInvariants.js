// The rules a pay application must obey, expressed as arithmetic.
//
// An invariant is a statement that is true of every correct application, without exception —
// Line 8 IS Line 6 less Line 7, on every project, every month. That makes it checkable in
// code, identically every time, with no model involved and no room for an opinion. Judgment
// calls (is this backup adequate, is this scope in the contract) are deliberately NOT here.
//
// These are drawn from two sources, both real rather than invented:
//   - the review workbook the PM has kept by hand for this contract, whose formulas encode
//     the method: per-line continuity, cumulative page subtotals, the G702 line arithmetic,
//     the certificate chain between applications, and the per-campus tie-out
//   - three actual applications, one of which failed and two of which passed
//
// Two design rules run through the whole file:
//
// 1. A check whose inputs are missing SKIPS. It never fails. A figure we could not read is
//    not evidence of a contractor error, and reporting it as one is the fastest way to make
//    the whole report untrustworthy.
// 2. Every finding carries the two numbers it compared. A reader must be able to see at a
//    glance whether the finding is real, without going back to the document.

// Money is compared to the cent. Aggregates get a little more room because a form rounds each
// line before summing, but the slack stays far below anything that matters — the smallest real
// error in the sample set is $7.00.
const TOL = {
  cent: 0.011,
  aggregate: 0.05,
  rate: 0.0005,
};

const SEVERITY = {
  CRITICAL: 'critical',  // the form contradicts itself, or the money is wrong
  MATERIAL: 'material',  // a figure is wrong, but nothing downstream depends on it yet
  NOTE: 'note',          // real, but it changes nothing
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const money = n => (isNum(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : '—');
const pct = n => (isNum(n) ? `${(n * 100).toFixed(2)}%` : '—');

// THE CONTRACT WITH WHATEVER PRODUCES THE FIGURES.
//
// For a money column: 0 means the cell was read and is blank or zero — no work booked on that
// line. null means the cell could not be read at all. Those two must never be conflated,
// because arithmetic on a guessed zero manufactures a discrepancy out of a bad scan, and the
// contractor gets blamed for the scanner.
//
// So nothing here substitutes a zero for a missing figure. A check with a null input stands
// down and says which column it could not see. Columns that a form leaves blank by convention
// rather than by omission — balance-to-finish, the variable-rate retainage column — are simply
// reported as null by the extractor, and the checks that need them stand down too.
const missingOf = (obj, keys) => keys.filter(k => !isNum(obj?.[k]));
const columnList = keys => keys.map(k => k.toUpperCase()).join(', ');

// --- result constructors -------------------------------------------------------------------

const fail = (o) => ({ status: 'FAIL', ...o });
const pass = (o) => ({ status: 'PASS', ...o });
const skip = (reason, o = {}) => ({ status: 'SKIPPED', detail: reason, ...o });

// --- the invariants ------------------------------------------------------------------------
//
// Each has: id, title, and run(app) -> result | result[]. Results are stamped with the id,
// title and default severity by runInvariants() below, so an invariant only states what it
// found.

const INVARIANTS = [

  // ---- I1  Row arithmetic ------------------------------------------------------------------
  {
    id: 'I1',
    title: 'Each line adds up',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const out = [];
      for (const li of app.lineItems || []) {
        const where = { itemNo: li.itemNo, description: li.description, page: li.page };
        const missing = missingOf(li, ['d', 'e', 'f', 'g']);
        if (missing.length) {
          out.push(skip(`Column ${columnList(missing)} could not be read on this line.`, { where }));
          continue;
        }

        const g = li.g;
        const sum = li.d + li.e + li.f;
        if (!close(g, sum, TOL.cent)) {
          out.push(fail({
            where,
            expected: sum,
            actual: g,
            difference: g - sum,
            detail: `Total completed and stored reads ${money(g)}, but from-previous ${money(li.d)} `
              + `plus this period ${money(li.e)} plus stored ${money(li.f)} `
              + `comes to ${money(sum)} — a difference of ${money(Math.abs(g - sum))}.`,
          }));
        } else {
          out.push(pass({ where }));
        }
      }
      return out.length ? out : skip('No line items were read.');
    },
  },

  // ---- I2  Balance to finish, per line -----------------------------------------------------
  {
    id: 'I2',
    title: 'Balance to finish, per line',
    severity: SEVERITY.NOTE,
    run(app) {
      const out = [];
      for (const li of app.lineItems || []) {
        if (!isNum(li.h) || !isNum(li.c) || !isNum(li.g)) continue;  // column often left blank
        const expected = li.c - li.g;
        const where = { itemNo: li.itemNo, description: li.description, page: li.page };
        out.push(close(li.h, expected, TOL.cent) ? pass({ where }) : fail({
          where,
          expected,
          actual: li.h,
          difference: li.h - expected,
          detail: `Balance to finish reads ${money(li.h)}; scheduled value ${money(li.c)} less `
            + `completed ${money(li.g)} is ${money(expected)}.`,
        }));
      }
      return out.length ? out : skip('No line carried a balance-to-finish figure.');
    },
  },

  // ---- I3  Continuity with the previous application ----------------------------------------
  // The check that catches billing for work that was never done: what a line claims was
  // completed before this month must equal what the last application said was completed in
  // total. Compared line by line, because an aggregate can net two errors to zero.
  {
    id: 'I3',
    title: 'Each line continues from the last application',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const prior = app.prior;
      if (!prior) return skip('No previous application is on file to compare against.');
      const priorByItem = new Map((prior.lineItems || []).map(li => [String(li.itemNo), li]));
      if (priorByItem.size === 0) return skip('The previous application has no line detail on file.');

      const out = [];
      for (const li of app.lineItems || []) {
        const was = priorByItem.get(String(li.itemNo));
        const where = { itemNo: li.itemNo, description: li.description, page: li.page };
        if (!was) { out.push(skip('This line was not on the previous application.', { where })); continue; }
        if (!isNum(li.d) || !isNum(was.g)) { out.push(skip('Figures missing on one side.', { where })); continue; }

        out.push(close(li.d, was.g, TOL.cent) ? pass({ where }) : fail({
          where,
          expected: was.g,
          actual: li.d,
          difference: li.d - was.g,
          detail: `From-previous reads ${money(li.d)}, but application ${prior.applicationNumber} `
            + `showed ${money(was.g)} completed to date on this line — `
            + `${money(Math.abs(li.d - was.g))} ${li.d > was.g ? 'more' : 'less'} than was billed before.`,
        }));
      }
      return out.length ? out : skip('No line items were read.');
    },
  },

  // ---- I4  Column totals -------------------------------------------------------------------
  {
    id: 'I4',
    title: 'Column totals match the lines above them',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const totals = app.grandTotals;
      if (!totals) return skip('No totals row was read.');
      const items = app.lineItems || [];
      if (!items.length) return skip('No line items were read.');

      const out = [];
      for (const col of ['c', 'd', 'e', 'f', 'g']) {
        if (!isNum(totals[col])) continue;
        // Summing a column where even one cell could not be read would manufacture a shortfall
        // the size of that cell, and report it as the contractor's error.
        const unread = items.filter(li => !isNum(li[col])).length;
        if (unread) {
          out.push(skip(`${unread} cell(s) in column ${col.toUpperCase()} could not be read.`, { where: { field: col } }));
          continue;
        }
        const sum = items.reduce((a, li) => a + li[col], 0);
        out.push(close(totals[col], sum, TOL.aggregate) ? pass({ where: { field: col } }) : fail({
          where: { field: col },
          expected: sum,
          actual: totals[col],
          difference: totals[col] - sum,
          detail: `The totals row shows ${money(totals[col])} for column ${col.toUpperCase()}, `
            + `but the lines above add to ${money(sum)} — a difference of ${money(Math.abs(totals[col] - sum))}.`,
        }));
      }
      return out.length ? out : skip('No totals could be compared.');
    },
  },

  // ---- I5  Page subtotals ------------------------------------------------------------------
  // Some forms print a per-page subtotal; this contract's prints a RUNNING one, where page 4's
  // figure includes pages 2 and 3. Getting that backwards would fail every page of a correct
  // application, so the style is detected from the numbers rather than assumed, and the check
  // stands down when it cannot tell.
  {
    id: 'I5',
    title: 'Page subtotals match the pages they cover',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const subs = (app.pageSubtotals || []).filter(s => isNum(s.g));
      if (subs.length < 1) return skip('The form prints no page subtotals.');
      const items = app.lineItems || [];
      if (!items.length) return skip('No line items were read.');

      const unread = items.filter(li => !isNum(li.g)).length;
      if (unread) return skip(`${unread} line(s) have an unreadable total, so page subtotals cannot be checked.`);

      const upTo = page => items.filter(li => li.page != null && li.page <= page)
        .reduce((a, li) => a + li.g, 0);
      const onPage = page => items.filter(li => li.page === page)
        .reduce((a, li) => a + li.g, 0);

      let style = app.pageSubtotalStyle || null;
      if (!style) {
        const cumulativeFits = subs.every(s => close(s.g, upTo(s.page), TOL.aggregate));
        const perPageFits = subs.every(s => close(s.g, onPage(s.page), TOL.aggregate));
        // When both fit, the pages are indistinguishable (a single page, or empty ones) and
        // there is nothing to learn — say so instead of picking one.
        if (cumulativeFits && perPageFits) return skip('Only one page carries values, so the subtotal style cannot be told apart.');
        if (cumulativeFits) style = 'cumulative';
        else if (perPageFits) style = 'per-page';
      }
      if (!style) {
        // Neither reading works: report against the one that fits best, so the finding names a
        // real discrepancy rather than an assumption about the form's layout.
        const err = s => Math.min(Math.abs(s.g - upTo(s.page)), Math.abs(s.g - onPage(s.page)));
        const worst = subs.reduce((a, b) => (err(a) > err(b) ? a : b));
        const cum = Math.abs(worst.g - upTo(worst.page)) <= Math.abs(worst.g - onPage(worst.page));
        const expected = cum ? upTo(worst.page) : onPage(worst.page);
        return fail({
          where: { page: worst.page },
          expected,
          actual: worst.g,
          difference: worst.g - expected,
          detail: `The subtotal on page ${worst.page} reads ${money(worst.g)}; the lines it should `
            + `cover add to ${money(expected)}.`,
        });
      }

      const expectedFor = style === 'cumulative' ? upTo : onPage;
      return subs.map(s => (close(s.g, expectedFor(s.page), TOL.aggregate)
        ? pass({ where: { page: s.page }, detail: `${style} subtotal` })
        : fail({
          where: { page: s.page },
          expected: expectedFor(s.page),
          actual: s.g,
          difference: s.g - expectedFor(s.page),
          detail: `The ${style} subtotal on page ${s.page} reads ${money(s.g)}, but the lines it `
            + `covers add to ${money(expectedFor(s.page))}.`,
        })));
    },
  },

  // ---- I6  Line 3 = Line 1 + Line 2 ---------------------------------------------------------
  {
    id: 'I6',
    title: 'Contract sum to date',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      const missing = missingOf(s, ['line1', 'line2', 'line3']);
      if (missing.length) return skip(`${missing.join(', ')} could not be read.`);
      const expected = s.line1 + s.line2;
      return close(s.line3, expected, TOL.cent) ? pass({ where: { field: 'line3' } }) : fail({
        where: { field: 'line3' },
        expected,
        actual: s.line3,
        difference: s.line3 - expected,
        detail: `Line 3 reads ${money(s.line3)}; Line 1 ${money(s.line1)} plus change orders `
          + `${money(s.line2)} is ${money(expected)}.`,
      });
    },
  },

  // ---- I7  Line 4 = the G703 grand total ----------------------------------------------------
  {
    id: 'I7',
    title: 'The summary agrees with the continuation sheet',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      const g = app.grandTotals?.g;
      if (!isNum(s.line4)) return skip('Line 4 could not be read.');
      if (!isNum(g)) return skip('The continuation sheet total could not be read.');
      return close(s.line4, g, TOL.aggregate) ? pass({ where: { field: 'line4' } }) : fail({
        where: { field: 'line4' },
        expected: g,
        actual: s.line4,
        difference: s.line4 - g,
        detail: `Line 4 reads ${money(s.line4)}, but column G on the continuation sheet totals `
          + `${money(g)} — the summary and its own backup disagree by ${money(Math.abs(s.line4 - g))}.`,
      });
    },
  },

  // ---- I8  Line 6 = Line 4 - Line 5 ---------------------------------------------------------
  {
    id: 'I8',
    title: 'Total earned less retainage',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      const missing = missingOf(s, ['line4', 'line5Total', 'line6']);
      if (missing.length) return skip(`${missing.join(', ')} could not be read.`);
      const expected = s.line4 - s.line5Total;
      return close(s.line6, expected, TOL.cent) ? pass({ where: { field: 'line6' } }) : fail({
        where: { field: 'line6' },
        expected,
        actual: s.line6,
        difference: s.line6 - expected,
        detail: `Line 6 reads ${money(s.line6)}; Line 4 ${money(s.line4)} less retainage `
          + `${money(s.line5Total)} is ${money(expected)}.`,
      });
    },
  },

  // ---- I9  Line 8 = Line 6 - Line 7 ---------------------------------------------------------
  // The one that caught Horizon #3: the contractor wrote the payment they wanted rather than
  // the one their own form produces.
  {
    id: 'I9',
    title: 'Current payment due follows from the form',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      if (!isNum(s.line8) || !isNum(s.line6) || !isNum(s.line7)) return skip('Lines 6, 7 or 8 could not be read.');
      const expected = s.line6 - s.line7;
      return close(s.line8, expected, TOL.cent) ? pass({ where: { field: 'line8' } }) : fail({
        where: { field: 'line8' },
        expected,
        actual: s.line8,
        difference: s.line8 - expected,
        detail: `Line 8 asks for ${money(s.line8)}, but Line 6 ${money(s.line6)} less previous `
          + `certificates ${money(s.line7)} is ${money(expected)}. The form does not support the `
          + `amount requested.`,
      });
    },
  },

  // ---- I10  Line 9 = Line 3 - Line 6 --------------------------------------------------------
  {
    id: 'I10',
    title: 'Balance to finish',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      if (!isNum(s.line9) || !isNum(s.line3) || !isNum(s.line6)) return skip('Lines 3, 6 or 9 could not be read.');
      const expected = s.line3 - s.line6;
      return close(s.line9, expected, TOL.cent) ? pass({ where: { field: 'line9' } }) : fail({
        where: { field: 'line9' },
        expected,
        actual: s.line9,
        difference: s.line9 - expected,
        detail: `Line 9 reads ${money(s.line9)}; contract sum ${money(s.line3)} less earned `
          + `${money(s.line6)} is ${money(expected)}.`,
      });
    },
  },

  // ---- I11  The certificate chain -----------------------------------------------------------
  {
    id: 'I11',
    title: 'Previous certificates match the last application',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      const prior = app.prior;
      if (!prior) return skip('No previous application is on file to compare against.');
      if (!isNum(s.line7)) return skip('Line 7 could not be read.');
      if (!isNum(prior.line6)) return skip('The previous application\'s Line 6 is not on file.');
      return close(s.line7, prior.line6, TOL.cent) ? pass({ where: { field: 'line7' } }) : fail({
        where: { field: 'line7' },
        expected: prior.line6,
        actual: s.line7,
        difference: s.line7 - prior.line6,
        detail: `Line 7 reads ${money(s.line7)}, but application ${prior.applicationNumber} certified `
          + `${money(prior.line6)}. Every dollar of that gap is either paid twice or not at all.`,
      });
    },
  },

  // ---- I12  Retainage amount matches the rate printed beside it ------------------------------
  // The seed of the Horizon failure. On application 2 the rate was mislabelled 0% while the
  // money was right and everything downstream tied — worth flagging, but nothing had gone
  // wrong yet. On application 3 the same mislabel sat on a release where the money should have
  // been zero, and three further lines broke. Same defect, different consequence, so the
  // severity has to depend on which it is.
  {
    id: 'I12',
    title: 'Retainage amount matches its stated rate',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const s = app.summary || {};
      if (!isNum(s.line5aAmount)) return skip('Retainage amount could not be read.');
      if (!isNum(s.line5aRate)) return skip('Retainage rate could not be read.');
      if (!isNum(s.line4)) return skip('Line 4 could not be read.');

      const expected = s.line4 * s.line5aRate;
      if (close(s.line5aAmount, expected, TOL.aggregate)) return pass({ where: { field: 'line5a' } });

      const implied = s.line4 === 0 ? null : s.line5aAmount / s.line4;
      return fail({
        where: { field: 'line5a' },
        expected,
        actual: s.line5aAmount,
        difference: s.line5aAmount - expected,
        severity: app.meta?.isRetainageRelease ? SEVERITY.CRITICAL : SEVERITY.MATERIAL,
        detail: `The form states ${pct(s.line5aRate)} of completed work but enters `
          + `${money(s.line5aAmount)}. ${pct(s.line5aRate)} of ${money(s.line4)} is ${money(expected)}`
          + (implied != null ? `; the amount shown is ${pct(implied)}.` : '.'),
      });
    },
  },

  // ---- I13  Retainage column ties to the summary ---------------------------------------------
  {
    id: 'I13',
    title: 'Retainage on the continuation sheet ties to the summary',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const s = app.summary || {};
      const col = app.grandTotals?.i;
      const out = [];

      if (isNum(col) && isNum(s.line5Total)) {
        out.push(close(col, s.line5Total, TOL.aggregate) ? pass({ where: { field: 'retainageColumn' } }) : fail({
          where: { field: 'retainageColumn' },
          expected: s.line5Total,
          actual: col,
          difference: col - s.line5Total,
          detail: `The retainage column totals ${money(col)} on the continuation sheet, but the `
            + `summary holds ${money(s.line5Total)}.`,
        }));
      }

      // The column heading carries its own rate on these forms, and it drifts out of step with
      // the summary just as easily as the amount does.
      if (isNum(app.grandTotals?.retainageHeaderRate) && isNum(s.line5aRate)) {
        const h = app.grandTotals.retainageHeaderRate;
        out.push(close(h, s.line5aRate, TOL.rate) ? pass({ where: { field: 'retainageHeader' } }) : fail({
          where: { field: 'retainageHeader' },
          expected: s.line5aRate,
          actual: h,
          difference: h - s.line5aRate,
          detail: `The continuation sheet's retainage column is headed ${pct(h)} while the summary `
            + `states ${pct(s.line5aRate)}.`,
        }));
      }

      return out.length ? out : skip('No retainage column figures were read.');
    },
  },

  // ---- I14  A retainage release holds nothing back ---------------------------------------------
  {
    id: 'I14',
    title: 'A retainage release holds no retainage',
    severity: SEVERITY.CRITICAL,
    run(app) {
      if (!app.meta?.isRetainageRelease) return skip('This is not a retainage release.');
      const s = app.summary || {};
      const out = [];

      if (isNum(s.line5Total)) {
        out.push(close(s.line5Total, 0, TOL.cent) ? pass({ where: { field: 'line5' } }) : fail({
          where: { field: 'line5' },
          expected: 0,
          actual: s.line5Total,
          difference: s.line5Total,
          detail: `This application releases retainage, so Line 5 must be ${money(0)}. It holds `
            + `${money(s.line5Total)}, which is what makes Lines 6, 8 and 9 disagree with each other.`,
        }));
      }
      if (isNum(app.grandTotals?.i)) {
        out.push(close(app.grandTotals.i, 0, TOL.cent) ? pass({ where: { field: 'retainageColumn' } }) : fail({
          where: { field: 'retainageColumn' },
          expected: 0,
          actual: app.grandTotals.i,
          difference: app.grandTotals.i,
          detail: `The continuation sheet still shows ${money(app.grandTotals.i)} of retainage on a `
            + `release.`,
        }));
      }
      return out.length ? out : skip('Retainage figures could not be read.');
    },
  },

  // ---- I15  The release pays out exactly what was held ------------------------------------------
  {
    id: 'I15',
    title: 'The release equals the retainage previously held',
    severity: SEVERITY.CRITICAL,
    run(app) {
      if (!app.meta?.isRetainageRelease) return skip('This is not a retainage release.');
      const s = app.summary || {};
      const prior = app.prior;
      if (!prior) return skip('No previous application is on file to compare against.');
      if (!isNum(s.line8)) return skip('Line 8 could not be read.');
      if (!isNum(prior.line5Total) || !isNum(prior.line4) || !isNum(s.line4)) {
        return skip('The previous application\'s retainage and completed total are not both on file.');
      }
      // A release usually closes out any work booked since the last application as well as
      // returning what was held, so both parts count.
      const newWork = s.line4 - prior.line4;
      const expected = newWork + prior.line5Total;
      return close(s.line8, expected, TOL.aggregate) ? pass({ where: { field: 'line8' } }) : fail({
        where: { field: 'line8' },
        expected,
        actual: s.line8,
        difference: s.line8 - expected,
        detail: `The release asks for ${money(s.line8)}. Application ${prior.applicationNumber} held `
          + `${money(prior.line5Total)} of retainage and ${money(newWork)} of work has been booked `
          + `since, which comes to ${money(expected)}.`,
      });
    },
  },

  // ---- I16  The rate billed is the rate contracted ------------------------------------------------
  {
    id: 'I16',
    title: 'Retainage is held at the contracted rate',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const contracted = app.contract?.retainageRate;
      if (!isNum(contracted)) return skip('No contracted retainage rate is on file for this project.');
      if (app.meta?.isRetainageRelease) return skip('Retainage is being released, so the rate does not apply.');
      const s = app.summary || {};
      if (!isNum(s.line5aAmount) || !isNum(s.line4) || s.line4 === 0) return skip('Retainage or Line 4 could not be read.');

      const billed = s.line5aAmount / s.line4;
      return close(billed, contracted, TOL.rate) ? pass({ where: { field: 'line5a' } }) : fail({
        where: { field: 'line5a' },
        expected: s.line4 * contracted,
        actual: s.line5aAmount,
        difference: s.line5aAmount - s.line4 * contracted,
        detail: `Retainage is being held at ${pct(billed)} of completed work, but the contract sets `
          + `${pct(contracted)} — ${money(s.line4 * contracted)} rather than ${money(s.line5aAmount)}.`,
      });
    },
  },

  // ---- I17  Nothing bills beyond its scheduled value -----------------------------------------------
  {
    id: 'I17',
    title: 'No line bills more than it is worth',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const out = [];
      for (const li of app.lineItems || []) {
        if (!isNum(li.c) || li.c < 0) continue;   // credit lines run the other way
        const where = { itemNo: li.itemNo, description: li.description, page: li.page };
        // Column G is what the payment is calculated on, so exceeding the scheduled value there
        // is money out of the door. Column D exceeding it means a PAST application overbilled,
        // which still needs chasing but is not what is being paid today.
        for (const [col, label, severity] of [
          ['g', 'Completed to date', SEVERITY.CRITICAL],
          ['d', 'From previous application', SEVERITY.MATERIAL],
        ]) {
          if (!isNum(li[col])) continue;
          if (li[col] > li.c + TOL.cent) {
            out.push(fail({
              where: { ...where, field: col },
              severity,
              expected: li.c,
              actual: li[col],
              difference: li[col] - li.c,
              detail: `${label} is ${money(li[col])} against a scheduled value of ${money(li.c)} — `
                + `${money(li[col] - li.c)} more than the line is worth.`,
            }));
          }
        }
      }
      if (out.length) return out;
      return (app.lineItems || []).length ? pass({}) : skip('No line items were read.');
    },
  },

  // ---- I18  Total completed never exceeds the contract -----------------------------------------
  {
    id: 'I18',
    title: 'Completed to date stays within the contract',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      if (!isNum(s.line4) || !isNum(s.line3)) return skip('Line 3 or Line 4 could not be read.');
      return s.line4 <= s.line3 + TOL.cent ? pass({ where: { field: 'line4' } }) : fail({
        where: { field: 'line4' },
        expected: s.line3,
        actual: s.line4,
        difference: s.line4 - s.line3,
        detail: `${money(s.line4)} has been billed against a contract sum of ${money(s.line3)} — `
          + `${money(s.line4 - s.line3)} beyond the contract.`,
      });
    },
  },

  // ---- I23  Nothing in the schedule of values is negative --------------------------------------------
  // A line cannot be worth less than nothing, and work cannot be un-performed. A credit is a
  // change order against a line that HAS value, not a negative smuggled into the billing.
  //
  // The case this came from: a $7,000 deduction applied to a line whose original value was
  // $0.00, leaving a scheduled value of minus $7,000. Every other figure on that application
  // tied to the cent, which is why nothing else notices.
  {
    id: 'I23',
    title: 'No figure in the schedule of values is negative',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const COLUMNS = [
        ['c', 'Scheduled value'],
        ['originalValue', 'Original value'],
        ['d', 'Work completed from previous applications'],
        ['e', 'Work completed this period'],
        ['f', 'Materials presently stored'],
        ['g', 'Total completed and stored'],
      ];
      // A change order line is the ONE place a negative belongs — it is how a credit is
      // supposed to be booked, which is the whole point of the rule. Flagging those would
      // punish the correct behaviour: a real application in this set carries a legitimate
      // "CO#12 Terrazo credit" of minus $14,897.10 and must pass untouched.
      const coItems = new Set((app.contingency?.changeOrderItemNos || []).map(String));
      const isChangeOrderLine = li => li.isChangeOrder === true || coItems.has(String(li.itemNo));

      const out = [];
      for (const li of app.lineItems || []) {
        if (isChangeOrderLine(li)) continue;
        const where = { itemNo: li.itemNo, description: li.description, page: li.page };
        for (const [col, label] of COLUMNS) {
          if (!isNum(li[col]) || li[col] >= 0) continue;

          // A negative scheduled value earns a fuller explanation, because the cause is
          // usually a deduction booked against a line that had nothing to deduct.
          const overdrawn = col === 'c' && isNum(li.originalValue) && isNum(li.changeOrders)
            && li.changeOrders < 0 && Math.abs(li.changeOrders) > li.originalValue;

          // One negative is ordinary: a downward adjustment in a PERIOD column that leaves the
          // line still positive overall. Insurance is where it shows up — a builders risk premium
          // trued up in a later month credits part of an earlier billing back. Nothing is worth
          // less than nothing there; a month's movement is simply backwards. It is still worth
          // saying, because it is also what an un-billing looks like, but it is not a reason to
          // hold a certificate and must not be graded as one.
          const periodColumn = col === 'd' || col === 'e';
          const stillPositive = isNum(li.g) && li.g >= 0 && isNum(li.c) && li.c > 0;
          const adjustment = periodColumn && stillPositive;

          out.push(fail({
            where: { ...where, field: col },
            severity: adjustment ? SEVERITY.NOTE : SEVERITY.CRITICAL,
            expected: 0,
            actual: li[col],
            difference: li[col],
            detail: adjustment
              ? `${label} is ${money(li[col])} — a credit against work billed earlier. The line is `
                + `still ${money(li.g)} complete overall, so this is a downward adjustment rather `
                + `than a negative value. Confirm it is a genuine credit and not work being quietly `
                + `un-billed.`
              : overdrawn
              ? `${label} is ${money(li.c)}. A change order deducts ${money(Math.abs(li.changeOrders))} `
                + `from a line whose original value was ${money(li.originalValue)} — there was never `
                + `that much scope on this line to take away. A credit of this kind belongs on its `
                + `own change order line, not as a negative against an empty one.`
              : `${label} is ${money(li[col])}. This figure cannot be negative: a line cannot be `
                + `worth less than nothing, and work already billed cannot be un-performed. If this `
                + `is a credit, it belongs on a change order.`,
          }));
        }
      }
      if (out.length) return out;
      return (app.lineItems || []).length ? pass({}) : skip('No line items were read.');
    },
  },

  // ---- I24  The change order summary matches the schedule of values ------------------------------------
  // Additions and deductions are reported separately on the G702 for a reason: netting them
  // hides deductions. On the application this came from, a $7,000 credit was reported inside
  // the additions figure, so the summary read "deductions $0.00" while a deduction sat on the
  // continuation sheet. The net was right, so nothing else in the form disagreed.
  {
    id: 'I24',
    title: 'The change order summary matches the schedule of values',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const cos = app.summary?.changeOrderSummary;
      if (!cos) return skip('The form prints no change order summary.');
      const items = (app.lineItems || []).filter(li => isNum(li.changeOrders));
      if (!items.length) return skip('No change order column on the schedule of values.');

      const additions = items.filter(li => li.changeOrders > 0).reduce((a, li) => a + li.changeOrders, 0);
      const deductions = items.filter(li => li.changeOrders < 0).reduce((a, li) => a + li.changeOrders, 0);

      const out = [];
      if (isNum(cos.additions) && !close(cos.additions, additions, TOL.aggregate)) {
        out.push(fail({
          where: { field: 'changeOrderAdditions' },
          expected: additions,
          actual: cos.additions,
          difference: cos.additions - additions,
          detail: `The change order summary reports ${money(cos.additions)} of additions, but the `
            + `positive change orders on the continuation sheet total ${money(additions)}.`,
        }));
      }
      // Reported as a magnitude, since forms print deductions unsigned in their own column.
      if (isNum(cos.deductions) && !close(Math.abs(cos.deductions), Math.abs(deductions), TOL.aggregate)) {
        out.push(fail({
          where: { field: 'changeOrderDeductions' },
          expected: Math.abs(deductions),
          actual: Math.abs(cos.deductions),
          difference: Math.abs(cos.deductions) - Math.abs(deductions),
          detail: `The change order summary reports ${money(Math.abs(cos.deductions))} of deductions, `
            + `but the continuation sheet carries ${money(Math.abs(deductions))} of them`
            + (Math.abs(cos.deductions) < Math.abs(deductions)
              ? ` — a credit is being reported inside the additions figure, where it cannot be seen.`
              : `.`),
        }));
      }
      if (out.length) return out;
      return pass({ where: { field: 'changeOrderSummary' } });
    },
  },

  // ---- I19  The contingency reconciles ------------------------------------------------------------
  // Change orders on this contract are drawn from an owner's contingency rather than added to
  // the contract sum. What has been allocated plus what is left must equal what was set aside —
  // if it does not, either a change order is unfunded or the allowance has been quietly topped up.
  {
    id: 'I19',
    title: 'Change orders reconcile to the contingency',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const c = app.contingency;
      if (!c || !isNum(c.originalAmount)) return skip('This contract carries no owner contingency.');
      const items = app.lineItems || [];
      const remaining = items.find(li => String(li.itemNo) === String(c.remainingItemNo));
      const orders = items.filter(li => (c.changeOrderItemNos || []).map(String).includes(String(li.itemNo)));

      if (!remaining || !isNum(remaining.c)) return skip('The remaining contingency line could not be read.');
      if (!orders.length) return skip('No change order lines were identified.');
      if (orders.some(o => !isNum(o.c))) return skip('Some change order values could not be read.');

      const allocated = orders.reduce((a, o) => a + o.c, 0);
      const total = allocated + remaining.c;
      return close(total, c.originalAmount, TOL.aggregate) ? pass({ where: { field: 'contingency' } }) : fail({
        where: { field: 'contingency' },
        expected: c.originalAmount,
        actual: total,
        difference: total - c.originalAmount,
        detail: `${money(allocated)} of change orders plus ${money(remaining.c)} still unallocated `
          + `comes to ${money(total)}, against an owner's contingency of ${money(c.originalAmount)}.`,
      });
    },
  },

  // ---- I20  The campus split ties to the payment ---------------------------------------------------
  // This contract runs four campuses on one application, and the owner is billed per campus.
  // Each campus's work this period, less retainage, must add back to Line 8.
  {
    id: 'I20',
    title: 'The campus split adds back to the payment due',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const campuses = app.campuses;
      if (!campuses?.length) return skip('This application is not split by campus.');
      const s = app.summary || {};
      if (!isNum(s.line8)) return skip('Line 8 could not be read.');
      const rate = isNum(s.line5aRate) ? s.line5aRate : app.contract?.retainageRate;
      if (!isNum(rate)) return skip('No retainage rate is available to net the campus totals down.');

      const items = app.lineItems || [];
      const unread = items.filter(li => li.campus && !isNum(li.e)).length;
      if (unread) return skip(`${unread} campus line(s) have an unreadable this-period figure.`);
      const perCampus = campuses.map(camp => {
        const rows = items.filter(li => li.campus === camp.name);
        return { name: camp.name, thisPeriod: rows.reduce((a, li) => a + li.e, 0) };
      });
      const expected = perCampus.reduce((a, c) => a + c.thisPeriod * (1 - rate), 0);

      return close(s.line8, expected, TOL.aggregate) ? pass({
        where: { field: 'line8' },
        detail: perCampus.map(c => `${c.name} ${money(c.thisPeriod * (1 - rate))}`).join(' · '),
      }) : fail({
        where: { field: 'line8' },
        expected,
        actual: s.line8,
        difference: s.line8 - expected,
        detail: `The campuses bill ${perCampus.map(c => `${c.name} ${money(c.thisPeriod)}`).join(', ')} `
          + `this period. Less ${pct(rate)} retainage that is ${money(expected)}, against a payment `
          + `due of ${money(s.line8)}.`,
      });
    },
  },

  // ---- I21  The lien waiver names the right money ---------------------------------------------------
  {
    id: 'I21',
    title: 'The lien waiver matches the payment requested',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const w = app.waiver;
      const s = app.summary || {};
      if (!w || !isNum(w.amount)) return skip('No lien waiver amount was read.');
      if (!isNum(s.line8)) return skip('Line 8 could not be read.');
      return close(w.amount, s.line8, TOL.cent) ? pass({ where: { field: 'waiver' } }) : fail({
        where: { field: 'waiver' },
        expected: s.line8,
        actual: w.amount,
        difference: w.amount - s.line8,
        detail: `The lien waiver releases against ${money(w.amount)} but the application asks for `
          + `${money(s.line8)}.`,
      });
    },
  },

  // ---- I22  The amount certified matches the amount applied for ---------------------------------------
  {
    id: 'I22',
    title: 'The amount certified matches the amount applied for',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const s = app.summary || {};
      if (!isNum(s.amountCertified)) return skip('No certified amount was read.');
      if (!isNum(s.line8)) return skip('Line 8 could not be read.');
      return close(s.amountCertified, s.line8, TOL.cent) ? pass({ where: { field: 'amountCertified' } }) : fail({
        where: { field: 'amountCertified' },
        expected: s.line8,
        actual: s.amountCertified,
        difference: s.amountCertified - s.line8,
        detail: `${money(s.amountCertified)} was certified against an application for ${money(s.line8)}. `
          + `A difference has to be explained and initialled on the form.`,
      });
    },
  },
];

// --- running them --------------------------------------------------------------------------

// Every invariant runs, always. One that cannot be evaluated returns SKIPPED with its reason,
// which is reported rather than hidden — a review that quietly checked nine of twenty-two
// things and said "no issues found" is worse than one that admits what it could not see.
function runInvariants(app) {
  const results = [];
  for (const inv of INVARIANTS) {
    let produced;
    try {
      produced = inv.run(app);
    } catch (err) {
      // A crash in one rule must not take the review with it.
      produced = skip(`This check could not be run (${err.message}).`);
    }
    for (const r of [].concat(produced)) {
      results.push({
        id: inv.id,
        title: inv.title,
        severity: r.severity || inv.severity,
        ...r,
      });
    }
  }

  const findings = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  const bySeverity = s => findings.filter(f => f.severity === s).length;

  return {
    results,
    findings,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: skipped.length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
    },
    // The PM asked for this to be explicit: a form that contradicts itself is not certifiable
    // as drawn even when the money it asks for turns out to be right.
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL)
      ? 'do-not-certify'
      : findings.length ? 'certify-with-corrections' : 'no-issues-found',
  };
}

// One wrong figure trips several invariants at once, and rightly so — a from-previous figure
// that is $7 too high fails to add up, fails to match last month, and exceeds its own scheduled
// value. All three statements are true, but printed as three findings they read as three
// problems and the report starts to feel like noise. Grouping by where the figure sits puts the
// root cause first and its consequences underneath it.
function groupFindings(findings) {
  // The key has to name the THING the finding is about. A reconciliation finding is about an
  // invoice, not a line of the G703, so the invoice number and vendor belong in the key —
  // without them every unbacked charge on an application shares one empty key and ten separate
  // problems are presented as one.
  const key = f => [
    f.where?.page,
    f.where?.itemNo,
    f.where?.ref,
    f.where?.ref ? '' : f.where?.vendor,
    f.where?.field && !f.where?.itemNo ? f.where.field : '',
  ].map(v => (v == null ? '' : String(v))).join('|');

  const groups = new Map();
  for (const f of findings) {
    const k = key(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const rank = { critical: 0, material: 1, note: 2 };
  return [...groups.values()].map(members => {
    const ordered = [...members].sort((a, b) => rank[a.severity] - rank[b.severity]);
    return {
      where: ordered[0].where,
      severity: ordered[0].severity,
      primary: ordered[0],
      alsoTrips: ordered.slice(1),
      count: ordered.length,
    };
  }).sort((a, b) => rank[a.severity] - rank[b.severity]);
}

module.exports = { INVARIANTS, runInvariants, groupFindings, SEVERITY, TOL, money, pct };
