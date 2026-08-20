// The document types that are the customer's own Word templates rather than project material.
//
// A memo cover and a progress report template are uploaded to a project's Shared Documents like
// anything else, but they are not something a review should ever read: they are the blank forms
// this app fills in. Every picker that offers "which documents should I look at?" filters them
// out, and each of those pickers used to name 'memo-cover' by hand — so adding a second template
// type would have quietly offered it up as reference material.
//
// Mirrors COVER_KINDS in backend/lib/coverTemplates.js.
export const WORD_TEMPLATES = ['memo-cover', 'progress-cover'];

export const isWordTemplate = docType => WORD_TEMPLATES.includes(docType);
