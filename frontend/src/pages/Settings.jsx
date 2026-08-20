import { useState, useEffect, useRef } from 'react';
import {
  UserCircleIcon, FolderIcon, KeyIcon, CheckIcon, ExclamationTriangleIcon,
  DocumentTextIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, SparklesIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { authApi, projectsApi, orgTemplatesApi, selectedOrg } from '../api';
import PageHeader from '../components/PageHeader';
import OrgSwitcher from '../components/OrgSwitcher';
import Modal from '../components/Modal';
import { useConfirm } from '../components/ConfirmDialog';
import CoverReview, { COVERS } from '../components/CoverReview';

// Settings, in two halves: who you are, and the jobs you are on.
//
// It used to hold three unrelated things — organization-wide due-date defaults, a proposal memo
// template, and an about box — none of which were settings a person would come here looking for.
// The memo template lives on the Proposal Intake page where it is used; the due-date rules moved
// onto each project, where the specification that sets them actually lives; and the about box
// duplicated the version already in the sidebar.
//
// What is left is the two things that were missing. A person's own details had nowhere to live at
// all, and a project's details could not be changed after it was created — so a typo in a project
// number outlived the job.

const TABS = [
  { key: 'personal', label: 'Personal Information', icon: UserCircleIcon },
  { key: 'projects', label: 'Project Information', icon: FolderIcon },
  // Admin only: feeding a company's standard template changes what every project produces.
  { key: 'templates', label: 'Templates', icon: DocumentTextIcon, adminOnly: true },
];

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function Saved({ show, children = 'Saved' }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: '#047857' }}>
      <CheckIcon className="w-3.5 h-3.5" /> {children}
    </span>
  );
}

// --- Personal ----------------------------------------------------------------------------------

function PersonalTab() {
  const stored = authApi.user();
  const org = selectedOrg.get();
  const [form, setForm] = useState({
    name: '', email: '', company: '', phone: '', address: '',
  });
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Loaded from the server rather than from the stored session: the session was written at sign-in
  // and will not carry a field added since.
  useEffect(() => {
    authApi.me().then(({ user }) => setForm({
      name: user.name || '',
      email: user.email || '',
      // Prefilled from the organization, but their own to change — a consultant working across two
      // customers has a firm that is neither of them.
      company: user.company || org?.name || '',
      phone: user.phone || '',
      address: user.address || '',
    })).catch(() => {});
  }, []);

  const set = k => e => { setForm(f => ({ ...f, [k]: e.target.value })); setSaved(false); };
  const emailChanging = form.email.trim().toLowerCase() !== (stored?.email || '').toLowerCase();

  const save = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      await authApi.updateProfile({ ...form, current_password: currentPassword || undefined });
      setCurrentPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save your details.');
    } finally { setSaving(false); }
  };

  return (
    <div className="grid grid-cols-5 gap-6 items-start">
      <div className="col-span-3">
        <form className="card p-5 space-y-4" onSubmit={save}>
          <div className="flex items-center gap-2">
            <UserCircleIcon className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Your details</h2>
            <span className="ml-auto"><Saved show={saved} /></span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Naren Murali" />
            </Field>
            <Field label="Phone">
              <input className="input" value={form.phone} onChange={set('phone')} placeholder="Optional" />
            </Field>
          </div>

          <Field label="Company" hint="Prefilled from your organization. Change it if you work under your own firm.">
            <input className="input" value={form.company} onChange={set('company')} />
          </Field>

          <Field label="Address">
            <textarea className="input" rows={3} value={form.address} onChange={set('address')}
              placeholder="Street, city, state, ZIP" />
          </Field>

          <Field
            label="Email"
            hint={emailChanging
              ? 'This is the address you sign in with. Enter your current password below to change it.'
              : 'The address you sign in with.'}
          >
            <input className="input" type="email" value={form.email} onChange={set('email')} />
          </Field>

          {/* Only asked for when the sign-in address is actually being moved. Changing where an
              account can be reached is the one edit here that an unattended session should not be
              able to make on its own. */}
          {emailChanging && (
            <Field label="Current password *">
              <input className="input" type="password" value={currentPassword} autoComplete="current-password"
                onChange={e => setCurrentPassword(e.target.value)} />
            </Field>
          )}

          {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

          <button type="submit" className="btn-primary w-full justify-center"
            disabled={saving || (emailChanging && !currentPassword)}>
            {saving ? 'Saving…' : 'Save details'}
          </button>
        </form>
      </div>

      <div className="col-span-2">
        <ChangePassword />
      </div>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);          // { ok, text }

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) { setMsg({ ok: false, text: 'New password must be at least 8 characters.' }); return; }
    // Caught here rather than after the request: a mistyped confirmation is the common case, and
    // finding out from the server after your password has already changed is the worst version.
    if (next !== confirmed) { setMsg({ ok: false, text: 'The two new passwords do not match.' }); return; }
    setSaving(true);
    try {
      await authApi.changePassword({ current_password: current, new_password: next });
      setCurrent(''); setNext(''); setConfirmed('');
      setMsg({ ok: true, text: 'Password changed. Other devices will need to sign in again.' });
    } catch (err) {
      setMsg({ ok: false, text: err?.response?.data?.error || 'Could not change your password.' });
    } finally { setSaving(false); }
  };

  return (
    <form className="card p-5 space-y-3" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <KeyIcon className="w-4 h-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">Password</h2>
      </div>
      <Field label="Current password">
        <input className="input" type="password" value={current} autoComplete="current-password"
          onChange={e => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" hint="At least 8 characters.">
        <input className="input" type="password" value={next} autoComplete="new-password"
          onChange={e => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new password">
        <input className="input" type="password" value={confirmed} autoComplete="new-password"
          onChange={e => setConfirmed(e.target.value)} />
      </Field>
      {msg && <p className="text-xs" style={{ color: msg.ok ? '#047857' : '#b91c1c' }}>{msg.text}</p>}
      <button type="submit" className="btn-primary w-full justify-center"
        disabled={saving || !current || !next || !confirmed}>
        {saving ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

// --- Projects ------------------------------------------------------------------------------------

const PROJECT_TYPES = ['MEP', 'Electrical', 'Mechanical', 'Plumbing', 'General'];
const STATUSES = ['Active', 'On Hold', 'Closed'];
const DELIVERY_METHODS = [
  { key: 'CSP', blurb: 'Contractor bills directly. Lien release as backup.' },
  { key: 'CMAR', blurb: 'Subcontractor applications, and a subcontract behind each.' },
];

function ProjectEditor({ project, onSaved }) {
  const [form, setForm] = useState(project);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setForm(project); setSaved(false); setError(''); }, [project.id]);

  const set = k => e => { setForm(f => ({ ...f, [k]: e.target.value })); setSaved(false); };

  const save = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      await projectsApi.update(project.id, {
        ...form,
        contract_value: form.contract_value === '' ? null : form.contract_value,
        rfi_response_days: form.rfi_response_days === '' ? null : form.rfi_response_days,
        submittal_review_days: form.submittal_review_days === '' ? null : form.submittal_review_days,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save this project.');
    } finally { setSaving(false); }
  };

  return (
    <form className="card p-5 space-y-4" onSubmit={save}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-900 truncate">{project.project_name}</h2>
        <span className="ml-auto"><Saved show={saved} /></span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Project name *">
            <input className="input" required value={form.project_name || ''} onChange={set('project_name')} />
          </Field>
        </div>
        <Field label="Project number">
          <input className="input" value={form.project_number || ''} onChange={set('project_number')} />
        </Field>
        <Field label="Client / owner">
          <input className="input" value={form.client_name || ''} onChange={set('client_name')} />
        </Field>
        <Field label="Project type">
          <select className="input" value={form.project_type || 'MEP'}
            onChange={e => setForm(f => ({ ...f, project_type: e.target.value, project_type_other: '' }))}>
            {PROJECT_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        {form.project_type === 'General' && (
          <Field label="Specify type">
            <input className="input" value={form.project_type_other || ''} onChange={set('project_type_other')} />
          </Field>
        )}
        <Field label="Status">
          <select className="input" value={form.status || 'Active'} onChange={set('status')}>
            {STATUSES.map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Start date">
          <input className="input" type="date" value={form.start_date || ''} onChange={set('start_date')} />
        </Field>
        <Field label="Projected end date">
          <input className="input" type="date" value={form.projected_end_date || ''} onChange={set('projected_end_date')} />
        </Field>
        <Field label="Project manager">
          <input className="input" value={form.project_manager || ''} onChange={set('project_manager')} />
        </Field>
      </div>

      {/* The two windows the RFI and submittal logs measure "overdue" against. They come from the
          project's own specification, which is why they are here rather than set once for every
          job in the organization. */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
          A/E response windows
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="RFI response days" hint="Blank uses the default of 10.">
            <input className="input" type="number" min="1" max="365"
              value={form.rfi_response_days ?? ''} onChange={set('rfi_response_days')} placeholder="10" />
          </Field>
          <Field label="Submittal review days" hint="Blank uses the default of 14.">
            <input className="input" type="number" min="1" max="365"
              value={form.submittal_review_days ?? ''} onChange={set('submittal_review_days')} placeholder="14" />
          </Field>
        </div>
      </div>

      {/* Editable, but not by accident. Both of these change what a pay app review CHECKS on this
          job — the delivery method decides whether missing subcontractor paperwork is reported as
          a gap, and the contract sum is what billing is measured against. */}
      <div className="rounded-xl p-3 space-y-4" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
        <div className="flex items-start gap-2">
          <ExclamationTriangleIcon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#a16207' }} />
          <p className="text-[11px]" style={{ color: '#854d0e' }}>
            These two change what future pay app reviews check on this job. Changing them does not
            alter a review already produced.
          </p>
        </div>
        <Field label="Delivery method">
          <div className="flex gap-2">
            {DELIVERY_METHODS.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => { setForm(f => ({ ...f, delivery_method: f.delivery_method === m.key ? '' : m.key })); setSaved(false); }}
                className="flex-1 text-left rounded-xl px-3 py-2 transition"
                style={{
                  border: form.delivery_method === m.key ? '1.5px solid #0f172a' : '1px solid #e2e8f0',
                  background: form.delivery_method === m.key ? '#fff' : '#fffdf5',
                }}
              >
                <span className="block text-xs font-semibold text-gray-900">{m.key}</span>
                <span className="block text-[11px] text-gray-500 mt-0.5 leading-snug">{m.blurb}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Contract value ($)">
          <input className="input" type="number" step="0.01" value={form.contract_value ?? ''}
            onChange={set('contract_value')} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea className="input" rows={3} value={form.notes || ''} onChange={set('notes')} />
      </Field>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}
      <button type="submit" className="btn-primary w-full justify-center" disabled={saving}>
        {saving ? 'Saving…' : 'Save project'}
      </button>
    </form>
  );
}

function ProjectsTab() {
  const [projects, setProjects] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const load = () => projectsApi.list()
    .then((list) => {
      setProjects(list);
      setSelectedId(id => (id && list.some(p => p.id === id) ? id : list[0]?.id ?? null));
    })
    .catch(() => setProjects([]));
  useEffect(() => { load(); }, []);

  if (projects == null) return <p className="text-sm text-gray-400">Loading…</p>;
  if (!projects.length) {
    return (
      <div className="card p-6 max-w-xl">
        <p className="text-sm text-gray-600">
          You are not on any projects yet. Once you are added to one, its details can be edited here.
        </p>
      </div>
    );
  }

  const selected = projects.find(p => p.id === selectedId);

  return (
    <div className="grid grid-cols-5 gap-6 items-start">
      <div className="col-span-2 card overflow-hidden">
        <div className="px-5 py-3" style={{ borderBottom: '1px solid #f3f4f6', background: '#fafbfc' }}>
          <h2 className="text-sm font-semibold text-gray-900">
            Your projects <span className="text-gray-400 font-normal">· {projects.length}</span>
          </h2>
        </div>
        <div className="divide-y" style={{ borderColor: '#f3f4f6' }}>
          {projects.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className="w-full text-left px-5 py-3 transition"
              style={{ background: p.id === selectedId ? '#f8fafc' : '#fff' }}
            >
              <p className="text-[13px] font-medium text-gray-900 truncate">{p.project_name}</p>
              <p className="text-[11px] text-gray-400 truncate">
                {[p.project_number, p.client_name, p.delivery_method, p.status]
                  .filter(Boolean).join(' · ') || 'No details set'}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="col-span-3">
        {selected && <ProjectEditor key={selected.id} project={selected} onSaved={load} />}
      </div>
    </div>
  );
}

// --- The company's own Word documents ---------------------------------------------------------
//
// One memo cover and one progress report per organization, fed once. They used to live only on the
// project, which meant a company with fifteen jobs uploaded the same two files fifteen times and
// confirmed the same mapping fifteen times. A project can still upload its own on its Shared
// Documents when a particular job needs a different format, and that one wins.

function TemplateCard({ template, onChanged, onReview }) {
  const cover = COVERS[template.doc_type] || {};
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, confirmDialog] = useConfirm();
  const fileRef = useRef();

  const choose = async file => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Straight into the confirmation: the mapping is the thing the admin has to look at, and a
      // template uploaded but never confirmed does nothing at all.
      onReview(await orgTemplatesApi.upload(template.doc_type, fd));
      onChanged();
    } catch (err) {
      setError(err?.friendlyMessage || err?.response?.data?.error || 'Could not read that document.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove this ${cover.noun}?`,
      message: `${template.file_name} is deleted, and every project without one of its own goes back `
        + `to Coaster's built-in ${cover.thing}. You can upload it again at any time.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await orgTemplatesApi.delete(template.doc_type);
    onChanged();
  };

  return (
    <div className="card p-5 space-y-3">
      {confirmDialog}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{cover.label || template.doc_type}</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {cover.blurb} Filled in by {cover.filledBy}.
          </p>
        </div>
        {template.onFile && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0"
            style={template.confirmed
              ? { background: '#f0fdf4', color: '#15803d' }
              : { background: '#fff7ed', color: '#c2410c' }}>
            {template.confirmed ? 'IN USE' : 'NEEDS REVIEW'}
          </span>
        )}
      </div>

      {template.onFile ? (
        <div className="p-3 rounded-xl" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
          <p className="text-[13px] font-medium text-gray-900 truncate">{template.file_name}</p>
          <p className="text-[11px] mt-0.5" style={{ color: template.confirmed ? '#15803d' : '#c2410c' }}>
            {template.confirmed
              ? `${template.replacements.length} field${template.replacements.length === 1 ? '' : 's'} filled in on every ${cover.thing}.`
              : `Coaster found ${template.replacements.length} variable part(s). Confirm them before it is used.`}
          </p>
        </div>
      ) : (
        <p className="text-[12px] text-gray-500">
          Nothing on file. Every project uses Coaster's built-in {cover.thing} until you upload one.
        </p>
      )}

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      <input ref={fileRef} type="file" accept=".docx" className="hidden"
        onChange={e => { choose(e.target.files?.[0]); e.target.value = ''; }} />

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className="btn-primary px-3 py-1.5 text-xs"
          onClick={() => fileRef.current.click()} disabled={busy}>
          {busy
            ? <><SparklesIcon className="w-4 h-4 animate-pulse" /> Reading…</>
            : <><ArrowUpTrayIcon className="w-4 h-4" /> {template.onFile ? 'Replace' : 'Upload'}</>}
        </button>
        {template.onFile && (
          <>
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => onReview(template)}>
              <SparklesIcon className="w-4 h-4" /> {template.confirmed ? 'Review mapping' : 'Confirm'}
            </button>
            {/* The document with its placeholders written in — what they keep, and edit, so the
                template Coaster fills is never a mystery. */}
            <a className="btn-secondary px-3 py-1.5 text-xs"
              href={orgTemplatesApi.templateUrl(template.doc_type)} target="_blank" rel="noreferrer">
              <ArrowDownTrayIcon className="w-4 h-4" /> Download
            </a>
            <button type="button" className="btn-danger px-3 py-1.5 text-xs" onClick={remove}>
              <TrashIcon className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [reviewing, setReviewing] = useState(null);
  const [error, setError] = useState('');

  const load = () => orgTemplatesApi.list().then(setTemplates)
    .catch(err => setError(err?.response?.data?.error || 'Could not load your templates.'));
  useEffect(() => { load(); }, []);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="p-4 rounded-xl text-[12px] leading-relaxed"
        style={{ background: '#fff1f2', border: '1px solid #fecdd3', color: '#9f1239' }}>
        These are your company's own Word documents. Upload each one once and Coaster produces
        <span className="font-semibold"> your document</span> — your fonts, your letterhead, your
        signature block — on every project, instead of a version of it redrawn by this app. A
        project that needs a different format can still upload its own on its Shared Documents,
        and that one is used for that project.
      </div>

      {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}

      {templates.map(t => (
        <TemplateCard key={t.doc_type} template={t} onChanged={load} onReview={setReviewing} />
      ))}

      {reviewing && (
        <Modal title="What Coaster will fill in" onClose={() => setReviewing(null)} size="lg">
          <CoverReview
            docType={reviewing.doc_type}
            fileName={reviewing.file_name}
            terms={reviewing.terms || reviewing}
            save={terms => orgTemplatesApi.update(reviewing.doc_type, { terms })}
            onDone={() => { setReviewing(null); load(); }}
            onCancel={() => setReviewing(null)} />
        </Modal>
      )}
    </div>
  );
}

// --- The page --------------------------------------------------------------------------------------

export default function Settings() {
  const [tab, setTab] = useState('personal');
  // Feeding the company's standard templates is an administrative act — it changes what every
  // project in the organization produces. The backend enforces this; hiding the tab only saves a
  // member from a button that would answer 403.
  const isAdmin = !!selectedOrg.get()?.is_admin;
  const tabs = TABS.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="p-8">
      <PageHeader
        title="Settings"
        subtitle="Your details, and the projects you are working on"
        actions={<OrgSwitcher />}
      />

      <div className="flex gap-1 mb-6" style={{ borderBottom: '1px solid #e8edf2' }}>
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium transition"
            style={{
              color: tab === key ? '#0f172a' : '#94a3b8',
              borderBottom: `2px solid ${tab === key ? '#f97316' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'personal' && <PersonalTab />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'templates' && isAdmin && <TemplatesTab />}
    </div>
  );
}
