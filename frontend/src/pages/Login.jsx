import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { authApi } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await authApi.login(email, password);
      // Which client to work on is chosen next.
      navigate('/organizations', { replace: true });
    } catch (err) {
      if (err.response) {
        setError(err.response.data?.error || 'Could not log in. Try again.');
      } else {
        setError(err.friendlyMessage || 'Cannot reach the server. Make sure the backend is running, then try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="card p-8 w-full max-w-sm animate-fade-up" style={{ position: 'relative', zIndex: 1 }}>
        <div className="flex items-center gap-3 mb-6">
          <img src="/coaster-logo.svg" alt="Coaster" className="w-10 h-10 rounded-xl flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-gray-900 leading-tight">Coaster</p>
          </div>
        </div>

        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Sign in</h1>
        <p className="text-sm text-gray-400 mb-6">Use the email and password set up for you.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              autoFocus
              autoComplete="username"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary w-full justify-center" disabled={loading || !email || !password}>
            {loading ? 'Signing in…' : (
              <span className="flex items-center gap-2"><LockClosedIcon className="w-4 h-4" /> Sign In</span>
            )}
          </button>
          <Link to="/forgot-password" className="block text-center text-xs text-gray-400 hover:text-gray-600">
            Forgot your password?
          </Link>
        </form>
      </div>
    </div>
  );
}
