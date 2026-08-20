// The customer's own Word documents that Coaster fills in.
//
// A "cover" is a document the organization already writes by hand — their memo letter, their
// progress report — uploaded once so the app can produce the real thing rather than an
// approximation of it redrawn in code. The upload is read, the varying parts are proposed as
// placeholders, the user confirms them, and from then on every memo or report comes back as
// their document with their formatting.
//
// There are two of them now, and they differ only in which fields a filled copy can supply and
// what the model should be told it is looking at. Everything else — reading the .docx, proposing
// the placeholders, writing them in, filling a prepared template — is one implementation in
// lib/memoCover.js.

// --- The memo cover -------------------------------------------------------------------------
// The letter that goes on top of a vendor proposal when it is sent to an owner for approval.
// Filled by Proposal Intake.
const MEMO_FIELDS = [
  { key: 'date', label: "Today's date" },
  { key: 'to_name', label: 'Who the memo is addressed to' },
  { key: 'from_name', label: 'Who the memo is from' },
  { key: 'project_name', label: 'Project name' },
  { key: 'vendor_name', label: 'Vendor or contractor name' },
  { key: 'memo_type', label: '"Proposal" or "Change Order"' },
  { key: 'po_number', label: 'Purchase order number' },
  { key: 'po_reference', label: 'Wording referencing the PO, or blank' },
  { key: 'scope_of_work', label: 'Scope of work described in the proposal' },
  { key: 'total_price', label: 'Total price' },
  { key: 'change_order_price', label: 'Change order amount' },
  { key: 'original_po_amount', label: 'Original PO amount' },
  { key: 'new_total_amount', label: 'PO total after the change' },
  { key: 'request_sentence', label: 'The sentence asking for the requisition or PO increase' },
];

const MEMO_INTRO = `You are looking at a construction project manager's memo cover — the letter
that goes on top of a vendor proposal when it is sent to an owner for approval. This particular
copy is a filled-in example or a blank form. Your job is to work out which parts of it change
from memo to memo, so it can be reused as a template.`;

// --- The progress report cover --------------------------------------------------------------
// The site-visit report the PM sends the team after a walk. Filled by Progress Report.
//
// Two of its fields are not single values on a line. `progress` is the list of observations and
// `site_photos` is the grid of captioned photographs, and both repeat: one copy of whichever
// paragraph or table row holds them, per observation and per photo. They are offered to the model
// as fields all the same, because what it has to recognise is the same thing either way — the
// sample bullet in the uploaded report is the bullet every report will have.
const PROGRESS_FIELDS = [
  { key: 'report_title', label: 'The report title line' },
  { key: 'report_number', label: 'The report number' },
  { key: 'date', label: 'The date of the site visit' },
  { key: 'time', label: 'The time of the site visit' },
  { key: 'weather', label: 'The weather on the day' },
  { key: 'submitted_by', label: 'Who submitted the report' },
  { key: 'project_name', label: 'Project name' },
  { key: 'contractor', label: 'Contractor name' },
  {
    key: 'progress',
    label: 'ONE of the progress observations — mark a single bullet, not the whole list. '
      + 'The paragraph it sits in is repeated once per observation.',
    repeating: true,
  },
  {
    key: 'photo_caption',
    label: 'ONE photo caption. The paragraph or table cell it sits in is repeated once per photo, '
      + 'with the photograph placed above it.',
    repeating: true,
  },
];

const PROGRESS_INTRO = `You are looking at a construction project manager's site progress report —
the report written up after a site visit and sent to the team. This particular copy is a
filled-in example or a blank form. Your job is to work out which parts of it change from report
to report, so it can be reused as a template.`;

const COVER_KINDS = {
  'memo-cover': {
    key: 'memo-cover',
    noun: 'memo cover',
    document: 'memo',
    fields: MEMO_FIELDS,
    intro: MEMO_INTRO,
  },
  'progress-cover': {
    key: 'progress-cover',
    noun: 'progress report template',
    document: 'report',
    fields: PROGRESS_FIELDS,
    intro: PROGRESS_INTRO,
    // Filled by expanding one host paragraph per item rather than substituting a value.
    repeating: ['progress', 'photo_caption'],
    // Two mistakes a progress report invites that a memo does not, both seen on the first real
    // template. The standing heading at the top of the page — the company's own name, "SITE
    // PROGRESS REPORT" — looks like a title and is not one; it is printed on every report and
    // must stay. And a title reading "Aldine ISD Middle School Progress Report-7" decomposes into
    // a project name and a report number, so marking only the project name leaves the 7 behind,
    // and every report thereafter goes out as number 7.
    extraRules: [
      'The company\'s own name and its standing heading at the top of the page are printed on '
        + 'every report. They are not the report title — leave them fixed.',
      'Where a title carries a report number, such as "Aldine ISD Middle School Progress '
        + 'Report-7", mark the project name and the number separately, as project_name and '
        + 'report_number. A number left behind is a number that is wrong on every later report.',
    ],
    // Where the photographs go. Written into the template beside the caption placeholder, so a
    // customer who has no caption line still gets their photos.
    photoTag: 'site_photo',
  },
};

const coverKindFor = docType => COVER_KINDS[docType] || null;

// The default, for callers that predate there being more than one.
const DEFAULT_KIND = 'memo-cover';

module.exports = { COVER_KINDS, coverKindFor, DEFAULT_KIND };
