// Writing confirmed placeholders into a customer's Word document.
//
// The case that motivated these: a progress report template whose title read "… Progress
// Report-7". The report number was correctly identified as "7" — and applying it rewrote every
// other 7 in the document, turning the company's own address "1177 West Loop South" into "1122"
// and the visit date "2026-07-14" into "2026-02-14". A memo cover never exposed this because no
// memo field is one character long.

const assert = require('assert');
const PizZip = require('pizzip');
const { applyPlaceholders } = require('../lib/memoCover');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

const para = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

function docx(lines) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${lines.map(para).join('')}</w:body></w:document>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  return zip.generate({ type: 'nodebuffer' });
}

// applyPlaceholders answers { buffer, changed }.
const readText = result => [...new PizZip(result.buffer || result).file('word/document.xml').asText()
  .matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('\n');

const REPORT = [
  'Aldine ISD Middle School Progress Report-7',
  'Date: 2026-07-14      Time: 9:00 AM',
  'Contractor: Tellepsen',
  'Prepared by Olivier Inc. · 1177 West Loop South, Houston TX',
];

// --- The one that broke ----------------------------------------------------------------------

test('a one-digit report number does not rewrite every other 7 in the document', () => {
  const out = applyPlaceholders(docx(REPORT), [
    { find: '7', field: 'report_number' },
  ], 'progress-cover');
  const text = readText(out);
  assert.ok(text.includes('Progress Report-{{report_number}}'), 'the title number is a placeholder');
  assert.ok(text.includes('1177 West Loop South'), `the address was rewritten: ${text}`);
  assert.ok(text.includes('2026-07-14'), `the date was rewritten: ${text}`);
  assert.ok(text.includes('9:00 AM'), 'the time was rewritten');
});

test('a short value still applies where it stands on its own', () => {
  const out = applyPlaceholders(docx(['Report No. 7', 'Suite 700']), [
    { find: '7', field: 'report_number' },
  ], 'progress-cover');
  const text = readText(out);
  assert.ok(text.includes('Report No. {{report_number}}'));
  assert.ok(text.includes('Suite 700'), 'a 7 inside a longer number is left alone');
});

// --- Ordinary spans keep working -------------------------------------------------------------

test('a normal field is still replaced everywhere it appears', () => {
  const out = applyPlaceholders(docx([
    'From: Devin Roy', 'Contractor: Tellepsen', 'Signed, Devin Roy',
  ]), [{ find: 'Devin Roy', field: 'submitted_by' }], 'progress-cover');
  const text = readText(out);
  assert.strictEqual([...text.matchAll(/\{\{submitted_by\}\}/g)].length, 2);
});

test('a span that is part of a longer word is not matched', () => {
  const out = applyPlaceholders(docx(['Contractor: ERC', 'Commercial: ERCOT filing']), [
    { find: 'ERC', field: 'contractor' },
  ], 'progress-cover');
  const text = readText(out);
  assert.ok(text.includes('Contractor: {{contractor}}'));
  assert.ok(text.includes('ERCOT filing'), `ERCOT was mangled: ${text}`);
});

test('a span edged with punctuation is unaffected by the boundary rule', () => {
  const out = applyPlaceholders(docx(['Total: $12,500.00 due on receipt']), [
    { find: '$12,500.00', field: 'total_price' },
  ], 'memo-cover');
  assert.ok(readText(out).includes('Total: {{total_price}} due'));
});

// --- The overlap filter ----------------------------------------------------------------------

test('a value is not dropped merely because a shorter one appears inside a word of it', () => {
  // "2026-07-14" was being discarded as a container of the report number "7", so the date never
  // became a field at all.
  const out = applyPlaceholders(docx(REPORT), [
    { find: '2026-07-14', field: 'date' },
    { find: '7', field: 'report_number' },
  ], 'progress-cover');
  const text = readText(out);
  assert.ok(text.includes('{{date}}'), `the date was dropped: ${text}`);
  assert.ok(text.includes('Progress Report-{{report_number}}'), 'the number is still a field');
  assert.ok(text.includes('1177 West Loop South'), 'and the address is still intact');
});

test('a genuinely wider span still gives way to the specific ones inside it', () => {
  const out = applyPlaceholders(docx(['Project: Aldine ISD Rebuild — Acme Mechanical']), [
    { find: 'Aldine ISD Rebuild — Acme Mechanical', field: 'report_title' },
    { find: 'Aldine ISD Rebuild', field: 'project_name' },
    { find: 'Acme Mechanical', field: 'contractor' },
  ], 'progress-cover');
  const text = readText(out);
  assert.ok(text.includes('{{project_name}}'), 'the project name survives');
  assert.ok(text.includes('{{contractor}}'), 'the contractor survives');
  assert.ok(!text.includes('{{report_title}}'), 'the container gave way');
});

console.log(`\n${passed} passing`);
