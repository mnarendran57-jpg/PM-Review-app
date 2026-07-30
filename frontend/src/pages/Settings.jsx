import { useState, useEffect } from 'react';
import { CheckIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import { settingsApi } from '../api';
import PageHeader from '../components/PageHeader';
import MemoTemplateEditor from '../components/MemoTemplateEditor';

export default function Settings() {
  const [settings, setSettings] = useState({ rfi_response_days: '10', submittal_review_days: '14' });
  const [saved, setSaved] = useState(false);

  useEffect(() => { settingsApi.get().then(setSettings); }, []);

  const saveSettings = async () => {
    await settingsApi.update(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="p-8">
      <PageHeader title="Settings" subtitle="Default configuration and document templates" />

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
