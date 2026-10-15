import { useState, useEffect } from 'react';
import {
  ScaleIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon, CheckIcon, MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { pcoReviewApi, payAppReviewApi, rfisApi } from '../api';
import { useProject } from '../context/ProjectContext';
import { WORD_TEMPLATES } from '../wordTemplates';
import PageHeader from '../components/PageHeader';
import FileDrop from '../components/FileDrop';
import DocList from '../components/DocList';
import {
  money, TONE, VerdictBanner, CountTiles, Section, CompareFinding, DeviationFinding, ListFinding,
  CoasterNotes, PassedLine,
} from '../components/ReviewReport';
import AddedDocuments, {
  useAddedDocuments, ONCE, SHARE_CATEGORIES, CONTRACT_CATEGORIES,
} from '../components/AddedDocuments';

// A purchase order governs a job that never had a contract, so it belongs in this list too.
// Mirrors GOVERNING_TYPES in backend/lib/docTypes.js.
const GOVERNING_DOCS = ['contract', 'purchase-order'];

// What a change order can be checked against. The math is checked whatever is chosen; the other two
// add their checks on top. "Basic" is the choice of neither, so picking it clears the others and
// picking either of the others clears it.
const CHECK_OPTIONS = [
  { key: 'contract', label: 'Contract', hint: 'Tax, markup limits, allowances, costs it forbids' },
  { key: 'reference', label: 'RFI / ASI', hint: 'Whether it prices only what was asked for' },
  { key: 'basic', label: 'Basic check', hint: 'The math only' },
];

function PcoReportView({ report }) {
  const h = report.header;
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

        <div className="mt-4"><VerdictBanner verdict={report.verdict} /></div>
        <div className="mt-3">
          <CountTiles tiles={report.tiles}
            toneOf={t => (t.key === 'savings' ? (t.count ? 'indigo' : 'grey') : t.count ? 'red' : 'green')} />
        </div>
        <p className="text-[11px] text-gray-400 mt-3">Checked against {h.checkedAgainst.join(', ')}.</p>
      </div>

      <Section title="Math errors" count={report.math.issues.length} tone={report.math.issues.length ? 'red' : 'green'}>
        {report.math.issues.length === 0
          ? <p className="text-[12px] text-gray-500">The arithmetic on the change order checks out.</p>
          : <div className="space-y-4">{report.math.issues.map(f => <CompareFinding key={f.id} finding={f} before="approving" shownLabel="On the PCO" />)}</div>}
      </Section>

      {report.contract && (
        <Section title={`Contract deviations${report.contract.label ? ` — ${report.contract.label}` : ''}`}
          count={report.contract.count ?? report.contract.issues.length} tone={report.contract.issues.length ? 'red' : 'green'}>
          {report.contract.issues.length === 0
            ? <p className="text-[12px] text-gray-500">Nothing on the change order goes against the contract terms that were checked.</p>
            : <div className="space-y-4">{report.contract.issues.map(f => <DeviationFinding key={f.id} finding={f} before="approving" whatLabel="On the PCO" />)}</div>}
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
          <ListFinding finding={{ figures: { rows: report.askFor } }} showTitle={false} />
        </Section>
      )}

      {/* Only there when the change order prices materials or equipment. */}
      {alt?.lines?.length > 0 && (
        <Section title="Value engineering options" count={alt.optionCount} tone={alt.optionCount ? 'indigo' : 'grey'}>
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

      <CoasterNotes notes={report.notes} />
      <PassedLine passed={report.passed} notChecked={report.notChecked} />
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

// Whether every word typed appears somewhere in the text — "duct 031" finds "RFI-031 Duct conflict".
const matches = (query, ...texts) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
};

// The project's RFI Log, to tick RFIs from. Each RFI is sent as its log entry — the question and the
// A/E's answer — with the front of its files, so it can be checked against whether or not anybody
// filed a PDF of it in Shared Documents.
function RfiPicker({ rfis, query, selectedIds, onToggle }) {
  if (rfis === null) return <p className="text-xs text-gray-400">Loading the RFI log…</p>;
  const shown = rfis.filter(r => !query || matches(query, r.rfi_number, r.subject, r.statusLabel));
  if (shown.length === 0) {
    return <p className="text-[11px] text-gray-400">No RFI in the log matches “{query}”.</p>;
  }
  return (
    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
      {shown.map(r => {
        const on = selectedIds.includes(String(r.id));
        return (
          <label key={r.id} className="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors"
            style={{ background: on ? '#eff6ff' : '#fafbfc' }}>
            <input type="checkbox" className="mt-0.5" checked={on} onChange={() => onToggle(String(r.id))} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-gray-800 truncate">
                {r.rfi_number}{r.subject ? ` — ${r.subject}` : ''}
              </span>
              <span className="block text-[10px] text-gray-400">
                {r.statusLabel}{r.responseAction ? ` · ${r.responseAction}` : ''}
              </span>
            </span>
          </label>
        );
      })}
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
  // The project's RFI Log, and which of its RFIs are ticked. Loaded when the RFI/ASI choice is made,
  // not before: most change orders are not checked against one.
  const [rfis, setRfis] = useState(null);
  const [rfiIds, setRfiIds] = useState([]);
  const [refQuery, setRefQuery] = useState('');

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

  useEffect(() => {
    if (!projectId || !checks.includes('reference')) return undefined;
    let cancelled = false;
    setRfis(null);
    rfisApi.list({ project_id: projectId })
      .then(data => { if (!cancelled) setRfis(data.rfis || []); })
      .catch(() => { if (!cancelled) setRfis([]); });
    return () => { cancelled = true; };
  }, [projectId, checks.includes('reference')]);

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
        : wants('reference') && referenceIds.length === 0 && rfiIds.length === 0 && refAdd.added.length === 0 ? 'Choose the RFI or ASI, or upload it.'
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
        fd.append('rfi_ids', JSON.stringify(rfiIds));
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
    setPcoFile(null); setIsAllowance(false); setChecks([]); setReferenceIds([]); setRfiIds([]); setRefQuery('');
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

            {wants('reference') && (() => {
              // One search over both lists. On a large job the log runs to a hundred RFIs and more, and
              // the one wanted is remembered by its number or a word of its subject.
              const docsShown = (others || []).filter(d => !refQuery || matches(refQuery, d.label, d.file_name));
              const hasLog = projectId && rfis?.length > 0;
              const hasDocs = projectId && others?.length > 0;
              const ticked = rfiIds.length + referenceIds.length;
              return (
                <div className="p-4 rounded-xl space-y-3" style={{ background: '#fbfdff', border: '1px solid #dbeafe' }}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[12px] font-bold text-gray-900">The RFI or ASI behind it</p>
                    {ticked > 0 && <span className="text-[11px] font-semibold" style={{ color: '#1d4ed8' }}>{ticked} chosen</span>}
                  </div>

                  {(hasLog || hasDocs) && (
                    <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-white" style={{ border: '1px solid #e5e7eb' }}>
                      <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <input value={refQuery} onChange={e => setRefQuery(e.target.value)}
                        placeholder="Search by RFI number, subject or file name"
                        aria-label="Search RFIs and documents"
                        className="flex-1 min-w-0 bg-transparent text-[12px] text-gray-800 placeholder-gray-400"
                        style={{ outline: 'none', border: 0, boxShadow: 'none' }} />
                      {refQuery && (
                        <button type="button" className="text-[11px] text-gray-400 hover:text-gray-600" onClick={() => setRefQuery('')}>Clear</button>
                      )}
                    </div>
                  )}

                  {projectId && rfis !== null && rfis.length === 0 ? null : projectId && (
                    <div>
                      <p className="text-[11px] text-gray-400 mb-1.5">From the RFI Log — the question and the A/E's answer go with it:</p>
                      <RfiPicker rfis={rfis} query={refQuery} selectedIds={rfiIds}
                        onToggle={id => setRfiIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))} />
                    </div>
                  )}

                  {hasDocs && (
                    <div>
                      <p className="text-[11px] text-gray-400 mb-1.5">From the project's Shared Documents — for an ASI, or an RFI filed there:</p>
                      {docsShown.length === 0
                        ? <p className="text-[11px] text-gray-400">No document matches “{refQuery}”.</p>
                        : <DocList docs={docsShown} selectedIds={referenceIds}
                            onToggle={id => setReferenceIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))} />}
                    </div>
                  )}

                  <AddedDocuments items={refAdd.added} onChange={refAdd.setAdded}
                    noun="change order" label={hasLog || hasDocs ? 'Or upload them' : 'Upload them'}
                    hint="the RFI, the ASI, the sketch that came with it"
                    categories={projectId ? SHARE_CATEGORIES : []} disabled={busy} />
                </div>
              );
            })()}

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
