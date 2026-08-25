const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const storage = require('../lib/storage');
const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');
const { friendlyAiError } = require('../lib/aiErrors');
const { chooseTier } = require('../lib/chatRouting');
const { sweepChats, KEEP_HOURS } = require('../lib/chatHistory');
const { toApiMessages, streamAnswer, titleFrom } = require('../lib/chatAnswer');

router.use(requireOrg);
router.use(requireFeature('coaster-ai'));

// A chat is somebody thinking out loud, so it belongs to the person who wrote it rather than to the
// project or the team. Scoped by organization AND by user everywhere below — an administrator can
// see every review in their organization, and cannot see anyone's chats.
const ownedChat = (req, id) => db.prepare(
  `SELECT * FROM ai_chats WHERE id=? AND org_id=? AND user_id=?`,
).get(id, req.orgId, req.user.id);

// Anything anyone has aged out, cleared on the way past. See lib/chatHistory.js for why there is no
// scheduled job.
async function sweep() {
  const { chats, keys } = sweepChats(db);
  if (keys.length) await storage.remove(keys).catch(() => {});
  return chats;
}

const ATTACHMENT_MB = 20;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MB * 1024 * 1024 },
});
const ATTACHABLE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ---------------------------------------------------------------------------------------------
// Threads

router.get('/chats', async (req, res) => {
  await sweep();
  res.json({
    keepHours: KEEP_HOURS,
    chats: db.prepare(`
      SELECT c.id, c.title, c.project_id, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS message_count
      FROM ai_chats c
      WHERE c.org_id=? AND c.user_id=?
      ORDER BY c.updated_at DESC
    `).all(req.orgId, req.user.id),
  });
});

router.post('/chats', (req, res) => {
  const projectId = req.body?.project_id ? Number(req.body.project_id) : null;
  // A project can only be attached if the person may actually see it, or the chat would become a
  // way of reading documents from a project they are not on.
  if (projectId && !access.recordVisible(req.user, { org_id: req.orgId, project_id: projectId })) {
    return res.status(404).json({ error: 'That project could not be found.' });
  }
  const documentIds = Array.isArray(req.body?.document_ids)
    ? req.body.document_ids.map(Number).filter(Number.isFinite) : [];

  const row = db.prepare(`
    INSERT INTO ai_chats (org_id, user_id, project_id, title, document_ids)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.orgId, req.user.id, projectId, null, JSON.stringify(documentIds));

  res.json(db.prepare(`SELECT * FROM ai_chats WHERE id=?`).get(row.lastInsertRowid));
});

router.get('/chats/:id', (req, res) => {
  const chat = ownedChat(req, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare(`
    SELECT id, role, content, tier, model, reason, attachments, created_at
    FROM ai_chat_messages WHERE chat_id=? ORDER BY id
  `).all(chat.id).map(m => ({ ...m, attachments: safeParse(m.attachments, []) }));
  res.json({ ...chat, document_ids: safeParse(chat.document_ids, []), messages });
});

router.put('/chats/:id', (req, res) => {
  const chat = ownedChat(req, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const projectId = req.body?.project_id ? Number(req.body.project_id) : null;
  if (projectId && !access.recordVisible(req.user, { org_id: req.orgId, project_id: projectId })) {
    return res.status(404).json({ error: 'That project could not be found.' });
  }
  const documentIds = Array.isArray(req.body?.document_ids)
    ? req.body.document_ids.map(Number).filter(Number.isFinite) : [];
  db.prepare(`UPDATE ai_chats SET project_id=?, document_ids=? WHERE id=?`)
    .run(projectId, JSON.stringify(documentIds), chat.id);
  res.json({ success: true });
});

router.delete('/chats/:id', async (req, res) => {
  const chat = ownedChat(req, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const keys = db.prepare(`SELECT attachments FROM ai_chat_messages WHERE chat_id=? AND attachments IS NOT NULL`)
    .all(chat.id)
    .flatMap(r => safeParse(r.attachments, []).map(f => f.key).filter(Boolean));
  db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id=?`).run(chat.id);
  db.prepare(`DELETE FROM ai_chats WHERE id=?`).run(chat.id);
  if (keys.length) await storage.remove(keys).catch(() => {});
  res.json({ success: true });
});

// ---------------------------------------------------------------------------------------------
// Attachments

router.post('/attachments', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file was uploaded.' });
  if (!ATTACHABLE.has(file.mimetype)) {
    return res.status(400).json({ error: 'Attach a PDF or an image (JPEG, PNG, GIF, WEBP).' });
  }
  const { key } = await storage.storeFile('chat', file.buffer, file.mimetype, file.originalname);
  res.json({
    name: file.originalname,
    mediaType: file.mimetype,
    bytes: file.size,
    key,
    // Where object storage is not configured the file lives only in this response and is written
    // into the message row below, which keeps local development working without a bucket.
    inline: key ? null : file.buffer.toString('base64'),
  });
});

// ---------------------------------------------------------------------------------------------
// The answer

router.post('/chats/:id/messages', async (req, res) => {
  const chat = ownedChat(req, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });

  const question = String(req.body?.text || '').trim();
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!question && !attachments.length) {
    return res.status(400).json({ error: 'Type a question or attach a file.' });
  }

  const documentIds = safeParse(chat.document_ids, []);
  const projectDocs = chat.project_id ? await loadProjectDocuments(chat.project_id, documentIds) : [];

  const prior = db.prepare(`SELECT role, content, attachments FROM ai_chat_messages WHERE chat_id=? ORDER BY id`)
    .all(chat.id);
  const historyChars = prior.reduce((n, m) => n + String(m.content || '').length, 0);

  const tier = chooseTier({
    question,
    attachmentCount: attachments.length,
    projectDocumentCount: projectDocs.length,
    historyChars,
    forceDeep: req.body?.deep === true,
  });

  // Written before the answer is asked for, so a question is never lost because the connection
  // dropped halfway through the reply.
  const userRow = db.prepare(`
    INSERT INTO ai_chat_messages (chat_id, role, content, attachments) VALUES (?, 'user', ?, ?)
  `).run(chat.id, question, attachments.length ? JSON.stringify(attachments) : null);

  if (!chat.title) {
    db.prepare(`UPDATE ai_chats SET title=? WHERE id=?`).run(titleFrom(question), chat.id);
  }

  // Server-sent events. The browser reads this with fetch rather than EventSource, which cannot
  // carry the Authorization header this API requires.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('start', {
    messageId: userRow.lastInsertRowid,
    tier: tier.key,
    tierLabel: tier.label,
    model: tier.model,
    reason: tier.reason,
  });

  try {
    const stored = [
      ...prior,
      { role: 'user', content: question, attachments: JSON.stringify(attachments) },
    ];
    const bytes = await loadAttachments(stored);
    const { messages } = toApiMessages(stored, row => blocksFor(row, bytes));

    const answer = await streamAnswer({
      model: tier.model,
      // The documents go in front of the conversation, not inside it — see documentsTurn.
      messages: [...documentsTurn(projectDocs), ...messages],
      onText: fragment => send('text', { t: fragment }),
    });

    const saved = db.prepare(`
      INSERT INTO ai_chat_messages
        (chat_id, role, content, tier, model, reason, input_tokens, output_tokens, cache_read, cache_write)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chat.id, answer.text, tier.key, tier.model, tier.reason,
      answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite);

    db.prepare(`UPDATE ai_chats SET updated_at=datetime('now') WHERE id=?`).run(chat.id);

    send('done', {
      messageId: saved.lastInsertRowid,
      truncated: answer.stopReason === 'max_tokens',
      usage: answer.usage,
    });
  } catch (err) {
    console.error('Coaster AI error:', err);
    // The headers are already out, so this cannot be an HTTP status — the page listens for it.
    send('error', { error: friendlyAiError(err) });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------------------------

// The project documents this chat was pointed at, with their bytes.
//
// Only ones the caller may see, and only the ones they ticked — attaching a whole contract to every
// question would be both expensive and rarely what was wanted. Read from object storage where that
// is configured and from the row where it is not, which is the same pair every module here handles.
async function loadProjectDocuments(projectId, documentIds) {
  if (!documentIds.length) return [];
  const placeholders = documentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, label, file_name, file_key, file_blob
    FROM project_contracts WHERE project_id=? AND id IN (${placeholders})
  `).all(projectId, ...documentIds);

  const out = [];
  for (const row of rows) {
    const bytes = await storage.readFile({ key: row.file_key, blob: row.file_blob }).catch(() => null);
    if (bytes && bytes.length) {
      out.push({ name: row.label || row.file_name, data: Buffer.from(bytes).toString('base64') });
    }
  }
  return out;
}

// Every file anyone attached anywhere in this conversation, fetched once and keyed by where it
// lives. An attachment is written to object storage on upload and only its key is kept on the
// message, so without this the model would be handed a conversation that talks about a drawing
// nobody gave it.
async function loadAttachments(stored) {
  const files = stored.flatMap(row => safeParse(row.attachments, []));
  const bytes = new Map();
  for (const file of files) {
    if (!file) continue;
    const id = file.key || file.name;
    if (!id || bytes.has(id)) continue;
    if (file.inline) { bytes.set(id, file.inline); continue; }
    const buffer = await storage.readFile({ key: file.key, blob: null }).catch(() => null);
    if (buffer && buffer.length) bytes.set(id, Buffer.from(buffer).toString('base64'));
  }
  return bytes;
}

// Content blocks for one stored message: the files first, then the words.
function blocksFor(row, bytes) {
  const blocks = [];
  for (const file of safeParse(row.attachments, [])) {
    const data = bytes.get(file?.key || file?.name);
    if (!data) continue;
    blocks.push(file.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.mediaType, data } });
  }
  return blocks;
}

// The project's documents as one fixed opening turn.
//
// They belong to the conversation rather than to any question in it, so they are sent once, at the
// front, where they never move. That is what makes them nearly free after the first turn: prompt
// caching works on a prefix that is byte-for-byte identical to last time, and a contract that
// shifted position — or rode along on whichever message happened to be first after trimming — would
// break the cache on every turn and be paid for in full each time.
function documentsTurn(docs) {
  if (!docs.length) return [];
  const content = docs.map(doc => ({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
  }));
  content.push({
    type: 'text',
    text: 'These are the project documents for this conversation: '
      + `${docs.map(d => d.name).join(', ')}. Answer from them where they are relevant, and quote `
      + 'the part you rely on. Where they do not settle a question, say so rather than filling the '
      + 'gap from general knowledge.',
  });
  return [
    { role: 'user', content },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood — I have read them and will quote from them.' }] },
  ];
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

module.exports = router;
