// Typesetting the organization's filled memo cover as the first page of the merged package.
//
// This is the page that goes to an owner for signature, and it is now made of the customer's own
// words rather than of a template that resembled them. The thing that must not happen is a memo
// whose text silently differs from the Word file it was made from — a dropped paragraph, a line
// that ran off the bottom of the page, a character the font could not print taking the whole
// document down with it.

const assert = require('assert');
const PizZip = require('pizzip');
const { renderDocxAsPdf, looksLikeHeading } = require('../lib/docxToPdf');
const renderMemoCoverPdf = (b, branding) => renderDocxAsPdf(b, { branding, confidential: true });
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

// A .docx carrying a real inline picture — the relationship, the media part and the content type,
// which is what the reader has to follow to get the bytes back.
function docxWithImage(before, imageBuffer, after) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').folder('media').file('image1.jpeg', imageBuffer);
  zip.folder('word').folder('_rels').file('document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpeg"/>'
    + '</Relationships>');

  const drawing = '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + '<wp:extent cx="1000000" cy="750000"/><wp:docPr id="1" name="Picture 1"/>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic>'
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

  zip.folder('word').file('document.xml',
    '<?xml version="1.0"?><w:document '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + `<w:body>${before.map(para).join('')}${drawing}${after.map(para).join('')}</w:body></w:document>`);
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

// --- The letterhead is drawn once, not twice ----------------------------------------------------

test('a document that already carries the letterhead does not get a second one', async () => {
  // Coaster's own Word memo and Word report print the address at the top, because they have to
  // look right when opened in Word. Drawing it again here put it on the page twice.
  const branding = { companyName: 'Olivier Inc\n3934 Cypress Creek Pkwy, Suite 355\nHouston, Texas 77068' };
  const withHeader = ['Olivier Inc', '3934 Cypress Creek Pkwy, Suite 355', 'Houston, Texas 77068', ...MEMO];
  const [page] = await textOf(await renderDocxAsPdf(docx(withHeader), { branding }));
  assert.strictEqual((page.match(/Cypress Creek/g) || []).length, 1, page);
});

test('a document without it still gets the letterhead drawn', async () => {
  // A customer's own letter usually keeps its letterhead in a Word header or as an image, neither
  // of which is read back — so suppressing it for everyone would leave those memos unheaded.
  const branding = { companyName: 'Olivier Inc\n3934 Cypress Creek Pkwy, Suite 355' };
  const [page] = await textOf(await renderDocxAsPdf(docx(MEMO), { branding }));
  assert.strictEqual((page.match(/Cypress Creek/g) || []).length, 1, page);
  assert.ok(page.includes('Olivier Inc'));
});

test('the confidential marking is not doubled either', async () => {
  const body = ['Client Confidential', ...MEMO];
  const [page] = await textOf(await renderDocxAsPdf(docx(body), { confidential: true }));
  assert.strictEqual((page.match(/Client Confidential/g) || []).length, 1, page);
});

// --- Pictures ------------------------------------------------------------------------------------

test('a photograph in the Word file reaches the PDF, in its place', async () => {
  const jpeg = require('jpeg-js');
  const width = 40; const height = 30;
  const data = Buffer.alloc(width * height * 4, 140);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const photo = Buffer.from(jpeg.encode({ data, width, height }, 80).data);

  const buffer = docxWithImage(['Site Pictures:'], photo, ['North elevation ductwork']);
  const pdf = await renderDocxAsPdf(buffer);
  const [page] = await textOf(pdf);
  assert.ok(page.includes('Site Pictures:'));
  assert.ok(page.includes('North elevation ductwork'), 'the caption follows the picture');
  // Text extraction cannot see a picture, so look for the image object itself. A JPEG embedded by
  // pdf-lib is a DCTDecode XObject; a byte-size threshold would have passed on the version of this
  // that silently dropped the picture.
  const raw = pdf.toString('latin1');
  assert.ok(/DCTDecode/.test(raw), 'no JPEG image object in the PDF');
  assert.ok(/\/Subtype\s*\/Image/.test(raw), 'no image XObject in the PDF');
});

test('a small picture is embedded too, not only a phone-sized one', async () => {
  // pdf-lib reads an image through a DataView on the underlying ArrayBuffer without honouring the
  // byte offset, and Buffer.from() takes small allocations from Node's shared pool — so a picture
  // under a few kilobytes was read from the wrong place and reported as "SOI not found in JPEG".
  // A real site photo is megabytes and never hit it; an icon or a logo always would.
  const jpeg = require('jpeg-js');
  const tiny = Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 60).data);
  assert.ok(tiny.length < 4096, 'the fixture has to be small enough to land in the pool');

  const pdf = await renderDocxAsPdf(docxWithImage(['Before'], tiny, ['After']));
  assert.ok(/DCTDecode/.test(pdf.toString('latin1')), 'the small picture was dropped');
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
