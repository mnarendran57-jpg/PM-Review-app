const express = require('express');
const router = express.Router();
const email = require('../lib/email');

// Where a message from the Contact Us page goes. Overridable so a deployment can route it somewhere
// else without a code change, but it has a real default rather than failing quietly when unset.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'info@coasterapp.net';
const CONTACT_PHONE = process.env.CONTACT_PHONE || '(832) 296-7170';

const MAX_MESSAGE = 5000;

// One message a minute per person. This endpoint is behind sign-in, so it is not open to the world
// — but it does turn a form submission into an email, and a stuck send button held down is enough
// to make a mess of an inbox without anyone intending harm.
const COOLDOWN_MS = 60 * 1000;
const lastSent = new Map();

// Whether sending actually works, so the page can tell the truth rather than showing a form that
// silently goes nowhere. Nothing secret here: the address and number are printed on the page.
router.get('/', (req, res) => {
  res.json({
    email: CONTACT_EMAIL,
    phone: CONTACT_PHONE,
    // False on a deployment with no mail provider, and the page falls back to opening the user's
    // own mail client with the message already written.
    canSend: email.isConfigured(),
  });
});

router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 200);
  const from = String(req.body?.email || '').trim().slice(0, 320);
  const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE);

  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return res.status(400).json({ error: 'Enter an email address we can reply to.' });
  }
  if (!message) {
    return res.status(400).json({ error: 'Write a message first.' });
  }

  // Answered before anything is attempted, so the page can offer the mail-client fallback rather
  // than reporting a failure the user can do nothing about.
  if (!email.isConfigured()) {
    return res.json({ sent: false, reason: 'not-configured', email: CONTACT_EMAIL });
  }

  const previous = lastSent.get(req.user.id);
  if (previous && Date.now() - previous < COOLDOWN_MS) {
    return res.status(429).json({ error: 'You just sent a message — give it a minute before the next one.' });
  }
  lastSent.set(req.user.id, Date.now());

  const result = await email.sendContactMessage({
    to: CONTACT_EMAIL,
    name,
    email: from,
    message,
    // Who was actually signed in, which is not always who typed their address into the form.
    account: req.user?.email,
    org: req.orgId ? String(req.orgId) : null,
  });

  if (!result.sent) {
    // A send that failed must not leave the cooldown standing — the user has nothing to wait for.
    lastSent.delete(req.user.id);
    console.error('[contact] send failed:', result.reason);
    return res.json({ sent: false, reason: result.reason, email: CONTACT_EMAIL });
  }
  res.json({ sent: true });
});

module.exports = router;
