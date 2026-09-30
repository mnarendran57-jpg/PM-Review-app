const { askForJson } = require('./aiJson');
const { blocksForFile } = require('./cmarDocuments');

// Reading a CMAR pay application packet into figures the checks can work on.
//
// WHY THE PDF GOES TO THE MODEL AS A DOCUMENT, NOT AS EXTRACTED TEXT
//
// The audit method this module implements warns that pay app PDFs are routinely scans of a signed
// form, with no text layer at all, and that a text-extraction pass returns empty strings while
// looking like it worked. Its own answer is to shell out to tesseract.
//
// Nothing here needs to. A document block hands the API the pages themselves, and the model reads a
// scan and a text layer the same way — so the OCR step, and the poppler and tesseract binaries it
// wants, are simply not part of this. That also settles the harder half of the same warning:
// "never conclude a form is unsigned based on text extraction alone — render the page and look at
// it." A document block IS the page. The notary question is answered by something that can see the
// stamp, which is the only way it can be answered honestly.
//
// WHAT THIS FILE DOES NOT DO
//
// It does not decide whether anything is wrong. It copies figures off the forms and reports what it
// can see, and every comparison, recomputation and verdict happens in cmarChecks.js against the
// result. That split is deliberate: arithmetic belongs in code, where it is exact, free, and the
// same every run.

// A money field, described once. The model is told to copy rather than compute in every one of
// these, because a figure it derived cannot be checked against the form it came from.
const money = description => ({ type: 'number', description });

// One AIA G702 certificate — the GC's, or a subcontractor's. Same form, same nine lines.
const G702 = {
  type: 'object',
  properties: {
    applicationNumber: { type: 'string', description: 'The application number printed on the form. Copy it as printed.' },
    periodTo: { type: 'string', description: 'The "Period To" date, as printed on the form. The last day of work being certified.' },
    applicationDate: { type: 'string', description: 'The application date printed on the form, if different from Period To.' },
    certifiedDate: {
      type: 'string',
      description: 'The date beside the contractor\'s signature in the certification block — when '
        + 'they signed, which is not always the period end. Null if the block is unsigned or no date is written.',
    },
    line1OriginalContractSum: money('Line 1, Original Contract Sum.'),
    line2NetChangeByChangeOrders: money('Line 2, Net change by Change Orders. Negative if a net deduct.'),
    line3ContractSumToDate: money('Line 3, Contract Sum to Date, exactly as printed. Do not compute it.'),
    line4CompletedAndStoredToDate: money('Line 4, Total Completed and Stored to Date, exactly as printed.'),
    line5Retainage: money('Line 5, Total Retainage — the combined figure (5a plus 5b) as printed.'),
    line5aCompletedWork: money('Line 5a, retainage on completed work, if broken out.'),
    line5bStoredMaterial: money('Line 5b, retainage on stored material, if broken out.'),
    line6TotalEarnedLessRetainage: money('Line 6, Total Earned Less Retainage, exactly as printed.'),
    line7LessPreviousCertificates: money('Line 7, Less Previous Certificates for Payment, exactly as printed.'),
    line8CurrentPaymentDue: money('Line 8, Current Payment Due, exactly as printed.'),
    line9BalanceToFinish: money('Line 9, Balance to Finish Including Retainage, exactly as printed.'),
  },
  required: ['line1OriginalContractSum', 'line4CompletedAndStoredToDate'],
};

// One row of a G703 continuation sheet.
const SOV_ROW = {
  type: 'object',
  properties: {
    itemNumber: { type: 'string', description: 'Column A, the item number as printed.' },
    description: { type: 'string', description: 'Column B, the description of work, as printed.' },
    scheduledValue: money('Column C, Scheduled Value.'),
    previousApplications: money('Column D, work completed from previous applications.'),
    thisPeriod: money('Column E, work completed this period.'),
    storedMaterials: money('Column F, materials presently stored.'),
    completedToDate: money('Column G, total completed and stored to date, as printed.'),
    percentComplete: { type: 'number', description: 'Column H, percent complete, as a number (55 not 0.55).' },
    balanceToFinish: money('Column I, balance to finish.'),
    retainage: money('Column J, retainage, if the sheet carries a retainage column.'),
    isSubtotal: {
      type: 'boolean',
      description: 'True when this row is a subtotal, a category header carrying a total, or a grand '
        + 'total rather than a line of work. Getting this right matters: a subtotal counted as work '
        + 'would double the schedule of values.',
    },
    category: {
      type: 'string',
      description: 'The category or division heading this row sits under, if the sheet groups rows. '
        + 'Copy the heading text. Null when the sheet is flat.',
    },
    isContingencyOrAllowance: {
      type: 'boolean',
      description: 'True when this row is a contingency, allowance, or change-order bucket rather '
        + 'than base scope. Change orders drawn this period should land in one of these.',
    },
  },
  required: ['description', 'scheduledValue', 'isSubtotal'],
};

// A subcontractor's own application inside the packet.
const SUB_APPLICATION = {
  type: 'object',
  properties: {
    firmName: { type: 'string', description: 'The subcontractor\'s firm name exactly as it appears on their form.' },
    scopeDescription: { type: 'string', description: 'What trade or scope this firm is doing, in a few words.' },
    certificate: G702,
    sovRows: { type: 'array', description: 'The rows of this subcontractor\'s own continuation sheet.', items: SOV_ROW },
    retainagePercent: {
      type: 'number',
      description: 'The retainage rate being held from this subcontractor, as a number (10 not 0.10). '
        + 'Read it off the form if stated; otherwise leave null rather than deriving it.',
    },
    signaturePresent: { type: 'boolean', description: 'Whether a handwritten signature is visible in the certification block. Look at the page.' },
    lienWaiverIncluded: {
      type: 'boolean',
      description: 'Whether a lien waiver for this firm appears anywhere in the packet. Null if you cannot tell.',
    },
    lienWaiverType: {
      type: 'string',
      description: 'If a waiver is present: "conditional" or "unconditional", and whether it covers '
        + 'progress payment or final payment, as printed on it.',
    },
    newChangeOrdersThisPeriod: money(
      'If this firm\'s Line 2 shows change orders newly approved in this period, the dollar amount '
      + 'of that new approval. Null when Line 2 is unchanged from their previous application.',
    ),
    pageRange: { type: 'string', description: 'Which pages of the packet this firm\'s application occupies, e.g. "12-14".' },
  },
  required: ['firmName', 'certificate'],
};

// A vendor invoice in the backup.
const BACKUP_INVOICE = {
  type: 'object',
  properties: {
    vendor: { type: 'string', description: 'The vendor or supplier name as printed on the invoice.' },
    invoiceNumber: { type: 'string', description: 'The invoice number as printed.' },
    invoiceDate: { type: 'string', description: 'The invoice date as printed.' },
    description: { type: 'string', description: 'What was bought or supplied, in a few words.' },
    subtotal: money('The pre-tax subtotal, if the invoice shows one.'),
    taxAmount: money(
      'The sales tax charged, as an itemised line on the invoice. Zero when the invoice shows tax '
      + 'of $0.00, and null only when the invoice shows no tax line at all. The difference matters: '
      + 'an explicit $0.00 is evidence an exemption was applied.',
    ),
    total: money('The invoice total as printed.'),
    exemptionNoted: {
      type: 'boolean',
      description: 'True when the invoice shows an exemption or resale certificate was presented — '
        + 'a tax-exempt notation, a certificate number, or tax explicitly charged at $0.00 with a reason.',
    },
    billedUnder: {
      type: 'string',
      description: 'Which schedule-of-values item or cost code this invoice is being billed under, '
        + 'if the packet says. Null when it is not stated.',
    },
    pageRange: { type: 'string', description: 'Which page or pages of the packet this invoice is on.' },
  },
  required: ['vendor', 'total'],
};

const READ_TOOL = {
  name: 'record_pay_application',
  description: 'Record every figure on a CMAR pay application packet, exactly as printed.',
  input_schema: {
    type: 'object',
    properties: {
      projectName: { type: 'string', description: 'The project name printed on the application.' },
      ownerName: { type: 'string', description: 'The owner the application is addressed to.' },
      contractorName: { type: 'string', description: 'The general contractor or construction manager submitting it.' },
      architectName: { type: 'string', description: 'The architect named on the form, if any.' },
      certificate: G702,
      sovRows: { type: 'array', description: 'Every row of the GC\'s G703 continuation sheet, in order.', items: SOV_ROW },
      retainagePercent: {
        type: 'number',
        description: 'The retainage rate stated anywhere on the GC\'s forms, as a number (5 not 0.05). '
          + 'Null if the forms never state a rate — do not derive it from the figures.',
      },
      notary: {
        type: 'object',
        description: 'The notary block on the GC\'s certificate, read by LOOKING at the page. A stamp '
          + 'and a signature are images; never report them missing because no text was found.',
        properties: {
          signaturePresent: { type: 'boolean', description: 'Is a handwritten contractor signature visible?' },
          notaryStampPresent: { type: 'boolean', description: 'Is a notary stamp or embossed seal visible?' },
          notarySignaturePresent: { type: 'boolean', description: 'Is the notary\'s own signature visible?' },
          notarySignedDate: { type: 'string', description: 'The date the notary signed, as printed.' },
          commissionExpiryDate: { type: 'string', description: 'The notary commission expiry date printed on the stamp.' },
          notaryName: { type: 'string', description: 'The notary\'s printed name, if legible.' },
          observation: {
            type: 'string',
            description: 'One sentence describing what you actually see in the block — including '
              + '"the stamp is present but the expiry date is illegible" where that is the truth.',
          },
        },
        required: ['signaturePresent', 'notaryStampPresent'],
      },
      subApplications: { type: 'array', description: 'Every subcontractor application in the packet.', items: SUB_APPLICATION },
      backupInvoices: { type: 'array', description: 'Every vendor invoice in the backup.', items: BACKUP_INVOICE },
      priorApplication: {
        type: 'object',
        description: 'If a PREVIOUS period\'s G702 is also in the packet, its figures — used to check '
          + 'that Line 7 carries forward correctly. Null when no prior application is included.',
        properties: {
          applicationNumber: { type: 'string', description: 'Its application number.' },
          line6TotalEarnedLessRetainage: money('Its Line 6, which should equal this application\'s Line 7.'),
          line4CompletedAndStoredToDate: money('Its Line 4.'),
        },
      },
      unreadablePages: {
        type: 'array',
        description: 'Pages you could not read confidently — too faint, cut off, or rotated. Say so '
          + 'rather than guessing at a figure.',
        items: { type: 'string' },
      },
    },
    required: ['certificate', 'sovRows'],
  },
};

const READ_SYSTEM = 'You are reading a construction pay application packet so its arithmetic can be '
  + 'checked. Copy every figure EXACTLY as printed, including figures you believe are wrong — you are '
  + 'transcribing, not correcting. If a form says Line 6 is $412,000.00 and you think it should be '
  + '$412,500.00, record $412,000.00. The checks downstream exist to find exactly that.\n\n'
  + 'Where a figure is genuinely absent from the form, leave it null. Never substitute a computed '
  + 'value for a printed one, and never carry a figure across from another form.\n\n'
  + 'For signature and notary blocks, LOOK at the page. Signatures and stamps are ink and images, not '
  + 'text. Report what is visibly there.';

// The packet, read. Sent as one document so the model can tie a subcontractor's page to the GC's
// schedule of values in the same pass — the association is the point, and splitting the packet
// across calls would throw it away.
async function readPacket(buffer, name) {
  const blocks = await blocksForFile({ buffer, name });
  return askForJson({
    content: [
      ...blocks,
      {
        type: 'text',
        text: 'Record every figure on this pay application packet using the tool. Work through it in '
          + 'order: the general contractor\'s G702 certificate and G703 continuation sheet first, then '
          + 'each subcontractor application, then every vendor invoice in the backup.\n\n'
          + 'Do not skip invoices because they look small or routine. A monthly monitoring fee, a '
          + 'dumpster charge and a trailer rental are each a vendor invoice and each belongs in the list.',
      },
    ],
    tool: READ_TOOL,
    system: READ_SYSTEM,
    cacheTool: true,
    maxTokens: 16000,
    label: 'cmar read',
  });
}

// --- The contract ------------------------------------------------------------------------

const CONTRACT_TOOL = {
  name: 'record_contract_terms',
  description: 'Record the terms of a construction contract that a pay application can be checked against.',
  input_schema: {
    type: 'object',
    properties: {
      contractForm: { type: 'string', description: 'What form of agreement this is, e.g. "AIA A133-2019" or "owner\'s own form".' },
      ownerName: { type: 'string', description: 'The owner as named in the agreement.' },
      contractorName: { type: 'string', description: 'The contractor or construction manager as named.' },
      gmp: money('The Guaranteed Maximum Price, if the agreement states one. Null when it is deferred to an amendment.'),
      originalContractSum: money('The original contract sum, if stated separately from the GMP.'),
      retainagePercent: {
        type: 'number',
        description: 'The retainage the owner holds from the contractor, as a number (5 not 0.05). '
          + 'Null when the agreement does not state a rate.',
      },
      retainageClause: { type: 'string', description: 'The section number and a short quote of the retainage provision.' },
      cmFeePercent: { type: 'number', description: 'The construction manager\'s fee, as a percentage number. Null if not stated as a percentage.' },
      cmFeeClause: { type: 'string', description: 'The section number and a short quote of the fee provision.' },
      feeMovesWithCostOfWork: {
        type: 'boolean',
        description: 'Whether the agreement says the fee adjusts in proportion to changes in the cost '
          + 'of work. Null when it does not address this.',
      },
      ownerIsTaxExempt: {
        type: 'boolean',
        description: 'Whether the owner is a tax-exempt entity — a school district, municipality, or '
          + 'other government body — per the agreement.',
      },
      taxExemptionClause: {
        type: 'object',
        description: 'The tax provision, if there is one. This is the single most commonly missed '
          + 'clause in a pay application review, so look for it specifically — often a short section '
          + 'headed "Taxes" in the general conditions.',
        properties: {
          present: { type: 'boolean', description: 'Whether a tax or exemption provision exists at all.' },
          section: { type: 'string', description: 'The section number, e.g. "3.6.1".' },
          quote: { type: 'string', description: 'The operative sentence, quoted.' },
          burdenOnContractor: {
            type: 'boolean',
            description: 'True when the clause puts the burden of CLAIMING the exemption on the '
              + 'contractor — meaning tax the contractor fails to avoid is theirs to absorb and is '
              + 'not billable to the owner. This is the distinction that decides whether tax found in '
              + 'the backup is a real finding or an unavoidable cost.',
          },
        },
        required: ['present'],
      },
      changeOrderCap: {
        type: 'object',
        description: 'Any statutory or contractual cap on cumulative change orders.',
        properties: {
          present: { type: 'boolean', description: 'Whether a cap is stated.' },
          percent: { type: 'number', description: 'The cap as a percentage of the original contract sum.' },
          section: { type: 'string', description: 'The section or statute cited.' },
          quote: { type: 'string', description: 'The operative sentence, quoted.' },
        },
        required: ['present'],
      },
      lienWaiverRequirement: {
        type: 'object',
        description: 'What the agreement requires by way of lien waivers as a condition of payment.',
        properties: {
          present: { type: 'boolean', description: 'Whether waivers are required.' },
          thresholdAmount: money('The subcontract value above which waivers are required, if stated.'),
          waiverType: { type: 'string', description: 'Conditional or unconditional, and for which payment.' },
          section: { type: 'string', description: 'The section number.' },
          quote: { type: 'string', description: 'The operative sentence, quoted.' },
        },
        required: ['present'],
      },
      changeOrderDocumentation: {
        type: 'string',
        description: 'What the agreement requires to substantiate a change order — a signed instrument, '
          + 'a particular form, cost backup. Quote the section. Null when it does not say.',
      },
      paymentTiming: { type: 'string', description: 'When payment is due after certification, with the section number.' },
      otherRelevantTerms: {
        type: 'array',
        description: 'Any other provision that can actually be checked against a pay application. Do '
          + 'not list clauses that have nothing to do with progress payments.',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'What it governs, in a few words.' },
            section: { type: 'string', description: 'The section number.' },
            requirement: { type: 'string', description: 'What it requires, in one sentence.' },
          },
          required: ['topic', 'requirement'],
        },
      },
      figuresNotStated: {
        type: 'array',
        description: 'Which of GMP, retainage rate and fee percentage this document does NOT state — '
          + 'common where general conditions defer the numbers to a separate agreement. Naming them '
          + 'lets the report say plainly what could only be checked for internal consistency.',
        items: { type: 'string' },
      },
    },
    required: ['taxExemptionClause'],
  },
};

const CONTRACT_SYSTEM = 'You are reading a construction contract so that a pay application can be '
  + 'checked against it. Record only what the document actually says. Quote section numbers so every '
  + 'finding can cite one.\n\n'
  + 'Where the agreement does not state a figure — general conditions frequently defer the GMP, the '
  + 'retainage rate and the fee to a separate owner-contractor agreement — say so in figuresNotStated '
  + 'rather than inferring a customary value. A report that claims a 5% retainage rate the contract '
  + 'never stated is worse than one that admits the rate was not on file.';

async function readContractTerms(buffer, name) {
  // preferText because a contract is read for its words: it has a text layer far more often than a
  // signed pay app does, and at a fraction of the tokens. blocksForFile falls back to pages on its
  // own when the text is missing or illegible, so a scanned contract still works.
  const blocks = await blocksForFile({ buffer, name, preferText: true });
  return askForJson({
    content: [
      ...blocks,
      {
        type: 'text',
        text: 'Record this agreement\'s terms using the tool. Pay particular attention to any provision '
          + 'about taxes or tax exemption, and to retainage, the fee, change-order limits and lien '
          + 'waiver requirements.',
      },
    ],
    tool: CONTRACT_TOOL,
    system: CONTRACT_SYSTEM,
    cacheTool: true,
    maxTokens: 8000,
    label: 'cmar contract',
  });
}

module.exports = { readPacket, readContractTerms, READ_TOOL, CONTRACT_TOOL };
