import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlusIcon, FolderIcon, ArrowRightIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { projectsApi, payAppReviewApi } from '../api';
import Modal from '../components/Modal';
import FileDrop from '../components/FileDrop';

function AddProjectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [contract, setContract] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Give the project a name first.'); return; }
    setError(''); setSaving(true);
    try {
      setStatus('Creating project…');
      const { id } = await projectsApi.create({ project_name: name.trim(), client_name: client.trim() || null });
      if (contract) {
        setStatus('Reading the contract — this can take a moment…');
        const fd = new FormData();
        fd.append('contract_file', contract);
        try {
          await payAppReviewApi.uploadContract(id, fd);
        } catch {
          // The project is already created; a contract that fails to parse shouldn't
          // block it. The user can re-upload it from the project's Overview page.
          setStatus('Project created — the contract couldn\'t be read and can be re-added inside the project.');
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
        <div>
          <FileDrop file={contract} onChange={setContract} label="Executed Contract (optional — shared across all tools)" />
          <p className="text-[11px] text-gray-400 mt-1.5">
            Upload it once here and every tool in this project reads from it — no need to attach it again per review.
            You can also add or replace it later from the project's Overview page.
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

function ProjectCard({ project, index, onOpen }) {
  const activity = [];
  if (project.open_rfis) activity.push(`${project.open_rfis} open RFIs`);
  if (project.pay_apps_under_review) activity.push(`${project.pay_apps_under_review} pay apps in review`);
  return (
    <button
      onClick={onOpen}
      className={`card card-hover group cursor-pointer p-6 flex flex-col text-left animate-fade-up stagger-${(index % 6) + 1}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 8px 24px rgba(99,102,241,0.28)' }}>
          <FolderIcon className="w-6 h-6 text-white" />
        </div>
        {project.status && (
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
            style={{ background: 'rgba(99,102,241,0.08)', color: '#4f46e5' }}>{project.status}</span>
        )}
      </div>
      <h3 className="text-lg font-bold text-gray-900 mb-1 leading-snug">{project.project_name}</h3>
      <p className="text-sm text-gray-500 flex-1">{project.client_name || 'No client set'}</p>
      <div className="flex items-center justify-between mt-5">
        <span className="text-[12px] text-gray-400">{activity.length ? activity.join(' · ') : 'No open items'}</span>
        <span className="flex items-center gap-1 text-sm font-semibold text-indigo-600">
          Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </span>
      </div>
    </button>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = () => projectsApi.list().then(setProjects).catch(() => setProjects([]));
  useEffect(() => { load(); }, []);

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-8 animate-fade-up">
        <div>
          <h1 className="text-[32px] font-extrabold tracking-tight text-gray-900">Projects</h1>
          <p className="text-gray-500 mt-1 text-[15px]">Open a project to run its reviews, or add a new one to get started.</p>
        </div>
        <button className="btn-primary flex items-center gap-2" onClick={() => setAdding(true)}>
          <PlusIcon className="w-5 h-5" /> Add a Project
        </button>
      </div>

      {projects == null ? (
        <p className="text-gray-400">Loading projects…</p>
      ) : projects.length === 0 ? (
        <button onClick={() => setAdding(true)}
          className="w-full card p-12 flex flex-col items-center justify-center gap-3 cursor-pointer border-dashed animate-fade-up"
          style={{ borderStyle: 'dashed', borderColor: '#d1d5db' }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(99,102,241,0.08)' }}>
            <DocumentTextIcon className="w-7 h-7" style={{ color: '#6366f1' }} />
          </div>
          <p className="text-lg font-bold text-gray-900">No projects yet</p>
          <p className="text-sm text-gray-500">Click to add your first project — give it a name and (optionally) its contract.</p>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {projects.map((p, i) => (
            <ProjectCard key={p.id} project={p} index={i} onOpen={() => navigate(`/project/${p.id}`)} />
          ))}
        </div>
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
