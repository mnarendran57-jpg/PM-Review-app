const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const db = require('../database');
const storage = require('./storage');
const { splitPdf } = require('./pdfChunk');
const { toWinAnsi, wrapLine } = require('./pdfGen');

// An RFI from the project's RFI Log, as one document a change order can be read against.
//
// The log holds more than any file of the RFI does: the question as logged, and — what a change
// order's scope is really measured against — the A/E's answer, which is recorded whether or not
// anybody filed a PDF of it. So the document opens with a page written from the log entry itself,
// followed by the front of the RFI as the contractor sent it and the front of the A/E's response,
// where those are on file.
//
// Only the front pages of each file. What an RFI asks and what the A/E answered are on its first
// pages; the photographs and catalogue cuts stapled behind them are not what a change order is
// priced against, and leaving them out keeps every RFI short enough to be read in one request beside
// the change order — the only way the scope comparison sees the two side by side.
const FRONT_PAGES = 4;

const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.42, 0.44, 0.48);

// The log entry, written out as a page.
async function summaryPage(doc, rfi, revision) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let y = 740;
  const write = (text, { f = font, size = 10, color = INK, gap = 4 } = {}) => {
    for (const line of wrapLine(toWinAnsi(String(text || '')), f, size, 512)) {
      if (y < 50) return;
      page.drawText(line, { x: 50, y, size, font: f, color });
      y -= size + 4;
    }
    y -= gap;
  };
  write('RFI, as recorded in the project\'s RFI Log', { size: 9, color: GREY, gap: 6 });
  write(`${rfi.rfi_number}${rfi.subject ? ` — ${rfi.subject}` : ''}`, { f: bold, size: 14, gap: 10 });
  if (rfi.question) { write('Question', { f: bold, size: 10 }); write(rfi.question, { gap: 10 }); }
  if (revision?.response_notes || revision?.response_action) {
    write("The A/E's response", { f: bold, size: 10 });
    if (revision.response_action) write(`Action: ${revision.response_action}`, { size: 9.5, color: GREY });
    if (revision.responded_by || revision.date_returned) {
      write([revision.responded_by, revision.date_returned].filter(Boolean).join(', '), { size: 9.5, color: GREY });
    }
    if (revision.response_notes) write(revision.response_notes, { gap: 10 });
  } else {
    write('No response from the A/E is recorded yet.', { size: 9.5, color: GREY });
  }
}

async function appendFront(doc, row) {
  if (!row) return;
  const buffer = await storage.readFile({ key: row.file_key, blob: row.file_blob }).catch(() => null);
  if (!buffer) return;
  try {
    const [front] = await splitPdf(buffer, FRONT_PAGES);
    const src = await PDFDocument.load(front.buffer, { ignoreEncryption: true });
    const pages = await doc.copyPages(src, src.getPageIndices());
    pages.forEach(p => doc.addPage(p));
  } catch {
    // A file that will not open is left out; the log entry above still says what the RFI was.
  }
}

// Returns { name, buffer } for an RFI on this project, or null when there is no such RFI.
async function rfiReference(rfiId, projectId) {
  const rfi = db.prepare(`SELECT * FROM rfis WHERE id=? AND project_id=?`).get(rfiId, projectId);
  if (!rfi) return null;
  const revision = db.prepare(
    `SELECT * FROM rfi_revisions WHERE rfi_id=? ORDER BY revision_number DESC LIMIT 1`
  ).get(rfi.id);
  const latest = kind => db.prepare(
    `SELECT file_key, file_blob FROM rfi_files WHERE rfi_id=? AND kind=? ORDER BY id DESC LIMIT 1`
  ).get(rfi.id, kind);

  const doc = await PDFDocument.create();
  await summaryPage(doc, rfi, revision);
  await appendFront(doc, latest('rfi'));
  await appendFront(doc, latest('response'));
  return { name: `${rfi.rfi_number}${rfi.subject ? ` — ${rfi.subject}` : ''}`, buffer: Buffer.from(await doc.save()) };
}

module.exports = { rfiReference, FRONT_PAGES };
