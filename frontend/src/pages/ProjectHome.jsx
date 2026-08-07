import { useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon, DocumentMagnifyingGlassIcon, ClipboardDocumentCheckIcon,
  ScaleIcon, ArrowRightIcon, ReceiptPercentIcon, CameraIcon,
  ClipboardDocumentListIcon, QuestionMarkCircleIcon, CheckCircleIcon, FolderOpenIcon,
} from '@heroicons/react/24/outline';
import { useProject } from '../context/ProjectContext';
import { usePlanFeatures } from '../hooks/usePlanFeatures';

// Shared Documents is not plan-gated — see the sidebar for why — so it is held apart from
// TOOLS and always rendered first.
const SHARED_DOCUMENTS = {
  slug: 'shared-documents', label: 'Shared Documents',
  description: 'The contract, drawings, specs and estimates — uploaded once and read by every tool below.',
  icon: FolderOpenIcon, bg: 'linear-gradient(135deg, #facc15, #ca8a04)', glow: 'rgba(234,179,8,0.28)',
};

const TOOLS = [
  { slug: 'proposal-intake', label: 'Proposal Intake',
    description: 'Turn a vendor proposal or change order into a signed-ready memo package.',
    icon: InboxArrowDownIcon, bg: 'linear-gradient(135deg, #f59e0b, #f97316)', glow: 'rgba(245,158,11,0.28)' },
  { slug: 'pay-app-review', label: 'Pay App Review',
    description: 'Catch math errors and over-billing on pay applications before you verify work on site.',
    icon: DocumentMagnifyingGlassIcon, bg: 'linear-gradient(135deg, #3b82f6, #2563eb)', glow: 'rgba(59,130,246,0.28)' },
  { slug: 'pco-review', label: 'Change Order Review',
    description: 'Check a proposed change order against the contract before you approve it.',
    icon: ScaleIcon, bg: 'linear-gradient(135deg, #fb923c, #f97316)', glow: 'rgba(249,115,22,0.28)' },
  { slug: 'invoice-review', label: 'Invoice Review',
    description: 'Check a vendor invoice for math errors, unallowable costs, and missing reimbursable backup.',
    icon: ReceiptPercentIcon, bg: 'linear-gradient(135deg, #14b8a6, #0891b2)', glow: 'rgba(20,184,166,0.28)' },
  { slug: 'progress-report', label: 'Progress Report',
    description: 'Upload site-visit photos with captions and generate a progress report to send to the team.',
    icon: CameraIcon, bg: 'linear-gradient(135deg, #f43f5e, #e11d48)', glow: 'rgba(244,63,94,0.28)' },
  { slug: 'precon-review', label: 'Pre-Construction Review',
    description: 'Upload drawings, specs, or narratives for a risk, cost, and change-order review.',
    icon: ClipboardDocumentCheckIcon, bg: 'linear-gradient(135deg, #10b981, #059669)', glow: 'rgba(16,185,129,0.28)' },
  { slug: 'submittal-log', label: 'Submittal Log',
    description: 'Track every submittal from the contractor to the A/E and back, with each revision on the record.',
    icon: ClipboardDocumentListIcon, bg: 'linear-gradient(135deg, #a78bfa, #7c3aed)', glow: 'rgba(139,92,246,0.28)' },
  { slug: 'rfi-log', label: 'RFI Log',
    description: 'Track RFIs to the A/E, and get a suggested answer read off the drawings before they reply.',
    icon: QuestionMarkCircleIcon, bg: 'linear-gradient(135deg, #38bdf8, #0284c7)', glow: 'rgba(14,165,233,0.28)' },
  { slug: 'meeting-actions', label: 'Meeting Actions',
    description: 'Turn meeting minutes into a running list of who owes what, with overdue items front and centre.',
    icon: CheckCircleIcon, bg: 'linear-gradient(135deg, #4ade80, #16a34a)', glow: 'rgba(34,197,94,0.28)' },
];


export default function ProjectHome() {
  const navigate = useNavigate();
  const ctx = useProject();
  const project = ctx?.project;
  const projectId = ctx?.projectId;
  const { has: hasFeature } = usePlanFeatures();

  return (
    <div className="p-8">
      <div className="mb-8 animate-fade-up">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">Project</p>
        <h1 className="text-[30px] font-extrabold tracking-tight text-gray-900">
          {project?.project_name || '…'}
        </h1>
        {project?.client_name && <p className="text-gray-500 mt-1 text-[15px]">{project.client_name}</p>}
      </div>

      <div className="grid grid-cols-3 gap-5 items-start">
          {[SHARED_DOCUMENTS, ...TOOLS.filter(tool => hasFeature(tool.slug))].map((tool, i) => {
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
                <span className="flex items-center gap-1 mt-4 text-sm font-semibold text-blue-600">
                  Open <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
