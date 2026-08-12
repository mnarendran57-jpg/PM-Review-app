import { useState, useEffect } from 'react';
import { CheckIcon, Cog6ToothIcon, KeyIcon } from '@heroicons/react/24/outline';
import { settingsApi, authApi } from '../api';
import PageHeader from '../components/PageHeader';
import MemoTemplateEditor from '../components/MemoTemplateEditor';
import OrgSwitcher from '../components/OrgSwitcher';

// Your own password.
//
// This used to sit on the Team page, which is about other people — a page that manages a customer's
// staff is the wrong place to keep a personal control, and having it there was most of the reason
// that page did three unrelated jobs. Changing your own password is a setting, so it lives here.
function ChangeMyPassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);           // { ok, text }

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) { setMsg({ ok: false, text: 'New password must be at least 8 characters.' }); return; }
    setSaving(true);
    try {
      await authApi.changePassword({ current_password: current, new_password: next });
      setCurrent(''); setNext('');
      setMsg({ ok: true, text: 'Password changed. Other devices will need to sign in again.' });
    } catch (err) {
      setMsg({ ok: false, text: err?.response?.data?.error || 'Could not change your password.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-2"
        style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
        <KeyIcon className="w-4 h-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">Your password</h2>
      </div>
      <form className="px-5 py-4 space-y-3" onSubmit={submit}>
        <div>
          <label className="label">Current password</label>
          <input className="input" type="password" value={current} autoComplete="current-password"
            onChange={e => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" value={next} autoComplete="new-password"
            onChange={e => setNext(e.target.value)} />
          <p className="text-[11px] text-gray-400 mt-1">At least 8 characters.</p>
        </div>
        {msg && (
          <p className="text-xs" style={{ color: msg.ok ? '#047857' : '#b91c1c' }}>{msg.text}</p>
        )}
        <button type="submit" className="btn-primary w-full justify-center" disabled={saving || !current || !next}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState({ rfi_response_days: '10', submittal_review_days: '14' });
  const [saved, setSaved] = useState(false);

  useEffect(() => { settingsApi.get().then(setSettings).catch(() => {}); }, []);

  const saveSettings = async () => {
    await settingsApi.update(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="p-8">
      <PageHeader
        title="Settings"
        subtitle="Default configuration and document templates"
        actions={<OrgSwitcher />}
      />

      {/* People are managed in one place only — the Team tab. A second directory here
          duplicated it without granting any access, which was purely confusing. */}
      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 flex items-center gap-2"
              style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
              <Cog6ToothIcon className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Default Due Date Rules</h2>
            </div>
            <div className="p-5 space-y-5">
              <div>
                <label className="label">RFI Response Days</label>
                <div className="flex items-center gap-3">
                  <input
                    className="input w-24"
                    type="number"
                    min="1"
                    value={settings.rfi_response_days}
                    onChange={e => setSettings(s => ({ ...s, rfi_response_days: e.target.value }))}
                  />
                  <span className="text-sm text-gray-500">days from submission</span>
                </div>
              </div>
              <div>
                <label className="label">Submittal Review Days</label>
                <div className="flex items-center gap-3">
                  <input
                    className="input w-24"
                    type="number"
                    min="1"
                    value={settings.submittal_review_days}
                    onChange={e => setSettings(s => ({ ...s, submittal_review_days: e.target.value }))}
                  />
                  <span className="text-sm text-gray-500">days from forwarded date</span>
                </div>
              </div>
              <button
                className="btn-primary w-full justify-center"
                onClick={saveSettings}
                style={saved ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
              >
                {saved ? (
                  <span className="flex items-center gap-2">
                    <CheckIcon className="w-4 h-4" /> Saved
                  </span>
                ) : 'Save Settings'}
              </button>
            </div>
          </div>

          <ChangeMyPassword />

          {/* About card */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4"
              style={{ background: 'linear-gradient(135deg, #0d1117 0%, #1e293b 100%)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Coaster
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
                  v1.0
                </span>
              </div>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>Coaster · MEP Construction Management</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-gray-500 leading-relaxed">
                Internal project management tool for Coaster. Data stored locally in SQLite.
                AI document reviews powered by the Anthropic Claude API.
              </p>
              <p className="text-xs text-gray-400 mt-3 pt-3" style={{ borderTop: '1px solid #f3f4f6' }}>
                Internal Use Only
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <MemoTemplateEditor />
      </div>
    </div>
  );
}
