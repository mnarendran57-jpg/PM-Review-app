const { askForJson } = require('./aiJson');

// Alternatives to what the estimate priced.
//
// The question this answers is the one an owner asks a week after they get a price: "is there
// another way to do this?" Today that costs an email to the architect, two or three days of
// silence, and a meeting. Nothing here replaces the architect — it puts a shortlist in the
// owner's hand so the conversation starts at "is this feasible on my building?" instead of at
// "what else is there?"
//
// THE OUTPUT IS A TABLE. Each item, its alternatives, and what each one would do to the cost.
// Nothing else. An earlier version also produced a trade-off paragraph, a caution, a confidence
// grade and a question to send the architect for every option — four paragraphs a row, which on a
// twenty-row estimate is a document nobody finishes. What survives is what the owner actually
// scans for: the swap, and what it costs.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// Coaster has no RS Means licence and no live pricing feed, so this cannot and must not quote a
// unit price. What the model does hold is the shape of the market — that a wood panel rainscreen
// and a fibre-cement one are alternatives, and roughly how they compare. So the cost column is a
// PERCENTAGE BAND against the line's own amount, never a dollar figure, and never a number narrow
// enough to be mistaken for a quote. A percentage cannot be quoted back at the PM as a price.
//
// The other discipline is silence. An estimate line that is already the sensible choice must come
// back with no alternatives at all. A report that finds three options for every one of twenty rows
// is not thorough, it is noise, and it buries the two rows where there was real money.

const OPTION = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'The alternative in a few words, named the way a supplier would name it, so it '
        + 'can be searched for. "Fibre-cement rainscreen panel", not "a cheaper cladding".',
    },
    whatItIs: {
      type: 'string',
      description: 'ONE short sentence saying what it is, for somebody who has never built '
        + 'anything. No trade jargon and no abbreviation you have not expanded. This is the only '
        + 'explanation the owner gets, so it has to stand on its own — but it is one sentence, not '
        + 'a paragraph.',
    },
    savingsLowPct: {
      type: 'number',
      description: 'Low end of the cost difference, as a percentage of THIS line item. A positive '
        + 'number means it costs LESS than what was priced; a negative number means it costs MORE. '
        + 'Leave both ends null where the honest answer is that it depends on the design — an '
        + 'invented number is worse than no number.',
    },
    savingsHighPct: {
      type: 'number',
      description: 'High end of the same band, greater than or equal to savingsLowPct. Keep the '
        + 'band wide enough to be honest: narrower than about five points is claiming a precision '
        + 'nobody has without a current quote.',
    },
    note: {
      type: 'string',
      description: 'At most one short sentence, and only where there is something the owner would '
        + 'be annoyed to discover later — the main thing given up, or the one condition that could '
        + 'rule the option out. Null far more often than not. Do not use it to restate the '
        + 'description, and do not pad every row with a caveat.',
    },
  },
  required: ['name', 'whatItIs'],
};

const OPTIONS_TOOL = {
  name: 'record_value_options',
  description: 'List alternative ways to build each cost estimate line item.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per line item you were given, in the same order, including the '
          + 'ones you found nothing for. Never skip a line — a missing entry reads as an oversight.',
        items: {
          type: 'object',
          properties: {
            lineIndex: {
              type: 'integer',
              description: 'The index number printed beside the line item you were given. Copy it '
                + 'exactly; it is how the answer is matched back to the estimate.',
            },
            options: { type: 'array', description: 'The alternatives worth considering. May be empty.', items: OPTION },
            noOptionsReason: {
              type: 'string',
              description: 'Required when options is empty: one short sentence on why this item '
                + 'should stay as priced. "This is the standard way to do it" is a real answer. '
                + 'Null when there are options.',
            },
          },
          required: ['lineIndex', 'options'],
        },
      },
    },
    required: ['items'],
  },
};

const OPTIONS_SYSTEM = `You are advising a building owner who has just received a construction cost
estimate and wants to know what choices they have before they accept it.

WHAT YOU PRODUCE. A table. For each line item: the alternatives, and what each would do to the cost.
Nothing else — no recommendations, no essays, no questions to forward. Just the swap and the number.

WHO IS READING IT. The owner. They are paying for the building and they are not in construction —
a school district business manager, a hospital administrator, a church board. Every alternative gets
one plain sentence they can understand without asking anyone what a word means. Spell out trade
terms. Never use an abbreviation you have not expanded.

THE RULES ABOUT COST. You have no current price data. You do not have RS Means, you do not have
supplier quotes, and you do not know what anything costs in this city this month. What you have is
general knowledge of how these products and methods compare. So:

  - Never state a dollar amount. Not for an option, not for a saving, not as an example.
  - Express the difference only as a percentage band against the line item you were given.
  - Keep the band wide. A five-point band is a lie about how much you know; ten to twenty points is
    usually honest.
  - Where the cost genuinely turns on the design, leave the band empty. That is a valid answer.

WHEN TO SAY NOTHING. Most line items on most estimates are priced the sensible way and have no
alternative worth raising. Return no options and give the one-sentence reason. Specifically:

  - the item is a commodity with no meaningful substitute — concrete, structural steel, excavation,
    standard electrical wire, ordinary framing lumber;
  - the only alternatives you can think of are worse in every way;
  - you would be guessing at what the line even covers because the description is too short.

Two or three strong options on a line beats six weak ones. Across the whole estimate, expect roughly
half the lines to have nothing worth saying. That is the correct outcome, not a failure.

WHAT MAKES AN OPTION GOOD. It is a real product or method that is actually built today, and it is
specific enough that an architect knows immediately what you mean.

WHEN THE DOCUMENT IS A PROPOSAL, NOT JUST AN ESTIMATE. Some arrive with a written scope, a list of
exclusions and assumptions, and a page of alternates the contractor has already priced. Where that
material is given to you above, it governs:

  - Anything under ALREADY OFFERED BY THE CONTRACTOR is off limits as a suggestion. Presenting the
    contractor's own priced alternate back to the owner as your discovery is the single worst thing
    this report can do — they are reading it with the proposal open beside them. If your best idea
    for a line is already on that list, return no options for that line and say so in
    noOptionsReason, naming the alternate.
  - An option that needs work the proposal EXCLUDES is not a saving. Drop it, or say so in note.
  - An option that breaks a stated ASSUMPTION must say so in note.
  - Use WHAT WAS ACTUALLY SPECIFIED. The priced row is a few words; the written scope names the
    material, the finish and the rating. An alternative that would not meet a rating the document
    states is not an alternative.

NEVER claim an option meets a code, a fire rating, or an accessibility requirement. You cannot see
the drawings, the occupancy, or the jurisdiction. Where that matters, put it in note as something to
confirm, never as a reassurance.`;

// The line items as the model sees them. Deliberately terse: what was priced, how much of it, and
// what it cost. The index is printed on every line because it is how the answer is matched back to
// the estimate; the model is not asked to repeat a description it could paraphrase and break the
// join on.
function buildLinesText(lines, { estimateTitle, contractor, location, proposal }) {
  const head = [];
  if (estimateTitle) head.push(`Estimate: ${estimateTitle}`);
  if (contractor) head.push(`Priced by: ${contractor}`);
  // Read off the estimate rather than typed by anyone, and the one piece of context that reliably
  // changes the answer — what is ordinary cladding in Houston is not ordinary cladding in Anchorage.
  if (location) head.push(`Where the project is: ${location}`);

  // Everything the pages around the numbers said. This is the INPUT side, and it stays rich even
  // though the output is now a table: it is what stops the tool suggesting something the proposal
  // already ruled out two pages earlier. A bare estimate has none of it and the sections simply do
  // not appear.
  const context = [];
  const section = (title, items) => {
    if (items.length) context.push(`${title}\n${items.map(t => `  - ${t}`).join('\n')}`);
  };

  if (proposal) {
    section(
      'ALREADY OFFERED BY THE CONTRACTOR — these are priced in the document itself. Do NOT propose '
      + 'any of them as your own idea; the owner is holding the page they are printed on.',
      proposal.alternates.map(a => a.description
        + (typeof a.amount === 'number'
          ? ` (${a.amount < 0 ? 'deduct ' : 'add '}$${Math.abs(a.amount).toLocaleString('en-US')})`
          : '')),
    );
    section(
      'WHAT THE PROPOSAL SAYS IS NOT INCLUDED — an option that depends on any of this is not a '
      + 'saving, because the work would have to be added back.',
      proposal.exclusions,
    );
    section(
      'WHAT THE PRICE ASSUMES — if an option would break one of these, either leave it out or say '
      + 'so plainly in note.',
      proposal.assumptions,
    );
    section(
      'WHAT WAS ACTUALLY SPECIFIED — the written scope, which carries the materials, finishes and '
      + 'ratings the priced rows leave out. Use it: an option that ignores a stated fire rating or '
      + 'finish is not a real option.',
      proposal.scopeNotes.map(n => `${n.system}: ${n.detail}`),
    );
  }

  const body = lines.map((line) => {
    const parts = [`[${line.index}]`];
    if (line.section) parts.push(`(${line.section})`);
    parts.push(line.description);
    const measure = [];
    if (typeof line.quantity === 'number') measure.push(`${line.quantity}${line.unit ? ` ${line.unit}` : ''}`);
    if (typeof line.amount === 'number') measure.push(`$${line.amount.toLocaleString('en-US')} on this line`);
    if (measure.length) parts.push(`— ${measure.join(', ')}`);
    return parts.join(' ');
  });

  return [
    head.join('\n'),
    context.join('\n\n'),
    `Line items to consider, one entry back for each:\n\n${body.join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

// Lines are worked in groups rather than one call for all of them, for two independent reasons. A
// group of forty produces more JSON than one reply holds, and hitting that ceiling loses the whole
// run rather than one group. And groups run at the same time, so the wall clock is the slowest
// group rather than the sum — what makes this slow is the model writing prose, at roughly a hundred
// tokens a second.
//
// Every group re-sends the same instructions and schema — about 1,650 tokens the model has to be
// given before it can answer — so the group count is a small cost as well as a speed dial. It is
// dominated by the other effect: a group's wall clock is however long the model spends WRITING its
// answer, at roughly a hundred tokens a second, and groups run side by side.
//
// Eight to a group was measured and was the wrong way round: twenty items came back in three calls,
// one of which wrote 2,600 tokens and held the whole stage open for 54 seconds. Four to a group
// splits the same work into five calls that all run at once, so the stage costs what its slowest
// quarter costs. The extra prefix repetitions are worth well under a cent.
const GROUP_SIZE = 4;
const CONCURRENCY = 8;

// How many of the costliest items go to the careful model.
//
// This stage is where the money goes — almost all of it output tokens, and the careful model charges
// three times as much for those. Measured head to head on the same eight items, the fast model
// matched it on every rule that matters: silence on all three commodity lines, no dollar figures, no
// unexpanded jargon. Where it fell short was insight — it offered white oak and bamboo against the
// walnut panel, where the careful model found the substrate-and-finish trades (site-finished
// plywood, real veneer on a cheaper backing) that an estimator would actually raise.
//
// So the split follows the money rather than the calendar: the biggest items, where a better idea is
// worth the most, get the careful model; the tail gets the fast one. An ordinary estimate has fewer
// items than this and goes entirely to the careful model, which is the behaviour that was signed off.
const CAREFUL_LINES = 8;

async function askForGroup(lines, context, fast) {
  const { data } = await askForJson({
    content: [{ type: 'text', text: buildLinesText(lines, context) }],
    system: OPTIONS_SYSTEM,
    tool: OPTIONS_TOOL,
    // The rules above are identical on every group of every estimate, so the cached prefix is the
    // whole invariant part and only the handful of line items is paid for per call.
    cacheTool: true,
    fast,
    maxTokens: 8000,
    label: `ve options ${fast ? 'tail' : 'top'}`,
    truncatedMessage: 'The answer for one group of line items ran long. Try the same estimate again.',
  });
  return data.items || [];
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function inParallel(groups, work) {
  const out = new Array(groups.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      out[i] = await work(groups[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
  return out;
}

// A stable identifier per option, because the PM's keep/drop decision is stored against it and has
// to survive the page reloading and the record being reopened months later. Derived from the line
// and the position rather than generated, so re-reading a stored analysis lands on the same ids.
const optionId = (lineIndex, position) => `L${lineIndex}-O${position}`;

// Runs the whole analysis and returns rows joined back to their estimate lines.
//
// Every option arrives kept. The PM drops what does not suit the job before anything reaches the
// owner. Defaulting the other way was tempting and wrong: a PM who runs the analysis and goes to
// lunch would produce an empty report for their client with no indication anything had gone missing.
async function buildOptions(lines, context = {}) {
  // `lines` arrives ranked biggest first, so the split is just a slice.
  const groups = [
    ...chunk(lines.slice(0, CAREFUL_LINES), GROUP_SIZE).map(g => ({ lines: g, fast: false })),
    ...chunk(lines.slice(CAREFUL_LINES), GROUP_SIZE).map(g => ({ lines: g, fast: true })),
  ];

  const answered = (await inParallel(groups, g => askForGroup(g.lines, context, g.fast))).flat();
  const byIndex = new Map(answered.map(item => [item.lineIndex, item]));

  return lines.map((line) => {
    const found = byIndex.get(line.index) || {};
    const options = (found.options || []).map((option, position) => ({
      ...option,
      id: optionId(line.index, position),
      kept: true,
    }));
    return {
      lineIndex: line.index,
      section: line.section || null,
      description: line.description,
      quantity: typeof line.quantity === 'number' ? line.quantity : null,
      unit: line.unit || null,
      amount: typeof line.amount === 'number' ? line.amount : null,
      // A line the model skipped entirely is reported as such rather than as "no alternatives
      // found" — those mean different things and only one of them is an answer.
      answered: byIndex.has(line.index),
      noOptionsReason: options.length ? null : (found.noOptionsReason || null),
      options,
    };
  });
}

module.exports = {
  buildOptions, buildLinesText, optionId,
  OPTIONS_TOOL, OPTIONS_SYSTEM, GROUP_SIZE, CAREFUL_LINES,
};
