const { sum } = require('./payAppChecks');

// Fills in summary fields that the AI extraction left blank (null) but that can be
// reliably derived from other fields already present — e.g. if Line 4 wasn't read
// directly off the page, it can still be computed as the sum of the line items' "G"
// column. This prevents a genuinely-present number from showing as "Not Available"
// just because the model happened to miss transcribing that one field.
function backfillPayApp(pa) {
  if (!pa || !pa.summary) return pa;
  const s = pa.summary;
  const items = Array.isArray(pa.lineItems) ? pa.lineItems : [];

  if (s.line3 == null && s.line1 != null && s.line2 != null) s.line3 = s.line1 + s.line2;
  if (s.line1 == null && s.line3 != null && s.line2 != null) s.line1 = s.line3 - s.line2;
  if (s.line2 == null && s.line3 != null && s.line1 != null) s.line2 = s.line3 - s.line1;

  if (s.line4 == null && items.length) s.line4 = sum(items, 'g');

  if (s.line5 == null && s.line5aAmount != null && s.line5bAmount != null) s.line5 = s.line5aAmount + s.line5bAmount;
  if (s.line5 == null && s.line5aAmount != null && s.line5bAmount == null) s.line5 = s.line5aAmount;

  if (s.line6 == null && s.line4 != null && s.line5 != null) s.line6 = s.line4 - s.line5;
  if (s.line4 == null && s.line6 != null && s.line5 != null) s.line4 = s.line6 + s.line5;

  if (s.line8 == null && s.line6 != null && s.line7 != null) s.line8 = s.line6 - s.line7;
  if (s.line7 == null && s.line6 != null && s.line8 != null) s.line7 = s.line6 - s.line8;

  if (s.line9 == null && s.line3 != null && s.line6 != null) s.line9 = s.line3 - s.line6;

  return pa;
}

module.exports = { backfillPayApp };
