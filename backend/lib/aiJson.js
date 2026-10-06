const Anthropic = require('@anthropic-ai/sdk');
const { aiLimiter } = require('./workLimit');

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

// Two models, chosen by what the call is for.
//
// What makes a document read slow is the model WRITING its answer, at roughly a hundred tokens a
// second, and a pay application transcribes into tens of thousands of them. Transcription is also
// the least judgemental thing this app asks: copy the figures out of a form. So it goes to the fast
// model, and everything that WEIGHS something — whether a subcontractor's billing is justified,
// whether a contract forbids a cost, whether an A/E answered the question — stays on the careful
// one. Getting a number wrong here is caught downstream: lib/payAppVerifyRead.js reconciles every
// transcribed line against the PDF's own text layer and corrects unambiguous misreads from the
// document itself, which is a safety net that judgement calls do not have.
const MODEL = 'claude-sonnet-4-5';
// Reserved for copying figures out of a document, never for deciding what they mean.
const FAST_MODEL = 'claude-haiku-4-5-20251001';
// The most any single answer may grow to on a retry. The model's own maximum; a ceiling below it
// would only reintroduce the problem further out.
const MAX_OUTPUT_TOKENS = 64000;

// Past roughly this, the SDK refuses a non-streamed request because it might outrun ten minutes.
// Measured: 16,000 and 20,000 go through unstreamed today, 64,000 is refused.
const SAFE_UNSTREAMED_TOKENS = 20000;

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
// The model occasionally escapes a quote inside a value that the API has already decoded for
// us, so a duct dimension arrives as 9'-0\" and would render with the backslash showing. Only
// a backslash directly before a double quote is touched: in construction prose that is always
// the artifact and never intended.
const unescapeStrayQuotes = text =>
  (typeof text === 'string' && text.includes('\\"') ? text.replace(/\\+"/g, '"') : text);

function fillDeclaredNulls(value, schema) {
  if (!schema || typeof schema !== 'object') return unescapeStrayQuotes(value);

  if (schema.type === 'array') {
    // A declared array that comes back as anything else becomes an empty one. The model does not
    // always omit a list it has nothing for — it sometimes writes the STRING "null" into it, which
    // is truthy, so `(result.exclusions || []).filter(...)` throws rather than skipping.
    //
    // Found in the VE Analyzer on a plain cost estimate: no exclusions section to read, the string
    // arrived, and the whole analysis died after the document had already been read and paid for.
    // The failure is worst on the documents that are most ordinary, and every module here does
    // .map or .filter straight off these lists.
    return Array.isArray(value) ? value.map(item => fillDeclaredNulls(item, schema.items)) : [];
  }
  if (schema.type !== 'object' || !schema.properties) return unescapeStrayQuotes(value);
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
//   cacheTool        keep the tool schema — and the system prompt with it — in the prompt cache
//                    between calls. Worth it wherever
//                    the SAME tool is used more than once inside five minutes — a document read
//                    in passes, a package catalogued in chunks. These schemas are not small:
//                    the pay app's is 5,356 tokens, more than half a minute's whole allowance,
//                    and it was being re-sent on every pass of the same document. A cache write
//                    costs a quarter more than the tokens it stores and a read costs a tenth, so
//                    it pays for itself on the second call and loses a little on a lone one —
//                    hence opt-in rather than always.
//   attempts         total tries including the first; 2 means one retry
//   truncatedMessage thrown when the model runs out of room mid-answer. Worth setting
//                    wherever the output can be long, since "it was cut off" and "it failed"
//                    call for different things from the user.
// One place that actually calls the API, so the retry behaviour is the same whatever shape of
// answer is being asked for.
// A long answer has to be streamed, whether or not anybody is watching it arrive.
//
// The SDK refuses a plain create() whose max_tokens implies the request could outrun ten minutes,
// and it is right to: a single HTTP response held open that long is at the mercy of every proxy
// between here and the API. Streaming keeps bytes moving, so the connection stays alive.
//
// Nothing downstream changes. finalMessage() assembles the same Message object create() would have
// returned, so stop_reason, usage and the tool call are all read exactly as before — this is how
// the answer travels, not what it is.
async function send(request, opts = {}) {
  // Every AI call in the application passes through here, which makes it the one place a limit on
  // how much happens at once can be applied without touching thirteen modules. See workLimit.js:
  // unbounded, five simultaneous uploads exhaust the instance and Render restarts it, ending every
  // request in flight rather than the one that was too much.
  return aiLimiter.run(() => sendNow(request, opts));
}

async function sendNow(request, { attempts = 2, label = 'ai', stream = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (stream) return await client.messages.stream(request).finalMessage();
      return await client.messages.create(request);
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
}

async function askForJson({
  content,
  tool,
  system = null,
  cacheTool = false,
  maxTokens = 3000,
  attempts = 2,
  label = 'ai',
  truncatedMessage = null,
  // Set where the answer itself can be long — see send(). Off by default so every existing
  // caller behaves exactly as it did.
  stream = false,
  // Transcription only. See FAST_MODEL above for where the line is drawn.
  fast = false,
}) {
  const request = {
    model: fast ? FAST_MODEL : MODEL,
    max_tokens: maxTokens,
    // The cache breakpoint goes as late as possible in the invariant part of the request,
    // because everything BEFORE it is cached with it. The API orders a prompt tools -> system ->
    // messages, so a breakpoint on the system block covers the tool too; with no system block it
    // has to sit on the tool itself. The documents and the per-pass text come after, and differ
    // every call, so they are never cached.
    tools: [cacheTool && !system ? { ...tool, cache_control: { type: 'ephemeral' } } : tool],
    // Forces the model to answer through the tool rather than in prose, so there is always
    // something structured to read back.
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
  if (system) {
    // A caller may pass a plain string; the cache marker needs a block to sit on.
    const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system;
    request.system = cacheTool
      ? blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b))
      : blocks;
  }

  // Below about a thousand tokens the API declines to cache and simply ignores the marker — no
  // error, no cost, and no saving. Nothing here depends on the exact figure; a schema that grows
  // past it starts being cached on its own.
  //
  // Measured against the careful model on 2026-08-20: a 1,110-token schema cached, a 647-token one
  // did not. That is why cacheTool is set only on the schemas over a thousand tokens — on the
  // smaller ones it would be a line of code that reads as an optimisation and does nothing. The
  // fast model's threshold is higher again, so a schema sent to it needs to be larger still.

  let response;
  response = await send(request, { attempts, label, stream });

  // AN ANSWER CUT OFF BY THE CEILING IS RETRIED WITH MORE ROOM.
  //
  // Every caller picks a max_tokens, and the number is always a guess about how long an answer
  // will be — so sooner or later a real document produces a longer one and the whole read fails.
  // It has now happened twice on real work: a sixty-seven page pay application needed 22,548
  // tokens against a ceiling of 16,000, and an RFI answer ran past the 2,000 it was given.
  //
  // Output is only charged for what is actually generated, so a ceiling that is never reached
  // costs nothing. The failure is therefore pure loss: the work was done, paid for, and thrown
  // away over a number somebody guessed months earlier. One retry with double the room turns that
  // into a delay instead, and costs nothing at all on the calls that never needed it.
  //
  // Once, not repeatedly. If an answer will not fit in twice the space, something is wrong with
  // the request rather than with the ceiling, and quietly spending more on each attempt is not
  // the way to find out.
  if (response.stop_reason === 'max_tokens') {
    const roomier = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
    if (roomier > maxTokens) {
      console.warn(`[${label}] answer hit the ${maxTokens}-token ceiling; retrying with ${roomier}`);
      response = await send(
        // Only max_tokens changes. Nothing else may be added to the request — an unrecognised
        // field is a 400 from the API, which would turn a recoverable truncation into a hard
        // failure for every caller at once.
        { ...request, max_tokens: roomier },
        // Above a certain size the SDK refuses a non-streamed request, correctly — a response held
        // open that long is at the mercy of every proxy in between. So a roomier retry streams.
        { attempts, label, stream: stream || roomier > SAFE_UNSTREAMED_TOKENS },
      );
    }
  }

  if (response.usage) {
    const read = response.usage.cache_read_input_tokens;
    const written = response.usage.cache_creation_input_tokens;
    // The model is logged because which one answered is the first thing worth knowing when a
    // transcription comes back wrong.
    console.log(`[${label}] ${fast ? 'fast' : 'careful'} in=${response.usage.input_tokens} `
      + `out=${response.usage.output_tokens}`
      + (read ? ` cache-hit=${read}` : '') + (written ? ` cache-write=${written}` : '') + ' tokens');
  }

  // Checked before reading the tool call: a run that hit the ceiling has a half-filled answer,
  // and silently returning it would drop line items the caller believes it received.
  if (response.stop_reason === 'max_tokens') {
    // "Try again with a smaller document" was the old wording, and on most of these calls it is
    // bad advice: the document is an RFI the contractor sent, or a pay application as it arrived,
    // and the person reading it cannot make it smaller. Say what happened instead.
    const err = new Error(truncatedMessage
      || 'The answer came out longer than there was room for, even after retrying with more. '
        + 'Nothing was saved. Try once more, and tell us if it keeps happening — this is ours to fix, '
        + 'not something to work around.');
    // Flagged, not just worded. Callers that can recover — by reading the document in smaller
    // pieces — need to recognise this without matching on prose, and every caller writes its
    // own message. Telling the user to split the PDF themselves is the answer of last resort.
    err.truncated = true;
    throw err;
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

// Plain prose back, with no schema imposed on it.
//
// Everything else in this app goes through askForJson, because a schema is what makes an answer
// checkable — and this deliberately does the opposite. It exists for the Pay App Reviewer 2
// sandbox, where the whole question is what a set of instructions produces when nothing reshapes
// it. Forcing that through a tool call would answer a different question.
//
// Nothing here feeds a calculation or a stored finding. If that ever changes, it should go back
// through a schema first.
async function askForText({ content, system = null, maxTokens = 16000, label = 'ai text' }) {
  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  if (system) request.system = system;

  const response = await send(request, { label });

  const text = (response.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  if (response.stop_reason === 'max_tokens') {
    // Said rather than hidden: a report cut off mid-sentence looks complete to a skim.
    const err = new Error('The answer was longer than the reply limit and has been cut short.');
    err.truncated = true;
    err.partial = text;
    throw err;
  }

  console.log(`[${label}] careful in=${response.usage.input_tokens} `
    + `out=${response.usage.output_tokens} tokens`);
  return text;
}

module.exports = { MODEL, FAST_MODEL, askForJson, askForText, fillDeclaredNulls };
