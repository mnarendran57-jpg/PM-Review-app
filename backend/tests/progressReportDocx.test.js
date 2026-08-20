// Coaster's own progress report as a Word document — the editable version of the PDF, offered to
// everyone whether or not they have uploaded a template of their own.
//
// A .docx that Word declines to open fails silently from here: the bytes are produced, the
// download works, and the customer gets a file that says it is corrupt. So these check the parts
// that decide whether it opens — the package's required parts, balanced tags, a relationship and a
// content type per image — as much as the words on the page.

const assert = require('assert');
const PizZip = require('pizzip');
const jpeg = require('jpeg-js');
const { renderProgressReportDocx } = require('../lib/progressReportDocx');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

function photo(width = 24, height = 16) {
  const data = Buffer.alloc(width * height * 4, 120);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

// Only the signature and the IHDR chunk matter here — nothing decodes these bytes, they are only
// measured and copied into the package.
function pngOf(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;  // bit depth, colour type
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
  ]);
}

const REPORT = {
  progress: [
    'Irrigation work has begun, along with associated plumbing works.',
    'Several grates have not been covered, which could cause dirt to enter the storm sewers.',
  ],
};

const HEADER = {
  projectName: 'Spring Branch AHU Replacement',
  reportNumber: 4,
  visitDate: '2026-08-20',
  visitTime: '10:15 AM',
  weather: 'Hot and clear',
  submittedBy: 'Naren Murali',
  contractor: 'ERC',
};

const PHOTOS = [
  { buffer: photo(40, 20), caption: 'Irrigation trench, north side' },
  { buffer: photo(20, 40), caption: 'Uncovered storm grate' },
  { buffer: photo(), caption: 'Housekeeping, north corridor' },
];

const build = (over = {}) => renderProgressReportDocx({
  report: REPORT, header: HEADER, photos: PHOTOS, ...over,
});

const doc = buffer => new PizZip(buffer).file('word/document.xml').asText();
const textOf = buffer => [...doc(buffer).matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
  .map(m => m[1]).join('\n');
const files = buffer => Object.keys(new PizZip(buffer).files);

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

// --- The package -------------------------------------------------------------------------------

test('every part Word requires is present', () => {
  const present = files(build());
  for (const part of [
    '[Content_Types].xml', '_rels/.rels',
    'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels',
  ]) {
    assert.ok(present.includes(part), `missing ${part}`);
  }
});

test('the document is well formed', () => {
  assertBalanced(doc(build()), 'built-in report');
});

test('a page size and margins are set, so it is not left to Word to guess', () => {
  const xml = doc(build());
  assert.ok(/<w:pgSz w:w="12240" w:h="15840"\/>/.test(xml), 'US Letter');
  assert.ok(/<w:pgMar /.test(xml));
});

// --- What it says ------------------------------------------------------------------------------

test('the header block carries this visit\'s details', () => {
  const text = textOf(build());
  assert.ok(text.includes('Spring Branch AHU Replacement Progress Report-4'), text);
  for (const value of ['2026-08-20', '10:15 AM', 'Hot and clear', 'Naren Murali', 'ERC']) {
    assert.ok(text.includes(value), `missing ${value}`);
  }
});

test('every observation appears, as its own paragraph', () => {
  const xml = doc(build());
  for (const line of REPORT.progress) assert.ok(xml.includes(line), `missing: ${line}`);
  // A bullet each, not one paragraph with line breaks in it.
  assert.strictEqual([...xml.matchAll(/•/g)].length, REPORT.progress.length);
});

test('a visit with nothing to report says so', () => {
  const text = textOf(build({ report: { progress: [] } }));
  assert.ok(text.includes('No observations recorded.'));
});

test('every caption appears', () => {
  const text = textOf(build());
  for (const p of PHOTOS) assert.ok(text.includes(p.caption), `missing: ${p.caption}`);
});

test('a report with no photographs says so rather than showing an empty grid', () => {
  const out = build({ photos: [] });
  assert.ok(textOf(out).includes('No photographs were attached'));
  assert.strictEqual([...doc(out).matchAll(/<w:drawing>/g)].length, 0);
  assertBalanced(doc(out), 'no photos');
});

// --- The photographs ---------------------------------------------------------------------------

test('each photo is embedded, related and typed', () => {
  const out = build();
  assert.strictEqual([...doc(out).matchAll(/<w:drawing>/g)].length, 3);
  const media = files(out).filter(f => f.startsWith('word/media/'));
  assert.strictEqual(media.length, 3, `media parts: ${media}`);

  const rels = new PizZip(out).file('word/_rels/document.xml.rels').asText();
  for (const m of media) {
    assert.ok(rels.includes(m.replace('word/', '')), `no relationship for ${m}`);
  }
  const types = new PizZip(out).file('[Content_Types].xml').asText();
  assert.ok(/Extension="jpeg"/.test(types), 'jpeg content type');
});

test('an odd number of photos still fills its last row', () => {
  // Three photos in a two-column grid. A row short of a cell is not a valid table.
  const xml = doc(build());
  const rows = [...xml.matchAll(/<w:tr>/g)].length;
  const cells = [...xml.matchAll(/<w:tc>/g)].length;
  assert.strictEqual(cells, rows * 2, `${cells} cells across ${rows} rows`);
});

test('a photo keeps its shape', () => {
  const extents = [...doc(build()).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)]
    .map(m => ({ cx: Number(m[1]), cy: Number(m[2]) }));
  assert.strictEqual(extents.length, 3);
  assert.ok(extents[0].cx > extents[0].cy, 'the landscape photo stays landscape');
  assert.ok(extents[1].cy > extents[1].cx, 'the portrait photo stays portrait');
});

test('a photo is never drawn wider than the column it sits in', () => {
  const CELL_EMU = Math.round((Math.floor((12240 - 2880) / 2) / 1440) * 914400);
  for (const m of doc(build()).matchAll(/<wp:extent cx="(\d+)"/g)) {
    assert.ok(Number(m[1]) <= CELL_EMU, `${m[1]} EMU is wider than the cell`);
  }
});

// --- The letterhead ----------------------------------------------------------------------------

test('the organization\'s logo and address are printed when it has them', () => {
  const out = build({
    companyName: 'Olivier Inc.\n1177 West Loop South\nHouston, TX',
    logo: { buffer: photo(200, 60), mimeType: 'image/jpeg' },
  });
  const text = textOf(out);
  assert.ok(text.includes('Olivier Inc.'));
  assert.ok(text.includes('1177 West Loop South'));
  // Four drawings now: the logo plus three photos.
  assert.strictEqual([...doc(out).matchAll(/<w:drawing>/g)].length, 4);
  assertBalanced(doc(out), 'with letterhead');
});

test('a customer with no letterhead gets a clean report, not somebody else\'s', () => {
  const out = build({ companyName: null, logo: null });
  assert.strictEqual([...doc(out).matchAll(/<w:drawing>/g)].length, 3, 'photos only');
  assert.ok(!textOf(out).includes('Olivier'));
});

test('a PNG logo is drawn in its own shape, not squashed into a default box', () => {
  // The JPEG reader cannot measure a PNG, and a logo it could not measure used to be drawn in a
  // 4:3 box whatever its real proportions — which for a wide letterhead logo is very visibly wrong.
  const png = pngOf(300, 60);
  const out = build({ logo: { buffer: png, mimeType: 'image/png' } });
  const first = doc(out).match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  const ratio = Number(first[1]) / Number(first[2]);
  assert.ok(Math.abs(ratio - 5) < 0.1, `logo drawn at ${ratio}:1, expected 5:1`);
  assert.ok(/Extension="png"/.test(new PizZip(out).file('[Content_Types].xml').asText()),
    'a png needs its own content type or Word calls the file corrupt');
});

test('the logo does not take a relationship id one of the photos needs', () => {
  const out = build({ logo: { buffer: photo(200, 60), mimeType: 'image/jpeg' } });
  const ids = [...doc(out).matchAll(/r:embed="(rId\d+)"/g)].map(m => m[1]);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate embed ids: ${ids}`);
  assert.ok(!ids.includes('rId1'), 'rId1 is the styles part');
});

console.log(`\n${passed} passing`);
