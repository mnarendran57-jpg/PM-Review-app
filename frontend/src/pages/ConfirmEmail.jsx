import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BuildingOffice2Icon } from '@heroicons/react/24/outline';
import { authApi } from '../api';

// Where the emailed confirmation link lands. Opening it changes nothing — the mail scanners some
// companies run open every link — so the account is confirmed only when the person chooses their
// password here. Then they are signed straight in.
export default function ConfirmEmail() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [alreadyUsed, setAlreadyUsed] = useState(false);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi.getConfirmation(token)
      .then(setInfo)
      .catch(err => {
        setLoadError(err.response?.data?.error || 'This link could not be opened.');
        setAlreadyUsed(!!err.response?.data?.used);
      });
  }, [token]);

  const submit = async e => {
    e.preventDefault();
    if (password !== again) { setError('The two passwords do not match.'); return; }
    setError(''); setBusy(true);
    try {
      await authApi.confirmEmail(token, password);
      navigate('/organizations', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || err.friendlyMessage || 'Could not confirm your account. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative px-4" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="card p-8 w-full max-w-md animate-fade-up" style={{ position: 'relative', zIndex: 1 }}>
        <div className="flex items-center gap-3 mb-6">
          <img src="/coaster-logo.svg" alt="Coaster" className="w-10 h-10 rounded-xl flex-shrink-0" />
          <p className="text-sm font-bold text-gray-900 leading-tight">Coaster</p>
        </div>

        {loadError ? (
          <div>
            <h1 className="text-xl font-extrabold text-gray-900 mb-2 tracking-tight">This link can't be used</h1>
            <p className="text-sm text-gray-600">{loadError}</p>
            <Link to={alreadyUsed ? '/login' : '/signup'} className="btn-primary inline-flex mt-5">
              {alreadyUsed ? 'Sign in' : 'Sign up again'}
            </Link>
          </div>
        ) : !info ? (
          <p className="text-sm text-gray-400">Opening your link…</p>
        ) : (
          <>
            <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">
              {info.name ? `Welcome, ${info.name.split(' ')[0]}` : 'Welcome'}
            </h1>
            <p className="text-sm text-gray-500 mb-5">Choose a password for {info.email}.</p>

            <div className="flex items-start gap-3 p-3 rounded-xl mb-5" style={{ background: '#f8fafc', border: '1px solid #eef1f4' }}>
              <BuildingOffice2Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#2563eb' }} />
              <p className="text-[12px] text-gray-600 leading-relaxed">
                Your {info.trialDays || 14}-day free trial starts as soon as you've chosen a password, in a workspace of your own for{' '}
                <span className="font-semibold text-gray-900">{info.company}</span>. You can set up programs and projects straight away.
              </p>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Password</label>
                <input type="password" className="input" autoFocus autoComplete="new-password"
                  value={password} onChange={e => setPassword(e.target.value)} />
                <p className="text-[11px] text-gray-400 mt-1">At least 12 characters. A short phrase is easier to remember than a jumble.</p>
              </div>
              <div>
                <label className="label">Type it again</label>
                <input type="password" className="input" autoComplete="new-password"
                  value={again} onChange={e => setAgain(e.target.value)} />
              </div>

              {error && (
                <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                  {error}
                </div>
              )}

              <button type="submit" className="btn-primary w-full justify-center" disabled={busy || !password || !again}>
                {busy ? 'Setting up…' : 'Confirm and continue'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
