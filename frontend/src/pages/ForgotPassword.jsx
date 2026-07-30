import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EnvelopeIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { authApi } from '../api';

// Asks for the address and stops there. The reset link is emailed and never shown on
// screen, because nothing here proves the person typing owns that mailbox.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async e => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.friendlyMessage ||
        'Cannot reach the server. Try again in a moment.'
      );
    } finally {
      setLoading(false);
    }
  };

  const shell = children => (
    <div className="min-h-screen flex items-center justify-center relative" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="card p-8 w-full max-w-sm animate-fade-up" style={{ position: 'relative', zIndex: 1 }}>
        <div className="flex items-center gap-3 mb-6">
          <img src="/coaster-logo.svg" alt="Coaster" className="w-10 h-10 rounded-xl flex-shrink-0" />
          <p className="text-sm font-bold text-gray-900 leading-tight">Coaster</p>
        </div>
        {children}
      </div>
    </div>
  );

  if (sent) {
    return shell(
      <>
        <CheckCircleIcon className="w-10 h-10 mb-3" style={{ color: '#059669' }} />
        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Check your email</h1>
        <p className="text-sm text-gray-500 mb-6">
          If <span className="font-medium text-gray-700">{email.trim()}</span> has a Coaster account,
          a reset link is on its way. It works for one hour, and only once.
        </p>
        <p className="text-[11px] text-gray-400 mb-5">
          Nothing arrived? Check the junk folder, or ask your firm's administrator to set a new
          password for you.
        </p>
        <button className="btn-primary w-full justify-center" onClick={() => navigate('/login')}>
          Back to sign in
        </button>
      </>
    );
  }

  return shell(
    <>
      <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Forgot your password?</h1>
      <p className="text-sm text-gray-400 mb-6">
        Enter your email and we'll send you a link to choose a new one.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Email</label>
          <input type="email" className="input" autoFocus autoComplete="username"
            value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" />
        </div>

        {error && (
          <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full justify-center" disabled={loading || !email.trim()}>
          {loading ? 'Sending…' : (
            <span className="flex items-center gap-2"><EnvelopeIcon className="w-4 h-4" /> Send reset link</span>
          )}
        </button>
        <Link to="/login" className="block text-center text-xs text-gray-400 hover:text-gray-600">
          Back to sign in
        </Link>
      </form>
    </>
  );
}
