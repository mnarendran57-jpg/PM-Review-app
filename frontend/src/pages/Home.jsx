import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PlusIcon, FolderIcon, ArrowRightIcon, DocumentTextIcon, EllipsisVerticalIcon,
  ArchiveBoxIcon, ArchiveBoxArrowDownIcon, TrashIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { projectsApi, payAppReviewApi, selectedOrg, selectedProgram } from '../api';
import Modal from '../components/Modal';
import FileDrop from '../components/FileDrop';

function AddProjectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [contract, setContract] = useState(null);
  const [delivery, setDelivery] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Give the project a name first.'); return; }
    setError(''); setSaving(true);
    try {
      setStatus('Creating project…');
      const program = selectedProgram.get();
      const { id } = await projectsApi.create({
        project_name: name.trim(),
        program_id: program?.id || null,
        client_name: client.trim() || null,
        delivery_method: delivery || null,
      });
      if (contract) {
        // Uploading is fast whatever the size; the reading happens afterwards, in the background.
        // It used to be read here, which meant a long agreement held this dialog open until the
        // request timed out — and the project appeared to fail when it had already been created.
        setStatus('Uploading the contract…');
        const fd = new FormData();
        fd.append('contract_file', contract);
        try {
          await payAppReviewApi.uploadContract(id, fd);
        } catch {
          // The project exists either way. A contract that fails to upload can be added again
          // from the project's Overview page.
          setStatus('Project created — the contract could not be uploaded and can be added inside the project.');
        }
      }
      onCreated(id);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not create the project.');
      setSaving(false);
    }
  };

  return (
    <Modal title="Add a Project" onClose={saving ? () => {} : onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Project Name *</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. HCC Central Plant Upgrade"
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        </div>
        <div>
          <label className="label">Client / Owner (optional)</label>
          <input className="input" value={client} onChange={e => setClient(e.target.value)}
            placeholder="e.g. Houston Community College" />
        </div>
        {/* How the job is procured. Asked once, here, because it is a property of the job rather
            than of any one pay application — and it decides what a complete pay application
            package looks like, so a review told the wrong one reports paperwork missing that was
            never going to exist. */}
        <div>
          <label className="label">Delivery Method (optional)</label>
          <div className="flex gap-2">
            {[['CSP', 'Contractor bills directly. Lien release as backup.'],
              ['CMAR', 'Subcontractor applications, and a subcontract behind each.']].map(([key, blurb]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDelivery(d => (d === key ? '' : key))}
                  className="flex-1 text-left rounded-xl px-3 py-2 transition"
                  style={{
                    border: delivery === key ? '1.5px solid #0f172a' : '1px solid #e2e8f0',
                    background: delivery === key ? '#f8fafc' : '#fff',
                  }}
                >
                  <span className="block text-xs font-semibold text-gray-900">{key}</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5 leading-snug">{blurb}</span>
                </button>
              ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            Changeable later in the project's settings. Without it a pay app review cannot tell
            missing subcontractor paperwork from a job that never has any.
          </p>
        </div>
        <div>
          <FileDrop file={contract} onChange={setContract} label="Executed Contract (optional — shared across all tools)" />
          <p className="text-[11px] text-gray-400 mt-1.5">
            Upload it once here and every tool in this project reads from it — no need to attach it again per review.
            Any size: it is read in the background after upload, so a long agreement never holds
            this up. You can add or replace it later from the project's Overview page.
          </p>
        </div>

        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        {saving && status && <p className="text-sm text-gray-500">{status}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Working…' : 'Create Project'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// What a delete would cost, shown before it can happen.
//
// The dialog is not a formality. Seventeen tables reference a project and the database treats them
// two ways — some rows are destroyed, the rest survive but stop belonging to anything — and nobody
// can be expected to know which is which. So the server is asked, and the answer is printed.
//
// Typing the name is the second guard. Projects are deleted from a grid of cards that look alike,
// and typing it is the difference between meaning THIS one and the one beside it.
function DeleteProjectModal({ project, onClose, onDeleted }) {
  const [preview, setPreview] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    projectsApi.deletionPreview(project.id)
      .then(setPreview)
      .catch(() => setError('What this would delete could not be worked out. Nothing has been changed.'));
  }, [project.id]);

  const matches = typed.trim() === String(project.project_name || '').trim();

  const run = async () => {
    setBusy(true); setError('');
    try {
      onDeleted(await projectsApi.delete(project.id, typed.trim()));
    } catch (err) {
      setError(err.response?.data?.error || 'The project could not be deleted.');
      setBusy(false);
    }
  };

  const total = rows => rows.reduce((n, r) => n + r.count, 0);

  return (
    <Modal onClose={busy ? undefined : onClose} title="Delete this project">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-xl"
          style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#b91c1c' }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: '#b91c1c' }}>
              This cannot be undone.
            </p>
            <p className="text-[12px] text-gray-700 mt-0.5 leading-relaxed">
              If you only want {project.project_name} out of the way, close this and archive it
              instead — that hides it and keeps everything.
            </p>
          </div>
        </div>

        {preview == null && !error && <p className="text-sm text-gray-400">Working out what this would affect…</p>}

        {preview && (
          <>
            {preview.destroyed.length > 0 ? (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: '#b91c1c' }}>
                  Permanently destroyed ({total(preview.destroyed)} records)
                </p>
                <ul className="space-y-1">
                  {preview.destroyed.map(d => (
                    <li key={d.table} className="text-[13px] text-gray-800 flex justify-between gap-4">
                      <span>{d.label}</span>
                      <span className="font-semibold flex-shrink-0">{d.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[13px]" style={{ color: '#047857' }}>
                Nothing attached to this project would be destroyed.
              </p>
            )}

            {preview.orphaned.length > 0 && (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">
                  Kept, but no longer attached to any project ({total(preview.orphaned)} records)
                </p>
                <ul className="space-y-1">
                  {preview.orphaned.map(d => (
                    <li key={d.table} className="text-[13px] text-gray-600 flex justify-between gap-4">
                      <span>{d.label}</span>
                      <span className="font-semibold flex-shrink-0">{d.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.fileCount > 0 && (
              <p className="text-[12px] text-gray-500">
                {preview.fileCount} uploaded file{preview.fileCount === 1 ? '' : 's'} will also be
                removed from storage.
              </p>
            )}

            <div>
              {/* The name is deliberately NOT inside .label, which applies `uppercase`. A project
                  called "trial" rendered as "TRIAL", and a user typing what they were shown would
                  be refused by a comparison that is correctly case-sensitive. */}
              <label className="label">Type the project name to confirm</label>
              <p className="text-[13px] mb-1.5 font-mono font-semibold text-gray-900 select-all">
                {project.project_name}
              </p>
              <input className="input" value={typed} autoFocus disabled={busy}
                onChange={e => setTyped(e.target.value)} />
              {typed && !matches && (
                <p className="text-[11px] mt-1" style={{ color: '#b45309' }}>
                  That does not match yet — it is case-sensitive.
                </p>
              )}
            </div>
          </>
        )}

        {error && (
          <div className="p-3 rounded-xl text-sm"
            style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={run} disabled={!matches || busy || !preview}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProjectCard({ project, index, onOpen, onArchive, onDelete, canManage }) {
  const activity = [];
  if (project.open_rfis) activity.push(`${project.open_rfis} open RFIs`);
  if (project.pay_apps_under_review) activity.push(`${project.pay_apps_under_review} pay apps in review`);
  const [menu, setMenu] = useState(false);
  const archived = project.status === 'Archived';

  // The menu sits ON the card rather than inside it: the card is a button, and a button inside a
  // button is invalid markup that browsers resolve by dropping one of them.
  return (
    <div className={`relative animate-fade-up stagger-${(index % 6) + 1}`}>
    <button
      onClick={onOpen}
      className="card card-hover group cursor-pointer p-6 flex flex-col text-left w-full"
      style={{ opacity: archived ? 0.6 : 1 }}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{
            background: archived ? 'linear-gradient(135deg, #94a3b8, #64748b)' : 'linear-gradient(135deg, #2563eb, #3b82f6)',
            boxShadow: archived ? 'none' : '0 8px 24px rgba(37,99,235,0.28)',
          }}>
          <FolderIcon className="w-6 h-6 text-white" />
        </div>
        {project.status && (
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${canManage ? 'mr-7' : ''}`}
            style={archived
              ? { background: 'rgba(100,116,139,0.12)', color: '#475569' }
              : { background: 'rgba(37,99,235,0.08)', color: '#1d4ed8' }}>{project.status}</span>
        )}
      </div>
      <h3 className="text-lg font-bold text-gray-900 mb-1 leading-snug">{project.project_name}</h3>
      <p className="text-sm text-gray-500 flex-1">{project.client_name || 'No client set'}</p>
      <div className="flex items-center justify-between mt-5">
        <span className="text-[12px] text-gray-400">{activity.length ? activity.join(' · ') : 'No open items'}</span>
        <span className="flex items-center gap-1 text-sm font-semibold text-blue-600">
          Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </span>
      </div>
    </button>

    {canManage && (
      <div className="absolute top-5 right-4">
        <button
          className="p-1 rounded-lg hover:bg-gray-100 transition-colors"
          title="Project options"
          onClick={e => { e.stopPropagation(); setMenu(v => !v); }}
        >
          <EllipsisVerticalIcon className="w-5 h-5 text-gray-400" />
        </button>

        {menu && (
          <>
            {/* Clicking anywhere else closes it, including on another card's menu. */}
            <div className="fixed inset-0 z-10" onClick={e => { e.stopPropagation(); setMenu(false); }} />
            <div className="absolute right-0 mt-1 w-56 rounded-xl bg-white shadow-lg z-20 py-1"
              style={{ border: '1px solid #e5e7eb' }}>
              <button
                className="w-full text-left px-3 py-2 text-[13px] text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                onClick={e => { e.stopPropagation(); setMenu(false); onArchive(project, !archived); }}
              >
                {archived
                  ? <><ArchiveBoxArrowDownIcon className="w-4 h-4" /> Restore to Active</>
                  : <><ArchiveBoxIcon className="w-4 h-4" /> Archive — hides it, keeps everything</>}
              </button>
              <div style={{ borderTop: '1px solid #f1f5f9' }} className="my-1" />
              <button
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-red-50 flex items-center gap-2"
                style={{ color: '#b91c1c' }}
                onClick={e => { e.stopPropagation(); setMenu(false); onDelete(project); }}
              >
                <TrashIcon className="w-4 h-4" /> Delete permanently…
              </button>
            </div>
          </>
        )}
      </div>
    )}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState('');

  const org = selectedOrg.get();
  const program = selectedProgram.get();
  // Archiving and deleting are org-admin actions, matching what the server will allow. Showing the
  // menu to somebody the API would refuse is just a way of promising something and then failing.
  const canManage = !!org?.is_admin;

  // Only this program's projects, and only the ones this user may see — the server applies
  // the access rules, so an ordinary member gets just the projects they're a member of.
  // Archived ones are left out unless asked for.
  const load = () => projectsApi.list({
    ...(program ? { program_id: program.id } : {}),
    ...(showArchived ? { include_archived: 'true' } : {}),
  }).then(setProjects).catch(() => setProjects([]));
  useEffect(() => { load(); }, [program?.id, showArchived]);

  const archive = async (project, archived) => {
    try {
      await projectsApi.archive(project.id, archived);
      setNotice(archived
        ? `${project.project_name} archived. Turn on "Show archived" to bring it back.`
        : `${project.project_name} restored.`);
      load();
    } catch (err) {
      setNotice(err.response?.data?.error || 'That could not be changed.');
    }
  };

  const onDeleted = result => {
    const name = deleting?.project_name;
    setDeleting(null);
    const destroyed = (result?.deleted?.destroyed || []).reduce((n, d) => n + d.count, 0);
    const orphaned = (result?.deleted?.orphaned || []).reduce((n, d) => n + d.count, 0);
    setNotice(`${name} deleted — ${destroyed} record${destroyed === 1 ? '' : 's'} destroyed`
      + `${orphaned ? `, ${orphaned} left unassigned` : ''}`
      + `${result?.filesRemoved ? `, ${result.filesRemoved} file${result.filesRemoved === 1 ? '' : 's'} removed` : ''}.`);
    load();
  };

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-8 animate-fade-up">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">
            {org?.name}{program?.name ? ` · ${program.name}` : ''}
          </p>
          <h1 className="text-[32px] font-extrabold tracking-tight text-gray-900">Projects</h1>
          <p className="text-gray-500 mt-1 text-[15px]">Open a project to run its reviews, or add a new one to get started.</p>
        </div>
        <div className="flex items-center gap-4">
          {canManage && (
            <label className="flex items-center gap-2 text-[13px] text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} />
              Show archived
            </label>
          )}
          <button className="btn-primary flex items-center gap-2" onClick={() => setAdding(true)}>
            <PlusIcon className="w-5 h-5" /> Add a Project
          </button>
        </div>
      </div>

      {notice && (
        <div className="mb-6 p-3 rounded-xl text-sm flex items-center justify-between gap-4"
          style={{ background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155' }}>
          <span>{notice}</span>
          <button className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}

      {projects == null ? (
        <p className="text-gray-400">Loading projects…</p>
      ) : projects.length === 0 ? (
        <button onClick={() => setAdding(true)}
          className="w-full card p-12 flex flex-col items-center justify-center gap-3 cursor-pointer border-dashed animate-fade-up"
          style={{ borderStyle: 'dashed', borderColor: '#d1d5db' }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(37,99,235,0.08)' }}>
            <DocumentTextIcon className="w-7 h-7" style={{ color: '#2563eb' }} />
          </div>
          <p className="text-lg font-bold text-gray-900">No projects yet</p>
          <p className="text-sm text-gray-500">Click to add your first project — give it a name and (optionally) its contract.</p>
        </button>
      ) : (
        // Fixed at three columns, a card on a 1280px laptop was narrow enough that the
        // options menu overflowed it. Responsive columns fix the cause, not the symptom.
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {projects.map((p, i) => (
            <ProjectCard key={p.id} project={p} index={i} canManage={canManage}
              onOpen={() => navigate(`/project/${p.id}`)}
              onArchive={archive} onDelete={setDeleting} />
          ))}
        </div>
      )}

      {deleting && (
        <DeleteProjectModal
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={onDeleted}
        />
      )}

      {adding && (
        <AddProjectModal
          onClose={() => setAdding(false)}
          onCreated={id => { setAdding(false); navigate(`/project/${id}`); }}
        />
      )}
    </div>
  );
}
