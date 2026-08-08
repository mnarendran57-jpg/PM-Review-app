const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { askForJson } = require('./aiJson');

// An organization's own memo cover, in Word, driving the memo Coaster produces.
//
// The point is that the output IS the customer's document — their fonts, their letterhead,
// their tables — rather than an approximation of it redrawn by this app. That means filling
// their .docx in place rather than reading it and re-rendering.
//
// Placeholders use the same {{field}} form the first customer's template already uses, so a
// file prepared by hand needs no conversion at all.
const DELIMITERS = { start: '{{', end: '}}' };

// The fields a proposal can supply. The AI is only ever allowed to map onto these, because a
// placeholder naming a field that is never populated renders as a blank in a signed document.
const FIELDS = [
  { key: 'date', label: "Today's date" },
  { key: 'to_name', label: 'Who the memo is addressed to' },
  { key: 'from_name', label: 'Who the memo is from' },
  { key: 'project_name', label: 'Project name' },
  { key: 'vendor_name', label: 'Vendor or contractor name' },
  { key: 'memo_type', label: '"Proposal" or "Change Order"' },
  { key: 'po_number', label: 'Purchase order number' },
  { key: 'po_reference', label: 'Wording referencing the PO, or blank' },
  { key: 'scope_of_work', label: 'Scope of work described in the proposal' },
  { key: 'total_price', label: 'Total price' },
  { key: 'change_order_price', label: 'Change order amount' },
  { key: 'original_po_amount', label: 'Original PO amount' },
  { key: 'new_total_amount', label: 'PO total after the change' },
  { key: 'request_sentence', label: 'The sentence asking for the requisition or PO increase' },
];
const FIELD_KEYS = new Set(FIELDS.map(f => f.key));

const DOC_XML = 'word/document.xml';

const unescapeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function loadZip(buffer) {
  try {
    return new PizZip(buffer);
  } catch {
    const err = new Error('That file could not be read as a Word document (.docx).');
    err.status = 400;
    throw err;
  }
}

// Word splits a sentence across several runs whenever formatting or spell-check state
// changes mid-line, so the text of a paragraph is never in one place. Reading it back means
// concatenating every <w:t> the paragraph contains.
function paragraphsOf(xml) {
  const out = [];
  const paras = xml.split(/<w:p[ >]/).slice(1);
  for (const chunk of paras) {
    const body = chunk.slice(0, chunk.indexOf('</w:p>') === -1 ? undefined : chunk.indexOf('</w:p>'));
    const text = [...body.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map(m => unescapeXml(m[1])).join('');
    out.push(text);
  }
  return out;
}

// The memo's text, paragraph by paragraph. Used to show the user what was read and to give
// the model something to reason about.
function readDocx(buffer) {
  const zip = loadZip(buffer);
  const file = zip.file(DOC_XML);
  if (!file) {
    const err = new Error('That .docx has no readable document body.');
    err.status = 400;
    throw err;
  }
  const paragraphs = paragraphsOf(file.asText()).map(p => p.trim());
  return {
    paragraphs,
    text: paragraphs.filter(Boolean).join('\n'),
    hasPlaceholders: /\{\{\s*\w+\s*\}\}/.test(paragraphs.join('\n')),
  };
}

// "find" has to come back byte-for-byte or the literal match fails, and a memo's scope line
// routinely carries an inch mark or a quoted phrase. Asking for this as text-and-parse meant
// exactly those memos — the ones with a dimension in them — failed to read at all.
const PLACEHOLDER_TOOL = {
  name: 'propose_placeholders',
  description: 'Propose which parts of a memo cover vary from memo to memo.',
  input_schema: {
    type: 'object',
    properties: {
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            find: {
              type: 'string',
              description: 'The exact text in the memo that should become variable, copied '
                + 'character for character.',
            },
            field: { type: 'string', enum: [...FIELD_KEYS] },
            confidence: { type: 'string', enum: ['high', 'low'] },
            why: {
              type: 'string',
              description: 'A short phrase for the person confirming this, e.g. "this looks '
                + 'like the vendor\'s name".',
            },
          },
          required: ['find', 'field', 'confidence'],
        },
      },
      notes: {
        type: 'string',
        description: 'Anything the user should know: a value you could not map, or a field '
          + 'this memo seems to need that is not in the list.',
      },
    },
    required: ['replacements'],
  },
};

function buildPrompt(text) {
  return `You are looking at a construction project manager's memo cover — the letter that
goes on top of a vendor proposal when it is sent to an owner for approval. This particular
copy is a filled-in example or a blank form. Your job is to work out which parts of it change
from memo to memo, so it can be reused as a template.

THE MEMO AS IT READS TODAY:
"""
${text}
"""

These are the only values this app can supply. Map onto these and nothing else:
${FIELDS.map(f => `  ${f.key} — ${f.label}`).join('\n')}

Report your proposals with the propose_placeholders tool.

Rules:
- "find" must appear in the memo above EXACTLY as you write it, including capitalisation and
  punctuation. It is used for a literal text match; an approximation will not be found.
- Only mark text that genuinely varies between memos. A heading, a standing instruction, a
  signature block job title and the company's own address stay as they are.
- Do not map two different pieces of text to the same field unless they really are the same
  value repeated.
- Prefer the smallest span that captures the value. For a line reading "Project: Aldine ISD
  Middle School", mark only "Aldine ISD Middle School", not the whole line.
- Where the memo already contains a {{field}} placeholder, leave it alone — do not include it
  in "replacements".
- Mark "confidence" as "low" when you are guessing from position rather than from the wording
  around it. The user reviews these, and a flagged guess is far more useful than a confident
  wrong one.`;
}

// Reads an uploaded memo and proposes which parts of it are variable. Nothing is written:
// the proposals are shown to the user, who confirms or corrects them before the template is
// saved. A memo goes to an owner for signature, so a misread field must not reach one
// silently.
async function proposePlaceholders(buffer) {
  const { text, paragraphs, hasPlaceholders } = readDocx(buffer);
  if (!text.trim()) {
    const err = new Error('No text could be read from that document.');
    err.status = 400;
    throw err;
  }

  const { data: parsed } = await askForJson({
    content: [{ type: 'text', text: buildPrompt(text) }],
    tool: PLACEHOLDER_TOOL,
    maxTokens: 3000,
    label: 'memo placeholders',
  });

  // Anything that does not literally appear in the document is dropped rather than offered:
  // it could not be applied, so showing it would only invite the user to approve a no-op.
  const replacements = (Array.isArray(parsed.replacements) ? parsed.replacements : [])
    .filter(r => r && typeof r.find === 'string' && r.find.trim() && FIELD_KEYS.has(r.field))
    .filter(r => text.includes(r.find))
    .map(r => ({
      find: r.find,
      field: r.field,
      confidence: r.confidence === 'high' ? 'high' : 'low',
      why: typeof r.why === 'string' ? r.why : null,
      // Every occurrence is replaced, which is usually what a memo wants — the sender's name
      // appears in the From line and again over the signature, and both should follow the
      // same field. It is surfaced rather than assumed, so a phrase that happens to repeat
      // for unrelated reasons is visible before the template is saved.
      occurrences: text.split(r.find).length - 1,
    }));

  // Overlapping proposals are the one failure that silently produces a worse template. The
  // model sometimes offers both "Aldine ISD Rebuild" and "Aldine ISD Rebuild — Acme Mechanical
  // Proposal"; applied together the longer one wins and the vendor and memo type never become
  // fields at all. The container is dropped in favour of the granular pieces, which is also
  // the better outcome for a sentence wrapping a price: keeping the price as its own field
  // leaves the surrounding wording intact.
  const kept = [];
  const dropped = [];
  for (const r of replacements) {
    const swallowsAnother = replacements.some(o => o !== r && r.find.includes(o.find));
    (swallowsAnother ? dropped : kept).push(r);
  }

  const notes = [
    parsed.notes || null,
    dropped.length
      ? `${dropped.length} wider suggestion(s) were set aside because they overlapped more specific ones: `
        + dropped.map(d => `"${d.find.slice(0, 40)}${d.find.length > 40 ? '…' : ''}"`).join(', ')
      : null,
  ].filter(Boolean).join(' ') || null;

  return { paragraphs, hasPlaceholders, replacements: kept, notes, fields: FIELDS };
}

// Rewrites the .docx so the confirmed spans become {{field}} tags.
//
// A paragraph that needs substituting is collapsed into a single run carrying the first run's
// formatting. That is deliberate: Word may split one sentence across a dozen runs, and
// replacing text across a run boundary otherwise corrupts the file. The cost is that mixed
// formatting inside that one paragraph — a bold word mid-sentence — is flattened to the
// paragraph's opening style. Only paragraphs actually being changed are touched, so the rest
// of the document keeps its formatting exactly.
function applyPlaceholders(buffer, replacements) {
  const zip = loadZip(buffer);
  const xml = zip.file(DOC_XML).asText();

  // Overlaps are filtered on proposal, but a mapping edited by hand can reintroduce one, and
  // the damage is silent: the wider span consumes the narrower and a field quietly disappears
  // from the template. Dropped here too rather than trusted to have been caught upstream.
  const candidates = (replacements || []).filter(r => r && r.find && FIELD_KEYS.has(r.field));
  const wanted = candidates
    .filter(r => !candidates.some(o => o !== r && r.find.includes(o.find)))
    // Longest first, so a short value nested inside a longer one cannot pre-empt it.
    .sort((a, b) => b.find.length - a.find.length);
  if (wanted.length === 0) return { buffer, changed: 0 };

  let changed = 0;

  // Rebuilds one paragraph if any replacement applies to it.
  const rewriteParagraph = (openTag, body) => {
    const text = [...body.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map(m => unescapeXml(m[1])).join('');
    if (!text) return openTag + body;

    let next = text;
    let hit = false;
    for (const r of wanted) {
      if (next.includes(r.find)) {
        next = next.split(r.find).join(`{{${r.field}}}`);
        hit = true;
      }
    }
    if (!hit) return openTag + body;
    changed++;

    // Keep the paragraph's own properties and the first run's formatting.
    const pPr = body.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    const rPr = body.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const rebuilt = `${pPr ? pPr[0] : ''}<w:r>${rPr ? rPr[0] : ''}`
      + `<w:t xml:space="preserve">${escapeXml(next)}</w:t></w:r>`;
    return openTag + rebuilt;
  };

  // Walk paragraphs without a regex over the whole document, so nested content cannot make
  // the match run past the paragraph it belongs to.
  let out = '';
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf('<w:p', index);
    if (start === -1) { out += xml.slice(index); break; }
    const openEnd = xml.indexOf('>', start);
    // <w:pPr>, <w:pStyle> etc. also begin with "<w:p" — only a real paragraph is processed.
    const tagName = xml.slice(start, openEnd + 1);
    if (!/^<w:p(\s[^>]*)?\/?>$/.test(tagName)) {
      out += xml.slice(index, openEnd + 1);
      index = openEnd + 1;
      continue;
    }
    const close = xml.indexOf('</w:p>', openEnd);
    if (close === -1) { out += xml.slice(index); break; }

    out += xml.slice(index, start);
    out += rewriteParagraph(tagName, xml.slice(openEnd + 1, close));
    out += '</w:p>';
    index = close + '</w:p>'.length;
  }

  zip.file(DOC_XML, out);
  return { buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), changed };
}

// Fills a prepared template with the values for one memo and returns the finished .docx —
// the customer's own document, formatting intact.
function fillDocx(templateBuffer, data) {
  const zip = loadZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    delimiters: DELIMITERS,
    paragraphLoop: true,
    linebreaks: true,
    // A field the proposal did not supply prints as empty rather than throwing, so one
    // missing value never costs the whole memo.
    nullGetter: () => '',
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  readDocx, proposePlaceholders, applyPlaceholders, fillDocx,
  FIELDS, FIELD_KEYS, DELIMITERS,
};
