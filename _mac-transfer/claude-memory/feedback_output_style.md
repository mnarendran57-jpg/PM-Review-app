---
name: feedback_output_style
description: Wants app-generated reports in plain English a non-construction client can read
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f4357737-33b3-48fe-b399-be124e4c01b0
---

Report output in the PM Review app must be written for a client or stakeholder with **no construction or accounting background** — short plain sentences and real dollar amounts, never internal jargon.

**Why:** On 2026-07-14 he rejected the Pay App Review output as "too complicated," specifically calling out things like `A4`, `B3`, `B4`, and "Over-billing per line: G ≤ C". His words: when shown to a client, "they should be able to read and understand" it even if they aren't from a construction background.

**How to apply:** No AIA line numbers ("Line 4"), no column letters (C/D/E/F/G), no math shorthand (ΣG), no internal check IDs shown in the UI. Say "total work billed to date" not "Line 4"; "billed $150,000, which is $50,000 more than its $100,000 budget" not "G > C". Internal IDs may stay in JSON exports and code comments for debugging. Section headers likewise plain: "Issues to Resolve Before Approving", not "Critical Issues — do not approve as-is". This applies to any new report surface, not just pay apps.

Related: [[project_pm_review]]
