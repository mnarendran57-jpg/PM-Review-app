const { PDFDocument } = require('pdf-lib');

// ORIENTATION: LOOKED AT, NOT REWRITTEN.
//
// This module used to turn rotated pages upright by re-drawing each one through pdf-lib's
// embedPage with a rotation transform. That was a mistake, and an expensive one to have shipped:
// it corrupted the very document it was meant to rescue.
//
// The evidence. A real previous pay application carrying /Rotate 270 on both pages, scanned and
// JBIG2-compressed, was read correctly as it arrived — right project, right application number,
// right contract sum of $437,000. The same document after being "normalized" here came back as a
// different project entirely, with a contract sum of $3,250,000 that appears nowhere on it. The
// re-drawn page did not carry its image through intact, and a page that renders as nothing does
// not produce an error: it produces a confident, plausible, invented pay application.
//
// The reason the rewrite was never needed is simpler still. THE READER ALREADY HONOURS /Rotate.
// A page marked 270 is presented to it the way a person holding the paper would see it, so there
// was nothing to correct. The skill's instruction to normalize orientation is written for a
// pipeline that rasterises pages itself; here that job is already done, correctly, upstream.
//
// What remains is worth keeping, because it is the part that could never be fixed by rewriting: a
// page scanned sideways with /Rotate 0 — where the IMAGE is rotated and the file never says so —
// is invisible to both the reader and to any transform, and the only useful thing to do with it is
// tell somebody.

// A continuation sheet is wider than it is tall on almost every form, so landscape alone proves
// nothing. This is why the suspicion is reported and never acted on: it is also the shape a
// sideways scan has, and only a person looking at the page can tell the two apart.
const LANDSCAPE_RATIO = 1.2;

async function inspectOrientation(buffer, label = 'document') {
  let source;
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    // A document this cannot open is not a document to discard. Hand it back untouched and let the
    // reader fail on it with its own error rather than one from here.
    return { rotated: [], sidewaysSuspects: [], unreadable: err.message };
  }

  const rotated = [];
  const sidewaysSuspects = [];
  source.getPages().forEach((page, i) => {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (angle !== 0) {
      // Recorded so a reader can see it was considered, not because anything is done about it.
      rotated.push({ page: i + 1, angle });
      return;
    }
    const { width, height } = page.getSize();
    if (width > height * LANDSCAPE_RATIO) sidewaysSuspects.push({ page: i + 1 });
  });

  if (rotated.length) {
    console.log(`[orientation] ${label}: ${rotated.length} page(s) carry a rotation `
      + `(${rotated.map(r => `p${r.page} ${r.angle}°`).join(', ')}); the reader applies it.`);
  }
  return { rotated, sidewaysSuspects };
}

module.exports = { inspectOrientation };
