---
name: feedback-commit-on-request
description: Never commit or push without an explicit instruction — applies to both frontend and backend
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6c57326e-5938-4b14-92f0-958878bfad05
  modified: 2026-07-31T17:28:36.192Z
---

Only run `git commit` or `git push` when Naren explicitly asks. This covers both
frontend and backend changes — there is no "obviously done, so ship it" case.
Finish the work, report what changed, and stop there.

**Why:** stated on 2026-07-31 after I had been committing at the end of each task
on my own initiative. He wants to decide when a change is settled enough to land,
partly because the live site deploys from `main` — Render auto-deploys the backend
on push, so committing is effectively releasing.

**How to apply:** end a task with the change made and verified, plus a one-line
note of what is uncommitted. Wait for "commit and push" (or similar) before
touching git. Earlier in the same session he said "you do the push and commit
part" about a specific change — that was permission for that change, not a
standing one.

Related: [[project-pm-review-github]], [[pm-review-operations]]
