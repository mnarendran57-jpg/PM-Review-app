import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon, DocumentMagnifyingGlassIcon, ClipboardDocumentCheckIcon,
  ArrowRightIcon, SparklesIcon,
} from '@heroicons/react/24/outline';
import { proposalIntakeApi, payAppReviewApi, preconReviewApi } from '../api';

const MODULES = [
  {
    to: '/proposal-intake',
    label: 'Proposal Intake',
    description: 'Turn an incoming vendor proposal or change order into a signed-ready memo package — automatically.',
    icon: InboxArrowDownIcon,
    bg: 'linear-gradient(135deg, #f59e0b, #f97316)',
    glow: 'rgba(245,158,11,0.35)',
    softBg: 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(249,115,22,0.03))',
    statLabel: 'proposals processed',
    fetch: () => proposalIntakeApi.list(),
  },
  {
    to: '/pay-app-review',
    label: 'Pay App Review',
    description: 'Catches math errors and over-billing on contractor pay applications before you verify the work on site.',
    icon: DocumentMagnifyingGlassIcon,
    bg: 'linear-gradient(135deg, #3b82f6, #6366f1)',
    glow: 'rgba(59,130,246,0.35)',
    softBg: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(99,102,241,0.03))',
    statLabel: 'pay apps reviewed',
    fetch: () => payAppReviewApi.list(),
  },
  {
    to: '/precon-review',
    label: 'Pre-Construction Review',
    description: 'Upload drawings, specs, or narratives and get a risk, cost, and change-order review before construction starts.',
    icon: ClipboardDocumentCheckIcon,
    bg: 'linear-gradient(135deg, #10b981, #059669)',
    glow: 'rgba(16,185,129,0.35)',
    softBg: 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(5,150,105,0.03))',
    statLabel: 'documents reviewed',
    fetch: () => preconReviewApi.list(),
  },
];

function ModuleCard({ mod, count, index }) {
  const navigate = useNavigate();
  const Icon = mod.icon;
  return (
    <div
      onClick={() => navigate(mod.to)}
      className={`card card-hover group cursor-pointer p-7 flex flex-col animate-fade-up stagger-${index + 1}`}
      style={{ background: mod.softBg }}
    >
      <div className="flex items-start justify-between mb-5">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: mod.bg, boxShadow: `0 8px 24px ${mod.glow}` }}>
          <Icon className="w-7 h-7 text-white" />
        </div>
        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.7)', color: '#374151' }}>
          {count == null ? '···' : count} {mod.statLabel}
        </span>
      </div>
      <h3 className="text-lg font-bold text-gray-900 mb-2">{mod.label}</h3>
      <p className="text-sm text-gray-600 leading-relaxed flex-1">{mod.description}</p>
      <div className="flex items-center gap-1.5 mt-5 text-sm font-semibold" style={{ color: '#374151' }}>
        Open module <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-1" />
      </div>
    </div>
  );
}

export default function Home() {
  const [counts, setCounts] = useState({});

  useEffect(() => {
    MODULES.forEach(mod => {
      mod.fetch().then(list => setCounts(c => ({ ...c, [mod.to]: list.length }))).catch(() => {});
    });
  }, []);

  return (
    <div className="p-8">
      <div className="mb-10 animate-fade-up">
        <div className="flex items-center gap-2 mb-2">
          <SparklesIcon className="w-5 h-5" style={{ color: '#f59e0b' }} />
          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Olivier Inc. · PM Review</span>
        </div>
        <h1 className="text-[34px] font-extrabold tracking-tight text-gray-900">
          Welcome back<span className="text-gradient" style={{ '--text-gradient': 'linear-gradient(135deg, #f59e0b, #6366f1)' }}>.</span>
        </h1>
        <p className="text-gray-500 mt-1.5 text-[15px]">Pick a tool below to get started.</p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {MODULES.map((mod, i) => (
          <ModuleCard key={mod.to} mod={mod} count={counts[mod.to]} index={i} />
        ))}
      </div>
    </div>
  );
}
