// Filling an organization's own progress report template.
//
// The two things that cannot be done by substitution are what these check: a list of observations
// of unknown length, and photographs. Both are edits to the document's XML, and both fail in the
// same silent way — Word declines to open the file and says only that it is corrupt. So the
// assertions are about the parts that make a .docx openable (the relationship, the content type,
// balanced tags) as much as about the words on the page.

const assert = require('assert');
const PizZip = require('pizzip');
const jpeg = require('jpeg-js');
const { fillProgressTemplate } = require('../lib/progressCover');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>
</Relationships>`;

const para = (text, props = '') =>
  `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// A template as Word would save one: the tags are already {{field}} form, so no AI mapping is
// involved and the test is about the filling alone.
function templateDocx(bodyParagraphs) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  zip.folder('word').file('document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:body>${bodyParagraphs.join('')}</w:body></w:document>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', DOC_RELS);
  return zip.generate({ type: 'nodebuffer' });
}

const BULLET_PROPS = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>';

const STANDARD_BODY = [
  para('{{report_title}}'),
  para('Date: {{date}}      Time: {{time}}      Weather: {{weather}}'),
  para('Submitted By: {{submitted_by}}'),
  para('Contractor: {{contractor}}'),
  para('Progress:'),
  para('{{progress}}', BULLET_PROPS),
  para('Site Pictures:'),
  para('{{photo_caption}}'),
];

function photo(width = 24, height = 16) {
  const data = Buffer.alloc(width * height * 4, 128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

const readDoc = buffer => new PizZip(buffer).file('word/document.xml').asText();
const readPart = (buffer, name) => {
  const file = new PizZip(buffer).file(name);
  return file ? file.asText() : null;
};
const listFiles = buffer => Object.keys(new PizZip(buffer).files);

// Every <w:x> has a matching </w:x> in the right order. Crude next to a real parser, but it is
// exactly the failure these edits produce, and it needs no dependency.
function assertBalanced(xml, label) {
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)(w:[a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = m;
    if (selfClosing || attrs.endsWith('/')) continue;
    if (closing) {
      const open = stack.pop();
      assert.strictEqual(open, name, `${label}: </${name}> closes <${open}>`);
    } else {
      stack.push(name);
    }
  }
  assert.strictEqual(stack.length, 0, `${label}: unclosed ${stack.join(', ')}`);
}

const FIELDS = {
  report_title: 'Spring Branch Progress Report-3',
  report_number: '3',
  date: '2026-08-18',
  time: '12:30 PM',
  weather: 'Sunny',
  submitted_by: 'Naren Murali',
  project_name: 'Spring Branch',
  contractor: 'ERC',
  progress: [
    'Irrigation work has begun, along with associated plumbing works.',
    'Several grates have not been covered.',
    'Housekeeping in the north corridor needs attention.',
  ],
};

// --- The ordinary fields ---------------------------------------------------------------------

test('the single-value fields are filled with this visit\'s values', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS, photos: [],
  });
  const xml = readDoc(out);
  for (const value of ['Spring Branch Progress Report-3', '12:30 PM', 'Sunny', 'Naren Murali', 'ERC']) {
    assert.ok(xml.includes(value), `expected "${value}" in the filled report`);
  }
  assert.ok(!xml.includes('{{'), 'no placeholder should survive the fill');
});

// --- The observations ------------------------------------------------------------------------

test('one bullet becomes one paragraph per observation', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS, photos: [],
  });
  const xml = readDoc(out);
  for (const line of FIELDS.progress) assert.ok(xml.includes(line), `missing: ${line}`);
  assertBalanced(xml, 'observations');
});

test('the bullet keeps its list formatting on every copy', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS, photos: [],
  });
  const xml = readDoc(out);
  // Three observations, so three numbered-list paragraphs — not one bulleted line followed by
  // two plain ones, which is what a line-break substitution would have produced.
  assert.strictEqual([...xml.matchAll(/<w:numId w:val="2"\/>/g)].length, 3);
});

test('a visit with nothing to report says so rather than leaving a blank bullet', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [],
    fields: { ...FIELDS, progress: [] }, photos: [],
  });
  assert.ok(readDoc(out).includes('No observations were recorded'));
});

test('surrounding wording on the bullet line is kept', () => {
  const body = [...STANDARD_BODY];
  body[5] = para('- {{progress}}', BULLET_PROPS);
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(body), replacements: [], fields: FIELDS, photos: [],
  });
  assert.strictEqual([...readDoc(out).matchAll(/- Irrigation work has begun/g)].length, 1);
  assert.ok(readDoc(out).includes('- Several grates'));
});

// --- The photographs -------------------------------------------------------------------------

test('each photo is embedded, related and typed', () => {
  const photos = [
    { buffer: photo(), caption: 'Irrigation trench, north side' },
    { buffer: photo(16, 24), caption: 'Uncovered storm grate' },
  ];
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS, photos,
  });

  const files = listFiles(out);
  assert.ok(files.includes('word/media/coasterPhoto1.jpeg'), 'photo 1 is in the package');
  assert.ok(files.includes('word/media/coasterPhoto2.jpeg'), 'photo 2 is in the package');

  const rels = readPart(out, 'word/_rels/document.xml.rels');
  assert.ok(rels.includes('media/coasterPhoto1.jpeg'), 'photo 1 has a relationship');
  assert.ok(rels.includes('media/coasterPhoto2.jpeg'), 'photo 2 has a relationship');

  // Without the jpeg content type Word calls the whole file corrupt.
  assert.ok(/Extension="jpeg"/.test(readPart(out, '[Content_Types].xml')));

  const xml = readDoc(out);
  assert.ok(xml.includes('Irrigation trench, north side'));
  assert.ok(xml.includes('Uncovered storm grate'));
  assert.strictEqual([...xml.matchAll(/<w:drawing>/g)].length, 2, 'two pictures drawn');
  assertBalanced(xml, 'photos');
});

test('a photo relationship never reuses an id the document already has', () => {
  // The template's own rels go up to rId7 — a photo landing on rId1 would repoint the styles part.
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS,
    photos: [{ buffer: photo(), caption: 'One' }],
  });
  const rels = readPart(out, 'word/_rels/document.xml.rels');
  const photoRel = rels.match(/Id="(rId\d+)"[^>]*coasterPhoto1/);
  assert.ok(photoRel, 'the photo relationship should be found');
  assert.ok(Number(photoRel[1].slice(3)) > 7, `${photoRel[1]} collides with an existing id`);
  assert.ok(readDoc(out).includes(`r:embed="${photoRel[1]}"`), 'the drawing points at that id');
});

test('a photo is drawn in its own shape, not squashed into a fixed box', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS,
    photos: [
      { buffer: photo(40, 20), caption: 'Wide' },
      { buffer: photo(20, 40), caption: 'Tall' },
    ],
  });
  const extents = [...readDoc(out).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)]
    .map(m => ({ cx: Number(m[1]), cy: Number(m[2]) }));
  assert.strictEqual(extents.length, 2);
  assert.ok(extents[0].cx > extents[0].cy, 'the landscape photo stays landscape');
  assert.ok(extents[1].cy > extents[1].cx, 'the portrait photo stays portrait');
  // Aspect ratio kept to within rounding.
  assert.ok(Math.abs((extents[0].cx / extents[0].cy) - 2) < 0.02);
});

test('a template with no caption line still gets its photographs', () => {
  const body = STANDARD_BODY.filter(p => !p.includes('{{photo_caption}}'));
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(body), replacements: [], fields: FIELDS,
    photos: [{ buffer: photo(), caption: 'Appended anyway' }],
  });
  const xml = readDoc(out);
  assert.strictEqual([...xml.matchAll(/<w:drawing>/g)].length, 1);
  assert.ok(xml.includes('Appended anyway'));
  assert.ok(xml.indexOf('<w:drawing>') < xml.indexOf('</w:body>'), 'inside the body');
  assertBalanced(xml, 'appended photos');
});

test('a report with no photos leaves no empty caption behind', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS, photos: [],
  });
  const xml = readDoc(out);
  assert.ok(!xml.includes('{{photo_caption}}'));
  assert.strictEqual([...xml.matchAll(/<w:drawing>/g)].length, 0);
  assertBalanced(xml, 'no photos');
});

// --- The namespaces the drawing needs --------------------------------------------------------

test('the namespaces a picture needs are declared even when the template lacks them', () => {
  const out = fillProgressTemplate({
    templateBuffer: templateDocx(STANDARD_BODY), replacements: [], fields: FIELDS,
    photos: [{ buffer: photo(), caption: 'One' }],
  });
  const xml = readDoc(out);
  assert.ok(/<w:document[^>]*xmlns:r=/.test(xml), 'xmlns:r must be declared for r:embed');
  assert.ok(/<w:document[^>]*xmlns:wp=/.test(xml), 'xmlns:wp must be declared for wp:inline');
  // Declared once, not once per fill.
  assert.strictEqual([...xml.matchAll(/xmlns:wp=/g)].length, 1);
});

console.log(`\n${passed} passing`);
