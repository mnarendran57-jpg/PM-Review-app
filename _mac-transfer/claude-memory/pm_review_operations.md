---
name: pm_review_operations
description: "How to run the PM Review app, the login accounts, and the Anthropic rate-limit gotcha"
metadata: 
  node_type: memory
  type: project
  originSessionId: f4357737-33b3-48fe-b399-be124e4c01b0
  modified: 2026-08-17T20:35:08.613Z
---

Operational facts for [[project_pm_review]] that aren't obvious from the code.

**Running it locally.** Neither server auto-starts, and both stop when a session ends.
Both are in `.claude/launch.json` — start via preview_start with the config named
`backend` (port 3001) or `frontend` (port 3000). **A dead backend is the most common
cause of "credentials not working"**: the UI cannot tell a wrong password from an
unreachable server, so check port 3001 is listening before touching auth code. Confirmed
again on 2026-07-31.

**Login is per-person, not shared** (the old shared `Team@olivier` password is gone).
Local platform-admin account: `admin@coaster.app`. Its password is whatever `APP_PASSWORD_HASH` was generated from and is NOT recorded here; ask the user. Seeded from
`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD_HASH` in `backend/.env`, which also holds
`JWT_SECRET`. Everyone else is invited by email and sets their own password. Since
2026-07-31 there is also a self-service "Forgot your password?" flow, but it stays
disabled until a mail provider is configured.

**Deployed** — Netlify (frontend) + Render (backend, with a persistent disk), files in
Cloudflare R2. Render auto-deploys on push to `main`; **Netlify needs a manual rebuild**.
See [[feedback_commit_on_request]] — pushing is effectively releasing, so only commit
when asked.

**The Anthropic rate limit is NO LONGER tight, and the old numbers are still quoted all
over the code.** Measured from the `anthropic-ratelimit-*` response headers on
2026-08-17: **5,000,000 input tokens/min, 1,000,000 output tokens/min, 5,000
requests/min.** The codebase was designed around 10,000 input tokens/min and 5
requests/min, and dozens of comments still cite that as the reason for a decision.

**How to apply:** treat "the per-minute allowance" in any comment as a stale premise and
re-measure before believing it. It cost real speed — passes over one document, the two pay
apps, every governing contract, and every uploaded backup file all ran SEQUENTIALLY purely
to respect a limit that no longer exists. Those four are now parallel (2026-08-17). More
sequential-for-rate-limit loops probably remain in the submittal, RFI, precon and progress
modules. **What actually costs wall-clock time is OUTPUT generation, ~100 tokens/sec**, so
the lever is running generation concurrently and asking for less transcription — not
reducing input or batching requests.

Still avoid rapid repeated test calls while debugging, and prefer synthetic local data for
deterministic logic (checks, report, backfill), which needs no API call at all.

**Still open:** uploaded PDFs and the SQLite DB live inside a OneDrive-synced folder
locally, so they sync to his Olivier Inc. cloud storage.
