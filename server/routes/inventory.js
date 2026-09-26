'use strict';

const express = require('express');
const { db, all, get, run, tx } = require('../db');
const { pick, num, requireFields, updateRow, insertRow, notFound, badRequest } = require('../util');

const router = express.Router();
const FIELDS = ['sku', 'name', 'description', 'unit', 'reorder_level', 'unit_cost', 'unit_price', 'location'];

function normalise(data) {
  for (const k of ['reorder_level', 'unit_cost', 'unit_price']) if (k in data) data[k] = num(data[k]);
  return data;
}

router.get('/', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  let rows = all(
    `SELECT * FROM inventory_items WHERE sku LIKE ? OR name LIKE ? OR IFNULL(location,'') LIKE ? ORDER BY name`, q, q, q);
  if (req.query.low === '1') rows = rows.filter((r) => r.quantity <= r.reorder_level);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const item = get('SELECT * FROM inventory_items WHERE id = ?', req.params.id);
  if (!item) throw notFound('Item');
  item.movements = all(
    `SELECT m.*, u.name AS user_name,
       CASE m.reference_type WHEN 'remittance' THEN (SELECT number FROM remittances WHERE id = m.reference_id) END AS reference_number
     FROM inventory_movements m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, item.id);
  res.json(item);
});

router.post('/', (req, res) => {
  const data = normalise(pick(req.body, FIELDS));
  requireFields(data, ['sku', 'name']);
  if (get('SELECT id FROM inventory_items WHERE sku = ?', data.sku)) throw badRequest(`SKU "${data.sku}" already exists`);
  const openingQty = num(req.body.quantity);
  const id = tx(() => {
    const newId = insertRow(db, 'inventory_items', { ...data, quantity: openingQty });
    if (openingQty) {
      insertRow(db, 'inventory_movements', {
        item_id: newId, change: openingQty, reason: 'opening', note: 'Opening stock', user_id: req.user.id,
      });
    }
    return newId;
  });
  res.status(201).json(get('SELECT * FROM inventory_items WHERE id = ?', id));
});

router.put('/:id', (req, res) => {
  const data = normalise(pick(req.body, FIELDS));
  if (!get('SELECT id FROM inventory_items WHERE id = ?', req.params.id)) throw notFound('Item');
  if (data.sku && get('SELECT id FROM inventory_items WHERE sku = ? AND id != ?', data.sku, req.params.id)) {
    throw badRequest(`SKU "${data.sku}" already exists`);
  }
  updateRow(db, 'inventory_items', req.params.id, data);
  res.json(get('SELECT * FROM inventory_items WHERE id = ?', req.params.id));
});

/** Manual stock adjustment: { change: +/-number, note } */
router.post('/:id/adjust', (req, res) => {
  const item = get('SELECT * FROM inventory_items WHERE id = ?', req.params.id);
  if (!item) throw notFound('Item');
  const change = num(req.body.change, NaN);
  if (!Number.isFinite(change) || change === 0) throw badRequest('Adjustment must be a non-zero number');
  tx(() => {
    run("UPDATE inventory_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?", change, item.id);
    insertRow(db, 'inventory_movements', {
      item_id: item.id, change, reason: 'adjustment', note: req.body.note || null, user_id: req.user.id,
    });
  });
  res.json(get('SELECT * FROM inventory_items WHERE id = ?', item.id));
});

router.delete('/:id', (req, res) => {
  const used = get('SELECT COUNT(*) AS n FROM remittance_items WHERE item_id = ?', req.params.id).n;
  if (used) throw badRequest('Item appears on remittances and cannot be deleted');
  if (!run('DELETE FROM inventory_items WHERE id = ?', req.params.id).changes) throw notFound('Item');
  res.json({ ok: true });
});

module.exports = router;
