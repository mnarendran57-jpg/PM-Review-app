# Memory Index

- [User profile](user_profile.md) — PM at Olivier Inc., MEP construction consulting, manages HCC and other projects
- [Project: PM Review App](project_pm_review.md) — Node/Express/SQLite/React tool; 3 live modules (Proposal Intake, Pay App Review, Pre-Construction Review)
- [PM Review: operations](pm_review_operations.md) — how to run it, login password, the rate limit is NOT tight any more (the code still says it is), deployment still open
- [PM Review: GitHub repo](project_pm_review_github.md) — private repo URL; Gautam Santhanu Thampy is a confirmed collaborator, not a security issue
- [Project: deferred work](project_deferred_work.md) — usage metering and the per-request upload cap were both looked at and put off; don't start them unprompted
- [Feedback: DB caution](feedback_db_caution.md) — never delete pm_review.db to reset state, write a migration instead
- [Feedback: output style](feedback_output_style.md) — app reports must read in plain English for non-construction clients
- [Feedback: commit only on request](feedback_commit_on_request.md) — never commit or push unless explicitly told; pushing to main deploys
- [Feedback: no size limits](feedback_no_size_limits.md) — document size must never decide whether a feature works; queue the AI work, never hold the request
- [Feedback: fresh modules, no Pay App reference](feedback_fresh_module_no_payapp_reference.md) — build new modules from their skill alone; the two existing Pay App modules are broken and must not be a reference point
