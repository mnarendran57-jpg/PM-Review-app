const express = require('express');
const router = express.Router();
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const { renderMemoPdf, mergePdfBuffers } = require('../lib/pdfGen');
const { friendlyAiError } = require('../lib/aiErrors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function safeJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  return JSON.parse(match[0]);
}

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

    const base64 = file.buffer.toString('base64');
    const prompt = `You are reviewing a vendor proposal PDF for a construction project at Olivier Inc., an MEP consulting firm. Extract the following fields and respond with ONLY a raw JSON object (no markdown, no commentary):

{
  "vendor_name": "the vendor/company submitting the proposal",
  "proposal_date": "the date on the proposal, e.g. proposal date or quote date, formatted as MM/DD/YYYY",
  "project_name": "the name or title of the project being quoted",
  "scope_of_work": "a concise 2-4 sentence summary of the work described",
  "total_price": "the final/total dollar amount quoted, formatted like $12,345.00"
}

If any field cannot be found with confidence, use "Not specified" as its value.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const extracted = safeJsonFromText(response.content[0].text);
    res.json(extracted);
  } catch (err) {
    console.error('Extract error:', err);
    res.status(err.status === 429 ? 429 : 500).json({ error: friendlyAiError(err) });
  }
});

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

    const templateRow = memo_template_id
      ? db.prepare('SELECT * FROM memo_templates WHERE id=?').get(memo_template_id)
      : db.prepare('SELECT * FROM memo_templates WHERE is_default=1').get();
    if (!templateRow) return res.status(400).json({ error: 'No memo template found' });
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
        : ''
    };

    const memoPdf = await renderMemoPdf(template, fields);
    const mergedPdf = await mergePdfBuffers([memoPdf, proposalFile.buffer, poFile?.buffer]);

    const baseName = proposalFile.originalname.replace(/\.pdf$/i, '');
    const mergedFileName = `${baseName}_processed.pdf`;

    const result = db.prepare(`
      INSERT INTO proposal_intakes (
        intake_type, vendor_name, project_name, po_number, proposal_date,
        scope_of_work, total_price, change_order_price, original_po_amount, new_total_amount,
        memo_template_id,
        proposal_file_name, proposal_file, po_file_name, po_file,
        merged_file_name, merged_pdf, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intake_type, fields.vendor_name, fields.project_name, fields.po_number, fields.date,
      fields.scope_of_work, fields.total_price, fields.change_order_price || null,
      fields.original_po_amount || null, fields.new_total_amount || null,
      template.id,
      proposalFile.originalname, proposalFile.buffer,
      poFile?.originalname || null, poFile?.buffer || null,
      mergedFileName, mergedPdf, fields.from_name
    );

    res.json({ id: result.lastInsertRowid, merged_file_name: mergedFileName });
  } catch (err) {
    console.error('Proposal intake error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, intake_type } = req.query;
  let sql = `SELECT id, intake_type, vendor_name, project_name, po_number, proposal_date,
             total_price, change_order_price, original_po_amount, new_total_amount,
             proposal_file_name, po_file_name, merged_file_name, created_by, created_at
             FROM proposal_intakes WHERE 1=1`;
  const params = [];
  if (intake_type) { sql += ' AND intake_type = ?'; params.push(intake_type); }
  if (search) {
    sql += ' AND (vendor_name LIKE ? OR project_name LIKE ? OR po_number LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT merged_file_name, merged_pdf FROM proposal_intakes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.merged_file_name}"`);
  res.send(Buffer.from(row.merged_pdf));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM proposal_intakes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
