import { useState, useEffect } from 'react';
import {
  EnvelopeIcon, PhoneIcon, MapPinIcon, PaperAirplaneIcon, CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { contactApi, authApi } from '../api';

const FALLBACK = { email: 'info@coasterapp.net', phone: '(832) 296-7170' };

// Opening the writer's own mail client with the message already in it.
//
// Used when the deployment has no mail provider configured. It is not a consolation prize: the
// message still reaches the same inbox, it arrives from their real address so replying works, and
// they can see it leave. The alternative — a form that says "thanks, we'll be in touch" and sends
// nothing — is the version of this page that was here before, and it loses every message typed
// into it.
// Opened by clicking a link rather than by assigning window.location. Assigning it looks to the
// browser like the single-page app is navigating away, and some of them tear the page down before
// the mail handler runs — which loses the message on the way to the thing meant to rescue it.
function openMailClient({ to, name, email, message }) {
  const subject = `Coaster enquiry${name ? ` — ${name}` : ''}`;
  const body = `${message}\n\n---\n${name || ''}${name && email ? '\n' : ''}${email || ''}\n`;
  const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return href;
}

export default function Contact() {
  const user = authApi.user();
  const [details, setDetails] = useState({ ...FALLBACK, canSend: false });
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '', message: '' });
  const [state, setState] = useState('idle');   // idle | sending | sent | handed-off
  const [error, setError] = useState('');

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    contactApi.details().then(d => setDetails({ ...FALLBACK, ...d })).catch(() => { /* keep the defaults */ });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setState('sending');
    try {
      const result = await contactApi.send(form);
      if (result.sent) {
        setState('sent');
        return;
      }
      // No mail provider on this deployment. Hand the message to their own mail client rather than
      // reporting a failure they can do nothing about.
      openMailClient({ to: result.email || details.email, ...form });
      setState('handed-off');
    } catch (err) {
      setState('idle');
      setError(err.response?.data?.error || 'That message could not be sent.');
    }
  };

  const reset = () => {
    setState('idle'); setError('');
    setForm({ name: user?.name || '', email: user?.email || '', message: '' });
  };

  const items = [
    { icon: EnvelopeIcon, label: 'Email', value: details.email, href: `mailto:${details.email}` },
    { icon: PhoneIcon, label: 'Phone', value: details.phone, href: `tel:${details.phone.replace(/[^\d+]/g, '')}` },
    { icon: MapPinIcon, label: 'Office', value: 'Houston, Texas' },
  ];

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-8 animate-fade-up">
        <h1 className="text-[30px] font-extrabold tracking-tight text-gray-900">Contact Us</h1>
        <p className="text-gray-500 mt-1 text-[15px]">Questions about a review, or need help with the app? Reach out.</p>
      </div>

      <div className="grid grid-cols-3 gap-6 items-start">
        <div className="col-span-2 card p-6 animate-fade-up">
          {state === 'sent' || state === 'handed-off' ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <CheckCircleIcon className="w-12 h-12" style={{ color: '#059669' }} />
              <p className="text-lg font-bold text-gray-900">
                {state === 'sent' ? "Thanks — we'll be in touch" : 'Your mail app is opening'}
              </p>
              <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
                {state === 'sent'
                  ? `Your message has gone to ${details.email}. A reply will come back to ${form.email}.`
                  : `Your message is ready to send to ${details.email} — press send in your mail app to finish. `
                    + 'If nothing opened, copy your message and email us directly.'}
              </p>
              <button className="btn-secondary mt-2" onClick={reset}>Write another</button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Your Name</label>
                  <input className="input" required value={form.name} onChange={set('name')} />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" type="email" required value={form.email} onChange={set('email')} />
                  <p className="text-[11px] text-gray-400 mt-1">We reply to this address.</p>
                </div>
              </div>
              <div>
                <label className="label">Message</label>
                <textarea className="input" rows={6} required maxLength={5000}
                  value={form.message} onChange={set('message')} placeholder="How can we help?" />
              </div>

              {error && (
                <div className="p-3 rounded-xl text-sm"
                  style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between gap-4">
                {/* Said up front rather than discovered on submit. */}
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  {details.canSend
                    ? `Goes straight to ${details.email}.`
                    : `Opens your mail app with the message ready to send to ${details.email}.`}
                </p>
                <button type="submit" className="btn-primary flex items-center gap-2 flex-shrink-0"
                  disabled={state === 'sending'}>
                  <PaperAirplaneIcon className="w-4 h-4" />
                  {state === 'sending' ? 'Sending…' : 'Send Message'}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="card p-6 space-y-5 animate-fade-up stagger-1">
          {items.map(({ icon: Icon, label, value, href }) => (
            <div key={label} className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(37,99,235,0.08)' }}>
                <Icon className="w-5 h-5" style={{ color: '#2563eb' }} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
                {/* Sized to fit an email address on one line in a third-width card. At text-sm
                    "info@coasterapp.net" wraps mid-word, which reads as a typo. */}
                {href ? (
                  <a href={href} className="text-[13px] text-gray-800 hover:underline">{value}</a>
                ) : (
                  <p className="text-[13px] text-gray-800 whitespace-pre-line">{value}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
