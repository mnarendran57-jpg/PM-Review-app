---
name: project_pm_review_github
description: "PM Review app GitHub repo — URL, visibility, and the confirmed collaborator"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c57326e-5938-4b14-92f0-958878bfad05
---

The [[project_pm_review]] app is hosted on GitHub at `https://github.com/mnarendran57-jpg/PM-Review-app` (personal account, **private** — verified 2026-07-14 via unauthenticated API probe returning 404).

**Gautam Santhanu Thampy <gautamsanthanu.thampy@sjsu.edu> is a legitimate collaborator with push access** — confirmed by the user on 2026-07-14 after Claude flagged an unrecognized commit from him. Do not re-raise this as a security concern.

**Why:** the user said he had never used GitHub and never mentioned a collaborator, so an unknown author pushing to a private repo holding Olivier Inc. code and HCC client data looked like unauthorized access. It wasn't. Gautam's commit `4a5b00e` did competent deployment prep: SPA `_redirects`, a `VITE_API_BASE_URL` env var in `frontend/src/api.js`, and binding the backend to `0.0.0.0`.

**How to apply:** treat commits from Gautam as expected. Still review third-party commits on their merits before merging — that review is normal practice, not suspicion of him.

Note: `backend/.env` and `pm_review.db` have never been committed, so the repo contains source code only — no API keys, no client documents. Keep it that way; the hardened root `.gitignore` is what enforces it.

Related: [[pm_review_operations]], [[feedback_db_caution]]
