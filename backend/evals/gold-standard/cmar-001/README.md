# CMAR-001 — Carver High School Rebuild, Application 07

The first gold-standard case. Not an example to imitate: the reviewer is measured against it.

**Source package** — `253016 - Pay Application 07 - July 2026_DRAFT (1).pdf`, 67 pages.
**Governing contract** — `CHS_A133 (1).pdf`, 53 pages, of which only 11 carry a text layer.

Neither file is committed. They contain a real project's financial detail, and the repository is not
where that belongs. Put them in `source/` locally to run the evaluation; `.gitignore` keeps them out.

## Why this package

It is a **clean** application on the measure that matters most — all four subcontractors reconcile
to the penny — while being hard in every way that produces false positives. A reviewer that reports
problems here is worse than no reviewer, because a PM who is shown four phantom variances stops
reading the ones that are real.

What makes it hard:

- **Retainage basis.** A subcontractor's "amount certified" is net of 5% retainage; the prime's SOV
  column is gross. Compared directly, Sendero shows an $8,510.80 variance that does not exist.
- **One subcontractor, four prime lines, three allowances.** IDR bills $36,735 this period spread
  across four SOV rows, drawing on Allowance #1, #2 and #3. One change event — CPR 010 — appears
  three times, once under each allowance.
- **Names do not match.** The SOV says "IDR", "GreenScape", "Greenrise". The applications say
  "Integrated Demolition and Remediation Inc.", "Greenscape Associates", "GREENRISE TECHNOLOGIES LLC
  FKA CONSTRUCTION ECO SERVICES II LLC".
- **Two GMPs in one application**, each with its own general conditions, contingency and fee.
- **A negative fee.** GMP 1's CM fee bills −$19,865.36 against GMP 2's +$28,276.02.
- **Scheduled-value changes that net to zero.** Savings move into buyout contingency; allowances
  move into the change events that consume them. The grand total change is $0.00.
- **Seven scanned pages with no text layer**, all of them invoices.
- **Line 9 is not the SOV balance.** $14,577,151.00 against $14,480,787.84 — they differ by exactly
  the retainage, because Line 9 is balance to finish PLUS retainage. A naive cross-check fails here.

## Status of this expected set

Drafted from the source document, for the PM to correct. Each file marks how its values were
arrived at:

- `"verified": true` — read directly off the page and, where arithmetic relates them, recalculated.
- `"verified": false` — not yet read, or read but not independently confirmed. **Do not treat these
  as the standard until confirmed.**

Anything a reviewer is scored against must be `verified: true`. The point of an evaluation harness
is defeated the moment a guess becomes the expected answer.

## Not yet drafted

- Full prime G703 row set. The rows relevant to reconciliation, allowances, contingency and fee are
  captured; the complete list of every line on pages 2–5 has not been transcribed by hand.
- Subcontractor G703 detail (their own line items), pages 7–9, 11, 13, 15.
- General Conditions job-cost transactions, pages 16–24 and 42–67.
- Contract Baseline. The A133 is 42/53 scanned, so it needs a vision pass rather than a text one,
  and none of its rules — retainage rate, fee percentage, tax treatment, allowance and contingency
  conditions — have been extracted yet. The 5% retainage below is what the DOCUMENT shows, not what
  the contract has been confirmed to require.
