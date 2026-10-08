---
name: project-deferred-work
description: Work on Coaster the user has explicitly deferred — do not build these unprompted
metadata:
  node_type: memory
  type: project
  originSessionId: 6c57326e-5938-4b14-92f0-958878bfad05
  modified: 2026-10-08T21:16:13.237Z
---

Items the user has looked at and chosen NOT to build yet. Don't start them unprompted; raise one
only if it becomes the direct cause of a problem they report.

- **Usage metering and per-account caps** — deferred 2026-10 ("don't do the metering now"). Still
  the main thing missing before public self-serve signup.
- **Per-request total upload cap** — deferred 2026-10-08 ("not now"). Each file is capped at 100 MB,
  but several routes accept up to 100 files in one request (Invoice Review among them), so a single
  request can ask for more memory than the whole instance holds. The concurrency queue does not help
  here, because it is one request rather than many.

**Why:** the user decides scope and sequencing; a deferral is a decision, not an oversight.

**How to apply:** if one of these would fix a live problem they are reporting, say so in a sentence
and let them choose. See [[feedback-commit-on-request]] and [[project-pm-review]].
