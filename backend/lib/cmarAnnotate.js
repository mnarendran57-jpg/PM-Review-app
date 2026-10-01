const { PDFDocument, PDFName, PDFString, StandardFonts, rgb, radians } = require('pdf-lib');
const { eachPage } = require('./pdfTextLayer');
const { toWinAnsi, wrapLine } = require('./pdfGen');
const { money } = require('./money');
const { FAIL, NOTE } = require('./cmarChecks');

// The contractor's own packet, marked up with what the audit found.
//
// WHY THIS EXISTS ALONGSIDE THE REPORT
//
// The report answers "what is wrong with this application". This answers "where". A reviewer
// holding a finding that says Line 6 is $5,000 out still has to find Line 6 among sixty-seven
// pages, and a subcontractor variance means nothing until you are looking at the row it came
// from. Circling the figure on the page the contractor sent is the difference between a report
// that is read and one that is filed.
//
// HOW A FINDING IS PLACED
//
// Every finding this module can place already names its own figures — "The form states
// $1,830,900.00. Line 4 less Line 5 gives $1,825,900.00" — so the dollar amounts are pulled out
// of the finding's own words and matched against positioned text from the page. Nothing in the
// checks had to change to support this, and nothing in the checks may be written differently
// because of it: a finding is written for a person to read, and this takes what it happens to say.
//
// WHEN THERE IS NO TEXT LAYER
//
// A scanned packet has no positions to anchor to, so nothing can be circled. That is common and
// must not produce an empty document pretending to be a markup. Every copy therefore opens with a
// findings page listing everything, placed or not — so the marked-up packet is worth opening even
// when not one figure could be circled, and a finding can never be silently lost because its
// number was a picture.

const AUTHOR = 'Pay App Reviewer 3';
const MONEY_RE = /\$\s?[\d,]+(?:\.\d{2})?/g;

const RED = rgb(0.78, 0.09, 0.09);
const AMBER = rgb(0.85, 0.47, 0.05);
const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.42, 0.42, 0.42);

const normalise = s => String(s).replace(/[$,\s]/g, '');

// Positioned text for every page, in pdf-lib's drawing space (origin bottom-left), which is the
// same space pdfjs reports transforms in — so a coordinate found here can be drawn on directly.
function textPositions(buffer) {
  return eachPage(buffer, async (page, p) => {
    const content = await page.getTextContent();
    const items = [];
    for (const i of content.items) {
      const str = (i.str || '').trim();
      if (!str) continue;
      // The WHOLE transform, not just its origin.
      //
      // A pay application is full of landscape sheets saved as portrait pages with /Rotate 90, and
      // on those the text is drawn SIDEWAYS in the page's own coordinates so that it reads
      // correctly once the viewer turns the page. Measured on a real packet: a figure on the
      // certificate has the matrix [0, 6.24, -6.24, 0, 520.92, 454.2] — it advances straight UP
      // the y axis, where a flat page gives [7, 0, 0, 7, ...] and advances along x.
      //
      // Treating every run as horizontal therefore drew the mark sideways out of the figure and
      // across the rows above and below it, on exactly the pages that matter most. (a, b) is the
      // direction the text actually runs, and everything below is built from it.
      const [a, b] = [i.transform[0], i.transform[1]];
      items.push({
        str,
        norm: normalise(str),
        x: i.transform[4],
        y: i.transform[5],
        a,
        b,
        angle: Math.atan2(b, a),
        w: i.width || 0,
        h: i.height || 9,
      });
    }
    return { pageIndex: p - 1, items };
  });
}

// Where a figure appears, earliest page first — a figure on the certificate and again on the
// continuation sheet belongs on the certificate, which is the page somebody is looking at. A
// position already used is skipped so two findings never stack on one spot and hide each other.
function findAnchor(pages, value, used) {
  const target = normalise(value);
  if (!target || target === '0' || target === '0.00') return null;
  for (const page of pages) {
    for (const item of page.items) {
      if (item.norm !== target) continue;
      const id = `${page.pageIndex}:${Math.round(item.x)}:${Math.round(item.y)}`;
      if (used.has(id)) continue;
      used.add(id);
      return {
        pageIndex: page.pageIndex,
        x: item.x, y: item.y, w: item.w, h: item.h,
        angle: item.angle,
      };
    }
  }
  return null;
}

const figuresIn = text => [...String(text || '').matchAll(MONEY_RE)].map(m => m[0]);

// Where a finding that names no money belongs.
//
// The two most important findings on a real packet are usually the notary block and a
// subcontractor certifying before the period ended, and neither carries a dollar figure — so
// anchoring on money alone left exactly those on the cover page, which is where they are least
// use. A phrase is matched instead: the first run of text containing it wins, and the page it is
// on is the page the reviewer needs to be looking at.
function findPhrase(pages, phrase, used) {
  const needle = String(phrase || '').toLowerCase().trim();
  if (needle.length < 3) return null;
  for (const page of pages) {
    for (const item of page.items) {
      if (!item.str.toLowerCase().includes(needle)) continue;
      const id = `${page.pageIndex}:${Math.round(item.x)}:${Math.round(item.y)}`;
      if (used.has(id)) continue;
      used.add(id);
      return {
        pageIndex: page.pageIndex,
        x: item.x, y: item.y, w: item.w, h: item.h, angle: item.angle,
      };
    }
  }
  return null;
}

// Distinctive words from a firm's name — the same idea the subcontractor reconciliation uses, so
// "Integrated Demolition and Remediation Inc." can be found on a sheet that says "IDR".
const FIRM_NOISE = /(inc|llc|ltd|lp|llp|co|company|corp|corporation|the|and|of|industries|associates|technologies|services|group|fka|ii|iii)/gi;

function firmHandles(name) {
  const cleaned = String(name || '').replace(FIRM_NOISE, ' ').replace(/[^A-Za-z0-9 ]/g, ' ');
  const words = cleaned.split(/\s+/).filter(w => w.length > 3);
  const acronym = words.map(w => w[0]).join('');
  return [...new Set([...words, acronym].filter(w => w && w.length >= 3))];
}

function stickyNote(pdfDoc, page, { x, y, contents, subject, colour = [1, 0.85, 0.2] }) {
  const size = 18;
  const annot = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Name: 'Comment',
    Rect: [x, y - size, x + size, y],
    Contents: PDFString.of(toWinAnsi(contents)),
    T: PDFString.of(AUTHOR),
    Subj: PDFString.of(toWinAnsi(subject || 'Audit finding')),
    C: colour,
    CA: 1,
    F: 4,                                  // print, so a paper copy carries the marks too
  });
  const ref = pdfDoc.context.register(annot);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing && typeof existing.push === 'function') existing.push(ref);
  else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([ref]));
}

// The axis the text runs along, and the one across it. Everything is measured in these rather
// than in x and y, so a sideways page is not a special case — it is the same arithmetic with a
// different angle.
const axes = angle => ({
  along: [Math.cos(angle), Math.sin(angle)],
  across: [-Math.sin(angle), Math.cos(angle)],
});

// Drawn into the page content rather than added as an annotation, so it survives being printed,
// flattened, or opened in a viewer that ignores comments.
// Where the mark goes, as pure arithmetic — separated so the geometry can be checked without
// rendering a PDF and looking at it. Centre the ellipse ON the run: half its length in the
// direction it reads, and a third of its height across that, which lands on the middle of the
// glyphs rather than on the baseline.
function markGeometry({ x, y, w, h, angle = 0 }) {
  const { along, across } = axes(angle);
  return {
    cx: x + along[0] * (w / 2) + across[0] * (h / 3),
    cy: y + along[1] * (w / 2) + across[1] * (h / 3),
    xScale: Math.max(w / 2 + 6, 14),
    yScale: Math.max(h / 2 + 3, 8),
    angle,
  };
}

function circle(page, anchor, colour) {
  const { cx, cy, xScale, yScale, angle } = markGeometry(anchor);
  page.drawEllipse({
    x: cx,
    y: cy,
    xScale,
    yScale,
    // Turned to match the text. Without this the ellipse keeps the page's axes while the figure
    // keeps the text's, and on a rotated sheet the two are ninety degrees apart.
    rotate: radians(angle),
    borderColor: colour,
    borderWidth: 1.5,
    color: colour,
    opacity: 0.15,
    borderOpacity: 0.95,
  });
}

// Everything worth marking, in the order a reviewer would want to meet it.
function markable(report) {
  const out = [];

  for (const q of report.headline || []) {
    if (q.status !== FAIL) continue;
    const notary = /notaris|notarization|notary/i.test(q.question);
    out.push({
      severity: FAIL,
      title: q.question,
      detail: q.detail,
      // The notary block is on the certificate, and it is named there.
      phrases: notary ? ['subscribed and sworn', 'notary public', 'notary'] : [],
    });
  }
  for (const f of report.issues || []) {
    if ((report.headline || []).some(q => q.detail === f.detail)) continue;
    out.push({
      severity: FAIL,
      title: `${f.subject ? `${f.subject} — ` : ''}${f.title}`,
      detail: f.detail,
      // Findings about dates name the firms they concern, and those firms are named on their own
      // application pages — which is where somebody checking a certification date has to look.
      phrases: [...(f.firms || []).flatMap(firmHandles), ...firmHandles(f.subject)],
    });
  }
  for (const s of report.subcontractors || []) {
    if (s.ties === false) {
      out.push({
        severity: FAIL,
        title: `${s.firmName} does not tie to the schedule of values`,
        detail: `Billed ${money(s.subGrossThisPeriod)} gross against ${money(s.sovThisPeriod)} on the `
          + `prime's schedule — a difference of ${money(s.variance)}. ${s.basisNote || ''}`.trim(),
        phrases: [s.matchedBy, ...firmHandles(s.firmName)].filter(Boolean),
      });
    }
  }
  // Each taxed invoice separately: the whole point of the tax finding is which invoice, and one
  // note saying "nine invoices" sends the reviewer back to look for them.
  for (const inv of report.tax?.charged || []) {
    out.push({
      severity: FAIL,
      title: `Sales tax charged — ${inv.vendor}`,
      detail: `Invoice ${inv.invoiceNumber || 'without a number'} carries ${money(inv.taxAmount, true)} `
        + `of sales tax on a total of ${money(inv.total, true)}. Not payable by a tax-exempt owner.`,
      phrases: [inv.invoiceNumber, ...firmHandles(inv.vendor)].filter(Boolean),
    });
  }
  for (const f of report.worthNoting?.findings || []) {
    out.push({
      severity: NOTE,
      title: `${f.subject ? `${f.subject} — ` : ''}${f.title}`,
      detail: f.detail,
    });
  }
  for (const u of report.worthNoting?.untraceable || []) {
    out.push({
      severity: NOTE,
      title: `No backup found — ${u.item}`,
      detail: `${u.amount ? `${money(u.amount)} ` : ''}${u.note || 'Nothing in the packet traces this.'}`,
    });
  }
  return out;
}

// The page that opens the marked-up copy. It carries every finding, so the document is useful
// even when the packet is a scan and not one figure could be circled.
async function coverPage(pdfDoc, report, findings, placedCount) {
  const page = pdfDoc.insertPage(0, [612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let y = 750;
  const write = (text, { f = font, size = 10, colour = INK, indent = 0, gap = 4 } = {}) => {
    for (const line of wrapLine(toWinAnsi(String(text || '')), f, size, 532 - indent)) {
      if (y < 50) return;                        // one page; the rest is marked on the sheets
      page.drawText(line, { x: 40 + indent, y, size, font: f, color: colour });
      y -= size + 3;
    }
    y -= gap;
  };

  const h = report.header || {};
  write('Pay Application Audit — marked-up copy', { f: bold, size: 16, gap: 6 });
  const facts = [h.projectName, h.contractorName,
    h.applicationNumber ? `Application No. ${h.applicationNumber}` : null,
    h.periodTo ? `period to ${h.periodTo}` : null].filter(Boolean);
  if (facts.length) write(facts.join('   |   '), { size: 9, colour: GREY, gap: 8 });

  write(placedCount
    ? `${placedCount} of these ${findings.length} findings are circled on the pages that follow, `
      + 'each with a comment attached.'
    : 'The pages that follow could not be marked: this packet has no readable text layer, so there '
      + 'are no positions to anchor a comment to. Every finding is listed here instead.',
  { f: italic, size: 9, colour: placedCount ? GREY : AMBER, gap: 10 });

  page.drawLine({ start: { x: 40, y }, end: { x: 572, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 14;

  if (!findings.length) {
    write('No issues were found. Nothing is marked on the pages that follow.', { f: bold, colour: rgb(0.05, 0.43, 0.23) });
    return page;
  }

  findings.forEach((f, i) => {
    const colour = f.severity === FAIL ? RED : AMBER;
    write(`${i + 1}. ${f.title}`, { f: bold, size: 9.5, colour, gap: 2 });
    write(f.detail, { size: 9, indent: 14, gap: 7 });
  });

  return page;
}

// The marked-up packet.
//
// Built on request rather than stored: it is derived entirely from the audit and the original
// upload, both of which are kept, and a second copy of a sixty-seven page packet in object
// storage buys nothing. It is also the heaviest thing this module does, so doing it on download
// keeps it out of the audit's own memory peak.
async function buildMarkedUpPacket({ pdfBuffer, report }) {
  const findings = markable(report);

  let pages = [];
  try {
    pages = await textPositions(pdfBuffer);
  } catch {
    pages = [];                                   // a scan, or a PDF pdfjs cannot read: cover page only
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const docPages = pdfDoc.getPages();
  const used = new Set();
  let placed = 0;

  for (const finding of findings) {
    let anchor = null;
    // A figure first: it is the most specific thing a finding can point at.
    for (const figure of figuresIn(finding.detail)) {
      anchor = findAnchor(pages, figure, used);
      if (anchor) break;
    }
    // Then the words it names — the notary block, a firm, an invoice number.
    if (!anchor) {
      for (const phrase of finding.phrases || []) {
        anchor = findPhrase(pages, phrase, used);
        if (anchor) break;
      }
    }
    if (!anchor || !docPages[anchor.pageIndex]) continue;

    const colour = finding.severity === FAIL ? RED : AMBER;
    const page = docPages[anchor.pageIndex];
    circle(page, anchor, colour);

    // The note sits just past the end of the figure, along the direction the text reads — so it
    // lands beside the number on a flat page and above it on a sideways one, which is the same
    // place to the person looking at it. Clamped to the page so a figure at the margin keeps its
    // note on the sheet.
    const { along } = axes(anchor.angle || 0);
    const noteX = anchor.x + along[0] * (anchor.w + 12) + (along[0] === 0 ? 8 : 0);
    const noteY = anchor.y + along[1] * (anchor.w + 12) + anchor.h;
    stickyNote(pdfDoc, page, {
      x: Math.max(4, Math.min(noteX, page.getWidth() - 24)),
      y: Math.max(22, Math.min(noteY, page.getHeight() - 4)),
      subject: finding.title,
      contents: `${finding.title}\n\n${finding.detail}`,
      colour: finding.severity === FAIL ? [1, 0.4, 0.4] : [1, 0.85, 0.2],
    });
    placed += 1;
  }

  // Inserted last so the page indexes above refer to the contractor's own pages.
  await coverPage(pdfDoc, report, findings, placed);

  return {
    buffer: Buffer.from(await pdfDoc.save()),
    findingCount: findings.length,
    placedCount: placed,
  };
}

module.exports = {
  buildMarkedUpPacket, markable, textPositions, findAnchor, findPhrase,
  figuresIn, markGeometry, firmHandles,
};
