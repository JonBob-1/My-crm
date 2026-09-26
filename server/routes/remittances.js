'use strict';

const express = require('express');
const { db, all, get, run, tx, nextNumber } = require('../db');
const { pick, num, updateRow, insertRow, notFound, badRequest, today, round2 } = require('../util');

/*
 * Inventory remittances: a document recording stock sent out to (outgoing) or received from (incoming)
 * a customer/supplier. While "draft" it can be edited freely. "Posting" applies the stock movements;
 * "voiding" a posted remittance reverses them.
 */
const router = express.Router();
const FIELDS = ['direction', 'customer_id', 'counterparty', 'job_id', 'date', 'reference', 'notes'];

function loadRemittance(id) {
  const r = get(
    `SELECT r.*, c.name AS customer_name, c.company AS customer_company, c.address AS customer_address,
            c.email AS customer_email, j.number AS job_number, j.title AS job_title
     FROM remittances r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.id = ?`, id);
  if (!r) return null;
  r.items = all(
    `SELECT ri.*, it.sku, it.name, it.unit, it.quantity AS on_hand FROM remittance_items ri
     JOIN inventory_items it ON it.id = ri.item_id WHERE ri.remittance_id = ? ORDER BY ri.id`, id);
  r.total_value = round2(r.items.reduce((s, i) => s + i.quantity * i.unit_value, 0));
  r.total_quantity = r.items.reduce((s, i) => s + i.quantity, 0);
  return r;
}

function saveItems(remId, items) {
  if (!Array.isArray(items)) return;
  run('DELETE FROM remittance_items WHERE remittance_id = ?', remId);
  for (const it of items) {
    if (!it || !it.item_id) continue;
    const qty = num(it.quantity);
    if (qty <= 0) throw badRequest('Remittance quantities must be greater than zero');
    if (!get('SELECT id FROM inventory_items WHERE id = ?', it.item_id)) throw badRequest('Unknown inventory item');
    insertRow(db, 'remittance_items', {
      remittance_id: remId, item_id: it.item_id, quantity: qty, unit_value: num(it.unit_value), note: it.note || null,
    });
  }
}

function validate(data) {
  if ('direction' in data && !['outgoing', 'incoming'].includes(data.direction)) throw badRequest('Direction must be outgoing or incoming');
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push("(r.number LIKE ? OR IFNULL(c.name,'') LIKE ? OR IFNULL(r.counterparty,'') LIKE ? OR IFNULL(r.reference,'') LIKE ?)");
    const q = `%${req.query.q}%`;
    params.push(q, q, q, q);
  }
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  if (req.query.direction) { where.push('r.direction = ?'); params.push(req.query.direction); }
  res.json(all(
    `SELECT r.*, c.name AS customer_name,
       (SELECT IFNULL(SUM(quantity * unit_value), 0) FROM remittance_items WHERE remittance_id = r.id) AS total_value,
       (SELECT COUNT(*) FROM remittance_items WHERE remittance_id = r.id) AS line_count
     FROM remittances r LEFT JOIN customers c ON c.id = r.customer_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.date DESC, r.id DESC`, ...params));
});

router.get('/:id', (req, res) => {
  const r = loadRemittance(req.params.id);
  if (!r) throw notFound('Remittance');
  res.json(r);
});

router.post('/', (req, res) => {
  const data = pick(req.body, FIELDS);
  data.direction = data.direction || 'outgoing';
  validate(data);
  data.date = data.date || today();
  const id = tx(() => {
    data.number = nextNumber('remittance');
    const newId = insertRow(db, 'remittances', data);
    saveItems(newId, req.body.items);
    return newId;
  });
  res.status(201).json(loadRemittance(id));
});

router.put('/:id', (req, res) => {
  const existing = get('SELECT * FROM remittances WHERE id = ?', req.params.id);
  if (!existing) throw notFound('Remittance');
  const data = pick(req.body, FIELDS);
  validate(data);
  if (existing.status !== 'draft') {
    // Only descriptive fields may change once stock has moved.
    for (const k of ['direction', 'customer_id', 'counterparty', 'job_id', 'date']) delete data[k];
    if (Array.isArray(req.body.items)) throw badRequest('Items cannot be changed after posting. Void it and create a new remittance.');
  }
  tx(() => {
    updateRow(db, 'remittances', existing.id, data);
    if (existing.status === 'draft') saveItems(existing.id, req.body.items);
  });
  res.json(loadRemittance(existing.id));
});

function applyStock(rem, sign, reason, userId) {
  for (const it of rem.items) {
    const change = sign * (rem.direction === 'incoming' ? it.quantity : -it.quantity);
    run("UPDATE inventory_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?", change, it.item_id);
    insertRow(db, 'inventory_movements', {
      item_id: it.item_id, change, reason, reference_type: 'remittance', reference_id: rem.id,
      note: `${rem.number} (${rem.direction})`, user_id: userId,
    });
  }
}

router.post('/:id/post', (req, res) => {
  const rem = loadRemittance(req.params.id);
  if (!rem) throw notFound('Remittance');
  if (rem.status !== 'draft') throw badRequest('Only draft remittances can be posted');
  if (!rem.items.length) throw badRequest('Add at least one item before posting');
  if (rem.direction === 'outgoing' && !req.body?.allow_negative) {
    const short = rem.items.filter((i) => i.quantity > i.on_hand);
    if (short.length) {
      throw badRequest(`Insufficient stock for: ${short.map((i) => `${i.sku} (have ${i.on_hand}, need ${i.quantity})`).join(', ')}`);
    }
  }
  tx(() => {
    applyStock(rem, 1, rem.direction === 'incoming' ? 'remittance_in' : 'remittance_out', req.user.id);
    run("UPDATE remittances SET status = 'posted', posted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", rem.id);
  });
  res.json(loadRemittance(rem.id));
});

router.post('/:id/void', (req, res) => {
  const rem = loadRemittance(req.params.id);
  if (!rem) throw notFound('Remittance');
  if (rem.status === 'void') throw badRequest('Already void');
  tx(() => {
    if (rem.status === 'posted') applyStock(rem, -1, 'remittance_void', req.user.id);
    run("UPDATE remittances SET status = 'void', updated_at = datetime('now') WHERE id = ?", rem.id);
  });
  res.json(loadRemittance(rem.id));
});

router.delete('/:id', (req, res) => {
  const rem = get('SELECT status FROM remittances WHERE id = ?', req.params.id);
  if (!rem) throw notFound('Remittance');
  if (rem.status === 'posted') throw badRequest('Void a posted remittance before deleting it');
  run('DELETE FROM remittances WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
