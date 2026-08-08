const { splitPdf } = require('./pdfChunk');
const { askForJson } = require('./aiJson');
const { PRIORITIES } = require('./actionRegister');

// Minutes are short — a Fathom summary is a couple of pages even for a long call — so unlike
// the drawing sets elsewhere in the app these are read whole. The cap only exists so an
// accidentally-uploaded transcript of a three-hour call cannot blow the token allowance.
const MAX_PAGES = 12;
const MAX_TEXT_CHARS = 60000;

const MINUTES_TOOL = {
  name: 'record_minutes',
  description: 'Record what a project meeting decided and who agreed to do what.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A short title for this meeting, e.g. "Weekly OAC Meeting" or '
          + '"MEP Coordination". Always give one.',
      },
      meetingDate: { type: 'string', description: 'The date the meeting took place, YYYY-MM-DD.' },
      attendees: {
        type: 'array',
        description: 'Each person present, as named in the minutes.',
        items: { type: 'string' },
      },
      summary: {
        type: 'string',
        description: '3-5 sentences: what this meeting was about and what came out of it, in '
          + 'plain English for someone who was not there.',
      },
      decisions: {
        type: 'array',
        description: 'A decision the meeting reached that is NOT a task for anyone — e.g. '
          + '"Agreed to proceed with the alternate light fixture".',
        items: { type: 'string' },
      },
      actionItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            assigneeName: {
              type: 'string',
              description: 'The person who has to do it, exactly as the minutes name them. '
                + 'Omit only if genuinely nobody was named.',
            },
            task: {
              type: 'string',
              description: 'What they have to do, as a short imperative phrase under about 90 '
                + 'characters, e.g. "Send the revised duct layout to the architect".',
            },
            detail: {
              type: 'string',
              description: 'The context a reader needs to act on it: why it came up, what it '
                + 'depends on. Omit if the task line says everything.',
            },
            dueDate: { type: 'string', description: 'YYYY-MM-DD if a deadline was given or implied.' },
            priority: { type: 'string', enum: PRIORITIES },
            followUpOfId: {
              type: 'integer',
              description: 'The id from the open register above if this is the SAME job being '
                + 'chased again. Omit otherwise.',
            },
            isNowComplete: {
              type: 'boolean',
              description: 'True if the minutes say this item has been DONE.',
            },
          },
          required: ['task'],
        },
      },
    },
    required: ['title', 'actionItems'],
  },
};

const trimmed = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
};

const isoDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

function buildPrompt({ openItems, knownNames, today, projectName }) {
  // The register is keyed on the name in the minutes, so the same person written two ways
  // becomes two people owing half the work each. Rather than making the PM reconcile that by
  // hand — most of the room is external and will never be a record in this app — the names
  // already on the register travel with the extraction, and the model reuses a spelling when
  // it is plainly the same person. The roster barely changes between meetings, so after the
  // first upload this settles by itself.
  const roster = knownNames.length
    ? `NAMES ALREADY ON THIS PROJECT'S REGISTER
${knownNames.map(n => `- ${n}`).join('\n')}

When someone in these minutes is one of the people above, use the EXISTING spelling exactly
as written there, even if the minutes abbreviate or expand it — "Tom" in the minutes is
"Tom Bradley" if that is who is meant. Only use a new name for someone genuinely new.`
    : '';

  // The open register travels with every extraction. Without it each meeting would produce a
  // fresh copy of the same unfinished item, and after four meetings "chase the shop drawings"
  // appears four times with nobody able to tell it is one job. With it, a repeat becomes a
  // chase against the original, which is what shows the PM that something is stuck.
  const register = openItems.length
    ? `THE PROJECT'S CURRENTLY OPEN ACTION ITEMS
These are already on the register from earlier meetings. If this meeting discusses one of
them — chasing it, updating it, or closing it — link to it by id rather than creating a
duplicate.

${openItems.map(i => `[id ${i.id}] ${i.assignee_name || 'unassigned'}: ${i.task}${i.due_date ? ` (due ${i.due_date})` : ''}`).join('\n')}`
    : 'There are no open action items on this project yet — everything you find is new.';

  return `You are reading the minutes of a construction project meeting on behalf of the
owner's project manager. Your job is to pull out who agreed to do what, so it can go on the
project's running action register.

${projectName ? `Project: ${projectName}\n` : ''}Today's date is ${today}. Use it to resolve
relative deadlines like "by next Friday" or "in two weeks" into real dates.

${register}

${roster}

Record what you find with the record_minutes tool.

Rules:
- An action item is something a named person must DO. A statement of fact, a decision, or a
  general observation is not an action item — put decisions in "decisions" and leave the rest
  out. A register padded with non-tasks stops being read.
- Do not invent deadlines. Only give a "dueDate" when the minutes give or clearly imply one.
- Priority: "High" only when the minutes signal urgency, a blocker, or a hard deadline.
  Most items are "Medium". Do not mark everything high — it makes the register useless.
- "followUpOfId" is important. If the meeting is chasing something already on the register
  above, link it rather than repeating it. Match on the underlying job, not the wording.
- "isNowComplete" lets a meeting close an item out. Set it only when the minutes actually say
  it was done, not when someone merely promises to do it.
- "assigneeName" must match an existing name from the roster above whenever it is that
  person. Otherwise write it as the minutes do. Never invent a surname for someone new — if
  the minutes only say "Mike", that is the name.
- Write "task" and "detail" in plain English for a reader who is not in construction.`;
}

async function callClaude(content) {
  const { data } = await askForJson({
    content,
    tool: MINUTES_TOOL,
    maxTokens: 4000,
    label: 'meeting extract',
    truncatedMessage: 'These minutes produced more action items than one response can hold. '
      + 'Try uploading the summary rather than the full transcript.',
  });
  return data;
}

// Reads a set of minutes. Accepts either an uploaded document or text pasted straight out of
// Fathom, because the summary is as often copied from the browser as exported to a file.
//
// Everything returned is a draft: the PM confirms the items, the assignees and the dates on a
// review screen before any of it reaches the register.
async function extractMeeting({ buffer, mimeType, text, openItems = [], knownNames = [], today, projectName }) {
  const content = [];

  if (buffer) {
    if (mimeType === 'application/pdf') {
      const parts = await splitPdf(buffer, MAX_PAGES);
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: parts[0].buffer.toString('base64') },
      });
    } else {
      // Fathom also exports plain text and markdown; both arrive as a buffer and are read as
      // text rather than being refused for not being a PDF.
      content.push({ type: 'text', text: `THE MINUTES:\n\n${buffer.toString('utf8').slice(0, MAX_TEXT_CHARS)}` });
    }
  } else if (text) {
    content.push({ type: 'text', text: `THE MINUTES:\n\n${String(text).slice(0, MAX_TEXT_CHARS)}` });
  } else {
    throw new Error('Provide the minutes, either as a file or pasted in.');
  }

  content.push({ type: 'text', text: buildPrompt({ openItems, knownNames, today, projectName }) });
  const parsed = await callClaude(content);

  const openIds = new Set(openItems.map(i => i.id));
  const actionItems = (Array.isArray(parsed.actionItems) ? parsed.actionItems : [])
    .map(item => {
      const followUp = Number(item.followUpOfId);
      return {
        assigneeName: trimmed(item.assigneeName),
        task: trimmed(item.task),
        detail: trimmed(item.detail),
        dueDate: isoDate(item.dueDate),
        priority: PRIORITIES.includes(trimmed(item.priority)) ? trimmed(item.priority) : 'Medium',
        // An id the model invented would silently attach this to the wrong item, so only ids
        // that were actually on the register are honoured.
        followUpOfId: openIds.has(followUp) ? followUp : null,
        isNowComplete: item.isNowComplete === true,
      };
    })
    .filter(item => item.task);

  return {
    title: trimmed(parsed.title) || 'Project Meeting',
    meetingDate: isoDate(parsed.meetingDate),
    attendees: Array.isArray(parsed.attendees)
      ? parsed.attendees.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()).slice(0, 40)
      : [],
    summary: trimmed(parsed.summary),
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.filter(d => typeof d === 'string' && d.trim()).slice(0, 20)
      : [],
    actionItems,
  };
}

module.exports = { extractMeeting, MAX_PAGES };
