# PM Review App

An internal web tool for MEP construction project management at Olivier, Inc. It takes the document review work that a project manager would otherwise do by hand — reading vendor proposals, checking contractor pay applications, and combing through drawing sets — and does the mechanical parts automatically, so the PM reviews conclusions instead of hunting for them.

The app runs a shared team login and uses the Anthropic Claude API to read construction PDFs.

---

## What it does

### Proposal Intake
Upload a vendor proposal or change order PDF. The app extracts the key fields, generates an Olivier letterhead memo cover, and merges the memo and the proposal (plus the PO, for change orders) into a single PDF ready to send. The memo wording is editable in-app under the module's Settings tab, so the template can change without touching code.

### Pay App Review
Upload the previous and current AIA G702/G703 pay applications. The app pulls the figures out of both, then runs **27 deterministic math and over-billing checks** against them — things like stored materials exceeding the scheduled value, retainage miscalculations, and line items billed beyond completion. It also produces a site-verification checklist of exactly what is newly billed this period, so the PM knows what to confirm in the field.

The checks are ordinary arithmetic, not AI. Only the initial reading of the PDFs uses the model, which means the numbers are reproducible and auditable.

### Pre-Construction Review
Upload drawings, specifications, or project narratives. The app returns a report covering design risks, likely high-cost items, probable change-order exposure, and concrete action items for the PM.

---

## How it is built

| Part | Technology |
|------|-----------|
| Frontend | React, Vite, Tailwind CSS (port 3000) |
| Backend | Node.js, Express (port 3001) |
| Database | SQLite via Node's built-in `node:sqlite` |
| PDF handling | `pdf-lib` |
| AI | Anthropic Claude API, model `claude-sonnet-4-5` |

The database is a single file, `backend/pm_review.db`, created automatically on first run. Schema changes are applied by migrations in `backend/database.js` at boot, so the file is never deleted to pick up changes.

---

## Requirements

- **Node.js 22 or newer** (24 recommended). The app uses Node's built-in `node:sqlite` module, which does not exist in Node 20 or earlier — older versions will fail to start.
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/).

---

## First-time setup

Clone the repository, then install both halves:

```powershell
cd PM-Review-app

cd backend
npm install
cd ..

cd frontend
npm install
cd ..
```

Create the backend environment file from the template:

```powershell
Copy-Item backend\.env.example backend\.env
```

Open `backend\.env` and fill in all four values:

| Variable | What it is |
|----------|-----------|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `PORT` | `3001` |
| `APP_PASSWORD_HASH` | bcrypt hash of the shared team login password |
| `JWT_SECRET` | Random secret used to sign login sessions |

Generate the last two:

```powershell
node -e "console.log(require('bcryptjs').hashSync('your_password', 10))"
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`backend/.env` is deliberately excluded from git and must never be committed. `backend/.env.example` is the safe template that is.

---

## Running the app

Two terminals, both left open.

**Backend:**
```powershell
cd backend
npm run dev
```
`npm run dev` runs the server under nodemon, which restarts it automatically when backend code changes. Use `npm start` for a plain run without auto-reload. Note that changes to `.env` require a full restart either way.

**Frontend:**
```powershell
cd frontend
npm run dev
```

Then open **http://localhost:3000** and sign in with the shared team password.

The backend must be running or the login screen will report that it cannot reach the server. The frontend proxies `/api` to port 3001 in development, configured in `frontend/vite.config.js`.

---

## Project layout

```
pm-review app/
├── backend/
│   ├── server.js              # Express entry point, route mounting, auth gate
│   ├── database.js            # SQLite schema and migrations, run at boot
│   ├── .env.example           # Template for backend/.env
│   ├── routes/                # One file per API area
│   ├── middleware/auth.js     # JWT check applied to every /api route
│   └── lib/
│       ├── payAppExtract.js   # Sends both pay app PDFs in a single API call
│       ├── payAppChecks.js    # The 27 deterministic checks
│       ├── payAppNormalize.js # Fills in derivable values the model missed
│       ├── payAppChecklist.js # Site-verification checklist builder
│       ├── preconReview.js    # Pre-construction analysis
│       ├── pdfGen.js          # Memo and report PDF generation
│       └── aiErrors.js        # Turns API errors into readable messages
└── frontend/
    └── src/
        ├── App.jsx            # Routes
        ├── api.js             # All API calls, JWT interceptor
        ├── pages/
        └── components/
```

### A note on unused files

`frontend/src/pages/` also contains `Projects.jsx`, `DocumentReview.jsx`, `RFITracker.jsx`, `SubmittalTracker.jsx`, `Finance.jsx`, and `Settings.jsx`, with matching backend routes. These are earlier modules, intentionally left out of the navigation while the three modules above are the focus. They are kept for reuse — re-adding their imports and routes to `App.jsx` and `Sidebar.jsx` brings them back.

---

## Things worth knowing

**API rate limits are the most common source of confusing failures.** The Anthropic account is on a low tier — roughly 10,000 input tokens and 5 requests per minute, shared across all three modules. Reviewing several documents in quick succession can exhaust it and surface as an error. The app already mitigates this by sending both pay app PDFs in one call and retrying once automatically. If it persists, the fix is on the Anthropic Console, not in this code.

**Back up `backend/pm_review.db`.** It holds every proposal, pay app, and memo template. It is excluded from git on purpose, so version control is not a backup.

**Authentication is a single shared team password**, not per-user accounts. Every `/api` route except health and login requires a valid token.

---

## Deployment status

The app currently runs locally only. Hosting it is in progress and unfinished.

The frontend deploys to Netlify from this repository (`netlify.toml` sets the build directory and the single-page-app redirect). **The backend is not yet hosted anywhere**, so a deployed frontend cannot log in — Netlify is a static host and cannot run Express, keep a SQLite file on disk, or hold the API key.

Completing the deployment requires a host that runs Node continuously with persistent storage, and a decision about whether client project data may live on third-party infrastructure.
