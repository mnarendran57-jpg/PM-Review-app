// Lien waivers: the document that decides whether paying is safe.
//
// The fifth family. The others ask whether the money is right. This one asks whether paying it
// extinguishes the risk it is supposed to extinguish — because an owner who pays a contractor
// without a valid release can be made to pay a subcontractor for the same work a second time,
// and no amount of correct arithmetic prevents that.
//
// What makes waivers checkable rather than a matter of judgement is that a Texas contractor's
// release carries its own schedule for payment, and that schedule restates the application:
//
//   CONTRACT AMOUNT                                     4,351,449.00   = G702 line 3
//   Total completed through date of application         737,171.91     = line 4
//   Less Retainage                                       36,858.58     = line 5
//   Total Earned Less Retainage                         700,313.33     = line 6
//   Less Previous Payments                              389,580.96     = line 7
//   AMOUNT NOW PAYABLE                                  310,732.37     = line 8
//
// Six figures sworn to under oath, which must equal six figures billed. When they diverge, the
// contractor is swearing to one number and invoicing another, and only one of those documents is
// the one the owner will be held to.
//
// The other half is coverage, and it is the half that costs money when it is missed. A waiver
// signed by the general contractor releases the general contractor's lien. It does nothing about
// the subcontractor who has not been paid — their lien rights are their own. So the question is
// never "is there a waiver", it is "is there a waiver from everybody who could file".
//
// Two kinds, and confusing them is the classic error:
//
//   conditional     "I release my lien WHEN I am paid."  Given with the current application,
//                   before payment. Worthless as proof that anyone has actually been paid.
//   unconditional   "I have been paid and I release."    Given for the PREVIOUS payment, after
//                   the money arrived. This is the one that proves last month's money reached
//                   the people who earned it.
//
// A package with only conditional waivers looks complete and proves nothing about the money
// already released. W6 exists entirely for that case.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, tol = TOL.aggregate) => Math.abs(a - b) <= tol;
const num = v => (isNum(v) ? v : 0);

const CONDITIONAL = /^conditional/;
// An affidavit of bills paid is a sworn statement that everyone downstream has already been
// paid. It does the same evidential job as an unconditional waiver and is accepted in its place.
//
// One document often does both jobs at once, and the Texas contractor's release in this project's
// packages is exactly that: paragraph 3 swears every bill incurred before the payment date is
// settled, while paragraphs 5 and 6 release the lien conditionally on the new money arriving. So
// a type may name both, and the two tests are deliberately independent rather than exclusive.
const PROVES_PAYMENT = w => /unconditional|affidavit/.test(String(w.type || ''));

const parseDate = d => {
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
};
const dayDiff = (a, b) => {
  const ta = parseDate(a);
  const tb = parseDate(b);
  return ta == null || tb == null ? null : Math.round((ta - tb) / 86400000);
};

const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/(inc|llc|lp|ltd|company|corp)$/g, '');

const sameParty = (a, b) => {
  const ka = nameKey(a);
  const kb = nameKey(b);
  return !!ka && !!kb && (ka.includes(kb) || kb.includes(ka));
};

const waiversFor = (app, party) => (app.waivers || []).filter(w => sameParty(w.party, party));

const describe = w => `${w.party}${w.type ? ` (${String(w.type).replace(/-/g, ' ')})` : ''}`;

// Which parties could put a lien on this job this period: the contractor, plus every
// subcontractor billing anything. A subcontractor billing nothing this period has nothing new to
// release, and demanding a waiver from them every month is how a real gap gets lost in noise.
function lienableParties(app) {
  const out = [];
  if (app.meta?.contractor) {
    out.push({ name: app.meta.contractor, role: 'contractor', amount: app.summary?.line8 ?? null });
  }
  for (const sub of app.subApplications || []) {
    if (num(sub.thisPeriod) <= TOL.aggregate) continue;
    out.push({
      name: sub.vendor, role: 'subcontractor',
      amount: isNum(sub.currentDue) ? sub.currentDue : sub.thisPeriod,
      previous: sub.previous ?? null,
    });
  }
  return out;
}

// --- checks ---------------------------------------------------------------------------------------

const fail = o => ({ status: 'FAIL', ...o });
const pass = o => ({ status: 'PASS', ...o });
const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });

const WAIVER_CHECKS = [

  // ---- W1  The contractor's own release is present ---------------------------------------------------
  {
    id: 'W1',
    title: "The contractor's lien release accompanies the application",
    severity: SEVERITY.CRITICAL,
    run(app) {
      const who = app.meta?.contractor;
      if (!who) return skip('The contractor was not named on the application.');
      const held = waiversFor(app, who);
      if (held.length) return pass({ where: { vendor: who } });
      return fail({
        where: { vendor: who },
        actual: app.summary?.line8 ?? null,
        detail: `No lien release from ${who} accompanies this application. Paying `
          + `${money(app.summary?.line8)} without one leaves the contractor's lien rights intact `
          + `over work the owner has already paid for.`,
      });
    },
  },

  // ---- W2  The release swears to the same figures the application bills ------------------------------
  // The check the whole family is built on. A contractor's release restates the payment schedule
  // under oath, so the two documents can be compared line for line — and a difference means one
  // of them is wrong about what is owed.
  {
    id: 'W2',
    title: "The release's payment schedule agrees with the application",
    severity: SEVERITY.CRITICAL,
    run(app) {
      const s = app.summary || {};
      // Retainage is the one figure that travels under two names — the extractor records the
      // G702's total as line5, the arithmetic engine calls it line5Total — so both are accepted.
      // A field that resolves to nothing is skipped, and a silently skipped comparison is exactly
      // how a check comes to pass without ever looking at anything.
      const FIELDS = [
        ['contractAmount', ['line3'], 'the contract amount'],
        ['completedToDate', ['line4'], 'total completed to date'],
        ['retainage', ['line5', 'line5Total'], 'retainage'],
        ['earnedLessRetainage', ['line6'], 'total earned less retainage'],
        ['previousPayments', ['line7'], 'less previous payments'],
        ['amountNowPayable', ['line8'], 'the amount now payable'],
      ];
      const withSchedule = (app.waivers || []).filter(w => w.schedule);
      if (!withSchedule.length) return skip('No waiver carries a payment schedule to compare against the application.');

      const out = [];
      for (const w of withSchedule) {
        for (const [key, lines, label] of FIELDS) {
          const sworn = w.schedule[key];
          const billed = lines.map(l => s[l]).find(isNum);
          if (!isNum(sworn) || !isNum(billed)) continue;
          out.push(close(Math.abs(sworn), Math.abs(billed))
            ? pass({ where: { vendor: w.party, field: label } })
            : fail({
              where: { vendor: w.party, field: label, page: w.page },
              expected: billed,
              actual: sworn,
              difference: sworn - billed,
              detail: `${w.party}'s lien release swears ${label} is ${money(sworn)}, but the `
                + `application bills ${money(billed)} — ${money(Math.abs(sworn - billed))} apart. `
                + `The release is a sworn document; the two cannot both be right.`,
            }));
        }
      }
      return out.length ? out : skip('No comparable figures on the waivers supplied.');
    },
  },

  // ---- W3  The release covers this period --------------------------------------------------------
  // A release stops at a date. One carried over from last month is a valid document that releases
  // nothing about the work being paid for now, and it is the easiest thing in a package to miss
  // because it looks exactly like the right one.
  {
    id: 'W3',
    title: 'Each release covers the period being paid',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const periodTo = app.meta?.periodTo;
      if (!periodTo) return skip('The application period end was not read, so waiver dates could not be checked.');
      const dated = (app.waivers || []).filter(w => w.through);
      if (!dated.length) return skip('No waiver states a through date.');
      return dated.map((w) => {
        const gap = dayDiff(w.through, periodTo);
        if (gap == null) return skip(`Could not read the through date on ${describe(w)}.`, { where: { vendor: w.party } });
        if (gap >= 0) return pass({ where: { vendor: w.party } });
        return fail({
          where: { vendor: w.party, field: 'through date', page: w.page },
          expected: periodTo,
          actual: w.through,
          detail: `${describe(w)} releases liens only for work through ${w.through}, but this `
            + `application pays for work through ${periodTo} — ${Math.abs(gap)} day(s) of work is `
            + `being paid for that no release covers.`,
        });
      });
    },
  },

  // ---- W4  The release is executed --------------------------------------------------------------
  // An unsigned or un-notarised release is a draft. It is worth exactly nothing, and it is
  // routinely filed as though it were finished.
  {
    id: 'W4',
    title: 'Each release is signed, dated and notarised',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const present = (app.waivers || []).filter(w => !w.onRecordOnly);
      if (!present.length) return skip('No waiver document was supplied to inspect.');
      const out = [];
      for (const w of present) {
        const missing = [];
        if (!w.signedBy) missing.push('a signature');
        if (!w.signedOn && !w.notaryDate) missing.push('a date');
        // Notarisation is only demanded when the form itself provides for it — many valid
        // statutory waivers carry no notary block at all, and inventing the requirement would
        // condemn correct paperwork.
        if (w.notarised === false) missing.push('notarisation');
        if (!missing.length) {
          out.push(pass({ where: { vendor: w.party } }));
          continue;
        }
        out.push(fail({
          where: { vendor: w.party, page: w.page },
          detail: `${describe(w)} is missing ${missing.join(' and ')}. Until it is executed it is a `
            + `draft, and releases nothing.`,
        }));
      }
      return out;
    },
  },

  // ---- W5  Everyone who could file a lien has released ------------------------------------------------
  // The expensive one. A general contractor's release binds the general contractor. It says
  // nothing about a subcontractor who has not been paid, whose lien rights are their own — which
  // is how an owner ends up paying for the same work twice.
  {
    id: 'W5',
    title: 'Every party billing this period has released its liens',
    severity: SEVERITY.CRITICAL,
    run(app) {
      const parties = lienableParties(app).filter(p => p.role === 'subcontractor');
      if (!parties.length) return skip('No subcontractor is billing on this application.');
      const out = [];
      for (const p of parties) {
        const held = waiversFor(app, p.name);
        if (!held.length) {
          out.push(fail({
            where: { vendor: p.name },
            actual: p.amount,
            detail: `${p.name} is billing ${money(p.amount)} this period with no lien waiver in the `
              + `package. The contractor's own release does not cover them — their lien rights are `
              + `their own, and survive the owner paying the contractor.`,
          }));
          continue;
        }
        // A waiver the audit trail proves exists but that was not enclosed is neither present nor
        // missing, and calling it either would be a lie about the evidence.
        const onRecord = held.every(w => w.onRecordOnly);
        out.push(onRecord
          ? skip(`A lien waiver is recorded for ${p.name} but the document was not enclosed, so its `
            + `amount and dates could not be checked.`, { where: { vendor: p.name } })
          : pass({ where: { vendor: p.name } }));
      }
      return out;
    },
  },

  // ---- W6  Last period's money is proved to have arrived ---------------------------------------------
  // Conditional waivers are promises; unconditional ones are receipts. A package can be full of
  // the first and prove nothing about money already paid out, which is precisely the exposure a
  // waiver file is supposed to close.
  {
    id: 'W6',
    title: 'The previous payment is covered by an unconditional release',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const priorPaid = app.summary?.line7;
      if (!isNum(priorPaid) || priorPaid <= TOL.aggregate) {
        return skip('Nothing has been paid on this contract yet, so there is no prior payment to prove.');
      }
      const waivers = app.waivers || [];
      if (!waivers.length) return skip('No waivers were supplied.');
      const proofs = waivers.filter(PROVES_PAYMENT);
      if (proofs.length) return pass({});
      const kinds = [...new Set(waivers.map(w => String(w.type || 'unstated').replace(/-/g, ' ')))];
      return fail({
        actual: priorPaid,
        detail: `${money(priorPaid)} has already been paid on this contract, but every waiver in `
          + `the package is ${kinds.join(' or ')} — a promise to release on payment, not evidence `
          + `that payment was received. Nothing here shows the money already released reached the `
          + `people who earned it. Ask for unconditional releases covering the prior payment.`,
      });
    },
  },

  // ---- W7  A waiver releases what was actually billed ---------------------------------------------
  {
    id: 'W7',
    title: 'Each waiver covers the amount that party is billing',
    severity: SEVERITY.MATERIAL,
    run(app) {
      const out = [];
      for (const p of lienableParties(app)) {
        if (!isNum(p.amount)) continue;
        for (const w of waiversFor(app, p.name)) {
          // The contractor's release carries its whole schedule and is compared field by field in
          // W2; comparing its headline amount again here would report one problem twice.
          if (w.schedule || w.onRecordOnly || !isNum(w.amount)) continue;
          if (CONDITIONAL.test(String(w.type || '')) || !w.type) {
            out.push(close(w.amount, p.amount) ? pass({ where: { vendor: p.name } }) : fail({
              where: { vendor: p.name, page: w.page },
              expected: p.amount,
              actual: w.amount,
              difference: w.amount - p.amount,
              detail: `${describe(w)} releases ${money(w.amount)}, but ${p.name} is being paid `
                + `${money(p.amount)} this period. `
                + `${w.amount < p.amount
                  ? `${money(p.amount - w.amount)} is being paid that no release covers.`
                  : 'The release is for more than is being paid, which is worth confirming was intended.'}`,
            }));
          }
        }
      }
      return out.length ? out : skip('No party-level waiver amount was available to compare.');
    },
  },

  // ---- W8  Say what the waiver review did not cover -----------------------------------------------
  {
    id: 'W8',
    title: 'Coverage of the lien waiver review',
    severity: SEVERITY.NOTE,
    run(app) {
      const parties = lienableParties(app);
      const waivers = app.waivers || [];
      if (!waivers.length) {
        return skip(`No lien waivers were supplied with this application, so none were checked. `
          + `${parties.length} part${parties.length === 1 ? 'y' : 'ies'} could file a lien for work `
          + `billed this period.`);
      }
      const onRecord = waivers.filter(w => w.onRecordOnly);
      const parts = [
        `${waivers.length} waiver(s) considered for ${parties.length} part${parties.length === 1 ? 'y' : 'ies'} `
        + `billing this period.`,
      ];
      if (onRecord.length) {
        parts.push(`${onRecord.length} of them (${[...new Set(onRecord.map(w => w.party))].join(', ')}) `
          + `are recorded as submitted but were not enclosed in the package, so their amounts and `
          + `dates could not be checked — only that they exist.`);
      }
      return skip(parts.join(' '));
    },
  },
];

function runWaiverChecks(app) {
  const results = [];
  const stamp = (chk, r) => results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r });

  for (const chk of WAIVER_CHECKS) {
    let produced;
    try {
      produced = chk.run(app);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r => stamp(chk, r));
  }

  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;
  return {
    results,
    findings,
    parties: lienableParties(app),
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      waivers: (app.waivers || []).length,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      // Notes do not move the verdict. They print under a heading that says no action is
      // expected, so letting one downgrade an otherwise clean application would have the
      // report contradict itself.
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
  };
}

// The table the report prints: who could file a lien, what they are owed, and what is on file for
// them. A reader should be able to satisfy themselves that nobody is missing by reading a column,
// which is not something a list of findings can do.
function waiverTable(app) {
  return lienableParties(app).map((p) => {
    const held = waiversFor(app, p.name);
    const proves = held.some(PROVES_PAYMENT);
    const conditional = held.some(w => CONDITIONAL.test(String(w.type || '')));
    return {
      party: p.name,
      role: p.role,
      amount: p.amount,
      waivers: held.map(w => String(w.type || 'unstated').replace(/-/g, ' ')),
      through: held.map(w => w.through).filter(Boolean)[0] || null,
      status: !held.length ? 'none on file'
        : held.every(w => w.onRecordOnly) ? 'on record, not enclosed'
          : proves && conditional ? 'complete'
            : conditional ? 'conditional only'
              : 'unconditional only',
    };
  });
}

module.exports = { WAIVER_CHECKS, runWaiverChecks, waiverTable, lienableParties };
