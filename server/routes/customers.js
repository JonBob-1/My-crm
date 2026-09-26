'use strict';

const express = require('express');
const { db, all, get, run } = require('../db');
const { pick, requireFields, updateRow, insertRow, notFound } = require('../util');

const router = express.Router();
const FIELDS = ['name', 'company', 'email', 'phone', 'address', 'notes', 'external_ref'];

router.get('/', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  res.json(all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS job_count,
       (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS invoice_count
     FROM customers c
     WHERE c.name LIKE ? OR IFNULL(c.company,'') LIKE ? OR IFNULL(c.email,'') LIKE ? OR IFNULL(c.phone,'') LIKE ?
     ORDER BY c.name`, q, q, q, q));
});

router.get('/:id', (req, res) => {
  const customer = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!customer) throw notFound('Customer');
  customer.jobs = all(
    `SELECT j.id, j.number, j.title, j.due_date, s.name AS status, s.color AS status_color
     FROM jobs j LEFT JOIN job_statuses s ON s.id = j.status_id WHERE j.customer_id = ? ORDER BY j.created_at DESC`, customer.id);
  customer.invoices = all(
    'SELECT id, number, issue_date, due_date, status FROM invoices WHERE customer_id = ? ORDER BY issue_date DESC', customer.id);
  customer.remittances = all(
    'SELECT id, number, direction, date, status FROM remittances WHERE customer_id = ? ORDER BY date DESC', customer.id);
  res.json(customer);
});

router.post('/', (req, res) => {
  const data = pick(req.body, FIELDS);
  requireFields(data, ['name']);
  const id = insertRow(db, 'customers', data);
  res.status(201).json(get('SELECT * FROM customers WHERE id = ?', id));
});

router.put('/:id', (req, res) => {
  const data = pick(req.body, FIELDS);
  if ('name' in data) requireFields(data, ['name']);
  if (!get('SELECT id FROM customers WHERE id = ?', req.params.id)) throw notFound('Customer');
  updateRow(db, 'customers', req.params.id, data);
  res.json(get('SELECT * FROM customers WHERE id = ?', req.params.id));
});

router.delete('/:id', (req, res) => {
  if (!run('DELETE FROM customers WHERE id = ?', req.params.id).changes) throw notFound('Customer');
  res.json({ ok: true });
});

module.exports = router;
