const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// --- One request must never be able to take the service down -----------------------------------
//
// Node's default for a promise rejection nobody caught is to kill the process. On a web service
// that is the worst possible default: one unhandled error in one request, on one user's document,
// ends every other request in flight — people lose work they had waited minutes for, and the
// restart looks to everybody like "it crashed for no reason".
//
// Logged loudly and survived instead. The request that caused it still fails, and it still has to
// be found and fixed, but it fails for the one person it belongs to.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection] the service is staying up; this still needs fixing:',
    reason && reason.stack ? reason.stack : reason);
});

// An uncaught exception is different: the process may genuinely be in a broken state, so carrying
// on could serve wrong answers rather than no answers. It is named in the log — which is the part
// that was missing — and then the process ends so Render replaces it with a clean one.
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception] shutting down so a clean process replaces this one:',
    err && err.stack ? err.stack : err);
  process.exit(1);
});

app.use(cors());

// Body ceilings.
//
// These were 500 MB, on an instance with 512 MB of memory. A single upload of that size could not
// be held at all, so the one request would not merely fail — it would exhaust the box and take
// every other user's work down with it. Nothing Coaster reads is anywhere near this: the largest
// real pay application packet on file is 3 MB across 67 pages, and a full drawing set is tens of
// megabytes.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
app.use('/api/cmar-pay-app-audit', require('./routes/cmarPayAppAudit'));
app.use('/api/coaster-ai', require('./routes/coasterAi'));
app.use('/api/contact', require('./routes/contact'));

// --- The last word on any request that went wrong -----------------------------------------------
//
// Without this, an error thrown out of a route gets Express's default: a stack trace in the
// response body on a dev build, and on a request that is still streaming an upload, a connection
// that simply stops — which the browser shows as a spinner that never ends. Neither tells the
// person anything they can act on.
//
// Two cases are worth naming specifically, because both are reachable by an ordinary user doing an
// ordinary thing, and both used to produce something baffling.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // An upload larger than the ceiling. Multer and body-parser each have their own way of saying it.
  if (err?.code === 'LIMIT_FILE_SIZE' || err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That file is too large for Coaster to read. Split it, or send the part that matters '
        + '— a pay application packet is usually a few megabytes, not hundreds.',
    });
  }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Too many files were attached to that request.' });
  }

  console.error(`[${req.method} ${req.path}] unhandled:`, err?.stack || err?.message || err);
  res.status(500).json({
    // Never the raw error: it is written for a developer and routinely contains a file path or a
    // fragment of somebody's document.
    error: 'Something went wrong handling that request. Nothing was saved. If it keeps happening, '
      + 'tell us what you were doing — this is ours to fix.',
  });
});

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

  // A daily copy of the database to object storage — a second company holding it, and a retention
  // we choose. See lib/dbBackup.js. It checks hourly rather than sleeping for a day, because this
  // process restarts often and a day-long timer would rarely live to fire.
  try {
    require('./lib/dbBackup').scheduleBackups();
  } catch (err) {
    console.error('Could not start database backups:', err.message);
  }
});
