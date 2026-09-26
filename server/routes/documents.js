'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, all, get, run, UPLOAD_DIR } = require('../db');
const { insertRow, notFound, badRequest } = require('../util');

const router = express.Router();
const MAX_MB = Number(process.env.CRM_MAX_UPLOAD_MB) || 25;
const ENTITY_TYPES = ['customer', 'job', 'invoice', 'remittance', 'inventory'];
// Types safe to display inline in the browser; everything else is forced to download.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 },
});

const SELECT = `SELECT d.*, u.name AS uploaded_by_name,
  CASE d.entity_type
    WHEN 'customer' THEN (SELECT name FROM customers WHERE id = d.entity_id)
    WHEN 'job' THEN (SELECT number || ' ' || title FROM jobs WHERE id = d.entity_id)
    WHEN 'invoice' THEN (SELECT number FROM invoices WHERE id = d.entity_id)
    WHEN 'remittance' THEN (SELECT number FROM remittances WHERE id = d.entity_id)
    WHEN 'inventory' THEN (SELECT sku || ' ' || name FROM inventory_items WHERE id = d.entity_id)
  END AS entity_label
  FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by`;

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entity_type) { where.push('d.entity_type = ?'); params.push(req.query.entity_type); }
  if (req.query.entity_id) { where.push('d.entity_id = ?'); params.push(req.query.entity_id); }
  if (req.query.q) {
    where.push("(d.original_name LIKE ? OR IFNULL(d.description,'') LIKE ?)");
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  res.json(all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC, d.id DESC`, ...params));
});

router.post('/', upload.array('files', 10), (req, res) => {
  const files = req.files || [];
  if (!files.length) throw badRequest('No files uploaded');
  const entityType = req.body.entity_type || null;
  const entityId = req.body.entity_id ? Number(req.body.entity_id) : null;
  if (entityType && !ENTITY_TYPES.includes(entityType)) {
    files.forEach((f) => fs.rmSync(f.path, { force: true }));
    throw badRequest('Invalid entity type');
  }
  const ids = files.map((f) => insertRow(db, 'documents', {
    // multer decodes names as latin1; re-decode so non-ASCII filenames survive.
    original_name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    stored_name: f.filename,
    mime_type: f.mimetype,
    size: f.size,
    entity_type: entityType,
    entity_id: entityType ? entityId : null,
    description: req.body.description || null,
    uploaded_by: req.user.id,
  }));
  res.status(201).json(all(`${SELECT} WHERE d.id IN (${ids.map(() => '?').join(',')})`, ...ids));
});

router.get('/:id/download', (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id = ?', req.params.id);
  if (!doc) throw notFound('Document');
  const file = path.join(UPLOAD_DIR, path.basename(doc.stored_name));
  if (!fs.existsSync(file)) throw notFound('File');
  const inline = req.query.inline === '1' && INLINE_TYPES.has(doc.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', inline ? doc.mime_type : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  fs.createReadStream(file).pipe(res);
});

router.put('/:id', (req, res) => {
  const doc = get('SELECT id FROM documents WHERE id = ?', req.params.id);
  if (!doc) throw notFound('Document');
  run('UPDATE documents SET description = ? WHERE id = ?', req.body.description || null, doc.id);
  res.json(get(`${SELECT} WHERE d.id = ?`, doc.id));
});

router.delete('/:id', (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id = ?', req.params.id);
  if (!doc) throw notFound('Document');
  run('DELETE FROM documents WHERE id = ?', doc.id);
  fs.rmSync(path.join(UPLOAD_DIR, path.basename(doc.stored_name)), { force: true });
  res.json({ ok: true });
});

module.exports = router;
module.exports.MAX_MB = MAX_MB;
