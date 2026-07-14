// Minimal CSV parser for a change-order log: expects a header row containing
// something like "co_number"/"co #"/"number" and "amount"/"value".
function parseCoLogCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const numIdx = header.findIndex(h => /co|number|#/.test(h));
  const amtIdx = header.findIndex(h => /amount|value|price|total/.test(h));
  const startRow = (numIdx !== -1 && amtIdx !== -1) ? 1 : 0;
  const rows = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const coNumber = numIdx !== -1 ? cols[numIdx] : cols[0];
    const amountRaw = amtIdx !== -1 ? cols[amtIdx] : cols[1];
    const amount = parseFloat(String(amountRaw ?? '').replace(/[^0-9.-]/g, ''));
    if (coNumber && Number.isFinite(amount)) rows.push({ coNumber, amount });
  }
  return rows;
}

module.exports = { parseCoLogCsv };
