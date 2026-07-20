import { useState, useRef } from 'react';
import { CloudArrowUpIcon } from '@heroicons/react/24/outline';

export default function FileDrop({ file, onChange, label, accept = '.pdf', hint = 'PDF · no size limit' }) {
  const ref = useRef();
  const [dragOver, setDragOver] = useState(false);
  return (
    <div>
      <label className="label">{label}</label>
      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); onChange(e.dataTransfer.files[0]); }}
        style={{
          border: `2px dashed ${dragOver ? '#f59e0b' : file ? '#10b981' : '#e2e8f0'}`,
          borderRadius: '14px',
          padding: '18px 16px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? 'rgba(245,158,11,0.04)' : file ? 'rgba(16,185,129,0.04)' : '#fafbfc',
          transition: 'all 0.2s',
        }}
      >
        <input ref={ref} type="file" className="hidden" accept={accept} onChange={e => onChange(e.target.files[0])} />
        {file ? (
          <p className="text-sm font-semibold text-gray-800 truncate">{file.name}</p>
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <CloudArrowUpIcon className="w-5 h-5" style={{ color: '#f97316' }} />
            <p className="text-xs font-medium text-gray-600">Drop file or click to browse</p>
            <p className="text-[11px] text-gray-400">{hint}</p>
          </div>
        )}
      </div>
    </div>
  );
}
