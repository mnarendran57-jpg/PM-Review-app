const express = require('express');
const router = express.Router();
const jobs = require('../lib/jobs');
const { requireOrg } = require('../middleware/auth');

// Where every module's background work is collected from.
//
// The three modules that had a job queue each grew their own /jobs/:id endpoint, which was fine
// while there were three. There are a dozen now, and a dozen identical endpoints is a dozen places
// for the scoping to be written slightly differently — and the thing being handed back is a whole
// extracted pay application or drawing review, so the scoping is the part that matters.
//
// One endpoint, one rule: a job is visible to the organization it was started in AND to the person
// who started it. The module-specific ones stay where they are; nothing is gained by moving the
// callers that already work.

router.use(requireOrg);

router.get('/:id', (req, res) => {
  const row = jobs.get(req.params.id, { orgId: req.orgId, userId: req.user.id });
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Finished jobs are swept on the way past rather than by a timer, so an abandoned result does
  // not sit in the database holding somebody's document indefinitely.
  if (row.status !== jobs.RUNNING) jobs.sweep();
  res.json(jobs.view(row));
});

module.exports = router;
