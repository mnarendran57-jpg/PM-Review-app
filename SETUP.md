# PM Review App — Setup Guide

## Prerequisites

### 1. Install Node.js
Download and install Node.js v20 LTS from: https://nodejs.org/en/download
- Choose the Windows Installer (.msi) — 64-bit
- Accept all defaults during install
- After install, open a NEW PowerShell window and verify: `node --version`

### 2. Get your Anthropic API Key
- Go to https://console.anthropic.com/
- Create or copy your API key

---

## First-Time Setup

Open PowerShell and run these commands one at a time:

```powershell
# 1. Go to the project folder
cd "C:\Users\NarenMurali\OneDrive - Olivier, Inc\HCC\pm-review app"

# 2. Install backend packages
cd backend
npm install
cd ..

# 3. Install frontend packages
cd frontend
npm install
cd ..

# 4. Create your .env file
Copy-Item backend\.env.example backend\.env
```

Then open `backend\.env` in Notepad and set your API key:
```
ANTHROPIC_API_KEY=sk-ant-...your key here...
PORT=3001
```

---

## Running the App

You need TWO terminal windows open simultaneously.

**Terminal 1 — Backend:**
```powershell
cd "C:\Users\NarenMurali\OneDrive - Olivier, Inc\HCC\pm-review app\backend"
node server.js
```

**Terminal 2 — Frontend:**
```powershell
cd "C:\Users\NarenMurali\OneDrive - Olivier, Inc\HCC\pm-review app\frontend"
npm run dev
```

Then open your browser to: **http://localhost:3000**

---

## Project Structure

```
pm-review app/
├── backend/
│   ├── server.js           # Express server entry point
│   ├── database.js         # SQLite schema + init
│   ├── pm_review.db        # Auto-created on first run (SQLite database)
│   ├── .env                # Your API keys (not committed to git)
│   └── routes/
│       ├── projects.js
│       ├── rfis.js
│       ├── submittals.js
│       ├── finance.js      # Pay apps + invoices
│       ├── reviews.js      # AI document review
│       ├── team.js
│       └── settings.js
└── frontend/
    └── src/
        ├── App.jsx
        ├── api.js          # All API calls
        ├── pages/
        │   ├── Projects.jsx
        │   ├── DocumentReview.jsx
        │   ├── RFITracker.jsx
        │   ├── SubmittalTracker.jsx
        │   ├── Finance.jsx
        │   └── Settings.jsx
        └── components/
            ├── Layout.jsx
            ├── Sidebar.jsx
            ├── Modal.jsx
            ├── PageHeader.jsx
            └── StatusBadge.jsx
```

---

## Modules

| Module | Path | Description |
|--------|------|-------------|
| Projects | `/projects` | Master project list with summary panels |
| Document Review | `/review` | AI-powered document review + history |
| RFI Tracker | `/rfis` | Full RFI lifecycle with overdue highlighting |
| Submittal Tracker | `/submittals` | Submittal log with EOR tracking |
| Pay Apps & Invoices | `/finance` | Financial tracking with dashboard summary |
| Team & Settings | `/settings` | Team members + due date configuration |

---

## Notes

- Database is stored at `backend/pm_review.db` — back this file up regularly
- The app runs entirely locally — no internet required except for AI reviews
- AI reviews use model `claude-sonnet-4-20250514` via the Anthropic API
- Export to Excel works for RFI and Submittal trackers
