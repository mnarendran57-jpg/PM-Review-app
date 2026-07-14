const express = require('express');
const router = express.Router();
const db = require('../database');

// ── PAY APPLICATIONS ──────────────────────────────────────────────────────────

router.get('/payapps', (req, res) => {
  const { project_id, status } = req.query;
  let sql = `
    SELECT pa.*, p.project_name
    FROM pay_applications pa
    LEFT JOIN projects p ON pa.project_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (project_id) { sql += ' AND pa.project_id = ?'; params.push(project_id); }
  if (status) { sql += ' AND pa.status = ?'; params.push(status); }
  sql += ' ORDER BY pa.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/payapps', (req, res) => {
  const {
    project_id, subcontractor, application_number, period_start, period_end,
    scheduled_value, previously_billed, current_billing, retainage_pct,
    net_amount_due, status, notes
  } = req.body;
  const result = db.prepare(`
    INSERT INTO pay_applications (project_id, subcontractor, application_number,
      period_start, period_end, scheduled_value, previously_billed, current_billing,
      retainage_pct, net_amount_due, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_id || null, subcontractor, application_number, period_start, period_end,
    scheduled_value || 0, previously_billed || 0, current_billing || 0,
    retainage_pct ?? 10, net_amount_due || 0, status || 'Received', notes);
  res.json({ id: result.lastInsertRowid });
});

router.put('/payapps/:id', (req, res) => {
  const {
    project_id, subcontractor, application_number, period_start, period_end,
    scheduled_value, previously_billed, current_billing, retainage_pct,
    net_amount_due, status, notes
  } = req.body;
  db.prepare(`
    UPDATE pay_applications SET project_id=?, subcontractor=?, application_number=?,
      period_start=?, period_end=?, scheduled_value=?, previously_billed=?,
      current_billing=?, retainage_pct=?, net_amount_due=?, status=?, notes=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(project_id || null, subcontractor, application_number, period_start, period_end,
    scheduled_value, previously_billed, current_billing, retainage_pct,
    net_amount_due, status, notes, req.params.id);
  res.json({ success: true });
});

router.delete('/payapps/:id', (req, res) => {
  db.prepare('DELETE FROM pay_applications WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── INVOICES ──────────────────────────────────────────────────────────────────

router.get('/invoices', (req, res) => {
  const { project_id, status } = req.query;
  let sql = `
    SELECT inv.*, p.project_name
    FROM invoices inv
    LEFT JOIN projects p ON inv.project_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (project_id) { sql += ' AND inv.project_id = ?'; params.push(project_id); }
  if (status) { sql += ' AND inv.status = ?'; params.push(status); }
  sql += ' ORDER BY inv.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/invoices', (req, res) => {
  const {
    project_id, vendor, invoice_number, invoice_date,
    amount, po_number, status, notes
  } = req.body;
  const result = db.prepare(`
    INSERT INTO invoices (project_id, vendor, invoice_number, invoice_date,
      amount, po_number, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_id || null, vendor, invoice_number, invoice_date,
    amount || 0, po_number, status || 'Received', notes);
  res.json({ id: result.lastInsertRowid });
});

router.put('/invoices/:id', (req, res) => {
  const {
    project_id, vendor, invoice_number, invoice_date,
    amount, po_number, status, notes
  } = req.body;
  db.prepare(`
    UPDATE invoices SET project_id=?, vendor=?, invoice_number=?, invoice_date=?,
      amount=?, po_number=?, status=?, notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(project_id || null, vendor, invoice_number, invoice_date,
    amount, po_number, status, notes, req.params.id);
  res.json({ success: true });
});

router.delete('/invoices/:id', (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── DASHBOARD SUMMARY ─────────────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const yearStart = `${now.getFullYear()}-01-01`;

  const billedThisMonth = db.prepare(`
    SELECT COALESCE(SUM(current_billing), 0) AS total
    FROM pay_applications
    WHERE period_end >= ? OR created_at >= ?
  `).get(monthStart, monthStart);

  const pendingApproval = db.prepare(`
    SELECT COALESCE(SUM(net_amount_due), 0) AS total
    FROM pay_applications
    WHERE status IN ('Received', 'Under Review')
  `).get();

  const paidYTD = db.prepare(`
    SELECT COALESCE(SUM(net_amount_due), 0) AS total
    FROM pay_applications
    WHERE status = 'Paid' AND updated_at >= ?
  `).get(yearStart);

  const byProject = db.prepare(`
    SELECT p.project_name,
      COALESCE(SUM(pa.current_billing), 0) AS billed,
      COALESCE(SUM(CASE WHEN pa.status IN ('Received','Under Review') THEN pa.net_amount_due ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN pa.status = 'Paid' THEN pa.net_amount_due ELSE 0 END), 0) AS paid
    FROM projects p
    LEFT JOIN pay_applications pa ON pa.project_id = p.id
    GROUP BY p.id
    ORDER BY p.project_name
  `).all();

  res.json({
    billed_this_month: billedThisMonth.total,
    pending_approval: pendingApproval.total,
    paid_ytd: paidYTD.total,
    by_project: byProject
  });
});

module.exports = router;
