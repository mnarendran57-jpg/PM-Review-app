const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Public — no login required
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', require('./routes/auth'));
// Accepting an invitation necessarily happens before the invitee has a login.
app.use('/api/invitations', require('./routes/invitations'));

// Everything below requires a valid login session
app.use('/api', requireAuth);

app.use('/api/programs', require('./routes/programs'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/settings', require('./routes/settings'));

// Not mounted: finance, reviews, team. Their pages are not routed in the frontend, so these
// endpoints were unreachable by the app but still served any logged-in caller — an
// authorization gap with no upside. The route files are kept for when those features are
// revived, at which point they need the same org scoping as everything below.
app.use('/api/proposal-intake', require('./routes/proposalIntake'));
app.use('/api/submittals', require('./routes/submittals'));
app.use('/api/rfis', require('./routes/rfis'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/memo-templates', require('./routes/memoTemplates'));
// The organization's own Word documents — their memo cover, their progress report — fed once by
// an admin and used by every project that has not uploaded its own.
app.use('/api/org-templates', require('./routes/orgTemplates'));
app.use('/api/pay-app-review', require('./routes/payAppReview'));
// Shared Documents — the project's filing cabinet. It is addressed under the pay app review path
// for historical reasons and mounted separately so that holding one module at an older behaviour
// cannot take the whole project's documents down with it, which is what happened on 19 August.
app.use('/api/pay-app-review', require('./routes/projectDocuments'));
// A sandbox copy of the module above, on its own table. See routes/payAppReview2.js.
app.use('/api/pay-app-review-2', require('./routes/payAppReview2'));
app.use('/api/pco-review', require('./routes/pcoReview'));
app.use('/api/invoice-review', require('./routes/invoiceReview'));
app.use('/api/progress-report', require('./routes/progressReport'));
app.use('/api/precon-review', require('./routes/preconReview'));
app.use('/api/ve-analyzer', require('./routes/veAnalyzer'));
app.use('/api/coaster-ai', require('./routes/coasterAi'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PM Review backend running on http://0.0.0.0:${PORT}`);
  // Nothing is read on boot. A contract is read by the first review that measures against it,
  // so a restart has no unfinished work to pick up — and a deploy can never start a bill.
  // Anything left mid-read by a restart is reset here so it is retried on next use rather than
  // sitting at "reading" for ever.
  try {
    const reset = require('./database').prepare(`UPDATE project_contracts SET terms_status='pending' WHERE terms_status='reading'`).run();
    if (reset.changes) console.log(`[contract extract] reset ${reset.changes} interrupted read(s) to pending`);
  } catch (err) {
    console.error('Could not reset interrupted contract reads:', err.message);
  }
});
