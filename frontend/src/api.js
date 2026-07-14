import axios from 'axios';

const TOKEN_KEY = 'pm_review_token';
const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
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
    return Promise.reject(err);
  }
);

export const authApi = {
  login: password => api.post('/auth/login', { password }).then(r => r.data),
  logout: () => localStorage.removeItem(TOKEN_KEY),
  isLoggedIn: () => !!localStorage.getItem(TOKEN_KEY),
  setToken: token => localStorage.setItem(TOKEN_KEY, token),
};

export const projectsApi = {
  list: () => api.get('/projects').then(r => r.data),
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
    headers: { 'Content-Type': 'multipart/form-data' }
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
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data),
  create: formData => api.post('/proposal-intake', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
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
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data),
  create: formData => api.post('/pay-app-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data),
  latestForProject: projectName => api.get('/pay-app-review/latest-for-project', { params: { project_name: projectName } }).then(r => r.data),
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

export const preconReviewApi = {
  list: params => api.get('/precon-review', { params }).then(r => r.data),
  get: id => api.get(`/precon-review/${id}`).then(r => r.data),
  create: formData => api.post('/precon-review', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
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
