import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { EnvelopeIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { authApi } from '../api';

// Signing up for a free trial of your own, with a work email. The server decides whether the address
// is a company's (backend/lib/workEmail.js); this page only shows its answer. How the work email is
// then approved depends on the server (backend/routes/auth.js, approvalMode):
//   'email'    — a link is emailed, and the password is chosen on the page it opens, so only the
//                person who holds the inbox ever sets it. No password on this form.
//   'approval' — Coaster approves the request by hand, so the password is chosen here and the
//                person signs in once it is approved.

// Cloudflare Turnstile, the check that a person and not a script is signing up. Shown only when the
// site key is configured; the server skips the check in the same circumstances.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// `showing` is whether the form (and so the widget's box) is on the page: the widget is put back
// when someone goes back from "check your email" to use a different address.
function useTurnstile(containerRef, onToken, showing) {
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !showing || !containerRef.current) return undefined;
    let widgetId = null;
    const render = () => {
      if (!window.turnstile || !containerRef.current || widgetId !== null) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: token => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector(`script[src="${TURNSTILE_SCRIPT}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', render);
    }
    return () => { if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId); };
  }, [showing]);
}

export default function Signup() {
  const [form, setForm] = useState({ name: '', email: '', company: '', password: '' });
  const [again, setAgain] = useState('');
  const [humanToken, setHumanToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [resent, setResent] = useState(false);
  const [mode, setMode] = useState('email');
  const [trialDays, setTrialDays] = useState(14);
  const humanBox = useRef(null);
  useTurnstile(humanBox, setHumanToken, !sentTo);

  useEffect(() => {
    authApi.signupOpen().then(r => { setMode(r.mode || 'email'); if (r.trialDays) setTrialDays(r.trialDays); }).catch(() => {});
  }, []);
  const byCoaster = mode === 'approval';

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));
  const ready = form.name.trim() && form.email.trim() && form.company.trim()
    && (!byCoaster || (form.password && again))
    && (!TURNSTILE_SITE_KEY || humanToken);

  const submit = async e => {
    e.preventDefault();
    if (byCoaster && form.password !== again) { setError('The two passwords do not match.'); return; }
    setError(''); setBusy(true);
    try {
      const r = await authApi.signup({ ...form, password: byCoaster ? form.password : undefined, human_token: humanToken });
      if (r.mode) setMode(r.mode);
      setSentTo(r.email || form.email.trim().toLowerCase());
    } catch (err) {
      setError(err.response?.data?.error || err.friendlyMessage || 'Could not sign up. Try again.');
      // A token is good for one check; a refused sign-up needs a fresh one.
      if (window.turnstile && TURNSTILE_SITE_KEY) { window.turnstile.reset(); setHumanToken(''); }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    await authApi.resendConfirmation(sentTo).catch(() => {});
    setResent(true);
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative px-4" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="card p-8 w-full max-w-md animate-fade-up" style={{ position: 'relative', zIndex: 1 }}>
        <div className="flex items-center gap-3 mb-6">
          <img src="/coaster-logo.svg" alt="Coaster" className="w-10 h-10 rounded-xl flex-shrink-0" />
          <p className="text-sm font-bold text-gray-900 leading-tight">Coaster</p>
        </div>

        {sentTo && byCoaster ? (
          <div>
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(5,150,105,0.1)' }}>
              <CheckCircleIcon className="w-6 h-6" style={{ color: '#047857' }} />
            </div>
            <h1 className="text-xl font-extrabold text-gray-900 mb-2 tracking-tight">Thanks — we've got your request</h1>
            <p className="text-sm text-gray-600 leading-relaxed">
              We're checking <span className="font-semibold text-gray-900">{sentTo}</span> is your work email. Once it's
              approved — usually within one business day — sign in with the password you just chose and your {trialDays}-day free
              trial starts.
            </p>
            <Link to="/login" className="btn-primary inline-flex mt-5">Go to sign in</Link>
          </div>
        ) : sentTo ? (
          <div>
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(37,99,235,0.08)' }}>
              <EnvelopeIcon className="w-6 h-6" style={{ color: '#2563eb' }} />
            </div>
            <h1 className="text-xl font-extrabold text-gray-900 mb-2 tracking-tight">Check your email</h1>
            <p className="text-sm text-gray-600 leading-relaxed">
              We sent a link to <span className="font-semibold text-gray-900">{sentTo}</span>. Open it to choose your
              password, and you'll go straight into Coaster.
            </p>
            <p className="text-xs text-gray-400 mt-4 leading-relaxed">
              The link works for 48 hours. Not there after a few minutes? Check your spam or junk folder.
            </p>
            <div className="mt-5 flex items-center gap-3">
              {resent ? (
                <span className="flex items-center gap-1.5 text-xs" style={{ color: '#047857' }}>
                  <CheckCircleIcon className="w-4 h-4" /> Sent again
                </span>
              ) : (
                <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={resend}>Send it again</button>
              )}
              <button type="button" className="text-xs text-gray-400 hover:text-gray-600" onClick={() => { setSentTo(''); setResent(false); }}>
                Use a different email
              </button>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Start your free trial</h1>
            <p className="text-sm text-gray-400 mb-6">{trialDays} days of Coaster, free. Sign up with your work email.</p>

            <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="label">Your name</label>
                  <input className="input" autoFocus autoComplete="name" value={form.name} onChange={set('name')} />
                </div>
                <div>
                  <label className="label">Work email</label>
                  <input type="email" className="input" autoComplete="email" placeholder="you@yourcompany.com"
                    value={form.email} onChange={set('email')} />
                  <p className="text-[11px] text-gray-400 mt-1">Personal addresses like Gmail or Outlook.com can't be used.</p>
                </div>
                <div>
                  <label className="label">Company</label>
                  <input className="input" autoComplete="organization" value={form.company} onChange={set('company')} />
                </div>
                {byCoaster && (
                  <>
                    <div>
                      <label className="label">Password</label>
                      <input type="password" className="input" autoComplete="new-password" value={form.password} onChange={set('password')} />
                      <p className="text-[11px] text-gray-400 mt-1">At least 12 characters. A short phrase is easier to remember than a jumble.</p>
                    </div>
                    <div>
                      <label className="label">Type it again</label>
                      <input type="password" className="input" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />
                    </div>
                  </>
                )}

                {TURNSTILE_SITE_KEY && <div ref={humanBox} />}

                {error && (
                  <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                    {error}
                  </div>
                )}

                <button type="submit" className="btn-primary w-full justify-center" disabled={busy || !ready}>
                  {busy ? 'Checking…' : 'Start my free trial'}
                </button>
              </form>
            <p className="text-center text-xs text-gray-400 mt-5">
              Already have an account? <Link to="/login" className="text-blue-600 hover:underline">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
