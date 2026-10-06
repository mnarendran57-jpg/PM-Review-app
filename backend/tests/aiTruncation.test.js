const assert = require('assert');
const path = require('path');
const Module = require('module');

// An answer cut off by its own ceiling is retried with more room.
//
// WHY THIS IS WORTH A TEST OF ITS OWN
//
// Every call in this application picks a max_tokens, and that number is always a guess about how
// long an answer will turn out to be. Twice now a real document has produced a longer one and the
// whole read failed: a sixty-seven page pay application needed 22,548 tokens against a ceiling of
// 16,000, and an RFI answer ran past the 2,000 it had been given. Both times the work had already
// been done and paid for, and was thrown away over a number somebody guessed months earlier.
//
// Output is billed only for what is generated, so the retry costs nothing on the calls that never
// need it. These checks run against a stubbed SDK — no API call is made and nothing is spent.

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

// --- A fake Anthropic SDK, so the retry can be observed without spending anything -------------

const calls = [];
let script = [];

const reply = stopReason => ({
  stop_reason: stopReason,
  usage: { input_tokens: 10, output_tokens: 10 },
  content: [{ type: 'tool_use', input: { answer: 'done' } }],
});

function fakeSdk() {
  return class Anthropic {
    constructor() {
      this.messages = {
        create: async request => {
          calls.push({ max_tokens: request.max_tokens, streamed: false });
          return reply(script.shift() || 'end_turn');
        },
        stream: request => {
          calls.push({ max_tokens: request.max_tokens, streamed: true });
          const r = reply(script.shift() || 'end_turn');
          return { finalMessage: async () => r };
        },
      };
    }
  };
}

// Load aiJson with the SDK replaced.
const aiJsonPath = require.resolve('../lib/aiJson');
const sdkPath = require.resolve('@anthropic-ai/sdk');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === '@anthropic-ai/sdk') return fakeSdk();
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[aiJsonPath];
delete require.cache[sdkPath];
const { askForJson } = require(aiJsonPath);
Module._load = originalLoad;

const TOOL = {
  name: 'record',
  input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
};

const ask = (maxTokens, label = 'test') => askForJson({
  content: [{ type: 'text', text: 'hello' }],
  tool: TOOL,
  maxTokens,
  label,
});

const reset = s => { calls.length = 0; script = s; };

(async () => {
  console.log('\nAn answer that fits is left alone:');

  await (async () => {
    try {
      reset(['end_turn']);
      const out = await ask(2000);
      assert.strictEqual(calls.length, 1, 'a successful answer must not be asked for twice');
      assert.strictEqual(calls[0].max_tokens, 2000);
      assert.strictEqual(out.data.answer, 'done');
      console.log('  PASS  one call, no retry, nothing extra spent');
      passed += 1;
    } catch (err) { console.log('  FAIL  one call, no retry\n        ' + err.message); failed += 1; }
  })();

  console.log('\nAn answer cut off is retried with double the room:');

  await (async () => {
    try {
      reset(['max_tokens', 'end_turn']);
      const out = await ask(2000);
      assert.strictEqual(calls.length, 2, 'it should have tried again');
      assert.strictEqual(calls[0].max_tokens, 2000, 'first attempt uses what the caller asked for');
      assert.strictEqual(calls[1].max_tokens, 4000, 'the retry doubles it');
      assert.strictEqual(out.data.answer, 'done', 'and the answer comes back to the caller');
      console.log('  PASS  the RFI case: 2,000 was not enough, 4,000 was');
      passed += 1;
    } catch (err) { console.log('  FAIL  the RFI case\n        ' + err.message); failed += 1; }
  })();

  await (async () => {
    try {
      reset(['max_tokens', 'end_turn']);
      await ask(16000);
      assert.strictEqual(calls[1].max_tokens, 32000, 'the pay application case: 16,000 -> 32,000');
      assert.strictEqual(calls[1].streamed, true,
        'a retry this large must stream, or the SDK refuses it outright');
      console.log('  PASS  a large retry streams, because the SDK will not send it otherwise');
      passed += 1;
    } catch (err) { console.log('  FAIL  a large retry streams\n        ' + err.message); failed += 1; }
  })();

  await (async () => {
    try {
      reset(['max_tokens', 'end_turn']);
      await ask(2000);
      assert.strictEqual(calls[1].streamed, false,
        'a small retry has no need to stream and should not start');
      console.log('  PASS  a small retry does not stream needlessly');
      passed += 1;
    } catch (err) { console.log('  FAIL  a small retry does not stream\n        ' + err.message); failed += 1; }
  })();

  console.log('\nIt gives up rather than spending forever:');

  await (async () => {
    try {
      reset(['max_tokens', 'max_tokens', 'end_turn']);
      await assert.rejects(() => ask(2000), /longer than there was room for/);
      assert.strictEqual(calls.length, 2, 'twice, not three times or more');
      console.log('  PASS  retried once, then stopped');
      passed += 1;
    } catch (err) { console.log('  FAIL  retried once, then stopped\n        ' + err.message); failed += 1; }
  })();

  await (async () => {
    try {
      reset(['max_tokens', 'max_tokens']);
      let message = '';
      try { await ask(2000); } catch (err) { message = err.message; }
      // The old wording told people to try a smaller document. On an RFI the contractor sent, or a
      // pay application as it arrived, that is advice nobody can act on.
      assert.ok(!/smaller document/i.test(message),
        'must not tell someone to shrink a document they did not write');
      assert.ok(/nothing was saved/i.test(message), 'must say the work was not kept');
      console.log('  PASS  the message says what happened, not something impossible');
      passed += 1;
    } catch (err) { console.log('  FAIL  the message is honest\n        ' + err.message); failed += 1; }
  })();

  await (async () => {
    try {
      reset(['max_tokens', 'max_tokens']);
      let thrown = null;
      try { await ask(2000); } catch (err) { thrown = err; }
      assert.strictEqual(thrown.truncated, true,
        'callers that can recover by reading in smaller pieces still need to recognise this');
      console.log('  PASS  it is still flagged as a truncation for callers that handle it');
      passed += 1;
    } catch (err) { console.log('  FAIL  still flagged\n        ' + err.message); failed += 1; }
  })();

  await (async () => {
    try {
      reset(['max_tokens', 'end_turn']);
      // Already at the model's own maximum: there is nowhere roomier to retry into, so it reports
      // the truncation rather than spending a second call to fail the same way.
      await assert.rejects(() => ask(64000), /longer than there was room for/);
      assert.strictEqual(calls.length, 1, 'one call, and no pointless second one');
      console.log('  PASS  no pointless retry when the ceiling is already the maximum');
      passed += 1;
    } catch (err) { console.log('  FAIL  no pointless retry\n        ' + err.message); failed += 1; }
  })();

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
