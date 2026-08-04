import { useState } from 'react';
import {
  ExclamationTriangleIcon, ExclamationCircleIcon, InformationCircleIcon,
  CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, ClipboardDocumentCheckIcon, ScaleIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import { CheckCircleIcon as CheckCircleSolid } from '@heroicons/react/24/solid';

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

function CheckSection({ title, icon: Icon, items, color, bg, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0 && !defaultOpen) return null;
  return (
    <div className="card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-3.5"
        style={{ background: bg }}
        onClick={() => setOpen(o => !o)}
      >
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
        <div className="divide-y" style={{ borderTop: '1px solid #f3f4f6' }}>
          {items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-400">None.</p>
          ) : (
            items.map(r => (
              <div key={r.id} className="px-5 py-3">
                <p className="text-sm font-medium text-gray-800">{r.description}</p>
                <p className="text-xs text-gray-500 mt-1">{r.detail}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SiteVerificationChecklist({ items }) {
  const [checked, setChecked] = useState({});
  const [open, setOpen] = useState(true);
  const toggle = key => setChecked(c => ({ ...c, [key]: !c[key] }));
  const confirmedCount = Object.values(checked).filter(Boolean).length;

  return (
    <div className="card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-3.5"
        style={{ background: '#eef2ff' }}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <ClipboardDocumentCheckIcon className="w-4 h-4" style={{ color: '#4338ca' }} />
          <span className="text-sm font-semibold" style={{ color: '#4338ca' }}>Site Verification Checklist</span>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.7)', color: '#4338ca' }}>
            {items.length}
          </span>
          {items.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.5)', color: '#4338ca' }}>
              {confirmedCount}/{items.length} confirmed
            </span>
          )}
        </div>
        {open ? <ChevronUpIcon className="w-4 h-4" style={{ color: '#4338ca' }} /> : <ChevronDownIcon className="w-4 h-4" style={{ color: '#4338ca' }} />}
      </button>
      {open && (
        <div style={{ borderTop: '1px solid #f3f4f6' }}>
          <p className="px-5 py-2.5 text-xs text-gray-500" style={{ background: '#fafbfc' }}>
            These are the dollar amounts newly billed <em>this period</em> — new completed work, new stored materials, or new change orders. Check each off once you've physically confirmed it on site.
          </p>
          {items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-400">No new period activity to verify — this period shows no new completed work, stored materials, or change orders.</p>
          ) : (
            <ul className="divide-y">
              {items.map((item, i) => {
                const key = `${item.itemNo}-${i}`;
                const isChecked = !!checked[key];
                return (
                  <li key={key} className="px-5 py-3 flex items-start gap-3 cursor-pointer" onClick={() => toggle(key)}>
                    <button className="flex-shrink-0 mt-0.5" onClick={e => { e.stopPropagation(); toggle(key); }}>
                      {isChecked
                        ? <CheckCircleSolid className="w-5 h-5" style={{ color: '#4338ca' }} />
                        : <span className="block w-5 h-5 rounded-full border-2" style={{ borderColor: '#c7d2fe' }} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`text-sm font-medium ${isChecked ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{item.description}</p>
                        <span className="text-xs font-semibold" style={{ color: isChecked ? '#9ca3af' : '#4338ca' }}>{money(item.amount)}</span>
                        {item.isNew && (
                          <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#92400e' }}>New</span>
                        )}
                      </div>
                      <p className={`text-xs mt-0.5 ${isChecked ? 'text-gray-300' : 'text-gray-500'}`}>{item.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Findings read from the documents against the executed contract. Kept visually distinct
// from the math checks and worded as things to confirm: unlike the arithmetic, a model
// reading a receipt can be wrong, and a reviewer needs to know which is which.
function ContractComplianceSection({ compliance }) {
  if (!compliance) return null;

  const findings = [
    ...(compliance.taxFindings || []).map(f => ({
      head: `Tax charged — ${f.description}`, amount: f.amount, where: f.where, detail: f.detail,
    })),
    ...(compliance.unallowableFindings || []).map(f => ({
      head: `Not allowed by contract — ${f.contractItem}`, amount: f.amount, where: f.where, detail: f.detail,
    })),
  ];

  return (
    <div className="card p-5 space-y-3" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: '#6d28d9' }}>
          <ScaleIcon className="w-4 h-4" /> Checked Against the Contract
          {findings.length > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: '#ede9fe', color: '#6d28d9' }}>
              {findings.length}
            </span>
          )}
        </h3>
        <p className="text-[11px] text-gray-500 mt-1">
          Read from the documents rather than calculated — confirm each before approving.
        </p>
      </div>

      {findings.length === 0 ? (
        <p className="text-xs text-gray-500">Nothing on this application conflicts with the contract terms on file.</p>
      ) : (
        findings.map((f, i) => (
          <div key={i}>
            <p className="text-sm font-medium text-gray-900">
              {f.head}{f.amount != null ? ` — ${money(f.amount)}` : ''}
            </p>
            {f.where && <p className="text-[11px] text-gray-400">{f.where}</p>}
            <p className="text-xs text-gray-600 mt-0.5">{f.detail}</p>
          </div>
        ))
      )}

      {compliance.backupCoverage && (
        <p className="text-xs text-gray-600 pt-1" style={{ borderTop: '1px solid #ddd6fe' }}>
          <span className="font-medium text-gray-900">Backup documentation: </span>{compliance.backupCoverage}
        </p>
      )}
      {compliance.notes && (
        <p className="text-xs" style={{ color: compliance.incomplete ? '#c2410c' : '#6b7280' }}>{compliance.notes}</p>
      )}
    </div>
  );
}

// Chart 1 — each subcontractor's billed amount vs. the total of their own cost breakdown.
// The comparison itself is the point, so matching rows are shown, not just mismatches.
function SubReconciliationChart({ rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
        <TableCellsIcon className="w-4 h-4 text-gray-400" /> Subcontractor Billing vs. Their Cost Breakdown
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-400 border-b" style={{ borderColor: '#f1f5f9' }}>
              <th className="py-1.5 pr-2 font-medium">Subcontractor</th>
              <th className="py-1.5 px-2 font-medium text-right">Billed on summary</th>
              <th className="py-1.5 px-2 font-medium text-right">Their breakdown</th>
              <th className="py-1.5 px-2 font-medium text-right">Difference</th>
              <th className="py-1.5 pl-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const bad = r.status === 'mismatch';
              const unmatched = r.status === 'unmatched';
              return (
                <tr key={i} className="border-b last:border-0" style={{ borderColor: '#f8fafc' }}>
                  <td className="py-1.5 pr-2 text-gray-900">
                    {r.subName}
                    {r.comparedTo && <span className="text-gray-400"> · {r.comparedTo}</span>}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{r.g703Amount != null ? money(r.g703Amount) : '—'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{money(r.breakdownTotal)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums font-medium" style={{ color: bad ? '#b91c1c' : '#9ca3af' }}>
                    {r.difference ? money(r.difference) : '—'}
                  </td>
                  <td className="py-1.5 pl-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={bad ? { background: '#fef2f2', color: '#b91c1c' }
                        : unmatched ? { background: '#fff7ed', color: '#c2410c' }
                        : { background: '#d1fae5', color: '#065f46' }}>
                      {bad ? 'Mismatch' : unmatched ? 'No billing line' : 'Matches'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Chart 2 — every billed line classified against the agreed scope (contract SOV or App #1).
function ScopeComparisonChart({ compliance }) {
  const rows = compliance?.scopeComparison;
  if (!rows || rows.length === 0) return null;
  const label = {
    in_contract: { text: 'In contract', bg: '#d1fae5', color: '#065f46' },
    changed: { text: 'Value changed', bg: '#fef9c3', color: '#854d0e' },
    covered_by_co: { text: 'Approved change', bg: '#dbeafe', color: '#1e40af' },
    not_in_contract: { text: 'NOT IN CONTRACT', bg: '#fef2f2', color: '#b91c1c' },
  };
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-1">
        <TableCellsIcon className="w-4 h-4 text-gray-400" />
        Billed Scope vs. {compliance.scopeSource === 'contract' ? 'the Contract' : 'the Original Schedule (App #1)'}
      </h3>
      <p className="text-[11px] text-gray-400 mb-3">Read from the documents — confirm anything outside the contract before approving.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-400 border-b" style={{ borderColor: '#f1f5f9' }}>
              <th className="py-1.5 pr-2 font-medium">Item</th>
              <th className="py-1.5 px-2 font-medium text-right">Scheduled value</th>
              <th className="py-1.5 px-2 font-medium">Status</th>
              <th className="py-1.5 pl-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const l = label[r.status] || label.not_in_contract;
              return (
                <tr key={i} className="border-b last:border-0" style={{ borderColor: '#f8fafc' }}>
                  <td className="py-1.5 pr-2 text-gray-900">{r.itemNo ? `#${r.itemNo} ` : ''}{r.description}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{r.scheduledValue != null ? money(r.scheduledValue) : '—'}</td>
                  <td className="py-1.5 px-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: l.bg, color: l.color }}>
                      {l.text}{r.status === 'covered_by_co' && r.coNumber ? ` · ${r.coNumber}` : ''}
                    </span>
                  </td>
                  <td className="py-1.5 pl-2 text-gray-500">{r.note || (r.status !== 'in_contract' ? r.matchedTo : '') || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PayAppReportView({ report }) {
  const { header, plainEnglish, critical, mathErrors, worthNoting = [], warnings, cleanBill, checklist = [], compliance = null, subReconciliation = [] } = report;
  const isClean = critical.length === 0 && mathErrors.length === 0;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-2">
          {header.projectName} · Application #{header.applicationNumber} · {header.periodTo}
        </p>
        <div className="grid grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-[11px] text-gray-400">Payment Due Now</p>
            <p className="text-lg font-bold text-gray-900">{money(header.currentPaymentDue)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400">Total Completed So Far</p>
            <p className="text-lg font-bold text-gray-900">{money(header.totalCompletedToDate)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400">Remaining Contract Balance</p>
            <p className="text-lg font-bold text-gray-900">{money(header.balanceToFinish)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400">% Billed / % Held Back</p>
            <p className="text-lg font-bold text-gray-900">
              {header.billedPct != null ? `${header.billedPct.toFixed(1)}%` : '—'} / {header.retainedPct != null ? `${header.retainedPct.toFixed(1)}%` : '—'}
            </p>
          </div>
        </div>
        <div className="p-3 rounded-xl text-sm font-medium"
          style={isClean
            ? { background: '#d1fae5', border: '1px solid #6ee7b7', color: '#065f46' }
            : { background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
          {plainEnglish}
        </div>
        <p className="text-[11px] text-gray-400 mt-3">
          This tool validates that the numbers are internally consistent and within contract limits. It does not verify that billed work was physically completed on site — use the checklist below for that.
        </p>
      </div>

      <CheckSection title="Issues to Resolve Before Approving" icon={ExclamationTriangleIcon} items={critical} color="#b91c1c" bg="#fef2f2" defaultOpen />
      <CheckSection title="Other Calculation Problems Found" icon={ExclamationCircleIcon} items={mathErrors} color="#c2410c" bg="#fff7ed" defaultOpen />
      <CheckSection title="Missed or Worth Noting" icon={InformationCircleIcon} items={worthNoting} color="#7c3aed" bg="#f5f3ff" defaultOpen />
      <SubReconciliationChart rows={subReconciliation} />
      <ScopeComparisonChart compliance={compliance} />
      <ContractComplianceSection compliance={compliance} />
      <SiteVerificationChecklist items={checklist} />
      <CheckSection title="Checks We Couldn't Fully Complete" icon={InformationCircleIcon} items={warnings} color="#a16207" bg="#fefce8" defaultOpen={false} />
      <CheckSection title="Everything Else Checked Out Fine" icon={CheckCircleIcon} items={cleanBill} color="#15803d" bg="#f0fdf4" defaultOpen={false} />
    </div>
  );
}
