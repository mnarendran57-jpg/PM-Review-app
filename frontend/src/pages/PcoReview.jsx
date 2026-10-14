import { useState, useEffect } from 'react';
import {
  ScaleIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon, CheckIcon,
  ExclamationTriangleIcon, CheckCircleIcon, LightBulbIcon,
} from '@heroicons/react/24/outline';
import { pcoReviewApi, payAppReviewApi } from '../api';
import { useProject } from '../context/ProjectContext';
import { WORD_TEMPLATES } from '../wordTemplates';
import PageHeader from '../components/PageHeader';
import FileDrop from '../components/FileDrop';
import AddedDocuments, {
  useAddedDocuments, ONCE, SHARE_CATEGORIES, CONTRACT_CATEGORIES,
} from '../components/AddedDocuments';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

// What a change order can be checked against. The math is checked whatever is chosen; the other two
// add their checks on top. "Basic" is the choice of neither, so picking it clears the others and
// picking either of the others clears it.
const CHECK_OPTIONS = [
  { key: 'contract', label: 'Contract', hint: 'Tax, markup limits, allowances, costs it forbids' },
  { key: 'reference', label: 'RFI / ASI', hint: 'Whether it prices only what was asked for' },
  { key: 'basic', label: 'Basic check', hint: 'The math only' },
];

const TONE = {
  red: { bg: '#fef2f2', border: '#fecaca', ink: '#b91c1c' },
  amber: { bg: '#fff7ed', border: '#fed7aa', ink: '#c2410c' },
  green: { bg: '#ecfdf5', border: '#a7f3d0', ink: '#047857' },
  grey: { bg: '#f8fafc', border: '#e2e8f0', ink: '#64748b' },
  indigo: { bg: '#eef2ff', border: '#c7d2fe', ink: '#4338ca' },
};

// --- The report -----------------------------------------------------------------------------------

function Section({ title, count, tone = 'grey', children }) {
  const t = TONE[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {count != null && (
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: t.bg, color: t.ink }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function FindingTitle({ finding }) {
  return (
    <p className="text-[13px] font-medium mb-1.5" style={{ color: finding.critical ? TONE.red.ink : '#111827' }}>
      {finding.title}
      {finding.critical && <span className="text-[11px] font-semibold ml-2">Resolve before approving</span>}
    </p>
  );
}

const th = 'text-[10px] font-semibold uppercase tracking-wider text-gray-400 py-1.5';
const td = 'py-2 text-[12px] align-top';

// Wrong arithmetic: what the change order says, what it should say, and the gap.
function MathFinding({ finding }) {
  return (
    <div>
      <FindingTitle finding={finding} />
      {/* Fixed columns, so every finding's table lines up with the one above it. */}
      <table className="w-full table-fixed">
        <colgroup><col style={{ width: '46%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /></colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
            <th className={`${th} text-left`}>Item</th>
            <th className={`${th} text-right`}>On the PCO</th>
            <th className={`${th} text-right`}>Should be</th>
            <th className={`${th} text-right`}>Off by</th>
          </tr>
        </thead>
        <tbody>
          {(finding.figures?.rows || []).map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f8fafc' }}>
              <td className={td}>
                <span className="text-gray-800">{r.item}</span>
                {r.working && <span className="block text-[11px] text-gray-400">{r.working}</span>}
              </td>
              <td className={`${td} text-right tabular-nums text-gray-600`}>{money(r.shown)}</td>
              <td className={`${td} text-right tabular-nums text-gray-600`}>{money(r.computed)}</td>
              <td className={`${td} text-right tabular-nums font-semibold`} style={{ color: TONE.red.ink }}>{money(r.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Something the contract does not allow: what was charged, how much, and the term it breaks.
function ContractFinding({ finding }) {
  return (
    <div>
      <FindingTitle finding={finding} />
      {finding.byCoaster && (
        <p className="text-[11px] italic text-gray-400 -mt-1 mb-1.5">Coaster's reading of the contract — verify before acting.</p>
      )}
      <table className="w-full table-fixed">
        <colgroup><col style={{ width: '38%' }} /><col style={{ width: '17%' }} /><col style={{ width: '45%' }} /></colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
            <th className={`${th} text-left`}>On the PCO</th>
            <th className={`${th} text-right`}>At issue</th>
            <th className={`${th} text-left pl-4`}>What the contract says</th>
          </tr>
        </thead>
        <tbody>
          {(finding.figures?.rows || []).map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f8fafc' }}>
              <td className={`${td} text-gray-800`}>{r.item}</td>
              <td className={`${td} text-right tabular-nums font-semibold`} style={{ color: TONE.red.ink }}>
                {typeof r.amount === 'number' ? money(r.amount) : '—'}
              </td>
              <td className={`${td} pl-4 text-gray-700`}>
                {r.rule}
                {r.basis && <span className="block text-[11px] italic text-gray-400">{r.basis}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PcoReportView({ report }) {
  const h = report.header;
  const v = report.verdict;
  const vt = TONE[v.tone];
  const alt = report.alternatives;

  return (
    <div className="space-y-4">
      {/* The answer first: can this be approved, and if not, how much is wrong with it. */}
      <div className="card p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-[15px] font-semibold text-gray-900">
            PCO {h.pcoNumber}{h.title ? ` — ${h.title}` : ''}
          </h3>
          <span className="text-lg font-semibold text-gray-900 tabular-nums">{money(h.totalAmount)}</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {[h.contractor, h.date, h.isAllowance && 'presented as an allowance'].filter(Boolean).join(' · ')}
        </p>

        <div className="mt-4 rounded-xl px-4 py-3 flex items-center gap-3"
          style={{ background: vt.bg, border: `1px solid ${vt.border}` }}>
          {v.tone === 'green'
            ? <CheckCircleIcon className="w-5 h-5 flex-shrink-0" style={{ color: vt.ink }} />
            : <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" style={{ color: vt.ink }} />}
          <p className="text-[14px] font-semibold" style={{ color: vt.ink }}>
            {v.headline}{v.sub && <span className="font-normal">, {v.sub}</span>}
          </p>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3">
          {report.tiles.map(t => {
            const checked = t.count != null;
            const tone = !checked ? 'grey' : t.key === 'savings' ? (t.count ? 'indigo' : 'grey') : (t.count ? 'red' : 'green');
            const c = TONE[tone];
            return (
              <div key={t.key} className="rounded-xl px-3 py-2.5" style={{ background: c.bg }}>
                <p className="text-xl font-bold tabular-nums" style={{ color: c.ink }}>{checked ? t.count : '—'}</p>
                <p className="text-[11px] text-gray-500 leading-tight">{t.label}</p>
                {!checked && <p className="text-[10px] italic text-gray-400">not checked</p>}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-3">Checked against {h.checkedAgainst.join(', ')}.</p>
      </div>

      <Section title="Math errors" count={report.math.issues.length} tone={report.math.issues.length ? 'red' : 'green'}>
        {report.math.issues.length === 0
          ? <p className="text-[12px] text-gray-500">The arithmetic on the change order checks out.</p>
          : <div className="space-y-4">{report.math.issues.map(f => <MathFinding key={f.id} finding={f} />)}</div>}
      </Section>

      {report.contract && (
        <Section title={`Contract deviations${report.contract.label ? ` — ${report.contract.label}` : ''}`}
          count={report.contract.count ?? report.contract.issues.length} tone={report.contract.issues.length ? 'red' : 'green'}>
          {report.contract.issues.length === 0
            ? <p className="text-[12px] text-gray-500">Nothing on the change order goes against the contract terms that were checked.</p>
            : <div className="space-y-4">{report.contract.issues.map(f => <ContractFinding key={f.id} finding={f} />)}</div>}
        </Section>
      )}

      {report.scope && (() => {
        const s = report.scope;
        const count = s.compared ? (s.aligned ? 0 : Math.max(1, s.extraItems.length)) : null;
        return (
          <Section title="Against the RFI/ASI" count={count} tone={count ? 'amber' : 'green'}>
            {s.reference?.label && <p className="text-[11px] text-gray-400 mb-1.5">{s.reference.label}</p>}
            {!s.compared ? (
              <p className="text-[12px] italic text-gray-500">Could not be compared — the documents were too long to read side by side.</p>
            ) : s.aligned ? (
              <p className="text-[12px] text-gray-600">The change order prices the work the RFI/ASI asked for.</p>
            ) : (
              <>
                <p className="text-[12px] text-gray-700">{s.note || 'The change order prices work the RFI/ASI does not call for.'}</p>
                {s.extraItems.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {s.extraItems.map((item, i) => (
                      <li key={i} className="text-[12px] px-3 py-1.5 rounded-lg" style={{ background: TONE.amber.bg, color: TONE.amber.ink }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>
        );
      })()}

      {report.askFor.length > 0 && (
        <Section title="Ask for a breakdown" count={report.askFor.length} tone="amber">
          <p className="text-[11px] text-gray-400 mb-2">Single figures with no quantities or unit prices behind them.</p>
          {report.askFor.map((r, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 py-1.5" style={{ borderTop: i ? '1px solid #f8fafc' : 'none' }}>
              <span className="text-[12px] text-gray-800">{r.item}</span>
              <span className="text-[12px] font-semibold tabular-nums text-gray-900">{money(r.amount)}</span>
            </div>
          ))}
        </Section>
      )}

      {/* Only there when the change order prices materials or equipment. */}
      {alt?.lines?.length > 0 && (
        <Section title="Savings ideas" count={alt.optionCount} tone={alt.optionCount ? 'indigo' : 'grey'}>
          <p className="text-[11px] text-gray-400 mb-3">
            Coaster's suggestions for the materials and equipment priced. Rough ranges against each line,
            not quotes — confirm with the design team before acting on any of them.
          </p>
          <div className="space-y-3">
            {alt.lines.map((line, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[12px] font-semibold text-gray-900">{line.description}</p>
                  {typeof line.amount === 'number' && <span className="text-[11px] text-gray-400 tabular-nums">{money(line.amount)}</span>}
                </div>
                {line.options.length === 0 ? (
                  <p className="text-[11px] text-gray-400 mt-0.5">No alternative suggested. {line.noOptionsReason}</p>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    {line.options.map((o, j) => (
                      <div key={j} className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg" style={{ background: '#fafbff', border: '1px solid #eef2ff' }}>
                        <div className="min-w-0">
                          <p className="text-[12px] text-gray-900">{o.name}</p>
                          <p className="text-[11px] text-gray-500">{o.whatItIs}</p>
                          {o.note && <p className="text-[11px] italic" style={{ color: TONE.amber.ink }}>{o.note}</p>}
                        </div>
                        <span className="text-[12px] font-semibold flex-shrink-0" style={{ color: o.isSaving ? TONE.green.ink : '#6b7280' }}>
                          {o.costDifference}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {report.notes.length > 0 && (
        <div className="card p-5" style={{ background: '#fafaff' }}>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-2">
            <LightBulbIcon className="w-4 h-4" style={{ color: '#6366f1' }} /> Coaster's notes
          </h3>
          <div className="space-y-2">
            {report.notes.map((n, i) => (
              <p key={i} className="text-[12px] text-gray-700"><span className="font-medium text-gray-900">{n.title}:</span> {n.body}</p>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-2">Coaster reads the documents; it does not verify them on site. Treat these as prompts to check.</p>
        </div>
      )}

      {/* One quiet line: there for anyone who asks what was looked at, out of everyone else's way. */}
      {(report.passed.length > 0 || report.notChecked.length > 0) && (
        <div className="px-1 space-y-0.5">
          {report.passed.length > 0 && (
            <p className="text-[11px] text-gray-400 flex items-start gap-1.5">
              <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 mt-px" style={{ color: TONE.green.ink }} />
              <span>Checked and fine: {report.passed.join(', ')}.</span>
            </p>
          )}
          {report.notChecked.length > 0 && (
            <p className="text-[11px] text-gray-400 pl-5">
              Could not be checked: {report.notChecked.map(n => n.description).join(', ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = item.critical_count > 0
    ? { bg: '#fef2f2', color: '#b91c1c', text: `${item.critical_count} to resolve` }
    : item.fail_count > 0
      ? { bg: '#fff7ed', color: '#c2410c', text: `${item.fail_count} to check` }
      : { bg: '#d1fae5', color: '#065f46', text: 'Clean' };
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0" style={{ background: badge.bg, color: badge.color }}>
          {badge.text}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            PCO {item.pco_number || '—'}{item.title ? ` — ${item.title}` : ''}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{money(item.total_amount)} · {item.contractor || '—'}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        <span className="flex items-center gap-1 text-xs text-gray-400"><ClockIcon className="w-3.5 h-3.5" />{date}</span>
        <button className="btn-danger" onClick={e => { e.stopPropagation(); onDelete(item.id); }}><TrashIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

// --- The form -------------------------------------------------------------------------------------

function DocList({ docs, selectedIds, onToggle, type = 'checkbox' }) {
  if (docs === null) return <p className="text-xs text-gray-400">Loading shared documents…</p>;
  // Nothing filed: nothing to show. The upload beneath is the way in, and saying "nothing is filed —
  // upload one below" above an "or upload one" said it twice.
  if (docs.length === 0) return null;
  return (
    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
      {docs.map(d => (
        <label key={d.id} className="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors"
          style={{ background: selectedIds.includes(String(d.id)) ? '#eff6ff' : '#fafbfc' }}>
          <input type={type} className="mt-0.5" checked={selectedIds.includes(String(d.id))} onChange={() => onToggle(String(d.id))} />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-gray-800 truncate">{d.label || d.file_name}</span>
            <span className="block text-[10px] text-gray-400">
              {d.is_primary ? 'Project default · ' : ''}{d.file_name}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

export default function PcoReview() {
  const [pcoFile, setPcoFile] = useState(null);
  const [isAllowance, setIsAllowance] = useState(false);
  // Which of CHECK_OPTIONS are chosen. Nothing until the PM says, so the review is never run
  // against something they did not mean to measure it against.
  const [checks, setChecks] = useState([]);

  const ctx = useProject();
  const routeProjectId = ctx?.projectId;

  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(routeProjectId ? String(routeProjectId) : '');
  // The project's Shared Documents, split into the agreements a change order is measured against
  // and everything an RFI or ASI might have been filed as.
  const [contracts, setContracts] = useState(null);
  const [others, setOthers] = useState(null);
  const [contractId, setContractId] = useState('');
  const [referenceIds, setReferenceIds] = useState([]);
  const [listVersion, setListVersion] = useState(0);

  // Documents added on this form, each kept for this review or filed in Shared Documents.
  const [contractFiled, setContractFiled] = useState([]);
  const contractAdd = useAddedDocuments(projectId, contractFiled, setContractFiled);
  const refAdd = useAddedDocuments(projectId, referenceIds.map(Number), ids => setReferenceIds(ids.map(String)));

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // { id, report }
  const [viewing, setViewing] = useState(null); // { id, report }
  const [history, setHistory] = useState([]);

  const loadHistory = () => pcoReviewApi.list(routeProjectId ? { project_id: routeProjectId } : undefined).then(setHistory);
  useEffect(() => { loadHistory(); }, [routeProjectId]);
  useEffect(() => { payAppReviewApi.projects().then(setProjects); }, []);
  useEffect(() => { if (routeProjectId) setProjectId(String(routeProjectId)); }, [routeProjectId]);

  useEffect(() => {
    if (!projectId) { setContracts(null); setOthers(null); setContractId(''); return undefined; }
    let cancelled = false;
    payAppReviewApi.listDocuments(projectId)
      .then(docs => {
        if (cancelled) return;
        const all = (docs || []).filter(d => !WORD_TEMPLATES.includes(d.doc_type));
        const agreements = all.filter(d => GOVERNING_DOCS.includes(d.doc_type));
        setContracts(agreements);
        setOthers(all.filter(d => !GOVERNING_DOCS.includes(d.doc_type)));
        // The project default is chosen for you, so a single-contract job needs no click.
        setContractId(prev => {
          if (prev && agreements.some(c => String(c.id) === String(prev))) return prev;
          const primary = agreements.find(c => c.is_primary) || agreements[0];
          return primary ? String(primary.id) : '';
        });
      })
      .catch(() => { if (!cancelled) { setContracts([]); setOthers([]); } });
    return () => { cancelled = true; };
  }, [projectId, listVersion, contractAdd.listVersion, refAdd.listVersion]);

  const toggleCheck = key => setChecks(prev => {
    if (prev.includes(key)) return prev.filter(k => k !== key);
    return key === 'basic' ? ['basic'] : [...prev.filter(k => k !== 'basic'), key];
  });
  const wants = key => checks.includes(key);
  const uploadedContract = contractAdd.added[0] || null;

  // What is still missing before the review can run, in words, so the button says why it is off.
  const missing = !pcoFile ? 'Upload the change order first.'
    : checks.length === 0 ? 'Choose what to check it against.'
      : wants('contract') && !contractId && !uploadedContract ? 'Choose the contract, or upload one.'
        : wants('reference') && referenceIds.length === 0 && refAdd.added.length === 0 ? 'Choose the RFI or ASI, or upload it.'
          : null;

  const handleAnalyze = async () => {
    if (missing) { setError(missing); return; }
    setError(''); setAnalyzing(true); setResult(null); setViewing(null);
    try {
      const fd = new FormData();
      fd.append('pco_file', pcoFile);
      if (projectId) fd.append('project_id', projectId);
      fd.append('checks', JSON.stringify(checks.filter(k => k !== 'basic')));
      fd.append('is_allowance', String(isAllowance));

      if (wants('contract')) {
        if (uploadedContract && uploadedContract.where !== ONCE) {
          // Filed in Shared Documents first, then checked against like any filed contract.
          const ids = await contractAdd.fileShared();
          const filed = ids[ids.length - 1];
          if (filed) fd.append('contract_id', String(filed));
          setListVersion(v => v + 1);
        } else if (uploadedContract) {
          fd.append('contract_file', uploadedContract.file);
        } else {
          fd.append('contract_id', contractId);
        }
      }
      if (wants('reference')) {
        fd.append('reference_ids', JSON.stringify(await refAdd.fileShared()));
        for (const once of refAdd.onceFiles) fd.append('reference_files', once);
      }

      const data = await pcoReviewApi.create(fd);
      setResult({ id: data.id, report: data.report });
      contractAdd.setAdded([]);
      refAdd.setAdded([]);
      loadHistory();
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'Could not review this change order.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleView = async id => {
    const record = await pcoReviewApi.get(id);
    setResult(null);
    setViewing({ id: record.id, report: record.report });
  };

  const handleDelete = async id => {
    await pcoReviewApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    if (result?.id === id) setResult(null);
    loadHistory();
  };

  const reset = () => {
    setPcoFile(null); setIsAllowance(false); setChecks([]); setReferenceIds([]);
    contractAdd.setAdded([]); refAdd.setAdded([]); setResult(null); setError('');
  };
  const active = result || viewing;
  const busy = analyzing || contractAdd.filing || refAdd.filing;

  return (
    <div className="p-8 space-y-6">
      <PageHeader
        icon={ScaleIcon}
        iconGradient="linear-gradient(135deg, #f59e0b, #ef4444)"
        title="Change Order Review"
        subtitle="Check a change order's math, and measure it against the contract and the RFI or ASI behind it"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5" style={{ '--card-accent': 'linear-gradient(90deg, #f59e0b, #ef4444)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #ef4444)' }}>
                  <ScaleIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Change Order Review</h2>
              </div>
              {(pcoFile || checks.length > 0 || result) && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            {!routeProjectId && (
              <div>
                <label className="label">Project</label>
                <select className="input" value={projectId} onChange={e => setProjectId(e.target.value)}>
                  <option value="">Which project is this change order for?</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                </select>
              </div>
            )}

            <FileDrop file={pcoFile} onChange={setPcoFile} label="The change order (PDF) *" />

            <div>
              <label className="label">What should it be checked against?</label>
              <p className="text-[11px] text-gray-400 -mt-0.5 mb-2">Choose one or more. The math is always checked.</p>
              <div className="space-y-1.5">
                {CHECK_OPTIONS.map(o => {
                  const on = wants(o.key);
                  return (
                    <button key={o.key} type="button" onClick={() => toggleCheck(o.key)} aria-pressed={on}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors"
                      style={{ background: on ? '#eff6ff' : '#fafbfc', border: `1px solid ${on ? '#bfdbfe' : '#eef1f4'}` }}>
                      <span className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                        style={{ background: on ? '#2563eb' : '#fff', border: `1px solid ${on ? '#2563eb' : '#cbd5e1'}` }}>
                        {on && <CheckIcon className="w-3 h-3 text-white" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-gray-900">{o.label}</span>
                        <span className="block text-[11px] text-gray-400">{o.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {wants('contract') && (
              <div className="p-4 rounded-xl space-y-3" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
                <p className="text-[12px] font-bold text-gray-900">The contract</p>
                {projectId && contracts?.length !== 0 && (
                  <div style={{ opacity: uploadedContract ? 0.5 : 1 }}>
                    <p className="text-[11px] text-gray-400 mb-1.5">From the project's Shared Documents:</p>
                    <DocList docs={contracts} selectedIds={contractId ? [contractId] : []} type="radio"
                      onToggle={id => setContractId(id)} />
                  </div>
                )}
                <AddedDocuments items={contractAdd.added} onChange={contractAdd.setAdded} single
                  noun="change order" label={contracts?.length ? 'Or upload one' : 'Upload it'}
                  hint="the agreement or purchase order this change order is billed under"
                  categories={projectId ? CONTRACT_CATEGORIES : []} disabled={busy} />
                {uploadedContract && projectId && (
                  <p className="text-[11px]" style={{ color: '#1d4ed8' }}>The uploaded contract is used instead of the one ticked above.</p>
                )}
              </div>
            )}

            {wants('reference') && (
              <div className="p-4 rounded-xl space-y-3" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
                <p className="text-[12px] font-bold text-gray-900">The RFI or ASI behind it</p>
                {projectId && others?.length !== 0 && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1.5">From the project's Shared Documents — tick any that apply:</p>
                    <DocList docs={others} selectedIds={referenceIds}
                      onToggle={id => setReferenceIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))} />
                  </div>
                )}
                <AddedDocuments items={refAdd.added} onChange={refAdd.setAdded}
                  noun="change order" label={others?.length ? 'Or upload them' : 'Upload them'}
                  hint="the RFI, the ASI, the sketch that came with it"
                  categories={projectId ? SHARE_CATEGORIES : []} disabled={busy} />
              </div>
            )}

            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={isAllowance} onChange={e => setIsAllowance(e.target.checked)} />
              <span className="text-xs text-gray-600">
                <span className="font-medium text-gray-900">This change order is an allowance.</span> An allowance is the
                owner's set-aside money — the contractor may not take overhead and profit on it.
              </span>
            </label>

            {error && (
              <div className="p-3 rounded-xl text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            <button type="button" className="btn-primary w-full justify-center" onClick={handleAnalyze} disabled={busy || !!missing}>
              {contractAdd.filing || refAdd.filing ? (
                <><SparklesIcon className="w-4 h-4 animate-pulse" /> Saving to Shared Documents…</>
              ) : analyzing ? (
                <><SparklesIcon className="w-4 h-4 animate-pulse" /> Reviewing…</>
              ) : (
                <><SparklesIcon className="w-4 h-4" /> Review Change Order</>
              )}
            </button>
            {missing && !busy && <p className="text-[11px] text-gray-400 -mt-2">{missing}</p>}
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {active && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">{result ? 'Review Result' : 'Stored Review'}</h2>
                <div className="flex items-center gap-2">
                  <button className="btn-primary px-3 py-1.5" onClick={() => pcoReviewApi.downloadPdf(active.id, `PCO_${active.report.header.pcoNumber}_Review.pdf`)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Report PDF
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => pcoReviewApi.downloadOriginal(active.id)}>
                    <ArrowDownTrayIcon className="w-4 h-4" /> Original
                  </button>
                  <button className="btn-secondary px-3 py-1.5" onClick={() => { setResult(null); setViewing(null); }}>Close</button>
                </div>
              </div>
              <PcoReportView report={active.report} />
            </>
          )}

          {!active && (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Review History</h2>
              {history.length === 0 ? (
                <div className="card p-8 text-center text-sm text-gray-400">
                  No change orders reviewed yet. Upload one to get started.
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map(item => (
                    <HistoryRow key={item.id} item={item} onView={handleView} onDelete={handleDelete} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
