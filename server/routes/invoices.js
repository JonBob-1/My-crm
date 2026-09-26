'use strict';

const express = require('express');
const { db, all, get, run, tx, nextNumber, getSettings } = require('../db');
const { pick, num, updateRow, insertRow, notFound, badRequest, today, round2 } = require('../util');

const router = express.Router();
const FIELDS = ['customer_id', 'job_id', 'issue_date', 'due_date', 'status', 'tax_rate', 'discount', 'notes'];
const STATUSES = ['draft', 'sent', 'paid', 'void'];

/** Adds subtotal/tax/total/paid/balance and a display status (overdue/partial) to an invoice row. */
function withTotals(inv) {
  const t = get(
    `SELECT IFNULL(SUM(quantity * unit_price), 0) AS subtotal FROM invoice_items WHERE invoice_id = ?`, inv.id);
  const p = get('SELECT IFNULL(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?', inv.id);
  const subtotal = round2(t.subtotal);
  const taxable = Math.max(0, subtotal - num(inv.discount));
  const tax = round2(taxable * num(inv.tax_rate) / 100);
  const total = round2(taxable + tax);
  const paid = round2(p.paid);
  const balance = round2(total - paid);
  let display_status = inv.status;
  if (inv.status === 'sent') {
    if (paid > 0 && balance > 0) display_status = 'partial';
    if (balance > 0 && inv.due_date && inv.due_date < today()) display_status = 'overdue';
  }
  return { ...inv, subtotal, tax, total, paid, balance, display_status };
}

function loadInvoice(id) {
  const inv = get(
    `SELECT i.*, c.name AS customer_name, c.company AS customer_company, c.email AS customer_email,
            c.phone AS customer_phone, c.address AS customer_address, j.number AS job_number, j.title AS job_title
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN jobs j ON j.id = i.job_id
     WHERE i.id = ?`, id);
  if (!inv) return null;
  const full = withTotals(inv);
  full.items = all(
    `SELECT ii.*, it.sku FROM invoice_items ii LEFT JOIN inventory_items it ON it.id = ii.item_id
     WHERE ii.invoice_id = ? ORDER BY ii.sort_order, ii.id`, id);
  full.payments = all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id', id);
  return full;
}

/** Re-derives paid/sent status after payments change. */
function syncPaidStatus(id) {
  const inv = withTotals(get('SELECT * FROM invoices WHERE id = ?', id));
  if (inv.status === 'sent' && inv.total > 0 && inv.balance <= 0) run("UPDATE invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?", id);
  if (inv.status === 'paid' && inv.balance > 0) run("UPDATE invoices SET status = 'sent', updated_at = datetime('now') WHERE id = ?", id);
}

function saveItems(invoiceId, items) {
  if (!Array.isArray(items)) return;
  run('DELETE FROM invoice_items WHERE invoice_id = ?', invoiceId);
  items.forEach((it, i) => {
    if (!it || !String(it.description || '').trim()) return;
    insertRow(db, 'invoice_items', {
      invoice_id: invoiceId,
      item_id: it.item_id || null,
      description: String(it.description).trim(),
      quantity: num(it.quantity, 1),
      unit_price: num(it.unit_price, 0),
      sort_order: i,
    });
  });
}

function validate(data) {
  if ('status' in data && !STATUSES.includes(data.status)) throw badRequest('Invalid status');
  if ('tax_rate' in data) data.tax_rate = num(data.tax_rate);
  if ('discount' in data) data.discount = num(data.discount);
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push("(i.number LIKE ? OR IFNULL(c.name,'') LIKE ? OR IFNULL(c.company,'') LIKE ?)");
    const q = `%${req.query.q}%`;
    params.push(q, q, q);
  }
  if (req.query.customer_id) { where.push('i.customer_id = ?'); params.push(req.query.customer_id); }
  const rows = all(
    `SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.issue_date DESC, i.id DESC`, ...params).map(withTotals);
  const status = req.query.status;
  res.json(status ? rows.filter((r) => r.display_status === status || r.status === status) : rows);
});

router.get('/:id', (req, res) => {
  const inv = loadInvoice(req.params.id);
  if (!inv) throw notFound('Invoice');
  res.json(inv);
});

router.post('/', (req, res) => {
  const data = pick(req.body, FIELDS);
  validate(data);
  const s = getSettings();
  data.issue_date = data.issue_date || today();
  if (!data.due_date) {
    const d = new Date(`${data.issue_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (parseInt(s.payment_terms_days, 10) || 0));
    data.due_date = d.toISOString().slice(0, 10);
  }
  if (data.tax_rate == null) data.tax_rate = num(s.default_tax_rate);
  const id = tx(() => {
    data.number = nextNumber('invoice');
    const newId = insertRow(db, 'invoices', data);
    saveItems(newId, req.body.items);
    return newId;
  });
  res.status(201).json(loadInvoice(id));
});

router.put('/:id', (req, res) => {
  if (!get('SELECT id FROM invoices WHERE id = ?', req.params.id)) throw notFound('Invoice');
  const data = pick(req.body, FIELDS);
  validate(data);
  tx(() => {
    updateRow(db, 'invoices', req.params.id, data);
    saveItems(req.params.id, req.body.items);
    syncPaidStatus(req.params.id);
  });
  res.json(loadInvoice(req.params.id));
});

router.delete('/:id', (req, res) => {
  if (!run('DELETE FROM invoices WHERE id = ?', req.params.id).changes) throw notFound('Invoice');
  res.json({ ok: true });
});

// ---- Payments (remittance received against an invoice) ----
router.post('/:id/payments', (req, res) => {
  const inv = get('SELECT * FROM invoices WHERE id = ?', req.params.id);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'void') throw badRequest('Cannot record a payment on a void invoice');
  const amount = num(req.body.amount, NaN);
  if (!(amount > 0)) throw badRequest('Payment amount must be greater than zero');
  tx(() => {
    insertRow(db, 'payments', {
      invoice_id: inv.id, amount, date: req.body.date || today(),
      method: req.body.method || null, reference: req.body.reference || null, notes: req.body.notes || null,
    });
    if (inv.status === 'draft') run("UPDATE invoices SET status = 'sent' WHERE id = ?", inv.id);
    syncPaidStatus(inv.id);
  });
  res.status(201).json(loadInvoice(inv.id));
});

router.delete('/:id/payments/:paymentId', (req, res) => {
  if (!run('DELETE FROM payments WHERE id = ? AND invoice_id = ?', req.params.paymentId, req.params.id).changes) {
    throw notFound('Payment');
  }
  syncPaidStatus(req.params.id);
  res.json(loadInvoice(req.params.id));
});

module.exports = router;
module.exports.withTotals = withTotals;
