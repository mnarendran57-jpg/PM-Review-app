---
name: feedback_no_size_limits
description: "Document size must never decide whether a feature works — no timeouts, no page caps, no 'split the PDF' errors"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6c57326e-5938-4b14-92f0-958878bfad05
  modified: 2026-08-12T23:54:38.631Z
---

The user has said twice (2026-08-03 and again 2026-08-12) that **the size of an uploaded
document must never determine the result**. Not a size cap, not a timeout, not an error
telling them to split the PDF into smaller parts.

**Why:** a PM receives whatever the contractor sends. A 200-page contract or a 300-page
drawing set is not something they can do anything about, so a tool that fails on it has
failed at the job, not at the file. An error that says "try splitting it" is asking the
user to do the tool's work.

**How to apply:** when any upload path calls the AI, do not hold the HTTP request open for
the work. Store the file, return immediately, do the reading in a background queue with a
status the UI can poll — the pattern in `backend/lib/contractQueue.js` (built 2026-08-12
for contract extraction, after a multi-contract CMAR upload timed out at the 3-minute
`AI_TIMEOUT` in `frontend/src/api.js`). Resume unfinished jobs on boot so a deploy
mid-read is harmless.

Paths still worth converting: pay app extraction and the pre-construction drawing review
both still run inside the request, the latter on a 20-minute client timeout.

See [[project_pm_review]] and [[pm_review_operations]] — the Anthropic rate limit is what
makes these jobs slow in the first place, so queue work sequentially rather than in
parallel.
