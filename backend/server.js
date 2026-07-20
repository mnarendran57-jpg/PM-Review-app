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

// Everything below requires a valid login session
app.use('/api', requireAuth);

app.use('/api/projects', require('./routes/projects'));
app.use('/api/rfis', require('./routes/rfis'));
app.use('/api/submittals', require('./routes/submittals'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/team', require('./routes/team'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/proposal-intake', require('./routes/proposalIntake'));
app.use('/api/memo-templates', require('./routes/memoTemplates'));
app.use('/api/pay-app-review', require('./routes/payAppReview'));
app.use('/api/pco-review', require('./routes/pcoReview'));
app.use('/api/invoice-review', require('./routes/invoiceReview'));
app.use('/api/precon-review', require('./routes/preconReview'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PM Review backend running on http://0.0.0.0:${PORT}`);
});
