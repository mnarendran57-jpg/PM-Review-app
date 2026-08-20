const jpeg = require('jpeg-js');

// Turning a site photo the right way up, once, at the point it is uploaded.
//
// A phone held sideways does not rotate the pixels it writes. It writes them in the sensor's
// own orientation and records a number — the EXIF Orientation tag — saying how far round the
// photo has to be turned to look right. A photo viewer honours that tag, and so does a browser,
// which is why a picture that looks upright in the upload box arrives in the report lying on its
// side: pdf-lib draws the pixels, and the pixels were never upright.
//
// This is fixed here rather than in the renderers because there is more than one consumer and
// they would each have to be right. The PDF draws the photo, a Word template embeds it, and
// Claude looks at it to write the observations — a model shown a sideways photograph describes
// a sideways site. Rotating the bytes once, before any of that, means all three see the same
// upright image and none of them has to know the tag exists.
//
// Only JPEG is handled, which is the only format the module accepts.

const SOI = 0xffd8;
const APP1 = 0xffe1;
// Markers carrying no length field, so scanning must not try to skip past one.
const STANDALONE = new Set([0xd8, 0xd9, 0x01]);
// SOF0-SOF15 hold the image dimensions. SOF4 (0xc4, DHT), SOF8 (0xc8) and SOF12 (0xcc, DAC)
// are not frame headers despite sitting in the range.
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// The eight EXIF orientations, written as where each pixel of the upright image comes from in
// the stored one. Stated this way round — destination asks source — because that is the order the
// copy loop runs in, and because composing "flip, then rotate" by hand is how the two transposed
// orientations get silently swapped for each other.
//
// `turned` says the result is the stored image's height by its width. w and h below are the
// stored image's dimensions.
const TRANSFORMS = {
  1: { turned: false, from: (x, y) => [x, y] },
  2: { turned: false, from: (x, y, w) => [w - 1 - x, y] },                 // mirrored
  3: { turned: false, from: (x, y, w, h) => [w - 1 - x, h - 1 - y] },      // 180°
  4: { turned: false, from: (x, y, w, h) => [x, h - 1 - y] },              // mirrored, 180°
  5: { turned: true, from: (x, y) => [y, x] },                             // transposed
  6: { turned: true, from: (x, y, w, h) => [y, h - 1 - x] },               // 90° clockwise
  7: { turned: true, from: (x, y, w, h) => [w - 1 - y, h - 1 - x] },       // transverse
  8: { turned: true, from: (x, y, w) => [w - 1 - y, x] },                  // 90° anticlockwise
};

// Walks the JPEG's marker segments, reporting the EXIF orientation and the pixel dimensions.
// Anything unreadable answers orientation 1 — an unrotated photo is the same photo, whereas
// throwing here would cost the upload.
function readJpeg(buffer) {
  const out = { orientation: 1, width: 0, height: 0 };
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt16BE(0) !== SOI) return out;

  let at = 2;
  while (at + 3 < buffer.length) {
    if (buffer[at] !== 0xff) { at++; continue; }          // resync on a stray byte
    const marker = buffer[at + 1];
    if (marker === 0xff) { at++; continue; }              // fill byte
    if (STANDALONE.has(marker)) { at += 2; continue; }
    if (marker === 0xda) break;                           // start of scan — no headers past here

    const length = buffer.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buffer.length) break;
    const body = buffer.subarray(at + 4, at + 2 + length);

    if (marker === (APP1 & 0xff) && body.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
      const found = readExifOrientation(body.subarray(6));
      if (found) out.orientation = found;
    } else if (SOF.has(marker) && body.length >= 5) {
      out.height = body.readUInt16BE(1);
      out.width = body.readUInt16BE(3);
    }
    at += 2 + length;
  }
  return out;
}

// The Orientation tag (0x0112) out of the TIFF header an EXIF block carries. The block is
// little- or big-endian depending on the camera, which is what "II"/"MM" says.
function readExifOrientation(tiff) {
  if (tiff.length < 8) return null;
  const endian = tiff.subarray(0, 2).toString('latin1');
  if (endian !== 'II' && endian !== 'MM') return null;
  const little = endian === 'II';
  const u16 = at => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = at => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return null;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return TRANSFORMS[value] ? value : null;
    }
  }
  return null;
}

// Rebuilds a decoded RGBA buffer upright. Written out rather than done with a canvas because
// there is no canvas here, and the operation is a pixel copy either way.
function transformPixels({ data, width, height }, transform) {
  const outW = transform.turned ? height : width;
  const outH = transform.turned ? width : height;
  const out = Buffer.alloc(outW * outH * 4);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = transform.from(x, y, width, height);
      const at = ((sy * width) + sx) * 4;
      out.set(data.subarray(at, at + 4), ((y * outW) + x) * 4);
    }
  }
  return { data: out, width: outW, height: outH };
}

// The photo, upright. Returns { buffer, width, height, rotated } — `rotated` says whether the
// bytes were rewritten, so a caller can tell the difference between "already upright" and
// "turned", and so the common case costs nothing.
//
// A photo that cannot be decoded comes back untouched. A site report missing one photograph's
// rotation is a far better outcome than a site report that could not be produced.
function uprightJpeg(buffer) {
  const { orientation, width, height } = readJpeg(buffer);
  const transform = TRANSFORMS[orientation] || TRANSFORMS[1];
  if (orientation === 1) return { buffer, width, height, rotated: false };

  try {
    // useTArray keeps the pixels in a typed array rather than a Buffer-of-numbers, which for a
    // 12-megapixel photograph is the difference between tens of megabytes and hundreds.
    const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 2048 });
    const turned = transformPixels(decoded, transform);
    // 88 is close enough to visually lossless for a photograph printed at 3 inches wide, and
    // keeps a 40-photo report from doubling in size.
    const encoded = jpeg.encode({ data: turned.data, width: turned.width, height: turned.height }, 88);
    return {
      buffer: Buffer.from(encoded.data),
      width: turned.width, height: turned.height,
      rotated: true,
    };
  } catch (err) {
    console.warn('[photo] could not be turned upright, using it as it arrived:', err.message);
    return { buffer, width, height, rotated: false };
  }
}

// --- Fitting a photo to the size it is actually printed at -----------------------------------
//
// A phone photograph is around 12 megapixels and four megabytes. A progress report prints it about
// three inches wide. Embedding the original put the whole four megabytes into the document for
// every photo: a four-photo report came to 11MB, and a twenty-photo site visit would have come to
// fifty — which most mail servers refuse, so the report could not be sent at all.
//
// The copy that goes into the document is fitted to roughly what it is printed at, at a resolution
// well above what any printer resolves. The original is untouched on the server, so nothing is
// lost: this is only the copy that travels.

// The largest a photo is ever printed in either report is about three and a half inches. 1600
// pixels across that is over 450 dots per inch — past what a printer or a screen can show, and
// still enough to zoom into a label on a piece of equipment.
const DEFAULT_MAX_EDGE = 1600;

// Averages the source pixels each destination pixel covers, rather than picking one of them.
// Sampling a single pixel is much faster and looks it: on a four-times reduction the fine detail in
// a site photo — a strut, a grille, printed text on a nameplate — breaks into aliased noise.
function boxScale({ data, width, height }, outW, outH) {
  const out = Buffer.alloc(outW * outH * 4);
  const xRatio = width / outW;
  const yRatio = height / outH;

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));

      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let at = ((sy * width) + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += data[at]; g += data[at + 1]; b += data[at + 2];
          at += 4; n++;
        }
      }
      const to = ((y * outW) + x) * 4;
      out[to] = r / n; out[to + 1] = g / n; out[to + 2] = b / n; out[to + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

// A copy of the photo no larger than `maxEdge` on its longest side. A photo already that size or
// smaller is handed straight back, so the common case costs nothing. Anything that cannot be
// decoded is handed back as it arrived — a report that is larger than it needed to be is a far
// better outcome than a report that could not be produced.
function fitJpeg(buffer, { maxEdge = DEFAULT_MAX_EDGE, quality = 82 } = {}) {
  const { width, height } = readJpeg(buffer);
  if (!width || !height) return buffer;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return buffer;

  try {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 2048 });
    const scale = maxEdge / longest;
    const scaled = boxScale(
      decoded,
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
    const encoded = jpeg.encode(scaled, quality);
    // Only if it actually helped. A photo that was already efficiently compressed can come back
    // larger from a re-encode, and shipping a bigger file to save space would be absurd.
    return encoded.data.length < buffer.length ? Buffer.from(encoded.data) : buffer;
  } catch (err) {
    console.warn('[photo] could not be resized, using it at full size:', err.message);
    return buffer;
  }
}

// Dimensions only, for a photo already known to be upright — what the Word template needs to
// work out how big to draw it.
const jpegSize = buffer => {
  const { width, height } = readJpeg(buffer);
  return { width, height };
};

module.exports = { uprightJpeg, fitJpeg, jpegSize, readJpeg, DEFAULT_MAX_EDGE };
