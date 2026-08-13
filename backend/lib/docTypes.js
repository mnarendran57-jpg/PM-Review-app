// What kinds of document a project can hold, in one place.
//
// The list existed in three: an allowlist in routes/payAppReview.js, labels in
// SharedDocuments.jsx, and a third partial copy in RfiLog.jsx that had already drifted — it
// omitted memo-cover, so a memo cover attached to an RFI displayed as "Other". Kept in step by
// hand, three copies drift; this one is served to the frontend so there is nothing to keep.

// A GOVERNING document is the one a party's billing is measured against.
//
// Not every job has a contract. Below a client's threshold there is no executed agreement at
// all: the vendor proposes, the architect, engineer and PM accept, a purchase order is issued,
// and the PO is what the work is done under. A pay app on such a job was reported as having
// "no contract on file" — a finding about a document that was never going to exist, on a job
// that was being run correctly. A purchase order governs exactly as a contract does, so it is
// read the same way and stands in the same place.
const GOVERNING_TYPES = ['contract', 'purchase-order'];

const isGoverning = docType => GOVERNING_TYPES.includes(docType);

// For use inside SQL. Written out rather than parameterised because it appears in queries that
// already carry positional parameters, and a fixed list of literals cannot carry an injection.
const GOVERNING_SQL = GOVERNING_TYPES.map(t => `'${t}'`).join(', ');

// What one is called when reporting its absence. A PM on a PO job should not be told to go and
// find a contract.
const governingLabel = 'contract or purchase order';

const DOC_TYPES = [
  {
    key: 'contract',
    label: 'Contract',
    hint: 'Executed agreement — terms are read automatically',
    accent: '#2563eb',
  },
  {
    key: 'purchase-order',
    label: 'Purchase Order',
    hint: 'For jobs run on a PO instead of a contract — read the same way',
    accent: '#1d4ed8',
  },
  { key: 'drawings', label: 'Drawings', hint: 'Plan sets, details, sections', accent: '#0891b2' },
  { key: 'design', label: 'Design Documents', hint: 'Narratives, basis of design, calculations', accent: '#7c3aed' },
  { key: 'specifications', label: 'Specifications', hint: 'Spec sections and divisions', accent: '#c026d3' },
  { key: 'scope', label: 'Scope of Work', hint: 'Scope letters and matrices', accent: '#059669' },
  { key: 'proposal', label: 'Proposals', hint: 'Vendor and subcontractor proposals', accent: '#d97706' },
  { key: 'estimate', label: 'Cost Estimate', hint: 'Estimates and budgets', accent: '#dc2626' },
  { key: 'schedule', label: 'Schedule', hint: 'Baseline and updated programmes', accent: '#0d9488' },
  { key: 'permit', label: 'Permits & Approvals', hint: 'Permits, approvals, authority letters', accent: '#65a30d' },
  { key: 'memo-cover', label: 'Memo Cover', hint: 'Your Word memo letter — Proposal Intake fills it in', accent: '#e11d48', docx: true },
  { key: 'other', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b' },
  // Predates the richer list and is kept so existing rows stay valid. Never offered on upload;
  // shown as "Other".
  { key: 'reference', label: 'Other', hint: 'Anything else the team needs on file', accent: '#64748b', legacy: true },
];

const DOC_TYPE_KEYS = DOC_TYPES.map(t => t.key);
const labelFor = key => DOC_TYPES.find(t => t.key === key)?.label || 'Other';

module.exports = {
  DOC_TYPES, DOC_TYPE_KEYS, labelFor,
  GOVERNING_TYPES, GOVERNING_SQL, isGoverning, governingLabel,
};
