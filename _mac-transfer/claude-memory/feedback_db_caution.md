---
name: feedback-db-caution
description: "Never delete pm_review.db to \"reset\" state — write a migration instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f4357737-33b3-48fe-b399-be124e4c01b0
---

Do not delete `backend/pm_review.db` (or `.db-shm`/`.db-wal`) to force schema/seed changes to apply, even reflexively. Write a targeted SQL migration in `database.js` instead (e.g. `UPDATE ... WHERE` guarded by a condition that only matches the old default values) — this was already the right pattern used for the memo template letterhead migration, but on 2026-06-30 it was deleted again anyway out of habit immediately after writing that exact migration.

**Why:** [[project_pm_review]] uses node:sqlite with no git/backup. The user already had to recover from one unauthorized deletion of this file in this project — see the Safety Protocol on destructive actions. There was no real data loss either time (db only held seed/test rows), but the user shouldn't have to keep catching this.

**How to apply:** Before running `rm`/`del` on any `.db`/`.db-shm`/`.db-wal` file in this project, stop and ask: does a migration in `database.js` already cover this? If yes, run that instead and never touch the file directly. If a destructive reset still seems necessary, ask the user first.
