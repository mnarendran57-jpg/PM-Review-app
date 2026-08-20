const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { askForJson } = require('./aiJson');
const { COVER_KINDS, DEFAULT_KIND } = require('./coverTemplates');

// An organization's own document, in Word, driving what Coaster produces — their memo cover for
// Proposal Intake, their progress report for Progress Report.
//
// The point is that the output IS the customer's document — their fonts, their letterhead,
// their tables — rather than an approximation of it redrawn by this app. That means filling
// their .docx in place rather than reading it and re-rendering.
//
// Placeholders use the same {{field}} form the first customer's template already uses, so a
// file prepared by hand needs no conversion at all.
//
// Which fields exist, and what the model is told it is reading, come from lib/coverTemplates.js.
// Everything below is the same for every kind of cover.
const DELIMITERS = { start: '{{', end: '}}' };

// The fields a filled copy can supply. The AI is only ever allowed to map onto these, because a
// placeholder naming a field that is never populated renders as a blank in a signed document.
const kindOf = kind => COVER_KINDS[kind] || COVER_KINDS[DEFAULT_KIND];
const fieldsFor = kind => kindOf(kind).fields;
const fieldKeysFor = kind => new Set(fieldsFor(kind).map(f => f.key));

// Kept for callers that predate there being more than one kind of cover.
const FIELDS = COVER_KINDS[DEFAULT_KIND].fields;
const FIELD_KEYS = new Set(FIELDS.map(f => f.key));

const DOC_XML = 'word/document.xml';

const unescapeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// --- Matching a span without matching inside a word -----------------------------------------
//
// A placeholder is applied by literal text match, and for a memo that was fine: no memo field is
// ever one character long. A progress report has one that is — the report number — and a bare "7"
// matched inside "1177 West Loop South" and inside the date "2026-07-14", so confirming a
// perfectly correct mapping silently rewrote the company's own address and the visit date.
//
// A span whose edge is alphanumeric only matches where that edge is not against another
// alphanumeric character. "7" therefore still matches in "Progress Report-7" and no longer in
// "1177"; a span edged with punctuation is unaffected, so nothing that used to work stops.
const isWordChar = c => /[A-Za-z0-9]/.test(c || '');

function boundedIndexes(haystack, needle) {
  const out = [];
  if (!needle) return out;
  const needsLeft = isWordChar(needle[0]);
  const needsRight = isWordChar(needle[needle.length - 1]);
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + needle.length] || '';
    if (!(needsLeft && isWordChar(before)) && !(needsRight && isWordChar(after))) out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

const boundedIncludes = (haystack, needle) => boundedIndexes(haystack, needle).length > 0;
const boundedCount = (haystack, needle) => boundedIndexes(haystack, needle).length;

function boundedReplace(haystack, needle, replacement) {
  const hits = boundedIndexes(haystack, needle);
  if (!hits.length) return haystack;
  let out = '';
  let cursor = 0;
  for (const at of hits) {
    if (at < cursor) continue;   // an overlapping hit whose text has already been consumed
    out += haystack.slice(cursor, at) + replacement;
    cursor = at + needle.length;
  }
  return out + haystack.slice(cursor);
}

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
const placeholderTool = kind => ({
  name: 'propose_placeholders',
  description: `Propose which parts of a ${kindOf(kind).noun} vary from one to the next.`,
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
              description: 'The exact text in the document that should become variable, copied '
                + 'character for character.',
            },
            field: { type: 'string', enum: [...fieldKeysFor(kind)] },
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
          + 'this document seems to need that is not in the list.',
      },
    },
    required: ['replacements'],
  },
});

function buildPrompt(text, kind) {
  const def = kindOf(kind);
  const repeating = def.fields.filter(f => f.repeating);
  return `${def.intro}

THE ${def.document.toUpperCase()} AS IT READS TODAY:
"""
${text}
"""

These are the only values this app can supply. Map onto these and nothing else:
${def.fields.map(f => `  ${f.key} — ${f.label}`).join('\n')}

Report your proposals with the propose_placeholders tool.

Rules:
- "find" must appear in the ${def.document} above EXACTLY as you write it, including
  capitalisation and punctuation. It is used for a literal text match; an approximation will not
  be found.
- Only mark text that genuinely varies between ${def.document}s. A heading, a standing
  instruction, a signature block job title and the company's own address stay as they are.
- Do not map two different pieces of text to the same field unless they really are the same
  value repeated.
- Prefer the smallest span that captures the value. For a line reading "Project: Aldine ISD
  Middle School", mark only "Aldine ISD Middle School", not the whole line.
- Where the ${def.document} already contains a {{field}} placeholder, leave it alone — do not
  include it in "replacements".
- Mark "confidence" as "low" when you are guessing from position rather than from the wording
  around it. The user reviews these, and a flagged guess is far more useful than a confident
  wrong one.${repeating.length ? `
- ${repeating.map(f => f.key).join(' and ')} repeat. Mark ONE example each — a single bullet, a
  single caption — never the whole list. The paragraph holding it is copied once per item when
  the ${def.document} is produced, so marking two of them produces the list twice.` : ''}${
  (def.extraRules || []).map(rule => `\n- ${rule}`).join('')}`;
}

// Reads an uploaded memo and proposes which parts of it are variable. Nothing is written:
// the proposals are shown to the user, who confirms or corrects them before the template is
// saved. A memo goes to an owner for signature, so a misread field must not reach one
// silently.
async function proposePlaceholders(buffer, kind = DEFAULT_KIND) {
  const def = kindOf(kind);
  const fieldKeys = fieldKeysFor(kind);
  const { text, paragraphs, hasPlaceholders } = readDocx(buffer);
  if (!text.trim()) {
    const err = new Error('No text could be read from that document.');
    err.status = 400;
    throw err;
  }

  const { data: parsed } = await askForJson({
    content: [{ type: 'text', text: buildPrompt(text, kind) }],
    tool: placeholderTool(kind),
    maxTokens: 3000,
    label: `${def.noun} placeholders`,
  });

  // Anything that does not literally appear in the document is dropped rather than offered:
  // it could not be applied, so showing it would only invite the user to approve a no-op.
  const replacements = (Array.isArray(parsed.replacements) ? parsed.replacements : [])
    .filter(r => r && typeof r.find === 'string' && r.find.trim() && fieldKeys.has(r.field))
    .filter(r => boundedIncludes(text, r.find))
    .map(r => ({
      find: r.find,
      field: r.field,
      confidence: r.confidence === 'high' ? 'high' : 'low',
      why: typeof r.why === 'string' ? r.why : null,
      // Every occurrence is replaced, which is usually what a memo wants — the sender's name
      // appears in the From line and again over the signature, and both should follow the
      // same field. It is surfaced rather than assumed, so a phrase that happens to repeat
      // for unrelated reasons is visible before the template is saved.
      occurrences: boundedCount(text, r.find),
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
    // Bounded, for the same reason as everywhere else: "2026-07-14" does not contain the report
    // number "7" in any sense that matters, and treating it as a container dropped the date.
    const swallowsAnother = replacements.some(o => o !== r && boundedIncludes(r.find, o.find));
    (swallowsAnother ? dropped : kept).push(r);
  }

  const notes = [
    parsed.notes || null,
    dropped.length
      ? `${dropped.length} wider suggestion(s) were set aside because they overlapped more specific ones: `
        + dropped.map(d => `"${d.find.slice(0, 40)}${d.find.length > 40 ? '…' : ''}"`).join(', ')
      : null,
  ].filter(Boolean).join(' ') || null;

  return { paragraphs, hasPlaceholders, replacements: kept, notes, fields: def.fields };
}

// Rewrites the .docx so the confirmed spans become {{field}} tags.
//
// A paragraph that needs substituting is collapsed into a single run carrying the first run's
// formatting. That is deliberate: Word may split one sentence across a dozen runs, and
// replacing text across a run boundary otherwise corrupts the file. The cost is that mixed
// formatting inside that one paragraph — a bold word mid-sentence — is flattened to the
// paragraph's opening style. Only paragraphs actually being changed are touched, so the rest
// of the document keeps its formatting exactly.
function applyPlaceholders(buffer, replacements, kind = DEFAULT_KIND) {
  const fieldKeys = fieldKeysFor(kind);
  const zip = loadZip(buffer);
  const xml = zip.file(DOC_XML).asText();

  // Overlaps are filtered on proposal, but a mapping edited by hand can reintroduce one, and
  // the damage is silent: the wider span consumes the narrower and a field quietly disappears
  // from the template. Dropped here too rather than trusted to have been caught upstream.
  const candidates = (replacements || []).filter(r => r && r.find && fieldKeys.has(r.field));
  const wanted = candidates
    .filter(r => !candidates.some(o => o !== r && boundedIncludes(r.find, o.find)))
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
      const replaced = boundedReplace(next, r.find, `{{${r.field}}}`);
      if (replaced !== next) { next = replaced; hit = true; }
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
  loadZip, paragraphsOf, escapeXml, unescapeXml, DOC_XML,
  fieldsFor, fieldKeysFor,
  FIELDS, FIELD_KEYS, DELIMITERS,
};
