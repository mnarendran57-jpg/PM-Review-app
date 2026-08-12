// Tax: who pays it, and what the contract says about it.
//
// The seventh family. Every other engine can settle its question with arithmetic. This one cannot,
// because the same $412.50 of sales tax is a legitimate reimbursable cost or a charge the
// contractor must absorb depending entirely on WHAT WAS BOUGHT — and the rule that decides it is
// written in the contract, not in any law this program is entitled to apply.
//
// The distinction the PM's own review turns on:
//
//   CONSUMED OR KEPT     furniture, fuel, blades, safety supplies, shop consumables. Bought,
//                        used up or retained. The contractor or its subcontractor pays the tax
//                        on these and does not bill it on.
//   RENTED               a crane, a tractor, portable equipment, a lift. Hired for a period and
//                        given back. The tax on the rental IS a job cost and can be billed.
//
// Both appear on subcontractor breakdowns in the same format, in the same column, at the same
// rate, and nothing in the figures tells them apart. Only the description does. So this engine
// reads the description, and where the description will not settle it, it says so and asks —
// rather than approving a charge nobody looked at, which is how the tax got through before.
//
// THREE RULES ABOUT ITS OWN AUTHORITY, which matter more here than anywhere else in the review:
//
//   1. THE CONTRACT DECIDES, NOT THIS FILE. Treatments come from the executed contract, read once
//      when it is uploaded and stored on the project. Where the contract is silent, the finding
//      says the contract is silent and asks for a ruling. It never supplies a rule of its own.
//
//   2. NO TAX-LAW DETERMINATION. Whether a purchase is taxable in a jurisdiction is a question for
//      a tax adviser. What this checks is whether the charge matches the agreement, and whether
//      the arithmetic on it holds.
//
//   3. A GUESS IS DECLARED AS A GUESS. When a category comes from the words on an invoice rather
//      than from the document stating it, the finding says which words it read. A PM can overrule
//      a sentence they can see; they cannot overrule a hunch they cannot.

const { SEVERITY, TOL, money } = require('./payAppInvariants');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : 0);
const sum = (list, f) => (list || []).reduce((a, x) => a + num(f(x)), 0);
const pct = r => `${(r * 100).toFixed(r * 100 % 1 ? 3 : 2).replace(/\.?0+$/, '')}%`;

// Tax lines are small and numerous. Below this a finding costs a reader more attention than the
// money is worth, and burying three real ones under forty trivial ones is how a report gets
// skimmed. The total of everything under the floor is still reported, as one line.
const FLOOR = 25;

// --- what was bought -----------------------------------------------------------------------------

const CATEGORY = {
  CONSUMABLE: 'consumable',       // used up on the job and gone
  FURNISHING: 'furnishing',       // bought and kept — furniture, appliances, tools
  MATERIAL: 'material',           // becomes part of the building
  RENTAL: 'rental',               // hired for a period and handed back
  LABOR: 'labor',
  FREIGHT: 'freight',
  UNKNOWN: 'unknown',
};

const LABEL = {
  [CATEGORY.CONSUMABLE]: 'consumable supplies',
  [CATEGORY.FURNISHING]: 'purchased equipment or furnishings',
  [CATEGORY.MATERIAL]: 'materials built into the work',
  [CATEGORY.RENTAL]: 'equipment rental',
  [CATEGORY.LABOR]: 'labour',
  [CATEGORY.FREIGHT]: 'freight or delivery',
  [CATEGORY.UNKNOWN]: 'an unidentified purchase',
};

// Read from the words on the charge. Each pattern is paired with the phrase that fired it, because
// the finding has to be able to say "read as a rental because the invoice says 'monthly rental
// rate'" — a reviewer can then agree or overrule in one glance.
//
// Rentals are tested FIRST and deliberately: a rented generator and a bought generator are
// described almost identically apart from the word "rental", and the consumable patterns are
// broad enough to catch the fuel line on a rental invoice.
const TELLS = [
  [CATEGORY.RENTAL, /\brent(?:al|als|ed|ing)?\b|\bleas(?:e|ed|ing)\b|\bhire[ds]?\b|\bmonthly rate\b|\bper (?:day|week|month)\b|\bdaily rate\b|\bre-?rent\b/i],
  [CATEGORY.FURNISHING, /\bfurniture\b|\bfurnishing/i, /\bdesk\b|\bchair\b|\bcasework\b|\bappliance/i, /\boffice equipment\b/i],
  [CATEGORY.CONSUMABLE, /\bconsumable/i, /\bfuel\b|\bdiesel\b|\bgasoline\b|\bpropane\b/i,
    /\bblade[s]?\b|\bdrill bit|\babrasive|\bsandpaper\b/i,
    /\bglove[s]?\b|\bPPE\b|\bsafety (?:supplies|equipment|gear)\b|\bhard hat/i,
    /\b(?:shop|misc(?:ellaneous)?|job(?:site)?|field) supplies\b/i, /\bform oil\b|\bfastener|\bcaulk\b|\btape\b/i],
  [CATEGORY.FREIGHT, /\bfreight\b|\bdelivery charge\b|\bshipping\b|\bhaul(?:ing|age)?\b/i],
  [CATEGORY.LABOR, /\blabou?r\b|\bpayroll\b|\bman[- ]?hours?\b|\bstraight time\b|\bovertime\b/i],
];

// Rental houses. A vendor whose entire business is hiring equipment out is strong evidence on an
// invoice whose line description is unhelpfully terse — "Inv 44812, equipment, $2,340.00".
const RENTAL_HOUSES = /united rentals|sunbelt|herc rental|ahern|cat(?:erpillar)? rental|nations ?rent|rsc equipment|h&e equipment|bigge|maxim crane|all ?erection|scaffold|portable (?:toilet|restroom)|united site services|texas toilets|mobile mini|williams scotsman/i;

function classify(charge) {
  // Declared beats inferred, always. If the package says what this is — a rental statement, a
  // line under a "Consumables" heading — that is the answer and no pattern is consulted.
  if (charge.category && Object.values(CATEGORY).includes(charge.category)) {
    return { category: charge.category, why: 'stated in the package', inferred: false };
  }
  const text = [charge.description, charge.chargeDescription, charge.ref].filter(Boolean).join(' ');
  for (const [category, ...patterns] of TELLS) {
    for (const p of patterns) {
      const hit = p.exec(text);
      if (hit) return { category, why: `the charge reads "${hit[0]}"`, inferred: true };
    }
  }
  if (RENTAL_HOUSES.test(String(charge.vendor || ''))) {
    return { category: CATEGORY.RENTAL, why: `${charge.vendor} is an equipment rental supplier`, inferred: true };
  }
  return { category: CATEGORY.UNKNOWN, why: 'nothing on the charge says what was bought', inferred: true };
}

// --- what the contract says about that category ----------------------------------------------------

const TREATMENT = {
  REIMBURSABLE: 'reimbursable',        // the owner pays it
  ABSORBED: 'contractor-absorbs',      // the contractor pays it and may not bill it on
  EXEMPT: 'exempt',                    // should not have been charged at all
};

// A ruling the PM has already given on this project outranks everything: it is a decision by the
// person who is entitled to make it. Same mechanism the backup engine uses for cost rulings, and
// for the same reason — a question settled in April should not be asked again in May.
function rulingFor(app, charge, category) {
  return (app.taxRulings || []).find(r =>
    (r.category && r.category === category)
    || (r.vendor && String(charge.vendor || '').toLowerCase().includes(String(r.vendor).toLowerCase()))
    || (r.ref && String(r.ref) === String(charge.ref)));
}

function treatmentFor(app, charge, category) {
  const ruled = rulingFor(app, charge, category);
  if (ruled && ruled.treatment) {
    return { treatment: ruled.treatment, basis: ruled.note || 'ruled on this project', source: 'ruling' };
  }
  const rule = (app.taxRules?.categories || []).find(c => c.category === category);
  if (rule && rule.treatment) {
    return { treatment: rule.treatment, basis: rule.basis || null, source: 'contract' };
  }
  return { treatment: null, basis: null, source: null };
}

// Everything worth saying about one tax charge, worked out once.
function survey(app) {
  return (app.taxes || []).filter(t => num(t.amount) > TOL.cent).map((t) => {
    const c = classify(t);
    const { treatment, basis, source } = treatmentFor(app, t, c.category);
    // Expected tax, where the invoice gives enough to compute it. A rate against a base is the
    // one part of this file that IS arithmetic, and it catches tax charged on the marked-up total
    // rather than on the cost.
    const expected = isNum(t.taxableBase) && isNum(t.rate)
      ? Math.round(t.taxableBase * t.rate * 100) / 100 : null;
    return {
      charge: t,
      amount: num(t.amount),
      ...c,
      treatment,
      basis,
      source,
      expected,
      overstated: expected != null ? Math.round((num(t.amount) - expected) * 100) / 100 : null,
    };
  });
}

const skip = (detail, o = {}) => ({ status: 'SKIPPED', detail, ...o });
const who = t => `${t.charge.vendor || 'A vendor'}${t.charge.ref ? ` ${t.charge.ref}` : ''}`;
const because = t => (t.inferred ? `, read as ${LABEL[t.category]} because ${t.why}` : ` (${LABEL[t.category]})`);

// Findings below the floor are worth counting, not worth a paragraph each.
function roll(items, sentence) {
  const total = sum(items, i => i.amount);
  return { total, sentence: sentence(items.length, money(total)) };
}

const TAX_CHECKS = [
  // ---- T1  Were the contract's tax rules read at all? ------------------------------------------
  // The gate, and it does not block: a package can still be checked for arithmetic and for tax on
  // an exempt owner without any contract on file. What it must not do is stay quiet, because a
  // review that never opened the contract has not checked tax compliance and should not be read
  // as though it had.
  {
    id: 'T1',
    title: "The contract's tax provisions were available to check against",
    severity: SEVERITY.NOTE,
    run(app, taxes) {
      const rules = app.taxRules?.categories || [];
      if (rules.length) {
        return { status: 'PASS',
          detail: `The contract's tax provisions were read and cover ${rules.length} `
            + `categor${rules.length === 1 ? 'y' : 'ies'} of purchase `
            + `(${rules.map(r => LABEL[r.category] || r.category).join(', ')}). Every tax charge `
            + 'below is measured against them.' };
      }
      if (!taxes.length) {
        return skip('No sales tax was found on the backup supplied, and the contract on file '
          + 'states no tax rules, so nothing was checked.');
      }
      return {
        status: 'FAIL',
        severity: SEVERITY.NOTE,
        actual: sum(taxes, t => t.amount),
        detail: `${money(sum(taxes, t => t.amount))} of tax is billed across ${taxes.length} `
          + 'charge(s) and no tax provisions were read from a contract for this project, so '
          + 'whether the owner owes it cannot be settled here. Upload the executed contract, or '
          + 'record the tax rules on the project, and this becomes a check rather than a question.',
      };
    },
  },

  // ---- T2  Tax the contractor is supposed to absorb, billed to the owner -------------------------
  // The case this file was built for. A subcontractor buys furniture, or fuel, or safety supplies,
  // pays sales tax on them as any purchaser would, and puts the tax on the breakdown. It is a real
  // tax on a real purchase, correctly calculated, and under this contract it is not the owner's.
  {
    id: 'T2',
    title: 'No tax is billed that the contract makes the contractor or subcontractor absorb',
    severity: SEVERITY.MATERIAL,
    run(app, taxes) {
      const absorbed = taxes.filter(t => t.treatment === TREATMENT.ABSORBED
        || t.treatment === TREATMENT.EXEMPT);
      if (!absorbed.length) {
        return (app.taxRules?.categories || []).length
          ? { status: 'PASS', detail: 'No tax is billed in a category the contract assigns to the '
              + 'contractor.' }
          : skip('The contract states no category the contractor must absorb, so no tax was '
            + 'questioned on that basis.');
      }
      const big = absorbed.filter(t => t.amount >= FLOOR);
      const small = absorbed.filter(t => t.amount < FLOOR);
      const out = big.map(t => ({
        status: 'FAIL',
        severity: SEVERITY.MATERIAL,
        where: { vendor: t.charge.vendor, ref: t.charge.ref, itemNo: t.charge.code },
        actual: t.amount,
        difference: t.amount,
        detail: `${money(t.amount)} of tax on ${LABEL[t.category]} is billed to the owner, and `
          + `under this contract ${t.source === 'ruling' ? 'and the ruling given on this project '
            : ''}the ${t.treatment === TREATMENT.EXEMPT ? 'purchase is exempt' : 'contractor pays it'}. `
          + `${who(t)}${t.inferred ? ` — ${t.why}` : ''}. `
          + `${t.basis ? `The contract says: "${t.basis}". ` : ''}`
          + 'Deduct it, or ask the contractor to show why this purchase falls outside that clause.',
      }));
      if (small.length) {
        const r = roll(small, (n, m) => `${m} of tax on consumables and purchased items is billed `
          + `across ${n} smaller charge(s), each under ${money(FLOOR)}. Individually they are not `
          + 'worth a letter; together they are worth a deduction.');
        out.push({
          status: 'FAIL',
          severity: SEVERITY.NOTE,
          actual: r.total,
          detail: r.sentence,
        });
      }
      return out;
    },
  },

  // ---- T3  Rental tax, which usually IS billable -------------------------------------------------
  // Included for a reason that has nothing to do with catching anybody. A report that only ever
  // speaks up about tax teaches its reader that tax is always a problem, and the next time a
  // perfectly proper crane rental tax appears they will query it and be wrong in front of the
  // contractor. Saying which tax is correct is part of saying which tax is not.
  {
    id: 'T3',
    title: 'Tax on rented equipment is treated as the contract allows',
    severity: SEVERITY.MATERIAL,
    run(app, taxes) {
      const rentals = taxes.filter(t => t.category === CATEGORY.RENTAL);
      if (!rentals.length) return skip('No tax on rented equipment was found on this application.');

      const wrong = rentals.filter(t => t.treatment === TREATMENT.ABSORBED
        || t.treatment === TREATMENT.EXEMPT);
      if (wrong.length) {
        return wrong.map(t => ({
          status: 'FAIL',
          severity: SEVERITY.MATERIAL,
          where: { vendor: t.charge.vendor, ref: t.charge.ref },
          actual: t.amount,
          detail: `${money(t.amount)} of tax on ${LABEL[t.category]} is billed by ${who(t)}, and `
            + 'this contract does not make rental tax reimbursable. '
            + `${t.basis ? `It says: "${t.basis}". ` : ''}`
            + 'Rental tax is billable on most contracts, so confirm the clause before deducting it.',
        }));
      }
      const total = sum(rentals, t => t.amount);
      const allowed = rentals.filter(t => t.treatment === TREATMENT.REIMBURSABLE).length;
      return {
        status: 'PASS',
        detail: `${money(total)} of tax on rented equipment is billed across ${rentals.length} `
          + `charge(s) and is properly the owner's cost`
          + `${allowed ? ' under the contract' : ' — the contract is silent, and rental tax is '
            + 'normally reimbursable'}. Nothing to do.`,
      };
    },
  },

  // ---- T4  Tax charged despite the owner's exemption ---------------------------------------------
  // The older question, kept and narrowed. Materials built into the work on an exempt project
  // should be bought on the exemption certificate; tax on them is avoidable, and an avoidable tax
  // is the contractor's to have avoided.
  {
    id: 'T4',
    title: "The owner's tax exemption was used where it applies",
    severity: SEVERITY.MATERIAL,
    run(app, taxes) {
      if (!app.contract?.ownerTaxExempt) {
        return skip('The owner is not recorded as tax exempt, so tax was not questioned on that '
          + 'basis. If that is wrong, it is a contract term worth correcting — it changes every '
          + 'tax finding on every application.');
      }
      // Materials only, and deliberately not the unidentified ones. An earlier version swept in
      // anything it could not classify, and the report then told a contractor to credit back tax
      // on a charge that T7, four paragraphs below, admitted it could not identify — accusing and
      // shrugging about the same $318.40 on one page. A charge nobody can place is T7's to ask
      // about, not this rule's to condemn.
      const exemptable = taxes.filter(t => t.category === CATEGORY.MATERIAL
        && t.treatment !== TREATMENT.REIMBURSABLE && t.amount >= TOL.cent);
      if (!exemptable.length) {
        return { status: 'PASS', detail: 'No tax is billed on materials that the owner\'s '
          + 'exemption certificate would have covered.' };
      }
      const total = sum(exemptable, t => t.amount);
      return exemptable.filter(t => t.amount >= FLOOR).map(t => ({
        status: 'FAIL',
        severity: SEVERITY.MATERIAL,
        where: { vendor: t.charge.vendor, ref: t.charge.ref },
        actual: t.amount,
        difference: t.amount,
        detail: `${who(t)} bills ${money(t.amount)} of sales tax on ${LABEL[t.category]}, passed `
          + `through to an owner that is exempt from it${app.contract?.taxExemptBasis
            ? ` (${app.contract.taxExemptBasis})` : ''}. `
          + `${exemptable.length > 1 ? `${money(total)} of tax appears across ${exemptable.length} `
            + 'charges on this application. ' : ''}`
          + 'The purchase should have been made on the exemption certificate, and tax that was '
          + 'avoidable is the contractor\'s to credit back.',
      })).concat(exemptable.every(t => t.amount < FLOOR) ? [{
        status: 'FAIL',
        severity: SEVERITY.NOTE,
        actual: total,
        detail: `${money(total)} of small tax charges are billed to a tax-exempt owner across `
          + `${exemptable.length} invoice(s). Each is trivial; the pattern is worth a word to the `
          + 'contractor about buying on the certificate.',
      }] : []);
    },
  },

  // ---- T5  The tax arithmetic ---------------------------------------------------------------------
  // Free, and it catches the quiet one: tax computed on the marked-up total instead of on the
  // cost. The rate is right, the arithmetic is right, and the base is the contractor's price
  // rather than the invoice.
  {
    id: 'T5',
    title: 'Tax is calculated on the right base at the right rate',
    severity: SEVERITY.MATERIAL,
    run(app, taxes) {
      const computable = taxes.filter(t => t.expected != null);
      if (!computable.length) {
        return skip('No tax charge states both a taxable base and a rate, so none could be '
          + 'recalculated. Only the amounts themselves were checked.');
      }
      const wrong = computable.filter(t => Math.abs(t.overstated) > TOL.cent);
      if (!wrong.length) {
        return { status: 'PASS', detail: `${computable.length} tax charge(s) were recalculated `
          + 'from their own base and rate and all agree.' };
      }
      return wrong.filter(t => Math.abs(t.overstated) >= 1).map(t => ({
        status: 'FAIL',
        severity: SEVERITY.MATERIAL,
        where: { vendor: t.charge.vendor, ref: t.charge.ref },
        expected: t.expected,
        actual: t.amount,
        difference: t.overstated,
        detail: `${who(t)} bills ${money(t.amount)} of tax, but ${pct(t.charge.rate)} of the `
          + `${money(t.charge.taxableBase)} base it states is ${money(t.expected)} — `
          + `${money(Math.abs(t.overstated))} ${t.overstated > 0 ? 'more' : 'less'} than the `
          + 'invoice charges. The usual cause of an overstatement is tax taken on the marked-up '
          + 'total rather than on the cost.',
      }));
    },
  },

  // ---- T6  Fee taken on top of tax ------------------------------------------------------------------
  // A contractor's fee is a fee on the cost of the work. Tax is not the cost of the work, and a
  // percentage taken across a total that includes it earns the contractor a margin on the state's
  // money. Small, certain, and never noticed.
  {
    id: 'T6',
    title: 'The contract fee is not taken on top of tax',
    severity: SEVERITY.NOTE,
    run(app, taxes) {
      const rate = app.contract?.feeRate;
      if (!isNum(rate)) return skip('No contract fee rate was captured, so fee on tax was not checked.');
      if (app.taxRules?.markupOnTaxAllowed === true) {
        return skip('This contract permits markup on tax, so the fee taken across it was not '
          + 'questioned.');
      }
      const marked = taxes.filter(t => t.charge.inFeeBase === true);
      if (!marked.length) {
        return skip('No tax charge is recorded as sitting inside the base the fee is taken on, so '
          + 'fee on tax could not be checked. It is worth a spot check on the invoice: the fee '
          + 'should be a percentage of cost, not of cost plus tax.');
      }
      const base = sum(marked, t => t.amount);
      const fee = Math.round(base * rate * 100) / 100;
      return {
        status: 'FAIL',
        severity: SEVERITY.NOTE,
        actual: fee,
        difference: fee,
        detail: `The ${pct(rate)} contract fee is taken across ${money(base)} of tax, earning `
          + `${money(fee)} of fee on tax. ${app.taxRules?.markupOnTaxAllowed === false
            ? 'The contract does not allow markup on tax.'
            : 'The contract is silent on markup over tax, so this is a question rather than an '
              + 'error.'} It is small, and it recurs every application.`,
      };
    },
  },

  // ---- T7  Tax nobody can classify -------------------------------------------------------------------
  // The honest residue. A charge that says "tax — $318.40" against a vendor nobody recognises is
  // not evidence of anything, and the one thing this engine must never do is wave it through
  // because it could not think of an objection.
  {
    id: 'T7',
    title: 'Every tax charge is identified well enough to rule on',
    severity: SEVERITY.NOTE,
    run(app, taxes) {
      const blind = taxes.filter(t => t.category === CATEGORY.UNKNOWN && !t.treatment);
      if (!taxes.length) return skip('No sales tax was found on the backup supplied.');
      if (!blind.length) {
        return { status: 'PASS', detail: `All ${taxes.length} tax charge(s) on this application `
          + 'could be identified well enough to rule on.' };
      }
      const total = sum(blind, t => t.amount);
      // On an exempt owner this stops being housekeeping. Whatever the purchase turns out to be,
      // tax reached a body that does not pay tax, and somebody has to say why before it is
      // certified — so it carries the weight the retired S7 gave it. Off an exempt job an
      // unidentified tax charge is a question, not a problem.
      const exempt = !!app.contract?.ownerTaxExempt;
      return {
        status: 'FAIL',
        severity: exempt ? SEVERITY.MATERIAL : SEVERITY.NOTE,
        actual: total,
        detail: `${money(total)} of tax across ${blind.length} charge(s) could not be identified as `
          + 'a rental, a consumable or a material, so no rule was applied to it and it has been '
          + `neither approved nor questioned: ${blind.slice(0, 4).map(t => who(t)).join(', ')}`
          + `${blind.length > 4 ? `, and ${blind.length - 4} more` : ''}. `
          + (exempt ? 'This owner is exempt from sales tax, so tax reaching them needs an '
            + 'explanation whatever was bought — a rental is reimbursable, a purchase should have '
            + 'been made on the exemption certificate, and this is neither until somebody says. '
            : '')
          + 'Ask the contractor what was bought. Once a category is ruled on for a vendor, it '
          + 'stops being asked.',
      };
    },
  },

  // ---- T8  What the tax review covered -----------------------------------------------------------------
  {
    id: 'T8',
    title: 'What the tax review covered',
    severity: SEVERITY.NOTE,
    run(app, taxes) {
      if (!taxes.length) {
        return skip('No separate tax line appears on any backup document read from this package, '
          + 'so no tax was reviewed. That is not the same as no tax being charged — tax buried in '
          + 'a lump-sum invoice line cannot be seen.');
      }
      const byCategory = {};
      for (const t of taxes) byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
      const parts = Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([c, amt]) => `${money(amt)} on ${LABEL[c] || c}`);
      return skip(`${money(sum(taxes, t => t.amount))} of tax was read from ${taxes.length} `
        + `charge(s) on the backup and classified: ${parts.join(', ')}. Tax included inside a `
        + 'lump-sum invoice line, rather than shown separately, cannot be seen and was not checked.');
    },
  },
];

function runTaxChecks(app) {
  const taxes = survey(app);
  const results = [];
  for (const chk of TAX_CHECKS) {
    let produced;
    try {
      produced = chk.run(app, taxes);
    } catch (err) {
      produced = skip(`This check could not be run (${err.message}).`);
    }
    [].concat(produced).forEach(r =>
      results.push({ id: chk.id, title: chk.title, severity: r.severity || chk.severity, ...r }));
  }

  const findings = results.filter(r => r.status === 'FAIL');
  const bySeverity = s => findings.filter(f => f.severity === s).length;

  // What a PM would actually deduct. Stated separately from the findings because it is the one
  // number that leaves this engine and lands on a payment certificate.
  const deduct = taxes.filter(t => t.treatment === TREATMENT.ABSORBED || t.treatment === TREATMENT.EXEMPT);

  return {
    results,
    findings,
    taxes,
    summary: {
      checksRun: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: findings.length,
      skipped: results.filter(r => r.status === 'SKIPPED').length,
      critical: bySeverity(SEVERITY.CRITICAL),
      material: bySeverity(SEVERITY.MATERIAL),
      notes: bySeverity(SEVERITY.NOTE),
      taxCharges: taxes.length,
      taxBilled: sum(taxes, t => t.amount),
      taxToDeduct: sum(deduct, t => t.amount),
      unclassified: taxes.filter(t => t.category === CATEGORY.UNKNOWN).length,
    },
    verdict: findings.some(f => f.severity === SEVERITY.CRITICAL) ? 'do-not-certify'
      : findings.some(f => f.severity === SEVERITY.MATERIAL) ? 'certify-with-corrections'
        : 'no-issues-found',
  };
}

// One row per tax charge: what was bought, what the contract says about it, and who pays. The
// findings say what is wrong; this says what was looked at, so a reviewer can satisfy themselves
// that a quiet charge is quiet because it is right.
const VERDICT_WORD = {
  [TREATMENT.REIMBURSABLE]: 'owner pays',
  [TREATMENT.ABSORBED]: 'contractor pays',
  [TREATMENT.EXEMPT]: 'should not be charged',
};

function taxTable(taxes) {
  if (!taxes || !taxes.length) return null;
  return taxes.map(t => ({
    vendor: t.charge.vendor || '—',
    ref: t.charge.ref || null,
    description: t.charge.description || t.charge.chargeDescription || null,
    amount: t.amount,
    category: LABEL[t.category],
    inferred: t.inferred,
    why: t.why,
    basis: t.basis,
    source: t.source,
    verdict: t.treatment ? VERDICT_WORD[t.treatment] : 'needs a ruling',
  }));
}

module.exports = {
  TAX_CHECKS, runTaxChecks, taxTable, classify, survey, CATEGORY, TREATMENT, LABEL,
};
