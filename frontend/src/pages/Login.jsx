import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { authApi } from '../api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { token } = await authApi.login(password);
      authApi.setToken(token);
      navigate('/home', { replace: true });
    } catch (err) {
      if (err.response) {
        setError(err.response.data?.error || 'Could not log in. Try again.');
      } else {
        setError('Cannot reach the server. Make sure the backend is running, then try again.');
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
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)', boxShadow: '0 4px 14px rgba(245,158,11,0.45)' }}>
            <span className="text-white font-black text-base tracking-tight">O</span>
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900 leading-tight">Olivier Inc.</p>
            <p className="text-[10px] font-medium tracking-widest uppercase text-gray-400">PM Review</p>
          </div>
        </div>

        <h1 className="text-xl font-extrabold text-gray-900 mb-1 tracking-tight">Team Login</h1>
        <p className="text-sm text-gray-400 mb-6">Enter the shared team password to continue.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary w-full justify-center" disabled={loading || !password}>
            {loading ? 'Logging in…' : (
              <span className="flex items-center gap-2"><LockClosedIcon className="w-4 h-4" /> Log In</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
