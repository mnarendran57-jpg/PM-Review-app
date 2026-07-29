import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuildingOffice2Icon, ArrowRightIcon, ArrowRightOnRectangleIcon } from '@heroicons/react/24/outline';
import { authApi, selectedOrg } from '../api';

// Step one after signing in. A user account isn't tied to an organization — a consultant
// may work for several — so we ask which one they're working in. The list comes from the
// server, which only returns organizations they actually have a membership in (directly,
// or through being on one of its projects).
export default function OrgSelect() {
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState(null);
  const [user, setUser] = useState(authApi.user());
  const [error, setError] = useState('');

  // Skipping straight past a single organization is only right on a fresh sign-in. If one
  // is already selected the user came here deliberately to switch, and auto-selecting
  // would bounce them back to where they started — making the switcher look broken.
  const [alreadyChosen] = useState(() => !!selectedOrg.get());
  const current = selectedOrg.get();

  useEffect(() => {
    authApi.me()
      .then(({ user: u, organizations }) => {
        setUser(u);
        setOrgs(organizations || []);
        if (!alreadyChosen && (organizations || []).length === 1) choose(organizations[0]);
      })
      .catch(e => {
        setOrgs([]);
        setError(e.friendlyMessage || 'Could not load your organizations.');
      });
  }, []);

  const choose = org => {
    // is_admin is kept alongside so the app can hide administrative controls without
    // another round trip; the server re-checks it on every write regardless.
    selectedOrg.set({ id: org.id, name: org.name, is_admin: !!org.is_admin });
    navigate('/programs');
  };

  const logout = () => { authApi.logout(); navigate('/login', { replace: true }); };

  return (
    <div className="min-h-screen relative" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <div className="relative max-w-5xl mx-auto px-8 py-12" style={{ zIndex: 1 }}>
        <div className="flex items-start justify-between mb-10 animate-fade-up">
          <div className="flex items-center gap-3">
            <img src="/coaster-logo.svg" alt="Coaster" className="w-11 h-11 rounded-xl" />
            <div>
              <h1 className="text-[26px] font-extrabold tracking-tight text-gray-900 leading-tight">Coaster</h1>
              <p className="text-sm text-gray-500">Signed in as {user?.name || user?.email}</p>
            </div>
          </div>
          <button className="btn-secondary" onClick={logout}>
            <ArrowRightOnRectangleIcon className="w-4 h-4" /> Sign out
          </button>
        </div>

        <div className="mb-6 animate-fade-up">
          <h2 className="text-lg font-bold text-gray-900">Select an organization</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {orgs && orgs.length === 1
              ? "You belong to one organization — there's nothing else to switch to."
              : "Choose which organization you're working in."}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
            {error}
          </div>
        )}

        {orgs == null ? (
          <p className="text-gray-400">Loading…</p>
        ) : orgs.length === 0 ? (
          <div className="card p-12 text-center animate-fade-up">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3" style={{ background: 'rgba(37,99,235,0.08)' }}>
              <BuildingOffice2Icon className="w-7 h-7" style={{ color: '#2563eb' }} />
            </div>
            <p className="text-lg font-bold text-gray-900">No organizations yet</p>
            <p className="text-sm text-gray-500 mt-1">
              You haven't been added to one. Ask an administrator to add you, or contact support.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6">
            {orgs.map((o, i) => (
              <button key={o.id} onClick={() => choose(o)}
                className={`card card-hover group cursor-pointer p-6 flex flex-col text-left animate-fade-up stagger-${(i % 4) + 1}`}>
                <div className="flex items-start justify-between mb-4">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                    style={{ background: 'linear-gradient(135deg, #f97316, #2563eb)', boxShadow: '0 8px 24px rgba(37,99,235,0.22)' }}>
                    <BuildingOffice2Icon className="w-6 h-6 text-white" />
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {current?.id === o.id && (
                      <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
                        style={{ background: 'rgba(37,99,235,0.1)', color: '#1d4ed8' }}>Current</span>
                    )}
                    {!!o.is_admin && (
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                        style={{ background: '#f1f5f9', color: '#64748b' }}>Admin</span>
                    )}
                  </div>
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1 leading-snug flex-1">{o.name}</h3>
                <span className="flex items-center gap-1 text-sm font-semibold text-blue-600 mt-4">
                  Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
