const { PDFDocument, degrees } = require('pdf-lib');

// ORIENTATION, FIXED ON EVERY DOCUMENT BEFORE ANY OF IT IS READ.
//
// Scanned pay applications routinely arrive rotated, and the two applications in one review
// frequently disagree: a real pair on this project had the current application upright and the
// previous one carrying /Rotate 270 on every page.
//
// A rotated PREVIOUS application does more damage than a rotated current one, which is why this
// runs on everything rather than on the document in front of the reader. An error in the current
// reading surfaces as a finding against a figure someone can check on the page. An error in the
// previous reading surfaces as a continuity failure blamed on THIS month's application, sending the
// reviewer to hunt for a problem that is not there — and one badly-read prior produces dozens of
// them at once.
//
// What this does and does not fix. A page whose /Rotate says 90 or 270 is baked upright here, so
// everything downstream sees it the way a person holding the paper would. A page scanned sideways
// with /Rotate 0 — where the IMAGE is rotated and the page never says so — cannot be corrected
// without re-rendering it, and is reported instead of silently accepted.

const QUARTER_TURNS = new Set([90, 180, 270]);

// Draw the original page onto a fresh one, transformed so the declared rotation becomes part of the
// geometry. pdf-lib's embedPage ignores /Rotate, which is exactly what makes this possible: the
// content arrives unrotated and the rotation is applied here, once, permanently.
function place(target, embedded, angle, width, height) {
  if (angle === 90) return target.drawPage(embedded, { x: width, y: 0, rotate: degrees(90) });
  if (angle === 180) return target.drawPage(embedded, { x: width, y: height, rotate: degrees(180) });
  if (angle === 270) return target.drawPage(embedded, { x: 0, y: height, rotate: degrees(270) });
  return target.drawPage(embedded, { x: 0, y: 0 });
}

// Returns the buffer unchanged when nothing needed turning, so an already-upright document costs
// one parse and no rewrite.
async function normalizeOrientation(buffer, label = 'document') {
  let source;
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    // A document this cannot open is not a document this should discard. Hand it back untouched
    // and let the reader fail on it with its own error rather than one from here.
    return { buffer, rotated: [], unreadable: err.message, sidewaysSuspects: [] };
  }

  const pages = source.getPages();
  const rotated = [];
  const sidewaysSuspects = [];

  pages.forEach((page, i) => {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (QUARTER_TURNS.has(angle)) rotated.push({ page: i + 1, angle });
    else if (angle === 0) {
      // A continuation sheet is wider than it is tall on almost every form, so landscape alone
      // proves nothing. This is recorded, not acted on: it is the shape a sideways scan would also
      // have, and only a person looking at the page can tell the two apart.
      const { width, height } = page.getSize();
      if (width > height * 1.2) sidewaysSuspects.push({ page: i + 1 });
    }
  });

  if (!rotated.length) return { buffer, rotated: [], sidewaysSuspects };

  const out = await PDFDocument.create();
  for (const page of pages) {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const { width, height } = page.getSize();
    const swap = angle === 90 || angle === 270;
    const target = out.addPage([swap ? height : width, swap ? width : height]);
    // eslint-disable-next-line no-await-in-loop -- embedPage is per page and must keep page order
    const embedded = await out.embedPage(page);
    place(target, embedded, angle, target.getSize().width, target.getSize().height);
  }

  console.log(`[orientation] ${label}: turned ${rotated.length} page(s) upright `
    + `(${rotated.map(r => `p${r.page} ${r.angle}°`).join(', ')})`);
  return { buffer: Buffer.from(await out.save()), rotated, sidewaysSuspects };
}

module.exports = { normalizeOrientation };
