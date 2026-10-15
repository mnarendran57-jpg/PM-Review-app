const { PDFDocument, StandardFonts, rgb, degrees, radians } = require('pdf-lib');
const { eachPage } = require('./pdfTextLayer');
const { toWinAnsi, wrapLine } = require('./pdfGen');
const { fitText } = require('./reviewPdfKit');

// A document someone sent in — a change order, an invoice — marked up with what its review found.
//
// WHY THIS EXISTS ALONGSIDE THE REPORT
//
// The report says what is wrong; this shows where. A finding that says a line total is $1,000 out
// still sends the reader looking for the line. Circling it on the page as it was sent, with the
// right figure beside it, is the difference between a report that is acted on and one that is read.
//
// HOW A PAGE IS LAID OUT
//
// Every marked page is the sender's page at full size, untouched, with a column added down its
// right-hand side for the notes and a band across the top for the key. Nothing is written over the
// sender's own text: a note placed in the page's margin collides with whatever was printed there,
// and that is the misaligned markup this is built to avoid. On the page itself there is only the
// mark — an oval round the figure and a numbered badge — and a fine line from it to its note.
//
// HOW A FINDING IS PLACED
//
// By the figures it is about. The text layer gives every run of text a position, and a finding names
// its amount — the line total that is wrong, the tax that should not be there — so the amount is
// found on the page, on the same row as the line's own description where there is one. A page with
// no text layer (a scan) has nothing to anchor to, and nothing is marked on it; the report still
// lists every finding.
//
// Each review decides WHAT to mark (lib/pcoMarkup.js, lib/invoiceMarkup.js) as a list of marks:
//   { tone: 'red'|'amber'|'indigo', title, amount, phrase, lines: [...], cite: { label, quote } | null }
// and this file decides where they go and draws them.
//
// The same idea as Pay App Reviewer 3's marked-up packet, written separately: that module shares no
// code with any other on purpose, and the lessons it learned about sideways pages are carried here
// rather than imported.

const SIDEBAR = 236;     // the notes column
const BAND = 44;         // the key across the top
const PAD = 10;

const TONES = {
  red: { ink: rgb(0.78, 0.11, 0.11), fill: rgb(0.996, 0.95, 0.95), label: 'Must resolve or correct' },
  amber: { ink: rgb(0.82, 0.42, 0.04), fill: rgb(1, 0.97, 0.92), label: 'Worth checking' },
  indigo: { ink: rgb(0.27, 0.23, 0.8), fill: rgb(0.94, 0.95, 1), label: 'Value engineering' },
};
const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.86, 0.87, 0.89);
const WHITE = rgb(1, 1, 1);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --- Where it is on the page ----------------------------------------------------------------------

// Every run of text on every page, with the direction it runs. A landscape sheet saved as a turned
// portrait page draws its text sideways in the page's own coordinates; (a, b) is that direction.
function textPositions(buffer) {
  return eachPage(buffer, async (page, p) => {
    const content = await page.getTextContent();
    const items = [];
    for (const i of content.items) {
      const str = (i.str || '').trim();
      if (!str) continue;
      items.push({
        str, x: i.transform[4], y: i.transform[5],
        angle: Math.atan2(i.transform[1], i.transform[0]),
        w: i.width || 0, h: i.height || 9,
      });
    }
    return { pageIndex: p - 1, items };
  });
}

// The ways an amount can be printed: "$20,920.00", "20,920.00", "20920.00", "$20,920".
function moneyForms(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return [];
  const abs = Math.abs(n);
  const fixed = abs.toFixed(2);
  const grouped = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const forms = [grouped, fixed];
  if (abs === Math.round(abs)) forms.push(abs.toLocaleString('en-US'), String(abs));
  return [...new Set(forms)];
}

// The part of a run that holds `form`, as its own box. A run is often a whole printed line —
// description, quantity, rate and total together — and circling all of it would mark the row rather
// than the figure. The share of the run's width is taken from its share of the characters: exact in
// the fixed-width fonts estimates are printed in, and close enough in the rest.
//
// Only a whole figure counts: "1,800.00" is inside "11,800.00", and matching it there put an overtime
// note on the exhaust fan's line. A match must not have a digit, comma or point running into it on
// either side. The last whole match wins — on a printed line the extended total comes after the rate.
function subRun(item, form) {
  let at = -1;
  for (let i = item.str.indexOf(form); i >= 0; i = item.str.indexOf(form, i + 1)) {
    const before = item.str[i - 1];
    const after = item.str[i + form.length];
    if ((before === undefined || !/[\d,.]/.test(before)) && (after === undefined || !/\d/.test(after))) at = i;
  }
  if (at < 0) return null;
  // Take in a "$" written against the figure, so the mark covers what a reader sees as the amount.
  const start = at > 0 && item.str[at - 1] === '$' ? at - 1 : at;
  const len = at + form.length - start;
  const per = item.str.length ? item.w / item.str.length : 0;
  const along = [Math.cos(item.angle), Math.sin(item.angle)];
  return {
    x: item.x + along[0] * per * start, y: item.y + along[1] * per * start,
    w: per * len, h: item.h, angle: item.angle,
  };
}

// Where a mark belongs: its amount, on the same row as its words where it has both — so a total that
// happens to equal another line's total lands on the right one — else the amount alone, else the
// words.
//
// Two findings about the same line — the overtime the contract forbids, and the same overtime the RFI
// never asked for — belong on the same figure. The second shares the first one's spot rather than
// going looking for another copy of the amount, which put it on the wrong line. A spot is only
// passed over for an unused one when the mark has no words to say which row it means.
function locate(pages, mark, used) {
  const forms = moneyForms(mark.amount);
  const words = norm(mark.phrase).split(' ').filter(w => w.length > 2).slice(0, 3);
  const key = (p, box) => `${p}:${Math.round(box.x)}:${Math.round(box.y)}`;

  const amountsOn = page => {
    const out = [];
    for (const item of page.items) {
      for (const form of forms) {
        const box = subRun(item, form);
        if (box) { out.push({ item, box }); break; }
      }
    }
    return out;
  };
  // Whether the row an amount sits on carries the mark's words. The whole row is read, not one run of
  // it: some documents store every word as its own run, and no single run then holds a description.
  const onSameRow = (page, item) => {
    if (!words.length) return false;
    const row = page.items
      .filter(other => Math.abs((other.y - item.y) * Math.cos(item.angle) - (other.x - item.x) * Math.sin(item.angle)) < 4)
      .map(other => norm(other.str)).join(' ');
    return words.every(w => row.includes(w));
  };
  const take = (pageIndex, box) => {
    const k = key(pageIndex, box);
    used.add(k);
    return { pageIndex, key: k, ...box };
  };

  // How far along its own line a box sits. Where a row prints the same figure twice — a quantity of
  // one at $11,800.00 for $11,800.00 — the second is the extended total, which is what a finding is
  // about, so the furthest along wins.
  const along = h => h.box.x * Math.cos(h.box.angle) + h.box.y * Math.sin(h.box.angle);

  if (forms.length) {
    if (words.length) {
      for (const page of pages) {
        const hits = amountsOn(page).filter(({ item }) => onSameRow(page, item));
        if (hits.length) {
          const hit = hits.reduce((best, h) => (along(h) > along(best) ? h : best));
          return take(page.pageIndex, hit.box);
        }
      }
    }
    const all = pages.flatMap(page => amountsOn(page).map(h => ({ pageIndex: page.pageIndex, ...h })));
    const fresh = all.find(h => !used.has(key(h.pageIndex, h.box))) || all[0];
    if (fresh) return take(fresh.pageIndex, fresh.box);
  }
  if (words.length) {
    for (const page of pages) {
      const item = page.items.find(i => words.every(w => norm(i.str).includes(w)));
      if (item) return take(page.pageIndex, { x: item.x, y: item.y, w: item.w, h: item.h, angle: item.angle });
    }
  }
  return null;
}

// --- Drawing ----------------------------------------------------------------------------------------

// From the page's own coordinates to where that point is seen once the page's /Rotate is applied, on
// a page whose lower-left corner is the origin. The sender's page is drawn turned the same way,
// so a mark placed through this lands on the figure whatever the page's rotation.
function viewTransform(rotation, w, h) {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90) return { vw: h, vh: w, at: (x, y) => [y, w - x], turn: -Math.PI / 2, draw: { x: 0, y: w, rotate: degrees(-90) } };
  if (r === 180) return { vw: w, vh: h, at: (x, y) => [w - x, h - y], turn: -Math.PI, draw: { x: w, y: h, rotate: degrees(-180) } };
  if (r === 270) return { vw: h, vh: w, at: (x, y) => [h - y, x], turn: -3 * Math.PI / 2, draw: { x: h, y: 0, rotate: degrees(-270) } };
  return { vw: w, vh: h, at: (x, y) => [x, y], turn: 0, draw: { x: 0, y: 0 } };
}

// The oval round a figure, in the coordinates it is seen in: centred on the glyphs (a third of the
// text height above the baseline), a little longer than the figure, turned to the way it reads.
function ovalFor(box, view, ox, oy) {
  const along = [Math.cos(box.angle), Math.sin(box.angle)];
  const across = [-Math.sin(box.angle), Math.cos(box.angle)];
  const cxSrc = box.x - ox + along[0] * (box.w / 2) + across[0] * (box.h / 3);
  const cySrc = box.y - oy + along[1] * (box.w / 2) + across[1] * (box.h / 3);
  const [cx, cy] = view.at(cxSrc, cySrc);
  const angle = box.angle + view.turn;
  const xScale = Math.max(box.w / 2 + 7, 16);
  const yScale = Math.max(box.h / 2 + 4, 9);
  // The rightmost point of the turned oval, where the line to its note leaves from.
  const reach = Math.abs(xScale * Math.cos(angle)) + Math.abs(yScale * Math.sin(angle));
  return { cx, cy, xScale, yScale, angle, right: cx + reach, top: cy + Math.abs(xScale * Math.sin(angle)) + Math.abs(yScale * Math.cos(angle)) };
}

function badge(page, { x, y, number, tone, font, r = 8 }) {
  page.drawCircle({ x, y, size: r, color: TONES[tone].ink, borderColor: WHITE, borderWidth: 1.2 });
  const label = String(number);
  const size = label.length > 1 ? 7.5 : 8.5;
  page.drawText(label, { x: x - font.widthOfTextAtSize(label, size) / 2, y: y - size * 0.35, size, font, color: WHITE });
}

// Notes laid out down the column near the height of their marks, pushed apart where they would
// overlap and pulled back up where they would run off the foot of the page. When there are more than
// the column holds, the notes drop their second line before anything is lost.
// A clause's words run three lines at most in a note; the report carries the whole quote.
const QUOTE_LINES = 3;

function layoutNotes(notes, top, bottom, fonts, width) {
  const measure = (n, brief) => {
    const lines = (brief ? n.lines.slice(0, 1) : n.lines).flatMap(l => wrapLine(toWinAnsi(l), fonts.font, 8, width - 34));
    const title = wrapLine(toWinAnsi(n.title), fonts.bold, 8.5, width - 34);
    // The contract clause: always where it is, and — room allowing — the start of its words.
    const citeHead = n.cite ? wrapLine(toWinAnsi(`Contract${n.cite.label ? ` · ${n.cite.label}` : ''}`), fonts.bold, 7, width - 34) : [];
    let citeQuote = [];
    if (n.cite && !brief) {
      citeQuote = wrapLine(toWinAnsi(`"${n.cite.quote}"`), fonts.italic, 7.5, width - 34);
      if (citeQuote.length > QUOTE_LINES) {
        citeQuote = citeQuote.slice(0, QUOTE_LINES);
        citeQuote[QUOTE_LINES - 1] = `${citeQuote[QUOTE_LINES - 1].replace(/\s*\S*$/, '')} ...`;
      }
    }
    const citeHeight = n.cite ? 3 + citeHead.length * 9 + citeQuote.length * 9 : 0;
    return { title, lines, citeHead, citeQuote, height: 8 + title.length * 11 + lines.length * 10 + citeHeight + 4 };
  };
  const place = brief => {
    const laid = notes.map(n => ({ ...n, ...measure(n, brief) })).sort((a, b) => b.want - a.want);
    let floor = top;
    for (const n of laid) {
      n.top = Math.min(n.want + n.height / 2, floor);
      floor = n.top - n.height - 6;
    }
    // Pulled back up from the foot, if the stack ran off it.
    let ceiling = bottom;
    for (let i = laid.length - 1; i >= 0; i--) {
      const n = laid[i];
      if (n.top - n.height < ceiling) n.top = ceiling + n.height;
      ceiling = n.top + 6;
    }
    return laid;
  };
  const full = place(false);
  return full.every(n => n.top <= top + 0.5) ? full : place(true);
}


// `sources` are the documents as sent, in order — an invoice and the receipts bound in behind it may
// arrive as several files — and a mark is placed on the first page of any of them that shows it.
// `heading` names the marked pages ("PCO 021 — marked up"); `noun` is what a source is called in the
// line under it ("change order", "invoice"), used when there is only one.
async function drawMarkedPages(target, { sources, marks, heading, noun = 'document' }) {
  const docs = (sources || []).filter(s => s && s.buffer);
  if (!marks.length || !docs.length) return { marks: marks.length, placed: 0 };

  // Every page of every source, numbered through them all; `src` and `page` say where it came from.
  const pages = [];
  for (const [s, doc] of docs.entries()) {
    try {
      for (const p of await textPositions(doc.buffer)) pages.push({ ...p, src: s, page: p.pageIndex, pageIndex: pages.length });
    } catch {
      // A source whose text cannot be read has nothing to anchor a mark to; the others still can.
    }
  }
  if (!pages.length) return { marks: marks.length, placed: 0 };

  const used = new Set();
  const byPage = new Map();
  for (const mark of marks) {
    const at = locate(pages, mark, used);
    if (!at) continue;
    if (!byPage.has(at.pageIndex)) byPage.set(at.pageIndex, []);
    byPage.get(at.pageIndex).push({ ...mark, at });
  }
  const placed = [...byPage.values()].reduce((n, list) => n + list.length, 0);
  if (!placed) return { marks: marks.length, placed: 0 };

  const font = await target.embedFont(StandardFonts.Helvetica);
  const bold = await target.embedFont(StandardFonts.HelveticaBold);
  const italic = await target.embedFont(StandardFonts.HelveticaOblique);
  const loaded = new Map();
  const sourceOf = async s => {
    if (!loaded.has(s)) loaded.set(s, await PDFDocument.load(docs[s].buffer, { ignoreEncryption: true }));
    return loaded.get(s);
  };
  const order = [...byPage.keys()].sort((a, b) => a - b);

  for (const [n, pageIndex] of order.entries()) {
    const where = pages[pageIndex];
    const src = (await sourceOf(where.src)).getPage(where.page);
    const { x: ox, y: oy, width: w, height: h } = src.getMediaBox();
    const view = viewTransform(src.getRotation().angle, w, h);
    const embedded = await target.embedPage(src);
    const page = target.addPage([view.vw + SIDEBAR, view.vh + BAND]);

    // The page, as it was sent.
    page.drawPage(embedded, { ...view.draw, xScale: 1, yScale: 1 });

    // The column and the band, set off from the page with a faint ground and a rule.
    page.drawRectangle({ x: view.vw, y: 0, width: SIDEBAR, height: view.vh + BAND, color: rgb(0.975, 0.978, 0.985) });
    page.drawLine({ start: { x: view.vw, y: 0 }, end: { x: view.vw, y: view.vh }, thickness: 0.6, color: RULE });
    page.drawRectangle({ x: 0, y: view.vh, width: view.vw + SIDEBAR, height: BAND, color: WHITE });
    page.drawLine({ start: { x: 0, y: view.vh }, end: { x: view.vw + SIDEBAR, y: view.vh }, thickness: 0.6, color: RULE });

    // The key: what each colour means, for the colours this review uses. Drawn first, so the heading
    // beside it knows how much room it has.
    let kx = view.vw + SIDEBAR - 16;
    for (const tone of ['indigo', 'amber', 'red'].filter(t => marks.some(m => m.tone === t))) {
      const label = TONES[tone].label;
      const lw = font.widthOfTextAtSize(label, 7.5);
      kx -= lw;
      page.drawText(label, { x: kx, y: view.vh + BAND - 26, size: 7.5, font, color: GREY });
      kx -= 11;
      page.drawCircle({ x: kx + 4, y: view.vh + BAND - 23.5, size: 4, color: TONES[tone].ink });
      kx -= 14;
    }
    // The heading and the line under it name documents, whose names can be as long as their files'.
    // Each keeps to one line, short of the key.
    const room = kx - 16 - 12;
    page.drawText(fitText(toWinAnsi(heading), bold, 11, room), { x: 16, y: view.vh + BAND - 18, size: 11, font: bold, color: INK });
    const of = docs.length > 1 ? (docs[where.src].name || `document ${where.src + 1}`) : `the ${noun}`;
    page.drawText(fitText(toWinAnsi(`Page ${where.page + 1} of ${of}  ·  ${n + 1} of ${order.length} marked`), font, 8, room),
      { x: 16, y: view.vh + BAND - 32, size: 8, font, color: GREY });

    const list = byPage.get(pageIndex);
    // Marks that share a spot share one oval, drawn in the most serious of their colours, with their
    // badges in a row just past its right end — where the line to the notes leaves from, and where a
    // page usually has white space. Above the oval, a badge sat on the row above.
    const SEVERITY = { red: 0, amber: 1, indigo: 2 };
    const spots = new Map();
    for (const m of list) {
      if (!spots.has(m.at.key)) spots.set(m.at.key, { oval: ovalFor(m.at, view, ox, oy), marks: [] });
      spots.get(m.at.key).marks.push(m);
    }
    const ovals = [];
    for (const spot of spots.values()) {
      spot.tone = spot.marks.map(m => m.tone).sort((a, b) => SEVERITY[a] - SEVERITY[b])[0];
      // Past the end of the figure in the direction it reads: to the right on an ordinary line, and
      // above it where the text runs up the page — not to the right of it, where the next column is.
      const dir = [Math.cos(spot.oval.angle), Math.sin(spot.oval.angle)];
      spot.marks.forEach((m, i) => {
        const reach = spot.oval.xScale + 10 + i * 17;
        ovals.push({ ...m, oval: spot.oval, badgeAt: { x: spot.oval.cx + dir[0] * reach, y: spot.oval.cy + dir[1] * reach } });
      });
      const { cx, cy, xScale, yScale, angle } = spot.oval;
      page.drawEllipse({
        x: cx, y: cy, xScale, yScale, rotate: radians(angle),
        borderColor: TONES[spot.tone].ink, borderWidth: 1.6, borderOpacity: 0.95,
        color: TONES[spot.tone].ink, opacity: 0.1,
      });
    }

    const colX = view.vw + 12;
    const colW = SIDEBAR - 24;
    const notes = layoutNotes(ovals.map(m => ({ ...m, want: m.badgeAt.y })), view.vh - 10, 10, { font, bold, italic }, colW);

    for (const note of notes) {
      const tone = TONES[note.tone];
      const mid = note.top - note.height / 2;
      // The line from the mark's badge to its note: across to the column, then to the note's middle.
      const startX = note.badgeAt.x + 8;
      page.drawLine({ start: { x: startX, y: note.badgeAt.y }, end: { x: view.vw - 6, y: note.badgeAt.y }, thickness: 0.8, color: tone.ink, opacity: 0.55, dashArray: [2.5, 2] });
      page.drawLine({ start: { x: view.vw - 6, y: note.badgeAt.y }, end: { x: colX, y: mid }, thickness: 0.8, color: tone.ink, opacity: 0.55 });
      page.drawCircle({ x: colX, y: mid, size: 1.8, color: tone.ink });

      // The note: a card with a coloured edge, its number, a title and a line or two of figures.
      page.drawRectangle({ x: colX, y: note.top - note.height, width: colW, height: note.height, color: WHITE, borderColor: RULE, borderWidth: 0.6 });
      page.drawRectangle({ x: colX, y: note.top - note.height, width: 3, height: note.height, color: tone.ink });
      badge(page, { x: colX + 15, y: note.top - 12, number: note.number, tone: note.tone, font: bold });
      let ty = note.top - 15;
      for (const t of note.title) { page.drawText(t, { x: colX + 28, y: ty, size: 8.5, font: bold, color: tone.ink }); ty -= 11; }
      for (const l of note.lines) { page.drawText(l, { x: colX + 28, y: ty, size: 8, font, color: INK }); ty -= 10; }
      if (note.citeHead.length) {
        ty -= 3;
        for (const l of note.citeHead) { page.drawText(l, { x: colX + 28, y: ty, size: 7, font: bold, color: TONES.indigo.ink }); ty -= 9; }
        for (const l of note.citeQuote) { page.drawText(l, { x: colX + 28, y: ty, size: 7.5, font: italic, color: GREY }); ty -= 9; }
      }
    }

    // Badges last, so a line never runs over a number. Kept on the sender's page, short of the
    // column, however far right the figure is.
    for (const m of ovals) {
      badge(page, {
        x: Math.max(10, Math.min(m.badgeAt.x, view.vw - 10)), y: Math.max(10, Math.min(m.badgeAt.y, view.vh - 10)),
        number: m.number, tone: m.tone, font: bold, r: 7.5,
      });
    }

    if (n === order.length - 1 && placed < marks.length) {
      page.drawText(toWinAnsi(`${marks.length - placed} more finding${marks.length - placed === 1 ? '' : 's'} could not be pinned to a spot on the page — see the report.`),
        { x: view.vw + 12, y: 4, size: 6.5, font: italic, color: GREY });
    }
  }

  return { marks: marks.length, placed };
}

module.exports = { drawMarkedPages, locate, moneyForms, subRun, viewTransform, ovalFor, layoutNotes, TONES };
