const express = require('express');
const router = express.Router();
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MEDIA_TYPES = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

function buildPrompt(docType, contextNotes, generalSubType) {
  const ctx = contextNotes ? `\n\nUser context: ${contextNotes}` : '';
  const prompts = {
    'Pay Application': `You are a construction project manager reviewing a pay application for Olivier Inc., an MEP consulting firm. Review this pay application carefully.${ctx}

Structure your response as follows:

## Pay Application Review

### Billing Summary
[Summarize what is being billed — subcontractor, scope, period]

### Math Check
[Verify: Scheduled Value, Previously Billed, Current Billing, Balance to Finish. Call out any arithmetic errors]

### Retainage Check
[Confirm retainage percentage is applied correctly and consistently]

### Line Item Flags
[List any line items that seem inflated, vague, or inconsistent with description]

### Missing Documentation
[Note any backup or documentation that should accompany this pay app but appears absent]

### Overall Recommendation
**[APPROVE / APPROVE WITH COMMENTS / HOLD FOR CLARIFICATION]**
[1–2 sentence justification]`,

    'Invoice': `You are a construction project manager reviewing an invoice for Olivier Inc., an MEP consulting firm.${ctx}

Structure your response as follows:

## Invoice Review

### Vendor & Scope
[Identify vendor, amount, and scope described]

### Line Item Analysis
[Flag vague line items or missing PO references. Note if totals add up]

### Red Flags
[List any concerns — duplicates, unsupported charges, missing references]

### Overall Recommendation
**[APPROVE / QUERY / REJECT]**
[1–2 sentence justification]`,

    'RFI': `You are a construction project manager reviewing an RFI for Olivier Inc., an MEP consulting firm.${ctx}

Structure your response as follows:

## RFI Review

### Summary
[Summarize what is being asked]

### Completeness Assessment
[Flag if the RFI is vague, incomplete, or missing necessary information]

### Could This Be Self-Answered?
[Note if the question could have been answered by reviewing existing drawings, specs, or submittals]

### Suggested Response Direction
[Provide a draft direction or answer framework for the team to respond with]

### Urgency Classification
**[HIGH / MEDIUM / LOW]**
[Brief reasoning]`,

    'Submittal': `You are a construction project manager reviewing a submittal for Olivier Inc., an MEP consulting firm.${ctx}

Structure your response as follows:

## Submittal Review

### Product / Material / Equipment Identified
[What is being submitted]

### Spec Section Reference
[Note if spec section is included and appears correct, or flag if missing]

### Missing Information
[Flag missing cut sheets, certifications, compliance statements, or required submittals]

### Review Action
**[APPROVED / APPROVED AS NOTED / REVISE AND RESUBMIT / REJECTED]**
[Notes justifying the action and any conditions]`,

    'Change Order': `You are a construction project manager reviewing a change order for Olivier Inc., an MEP consulting firm.${ctx}

Structure your response as follows:

## Change Order Review

### Scope Change Summary
[Describe the proposed change clearly]

### Pricing Analysis
[Flag if pricing seems unreasonable, lacks labor/material breakdown, or has no backup]

### Schedule Impact
[Note whether schedule impact is addressed; flag if it is missing]

### Justification Assessment
[Note whether the change is adequately justified — owner-directed, differing site condition, design error, etc.]

### Overall Recommendation
**[APPROVE / NEGOTIATE / REJECT]**
[1–2 sentence justification]`,

    'Construction Drawing': `You are a construction project manager reviewing construction drawings for Olivier Inc., an MEP consulting firm.${ctx}

Structure your response as follows:

## Drawing Review

### Discipline & Scope
[Summarize what discipline (Mechanical, Electrical, Plumbing, Civil, etc.) and scope the drawing covers]

### Coordination Conflicts
[Flag any obvious conflicts with other trades or systems]

### Missing Details / Unclear Callouts
[Note details that appear incomplete, ambiguous, or underspecified]

### Likely RFI Generators
[List items that will likely generate field RFIs during construction]

### Scope Boundary Issues
[Flag any ambiguity in who is responsible for what work]`,

    'General / Other': `You are a construction project manager reviewing a document for Olivier Inc., an MEP consulting firm.${ctx}${generalSubType ? `\n\nDocument type specified by user: ${generalSubType}` : ''}

Structure your response as follows:

## Document Review${generalSubType ? ` — ${generalSubType}` : ''}

### Document Summary
[Describe what this document is and its purpose]

### Key Information Extracted
[Pull out the most important facts, dates, amounts, or action items]

### Issues or Concerns
[Note anything unclear, missing, inconsistent, or requiring follow-up]

### Recommended Action
[What should the project team do with this document]`,
  };
  return prompts[docType] || prompts['General / Other'];
}

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { document_type, context_notes, project_name, general_sub_type } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const base64 = file.buffer.toString('base64');
    const mimeType = file.mimetype;
    const isImage = mimeType.startsWith('image/');
    const isPDF = mimeType === 'application/pdf';

    let messageContent = [];

    const prompt = buildPrompt(document_type, context_notes, general_sub_type);

    if (isImage) {
      messageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64 }
        },
        { type: 'text', text: prompt }
      ];
    } else if (isPDF) {
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        },
        { type: 'text', text: prompt }
      ];
    } else {
      // For Word/Excel — send as text with a note
      messageContent = [
        {
          type: 'text',
          text: `${prompt}\n\n[Note: File "${file.originalname}" (${mimeType}) was uploaded. The document content could not be rendered as an image or PDF. Please review based on the context notes provided and any visible metadata.]`
        }
      ];
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: messageContent }]
    });

    const aiReview = response.content[0].text;

    const result = db.prepare(`
      INSERT INTO document_reviews (project_name, document_type, file_name, context_notes, ai_review)
      VALUES (?, ?, ?, ?, ?)
    `).run(project_name || null, document_type, file.originalname, context_notes || null, aiReview);

    res.json({ id: result.lastInsertRowid, review: aiReview });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { search, document_type, project_name } = req.query;
  let sql = 'SELECT * FROM document_reviews WHERE 1=1';
  const params = [];
  if (document_type) { sql += ' AND document_type = ?'; params.push(document_type); }
  if (project_name) { sql += ' AND project_name LIKE ?'; params.push(`%${project_name}%`); }
  if (search) {
    sql += ' AND (file_name LIKE ? OR ai_review LIKE ? OR context_notes LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM document_reviews WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
