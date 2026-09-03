const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../database');
const { askForJson } = require('../lib/aiJson');
const { PDFDocument } = require('pdf-lib');
const { renderMemoPdf, mergePdfBuffers } = require('../lib/pdfGen');
const { renderDocxAsPdf } = require('../lib/docxToPdf');
const { renderMemoDocx } = require('../lib/memoDocx');
const { applyPlaceholders, fillDocx } = require('../lib/memoCover');
const { loadCover } = require('../lib/coverLookup');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const { brandingFor } = require('../lib/orgBranding');
const { friendlyAiError } = require('../lib/aiErrors');
const { pageCount, firstPages, MAX_PDF_PAGES } = require('../lib/chatDocuments');
const storage = require('../lib/storage');


const access = require('../lib/access');
const { requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../lib/plans');

// Scoped to one organization; within it a member sees only projects they belong to.
// Applied to the whole router so a new endpoint cannot silently skip it.
router.use(requireOrg);
// Gated by the customer's Coaster plan — see lib/plans.js.
router.use(requireFeature('proposal-intake'));

// Loads a row only if the caller may see it, else null -> the caller answers 404 rather
// than 403 so ids cannot be probed. Always selects the whole row, because the check needs
// org_id.
function visibleRow(req) {
  const row = db.prepare(`SELECT * FROM proposal_intakes WHERE id=?`).get(req.params.id);
  return access.recordVisible(req.user, row, { projectColumn: null }) ? row : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// The fields lifted off a vendor proposal. A scope summary routinely carries a pipe size or a
// duct dimension written with an inch mark, which is why this is a tool schema rather than
// JSON asked for in the prompt — see lib/aiJson.js.
const PROPOSAL_TOOL = {
  name: 'record_proposal',
  description: 'Record the key fields from a vendor proposal.',
  input_schema: {
    type: 'object',
    properties: {
      vendor_name: { type: 'string', description: 'The vendor/company submitting the proposal.' },
      proposal_date: {
        type: 'string',
        description: 'The date on the proposal (proposal date or quote date), formatted MM/DD/YYYY.',
      },
      project_name: { type: 'string', description: 'The name or title of the project being quoted.' },
      scope_of_work: { type: 'string', description: 'A concise 2-4 sentence summary of the work described.' },
      total_price: {
        type: 'string',
        description: 'The final/total dollar amount quoted, formatted like $12,345.00.',
      },
    },
    required: ['vendor_name', 'proposal_date', 'project_name', 'scope_of_work', 'total_price'],
  },
};

function parseMoney(str) {
  const n = parseFloat(String(str ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Extract key fields from an uploaded proposal PDF via Claude
router.post('/extract', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Proposal must be a PDF' });
    }

    // The API refuses a PDF of more than a hundred pages outright, and refuses the whole request
    // rather than the excess. A proposal that arrives with its specifications bound in behind it
    // would have failed here with the provider's raw error.
    //
    // The fields wanted — who it is from, what it prices, how much — are on the front pages of any
    // proposal ever written, so the first hundred are read and the rest are not. Nothing is lost
    // from the OUTPUT: the merged package is built from the whole file, not from this.
    const pages = await pageCount(file.buffer);
    const readable = pages && pages > MAX_PDF_PAGES
      ? await firstPages(file.buffer, MAX_PDF_PAGES)
      : file.buffer;

    const base64 = readable.toString('base64');
    const prompt = `You are reviewing a vendor proposal PDF for a construction project at an MEP
consulting firm. Record the key fields with the record_proposal tool.
${pages && pages > MAX_PDF_PAGES
    ? `\nThis proposal is ${pages} pages; you are being shown the first ${MAX_PDF_PAGES}.\n` : ''}
If any field cannot be found with confidence, use "Not specified" as its value.`;

    const { data: extracted } = await askForJson({
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: prompt },
      ],
      tool: PROPOSAL_TOOL,
      maxTokens: 1024,
      label: 'proposal extract',
    });
    res.json(extracted);
  } catch (err) {
    console.error('Extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

// The memo's values, worked out from what the form said.
//
// Pulled out of the create handler so that REGENERATING an existing package runs the same code.
// The alternative — a second copy of this for the edit path — is how the memo produced on Monday
// and the memo produced by correcting it on Tuesday come to word the same request differently.
function memoFieldsFor(body, orgId) {
  const {
    intake_type, vendor_name, project_name, po_number,
    proposal_date, scope_of_work, total_price, memo_template_id,
    to_name, from_name, change_order_price, original_po_amount,
  } = body;

  // Scoped to the caller's organization. The unscoped version picked whichever template
  // happened to be default anywhere in the database, so a second customer's memo came out
  // on the first customer's letterhead.
  const templateRow = memo_template_id
    ? db.prepare('SELECT * FROM memo_templates WHERE id=? AND org_id=?').get(memo_template_id, orgId)
    : db.prepare('SELECT * FROM memo_templates WHERE org_id=? ORDER BY is_default DESC, id ASC LIMIT 1').get(orgId);
  if (!templateRow) {
    const err = new Error('No memo template found');
    err.status = 400;
    throw err;
  }
  const template = { ...templateRow, sections: JSON.parse(templateRow.sections) };

  let newTotalAmount = null;
  let requestSentence;
  if (intake_type === 'Change Order') {
    newTotalAmount = formatMoney(parseMoney(change_order_price) + parseMoney(original_po_amount));
    requestSentence = `Kindly increase the existing PO ${po_number || '(number not specified)'} by ${change_order_price}, so that the new PO will have a total of ${newTotalAmount}.`;
  } else {
    requestSentence = `Kindly initiate a requisition in the amount of ${total_price || 'Not specified'}.`;
  }

  const fields = {
    vendor_name: vendor_name || 'Not specified',
    project_name: project_name || 'Not specified',
    po_number: po_number || '',
    date: proposal_date || 'Not specified',
    scope_of_work: scope_of_work || 'Not specified',
    total_price: intake_type === 'Change Order' ? newTotalAmount : (total_price || 'Not specified'),
    change_order_price: change_order_price || '',
    original_po_amount: original_po_amount || '',
    new_total_amount: newTotalAmount || '',
    request_sentence: requestSentence,
    to_name: to_name || 'James Walker',
    from_name: from_name || 'Devin Roy',
    memo_type: intake_type === 'Change Order' ? 'Change Order Memo' : 'Recommendation Memo',
    po_reference: intake_type === 'Change Order' && po_number
      ? ` (against existing PO #${po_number})`
      : '',
  };
  return { template, fields, newTotalAmount };
}

// The memo page, and the package built around it. Shared by create and regenerate for the same
// reason as above.
async function buildPackage({ orgId, projectId, template, fields, proposalBytes, poBytes }) {
  const branding = await brandingFor(orgId);

  // The organization's own memo cover, where one is on file. Filling their .docx keeps their
  // exact formatting — their fonts, their letterhead, their signature block.
  let memoDocx = null;
  try {
    const cover = await loadCover({ docType: 'memo-cover', projectId, orgId });
    if (cover) {
      const { buffer: prepared } = applyPlaceholders(
        cover.buffer, cover.terms.replacements || [], 'memo-cover');
      memoDocx = fillDocx(prepared, fields);
    }
  } catch (err) {
    // A broken cover must not stop the memo going out — the built-in one below still renders.
    console.error('Memo cover could not be filled (falling back to the built-in memo):', err.message);
  }

  const memoPdf = memoDocx
    ? await renderDocxAsPdf(memoDocx, { branding, confidential: true })
    : await renderMemoPdf(template, fields, branding);
  const mergedPdf = await mergePdfBuffers([memoPdf, proposalBytes, poBytes]);

  // Every package carries an editable Word memo, whether or not a template was uploaded.
  if (!memoDocx) memoDocx = renderMemoDocx(template, fields, branding);

  return { mergedPdf, memoDocx };
}

router.post('/', upload.fields([{ name: 'proposal_file', maxCount: 1 }, { name: 'po_file', maxCount: 1 }]), async (req, res) => {
  try {
    const {
      intake_type, vendor_name, project_name, po_number,
      proposal_date, scope_of_work, total_price, memo_template_id,
      to_name, from_name, change_order_price, original_po_amount
    } = req.body;

    if (!intake_type || !['New Vendor', 'Change Order'].includes(intake_type)) {
      return res.status(400).json({ error: 'intake_type must be "New Vendor" or "Change Order"' });
    }
    const proposalFile = req.files?.proposal_file?.[0];
    if (!proposalFile) return res.status(400).json({ error: 'Proposal PDF is required' });
    if (intake_type === 'Change Order' && !req.files?.po_file?.[0]) {
      return res.status(400).json({ error: 'Existing PO PDF is required for a Change Order' });
    }
    if (intake_type === 'Change Order' && (!change_order_price || !original_po_amount)) {
      return res.status(400).json({ error: 'Change order price and original PO amount are required for a Change Order' });
    }
    const poFile = req.files?.po_file?.[0];

    const built = memoFieldsFor(req.body, req.orgId);
    const template = built.template;
    const newTotalAmount = built.newTotalAmount;

    const fields = built.fields;

    const { mergedPdf, memoDocx } = await buildPackage({
      orgId: req.orgId,
      projectId: req.body.project_id ? Number(req.body.project_id) : null,
      template, fields,
      proposalBytes: proposalFile.buffer,
      poBytes: poFile?.buffer || null,
    });

    const baseName = proposalFile.originalname.replace(/\.pdf$/i, '');
    const mergedFileName = `${baseName}_processed.pdf`;

    const proposalKey = (await storage.storeFile('proposal', proposalFile.buffer, proposalFile.mimetype, proposalFile.originalname)).key;
    const poKey = poFile ? (await storage.storeFile('proposal', poFile.buffer, poFile.mimetype, poFile.originalname)).key : null;
    const mergedKey = (await storage.storeFile('proposal', mergedPdf, 'application/pdf', mergedFileName)).key;
    const memoDocxName = memoDocx ? `${baseName}_memo.docx` : null;
    const memoDocxKey = memoDocx
      ? (await storage.storeFile('proposal', memoDocx, DOCX_MIME, memoDocxName)).key
      : null;

    const result = db.prepare(`
      INSERT INTO proposal_intakes (
        org_id, intake_type, vendor_name, project_name, po_number, proposal_date,
        scope_of_work, total_price, change_order_price, original_po_amount, new_total_amount,
        memo_template_id,
        proposal_file_name, proposal_file, proposal_file_key, po_file_name, po_file, po_file_key,
        merged_file_name, merged_pdf, merged_pdf_key, created_by,
        memo_docx, memo_docx_key, memo_docx_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId,
      intake_type, fields.vendor_name, fields.project_name, fields.po_number, fields.date,
      fields.scope_of_work, fields.total_price, fields.change_order_price || null,
      fields.original_po_amount || null, fields.new_total_amount || null,
      template.id,
      proposalFile.originalname, proposalKey ? Buffer.alloc(0) : proposalFile.buffer, proposalKey,
      poFile?.originalname || null, poFile ? (poKey ? Buffer.alloc(0) : poFile.buffer) : null, poKey,
      mergedFileName, mergedKey ? Buffer.alloc(0) : mergedPdf, mergedKey, fields.from_name,
      memoDocx ? (memoDocxKey ? Buffer.alloc(0) : memoDocx) : null, memoDocxKey, memoDocxName
    );

    res.json({
      id: result.lastInsertRowid,
      merged_file_name: mergedFileName,
      // Tells the page whether to offer the Word download alongside the PDF package.
      memo_docx_name: memoDocxName,
    });
  } catch (err) {
    console.error('Proposal intake error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, intake_type, project_name } = req.query;
  const scope = access.visibilityClause(req.user, req.orgId, { projectColumn: null });
  // memo_docx_name travels with the list so the history can offer the Word memo and the
  // put-it-back button on an intake from last week, not only on the one just generated. A PM
  // rarely edits the memo in the same minute they created it.
  // scope_of_work travels with the list so the history can open the edit form filled in, rather
  // than fetching the row again the moment the user clicks Edit.
  let sql = `SELECT id, intake_type, vendor_name, project_name, po_number, proposal_date,
             scope_of_work,
             total_price, change_order_price, original_po_amount, new_total_amount,
             proposal_file_name, po_file_name, merged_file_name, memo_docx_name,
             created_by, created_at
             FROM proposal_intakes WHERE ${scope.sql}`;
  const params = [...scope.params];
  if (project_name) { sql += ' AND project_name = ?'; params.push(project_name); }
  if (intake_type) { sql += ' AND intake_type = ?'; params.push(intake_type); }
  if (search) {
    sql += ' AND (vendor_name LIKE ? OR project_name LIKE ? OR po_number LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id/download', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const bytes = await storage.readFile({ key: row.merged_pdf_key, blob: row.merged_pdf });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.merged_file_name}"`);
  res.send(bytes);
});

// The memo as the organization's own Word document, filled in. Offered alongside the merged
// PDF package rather than instead of it: the PDF is what gets circulated for signature, this
// is what they edit or print themselves.
router.get('/:id/memo.docx', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.memo_docx_key && !row.memo_docx) {
    return res.status(404).json({ error: 'No Word memo was produced for this intake.' });
  }
  const bytes = await storage.readFile({ key: row.memo_docx_key, blob: row.memo_docx });
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', DOCX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${row.memo_docx_name || 'memo.docx'}"`);
  res.send(bytes);
});

// Correcting the details and rebuilding the package.
//
// Almost nothing in a memo varies: the scope summary, occasionally the project or vendor name, the
// odd figure. Those are the values Coaster reads off the proposal, and reading is where it can be
// wrong — a scope summarised too tightly, a project named as the vendor writes it rather than as
// the owner does. Being able to correct THE FIELD and produce the memo again is the whole of what
// a PM needs, and it is a far better answer than editing prose in Word and hoping the formatting
// survives a round trip.
//
// The proposal and the PO are the ones already on file; only the memo in front of them changes.
router.put('/:id', async (req, res) => {
  try {
    const row = visibleRow(req);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const intakeType = row.intake_type;
    if (intakeType === 'Change Order'
      && (!req.body.change_order_price || !req.body.original_po_amount)) {
      return res.status(400).json({
        error: 'A change order needs both the change order amount and the original PO amount.',
      });
    }

    const proposalBytes = await storage.readFile({
      key: row.proposal_file_key, blob: row.proposal_file,
    });
    if (!proposalBytes) {
      return res.status(409).json({
        error: 'The original proposal PDF is no longer on file, so the package cannot be rebuilt.',
      });
    }
    const poBytes = (row.po_file_key || row.po_file)
      ? await storage.readFile({ key: row.po_file_key, blob: row.po_file })
      : null;

    // The intake type and the memo template are not things this screen edits, so they come from
    // the row rather than from the request — a form that omits one must not silently turn a change
    // order into a new-vendor memo.
    const { template, fields, newTotalAmount } = memoFieldsFor({
      ...req.body,
      intake_type: intakeType,
      memo_template_id: row.memo_template_id,
    }, req.orgId);

    const { mergedPdf, memoDocx } = await buildPackage({
      orgId: req.orgId,
      projectId: req.body.project_id ? Number(req.body.project_id) : null,
      template, fields, proposalBytes, poBytes,
    });

    const previousMerged = row.merged_pdf_key;
    const previousDocx = row.memo_docx_key;
    const mergedKey = (await storage.storeFile(
      'proposal', mergedPdf, 'application/pdf', row.merged_file_name || 'processed.pdf')).key;
    const docxName = row.memo_docx_name
      || `${(row.proposal_file_name || 'proposal').replace(/\.pdf$/i, '')}_memo.docx`;
    const docxKey = (await storage.storeFile('proposal', memoDocx, DOCX_MIME, docxName)).key;

    db.prepare(`
      UPDATE proposal_intakes SET
        vendor_name=?, project_name=?, po_number=?, proposal_date=?, scope_of_work=?,
        total_price=?, change_order_price=?, original_po_amount=?, new_total_amount=?,
        merged_pdf=?, merged_pdf_key=?, memo_docx=?, memo_docx_key=?, memo_docx_name=?
      WHERE id=?
    `).run(
      fields.vendor_name, fields.project_name, fields.po_number, fields.date, fields.scope_of_work,
      fields.total_price, fields.change_order_price || null, fields.original_po_amount || null,
      newTotalAmount || null,
      mergedKey ? Buffer.alloc(0) : mergedPdf, mergedKey,
      docxKey ? Buffer.alloc(0) : memoDocx, docxKey, docxName,
      row.id,
    );

    // Only once the replacements are stored. A failed write must not cost a working package.
    const stale = [previousMerged, previousDocx].filter(k => k && k !== mergedKey && k !== docxKey);
    if (stale.length) await storage.remove(stale);

    res.json({
      id: row.id,
      merged_file_name: row.merged_file_name,
      memo_docx_name: docxName,
      regenerated: true,
    });
  } catch (err) {
    console.error('Proposal intake regenerate error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const row = visibleRow(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM proposal_intakes WHERE id=?').run(req.params.id);
  await storage.remove([row?.proposal_file_key, row?.po_file_key, row?.merged_pdf_key, row?.memo_docx_key]);
  res.json({ success: true });
});

module.exports = router;
