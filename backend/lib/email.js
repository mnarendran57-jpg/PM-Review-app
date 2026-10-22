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

// The look shared by the sign-up emails: a heading, a line or two, one button, and the link
// written out for a mail program that does not show buttons. Every value that came from a person
// — a name, a company — is escaped, because a sign-up form is open to anyone.
function simpleEmail({ heading, paragraphs, button, link, footnote }) {
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
      ${paragraphs.map(p => `<p style="color:#374151;line-height:1.6">${escapeHtml(p)}</p>`).join('')}
      ${link ? `<p style="margin:24px 0">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;
           text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(button)}</a>
      </p>` : ''}
      <p style="color:#6b7280;font-size:13px;line-height:1.6">
        ${footnote ? `${escapeHtml(footnote)}<br><br>` : ''}
        ${link ? `If the button doesn't work, paste this into your browser:<br>
        <span style="color:#2563eb;word-break:break-all">${link}</span>` : ''}
      </p>
    </div>`;
  const text = [heading, '', ...paragraphs, '', ...(link ? [`${button}: ${link}`, ''] : []), footnote || '']
    .join('\n').trim();
  return { html, text };
}

function sendEmailConfirmation({ to, name, link, hours }) {
  const { html, text } = simpleEmail({
    heading: 'Confirm your email to start using Coaster',
    paragraphs: [`${name ? `Hi ${name}, t` : 'T'}hanks for signing up. Confirm this is your email address and you'll go straight into Coaster.`],
    button: 'Confirm my email',
    link,
    footnote: `This link is valid for ${hours} hours and can only be used once. If you didn't sign up for Coaster, ignore this email — no account is created until the link is used.`,
  });
  return send({ to, subject: 'Confirm your email for Coaster', html, text });
}

// Someone tried to sign up with an address that already has an account. Sent to that address, so
// the person who owns it learns of the attempt, and the sign-up page itself gives nothing away.
function sendAlreadyRegistered({ to, loginLink, resetLink }) {
  const { html, text } = simpleEmail({
    heading: 'You already have a Coaster account',
    paragraphs: [
      'Someone — probably you — tried to sign up for Coaster with this email address, which already has an account.',
      `Sign in at ${loginLink}. If you've forgotten your password, you can choose a new one.`,
    ],
    button: 'Choose a new password',
    link: resetLink,
    footnote: "If this wasn't you, you can ignore this email. Nothing about your account has changed.",
  });
  return send({ to, subject: 'You already have a Coaster account', html, text });
}

// `forCoaster`: sent to Coaster's own admins, who answer for a company that has no Admin yet.
function sendJoinRequest({ to, adminName, requesterName, requesterEmail, orgName, link, forCoaster = false }) {
  const { html, text } = simpleEmail({
    heading: `${requesterName || requesterEmail} wants to join ${orgName}`,
    paragraphs: forCoaster ? [
      `${requesterName || 'Someone'} (${requesterEmail}) signed up for Coaster and asked to join ${orgName}, which has no administrator of its own yet.`,
      "They can't see any of the company's projects until they're approved. Approve or decline from the Team page.",
    ] : [
      `${adminName ? `Hi ${adminName}, ` : ''}${requesterName || 'Someone'} (${requesterEmail}) signed up for Coaster with your company's email domain and asked to join ${orgName}.`,
      "They can't see any of your projects until you approve them. Approve or decline from your Team page.",
    ],
    button: 'Review the request',
    link,
  });
  return send({ to, subject: `${requesterName || requesterEmail} wants to join ${orgName} on Coaster`, html, text });
}

function sendJoinDecision({ to, name, orgName, approved, link }) {
  const { html, text } = simpleEmail({
    heading: approved ? `You've been added to ${orgName}` : `Your request to join ${orgName} was declined`,
    paragraphs: [approved
      ? `${name ? `Hi ${name}, ` : ''}an administrator at ${orgName} approved your request. You can sign in and start working now.`
      : `${name ? `Hi ${name}, ` : ''}an administrator at ${orgName} declined your request to join. If you think this is a mistake, contact them directly.`],
    button: approved ? 'Open Coaster' : null,
    link: approved ? link : null,
  });
  return send({ to, subject: approved ? `You're in — ${orgName} on Coaster` : `Your request to join ${orgName}`, html, text });
}

module.exports = {
  isConfigured, send, sendInvitation, sendPasswordReset, sendContactMessage,
  sendEmailConfirmation, sendAlreadyRegistered, sendJoinRequest, sendJoinDecision, escapeHtml,
};
