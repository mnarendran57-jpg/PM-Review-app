const db = require('../database');
const storage = require('./storage');
const { coverKindFor } = require('./coverTemplates');

// Which of the customer's Word documents to fill, for this project.
//
// There are two places one can be on file and a rule between them:
//
//   the project's own, on its Shared Documents — a job that needs a different format
//   the organization's, in Settings — the company's standard, fed once by an admin
//
// The project's wins where it exists. It was uploaded against this job deliberately, by someone
// looking at this job, which is better evidence of intent than a company default that predates it.
//
// This is one function rather than a lookup repeated in each module because the rule is the whole
// feature. The version of it that lived inside Proposal Intake read only the project, so a company
// that had fed Coaster its memo letter still got the built-in memo on every project that had not
// been given a copy — the template was on file and simply never looked for.
//
// UNCONFIRMED TEMPLATES ARE IGNORED, at both levels. The placeholder mapping is a model's reading
// of the customer's document, and one that nobody has checked, filled and sent to an owner over
// somebody's signature, is exactly what the confirm step exists to prevent. A template awaiting
// review is treated as no template at all, which falls back to what the module did before.

const parseTerms = row => {
  try { return JSON.parse(row.terms || '{}'); } catch { return null; }
};

// Returns { source: 'project' | 'organization', row, terms } or null.
function findCover({ docType, projectId, orgId }) {
  if (!coverKindFor(docType)) return null;

  if (projectId) {
    const row = db.prepare(`
      SELECT * FROM project_contracts
      WHERE project_id = ? AND doc_type = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(projectId, docType);
    const terms = row && parseTerms(row);
    if (terms?.confirmed) return { source: 'project', row, terms };
  }

  if (orgId) {
    const row = db.prepare(
      `SELECT * FROM org_templates WHERE org_id = ? AND doc_type = ?`
    ).get(orgId, docType);
    const terms = row && parseTerms(row);
    if (terms?.confirmed) return { source: 'organization', row, terms };
  }

  return null;
}

// The same lookup with the bytes read. Answers null when there is no template, or when the file
// behind the row cannot be read — a missing object in storage should cost the customer's
// formatting, not the document they were waiting for.
async function loadCover({ docType, projectId, orgId }) {
  const found = findCover({ docType, projectId, orgId });
  if (!found) return null;
  const buffer = await storage.readFile({ key: found.row.file_key, blob: found.row.file_blob });
  if (!buffer || !buffer.length) return null;
  return { ...found, buffer };
}

module.exports = { findCover, loadCover };
