const Anthropic = require('@anthropic-ai/sdk');
const { historyWindow } = require('./chatHistory');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Answering a question, a token at a time.
//
// Everything else in this application asks the model for a filled-in schema and waits — a review is
// a document that either arrives or does not, and forty seconds behind a progress bar is fine.
// A chat is not that. Twenty seconds of nothing reads as broken, so this is the one place that
// streams, and it is why this file exists rather than another entry point in lib/aiJson.js.
//
// There is no tool call and no schema here, which also means none of the checking the rest of the
// app relies on. The only thing standing between a confident wrong answer and a project manager is
// the system prompt below, so it carries the same rules the reports do.

const SYSTEM = `You are Coaster, answering questions for people who build things — project managers,
owners' representatives, and the owners paying for the work.

WHO YOU ARE TALKING TO. Someone in the middle of a working day who wants an answer, not an essay.
Construction people asking about their own field, and sometimes owners who are not in the industry at
all. Match the question: a definition gets a couple of sentences, a genuine problem gets as much as it
needs and no more. Never pad, never restate the question back, never open with "Great question".

PLAIN ENGLISH. Expand every abbreviation the first time you use it. If a term only makes sense to an
estimator, say what it means in the same breath. Somebody on a school board should be able to follow
you without asking anyone.

WHAT YOU MUST NOT DO.

  - Never state that something complies with a building code, a fire rating, an accessibility
    requirement, or a standard. You cannot see the drawings, the occupancy, the jurisdiction or the
    edition of the code in force. Explain what the requirement generally is and say plainly that
    whether this project meets it is for the architect or engineer of record to confirm.
  - Never give a price. You have no pricing data, no RS Means, and no idea what anything costs in
    that city this month. Talk about relative cost — what is usually dearer than what, and why —
    and say that a real number needs a quote.
  - Never interpret a contract as though your reading settles it. Say what the language ordinarily
    means, name what would change the answer, and point at the person whose job it is to decide.
  - Never invent a clause, a section number, a standard, or a figure. If a document was given to
    you, quote it. If it was not, say you are speaking generally.

WHEN A DOCUMENT IS ATTACHED. Answer from it, and quote the part you are relying on so the reader can
check you. If the document does not settle the question, say so rather than filling the gap from
general knowledge — the whole reason they attached it was to be answered from it.

WHEN YOU DO NOT KNOW. Say so, in one sentence, and say what would answer it. A confident wrong answer
about a fire rating or a retainage clause costs somebody real money, and this tool is used by people
who will act on what it says.`;

// Where the cache breakpoint goes, and why it matters more here than anywhere else.
//
// A chat re-sends its entire history on every turn, so by turn ten the same words have been paid for
// ten times. Marking the end of the previous turn means everything before the new question is a
// cache read at a tenth of the price, and the saving compounds exactly as the cost would have.
//
// The breakpoint sits on the LAST message of the prior turn rather than on the new one: the prefix
// has to be identical to the last request for the cache to hit, and the new question by definition
// is not.
function toApiMessages(stored, attachmentsFor) {
  const { messages, trimmed } = historyWindow(stored);
  const out = messages.map((row) => {
    const content = [];
    for (const block of attachmentsFor(row)) content.push(block);
    if (String(row.content || '').trim()) {
      content.push({ type: 'text', text: String(row.content) });
    }
    return { role: row.role === 'assistant' ? 'assistant' : 'user', content };
  }).filter(m => m.content.length);

  if (out.length > 1) {
    const prior = out[out.length - 2];
    const last = prior.content[prior.content.length - 1];
    if (last) last.cache_control = { type: 'ephemeral' };
  }
  return { messages: out, trimmed };
}

// Streams an answer, calling onText for each fragment. Resolves with the finished text and what it
// cost, which is recorded against the message — see database.js for why that is kept.
async function streamAnswer({ model, messages, maxTokens = 4000, onText }) {
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  stream.on('text', (fragment) => {
    if (onText) onText(fragment);
  });

  const final = await stream.finalMessage();
  const text = (final.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return {
    text,
    stopReason: final.stop_reason,
    usage: {
      input: final.usage?.input_tokens ?? 0,
      output: final.usage?.output_tokens ?? 0,
      cacheRead: final.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

// A title for the thread list, taken from the first thing asked rather than from a second API call.
// A chat that lives for a day does not deserve one.
function titleFrom(question) {
  const text = String(question || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length <= 60 ? text : `${text.slice(0, 57).trimEnd()}…`;
}

module.exports = { SYSTEM, toApiMessages, streamAnswer, titleFrom };
