import { useState, useEffect, useMemo } from 'react';
import {
  LightBulbIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon,
  CloudArrowUpIcon, DocumentTextIcon,
} from '@heroicons/react/24/outline';
import { veAnalyzerApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import FileDrop from '../components/FileDrop';
import { useConfirm } from '../components/ConfirmDialog';

const money = n => (typeof n === 'number' && Number.isFinite(n)
  ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : null);

// The same wording the report uses, so what the PM sees on screen is what the owner reads. Kept in
// step with lib/veReport.js on purpose — a dollar figure must never appear here either.
function costBand(option) {
  const low = typeof option.savingsLowPct === 'number' ? option.savingsLowPct : null;
  const high = typeof option.savingsHighPct === 'number' ? option.savingsHighPct : null;
  if (low === null && high === null) return 'Depends on the design';
  const [lo, hi] = [low ?? high, high ?? low].sort((a, b) => a - b);
  const pct = n => `${Math.abs(Math.round(n))}%`;
  const same = Math.round(lo) === Math.round(hi);
  if (lo < 0 && hi > 0) return `${pct(lo)} more to ${pct(hi)} less`;
  if (hi <= 0) return `${same ? '' : `${pct(hi)} to `}${pct(lo)} more`;
  return `${same ? '' : `${pct(lo)} to `}${pct(hi)} less`;
}

const isSaving = o => typeof o.savingsLowPct === 'number' && o.savingsLowPct > 0;

function HistoryItem({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0"
          style={{ background: '#eef2ff', color: '#4338ca' }}>
          {item.option_count} kept
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {item.estimate_title || item.project_name || item.estimate_file_name || 'Cost estimate'}
          </p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {[item.contractor, money(item.estimate_total), `${item.worked_count} items`]
              .filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}>
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// One row of the table: the alternative, what it is, and what it does to the cost. The tick decides
// whether it reaches the owner's copy.
function OptionRow({ entry, option, position, onToggle, busy }) {
  const kept = option.kept !== false;
  return (
    <tr style={{ opacity: kept ? 1 : 0.45, background: kept ? undefined : '#fafafa' }}>
      <td className="align-top py-3 pr-4" style={{ borderTop: '1px solid #f1f5f9', width: '26%' }}>
        {position === 0 && (
          <>
            <p className="text-[13px] font-semibold text-gray-900 leading-snug">{entry.description}</p>
            {typeof entry.amount === 'number' && (
              <p className="text-[11px] text-gray-400 mt-0.5">{money(entry.amount)}</p>
            )}
          </>
        )}
      </td>
      <td className="align-top py-3 pr-4" style={{ borderTop: '1px solid #f1f5f9' }}>
        <div className="flex items-start gap-2">
          <input
            type="checkbox" className="mt-1 flex-shrink-0" checked={kept} disabled={busy}
            onChange={() => onToggle(option.id, !kept)}
            title={kept ? 'Goes into the PDF' : 'Left out of the PDF'}
          />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-gray-900">{option.name}</p>
            <p className="text-[12px] text-gray-600 leading-relaxed mt-0.5">{option.whatItIs}</p>
            {option.note && (
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: '#b45309' }}>{option.note}</p>
            )}
          </div>
        </div>
      </td>
      <td className="align-top py-3 text-right whitespace-nowrap"
        style={{ borderTop: '1px solid #f1f5f9', width: '18%' }}>
        <span className="text-[12px] font-semibold"
          style={{ color: isSaving(option) ? '#047857' : '#334155' }}>
          {costBand(option)}
        </span>
      </td>
    </tr>
  );
}

function EmptyRow({ entry }) {
  return (
    <tr>
      <td className="align-top py-3 pr-4" style={{ borderTop: '1px solid #f1f5f9', width: '26%' }}>
        <p className="text-[13px] font-semibold text-gray-900 leading-snug">{entry.description}</p>
        {typeof entry.amount === 'number' && (
          <p className="text-[11px] text-gray-400 mt-0.5">{money(entry.amount)}</p>
        )}
      </td>
      <td className="align-top py-3 pr-4" style={{ borderTop: '1px solid #f1f5f9' }}>
        {/* Only reached when the model found nothing at all. A line whose options the PM dropped
            still shows them here, greyed and unticked, so the decision can be undone. */}
        <p className="text-[12px] text-gray-400 italic leading-relaxed">
          {entry.noOptionsReason || 'No alternative worth raising.'}
        </p>
      </td>
      <td className="align-top py-3 text-right" style={{ borderTop: '1px solid #f1f5f9', width: '18%' }}>
        <span className="text-[12px] text-gray-300">—</span>
      </td>
    </tr>
  );
}

function AnalysisView({ record, onChange, onClose, onNew }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const offered = record.report?.alreadyOffered || [];
  const keptCount = useMemo(
    () => record.entries.reduce((n, e) => n + e.options.filter(o => o.kept !== false).length, 0),
    [record.entries]);

  // Every tick is saved on its own rather than batched behind a Save button: a PM who works through
  // twenty options and then closes the tab must not lose the lot.
  const toggle = async (optionId, kept) => {
    setBusy(true); setError(''); setSaved(false);
    try {
      onChange(await veAnalyzerApi.setKept(record.id, { [optionId]: kept }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            {record.header.estimateTitle || record.header.projectName || 'Cost estimate'}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {record.entries.length} items · {keptCount} option{keptCount === 1 ? '' : 's'} in the PDF
            {saved && <span style={{ color: '#059669' }}> · saved</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary px-3 py-1.5" disabled={busy}
            onClick={() => veAnalyzerApi.downloadPdf(record.id)}>
            <ArrowDownTrayIcon className="w-4 h-4" /> Download PDF
          </button>
          <button className="btn-secondary px-3 py-1.5"
            onClick={() => veAnalyzerApi.downloadOriginal(record.id, record.estimate_file_name)}>
            Estimate
          </button>
          <button className="btn-secondary px-3 py-1.5" onClick={onClose || onNew}>
            {onClose ? 'Close' : 'New'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      {offered.length > 0 && (
        <div className="card p-5">
          <p className="text-sm font-semibold text-gray-900">Already offered by your contractor</p>
          <p className="text-xs text-gray-400 mt-0.5 mb-3">
            Priced in the proposal itself — their figures, not estimates.
          </p>
          <table className="w-full">
            <tbody>
              {offered.map((item, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-4 text-[13px] text-gray-700" style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                    {item.description}
                  </td>
                  <td className="py-1.5 text-right text-[12px] font-semibold whitespace-nowrap"
                    style={{ borderTop: i ? '1px solid #f1f5f9' : 'none', color: item.isSaving ? '#047857' : '#334155' }}>
                    {item.effect || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-5">
        <p className="text-[11px] text-gray-400 mb-2">
          Untick anything you would not put in front of this client. Only ticked options go into the PDF.
        </p>
        <table className="w-full">
          <thead>
            <tr>
              <th className="text-left text-[10px] font-semibold text-gray-400 pb-2">ITEM</th>
              <th className="text-left text-[10px] font-semibold text-gray-400 pb-2">ALTERNATIVE</th>
              <th className="text-right text-[10px] font-semibold text-gray-400 pb-2">DIFFERENCE IN COST</th>
            </tr>
          </thead>
          <tbody>
            {record.entries.map(entry => (
              entry.options.length === 0
                ? <EmptyRow key={entry.lineIndex} entry={entry} />
                : entry.options.map((option, i) => (
                  <OptionRow key={option.id} entry={entry} option={option} position={i}
                    onToggle={toggle} busy={busy} />
                ))
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function VeAnalyzer() {
  const ctx = useProject();
  const projectId = ctx?.projectId;
  const routeProjectName = ctx?.project?.project_name;

  const [file, setFile] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [record, setRecord] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [history, setHistory] = useState([]);
  const [confirm, confirmDialog] = useConfirm();

  const loadHistory = () => veAnalyzerApi.list(projectId ? { project_id: projectId } : undefined)
    .then(setHistory).catch(() => setHistory([]));
  useEffect(() => { loadHistory(); }, [projectId]);

  const reset = () => {
    setFile(null); setProjectName('');
    setRecord(null); setViewing(null); setError('');
  };

  const run = async () => {
    if (!file) { setError('Upload the cost estimate first.'); return; }
    setError(''); setRunning(true); setElapsed(0); setRecord(null); setViewing(null);
    try {
      const fd = new FormData();
      fd.append('estimate_file', file);
      if (projectId) fd.append('project_id', projectId);
      if (routeProjectName || projectName) fd.append('project_name', routeProjectName || projectName);
      setRecord(await veAnalyzerApi.create(fd, setElapsed));
      loadHistory();
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'The estimate could not be analysed.');
    } finally {
      setRunning(false);
    }
  };

  const view = async id => {
    const row = await veAnalyzerApi.get(id);
    setViewing({ ...row, id });
    setRecord(null);
  };

  const remove = async id => {
    if (!(await confirm('Delete this analysis? The uploaded estimate is removed too.'))) return;
    await veAnalyzerApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    if (record?.id === id) setRecord(null);
    loadHistory();
  };

  const showing = record || viewing;

  return (
    <div className="p-8">
      {confirmDialog}
      <PageHeader
        title="VE Analyzer"
        subtitle="Upload a cost estimate and get the alternatives to each item, with what they would do to the cost"
        icon={LightBulbIcon}
        accent="indigo"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5"
            style={{ '--card-accent': 'linear-gradient(90deg, #6366f1, #4f46e5)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}>
                  <DocumentTextIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Analysis</h2>
              </div>
              {(file || projectName) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <FileDrop file={file} onChange={setFile} label="Cost Estimate (PDF) *" />

            {!routeProjectName && (
              <div>
                <label className="label">Project Name (optional)</label>
                <input className="input" value={projectName} onChange={e => setProjectName(e.target.value)}
                  placeholder="e.g. Spring Branch Lobby Renovation" />
              </div>
            )}

            {/* Nothing else is asked for. Which items are worth an opinion, and where the building
                is, are both read off the estimate — a PM cannot know either before they have seen
                the document, so making them answer first was the tool avoiding its job. */}
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Coaster picks out the items that actually drive the budget. Subtotals, overhead and
              profit are never included.
            </p>

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={run} disabled={running || !file}>
              {running ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Looking for options… {elapsed}s
                </span>
              ) : (
                <span className="flex items-center gap-2"><SparklesIcon className="w-4 h-4" /> Find Options</span>
              )}
            </button>

            {running && (
              <p className="text-[11px] text-gray-500 text-center leading-relaxed">
                The estimate is read first, then each item is thought about separately. You can leave
                this page — the work carries on and the result is in the history when you come back.
              </p>
            )}
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {showing ? (
            <AnalysisView
              record={showing}
              onChange={updated => (record ? setRecord(updated) : setViewing({ ...viewing, ...updated }))}
              onClose={viewing ? () => setViewing(null) : null}
              onNew={reset}
            />
          ) : (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Past Analyses</h2>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="card px-5 py-12 text-center">
                    <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    <p className="text-sm text-gray-400">No estimates analysed yet.</p>
                  </div>
                ) : (
                  history.map(h => <HistoryItem key={h.id} item={h} onView={view} onDelete={remove} />)
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
