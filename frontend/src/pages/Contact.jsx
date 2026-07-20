import { useState } from 'react';
import { EnvelopeIcon, PhoneIcon, MapPinIcon, PaperAirplaneIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

// Sample "Contact Us" page. The form is a front-end placeholder — it doesn't send
// anywhere yet; wire it to a mailbox or ticketing endpoint when that's decided.
export default function Contact() {
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const details = [
    { icon: EnvelopeIcon, label: 'Email', value: 'support@pm-ai.app' },
    { icon: PhoneIcon, label: 'Phone', value: '(281) 000-0000' },
    { icon: MapPinIcon, label: 'Office', value: 'Houston, Texas' },
  ];

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-8 animate-fade-up">
        <h1 className="text-[30px] font-extrabold tracking-tight text-gray-900">Contact Us</h1>
        <p className="text-gray-500 mt-1 text-[15px]">Questions about a review, or need help with the app? Reach out.</p>
      </div>

      <div className="grid grid-cols-3 gap-6 items-start">
        <div className="col-span-2 card p-6 animate-fade-up">
          {sent ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <CheckCircleIcon className="w-12 h-12" style={{ color: '#059669' }} />
              <p className="text-lg font-bold text-gray-900">Thanks — we'll be in touch</p>
              <p className="text-sm text-gray-500">This is a sample form, so nothing was actually sent.</p>
              <button className="btn-secondary mt-2" onClick={() => { setSent(false); setForm({ name: '', email: '', message: '' }); }}>
                Send another
              </button>
            </div>
          ) : (
            <form onSubmit={e => { e.preventDefault(); setSent(true); }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Your Name</label>
                  <input className="input" required value={form.name} onChange={set('name')} />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" type="email" required value={form.email} onChange={set('email')} />
                </div>
              </div>
              <div>
                <label className="label">Message</label>
                <textarea className="input" rows={6} required value={form.message} onChange={set('message')}
                  placeholder="How can we help?" />
              </div>
              <div className="flex justify-end">
                <button type="submit" className="btn-primary flex items-center gap-2">
                  <PaperAirplaneIcon className="w-4 h-4" /> Send Message
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="card p-6 space-y-5 animate-fade-up stagger-1">
          {details.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(99,102,241,0.08)' }}>
                <Icon className="w-5 h-5" style={{ color: '#6366f1' }} />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
                <p className="text-sm text-gray-800 whitespace-pre-line">{value}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
