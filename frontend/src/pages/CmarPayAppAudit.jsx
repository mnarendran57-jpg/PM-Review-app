import { useState, useEffect } from 'react';
import {
  ShieldCheckIcon, SparklesIcon, ArrowDownTrayIcon, TrashIcon, ClockIcon,
  CloudArrowUpIcon, DocumentTextIcon, CheckCircleIcon, XCircleIcon,
  ExclamationTriangleIcon, QuestionMarkCircleIcon, PencilSquareIcon,
} from '@heroicons/react/24/outline';
import { cmarAuditApi } from '../api';
import { useProject } from '../context/ProjectContext';
import PageHeader from '../components/PageHeader';
import FileDrop from '../components/FileDrop';
import { useConfirm } from '../components/ConfirmDialog';

const money = (n, cents = false) => (typeof n === 'number' && Number.isFinite(n)
  ? n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
  })
  : '—');

// One visual language for a verdict, used everywhere a status appears. A reader learns it once.
const STATUS = {
  pass: { icon: CheckCircleIcon, colour: '#047857', bg: '#ecfdf5', border: '#a7f3d0', word: 'OK' },
  fail: { icon: XCircleIcon, colour: '#b91c1c', bg: '#fef2f2', border: '#fecaca', word: 'Issue' },
  note: { icon: ExclamationTriangleIcon, colour: '#b45309', bg: '#fffbeb', border: '#fde68a', word: 'Minor' },
  unknown: { icon: QuestionMarkCircleIcon, colour: '#64748b', bg: '#f8fafc', border: '#e2e8f0', word: 'Not checked' },
};

function StatusLine({ status, title, detail, compact = false }) {
  const s = STATUS[status] || STATUS.unknown;
  const Icon = s.icon;
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: s.colour }} />
      <div className="min-w-0">
        <p className={`${compact ? 'text-[12px]' : 'text-[13px]'} font-semibold leading-snug`}
          style={{ color: status === 'pass' ? '#111827' : s.colour }}>
          {title}
        </p>
        {detail && <p className="text-[12px] text-gray-600 leading-relaxed mt-0.5">{detail}</p>}
      </div>
    </div>
  );
}

function HistoryItem({ item, onView, onDelete }) {
  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const clean = item.issue_count === 0;
  return (
    <div className="card px-5 py-3.5 flex items-center justify-between cursor-pointer" onClick={() => onView(item.id)}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0"
          style={{
            background: clean ? '#ecfdf5' : '#fef2f2',
            color: clean ? '#047857' : '#b91c1c',
          }}>
          {clean ? 'No issues' : `${item.issue_count} issue${item.issue_count === 1 ? '' : 's'}`}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {item.application_number ? `Application No. ${item.application_number}` : 'Pay application'}
            {item.project_name ? ` — ${item.project_name}` : ''}
          </p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {[
              item.contractor,
              money(item.payment_due),
              item.math_only ? 'math check only' : item.contract_name,
              item.tax_total > 0 ? `${money(item.tax_total, true)} tax` : null,
            ].filter(Boolean).join(' · ')}
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

function AuditView({ record, onClose, onNew }) {
  const r = record.report;
  const h = record.header || {};
  // Marking up reads the position of every figure on every page, which takes a moment on a long
  // packet — so the button says so rather than appearing to do nothing.
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState('');

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 truncate">
            {h.applicationNumber ? `Application No. ${h.applicationNumber}` : 'Pay application'}
            {h.projectName ? ` — ${h.projectName}` : ''}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {[h.contractorName, h.periodTo ? `period to ${h.periodTo}` : null,
              h.mathOnly ? 'math check only' : h.contractName].filter(Boolean).join(' · ')}
          </p>
        </div>
        {/* Two outputs, and they answer different questions. The REVIEW is what is wrong; the
            MARKED-UP PACKET is where — the contractor's own pages with each figure circled and a
            comment attached, which is what a reviewer actually works from and what goes back to
            the contractor. The untouched original stays available because a marked-up copy is an
            opinion written on somebody else's document, and the clean one is the record. */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-4">
          <button className="btn-primary px-3 py-1.5" disabled={marking}
            onClick={() => cmarAuditApi.downloadPdf(record.id)}>
            <ArrowDownTrayIcon className="w-4 h-4" /> Review PDF
          </button>
          <button className="btn-primary px-3 py-1.5" disabled={marking}
            title="The contractor's packet with every finding circled on the page it belongs to"
            onClick={async () => {
              setMarking(true);
              setMarkError('');
              try {
                await cmarAuditApi.downloadMarkedUp(record.id);
              } catch {
                setMarkError('The marked-up packet could not be produced. The review PDF above is unaffected.');
              } finally {
                setMarking(false);
              }
            }}>
            {marking
              ? <><svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg> Marking up…</>
              : <><PencilSquareIcon className="w-4 h-4" /> Marked-Up Packet</>}
          </button>
          <button className="btn-secondary px-3 py-1.5" title="The packet exactly as the contractor sent it"
            onClick={() => cmarAuditApi.downloadOriginal(record.id, record.packet_file_name)}>
            Original
          </button>
          <button className="btn-secondary px-3 py-1.5" onClick={onClose || onNew}>
            {onClose ? 'Close' : 'New'}
          </button>
        </div>
      </div>

      {markError && (
        <div className="p-3 rounded-xl text-sm"
          style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
          {markError}
        </div>
      )}

      {/* The verdict, first and unmissable. */}
      <div className="card p-5" style={{
        background: r.summary.certifiable ? '#f0fdf4' : '#fef2f2',
        borderColor: r.summary.certifiable ? '#bbf7d0' : '#fecaca',
      }}>
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-semibold" style={{ color: r.summary.certifiable ? '#047857' : '#b91c1c' }}>
            {r.summary.certifiable
              ? 'No arithmetic or contract issues were found.'
              : `${r.summary.issueCount} issue${r.summary.issueCount === 1 ? '' : 's'} found.`}
          </p>
          {r.summary.paymentDue != null && (
            <p className="text-sm font-semibold text-gray-900 whitespace-nowrap">
              {money(r.summary.paymentDue)} <span className="text-[11px] font-normal text-gray-500">due</span>
            </p>
          )}
        </div>
        {r.summary.text && (
          <p className="text-[13px] text-gray-700 leading-relaxed mt-2">{r.summary.text}</p>
        )}
        {r.summary.mathOnly && (
          <p className="text-[11px] mt-2 leading-relaxed" style={{ color: '#b45309' }}>
            Arithmetic only — no contract was provided, so contracted rates, tax exemption and
            change-order limits were not checked.
          </p>
        )}
      </div>

      {/* The nine lines. */}
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-900 mb-3">The Numbers</p>
        <table className="w-full">
          <tbody>
            {r.numbers.lines.map((line, i) => (
              <tr key={line.line} style={{ background: line.line === 8 ? '#f8fafc' : undefined }}>
                <td className="py-1.5 pr-2 text-[11px] text-gray-400 align-top"
                  style={{ borderTop: i ? '1px solid #f1f5f9' : 'none', width: 24 }}>
                  {line.line}
                </td>
                <td className={`py-1.5 pr-4 text-[12px] ${line.line === 8 ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                  style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                  {line.label}
                </td>
                <td className={`py-1.5 text-right text-[12px] whitespace-nowrap ${line.line === 8 ? 'font-bold text-gray-900' : 'text-gray-700'}`}
                  style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                  {money(line.amount, true)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {r.numbers.categories.length > 0 && (
          <>
            <p className="text-[11px] font-semibold text-gray-400 mt-5 mb-2">THIS APPLICATION, BY CATEGORY</p>
            <table className="w-full">
              <tbody>
                {r.numbers.categories.map((c, i) => (
                  <tr key={c.category}>
                    <td className="py-1.5 pr-4 text-[12px] text-gray-700"
                      style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>{c.category}</td>
                    <td className="py-1.5 text-right text-[12px] text-gray-700 whitespace-nowrap"
                      style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>{money(c.thisPeriod)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* The six questions, always all six. */}
      <div className="card p-5 space-y-3.5">
        <p className="text-sm font-semibold text-gray-900">Any Issues That Were Found</p>
        {r.headline.map((q, i) => (
          <StatusLine key={i} status={q.status} title={q.question} detail={q.detail} />
        ))}

        {r.issues.filter(f => !r.headline.some(q => q.detail === f.detail)).length > 0 && (
          <>
            <p className="text-[11px] font-semibold text-gray-400 pt-2">ALSO FOUND</p>
            {r.issues.filter(f => !r.headline.some(q => q.detail === f.detail)).map((f, i) => (
              <StatusLine key={i} status="fail"
                title={`${f.subject ? `${f.subject} — ` : ''}${f.title}`} detail={f.detail} />
            ))}
          </>
        )}
      </div>

      {/* Tax, where the contract made it a question and something was found. */}
      {r.tax && (
        <div className="card p-5" style={{ borderColor: '#fecaca' }}>
          <div className="flex items-baseline justify-between gap-4 mb-2">
            <p className="text-sm font-semibold" style={{ color: '#b91c1c' }}>
              Items Where Tax Was Charged Unwantedly
            </p>
            <p className="text-sm font-bold whitespace-nowrap" style={{ color: '#b91c1c' }}>
              {money(r.tax.total, true)}
            </p>
          </div>
          {r.tax.finding && (
            <p className="text-[12px] text-gray-700 leading-relaxed mb-3">{r.tax.finding.detail}</p>
          )}
          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left text-[10px] font-semibold text-gray-400 pb-1.5">VENDOR</th>
                <th className="text-left text-[10px] font-semibold text-gray-400 pb-1.5">INVOICE</th>
                <th className="text-right text-[10px] font-semibold text-gray-400 pb-1.5">TOTAL</th>
                <th className="text-right text-[10px] font-semibold text-gray-400 pb-1.5">TAX</th>
              </tr>
            </thead>
            <tbody>
              {r.tax.charged.map((inv, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-3 text-[12px] text-gray-700" style={{ borderTop: '1px solid #f1f5f9' }}>
                    {inv.vendor}
                  </td>
                  <td className="py-1.5 pr-3 text-[12px] text-gray-500" style={{ borderTop: '1px solid #f1f5f9' }}>
                    {inv.invoiceNumber || '—'}
                  </td>
                  <td className="py-1.5 text-right text-[12px] text-gray-700 whitespace-nowrap" style={{ borderTop: '1px solid #f1f5f9' }}>
                    {money(inv.total, true)}
                  </td>
                  <td className="py-1.5 text-right text-[12px] font-semibold whitespace-nowrap"
                    style={{ borderTop: '1px solid #f1f5f9', color: '#b91c1c' }}>
                    {money(inv.taxAmount, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.tax.exempt.length > 0 && (
            <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
              For contrast, the exemption was correctly applied on {r.tax.exempt.length} other
              invoice{r.tax.exempt.length === 1 ? '' : 's'} in the same packet.
            </p>
          )}
        </div>
      )}

      {/* Subcontractors, by name. */}
      {r.subcontractors.length > 0 && (
        <div className="card p-5 space-y-4">
          <p className="text-sm font-semibold text-gray-900">Subcontractor Billing vs Cost Breakdown</p>
          {r.subcontractors.map((s, i) => (
            <div key={i} style={{ borderTop: i ? '1px solid #f1f5f9' : 'none', paddingTop: i ? 14 : 0 }}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[13px] font-semibold text-gray-900">{s.firmName}</p>
                <span className="text-[11px] font-semibold whitespace-nowrap"
                  style={{ color: s.ties === null ? '#64748b' : (s.ties ? '#047857' : '#b91c1c') }}>
                  {s.ties === null ? 'Not comparable' : (s.ties ? 'Ties' : 'Does not tie')}
                </span>
              </div>
              {s.scopeDescription && <p className="text-[11px] text-gray-400">{s.scopeDescription}</p>}
              <div className="flex gap-5 mt-1.5 text-[12px] text-gray-600">
                <span>Billed (gross) <strong className="text-gray-900">{money(s.subGrossThisPeriod)}</strong></span>
                <span>Matched SOV <strong className="text-gray-900">{money(s.sovThisPeriod)}</strong></span>
                {s.variance != null && s.variance !== 0 && (
                  <span>Variance <strong style={{ color: '#b91c1c' }}>{money(s.variance, true)}</strong></span>
                )}
              </div>
              {s.basisNote && (
                <p className="text-[11px] text-gray-500 leading-relaxed mt-1">{s.basisNote}</p>
              )}
              {s.explanation && (
                <p className="text-[12px] text-gray-600 leading-relaxed mt-1">{s.explanation}</p>
              )}
              {(s.checks || []).filter(c => c.status === 'fail').map((c, j) => (
                <div key={j} className="mt-2">
                  <StatusLine status="fail" title={c.title} detail={c.detail} compact />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Everything smaller that should not get lost. */}
      {(r.worthNoting.findings.length > 0 || r.worthNoting.unchecked.length > 0
        || r.worthNoting.untraceable.length > 0 || r.worthNoting.observations.length > 0
        || r.worthNoting.unreadablePages.length > 0) && (
        <div className="card p-5 space-y-3">
          <p className="text-sm font-semibold text-gray-900">Missed or Worth Noting</p>
          {r.worthNoting.untraceable.map((u, i) => (
            <StatusLine key={`u${i}`} status="note"
              title={`No backup found — ${u.item}${u.amount ? ` (${money(u.amount)})` : ''}`}
              detail={u.note} compact />
          ))}
          {r.worthNoting.findings.map((f, i) => (
            <StatusLine key={`f${i}`} status="note"
              title={`${f.subject ? `${f.subject} — ` : ''}${f.title}`} detail={f.detail} compact />
          ))}
          {r.worthNoting.observations.map((o, i) => (
            <p key={`o${i}`} className="text-[12px] text-gray-600 leading-relaxed pl-6">{o}</p>
          ))}
          {r.worthNoting.unchecked.map((f, i) => (
            <StatusLine key={`n${i}`} status="unknown" title={f.title} detail={f.detail} compact />
          ))}
          {r.worthNoting.unreadablePages.length > 0 && (
            <StatusLine status="note" title="Pages that could not be read confidently"
              detail={r.worthNoting.unreadablePages.join(', ')} compact />
          )}
        </div>
      )}

      {/* Invoices flagged by judgement rather than arithmetic. */}
      {r.invoiceConcerns.length > 0 && (
        <div className="card p-5 space-y-3">
          <p className="text-sm font-semibold text-gray-900">Invoices Worth a Second Look</p>
          {r.invoiceConcerns.map((c, i) => (
            <StatusLine key={i} status="note"
              title={`${c.vendor}${c.invoiceNumber ? ` #${c.invoiceNumber}` : ''}`
                + `${c.amount ? ` — ${money(c.amount, true)}` : ''} (${c.confidence || 'possible'})`}
              detail={c.concern} compact />
          ))}
        </div>
      )}

      {/* What to actually do. */}
      {r.actions.length > 0 && (
        <div className="card p-5">
          <p className="text-sm font-semibold text-gray-900 mb-3">Items to Verify Before Approving</p>
          <ol className="space-y-2.5">
            {r.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="text-[11px] font-semibold text-gray-400 mt-0.5 flex-shrink-0">{i + 1}.</span>
                <div className="min-w-0">
                  <p className="text-[13px] leading-snug"
                    style={{ color: a.blocking ? '#b91c1c' : '#111827', fontWeight: a.blocking ? 600 : 400 }}>
                    {a.action}{a.amount ? ` — ${money(a.amount, true)}` : ''}
                  </p>
                  {(a.why || a.blocking) && (
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {[a.why, a.blocking ? 'Do not certify until this is resolved.' : null]
                        .filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

export default function CmarPayAppAudit() {
  const ctx = useProject();
  const projectId = ctx?.projectId;
  const routeProjectName = ctx?.project?.project_name;

  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('contract');     // 'contract' | 'math'
  const [contracts, setContracts] = useState([]);
  const [contractId, setContractId] = useState('');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [record, setRecord] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [history, setHistory] = useState([]);
  const [confirm, confirmDialog] = useConfirm();

  const loadHistory = () => cmarAuditApi.list(projectId ? { project_id: projectId } : undefined)
    .then(setHistory).catch(() => setHistory([]));

  useEffect(() => { loadHistory(); }, [projectId]);

  // The agreements already on file. Nothing is uploaded twice — the contract is the same document
  // every period, and it is already in Shared Documents.
  useEffect(() => {
    if (!projectId) { setContracts([]); return; }
    cmarAuditApi.contracts(projectId)
      .then(rows => {
        setContracts(rows);
        const primary = rows.find(r => r.is_primary) || rows[0];
        if (primary) setContractId(String(primary.id));
        // With nothing on file there is no contract to check against, so the only honest option
        // is the arithmetic one. Selected rather than offered-and-broken.
        if (!rows.length) setMode('math');
      })
      .catch(() => setContracts([]));
  }, [projectId]);

  const reset = () => { setFile(null); setRecord(null); setViewing(null); setError(''); };

  const run = async () => {
    if (!file) { setError('Upload the pay application packet first.'); return; }
    if (mode === 'contract' && !contractId) {
      setError('Choose the contract this application is measured against, or switch to a math check.');
      return;
    }
    setError(''); setRunning(true); setElapsed(0); setRecord(null); setViewing(null);
    try {
      const fd = new FormData();
      fd.append('packet_file', file);
      if (projectId) fd.append('project_id', projectId);
      if (routeProjectName) fd.append('project_name', routeProjectName);
      if (mode === 'math') fd.append('math_only', 'true');
      else fd.append('contract_id', contractId);
      setRecord(await cmarAuditApi.create(fd, setElapsed));
      loadHistory();
    } catch (err) {
      setError(err.friendlyMessage || err.response?.data?.error || 'The pay application could not be reviewed.');
    } finally {
      setRunning(false);
    }
  };

  const view = async id => { setViewing(await cmarAuditApi.get(id)); setRecord(null); };

  const remove = async id => {
    if (!(await confirm('Delete this audit? The uploaded packet is removed too.'))) return;
    await cmarAuditApi.delete(id);
    if (viewing?.id === id) setViewing(null);
    if (record?.id === id) setRecord(null);
    loadHistory();
  };

  const showing = record || viewing;

  return (
    <div className="p-8">
      {confirmDialog}
      <PageHeader
        title="Pay App Reviewer 3"
        subtitle="Check a pay application against the contract it is billed under — the math, the backup, the notary, and the tax"
        icon={ShieldCheckIcon}
        accent="blue"
      />

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card card-accent p-6 space-y-5"
            style={{ '--card-accent': 'linear-gradient(90deg, #2563eb, #1d4ed8)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8)' }}>
                  <DocumentTextIcon className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-gray-900">New Audit</h2>
              </div>
              {file && (
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={reset}>Reset</button>
              )}
            </div>

            <FileDrop file={file} onChange={setFile} label="Pay Application Packet (PDF) *" />
            <p className="text-[11px] text-gray-400 leading-relaxed -mt-3">
              The whole packet as the contractor sent it — the G702 and G703, every subcontractor
              application, and the backup invoices. Scans are fine.
            </p>

            {/* The only question the PM is asked. */}
            <div className="space-y-2">
              <label className="label">What should this be checked against?</label>

              <label className="flex items-start gap-2.5 p-3 rounded-xl cursor-pointer"
                style={{
                  border: `1px solid ${mode === 'contract' ? '#2563eb' : '#e5e7eb'}`,
                  background: mode === 'contract' ? '#eff6ff' : '#fff',
                  opacity: contracts.length ? 1 : 0.5,
                }}>
                <input type="radio" className="mt-0.5" checked={mode === 'contract'}
                  disabled={!contracts.length}
                  onChange={() => setMode('contract')} />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-gray-900">The contract</p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    {contracts.length
                      ? 'The full review — retainage, tax exemption, change-order limits and lien waivers, as well as the math.'
                      : 'No contract or purchase order is filed in Shared Documents for this project yet.'}
                  </p>
                </div>
              </label>

              {mode === 'contract' && contracts.length > 0 && (
                <select className="input" value={contractId} onChange={e => setContractId(e.target.value)}>
                  {contracts.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.label || c.file_name}
                      {c.party ? ` — ${c.party}` : ''}
                      {c.is_primary ? ' (primary)' : ''}
                    </option>
                  ))}
                </select>
              )}

              <label className="flex items-start gap-2.5 p-3 rounded-xl cursor-pointer"
                style={{
                  border: `1px solid ${mode === 'math' ? '#2563eb' : '#e5e7eb'}`,
                  background: mode === 'math' ? '#eff6ff' : '#fff',
                }}>
                <input type="radio" className="mt-0.5" checked={mode === 'math'}
                  onChange={() => setMode('math')} />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-gray-900">Math check only</p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    Every figure recomputed and reconciled, with nothing checked against contracted
                    rates. Faster, and the report says what it did not look at.
                  </p>
                </div>
              </label>
            </div>

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
                  Auditing… {elapsed}s
                </span>
              ) : (
                <span className="flex items-center gap-2"><SparklesIcon className="w-4 h-4" /> Run Audit</span>
              )}
            </button>

            {running && (
              <p className="text-[11px] text-gray-500 text-center leading-relaxed">
                The packet is read first, then every figure is recomputed. You can leave this page —
                the work carries on and the result is in the history when you come back.
              </p>
            )}
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          {showing ? (
            <AuditView
              record={showing}
              onClose={viewing ? () => setViewing(null) : null}
              onNew={reset}
            />
          ) : (
            <>
              <h2 className="text-sm font-semibold text-gray-900">Past Audits</h2>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="card px-5 py-12 text-center">
                    <CloudArrowUpIcon className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    <p className="text-sm text-gray-400">No pay applications audited yet.</p>
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
