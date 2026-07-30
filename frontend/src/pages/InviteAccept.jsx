import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LockClosedIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { invitationsApi, authApi, selectedOrg } from '../api';

// Where an invited person lands. They choose their own password here — nobody else, not
// even the admin who invited them, ever knows it.
export default function InviteAccept() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(null);

  useEffect(() => {
    invitationsApi.get(token)
      .then(setInvite)
      .catch(e => setLoadError(e?.response?.data?.error || 'This invitation link is not valid.'));
  }, [token]);

  const submit = async () => {
    setError('');
    if (!invite.hasAccount) {
      if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
      if (password !== confirm) { setError('The two passwords do not match.'); return; }
    }
    setSaving(true);
    try {
      const result = await invitationsApi.accept(token, { name: name.trim(), password });
      if (result.existingAccount) {
        setJoined(result);           // they already had a login — send them to sign in
      } else {
        authApi.adopt(result);       // brand new account: sign straight in
        selectedOrg.clear();
        navigate('/organizations', { replace: true });
      }
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not complete your invitation.');
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
        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Invitation problem</h1>
        <p className="text-sm text-gray-500 mb-6">{loadError}</p>
        <button className="btn-secondary w-full justify-center" onClick={() => navigate('/login')}>Go to sign in</button>
      </>
    );
  }

  if (joined) {
    return shell(
      <>
        <CheckCircleIcon className="w-10 h-10 mb-3" style={{ color: '#059669' }} />
        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">You're in</h1>
        <p className="text-sm text-gray-500 mb-6">
          You already had a Coaster account, so we've added <strong>{joined.orgName}</strong> to it.
          Sign in with your existing password.
        </p>
        <button className="btn-primary w-full justify-center" onClick={() => navigate('/login')}>Go to sign in</button>
      </>
    );
  }

  if (!invite) return shell(<p className="text-sm text-gray-400">Checking your invitation…</p>);

  return shell(
    <>
      <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">
        Join {invite.orgName}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        {invite.inviterName ? `${invite.inviterName} invited ` : 'You were invited '}
        <span className="font-medium text-gray-700">{invite.email}</span>
        {invite.role === 'Admin' ? ' as an administrator.' : ' as a member.'}
      </p>

      {invite.hasAccount ? (
        <>
          <p className="text-sm text-gray-600 mb-5">
            You already have a Coaster account with this email. Accept to add this organization to it —
            your existing password stays as it is.
          </p>
          {error && (
            <div className="p-3 mb-4 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>{error}</div>
          )}
          <button className="btn-primary w-full justify-center" onClick={submit} disabled={saving}>
            {saving ? 'Joining…' : 'Accept invitation'}
          </button>
        </>
      ) : (
        <form onSubmit={e => { e.preventDefault(); submit(); }} className="space-y-4">
          <div>
            <label className="label">Your name</label>
            <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Naren Murali" />
          </div>
          <div>
            <label className="label">Choose a password</label>
            <input className="input" type="password" autoComplete="new-password" value={password}
              onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input className="input" type="password" autoComplete="new-password" value={confirm}
              onChange={e => setConfirm(e.target.value)} />
          </div>
          {error && (
            <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>{error}</div>
          )}
          <button type="submit" className="btn-primary w-full justify-center" disabled={saving || !password || !confirm}>
            {saving ? 'Setting up…' : (<span className="flex items-center gap-2"><LockClosedIcon className="w-4 h-4" /> Set password &amp; join</span>)}
          </button>
        </form>
      )}
    </>
  );
}
