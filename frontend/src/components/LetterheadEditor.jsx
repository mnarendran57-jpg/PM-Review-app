import { useState, useEffect, useRef } from 'react';
import { PhotoIcon, TrashIcon, CheckIcon } from '@heroicons/react/24/outline';
import { brandingApi } from '../api';

// The letterhead that prints on this organization's memos: a logo and an address block.
// It belongs to the organization, so each customer's memos come out on their own paper —
// previously a single logo file and whichever address sorted first were used for everyone.
export default function LetterheadEditor({ onChanged }) {
  const [branding, setBranding] = useState(null);
  const [address, setAddress] = useState('');
  const [logoSrc, setLogoSrc] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef();

  const load = () => brandingApi.get().then(b => {
    setBranding(b);
    setAddress(b.companyName || '');
    setLogoSrc(b.hasLogo ? brandingApi.logoUrl() : null);
  }).catch(() => setBranding({ companyName: null, hasLogo: false }));

  useEffect(() => { load(); }, []);

  const saveAddress = async () => {
    setBusy(true); setError('');
    try {
      await brandingApi.setCompanyName(address);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the letterhead.');
    } finally { setBusy(false); }
  };

  const uploadLogo = async file => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('logo', file);
      await brandingApi.uploadLogo(fd);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload that logo.');
    } finally { setBusy(false); }
  };

  const removeLogo = async () => {
    setBusy(true);
    try { await brandingApi.removeLogo(); await load(); onChanged?.(); }
    finally { setBusy(false); }
  };

  if (!branding) return <p className="text-xs text-gray-400">Loading letterhead…</p>;

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Company logo</label>
        <div className="flex items-start gap-3">
          <div className="w-32 h-20 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden"
            style={{ background: '#fafbfc', border: '1px dashed #e2e8f0' }}>
            {logoSrc
              ? <img src={logoSrc} alt="Company logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              : <PhotoIcon className="w-6 h-6 text-gray-300" />}
          </div>
          <div className="space-y-1.5">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden"
              onChange={e => uploadLogo(e.target.files?.[0])} />
            <button className="btn-secondary text-[12px] py-1" onClick={() => fileRef.current?.click()} disabled={busy}>
              {logoSrc ? 'Replace logo' : 'Upload logo'}
            </button>
            {logoSrc && (
              <button className="btn-secondary text-[12px] py-1 ml-2" onClick={removeLogo} disabled={busy}>
                <TrashIcon className="w-3.5 h-3.5" /> Remove
              </button>
            )}
            <p className="text-[10px] text-gray-400 leading-tight max-w-[220px]">
              JPG or PNG. Prints top-left on the memo at about 2 inches wide.
            </p>
          </div>
        </div>
      </div>

      <div>
        <label className="label">Address block</label>
        <textarea className="input font-mono text-[11px]" rows={4} value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder={'Your Company Inc\n123 Street\nCity, State 00000\nwww.yourcompany.com'} />
        <p className="text-[10px] text-gray-400 mt-1">
          One line each. Prints right-aligned opposite the logo. Leave blank for no address.
        </p>
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <button className="btn-primary text-[12px] py-1.5" onClick={saveAddress} disabled={busy}>
        {saved ? <><CheckIcon className="w-4 h-4" /> Saved</> : 'Save letterhead'}
      </button>
    </div>
  );
}
