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

async function send({ to, subject, html, text }) {
  if (!isConfigured()) return { sent: false, reason: 'not-configured' };
  try {
    if (hasSmtp()) {
      await smtpTransport().sendMail({ from: EMAIL_FROM, to, subject, html, text });
      return { sent: true, via: 'smtp' };
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
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

module.exports = { isConfigured, send, sendInvitation };
