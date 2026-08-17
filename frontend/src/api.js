import axios from 'axios';

// Browser-stored session keys. Declared up front because the interceptors below read
// them, and keeping the declaration adjacent to its use avoids a temporal-dead-zone trap
// if anything ever runs during module evaluation.
const TOKEN_KEY = 'pm_review_token';
const USER_KEY = 'pm_review_user';
const ORG_KEY = 'pm_review_org';
const PROGRAM_KEY = 'pm_review_program';
const configuredBase = import.meta.env.VITE_API_BASE_URL || '/api';
const apiBaseUrl = configuredBase.endsWith('/api')
  ? configuredBase.replace(/\/$/, '')
  : `${configuredBase.replace(/\/$/, '')}/api`;
// Long-running AI/upload calls override this per request (see AI_TIMEOUT below). The
// default keeps ordinary reads/writes from hanging forever when the backend is
// unreachable — which is exactly what happens on a deployed frontend with no backend
// behind it: without a timeout, every request spins indefinitely and the app "lags".
const DEFAULT_TIMEOUT = 20000;   // 20s — plenty for any DB-backed request
const AI_TIMEOUT = 180000;       // 3min — document extraction / report generation
// A whole drawing set is read in one request, 40 pages at a time, one pass after another, and
// the account's per-minute allowance forces a wait between them. Eight passes is realistic for
// a 300-page set, so three minutes guaranteed a timeout on exactly the uploads this feature
// exists for — the browser gave up long before the server had finished.
const LONG_AI_TIMEOUT = 1200000; // 20min — multi-pass review of a full document set

const api = axios.create({ baseURL: apiBaseUrl, timeout: DEFAULT_TIMEOUT });

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Which organization the user is working in travels with every request. The server
  // always re-checks their membership of it, so this is a convenience, not a grant.
  // A call may name its own organization — the platform owner's Team page lists every customer
  // at once, so acting on one must not depend on which is selected in the header. An explicit
  // header on the request wins; without one, the selected organization travels by default.
  const org = localStorage.getItem(ORG_KEY);
  if (org && !config.headers['X-Org-Id']) {
    try { config.headers['X-Org-Id'] = String(JSON.parse(org).id); } catch { /* ignore */ }
  }
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    const isLoginCall = err.config?.url?.includes('/auth/login');
    if (err.response?.status === 401 && !isLoginCall) {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login';
    }
    // The selected organization is no longer valid — it was deleted, or the user's access
    // to it was revoked. Without this the app would keep showing a stale, empty shell of
    // an organization the server refuses to answer for, so send them back to the picker.
    const orgGone = err.response?.status === 400
      && /no organization selected/i.test(err.response?.data?.error || '');
    if (orgGone && !window.location.pathname.startsWith('/organizations')) {
      localStorage.removeItem(ORG_KEY);
      localStorage.removeItem(PROGRAM_KEY);
      window.location.href = '/organizations';
    }
    // Turn a timeout / unreachable-backend failure into a clear, consistent message so
    // callers can surface "can't reach the server" instead of appearing to hang. A
    // timeout is called out separately: on a long document it usually means the work is
    // still running, and "the server is offline" would send the user looking in the
    // wrong place.
    if (!err.response) {
      err.friendlyMessage = err.code === 'ECONNABORTED'
        // Reading a document no longer happens inside a request, so this can no longer mean "the
        // document was too big" — and it must never again suggest splitting the PDF, which is not
        // an answer this application is allowed to give. What is left is an ordinary slow or
        // dropped connection.
        ? 'The connection to the server timed out. Check your connection and try again — nothing was lost.'
        : 'Cannot reach the server. It may be offline or still starting up — check that the backend is running and reachable, then try again.';
    }

    // An endpoint the app called does not exist on this server. Express answers an
    // unmatched route with an HTML page, whereas a route that ran and found nothing
    // answers with JSON — so the HTML body is what distinguishes "this version of the
    // server has never heard of that endpoint" from an ordinary "not found".
    //
    // In practice this means the deployed frontend and backend are different versions:
    // the backend redeploys itself on every push, the frontend does not. Saying so
    // beats a generic failure that sends everyone hunting through the actual feature.
    const body = err.response?.data;
    if (err.response?.status === 404 && typeof body === 'string' && /^\s*<!doctype html/i.test(body)) {
      err.friendlyMessage = 'This page is out of step with the server — it is asking for something the server no longer provides. Rebuild and redeploy the site, then try again.';
    }
    return Promise.reject(err);
  }
);

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }).then(r => {
    localStorage.setItem(TOKEN_KEY, r.data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(r.data.user));
    return r.data;
  }),
  me: () => api.get('/auth/me').then(r => {
    localStorage.setItem(USER_KEY, JSON.stringify(r.data.user));
    return r.data;
  }),
  changePassword: data => api.post('/auth/change-password', data).then(r => r.data),
  // A person's own details. The stored session is refreshed with the answer, so the app stops
  // showing the name they had before they changed it.
  updateProfile: data => api.patch('/auth/profile', data).then(r => {
    localStorage.setItem(USER_KEY, JSON.stringify(r.data.user));
    return r.data;
  }),
  // Public: no session yet. The link itself is only ever emailed, never returned here.
  forgotPassword: email => api.post('/auth/forgot-password', { email }).then(r => r.data),
  getReset: token => api.get(`/auth/reset-password/${token}`).then(r => r.data),
  resetPassword: (token, password) =>
    api.post(`/auth/reset-password/${token}`, { password }).then(r => r.data),
  logout: () => {
    [TOKEN_KEY, USER_KEY, ORG_KEY, PROGRAM_KEY].forEach(k => localStorage.removeItem(k));
  },
  isLoggedIn: () => !!localStorage.getItem(TOKEN_KEY),
  setToken: token => localStorage.setItem(TOKEN_KEY, token),
  // Takes a freshly-issued session (e.g. straight after accepting an invitation) and
  // stores it as though the user had just signed in.
  adopt: ({ token, user }) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  // The signed-in person, as last known. Used to decide which admin screens to show.
  user: () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  },
};

function stored(key) {
  return {
    get: () => {
      try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
    },
    set: value => localStorage.setItem(key, JSON.stringify(value)),
    clear: () => localStorage.removeItem(key),
  };
}

// The organization the user picked after signing in — one account can reach several, so
// this is what scopes everything below it. Changing it clears the chosen program, since
// programs belong to an organization.
const orgStore = stored(ORG_KEY);
export const selectedOrg = {
  ...orgStore,
  set: org => { orgStore.set(org); localStorage.removeItem(PROGRAM_KEY); },
  clear: () => { orgStore.clear(); localStorage.removeItem(PROGRAM_KEY); },
};

// The program within that organization.
export const selectedProgram = stored(PROGRAM_KEY);

export const orgsApi = {
  // Organizations this user can reach, straight from the server.
  mine: () => api.get('/auth/me').then(r => r.data.organizations || []),
};

export const programsApi = {
  list: () => api.get('/programs').then(r => r.data),
  get: id => api.get(`/programs/${id}`).then(r => r.data),
  create: data => api.post('/programs', data).then(r => r.data),
  update: (id, data) => api.put(`/programs/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/programs/${id}`).then(r => r.data),
};

// Every member call acts on ONE organization. Normally that is whichever the user has selected,
// which the client sends as a header on every request. The platform owner is the exception: their
// Team page lists all customers at once, so acting on a particular one has to name it rather than
// requiring them to switch context between every click. The server validates it either way — a
// supplied id gets you nothing you could not already reach.
// Named as a HEADER rather than a query parameter. The server prefers the header when both are
// present, so a query parameter would have been silently overridden by whichever organization
// happened to be selected — the owner would have clicked "add administrator" on one customer and
// added them to another.
const inOrg = orgId => (orgId ? { headers: { 'X-Org-Id': String(orgId) } } : undefined);

export const adminApi = {
  // People in one organization — the active one unless `orgId` names another.
  listMembers: orgId => api.get('/admin/members', inOrg(orgId)).then(r => r.data),
  listPeople: () => api.get('/admin/people').then(r => r.data),
  addMember: (data, orgId) => api.post('/admin/members', data, inOrg(orgId)).then(r => r.data),
  updateMember: (userId, data, orgId) =>
    api.put(`/admin/members/${userId}`, data, inOrg(orgId)).then(r => r.data),
  removeMember: (userId, orgId) =>
    api.delete(`/admin/members/${userId}`, inOrg(orgId)).then(r => r.data),
  // What one person can reach in that organization, and rewriting it wholesale.
  getMemberAccess: (userId, orgId) =>
    api.get(`/admin/members/${userId}/access`, inOrg(orgId)).then(r => r.data),
  setMemberAccess: (userId, data, orgId) =>
    api.put(`/admin/members/${userId}/access`, data, inOrg(orgId)).then(r => r.data),
  // Invitations — the preferred way to add someone, since they set their own password.
  listInvitations: orgId => api.get('/admin/invitations', inOrg(orgId)).then(r => r.data),
  invite: (data, orgId) => api.post('/admin/invitations', data, inOrg(orgId)).then(r => r.data),
  revokeInvitation: id => api.delete(`/admin/invitations/${id}`).then(r => r.data),
  // Coaster plans. Reading and setting a customer's plan is vendor-only; "my plan" is what
  // the signed-in user's own organization includes, used to hide tools they haven't bought.
  listPlans: () => api.get('/admin/plans').then(r => r.data),
  setOrgPlan: (orgId, data) => api.put(`/admin/organizations/${orgId}/plan`, data).then(r => r.data),
  myPlan: () => api.get('/admin/my-plan').then(r => r.data),
  // Vendor-only: customer organizations.
  listOrganizations: () => api.get('/admin/organizations').then(r => r.data),
  createOrganization: data => api.post('/admin/organizations', data).then(r => r.data),
  updateOrganization: (id, data) => api.put(`/admin/organizations/${id}`, data).then(r => r.data),
};

// Public: used by someone who has an invitation link but no account yet.
export const invitationsApi = {
  get: token => api.get(`/invitations/${token}`).then(r => r.data),
  accept: (token, data) => api.post(`/invitations/${token}/accept`, data).then(r => r.data),
};

export const projectMembersApi = {
  list: projectId => api.get(`/projects/${projectId}/members`).then(r => r.data),
  add: (projectId, data) => api.post(`/projects/${projectId}/members`, data).then(r => r.data),
  remove: (projectId, memberId) => api.delete(`/projects/${projectId}/members/${memberId}`).then(r => r.data),
};

export const projectsApi = {
  list: params => api.get('/projects', { params }).then(r => r.data),
  get: id => api.get(`/projects/${id}`).then(r => r.data),
  create: data => api.post('/projects', data).then(r => r.data),
  update: (id, data) => api.put(`/projects/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/projects/${id}`).then(r => r.data),
};

// The RFI log. Same shape as the submittal log — one entry per RFI with a revision behind it
// for each trip to the A/E — plus the predicted answer, which is run on demand and kept
// separate from the log because it is for the PM's understanding, not a record of anything.
export const rfisApi = {
  list: params => api.get('/rfis', { params }).then(r => r.data),
  get: id => api.get(`/rfis/${id}`).then(r => r.data),
  extract: formData => api.post('/rfis/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  create: formData => api.post('/rfis', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  update: (id, data) => api.patch(`/rfis/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/rfis/${id}`).then(r => r.data),

  addRevision: (id, formData) => api.post(`/rfis/${id}/revisions`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  updateRevision: (id, revId, data) =>
    api.patch(`/rfis/${id}/revisions/${revId}`, data).then(r => r.data),
  extractResponse: (id, revId, formData) =>
    api.post(`/rfis/${id}/revisions/${revId}/extract-response`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
    }).then(r => r.data),
  recordResponse: (id, revId, formData) =>
    api.post(`/rfis/${id}/revisions/${revId}/response`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
    }).then(r => r.data),

  // Reads the RFI against the chosen documents and suggests how the A/E is likely to answer.
  // Two AI passes over a drawing set, so it is slow — hence the long timeout.
  analyze: (id, formData) => api.post(`/rfis/${id}/analysis`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  // The same two passes, run while the RFI is still being entered. Saves nothing until the
  // token it returns is handed back to create().
  previewAnalysis: formData => api.post('/rfis/preview-analysis', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  downloadAnalysis: async (id, fileName) => {
    const res = await api.get(`/rfis/${id}/analysis.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `rfi_${id}_suggested_answer.md`);
  },

  // Compares the A/E's actual answer with the one Coaster predicted. Runs automatically when
  // the response is recorded; this is for re-running it, or running it after a failure.
  reviewResponse: (id, revId) =>
    api.post(`/rfis/${id}/revisions/${revId}/review`, {}, { timeout: AI_TIMEOUT }).then(r => r.data),
  downloadResponseReview: async (id, fileName) => {
    const res = await api.get(`/rfis/${id}/response-review.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `rfi_${id}_response_review.md`);
  },

  fileUrl: (id, fileId) => `${apiBaseUrl}/rfis/${id}/files/${fileId}`,
  downloadCsv: async projectId => {
    const res = await api.get('/rfis/export.csv', {
      params: projectId ? { project_id: projectId } : undefined, responseType: 'blob',
    });
    triggerDownload(res.data, 'RFI_Log.csv');
  },
};

// The submittal log. A submittal is one entry with a revision behind it for each trip to
// the A/E and back, so the calls below are grouped the same way: the entry, its revisions,
// and the response that closes a revision.
export const submittalsApi = {
  list: params => api.get('/submittals', { params }).then(r => r.data),
  get: id => api.get(`/submittals/${id}`).then(r => r.data),
  // Reads an uploaded submittal so the entry form opens pre-filled. Saves nothing.
  // Predicts the review before the submittal is logged. LONG_AI_TIMEOUT because the governing
  // section has to be found in the specification before it can be read.
  previewAnalysis: formData => api.post('/submittals/preview-analysis', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: LONG_AI_TIMEOUT,
  }).then(r => r.data),
  extract: formData => api.post('/submittals/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  create: formData => api.post('/submittals', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  update: (id, data) => api.patch(`/submittals/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/submittals/${id}`).then(r => r.data),

  // A resubmittal — the next revision of an existing entry.
  addRevision: (id, formData) => api.post(`/submittals/${id}/revisions`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  updateRevision: (id, revId, data) =>
    api.patch(`/submittals/${id}/revisions/${revId}`, data).then(r => r.data),
  // Reads the A/E's stamp off the returned document. Suggestion only — nothing is saved
  // until recordResponse is called with the action the user confirmed.
  extractResponse: (id, revId, formData) =>
    api.post(`/submittals/${id}/revisions/${revId}/extract-response`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
    }).then(r => r.data),
  recordResponse: (id, revId, formData) =>
    api.post(`/submittals/${id}/revisions/${revId}/response`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
    }).then(r => r.data),

  // Reads the submittal against the chosen specification and predicts how the A/E will
  // review it. LONG_AI_TIMEOUT because a project manual is searched before it is read, and the
  // account's per-minute allowance puts a wait between the two calls.
  analyze: (id, formData) => api.post(`/submittals/${id}/analysis`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: LONG_AI_TIMEOUT,
  }).then(r => r.data),
  // Compares the A/E's actual review with that prediction. Runs automatically when a review is
  // recorded; this is the retry, for when it did not.
  compareReview: (id, revId) =>
    api.post(`/submittals/${id}/revisions/${revId}/comparison`, {}, { timeout: AI_TIMEOUT }).then(r => r.data),
  analysisMarkdownUrl: id => `${apiBaseUrl}/submittals/${id}/analysis.md`,
  comparisonMarkdownUrl: id => `${apiBaseUrl}/submittals/${id}/comparison.md`,

  fileUrl: (id, fileId) => `${apiBaseUrl}/submittals/${id}/files/${fileId}`,
  downloadCsv: async projectId => {
    const res = await api.get('/submittals/export.csv', {
      params: projectId ? { project_id: projectId } : undefined, responseType: 'blob',
    });
    triggerDownload(res.data, 'Submittal_Log.csv');
  },
};

// Meeting minutes in, a running action register out. The register accumulates across every
// meeting on a project rather than resetting per meeting, so the calls are split between the
// meetings themselves, the register they feed, and the contacts actions are assigned to.
export const meetingsApi = {
  list: params => api.get('/meetings', { params }).then(r => r.data),
  get: id => api.get(`/meetings/${id}`).then(r => r.data),
  // Reads the minutes and returns a draft to confirm. Saves nothing.
  extract: formData => api.post('/meetings/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  save: formData => api.post('/meetings', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  delete: id => api.delete(`/meetings/${id}`).then(r => r.data),
  fileUrl: id => `${apiBaseUrl}/meetings/${id}/file`,

  register: params => api.get('/meetings/register', { params }).then(r => r.data),
  digests: params => api.get('/meetings/register/digest', { params }).then(r => r.data),
  downloadCsv: async projectId => {
    const res = await api.get('/meetings/register/export.csv', {
      params: projectId ? { project_id: projectId } : undefined, responseType: 'blob',
    });
    triggerDownload(res.data, 'Action_Items.csv');
  },

  createItem: data => api.post('/meetings/items', data).then(r => r.data),
  updateItem: (itemId, data) => api.patch(`/meetings/items/${itemId}`, data).then(r => r.data),
  deleteItem: itemId => api.delete(`/meetings/items/${itemId}`).then(r => r.data),

  // The people actions are assigned to. Separate from Coaster users on purpose — most of the
  // room (the architect, the GC's super) will never sign in here.
  contacts: () => api.get('/meetings/contacts').then(r => r.data),
  createContact: data => api.post('/meetings/contacts', data).then(r => r.data),
  updateContact: (id, data) => api.patch(`/meetings/contacts/${id}`, data).then(r => r.data),
  // Attaches an email to a name from the minutes. Optional — the register works on names
  // alone; this only exists so a person can be emailed.
  setPersonEmail: data => api.post('/meetings/register/person-email', data).then(r => r.data),
};

export const financeApi = {
  payapps: params => api.get('/finance/payapps', { params }).then(r => r.data),
  createPayapp: data => api.post('/finance/payapps', data).then(r => r.data),
  updatePayapp: (id, data) => api.put(`/finance/payapps/${id}`, data).then(r => r.data),
  deletePayapp: id => api.delete(`/finance/payapps/${id}`).then(r => r.data),
  invoices: params => api.get('/finance/invoices', { params }).then(r => r.data),
  createInvoice: data => api.post('/finance/invoices', data).then(r => r.data),
  updateInvoice: (id, data) => api.put(`/finance/invoices/${id}`, data).then(r => r.data),
  deleteInvoice: id => api.delete(`/finance/invoices/${id}`).then(r => r.data),
  summary: () => api.get('/finance/summary').then(r => r.data),
};

export const reviewsApi = {
  submit: formData => api.post('/reviews', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  list: params => api.get('/reviews', { params }).then(r => r.data),
  delete: id => api.delete(`/reviews/${id}`).then(r => r.data),
};

export const teamApi = {
  list: () => api.get('/team').then(r => r.data),
  create: data => api.post('/team', data).then(r => r.data),
  update: (id, data) => api.put(`/team/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/team/${id}`).then(r => r.data),
};

export const settingsApi = {
  get: () => api.get('/settings').then(r => r.data),
  update: data => api.put('/settings', data).then(r => r.data),
};

export const proposalIntakeApi = {
  list: params => api.get('/proposal-intake', { params }).then(r => r.data),
  extract: formData => api.post('/proposal-intake/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  create: formData => api.post('/proposal-intake', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  download: async (id, fileName) => {
    const res = await api.get(`/proposal-intake/${id}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || `proposal_intake_${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },
  // The memo as the organization's own Word document, when a confirmed memo cover exists on
  // the project. Absent otherwise, so callers check before offering it.
  downloadMemoDocx: async (id, fileName) => {
    const res = await api.get(`/proposal-intake/${id}/memo.docx`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `memo_${id}.docx`);
  },
  delete: id => api.delete(`/proposal-intake/${id}`).then(r => r.data),
};

// The organization's own letterhead — the address block and the logo that print at the top of
// a memo. Per organization, so one customer's branding never reaches another's documents.
export const brandingApi = {
  get: () => api.get('/memo-templates/branding').then(r => r.data),
  setCompanyName: companyName =>
    api.put('/memo-templates/branding', { companyName }).then(r => r.data),
  uploadLogo: formData => api.post('/memo-templates/branding/logo', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data),
  removeLogo: () => api.delete('/memo-templates/branding/logo').then(r => r.data),
  // Cache-busted so a freshly uploaded logo actually appears rather than the previous one.
  logoUrl: () => `${apiBaseUrl}/memo-templates/branding/logo?t=${Date.now()}`,
};

export const memoTemplatesApi = {
  list: () => api.get('/memo-templates').then(r => r.data),
  get: id => api.get(`/memo-templates/${id}`).then(r => r.data),
  create: data => api.post('/memo-templates', data).then(r => r.data),
  update: (id, data) => api.put(`/memo-templates/${id}`, data).then(r => r.data),
  setDefault: id => api.post(`/memo-templates/${id}/set-default`).then(r => r.data),
  delete: id => api.delete(`/memo-templates/${id}`).then(r => r.data),
};

function triggerDownload(blob, fileName) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// Waits for a job to finish, however long it takes.
//
// Nothing here has a deadline, and that is the point: the document decides how long the work takes,
// and no clock in the browser, a proxy or a load balancer gets a vote any more. Each poll is a tiny
// request that either says "running" or hands back the result.
async function waitForJob(jobId, { onTick } = {}) {
  const started = Date.now();
  // Quick at first — a small pay application is read in seconds and should not sit waiting on a
  // slow poll — then easing off so a twenty-minute read is not a thousand requests.
  const delayFor = elapsed => (elapsed < 30000 ? 1500 : elapsed < 180000 ? 3000 : 6000);

  for (;;) {
    const elapsed = Date.now() - started;
    await new Promise(r => setTimeout(r, delayFor(elapsed)));
    const job = await api.get(`/pay-app-review/jobs/${jobId}`).then(r => r.data);
    if (job.status === 'done') return job.result;
    if (job.status === 'failed') {
      const err = new Error(job.error || 'The work could not be completed.');
      err.friendlyMessage = job.error || 'The work could not be completed.';
      throw err;
    }
    if (onTick) onTick(Math.round((Date.now() - started) / 1000));
  }
}

export const payAppReviewApi = {
  list: params => api.get('/pay-app-review', { params }).then(r => r.data),
  get: id => api.get(`/pay-app-review/${id}`).then(r => r.data),
  // The findings report, rendered server-side so the page, the PDF and the printed copy are
  // the same document rather than three renderings that can drift apart.
  reportHtml: id => api.get(`/pay-app-review/${id}/report.html`, { responseType: 'text' }).then(r => r.data),
  // The upload still has a timeout — that part is a file transfer and a stall there is a real
  // fault. The READING has none, because it is no longer happening on this connection.
  extract: (formData, onTick) => api.post('/pay-app-review/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => waitForJob(r.data.jobId, { onTick })),
  // The first review on a project reads the contract, which is several passes on a long
  // agreement; every review after that reads the stored terms and returns in seconds.
  create: (formData, onTick) => api.post('/pay-app-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => waitForJob(r.data.jobId, { onTick })),
  projects: () => api.get('/pay-app-review/projects').then(r => r.data),
  createProject: projectName =>
    api.post('/pay-app-review/projects', { project_name: projectName }).then(r => r.data),
  projectHistory: projectId => api.get(`/pay-app-review/project/${projectId}/history`).then(r => r.data),
  getContract: projectId => api.get(`/pay-app-review/project/${projectId}/contract`).then(r => r.data),
  uploadContract: (projectId, formData) =>
    api.post(`/pay-app-review/project/${projectId}/contract`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT,
    }).then(r => r.data),
  updateContractTerms: (projectId, terms) =>
    api.patch(`/pay-app-review/project/${projectId}/contract`, { terms }).then(r => r.data),
  deleteContract: projectId => api.delete(`/pay-app-review/project/${projectId}/contract`).then(r => r.data),

  // Shared Documents: every contract and reference file on a project. A 'contract' has its
  // terms read and can be reviewed against; a 'reference' (schedule, estimate) is stored for
  // the team and never sent to the AI.
  listDocuments: projectId =>
    api.get(`/pay-app-review/project/${projectId}/documents`).then(r => r.data),
  addDocument: (projectId, formData) =>
    api.post(`/pay-app-review/project/${projectId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT,
    }).then(r => r.data),
  updateDocument: (projectId, docId, data) =>
    api.patch(`/pay-app-review/project/${projectId}/documents/${docId}`, data).then(r => r.data),
  deleteDocument: (projectId, docId) =>
    api.delete(`/pay-app-review/project/${projectId}/documents/${docId}`).then(r => r.data),
  documentFileUrl: (projectId, docId) =>
    `${apiBaseUrl}/pay-app-review/project/${projectId}/documents/${docId}/file.pdf`,
  latestForProject: ({ projectId, projectName }) =>
    api.get('/pay-app-review/latest-for-project', {
      params: projectId ? { project_id: projectId } : { project_name: projectName },
    }).then(r => r.data),
  downloadPdf: async (id, fileName) => {
    const res = await api.get(`/pay-app-review/${id}/report.pdf`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pay_app_review_${id}.pdf`);
  },
  downloadMarkedUpPdf: async (id, fileName) => {
    const res = await api.get(`/pay-app-review/${id}/marked-up.pdf`, { responseType: 'blob', timeout: AI_TIMEOUT });
    triggerDownload(res.data, fileName || `pay_app_${id}_marked_up.pdf`);
  },
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/pay-app-review/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pay_app_review_${id}.md`);
  },
  downloadJson: async (id, fileName) => {
    const res = await api.get(`/pay-app-review/${id}/report.json`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pay_app_review_${id}.json`);
  },
  downloadOriginal: async (id, fileName) => {
    const res = await api.get(`/pay-app-review/${id}/original.pdf`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pay_app_${id}.pdf`);
  },
  delete: id => api.delete(`/pay-app-review/${id}`).then(r => r.data),
};

// Shared Documents — the project's contracts, drawings, specs and the rest, uploaded once and
// read by every tool that needs them. The endpoints still sit under the pay-app-review router
// on the server, which is where they were first written; the naming here reflects what they
// actually are now that this is a tool in its own right.
export const projectDocumentsApi = {
  list: projectId => api.get(`/pay-app-review/project/${projectId}/documents`).then(r => r.data),
  get: (projectId, docId) =>
    api.get(`/pay-app-review/project/${projectId}/documents/${docId}`).then(r => r.data),
  // Uploading a contract also extracts its terms, so this one call can be slow.
  add: (projectId, formData) =>
    api.post(`/pay-app-review/project/${projectId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT,
    }).then(r => r.data),
  update: (projectId, docId, data) =>
    api.patch(`/pay-app-review/project/${projectId}/documents/${docId}`, data).then(r => r.data),
  remove: (projectId, docId) =>
    api.delete(`/pay-app-review/project/${projectId}/documents/${docId}`).then(r => r.data),
  fileUrl: (projectId, docId) =>
    `${apiBaseUrl}/pay-app-review/project/${projectId}/documents/${docId}/file.pdf`,
};

export const pcoReviewApi = {
  list: params => api.get('/pco-review', { params }).then(r => r.data),
  get: id => api.get(`/pco-review/${id}`).then(r => r.data),
  create: formData => api.post('/pco-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/pco-review/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pco_review_${id}.md`);
  },
  downloadOriginal: async (id, fileName) => {
    const res = await api.get(`/pco-review/${id}/original.pdf`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `pco_${id}.pdf`);
  },
  delete: id => api.delete(`/pco-review/${id}`).then(r => r.data),
};

export const invoiceReviewApi = {
  list: params => api.get('/invoice-review', { params }).then(r => r.data),
  get: id => api.get(`/invoice-review/${id}`).then(r => r.data),
  create: formData => api.post('/invoice-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/invoice-review/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `invoice_review_${id}.md`);
  },
  downloadFile: async (reviewId, fileId, fileName) => {
    const res = await api.get(`/invoice-review/${reviewId}/files/${fileId}`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `invoice_${fileId}.pdf`);
  },
  delete: id => api.delete(`/invoice-review/${id}`).then(r => r.data),
};

export const progressReportApi = {
  list: params => api.get('/progress-report', { params }).then(r => r.data),
  get: id => api.get(`/progress-report/${id}`).then(r => r.data),
  create: formData => api.post('/progress-report', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  fileUrl: (reportId, fileId) => `${apiBaseUrl}/progress-report/${reportId}/files/${fileId}`,
  downloadPdf: async (id, fileName) => {
    const res = await api.get(`/progress-report/${id}/report.pdf`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `progress_report_${id}.pdf`);
  },
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/progress-report/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `progress_report_${id}.md`);
  },
  delete: id => api.delete(`/progress-report/${id}`).then(r => r.data),
};

export const preconReviewApi = {
  list: params => api.get('/precon-review', { params }).then(r => r.data),
  get: id => api.get(`/precon-review/${id}`).then(r => r.data),
  create: formData => api.post('/precon-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: LONG_AI_TIMEOUT
  }).then(r => r.data),
  comparisonMarkdownUrl: id => `${apiBaseUrl}/precon-review/${id}/comparison.md`,
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/precon-review/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `precon_review_${id}.md`);
  },
  downloadPdf: async (id, fileName) => {
    const res = await api.get(`/precon-review/${id}/report.pdf`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `precon_review_${id}.pdf`);
  },
  downloadFile: async (reviewId, fileId, fileName) => {
    const res = await api.get(`/precon-review/${reviewId}/files/${fileId}`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `document_${fileId}`);
  },
  delete: id => api.delete(`/precon-review/${id}`).then(r => r.data),
};
