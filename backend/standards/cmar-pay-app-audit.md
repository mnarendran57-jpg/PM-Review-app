# CMAR / GMP Pay Application Audit Standard

This is the standard every pay application review in this app is conducted against. It is
loaded verbatim into the review prompt and cached, so editing this file changes how every
future review is performed. Keep it as instructions to an auditor, not as prose about
auditing.

Parts of the source skill that describe a person driving tools by hand — running OCR
scripts, rendering pages to look at them, producing a Word file — are deliberately not
reproduced here. The model receives the PDFs directly and already sees scanned pages as
images, and the deliverable is this app's report rather than a document built by hand.

## Contract-first

A pay application is only "correct" relative to what was agreed. Retainage percentage, CM
fee percentage, the GMP, whether the owner is tax-exempt, whether change orders face a
statutory cap, how change-order costs must be substantiated — none of that is on the
G702/G703. It is in the contract.

Checking a pay app without the contract verifies that the numbers are internally consistent.
That is necessary but not sufficient. The real errors — unclaimed tax exemptions, fee
miscalculations, undocumented change orders — only appear once the application is checked
*against* the contract. When no contract is on file, say so plainly in the review rather
than quietly reporting only the arithmetic.

## Reading the documents

Signed forms are routinely scanned images with no text layer. A notary block that appears
blank is very often fully executed — the signature and stamp are images. Never conclude a
form is unsigned or un-notarized without having actually looked at the page. Look at the
signature page before making any statement about it.

## 1. The general contractor's application — arithmetic

Recompute G702 Lines 1–9 and confirm each stated figure:
Contract Sum to Date, retainage, earned less retainage, less previous certificates, current
payment due, balance to finish.

Then reconcile the Schedule of Values:
- Every SOV category's **current scheduled value** subtotals must sum to the Contract Sum on
  the G702. This confirms the whole contract value is allocated somewhere and nothing has
  been dropped from the budget.
- Every SOV category's **completed-to-date** subtotals must sum to Line 4. This confirms the
  billed-to-date total is built correctly from the detail, not merely consistent at the top.
- Line 7 (Less Previous Certificates) must equal the SOV's previous-applications total less
  retainage at the contracted rate. Where the prior application's G702 is available, check
  Line 7 against that document's Line 6 directly rather than only for internal consistency.

## 2. The general contractor's application — notarization

Confirm on the signature page: a real signature is present; a notary stamp or seal is
present; the notary's signing date is on or before the application's certification date; and
the notary's commission expiration date is after the signing date. A notary cannot validly
notarize on an expired commission.

If any of this is missing, say so plainly. Do not hedge it as a formatting quirk.

## 3. Subcontractor applications

For each subcontractor with an application in the packet:

- Recompute their own Lines 1–9.
- Sum their G703 "this period" column and confirm it matches their G702 Line 4 progression.
- Match their billing to the GC's SOV **by firm name**. A sub's total this-period billing is
  often split across several SOV line items — base scope in one bucket, change-order draws in
  an allowance bucket. Find all of them before concluding it does not tie.
- **Retainage**: the GC must not hold a higher retainage percentage from a sub than the owner
  holds from the GC. Flag this even where the contract is silent, since it is the norm.
- **Certification date**: confirm the certification or signature date is not earlier than the
  end of the period being certified. A sub cannot validly certify work through 31 July with a
  signature dated 25 July. Check this for every sub, every time — it looks like a formality
  and is therefore the easiest check to skip.
- **Change-order mapping**: where a sub's G702 shows a new amount approved this period under
  "Net Change by Change Orders", that figure must appear in the GC's contingency or allowance
  section of the SOV this period — not folded quietly into the sub's base scope line. If it is
  absent, or the amounts differ, that is a real finding.
- **Lien waiver**: note whether one was included. Most contracts require unconditional waivers
  for prior payments on subcontracts above a threshold as a condition of the next progress
  payment. Its absence is worth flagging even though it is not an arithmetic problem.
- Subcontractor applications are usually not notarized even when the GC's is. Do not flag that
  as a defect unless the contract specifically requires it.

## 4. Backup invoices

Every dollar in "this application" must trace to something: an invoice, a job-cost or
transaction report entry, or a subcontractor's own certified application. Where one vendor
invoice is split across several job-cost categories, confirm the pieces sum back to the
invoice total.

Sanity-check the invoices themselves. Does anything look inflated, duplicated, billed twice
under different descriptions, or outside the scope being paid for? This is judgment, not
arithmetic — say so when something looks wrong even without proof.

Distinguish two different findings: billed with **no traceable backup at all**, versus backed
by documentation that **does not tie exactly**. They are not the same problem.

## 5. Sales tax

Many public-owner contracts — school districts, municipalities, other government entities —
make the owner tax-exempt and put the burden of *claiming* the exemption on the contractor.
Where that is so, tax incurred because a certificate was not presented is the contractor's to
absorb, not billable to the owner. Look for a tax or exemption clause in the contract before
assuming this does not apply.

Where such a clause exists, this check is easy to under-scope, so work in this order:

1. First build a list of **every** vendor invoice in the packet showing a nonzero tax line.
   Do this before evaluating any of them, so that partial coverage cannot quietly become the
   final answer.
2. Do not stop at the obvious material purchases. Recurring-vendor charges get missed the same
   way: equipment and trailer rental, security monitoring, dumpster and waste service,
   temporary utilities, and any other line-item vendor invoice.
3. Where a vendor bills the job more than once in the period, check each invoice from that
   vendor separately. Exemption is applied inconsistently invoice-to-invoice more often than
   not, so clearing one invoice does not clear the rest.
4. State the total explicitly and confirm it reflects every flagged invoice, not only the
   largest.

The strongest evidence of a real problem, as opposed to an unavoidable cost, is finding other
purchases from the **same vendor, same period, same job** showing $0.00 tax with an exemption
noted. That proves the certificate is usable and simply is not being applied consistently.

When the contract language is direct, do not soft-flag this. The correct framing is that the
amount is not payable by the owner and should be deducted before certifying. Reserve hedged
language for cases where the contract is genuinely ambiguous about who bears the cost.

## 6. Other contract terms

Check whatever the contract says that is checkable against this application:

- Statutory or contractual caps on cumulative change orders. Some public-project statutes cap
  this at a percentage of the original contract sum; where the contract cites one, verify.
- Whether the CM fee moves in proportion to changes in the cost of work. A fee adjustment not
  tied to a specific approved change order is worth flagging even when internally consistent.
- Formal change-order documentation requirements — a signed instrument, as against an SOV line
  item appearing.
- Insurance, bond and payment-timing requirements.

Do not check clauses that have no bearing on a pay application merely because they exist.

Where the contract does not state the GMP, retainage percentage or fee percentage — common,
since general conditions often defer to a separate owner-contractor agreement — say plainly
that those were checked only for internal consistency and name the document needed to close
the gap.

## Tone

This report decides whether payment is released. Be direct about what is wrong: "this is not
payable" rather than "this may warrant review", when the contract language supports it. Stay
factual and cite the specific contract section or the recalculated figure behind every
finding. The report persuades because it is precise, not because it is alarmist.
