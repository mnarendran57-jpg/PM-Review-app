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

const api = axios.create({ baseURL: apiBaseUrl, timeout: DEFAULT_TIMEOUT });

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Which organization the user is working in travels with every request. The server
  // always re-checks their membership of it, so this is a convenience, not a grant.
  const org = localStorage.getItem(ORG_KEY);
  if (org) {
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
    // callers can surface "can't reach the server" instead of appearing to hang.
    if (!err.response && (err.code === 'ECONNABORTED' || err.code === 'ERR_NETWORK' || err.message === 'Network Error')) {
      err.friendlyMessage = 'Cannot reach the server. It may be offline or still starting up — check that the backend is running and reachable, then try again.';
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

export const adminApi = {
  // People in the active organization.
  listMembers: () => api.get('/admin/members').then(r => r.data),
  listPeople: () => api.get('/admin/people').then(r => r.data),
  addMember: data => api.post('/admin/members', data).then(r => r.data),
  updateMember: (userId, data) => api.put(`/admin/members/${userId}`, data).then(r => r.data),
  removeMember: userId => api.delete(`/admin/members/${userId}`).then(r => r.data),
  // Invitations — the preferred way to add someone, since they set their own password.
  listInvitations: () => api.get('/admin/invitations').then(r => r.data),
  invite: data => api.post('/admin/invitations', data).then(r => r.data),
  revokeInvitation: id => api.delete(`/admin/invitations/${id}`).then(r => r.data),
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

export const rfisApi = {
  list: params => api.get('/rfis', { params }).then(r => r.data),
  create: data => api.post('/rfis', data).then(r => r.data),
  update: (id, data) => api.put(`/rfis/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/rfis/${id}`).then(r => r.data),
  nextNumber: projectId => api.get(`/rfis/next-number/${projectId}`).then(r => r.data),
};

export const submittalsApi = {
  list: params => api.get('/submittals', { params }).then(r => r.data),
  create: data => api.post('/submittals', data).then(r => r.data),
  update: (id, data) => api.put(`/submittals/${id}`, data).then(r => r.data),
  delete: id => api.delete(`/submittals/${id}`).then(r => r.data),
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
  delete: id => api.delete(`/proposal-intake/${id}`).then(r => r.data),
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

export const payAppReviewApi = {
  list: params => api.get('/pay-app-review', { params }).then(r => r.data),
  get: id => api.get(`/pay-app-review/${id}`).then(r => r.data),
  extract: formData => api.post('/pay-app-review/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  create: formData => api.post('/pay-app-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
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
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: AI_TIMEOUT
  }).then(r => r.data),
  downloadMarkdown: async (id, fileName) => {
    const res = await api.get(`/precon-review/${id}/report.md`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `precon_review_${id}.md`);
  },
  downloadFile: async (reviewId, fileId, fileName) => {
    const res = await api.get(`/precon-review/${reviewId}/files/${fileId}`, { responseType: 'blob' });
    triggerDownload(res.data, fileName || `document_${fileId}`);
  },
  delete: id => api.delete(`/precon-review/${id}`).then(r => r.data),
};
