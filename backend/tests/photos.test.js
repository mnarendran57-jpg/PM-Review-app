// Proves that handing a photo to the worker gives the same answer as doing it in place, and that
// the thread answering requests keeps answering while it happens — which is the whole point.

const assert = require('assert');
const jpeg = require('jpeg-js');
const { uprightJpeg, fitJpeg } = require('../lib/imageOrientation');
const photos = require('../lib/photos');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

function photo(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    data[i] = (p % width) & 255;
    data[i + 1] = Math.floor(p / width) & 255;
    data[i + 2] = (p * 7) & 255;
    data[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 85).data);
}

// Writes an EXIF APP1 segment carrying just the Orientation tag, immediately after the SOI.
function withOrientation(jpegBuffer, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpegBuffer.subarray(0, 2), header, exif, jpegBuffer.subarray(2)]);
}

(async () => {
  console.log('\nThe worker gives the same answer as doing it in place:');

  await test('a sideways photo comes back turned, byte for byte the same as before', async () => {
    const sideways = withOrientation(photo(400, 200), 6);
    const direct = uprightJpeg(sideways);
    const viaWorker = await photos.upright(sideways);
    assert.strictEqual(viaWorker.rotated, true);
    assert.strictEqual(viaWorker.width, direct.width);
    assert.strictEqual(viaWorker.height, direct.height);
    assert.ok(viaWorker.buffer.equals(direct.buffer), 'the turned photo differs from the in-place result');
  });

  await test('an upright photo is handed back untouched — the same buffer, not a copy', async () => {
    const original = photo(400, 200);
    const result = await photos.upright(original);
    assert.strictEqual(result.rotated, false);
    assert.ok(result.buffer === original);
  });

  await test('a large photo is fitted, byte for byte the same as before', async () => {
    const large = photo(3000, 2000);
    const direct = fitJpeg(large);
    const viaWorker = await photos.fit(large);
    assert.ok(viaWorker.length < large.length, 'the fitted copy should be smaller');
    assert.ok(viaWorker.equals(direct), 'the fitted photo differs from the in-place result');
  });

  await test('a photo already small enough is handed back untouched — the same buffer', async () => {
    const small = photo(800, 600);
    assert.ok((await photos.fit(small)) === small);
  });

  await test('something that is not a photo comes back as it arrived', async () => {
    const junk = Buffer.from('this is not a jpeg');
    assert.ok((await photos.fit(junk)) === junk);
    assert.ok((await photos.upright(junk)).buffer === junk);
  });

  console.log('\nThe request thread keeps answering while photos are processed:');

  await test('six large photos in a row never hold the request thread for long', async () => {
    const large = withOrientation(photo(3000, 2000), 6);
    // What a health check sees: something that should run every few milliseconds, and how long it
    // was ever kept waiting.
    let last = Date.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);

    const started = Date.now();
    for (let i = 0; i < 6; i++) await photos.upright(large);
    const took = Date.now() - started;
    clearInterval(tick);

    assert.ok(took > 300, `expected real work to have been done, but it took only ${took}ms`);
    assert.ok(longest < 150, `the request thread was held for ${longest}ms while photos were processed`);
    console.log(`       ${took}ms of photo work; the longest the request thread waited was ${longest}ms`);
  });

  await test('photos asked for at the same time are all answered, in turn', async () => {
    const large = photo(2400, 1600);
    const results = await Promise.all([photos.fit(large), photos.fit(large), photos.fit(large)]);
    assert.ok(results.every(r => r.length < large.length));
    assert.deepStrictEqual(photos.stats(), { waiting: 0, busy: false });
  });

  console.log(`\n${failed === 0 ? 'All' : ''} ${passed} check${passed === 1 ? '' : 's'} passed`
    + `${failed ? `, ${failed} FAILED` : '.'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
