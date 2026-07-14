import { useState, useRef } from 'react';
import { CloudArrowUpIcon, DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline';

export default function MultiFileDrop({
  files, onChange, label,
  accept = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx',
  hint = 'PDF, images, Word/Excel · max 20 MB each, up to 10 files',
  maxFiles = 10,
}) {
  const ref = useRef();
  const [dragOver, setDragOver] = useState(false);

  const addFiles = incoming => {
    const list = Array.from(incoming);
    const merged = [...files, ...list].slice(0, maxFiles);
    onChange(merged);
  };

  const removeAt = idx => onChange(files.filter((_, i) => i !== idx));

  return (
    <div>
      <label className="label">{label}</label>
      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${dragOver ? '#f59e0b' : files.length ? '#10b981' : '#e2e8f0'}`,
          borderRadius: '14px',
          padding: '18px 16px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? 'rgba(245,158,11,0.04)' : files.length ? 'rgba(16,185,129,0.04)' : '#fafbfc',
          transition: 'all 0.2s',
        }}
      >
        <input ref={ref} type="file" multiple className="hidden" accept={accept} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <div className="flex flex-col items-center gap-1.5">
          <CloudArrowUpIcon className="w-5 h-5" style={{ color: '#f97316' }} />
          <p className="text-xs font-medium text-gray-600">Drop files or click to browse</p>
          <p className="text-[11px] text-gray-400">{hint}</p>
        </div>
      </div>
      {files.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {files.map((f, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-1.5 rounded-lg text-xs" style={{ background: '#fafbfc', border: '1px solid #f1f5f9' }}>
              <span className="flex items-center gap-1.5 min-w-0 text-gray-700">
                <DocumentIcon className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                <span className="truncate">{f.name}</span>
              </span>
              <button type="button" className="flex-shrink-0 text-gray-400 hover:text-red-600" onClick={e => { e.stopPropagation(); removeAt(i); }}>
                <XMarkIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
