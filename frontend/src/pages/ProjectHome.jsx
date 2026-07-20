import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon, DocumentMagnifyingGlassIcon, ClipboardDocumentCheckIcon,
  ScaleIcon, ArrowRightIcon, DocumentTextIcon, TrashIcon, CheckCircleIcon,
  ReceiptPercentIcon,
} from '@heroicons/react/24/outline';
import { payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import FileDrop from '../components/FileDrop';

const TOOLS = [
  { slug: 'proposal-intake', label: 'Proposal Intake',
    description: 'Turn a vendor proposal or change order into a signed-ready memo package.',
    icon: InboxArrowDownIcon, bg: 'linear-gradient(135deg, #f59e0b, #f97316)', glow: 'rgba(245,158,11,0.28)' },
  { slug: 'pay-app-review', label: 'Pay App Review',
    description: 'Catch math errors and over-billing on pay applications before you verify work on site.',
    icon: DocumentMagnifyingGlassIcon, bg: 'linear-gradient(135deg, #3b82f6, #6366f1)', glow: 'rgba(59,130,246,0.28)' },
  { slug: 'pco-review', label: 'Change Order Review',
    description: 'Check a proposed change order against the contract before you approve it.',
    icon: ScaleIcon, bg: 'linear-gradient(135deg, #fb923c, #f97316)', glow: 'rgba(249,115,22,0.28)' },
  { slug: 'invoice-review', label: 'Invoice Review',
    description: 'Check a vendor invoice for math errors, unallowable costs, and missing reimbursable backup.',
    icon: ReceiptPercentIcon, bg: 'linear-gradient(135deg, #14b8a6, #0891b2)', glow: 'rgba(20,184,166,0.28)' },
  { slug: 'precon-review', label: 'Pre-Construction Review',
    description: 'Upload drawings, specs, or narratives for a risk, cost, and change-order review.',
    icon: ClipboardDocumentCheckIcon, bg: 'linear-gradient(135deg, #10b981, #059669)', glow: 'rgba(16,185,129,0.28)' },
];

// The shared contract — uploaded once for the whole project and read by every tool.
function ContractSection({ projectId }) {
  const [contract, setContract] = useState(undefined); // undefined = loading, null = none
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => payAppReviewApi.getContract(projectId)
    .then(c => setContract(c || null)).catch(() => setContract(null));
  useEffect(() => { if (projectId) load(); }, [projectId]);

  const upload = async () => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('contract_file', file);
      await payAppReviewApi.uploadContract(projectId, fd);
      setFile(null); load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read this contract.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await payAppReviewApi.deleteContract(projectId); setContract(null); }
    finally { setBusy(false); }
  };

  const t = contract?.terms || {};
  const taxLabel = t.taxExempt === true ? 'Tax exempt' : t.taxExempt === false ? 'Not tax exempt' : 'Tax status not stated';

  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 mb-1">
        <DocumentTextIcon className="w-5 h-5 text-indigo-500" />
        <h2 className="text-base font-bold text-gray-900">Shared Documents</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        The executed contract is uploaded once here and read automatically by every tool in this project —
        you never attach it again per review.
      </p>

      {contract === undefined ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : contract ? (
        <div className="p-4 rounded-xl flex items-start justify-between gap-3" style={{ background: '#f6faf7', border: '1px solid #dcf0e2' }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircleIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
              <span className="text-sm font-semibold text-gray-900 truncate">{contract.file_name}</span>
            </div>
            <p className="text-xs text-gray-500">
              {taxLabel} · {(t.unallowableItems || []).length} unallowable item{(t.unallowableItems || []).length === 1 ? '' : 's'} on file
              {contract.terms_edited ? ' · terms corrected by you' : ' · read from the contract'}
            </p>
          </div>
          <button className="btn-danger flex-shrink-0" onClick={remove} disabled={busy} title="Remove contract">
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <FileDrop file={file} onChange={setFile} label="Executed Contract (PDF)" />
          {error && <p className="text-xs" style={{ color: '#b91c1c' }}>{error}</p>}
          {file && (
            <button className="btn-secondary w-full justify-center py-1.5 text-sm" onClick={upload} disabled={busy}>
              {busy ? 'Reading contract…' : 'Read contract terms'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProjectHome() {
  const navigate = useNavigate();
  const ctx = useProject();
  const project = ctx?.project;
  const projectId = ctx?.projectId;

  return (
    <div className="p-8">
      <div className="mb-8 animate-fade-up">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">Project</p>
        <h1 className="text-[30px] font-extrabold tracking-tight text-gray-900">
          {project?.project_name || '…'}
        </h1>
        {project?.client_name && <p className="text-gray-500 mt-1 text-[15px]">{project.client_name}</p>}
      </div>

      <div className="grid grid-cols-3 gap-6 items-start">
        {/* Tools */}
        <div className="col-span-2 grid grid-cols-2 gap-5">
          {TOOLS.map((tool, i) => {
            const Icon = tool.icon;
            return (
              <button key={tool.slug} onClick={() => navigate(`/project/${projectId}/${tool.slug}`)}
                className={`card card-hover group cursor-pointer p-6 flex flex-col text-left animate-fade-up stagger-${i + 1}`}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: tool.bg, boxShadow: `0 8px 24px ${tool.glow}` }}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-base font-bold text-gray-900 mb-1.5">{tool.label}</h3>
                <p className="text-sm text-gray-500 leading-relaxed flex-1">{tool.description}</p>
                <span className="flex items-center gap-1 mt-4 text-sm font-semibold text-indigo-600">
                  Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </span>
              </button>
            );
          })}
        </div>

        {/* Shared documents */}
        <div className="animate-fade-up stagger-2">
          <ContractSection projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
