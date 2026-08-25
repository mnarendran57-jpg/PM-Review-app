// What a conversation carries, and how long it lasts.
//
// Two different things are going on here and they are easy to confuse.
//
// EXPIRY is about clutter and storage. A day after its last message a conversation is gone —
// the thread, every message, and every file anyone attached to it. Nobody comes back to a chat
// about what "retainage" means, and a list of four hundred of them is a burden rather than a
// feature. This costs nothing per message; it keeps the tab and the bucket from filling up.
//
// THE HISTORY WINDOW is about money, which expiry does nothing for. Every turn of a chat re-sends
// the whole conversation so far, so turn ten pays for turns one through nine again. Text-only that
// is mild. With a drawing attached it is not: a five page drawing is roughly ten thousand tokens as
// images, and left alone it would ride along on every subsequent message for the life of the
// thread.
//
// Both matter. Neither substitutes for the other.

const KEEP_HOURS = 24;

// How much conversation travels on each turn. Generous enough that an ordinary back-and-forth is
// never trimmed, small enough that a very long thread cannot grow without limit.
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 30000;

// A conversation and everything belonging to it, once it has been quiet for a day.
//
// Swept on the way past rather than by a scheduled job, the same way stale AI jobs are: the only
// moment anyone cares whether a chat has aged out is when they open the tab and look at the list.
// Attachment keys come back with it — deleting the rows and leaving the files in object storage
// would be exactly the accumulation this is meant to prevent.
function expiredChats(db) {
  const chats = db.prepare(
    `SELECT id FROM ai_chats WHERE updated_at < datetime('now', ?)`,
  ).all(`-${KEEP_HOURS} hours`);
  if (!chats.length) return { ids: [], keys: [] };

  const ids = chats.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT attachments FROM ai_chat_messages WHERE chat_id IN (${placeholders}) AND attachments IS NOT NULL`,
  ).all(...ids);

  const keys = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.attachments);
    } catch {
      continue;                       // a corrupt row must not stop the rest being cleared
    }
    for (const file of Array.isArray(parsed) ? parsed : []) {
      if (file && file.key) keys.push(file.key);
    }
  }
  return { ids, keys };
}

// Deletes the rows and hands back the object-storage keys for the caller to remove. Kept separate
// because storage is asynchronous and this is not — and because a failure to reach the bucket must
// not leave the database holding conversations it has already promised to forget.
function sweepChats(db) {
  const { ids, keys } = expiredChats(db);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM ai_chats WHERE id IN (${placeholders})`).run(...ids);
  }
  return { chats: ids.length, keys };
}

// The slice of the conversation that travels with the next question.
//
// While a thread is under the cap this returns all of it, which matters more than it looks: prompt
// caching works on a prefix that only ever grows, so an untrimmed conversation is cached almost
// entirely and costs a tenth to re-send. The moment trimming starts the prefix changes and the
// cache is written again — once — and then settles. So the cap is set high enough that ordinary
// conversations never reach it, rather than trimming little and often.
//
// Trimming keeps the most RECENT messages. The oldest turns are the ones nobody is still referring
// to, and dropping from the front is what keeps the tail of the conversation coherent.
function historyWindow(messages) {
  const all = Array.isArray(messages) ? messages : [];
  if (all.length <= MAX_HISTORY_MESSAGES && totalChars(all) <= MAX_HISTORY_CHARS) {
    return { messages: all, trimmed: 0 };
  }

  const kept = [];
  let chars = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const size = messageChars(all[i]);
    if (kept.length >= MAX_HISTORY_MESSAGES) break;
    if (kept.length && chars + size > MAX_HISTORY_CHARS) break;
    kept.unshift(all[i]);
    chars += size;
  }

  // A conversation must not open on an assistant reply to a question that is no longer there — the
  // model reads it as having said something unprompted, and the API rejects a leading assistant
  // turn outright.
  while (kept.length && kept[0].role !== 'user') kept.shift();

  return { messages: kept, trimmed: all.length - kept.length };
}

const messageChars = m => String(m?.content || '').length;
const totalChars = list => list.reduce((n, m) => n + messageChars(m), 0);

module.exports = {
  KEEP_HOURS, MAX_HISTORY_MESSAGES, MAX_HISTORY_CHARS,
  expiredChats, sweepChats, historyWindow,
};
