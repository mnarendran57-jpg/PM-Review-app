import { useState } from 'react';
import {
  ExclamationTriangleIcon, CurrencyDollarIcon, ArrowPathRoundedSquareIcon,
  QuestionMarkCircleIcon, ClipboardDocumentCheckIcon, ChevronDownIcon, ChevronUpIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';

function BasisBadge({ basis }) {
  const isConfirmed = basis === 'confirmed';
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 mr-2"
      style={isConfirmed ? { background: '#d1fae5', color: '#065f46' } : { background: '#fef3c7', color: '#92400e' }}
    >
      {isConfirmed ? 'Confirmed' : 'Assumption'}
    </span>
  );
}

function Section({ title, icon: Icon, items, color, bg, plain, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-3.5" style={{ background: bg }} onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color }} />
          <span className="text-sm font-semibold" style={{ color }}>{title}</span>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.6)', color }}>
            {items.length}
          </span>
        </div>
        {open ? <ChevronUpIcon className="w-4 h-4" style={{ color }} /> : <ChevronDownIcon className="w-4 h-4" style={{ color }} />}
      </button>
      {open && (
        <div style={{ borderTop: '1px solid #f3f4f6' }}>
          {items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-400">None identified.</p>
          ) : (
            <ul className="divide-y">
              {items.map((item, i) => (
                <li key={i} className="px-5 py-3 text-sm text-gray-800 flex items-start">
                  {!plain && <BasisBadge basis={item.basis} />}
                  <span className="flex-1">{plain ? item : item.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function PreconReviewView({ report }) {
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-2">
          {report.projectName || 'Untitled Project'} · {report.fileNames?.join(', ')}
        </p>
        {report.reviewFocus && (
          <p className="text-xs text-gray-500 mb-3">Review focus: {report.reviewFocus}</p>
        )}
        {report.insufficientInfo && (
          <div className="p-3 rounded-xl text-sm mb-3 flex items-start gap-2" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
            <InformationCircleIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span><strong>The uploaded documents do not contain enough information for a complete review.</strong> {report.insufficientInfoNote}</span>
          </div>
        )}
        <p className="text-sm text-gray-700 leading-relaxed">{report.documentSummary}</p>
      </div>

      <Section title="Potential Risks" icon={ExclamationTriangleIcon} items={report.risks || []} color="#b91c1c" bg="#fef2f2" />
      <Section title="High-Cost Items" icon={CurrencyDollarIcon} items={report.highCostItems || []} color="#c2410c" bg="#fff7ed" />
      <Section title="Potential Change Order Areas" icon={ArrowPathRoundedSquareIcon} items={report.changeOrderAreas || []} color="#a16207" bg="#fefce8" />
      <Section title="Missing or Unclear Information" icon={QuestionMarkCircleIcon} items={report.missingInfo || []} color="#1d4ed8" bg="#eff6ff" plain />
      <Section title="Recommended PM Action Items" icon={ClipboardDocumentCheckIcon} items={report.actionItems || []} color="#15803d" bg="#f0fdf4" plain />
    </div>
  );
}
