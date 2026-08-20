// Typesetting the organization's filled memo cover as the first page of the merged package.
//
// This is the page that goes to an owner for signature, and it is now made of the customer's own
// words rather than of a template that resembled them. The thing that must not happen is a memo
// whose text silently differs from the Word file it was made from — a dropped paragraph, a line
// that ran off the bottom of the page, a character the font could not print taking the whole
// document down with it.

const assert = require('assert');
const PizZip = require('pizzip');
const { renderMemoCoverPdf, looksLikeHeading } = require('../lib/memoCoverPdf');
const { readTextPages } = require('../lib/pdfTextLayer');

let passed = 0;
const results = [];
const test = (name, fn) => results.push({ name, fn });

const para = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

function docx(lines) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${lines.map(para).join('')}</w:body></w:document>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  return zip.generate({ type: 'nodebuffer' });
}

const MEMO = [
  'MEMORANDUM',
  'Date: August 20, 2026',
  'To: James Walker',
  'From: Devin Roy',
  'Subject: Recommendation Memo',
  'We have reviewed the proposal from Acme Mechanical in the amount of $62,400.00 and find the '
    + 'pricing reasonable and consistent with the scope of work described.',
  'We respectfully request a requisition be issued.',
  'Sincerely,',
  'Devin Roy, Project Manager',
];

const textOf = async buffer => {
  const pages = await readTextPages(buffer);
  return pages.map(p => String(p.text || '').replace(/\s+/g, ' ').trim());
};

// --- Every word survives -----------------------------------------------------------------------

test('every paragraph of the memo reaches the page', async () => {
  const [page] = await textOf(await renderMemoCoverPdf(docx(MEMO)));
  for (const line of MEMO) {
    const needle = line.slice(0, 40).replace(/\s+/g, ' ');
    assert.ok(page.includes(needle), `missing from the PDF: "${needle}"`);
  }
});

test('an edit to the Word file changes the page', async () => {
  const edited = MEMO.map(l => l.replace('reasonable and consistent', 'reasonable, SUBJECT TO a warranty'));
  const [page] = await textOf(await renderMemoCoverPdf(docx(edited)));
  assert.ok(page.includes('SUBJECT TO a warranty'), 'the edit did not reach the PDF');
  assert.ok(!page.includes('reasonable and consistent'), 'the superseded wording is still there');
});

test('a long memo continues onto a second page rather than being cut off', async () => {
  const long = [];
  for (let i = 0; i < 60; i++) {
    long.push(`Paragraph ${i}: the vendor has provided pricing for this portion of the work and `
      + 'the amounts have been checked against the schedule of values line by line.');
  }
  const pages = await textOf(await renderMemoCoverPdf(docx(long)));
  assert.ok(pages.length > 1, `a 60-paragraph memo produced ${pages.length} page(s)`);
  const all = pages.join(' ');
  assert.ok(all.includes('Paragraph 0:'), 'the first paragraph is missing');
  assert.ok(all.includes('Paragraph 59:'), 'the last paragraph was dropped off the end');
});

// --- The letterhead ---------------------------------------------------------------------------

test('the organization\'s address is printed', async () => {
  const [page] = await textOf(await renderMemoCoverPdf(docx(MEMO), {
    companyName: 'Olivier Inc\n3934 Cypress Creek Pkwy, Suite 355\nHouston, Texas 77068',
  }));
  assert.ok(page.includes('Olivier Inc'));
  assert.ok(page.includes('3934 Cypress Creek Pkwy'));
});

test('a customer with no letterhead gets a clean memo, not somebody else\'s', async () => {
  const [page] = await textOf(await renderMemoCoverPdf(docx(MEMO), {}));
  assert.ok(page.includes('MEMORANDUM'), 'the memo itself is still there');
  assert.ok(!page.includes('Olivier'), 'another company\'s name leaked in');
});

// --- Characters the built-in fonts cannot print -------------------------------------------------

test('a memo containing characters the PDF font cannot encode still renders', async () => {
  // A PM writing in Word gets curly quotes, en dashes and the odd arrow for free. pdf-lib's
  // standard fonts raise rather than skip on an unencodable character, so one pasted symbol used
  // to take down the whole package.
  const awkward = [
    'MEMORANDUM',
    'Scope: rebalance the AHU — target 5% → 85% of design airflow, ≈ 12,000 CFM.',
    'The vendor’s price of $62,400.00 is “reasonable” per §4.2 of the agreement.',
  ];
  const [page] = await textOf(await renderMemoCoverPdf(docx(awkward)));
  assert.ok(page.includes('MEMORANDUM'));
  assert.ok(/rebalance the AHU/.test(page), `the scope line did not render: ${page}`);
  assert.ok(/4\.2 of the agreement/.test(page), 'the section reference did not render');
});

test('a document with no readable text is refused rather than producing a blank memo', async () => {
  await assert.rejects(() => renderMemoCoverPdf(docx([])), /No text could be read/);
});

test('a file that is not a Word document is refused with a message a person can act on', async () => {
  await assert.rejects(
    () => renderMemoCoverPdf(Buffer.from('this is not a docx')),
    /could not be read as a Word document/,
  );
});

// --- Which lines are drawn as headings ----------------------------------------------------------

test('headings are recognised without pretending to have read Word\'s formatting', () => {
  assert.ok(looksLikeHeading('MEMORANDUM'), 'an all-capitals line is a heading');
  assert.ok(looksLikeHeading('Scope of Work:'), 'a short line ending in a colon is a heading');
  assert.ok(!looksLikeHeading(
    'We have reviewed the proposal from Acme Mechanical and find the pricing reasonable.'),
  'a sentence of prose is not a heading');
  assert.ok(!looksLikeHeading(
    'The following items were reviewed against the contract and the schedule of values:'),
  'a long lead-in ending in a colon is prose, not a heading');
  assert.ok(!looksLikeHeading('Date: August 20, 2026'), 'a field line is not a heading');
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passing`);
})();
