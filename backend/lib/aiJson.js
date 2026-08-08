const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Getting structured data back from the model without the JSON falling apart.
//
// The obvious approach — ask for "only valid JSON" and JSON.parse the reply — works on every
// document you test with and then fails on a real one. Construction writing is full of inch
// marks: 36" of service clearance, a 2" gap, 18" duct. A bare quote inside a JSON string ends
// that string early, everything after it is unparseable, and the PM is shown a syntax error
// where the answer should be. Telling the model to escape its quotes does not hold, because it
// is writing prose about ductwork, not thinking about delimiters. Every module in this app
// used to read replies that way, and every one of them could fail on a document that merely
// mentioned a dimension.
//
// A tool call has no such failure mode. The model fills in a declared schema, the API
// serialises it, and the result arrives already parsed — an inch mark is just a character in a
// string. Same model, same prompt, one less way to fail.
//
// The field descriptions move out of the prompt and into the schema, where they belong: the
// prompt keeps the reasoning and the rules, the schema says what shape the answer takes.

const MODEL = 'claude-sonnet-4-5';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Answers worth waiting out rather than failing on. 429 is the per-minute allowance, which
// this account hits routinely; 529 and 503 are the API being briefly busy.
const RETRYABLE = new Set([429, 503, 529]);

// A field the model had nothing to say about is simply absent from a tool call, where the old
// prompts asked for an explicit null. That difference is not cosmetic: the pay app checks do
// arithmetic straight off these values, and `null + 1` is 1 where `undefined + 1` is NaN — so
// an omitted line would have turned a total into "NaN" on a report rather than into a gap.
//
// Every property the schema declares is therefore filled in with null when the model leaves it
// out, which restores exactly the shape the rest of the app was written against.
function fillDeclaredNulls(value, schema) {
  if (!schema || typeof schema !== 'object') return value;

  if (schema.type === 'array') {
    return Array.isArray(value) ? value.map(item => fillDeclaredNulls(item, schema.items)) : value;
  }
  if (schema.type !== 'object' || !schema.properties) return value;
  // An absent object stays absent rather than becoming a hollow shell of nulls: callers
  // distinguish "no notarization block was found" from "one was found and every field is empty".
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;

  const out = { ...value };
  for (const [key, child] of Object.entries(schema.properties)) {
    out[key] = key in out ? fillDeclaredNulls(out[key], child) : null;
  }
  return out;
}

// Returns { data, usage, stopReason }.
//
//   content          message content blocks (documents, images, text), as before
//   tool             { name, description, input_schema } — the shape wanted back
//   system           optional system blocks, including any cache_control
//   attempts         total tries including the first; 2 means one retry
//   truncatedMessage thrown when the model runs out of room mid-answer. Worth setting
//                    wherever the output can be long, since "it was cut off" and "it failed"
//                    call for different things from the user.
async function askForJson({
  content,
  tool,
  system = null,
  maxTokens = 3000,
  attempts = 2,
  label = 'ai',
  truncatedMessage = null,
}) {
  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    tools: [tool],
    // Forces the model to answer through the tool rather than in prose, so there is always
    // something structured to read back.
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
  if (system) request.system = system;

  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await client.messages.create(request);
      break;
    } catch (err) {
      if (!RETRYABLE.has(err?.status) || attempt >= attempts) throw err;
      // The API's own retry-after where it gives one: it knows when the window resets better
      // than a guess does. Capped so a long advertised wait cannot outlast the client.
      const advertised = Number(err?.headers?.['retry-after']);
      const wait = Number.isFinite(advertised) && advertised > 0
        ? Math.min(advertised, 90) * 1000
        : Math.min(20000 * attempt, 60000);
      console.warn(`[${label}] ${err.status} on attempt ${attempt}; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  if (response.usage) {
    const cached = response.usage.cache_read_input_tokens;
    console.log(`[${label}] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
      + (cached ? ` cached=${cached}` : '') + ' tokens');
  }

  // Checked before reading the tool call: a run that hit the ceiling has a half-filled answer,
  // and silently returning it would drop line items the caller believes it received.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(truncatedMessage
      || 'The response was cut off before it finished. Try again with a smaller document.');
  }

  const call = response.content.find(block => block.type === 'tool_use');
  if (!call) {
    // Only reachable if the model declines outright — nothing to do with formatting, so it
    // deserves its own message rather than being reported as unreadable data.
    const said = response.content.find(block => block.type === 'text')?.text?.trim();
    throw new Error(said
      ? `The model did not return an answer in the expected form. It said: ${said.slice(0, 300)}`
      : 'The model did not return an answer.');
  }

  return {
    data: fillDeclaredNulls(call.input || {}, tool.input_schema),
    usage: response.usage || null,
    stopReason: response.stop_reason,
  };
}

module.exports = { askForJson, fillDeclaredNulls, MODEL };
