import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { authApi, selectedOrg } from '../api';

// Where an emailed reset link lands. Using the link is what proves the account is theirs,
// so a successful reset signs them straight in.
export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    authApi.getReset(token)
      .then(setAccount)
      .catch(e => setLoadError(e?.response?.data?.error || 'This reset link is not valid.'));
  }, [token]);

  const submit = async e => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setSaving(true);
    try {
      authApi.adopt(await authApi.resetPassword(token, password));
      selectedOrg.clear();
      navigate('/organizations', { replace: true });
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not reset your password.');
      setSaving(false);
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

  if (loadError) {
    return shell(
      <>
        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Link problem</h1>
        <p className="text-sm text-gray-500 mb-6">{loadError}</p>
        <button className="btn-primary w-full justify-center" onClick={() => navigate('/forgot-password')}>
          Request a new link
        </button>
      </>
    );
  }

  if (!account) return shell(<p className="text-sm text-gray-400">Checking your link…</p>);

  return shell(
    <>
      <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Choose a new password</h1>
      <p className="text-sm text-gray-500 mb-6">
        For <span className="font-medium text-gray-700">{account.email}</span>.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" autoFocus autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" autoComplete="new-password"
            value={confirm} onChange={e => setConfirm(e.target.value)} />
        </div>

        {error && (
          <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full justify-center" disabled={saving || !password || !confirm}>
          {saving ? 'Saving…' : (
            <span className="flex items-center gap-2"><LockClosedIcon className="w-4 h-4" /> Set password &amp; sign in</span>
          )}
        </button>
        <p className="text-[11px] text-gray-400 text-center">
          Anyone still signed in as you elsewhere will be signed out.
        </p>
      </form>
    </>
  );
}
