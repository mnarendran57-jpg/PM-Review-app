---
name: project-pm-review-app
description: "Internal construction PM tool — stack, live modules, and how to run it"
metadata: 
  node_type: memory
  type: project
  originSessionId: f4357737-33b3-48fe-b399-be124e4c01b0
---

Full-stack internal web app at: `C:\Users\NarenMurali\OneDrive - Olivier, Inc\HCC\pm-review app`

**Stack:** React + Vite + Tailwind (frontend, port 3000) / Node + Express (backend, port 3001) / SQLite via built-in `node:sqlite` (`DatabaseSync`) — NOT better-sqlite3. Node v24 is installed.
**AI:** Anthropic Claude API, model `claude-sonnet-4-5`. Key in `backend/.env`.

**Three live modules** (as of 2026-07-14) — the goal is pitching these to his team:
1. **Proposal Intake** — vendor proposal/change-order PDF → AI extracts fields → generates an Olivier letterhead memo cover → merges memo + proposal (+ PO for change orders) into one PDF. Memo template is editable in-app (Settings tab within the module), stored in `memo_templates` table.
2. **Pay App Review** — upload previous + current AIA G702/G703 pay apps → single combined AI extraction → 27 deterministic (non-AI) math/over-billing checks + a site-verification checklist of what's newly billed this period.
3. **Pre-Construction Review** — upload drawings/specs/narratives → AI risk, high-cost, change-order, and PM action-item report.

**Older modules exist but are intentionally unrouted/hidden** (Projects, Document Review, RFI Tracker, Submittals, Finance, Team & Settings). Files remain in `frontend/src/pages/` for reuse — re-add imports/routes in `App.jsx` + `Sidebar.jsx` to revive.

**Key files:**
- `backend/database.js` — schema + migrations (run automatically on boot)
- `backend/lib/payAppChecks.js` — the 27 checks; descriptions/details are deliberately written in plain English for non-construction clients, no jargon or check IDs shown in UI
- `backend/lib/payAppExtract.js` — sends BOTH pay app PDFs in ONE Claude call (deliberate: halves API calls against a tight rate limit)
- `backend/lib/payAppNormalize.js` — backfills summary values the AI missed but that are derivable
- `frontend/src/api.js` — all API calls, JWT interceptor

Related: [[pm_review_operations]], [[feedback_db_caution]], [[user_profile]]
