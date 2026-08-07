const db = require('../database');
const storage = require('./storage');

// One answer to "whose letterhead goes on this document?".
//
// Previously each PDF worked it out for itself, and all of them got it wrong the same way:
// the address came from whichever memo template sorted first across the entire database, and
// the logo was a file on disk. Every customer's outgoing documents therefore carried the
// first customer's branding. Reading it from the organization, in one place, is what makes
// that impossible rather than merely fixed.

const LOGO_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png']);

// Returns { companyName, logo: { buffer, mimeType } | null }. A customer that has uploaded
// nothing gets nulls, and every renderer treats that as "print no letterhead" rather than
// falling back to somebody else's.
async function brandingFor(orgId) {
  if (!orgId) return { companyName: null, logo: null };

  const org = db.prepare(
    `SELECT name, letterhead, logo_key, logo_blob, logo_mime FROM organizations WHERE id=?`
  ).get(orgId);
  if (!org) return { companyName: null, logo: null };

  // The organization's own letterhead wins. Its default memo template is the fallback, since
  // that is where the address lived before this existed.
  let companyName = (org.letterhead || '').trim() || null;
  if (!companyName) {
    const tpl = db.prepare(`
      SELECT company_name FROM memo_templates
      WHERE org_id = ? AND company_name IS NOT NULL AND TRIM(company_name) <> ''
      ORDER BY is_default DESC, id ASC LIMIT 1
    `).get(orgId);
    companyName = (tpl?.company_name || '').trim() || null;
  }

  let logo = null;
  if (org.logo_key || org.logo_blob) {
    const buffer = await storage.readFile({ key: org.logo_key, blob: org.logo_blob });
    if (buffer && buffer.length) logo = { buffer, mimeType: org.logo_mime || 'image/jpeg' };
  }

  return { companyName, logo, orgName: org.name };
}

// Embeds a logo into a pdf-lib document, choosing the decoder by type. Returns null rather
// than throwing on a file pdf-lib cannot read — a broken logo should cost the letterhead, not
// the whole document the user was waiting for.
async function embedLogo(pdfDoc, logo) {
  if (!logo?.buffer) return null;
  try {
    return logo.mimeType === 'image/png'
      ? await pdfDoc.embedPng(logo.buffer)
      : await pdfDoc.embedJpg(logo.buffer);
  } catch (err) {
    console.warn('[branding] logo could not be embedded:', err.message);
    return null;
  }
}

async function setLogo({ orgId, buffer, mimeType, originalName }) {
  if (!LOGO_TYPES.has(mimeType)) {
    const err = new Error('The logo must be a JPG or PNG image.');
    err.status = 400;
    throw err;
  }
  const previous = db.prepare(`SELECT logo_key FROM organizations WHERE id=?`).get(orgId);
  const { key } = await storage.storeFile('branding', buffer, mimeType, originalName);
  db.prepare(`UPDATE organizations SET logo_key=?, logo_blob=?, logo_mime=? WHERE id=?`)
    .run(key, key ? null : buffer, mimeType, orgId);
  if (previous?.logo_key && previous.logo_key !== key) await storage.remove([previous.logo_key]);
}

async function clearLogo(orgId) {
  const previous = db.prepare(`SELECT logo_key FROM organizations WHERE id=?`).get(orgId);
  db.prepare(`UPDATE organizations SET logo_key=NULL, logo_blob=NULL, logo_mime=NULL WHERE id=?`).run(orgId);
  if (previous?.logo_key) await storage.remove([previous.logo_key]);
}

module.exports = { brandingFor, embedLogo, setLogo, clearLogo, LOGO_TYPES };
