// Proves a sideways photograph comes back upright, and an upright one is left alone.
//
// The check is a corner test. A synthetic photo is painted with a different solid colour in each
// quadrant, an EXIF orientation tag is written into it, and after turning it upright the four
// corners have to be the colours a viewer honouring that tag would have shown. Comparing whole
// images would pass on an approximation; comparing corners fails the moment two orientations get
// swapped for each other, which is exactly the mistake this code invites.

const assert = require('assert');
const jpeg = require('jpeg-js');
const { uprightJpeg, readJpeg } = require('../lib/imageOrientation');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

const RED = [220, 30, 30];
const GREEN = [30, 190, 60];
const BLUE = [40, 70, 210];
const YELLOW = [230, 205, 40];

// A deliberately non-square photo, so a 90-degree turn is visible in the dimensions too.
const W = 40;
const H = 20;

// Quadrants: top-left red, top-right green, bottom-left blue, bottom-right yellow.
function quadrantJpeg(width = W, height = H) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      const top = y < height / 2;
      const [r, g, b] = top ? (left ? RED : GREEN) : (left ? BLUE : YELLOW);
      const at = ((y * width) + x) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 100).data);
}

// Writes an EXIF APP1 segment carrying just the Orientation tag, immediately after the SOI.
function withOrientation(jpegBuffer, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');          // little-endian
  tiff.writeUInt16LE(42, 2);              // TIFF magic
  tiff.writeUInt32LE(8, 4);               // offset of IFD0
  tiff.writeUInt16LE(1, 8);               // one entry
  tiff.writeUInt16LE(0x0112, 10);         // Orientation
  tiff.writeUInt16LE(3, 12);              // SHORT
  tiff.writeUInt32LE(1, 14);              // count
  tiff.writeUInt16LE(orientation, 18);    // the value, in the value field
  tiff.writeUInt32LE(0, 22);              // no next IFD

  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpegBuffer.subarray(0, 2), header, exif, jpegBuffer.subarray(2)]);
}

// The colour a few pixels in from one corner, away from the JPEG ringing along the quadrant edges.
function corner(decoded, which) {
  const inset = 4;
  const x = which.includes('left') ? inset : decoded.width - 1 - inset;
  const y = which.includes('top') ? inset : decoded.height - 1 - inset;
  const at = ((y * decoded.width) + x) * 4;
  return [decoded.data[at], decoded.data[at + 1], decoded.data[at + 2]];
}

const near = (got, want) => want.every((c, i) => Math.abs(got[i] - c) <= 40);

function assertCorners(buffer, expected, label) {
  const decoded = jpeg.decode(buffer, { useTArray: true });
  for (const [which, want] of Object.entries(expected)) {
    const got = corner(decoded, which);
    assert.ok(
      near(got, want),
      `${label}: ${which} is [${got}], expected about [${want}]`
    );
  }
}

// --- The tag is found at all -----------------------------------------------------------------

test('an EXIF orientation tag is read back', () => {
  for (let o = 1; o <= 8; o++) {
    assert.strictEqual(readJpeg(withOrientation(quadrantJpeg(), o)).orientation, o);
  }
});

test('a photo with no EXIF at all reads as orientation 1', () => {
  assert.strictEqual(readJpeg(quadrantJpeg()).orientation, 1);
});

test('dimensions are read from the frame header', () => {
  const { width, height } = readJpeg(quadrantJpeg());
  assert.strictEqual(width, W);
  assert.strictEqual(height, H);
});

// --- Turning it upright ----------------------------------------------------------------------

test('an upright photo is handed back untouched, byte for byte', () => {
  const original = quadrantJpeg();
  const result = uprightJpeg(original);
  assert.strictEqual(result.rotated, false);
  assert.ok(result.buffer === original, 'the same buffer should come back, not a re-encoded copy');
});

test('orientation 1 is left alone even when the tag is present', () => {
  const result = uprightJpeg(withOrientation(quadrantJpeg(), 1));
  assert.strictEqual(result.rotated, false);
});

test('a phone held sideways (orientation 6) comes back upright', () => {
  // 6 means "turn it 90 degrees clockwise to view". The stored top-left therefore ends up
  // top-right, and a 40x20 photo becomes 20x40.
  const result = uprightJpeg(withOrientation(quadrantJpeg(), 6));
  assert.strictEqual(result.rotated, true);
  assert.strictEqual(result.width, H);
  assert.strictEqual(result.height, W);
  assertCorners(result.buffer, {
    'top-right': RED, 'bottom-right': GREEN, 'top-left': BLUE, 'bottom-left': YELLOW,
  }, 'orientation 6');
});

test('the other sideways case (orientation 8) turns the other way', () => {
  const result = uprightJpeg(withOrientation(quadrantJpeg(), 8));
  assert.strictEqual(result.width, H);
  assert.strictEqual(result.height, W);
  assertCorners(result.buffer, {
    'bottom-left': RED, 'top-left': GREEN, 'bottom-right': BLUE, 'top-right': YELLOW,
  }, 'orientation 8');
});

test('an upside-down photo (orientation 3) is turned over, keeping its shape', () => {
  const result = uprightJpeg(withOrientation(quadrantJpeg(), 3));
  assert.strictEqual(result.width, W);
  assert.strictEqual(result.height, H);
  assertCorners(result.buffer, {
    'bottom-right': RED, 'bottom-left': GREEN, 'top-right': BLUE, 'top-left': YELLOW,
  }, 'orientation 3');
});

test('the mirrored orientations are not confused with one another', () => {
  // 5 and 7 are both transposes and are the pair most easily swapped, because composing
  // "mirror then rotate" in the wrong order produces the other one.
  assertCorners(uprightJpeg(withOrientation(quadrantJpeg(), 5)).buffer, {
    'top-left': RED, 'bottom-left': GREEN, 'top-right': BLUE, 'bottom-right': YELLOW,
  }, 'orientation 5');
  assertCorners(uprightJpeg(withOrientation(quadrantJpeg(), 7)).buffer, {
    'bottom-right': RED, 'top-right': GREEN, 'bottom-left': BLUE, 'top-left': YELLOW,
  }, 'orientation 7');
  assertCorners(uprightJpeg(withOrientation(quadrantJpeg(), 2)).buffer, {
    'top-right': RED, 'top-left': GREEN, 'bottom-right': BLUE, 'bottom-left': YELLOW,
  }, 'orientation 2');
  assertCorners(uprightJpeg(withOrientation(quadrantJpeg(), 4)).buffer, {
    'bottom-left': RED, 'bottom-right': GREEN, 'top-left': BLUE, 'top-right': YELLOW,
  }, 'orientation 4');
});

// --- Failure costs the rotation, never the upload --------------------------------------------

test('a file that is not a JPEG at all comes back untouched', () => {
  const junk = Buffer.from('this is not an image');
  const result = uprightJpeg(junk);
  assert.strictEqual(result.rotated, false);
  assert.ok(result.buffer === junk);
});

test('a truncated JPEG with a rotation tag does not throw', () => {
  const truncated = withOrientation(quadrantJpeg(), 6).subarray(0, 120);
  const result = uprightJpeg(truncated);
  assert.strictEqual(result.rotated, false);
});

console.log(`\n${passed} passing`);
