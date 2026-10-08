---
name: feedback_fresh_module_no_payapp_reference
description: "New review modules must be built from their source skill alone, never by referencing the existing Pay App modules"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6c57326e-5938-4b14-92f0-958878bfad05
  modified: 2026-09-30T23:04:23.197Z
---

When building a new review module for [[project_pm_review]], build it from its own
specification (the skill) and do not read or imitate the existing Pay App modules
(`routes/payAppReview.js`, `routes/payAppReview2.js`). Sharing generic infrastructure —
database, job queue, storage, auth middleware, PDF helpers — is fine and expected. What
is not fine is letting the older modules' design be a reference point.

**Why:** as of 2026-09-30 both existing Pay App modules were erroring in production. Naren
asked for the new CMAR module to be "a whole fresh module running just on this skill" so
those faults could not propagate. His words: "I don't want those errors to be in this one
as well."

**How to apply:** build from the spec, then audit the imports and state plainly what the
new module depends on. Say explicitly whether the old modules were opened at all — he
asked twice, so a verified answer beats an assurance.

Fixing the two broken Pay App modules is deferred, to be requested separately.

Related: [[feedback_commit_on_request]], [[project_pm_review]].
