// Optional outbound email. Sending is not required for the product to work: when no
// provider is configured the caller simply hands the admin a link to pass on themselves,
// which is why every function here reports whether it actually sent rather than throwing.
//
// Two ways to configure it, whichever suits the deployment:
//   SMTP     — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
//              (for Gmail: smtp.gmail.com / 465, and an App Password, not the account
//               password — Google blocks the latter for SMTP)
//   Resend   — RESEND_API_KEY, EMAIL_FROM
// SMTP wins if both are present, since it is the more deliberate choice.
const { RESEND_API_KEY, EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

const hasSmtp = () => !!(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM);
const hasResend = () => !!(RESEND_API_KEY && EMAIL_FROM);
const isConfigured = () => hasSmtp() || hasResend();

let transport = null;
function smtpTransport() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    const port = Number(SMTP_PORT) || 587;
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transport;
}

// `replyTo` matters for anything a person is expected to answer. Mail sent by an application goes
// out as EMAIL_FROM, so hitting reply on a contact-form message would write back to the application
// rather than to whoever asked the question.
async function send({ to, subject, html, text, replyTo }) {
  if (!isConfigured()) return { sent: false, reason: 'not-configured' };
  try {
    if (hasSmtp()) {
      await smtpTransport().sendMail({ from: EMAIL_FROM, to, subject, html, text, replyTo });
      return { sent: true, via: 'smtp' };
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM, to: [to], subject, html, text,
        ...(replyTo ? { reply_to: [replyTo] } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[email] resend failed:', res.status, body.slice(0, 200));
      return { sent: false, reason: `provider-error-${res.status}` };
    }
    return { sent: true, via: 'resend' };
  } catch (err) {
    // A failed send must never fail the request that triggered it — the invitation still
    // exists and its link can be copied by hand.
    console.error('[email] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

function sendInvitation({ to, orgName, inviterName, role, link }) {
  const who = inviterName ? `${inviterName} has` : 'You have been';
  const subject = `You've been invited to ${orgName} on Coaster`;
  const text =
    `${who} invited you to join ${orgName} on Coaster as ${role === 'Admin' ? 'an administrator' : 'a member'}.\n\n` +
    `Set your password and get started:\n${link}\n\n` +
    `This link is valid for 7 days and can only be used once.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">You've been invited to ${orgName}</h2>
      <p style="color:#374151;line-height:1.6">
        ${who} invited you to join <strong>${orgName}</strong> on Coaster as
        ${role === 'Admin' ? 'an <strong>administrator</strong>' : 'a <strong>member</strong>'}.
      </p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;
           text-decoration:none;font-weight:600;display:inline-block">Set your password</a>
      </p>
      <p style="color:#6b7280;font-size:13px;line-height:1.6">
        This link is valid for 7 days and can only be used once.<br>
        If the button doesn't work, paste this into your browser:<br>
        <span style="color:#2563eb;word-break:break-all">${link}</span>
      </p>
    </div>`;
  return send({ to, subject, html, text });
}

function sendPasswordReset({ to, name, link, minutes }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const subject = 'Reset your Coaster password';
  const text =
    `${greeting}\n\nSomeone asked to reset the password for this Coaster account.\n\n` +
    `Choose a new one here:\n${link}\n\n` +
    `This link is valid for ${minutes} minutes and can only be used once.\n` +
    `If you didn't ask for this, ignore this email — your password has not changed.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">Reset your password</h2>
      <p style="color:#374151;line-height:1.6">
        ${greeting} someone asked to reset the password for this Coaster account.
      </p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;
           text-decoration:none;font-weight:600;display:inline-block">Choose a new password</a>
      </p>
      <p style="color:#6b7280;font-size:13px;line-height:1.6">
        This link is valid for ${minutes} minutes and can only be used once.<br>
        If you didn't ask for this, you can ignore this email — your password has not changed.<br><br>
        If the button doesn't work, paste this into your browser:<br>
        <span style="color:#2563eb;word-break:break-all">${link}</span>
      </p>
    </div>`;
  return send({ to, subject, html, text });
}

// A message somebody typed into the Contact Us page.
//
// Their address goes in Reply-To rather than in From: mail providers reject or quarantine a message
// claiming to come from a domain the sender does not control, so this is sent as Coaster's own
// address and replies land where they should.
function sendContactMessage({ to, name, email, message, account, org }) {
  const who = name || email || 'Someone';
  const subject = `Coaster contact — ${who}`;
  const facts = [
    `From: ${name || '(no name given)'} <${email}>`,
    account ? `Signed in as: ${account}` : null,
    org ? `Organization: ${org}` : null,
  ].filter(Boolean);

  const text = `${facts.join('\n')}\n\n${message}\n`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">
      <h2 style="margin:0 0 12px">Message from the Contact Us page</h2>
      <p style="color:#6b7280;font-size:13px;line-height:1.7;margin:0 0 16px">
        ${facts.map(escapeHtml).join('<br>')}
      </p>
      <div style="color:#111827;line-height:1.7;white-space:pre-wrap;border-left:3px solid #e5e7eb;padding-left:14px">
${escapeHtml(message)}
      </div>
    </div>`;

  // Reply-To is the whole point: answering this should write back to them, not to Coaster.
  return send({ to, subject, html, text, replyTo: email });
}

const escapeHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = { isConfigured, send, sendInvitation, sendPasswordReset, sendContactMessage };
