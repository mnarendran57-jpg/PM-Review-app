// Coaster AI's decisions, without an API call.
//
// A chat answer cannot be checked the way a review can — there is no schema, no arithmetic that has
// to tie, no clause it must cite. So the things that CAN be pinned down are pinned down here:
//
//   1. Which model answers, and why. The routing is a pure function of things that can be observed,
//      precisely so that it is testable and so a wrong route is visible rather than silent.
//   2. How much conversation travels on each turn. A chat re-sends its whole history, so this is
//      the difference between a thread that costs pennies and one that does not.
//   3. That a conversation, and every file attached to it, really is gone a day later.
const assert = require('assert');
const { chooseTier, looksLikeLookup, TIERS, LONG_CONVERSATION_CHARS } = require('../lib/chatRouting');
const {
  historyWindow, expiredChats, sweepChats,
  KEEP_HOURS, MAX_HISTORY_MESSAGES, MAX_HISTORY_CHARS,
} = require('../lib/chatHistory');
const { toApiMessages, titleFrom, SYSTEM } = require('../lib/chatAnswer');
const db = require('../database');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCoaster AI — which model answers');

check('a terminology question goes to the fast model', () => {
  for (const q of [
    'What is retainage?',
    'What does GMP stand for?',
    'Define substantial completion',
    "What's the difference between a submittal and a shop drawing?",
    'What is an RFI in construction?',
  ]) {
    const tier = chooseTier({ question: q });
    assert.strictEqual(tier.key, 'fast', `"${q}" went to ${tier.key}`);
  }
});

check('a question asking for judgement does not, however short', () => {
  for (const q of [
    'Should we accept this change order?',
    'Is 10% retainage reasonable?',
    'Why would a GC ask for that?',
    'Draft a response to the architect',
    'What is the risk of signing this?',
  ]) {
    const tier = chooseTier({ question: q });
    assert.strictEqual(tier.key, 'careful', `"${q}" went to ${tier.key}`);
  }
});

check('an attached file always gets the careful model', () => {
  // A document is the whole reason the question was asked, and reading one is not recall.
  const tier = chooseTier({ question: 'What is this?', attachmentCount: 1 });
  assert.strictEqual(tier.key, 'careful');
  assert.match(tier.reason, /file you attached/);
});

check('so do the project documents', () => {
  const tier = chooseTier({ question: 'What is retainage?', projectDocumentCount: 2 });
  assert.strictEqual(tier.key, 'careful');
  assert.match(tier.reason, /project documents/);
});

check('a long conversation gets the careful model even for a short question', () => {
  const tier = chooseTier({ question: 'What is retainage?', historyChars: LONG_CONVERSATION_CHARS + 1 });
  assert.strictEqual(tier.key, 'careful');
  assert.match(tier.reason, /long conversation/);
});

check('the deep model is NEVER chosen on its own', () => {
  // The whole cost guarantee rests on this: a run of hard questions cannot quietly cost five times
  // what it looks like it should.
  const shapes = [
    { question: 'Analyse the entire contract and advise on every risk', historyChars: 999999 },
    { question: 'What is retainage?', attachmentCount: 9, projectDocumentCount: 9 },
    { question: 'x'.repeat(5000) },
    {},
  ];
  for (const shape of shapes) {
    assert.notStrictEqual(chooseTier(shape).key, 'deep', `${JSON.stringify(shape).slice(0, 60)} reached Opus`);
  }
});

check('the deep model is reachable only by asking', () => {
  const tier = chooseTier({ question: 'What is retainage?', forceDeep: true });
  assert.strictEqual(tier.key, 'deep');
  assert.match(tier.reason, /you asked/i);
});

check('every route explains itself', () => {
  // The reason is shown next to the answer, so routing is something a user can argue with.
  for (const shape of [{ question: 'What is a punch list?' }, { question: 'Should we sign?' },
    { question: 'x', attachmentCount: 1 }, { question: 'x', forceDeep: true }]) {
    const tier = chooseTier(shape);
    assert.ok(tier.reason && tier.reason.length > 5, `no reason for ${JSON.stringify(shape)}`);
    assert.ok(tier.label && tier.model, 'no label or model');
  }
});

check('two questions in one message is a conversation, not a lookup', () => {
  assert.strictEqual(looksLikeLookup('What is retainage? And what is a lien waiver?'), false);
});

check('a long message is never a lookup', () => {
  assert.strictEqual(looksLikeLookup(`What is retainage? ${'context '.repeat(60)}`), false);
});

check('the models named are the ones intended', () => {
  assert.match(TIERS.fast.model, /haiku/);
  assert.match(TIERS.careful.model, /sonnet/);
  assert.match(TIERS.deep.model, /opus/);
});

console.log('\nCoaster AI — how much conversation travels each turn');

const turns = n => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message ${i}`,
}));

check('an ordinary conversation is never trimmed', () => {
  // Deliberately: prompt caching works on a prefix that only grows, so an untrimmed thread is
  // almost entirely a cache read. Trimming little and often would be the expensive choice.
  const { messages, trimmed } = historyWindow(turns(10));
  assert.strictEqual(trimmed, 0);
  assert.strictEqual(messages.length, 10);
});

check('a very long conversation is trimmed from the front', () => {
  const { messages, trimmed } = historyWindow(turns(MAX_HISTORY_MESSAGES + 20));
  assert.ok(trimmed > 0, 'nothing was trimmed');
  assert.ok(messages.length <= MAX_HISTORY_MESSAGES);
  // The most recent turn must survive — it is the question being answered.
  assert.strictEqual(messages[messages.length - 1].content, `message ${MAX_HISTORY_MESSAGES + 19}`);
});

check('a huge single message is capped by characters, not just by count', () => {
  const fat = [
    { role: 'user', content: 'x'.repeat(MAX_HISTORY_CHARS) },
    { role: 'assistant', content: 'y'.repeat(MAX_HISTORY_CHARS) },
    { role: 'user', content: 'the actual question' },
  ];
  const { messages } = historyWindow(fat);
  assert.ok(messages.length < 3, 'a conversation far over the character cap was sent whole');
  assert.strictEqual(messages[messages.length - 1].content, 'the actual question');
});

check('a trimmed conversation never opens on an assistant reply', () => {
  // The API rejects a leading assistant turn outright, and the model reads it as having spoken
  // unprompted.
  for (const n of [MAX_HISTORY_MESSAGES + 1, MAX_HISTORY_MESSAGES + 2, MAX_HISTORY_MESSAGES + 7]) {
    const { messages } = historyWindow(turns(n));
    assert.strictEqual(messages[0].role, 'user', `${n} turns opened on ${messages[0].role}`);
  }
});

check('the cache breakpoint sits on the turn before the new question', () => {
  // On the new question it would never hit: the prefix has to match the last request byte for byte,
  // and the new question by definition does not.
  const { messages } = toApiMessages(turns(6), () => []);
  const marked = messages.filter(m => m.content.some(b => b.cache_control));
  assert.strictEqual(marked.length, 1, `${marked.length} breakpoints`);
  assert.strictEqual(marked[0], messages[messages.length - 2], 'breakpoint is not on the prior turn');
});

check('a single opening question carries no breakpoint', () => {
  const { messages } = toApiMessages([{ role: 'user', content: 'What is retainage?' }], () => []);
  assert.ok(!messages.some(m => m.content.some(b => b.cache_control)));
});

check('a title is taken from the question, not from another API call', () => {
  assert.strictEqual(titleFrom('What is retainage?'), 'What is retainage?');
  assert.ok(titleFrom('x'.repeat(200)).length <= 60);
  assert.strictEqual(titleFrom(''), 'New chat');
});

console.log('\nCoaster AI — files bigger than one request can hold');

// Found on a real customer contract: 168 pages, attached to a chat, and the API refuses more than
// a hundred in one document. The whole conversation failed with the provider's raw JSON on screen.
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { blocksForFile, MAX_PDF_PAGES } = require('../lib/chatDocuments');

async function pdfOf(pages, textPerPage) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([612, 792]);
    if (textPerPage) {
      textPerPage.split('\n').forEach((line, j) => {
        page.drawText(`${line} (page ${i + 1})`, { x: 40, y: 740 - j * 14, size: 10, font });
      });
    }
  }
  return Buffer.from(await pdf.save());
}

const asyncChecks = [];
const acheck = (name, fn) => asyncChecks.push([name, fn]);

acheck('a contract longer than the page limit is read as text, not refused', async () => {
  const long = await pdfOf(MAX_PDF_PAGES + 68,
    'ARTICLE 5 PAYMENTS\nThe Owner shall withhold five percent retainage from each progress payment.');
  const blocks = await blocksForFile({ buffer: long, name: 'Contract.pdf', mediaType: 'application/pdf' });
  assert.ok(blocks.length >= 1, 'nothing came back');
  assert.strictEqual(blocks[0].type, 'text', `sent as ${blocks[0].type} — the API refuses this many pages`);
  assert.match(blocks[0].text, /retainage/i, 'the words did not survive');
  assert.match(blocks[0].text, /168 pages/, 'the reader is not told how long it is');
});

acheck('a project document is read as text even when it is short', async () => {
  // A contract is quoted from, not looked at. Text is a fraction of the tokens and caches better.
  const short = await pdfOf(3, 'ARTICLE 4 CONTRACT SUM\nThe Contract Sum shall be four hundred thousand dollars.');
  const blocks = await blocksForFile({
    buffer: short, name: 'Contract.pdf', mediaType: 'application/pdf', preferText: true,
  });
  assert.strictEqual(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Contract Sum/i);
});

acheck('a short attachment stays a document, because the picture is the point', async () => {
  const drawing = await pdfOf(2, 'M-401 MECHANICAL PLAN');
  const blocks = await blocksForFile({ buffer: drawing, name: 'M-401.pdf', mediaType: 'application/pdf' });
  assert.strictEqual(blocks[0].type, 'document');
});

acheck('a long SCAN falls back to the first pages rather than failing', async () => {
  // No text layer, so it cannot be read as words — but it must not take the conversation down.
  const scan = await pdfOf(MAX_PDF_PAGES + 20, null);
  const blocks = await blocksForFile({ buffer: scan, name: 'Scan.pdf', mediaType: 'application/pdf' });
  assert.strictEqual(blocks[0].type, 'document');
  const trimmed = Buffer.from(blocks[0].source.data, 'base64');
  const count = (await PDFDocument.load(trimmed)).getPageCount();
  assert.strictEqual(count, MAX_PDF_PAGES, `sent ${count} pages; the API refuses more than ${MAX_PDF_PAGES}`);
  assert.ok(blocks.some(b => b.type === 'text' && /only the first/i.test(b.text)),
    'the reader is not told that later pages were left out');
});

acheck('an image is an image', async () => {
  const blocks = await blocksForFile({
    buffer: Buffer.from('fake'), name: 'photo.jpg', mediaType: 'image/jpeg',
  });
  assert.strictEqual(blocks[0].type, 'image');
  assert.strictEqual(blocks[0].source.media_type, 'image/jpeg');
});

console.log('\nCoaster AI — the rules the answers are held to');

check('the prompt forbids the three things that cost somebody money', () => {
  assert.match(SYSTEM, /Never state that something complies/i);
  assert.match(SYSTEM, /Never give a price/i);
  assert.match(SYSTEM, /Never invent a clause/i);
  assert.match(SYSTEM, /architect or engineer/i);
});

console.log('\nCoaster AI — a conversation lasts a day');

check('a fresh chat is not swept', () => {
  const chat = db.prepare(`INSERT INTO ai_chats (org_id, user_id, title) VALUES (9901, 9901, 'fresh')`).run();
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, 'user', 'hello')`).run(chat.lastInsertRowid);
  const { ids } = expiredChats(db);
  assert.ok(!ids.includes(chat.lastInsertRowid), 'a chat from this second was swept');
  db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id=?`).run(chat.lastInsertRowid);
  db.prepare(`DELETE FROM ai_chats WHERE id=?`).run(chat.lastInsertRowid);
});

check('a chat quiet for longer than a day is swept, with its files', () => {
  const old = db.prepare(
    `INSERT INTO ai_chats (org_id, user_id, title, updated_at) VALUES (9901, 9901, 'old', datetime('now', ?))`,
  ).run(`-${KEEP_HOURS + 1} hours`);
  const id = old.lastInsertRowid;
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content, attachments) VALUES (?, 'user', 'see this', ?)`)
    .run(id, JSON.stringify([{ name: 'drawing.pdf', key: 'chat/abc123.pdf' }]));
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, 'assistant', 'ok')`).run(id);

  const { ids, keys } = expiredChats(db);
  assert.ok(ids.includes(id), 'an expired chat was not found');
  assert.ok(keys.includes('chat/abc123.pdf'),
    'the attachment key was not returned — the row would go and the file would stay in the bucket for ever');

  const swept = sweepChats(db);
  assert.ok(swept.chats >= 1);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM ai_chats WHERE id=?`).get(id).c, 0);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM ai_chat_messages WHERE chat_id=?`).get(id).c, 0,
    'messages outlived the chat they belonged to');
});

check('a corrupt attachment row does not stop the rest being cleared', () => {
  const old = db.prepare(
    `INSERT INTO ai_chats (org_id, user_id, title, updated_at) VALUES (9901, 9901, 'bad', datetime('now', ?))`,
  ).run(`-${KEEP_HOURS + 1} hours`);
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content, attachments) VALUES (?, 'user', 'x', 'not json')`)
    .run(old.lastInsertRowid);
  assert.doesNotThrow(() => sweepChats(db));
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM ai_chats WHERE id=?`).get(old.lastInsertRowid).c, 0);
});

// Nothing belonging to this test should survive it.
db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id IN (SELECT id FROM ai_chats WHERE org_id=9901)`).run();
db.prepare(`DELETE FROM ai_chats WHERE org_id=9901`).run();

// The document checks build real PDFs and have to await, so they run after everything synchronous.
(async () => {
  console.log('\nCoaster AI — files bigger than one request can hold (results)');
  for (const [name, fn] of asyncChecks) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
