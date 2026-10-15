const { analyzeInPasses, partNotice } = require('./pdfChunk');
const { askForJson } = require('./aiJson');

// Where in the contract each rule a change order or an invoice is checked against comes from.
//
// A finding that says "tax is not allowed" is a claim; one that says "Section 3.6 Taxes, page 4:
// 'The Contractor shall not include sales tax in any Change Order'" is something a PM can hand to
// the contractor. The contract's stored terms say WHAT the rules are; this reads WHERE each one is
// written — the section, the page and the wording itself — for what change orders and invoices are
// measured against: tax, markup limits, allowances, costs the contract forbids or restricts, what the
// agreement is worth, and what a reimbursable cost must come with.
//
// The markup limits are read here too, with their clause. Without them the markup checks fall back
// to Coaster's usual 10% and 5%, and say so, rather than cite a clause that does not say it.
//
// Read once per contract, the first time a change order or invoice is checked against it, and kept
// with the contract's terms — see ensureTermsWithClauses in lib/contractTerms.js.

const CLAUSE = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'The section or article number as printed, e.g. "Section 7.4" or "Article 3.6". Omit if none is printed.' },
    heading: { type: 'string', description: "The section's own heading as printed, e.g. \"Markup on Changes\" — not the heading of the article it sits in. Omit if the section has none." },
    page: { type: 'integer', description: 'Which page of the document you were given it is on, counting the first page as 1.' },
    quote: { type: 'string', description: 'The sentence or two that says it, copied word for word. Required.' },
  },
  required: ['quote'],
};

const TOOL = {
  name: 'record_contract_clauses',
  description: 'Record where this contract states the rules its change orders and invoices are checked against.',
  input_schema: {
    type: 'object',
    properties: {
      tax: {
        ...CLAUSE,
        description: 'The clause that says whether sales tax may be charged — a tax exemption, or a rule '
          + 'on tax in changes. Omit if the contract does not address tax.',
      },
      markups: {
        type: 'object',
        description: 'The clause that limits overhead, profit or markup on changed work. Omit if the '
          + 'contract sets no limit.',
        properties: {
          ...CLAUSE.properties,
          contractorRate: { type: 'number', description: 'The limit on the contractor\'s own markup, as a decimal (10% -> 0.10).' },
          subRate: { type: 'number', description: 'The limit on markup a contractor takes on its subcontractors\' work, or a subcontractor on its own work, as a decimal.' },
          secondTierRate: { type: 'number', description: 'The limit on markup on second-tier (sub-subcontractor) work, as a decimal.' },
        },
        required: ['quote'],
      },
      allowances: {
        type: 'object',
        description: 'The clause on allowances — whether overhead, profit or markup may be taken on '
          + 'allowance work. Omit if the contract does not address allowances.',
        properties: {
          ...CLAUSE.properties,
          markupAllowed: { type: 'boolean', description: 'True if markup may be taken on allowance work, false if not. Omit if the clause does not say.' },
        },
        required: ['quote'],
      },
      contractSum: {
        type: 'object',
        description: 'The clause that states what the agreement or purchase order is worth — the '
          + 'contract sum, fee, not-to-exceed amount or PO total. Omit if none is stated.',
        properties: {
          ...CLAUSE.properties,
          amount: { type: 'number', description: 'The amount, as a plain number.' },
        },
        required: ['quote'],
      },
      reimbursables: {
        type: 'object',
        description: 'The clause on reimbursable expenses — what must accompany them (receipts, '
          + 'invoices), and any multiplier or cap on them. Omit if the contract does not address them.',
        properties: {
          ...CLAUSE.properties,
          backupRequired: { type: 'boolean', description: 'True if reimbursable costs must be billed with receipts or other backup.' },
          multiplier: { type: 'number', description: 'The factor reimbursables are billed at, if one is stated — 1.10 for cost plus 10%.' },
        },
        required: ['quote'],
      },
      rates: {
        ...CLAUSE,
        description: 'The clause or exhibit that sets billing rates — hourly rates by role, unit rates, '
          + 'equipment rates. Quote the rates themselves. Omit if the agreement sets none.',
      },
      costRules: {
        type: 'array',
        description: 'Costs the contract forbids or restricts — overtime without written direction, '
          + 'costs without backup, equipment above a stated rate, hourly rates above a rate schedule, '
          + 'travel or meals it will not pay for. Not tax, markup percentages, the contract sum or the '
          + 'reimbursable-expense clause, which are recorded above.',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'Short name of the cost, e.g. "Overtime premium".' },
            rule: { type: 'string', description: 'What the contract says about it, in one short plain-English sentence.' },
            ...CLAUSE.properties,
          },
          required: ['item', 'quote'],
        },
      },
    },
    required: [],
  },
};

const PROMPT = `You are reading an executed construction contract, design agreement or purchase order
for the owner's project manager, who checks the change orders and invoices billed under it. Record
WHERE it states the rules they are checked against, with the record_contract_clauses tool.

Rules:
- Every "quote" is the contract's own words, copied exactly. Never paraphrase in a quote, never join
  sentences from different places, never quote a heading alone.
- Record a rule only if you can quote the wording that says it. A rule with no wording behind it must
  be left out — the PM will put these quotes in front of the contractor.
- "section" and "heading" are as printed. Leave either out rather than guess one.
- Look beyond the article headed "Changes": tax is often in the general conditions or the tax article,
  allowances in their own article, cost limits in the cost-of-the-work article or an exhibit, and on a
  design agreement the rates and reimbursable expenses in the compensation article or an exhibit.
- Rates are decimals: 10% -> 0.10.
- Return fewer, well-grounded clauses rather than a long list.`;

const clean = (c, startPage) => {
  if (!c || typeof c !== 'object' || !c.quote || !String(c.quote).trim()) return null;
  const out = { quote: String(c.quote).trim() };
  if (c.section) out.section = String(c.section).trim();
  if (c.heading) out.heading = String(c.heading).trim();
  if (Number.isInteger(c.page) && c.page > 0) out.page = c.page + startPage - 1;
  return out;
};

// One pass's answer, with its pages counted from the start of the whole contract.
function tidy(raw, startPage = 1) {
  const r = raw || {};
  const markups = clean(r.markups, startPage);
  if (markups) {
    for (const k of ['contractorRate', 'subRate', 'secondTierRate']) {
      if (typeof r.markups[k] === 'number' && r.markups[k] >= 0 && r.markups[k] < 1) markups[k] = r.markups[k];
    }
  }
  const allowances = clean(r.allowances, startPage);
  if (allowances && typeof r.allowances.markupAllowed === 'boolean') allowances.markupAllowed = r.allowances.markupAllowed;
  const contractSum = clean(r.contractSum, startPage);
  if (contractSum && typeof r.contractSum.amount === 'number' && r.contractSum.amount > 0) contractSum.amount = r.contractSum.amount;
  const reimbursables = clean(r.reimbursables, startPage);
  if (reimbursables) {
    if (typeof r.reimbursables.backupRequired === 'boolean') reimbursables.backupRequired = r.reimbursables.backupRequired;
    if (typeof r.reimbursables.multiplier === 'number' && r.reimbursables.multiplier >= 1 && r.reimbursables.multiplier < 3) reimbursables.multiplier = r.reimbursables.multiplier;
  }
  return {
    tax: clean(r.tax, startPage),
    rates: clean(r.rates, startPage),
    markups,
    allowances,
    contractSum,
    reimbursables,
    costRules: (Array.isArray(r.costRules) ? r.costRules : [])
      .map(c => {
        const cl = clean(c, startPage);
        return cl && c.item ? { item: String(c.item).trim(), rule: c.rule ? String(c.rule).trim() : null, ...cl } : null;
      })
      .filter(Boolean),
  };
}

// A long contract is read in passes. Each clause is taken from the first pass that found it — a
// section's fields are never mixed from two places, which would cite one section's number beside
// another's words — and the cost rules are gathered from all of them, once each.
function combine(passes) {
  const first = key => passes.map(p => p[key]).find(Boolean) || null;
  const seen = new Set();
  const costRules = [];
  for (const rule of passes.flatMap(p => p.costRules)) {
    const k = rule.item.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    costRules.push(rule);
  }
  return {
    tax: first('tax'), markups: first('markups'), allowances: first('allowances'),
    contractSum: first('contractSum'), reimbursables: first('reimbursables'), rates: first('rates'), costRules,
  };
}

async function readContractClauses(contractBuffer) {
  const passes = [];
  const usages = [];
  await analyzeInPasses(contractBuffer, async (buffer, context) => {
    const { data, usage } = await askForJson({
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT + partNotice(context) },
      ],
      tool: TOOL,
      cacheTool: true,
      maxTokens: 6000,
      label: 'contract clauses',
    });
    if (usage) usages.push(usage);
    passes.push(tidy(data, context?.isPart ? context.startPage : 1));
    return data;
  });
  const usage = usages.length ? {
    inputTokens: usages.reduce((sum, u) => sum + (u.input_tokens || 0), 0),
    outputTokens: usages.reduce((sum, u) => sum + (u.output_tokens || 0), 0),
  } : null;
  return { clauses: combine(passes), usage };
}

// The costs a contract forbids or restricts, once each, for a check that looks for them on a document:
// the ones its clauses name, each with its clause, and the unallowable items read with its terms. An
// unallowable item a clause also covers — "Meals" and the clause on "meals, entertainment and travel"
// — takes that clause, so it is cited and not listed twice.
const words = t => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
function forbiddenCosts(terms) {
  const ruled = (terms?.clauses?.costRules || []).map(c => ({ item: c.item, basis: c.rule || null, rule: c.rule || null, clause: c }));
  const out = [...ruled];
  for (const b of terms?.unallowableItems || []) {
    const w = words(b.item);
    const covered = ruled.find(r => w.length && w.every(x => words(`${r.item} ${r.clause.quote}`).includes(x)));
    if (covered) {
      // Looked for by the item's own short name, which is how a document prints it.
      if (!out.some(x => x.item.toLowerCase() === String(b.item).toLowerCase())) out.push({ ...covered, item: String(b.item) });
    } else if (!out.some(x => x.item.toLowerCase() === String(b.item).toLowerCase())) {
      out.push(b);
    }
  }
  return out;
}

// A section as Coaster named it, kept only when it reads like one — "7.3", "Article 11" — and not a
// word like "notes" taken from the shape of the terms it was given.
const sectionLike = v => (v && /\d/.test(String(v)) ? String(v) : null);

// "Section 7.4 Markup on Changes, page 12" — however much of that the contract printed.
function citeLabel(clause) {
  if (!clause) return null;
  const where = [clause.section, clause.heading].filter(Boolean).join(' ');
  const parts = [where, clause.page ? `page ${clause.page}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// The contract clause behind one of Coaster's own flags. Coaster is asked to copy the wording from
// the clauses the contract was read for, and a quote is only trusted when it is found there — the
// clause it is found in then supplies the section and page. One that is not found is dropped, and the
// flag keeps only the section Coaster named, rather than put words in the contract's mouth.
const squash = t => String(t || '').toLowerCase().replace(/[^a-z0-9%$.]+/g, ' ').trim();
function clauseFor(concern, terms) {
  const c = terms?.clauses;
  const quote = squash(concern.quote);
  if (!c || quote.length < 12) return null;
  const all = [c.tax, c.markups, c.allowances, c.contractSum, c.reimbursables, c.rates, ...(c.costRules || [])].filter(Boolean);
  const found = all.find(cl => squash(cl.quote).includes(quote) || quote.includes(squash(cl.quote)));
  if (!found) return null;
  const { section, heading, page, quote: q } = found;
  return { section, heading, page, quote: q };
}

module.exports = { readContractClauses, citeLabel, clauseFor, forbiddenCosts, sectionLike, tidy, combine };
