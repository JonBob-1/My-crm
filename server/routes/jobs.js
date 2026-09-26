'use strict';

const express = require('express');
const { db, all, get, run, tx, nextNumber } = require('../db');
const { pick, requireFields, updateRow, insertRow, notFound, badRequest } = require('../util');
const { requireAdmin } = require('../auth');

const router = express.Router();
const FIELDS = ['title', 'customer_id', 'status_id', 'priority', 'assigned_to', 'start_date', 'due_date', 'description', 'external_ref'];

const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, s.name AS status, s.color AS status_color, s.is_closed,
         u.name AS assigned_name
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN job_statuses s ON s.id = j.status_id
  LEFT JOIN users u ON u.id = j.assigned_to`;

// ---- Statuses (pipeline stages) ----
router.get('/statuses', (req, res) => {
  res.json(all(
    `SELECT s.*, (SELECT COUNT(*) FROM jobs j WHERE j.status_id = s.id) AS job_count
     FROM job_statuses s ORDER BY sort_order, id`));
});

router.post('/statuses', requireAdmin, (req, res) => {
  const data = pick(req.body, ['name', 'color', 'sort_order', 'is_closed']);
  requireFields(data, ['name']);
  data.is_closed = data.is_closed ? 1 : 0;
  if (data.sort_order == null) data.sort_order = (get('SELECT MAX(sort_order) AS m FROM job_statuses').m || 0) + 1;
  const id = insertRow(db, 'job_statuses', data);
  res.status(201).json(get('SELECT * FROM job_statuses WHERE id = ?', id));
});

router.put('/statuses/:id', requireAdmin, (req, res) => {
  const data = pick(req.body, ['name', 'color', 'sort_order', 'is_closed']);
  if ('is_closed' in data) data.is_closed = data.is_closed ? 1 : 0;
  if (!updateRow(db, 'job_statuses', req.params.id, data, false)) throw notFound('Status');
  res.json(get('SELECT * FROM job_statuses WHERE id = ?', req.params.id));
});

router.delete('/statuses/:id', requireAdmin, (req, res) => {
  const inUse = get('SELECT COUNT(*) AS n FROM jobs WHERE status_id = ?', req.params.id).n;
  if (inUse) throw badRequest(`Status is used by ${inUse} job(s). Move them first.`);
  if (!run('DELETE FROM job_statuses WHERE id = ?', req.params.id).changes) throw notFound('Status');
  res.json({ ok: true });
});

// ---- Jobs ----
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push('(j.title LIKE ? OR j.number LIKE ? OR IFNULL(c.name,\'\') LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q);
  }
  if (req.query.status_id) { where.push('j.status_id = ?'); params.push(req.query.status_id); }
  if (req.query.customer_id) { where.push('j.customer_id = ?'); params.push(req.query.customer_id); }
  if (req.query.open === '1') where.push('IFNULL(s.is_closed, 0) = 0');
  res.json(all(`${JOB_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.updated_at DESC`, ...params));
});

router.get('/:id', (req, res) => {
  const job = get(`${JOB_SELECT} WHERE j.id = ?`, req.params.id);
  if (!job) throw notFound('Job');
  job.history = all(
    `SELECT h.*, u.name AS user_name FROM job_status_history h
     LEFT JOIN users u ON u.id = h.user_id WHERE h.job_id = ? ORDER BY h.created_at DESC, h.id DESC`, job.id);
  job.invoices = all('SELECT id, number, issue_date, status FROM invoices WHERE job_id = ? ORDER BY issue_date DESC', job.id);
  job.remittances = all('SELECT id, number, direction, date, status FROM remittances WHERE job_id = ? ORDER BY date DESC', job.id);
  res.json(job);
});

function statusName(id) {
  return id ? get('SELECT name FROM job_statuses WHERE id = ?', id)?.name ?? null : null;
}

router.post('/', (req, res) => {
  const data = pick(req.body, FIELDS);
  requireFields(data, ['title']);
  if (!data.status_id) data.status_id = get('SELECT id FROM job_statuses ORDER BY sort_order, id LIMIT 1')?.id ?? null;
  const id = tx(() => {
    data.number = nextNumber('job');
    const newId = insertRow(db, 'jobs', data);
    insertRow(db, 'job_status_history', {
      job_id: newId, from_status: null, to_status: statusName(data.status_id), note: 'Job created', user_id: req.user.id,
    });
    return newId;
  });
  res.status(201).json(get(`${JOB_SELECT} WHERE j.id = ?`, id));
});

router.put('/:id', (req, res) => {
  const existing = get('SELECT * FROM jobs WHERE id = ?', req.params.id);
  if (!existing) throw notFound('Job');
  const data = pick(req.body, FIELDS);
  if ('title' in data) requireFields(data, ['title']);
  tx(() => {
    updateRow(db, 'jobs', existing.id, data);
    if ('status_id' in data && Number(data.status_id) !== Number(existing.status_id)) {
      insertRow(db, 'job_status_history', {
        job_id: existing.id,
        from_status: statusName(existing.status_id),
        to_status: statusName(data.status_id),
        note: req.body.status_note || null,
        user_id: req.user.id,
      });
    }
  });
  res.json(get(`${JOB_SELECT} WHERE j.id = ?`, existing.id));
});

router.post('/:id/notes', (req, res) => {
  const job = get('SELECT j.id, s.name AS status FROM jobs j LEFT JOIN job_statuses s ON s.id = j.status_id WHERE j.id = ?', req.params.id);
  if (!job) throw notFound('Job');
  requireFields(req.body || {}, ['note']);
  insertRow(db, 'job_status_history', {
    job_id: job.id, from_status: job.status, to_status: job.status, note: req.body.note, user_id: req.user.id,
  });
  run("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?", job.id);
  res.status(201).json({ ok: true });
});

router.delete('/:id', (req, res) => {
  if (!run('DELETE FROM jobs WHERE id = ?', req.params.id).changes) throw notFound('Job');
  res.json({ ok: true });
});

module.exports = router;
