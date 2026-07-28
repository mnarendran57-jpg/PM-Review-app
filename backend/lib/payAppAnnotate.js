const { PDFDocument, PDFName, PDFString, rgb } = require('pdf-lib');

// Marks up the contractor's own pay application PDF with the review findings, instead of
// producing a separate report the reader has to cross-reference by hand. Each failing
// check is anchored to the actual figure it concerns: the number is circled in red and a
// sticky-note comment is attached next to it, so the issue is read in context.
//
// Anchoring works off the PDF's text layer. Every check's `detail` already names the
// specific dollar amounts involved ("Line 8 shows $310,732.37, but ..."), so those are
// pulled out and matched against the positioned text extracted from the page. No changes
// to the 27 checks are needed — they keep describing findings in plain English.

const AUTHOR = 'Pay App Review';
const MONEY_RE = /\$\s?[\d,]+\.\d{2}/g;

const normalizeNumber = s => String(s).replace(/[$,\s]/g, '');

// Pulls positioned text out of every page via pdfjs. Returns one entry per page with the
// item strings and their coordinates in PDF user space (origin bottom-left, matching
// pdf-lib's drawing space).
async function extractTextPositions(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const i of tc.items) {
      const str = (i.str || '').trim();
      if (!str) continue;
      items.push({
        str,
        norm: normalizeNumber(str),
        x: i.transform[4],
        y: i.transform[5],
        w: i.width || 0,
        h: i.height || 9,
      });
    }
    pages.push({ pageIndex: p - 1, items });
  }
  await doc.destroy();
  return pages;
}

// Finds where a dollar figure appears. Summary-sheet findings should land on the cover
// page when the same number also repeats on the continuation sheet, so earlier pages win
// ties. Anything already used is skipped so two findings never stack on one spot.
function findAnchor(pages, value, used) {
  const target = normalizeNumber(value);
  if (!target || target === '0.00') return null;
  for (const page of pages) {
    for (const item of page.items) {
      if (item.norm !== target) continue;
      const id = `${page.pageIndex}:${Math.round(item.x)}:${Math.round(item.y)}`;
      if (used.has(id)) continue;
      used.add(id);
      return { pageIndex: page.pageIndex, x: item.x, y: item.y, w: item.w, h: item.h };
    }
  }
  return null;
}

// The figures a finding talks about, most-specific first.
function valuesInDetail(detail) {
  return [...String(detail || '').matchAll(MONEY_RE)].map(m => m[0]);
}

function addStickyNote(pdfDoc, page, { x, y, contents, subject }) {
  const size = 18;
  const annot = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Name: 'Comment',
    Rect: [x, y - size, x + size, y],
    Contents: PDFString.of(contents),
    T: PDFString.of(AUTHOR),
    Subj: PDFString.of(subject || 'Review finding'),
    C: [1, 0.85, 0.2],
    CA: 1,
    F: 4, // print
  });
  const ref = pdfDoc.context.register(annot);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing && typeof existing.push === 'function') existing.push(ref);
  else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([ref]));
}

// Red ellipse around the figure, drawn into the page content so it shows in every viewer
// (not just ones that render annotations).
function circleValue(page, { x, y, w, h }, color) {
  const padX = 6;
  const padY = 3;
  const cx = x + w / 2;
  const cy = y + h / 3;
  page.drawEllipse({
    x: cx, y: cy,
    xScale: Math.max(w / 2 + padX, 14),
    yScale: Math.max(h / 2 + padY, 8),
    borderColor: color,
    borderWidth: 1.5,
    color,
    opacity: 0.18,
    borderOpacity: 0.95,
  });
}

// Builds the marked-up copy. `results` are the check results; only failures are marked.
async function annotatePayAppPdf({ pdfBuffer, results, header }) {
  const pages = await extractTextPositions(pdfBuffer);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const docPages = pdfDoc.getPages();

  const failures = (results || []).filter(r => r.status === 'FAIL');
  const used = new Set();
  const marked = [];
  const unplaced = [];

  for (const r of failures) {
    const critical = !!r.critical;
    const color = critical ? rgb(0.85, 0.1, 0.1) : rgb(0.9, 0.45, 0.05);
    let anchor = null;
    for (const v of valuesInDetail(r.detail)) {
      anchor = findAnchor(pages, v, used);
      if (anchor) break;
    }
    if (!anchor || !docPages[anchor.pageIndex]) { unplaced.push(r); continue; }

    const page = docPages[anchor.pageIndex];
    circleValue(page, anchor, color);
    addStickyNote(pdfDoc, page, {
      x: anchor.x + anchor.w + 10,
      y: anchor.y + anchor.h + 6,
      subject: `${critical ? 'Resolve before approving' : 'Problem found'} — ${r.description}`,
      contents: `${r.description}\n\n${r.detail}`,
    });
    marked.push(r);
  }

  // Findings whose figures aren't on the page (or that reference no figure at all) would
  // otherwise vanish silently, so they go in one note on page 1 rather than being dropped.
  if (unplaced.length > 0 && docPages[0]) {
    const body = unplaced
      .map(r => `• ${r.description}\n  ${r.detail}`)
      .join('\n\n');
    addStickyNote(pdfDoc, docPages[0], {
      x: 24,
      y: docPages[0].getHeight() - 24,
      subject: `${unplaced.length} further finding${unplaced.length === 1 ? '' : 's'}`,
      contents: `These findings could not be tied to a specific figure on the page:\n\n${body}`,
    });
  }

  return {
    buffer: Buffer.from(await pdfDoc.save()),
    markedCount: marked.length,
    unplacedCount: unplaced.length,
    totalFailures: failures.length,
  };
}

module.exports = { annotatePayAppPdf, extractTextPositions };
