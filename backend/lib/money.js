// Two formatting helpers shared across every review module.
//
// They used to live in payAppChecks.js, which was the pay application's original check suite.
// When that suite was replaced by the deterministic engines, invoice review, change order review
// and the site checklist were all still importing its helpers — so the helpers moved here rather
// than holding a retired file alive for two functions.
//
// `money` prints "n/a" rather than "$0.00" for a missing figure on purpose: a number nobody could
// read and a number that is genuinely zero mean completely different things in a review, and
// printing them the same way is how a gap becomes invisible.

// The sign goes before the currency symbol — "-$7,000.00", not "$-7,000.00". An ASCII hyphen
// rather than a typographic minus, deliberately: this string is also drawn into PDFs using the
// standard fonts, whose WinAnsi encoding has no U+2212 and throws when asked to write one.
function money(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${abs}`;
}

function sum(items, key) {
  return (items || []).reduce((acc, it) => acc + (Number(it[key]) || 0), 0);
}

module.exports = { money, sum };
