'use strict';

const express = require('express');
const { db, all, get, run, tx, nextNumber } = require('../db');
const { pick, num, requireFields, updateRow, insertRow, notFound, badRequest, getPath } = require('../util');
const { requireAdmin } = require('../auth');

/*
 * External API connections. Each connection describes an HTTP endpoint at another company
 * (supplier stock feed, partner job tracker, CRM export, ...). The server makes the request
 * (so browser CORS rules do not apply and credentials stay server-side), extracts an array of
 * records from the JSON (or CSV) response, and can optionally import/update those records
 * into customers, inventory or jobs using a field map.
 */
const router = express.Router();
const FIELDS = ['name', 'url', 'method', 'headers', 'body', 'auth_type', 'auth_key', 'auth_value',
  'data_path', 'target', 'field_map', 'schedule_minutes'];
const MAX_PAYLOAD_LOG = 200_000;

/** Fields each import target accepts, used by the UI to build the field-map editor. */
const TARGET_FIELDS = {
  customers: ['external_ref', 'name', 'company', 'email', 'phone', 'address', 'notes'],
  inventory: ['sku', 'name', 'description', 'unit', 'quantity', 'reorder_level', 'unit_cost', 'unit_price', 'location'],
  jobs: ['external_ref', 'title', 'status', 'priority', 'start_date', 'due_date', 'description', 'customer_name'],
};

function parseJsonField(value, label) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  try {
    JSON.parse(value);
    return value;
  } catch {
    throw badRequest(`${label} must be valid JSON`);
  }
}

function validate(data) {
  if ('url' in data) {
    let u;
    try { u = new URL(data.url); } catch { throw badRequest('URL is not valid'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('URL must start with http:// or https://');
  }
  if ('method' in data && data.method) data.method = String(data.method).toUpperCase();
  if ('method' in data && !['GET', 'POST'].includes(data.method)) throw badRequest('Method must be GET or POST');
  if ('target' in data && data.target && !['none', ...Object.keys(TARGET_FIELDS)].includes(data.target)) throw badRequest('Invalid import target');
  if ('headers' in data) data.headers = parseJsonField(data.headers, 'Headers');
  if ('field_map' in data) data.field_map = parseJsonField(data.field_map, 'Field map');
  if ('schedule_minutes' in data) data.schedule_minutes = Math.max(0, parseInt(data.schedule_minutes, 10) || 0);
}

/** Never send stored secrets back to the browser. */
function redact(conn) {
  if (!conn) return conn;
  return { ...conn, auth_value: conn.auth_value ? '••••••••' : '', has_secret: !!conn.auth_value };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

async function fetchConnection(conn) {
  const headers = { Accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...(conn.headers ? JSON.parse(conn.headers) : {}) };
  let url = conn.url;
  if (conn.auth_type === 'bearer' && conn.auth_value) headers.Authorization = `Bearer ${conn.auth_value}`;
  if (conn.auth_type === 'basic' && conn.auth_value) headers.Authorization = `Basic ${Buffer.from(conn.auth_value).toString('base64')}`;
  if (conn.auth_type === 'apikey' && conn.auth_value) {
    const key = conn.auth_key || 'X-API-Key';
    if (key.startsWith('?')) {
      const u = new URL(url);
      u.searchParams.set(key.slice(1), conn.auth_value);
      url = u.toString();
    } else headers[key] = conn.auth_value;
  }
  const init = { method: conn.method || 'GET', headers, signal: AbortSignal.timeout(30_000), redirect: 'follow' };
  if (conn.method === 'POST' && conn.body) {
    init.body = conn.body;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data;
  const ctype = resp.headers.get('content-type') || '';
  if (ctype.includes('csv') || (!ctype.includes('json') && /^[^{[]/.test(text.trim()) && text.includes(','))) {
    data = parseCsv(text);
  } else {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  let records = getPath(data, conn.data_path);
  if (records != null && !Array.isArray(records)) records = typeof records === 'object' ? [records] : [];
  return { status: resp.status, ok: resp.ok, raw: data, records: records || [] };
}

function mapRecord(record, fieldMap) {
  const out = {};
  for (const [crmField, sourcePath] of Object.entries(fieldMap)) {
    if (!sourcePath) continue;
    const v = getPath(record, sourcePath);
    if (v !== undefined && v !== null && typeof v !== 'object') out[crmField] = String(v).trim();
  }
  return out;
}

function importRecords(conn, records, userId) {
  const fieldMap = conn.field_map ? JSON.parse(conn.field_map) : {};
  const allowed = TARGET_FIELDS[conn.target];
  if (!allowed) return { created: 0, updated: 0, skipped: records.length };
  for (const k of Object.keys(fieldMap)) if (!allowed.includes(k)) delete fieldMap[k];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  tx(() => {
    for (const record of records) {
      const m = mapRecord(record, fieldMap);
      if (conn.target === 'customers') {
        if (!m.name) { skipped++; continue; }
        const existing = (m.external_ref && get('SELECT id FROM customers WHERE external_ref = ?', m.external_ref))
          || (m.email && get('SELECT id FROM customers WHERE lower(email) = lower(?)', m.email))
          || get('SELECT id FROM customers WHERE name = ? AND IFNULL(company,\'\') = ?', m.name, m.company || '');
        if (existing) { updateRow(db, 'customers', existing.id, m); updated++; } else { insertRow(db, 'customers', m); created++; }
      } else if (conn.target === 'inventory') {
        if (!m.sku) { skipped++; continue; }
        const { quantity, ...rest } = m;
        for (const k of ['reorder_level', 'unit_cost', 'unit_price']) if (k in rest) rest[k] = num(rest[k]);
        const existing = get('SELECT * FROM inventory_items WHERE sku = ?', m.sku);
        const qty = quantity !== undefined ? num(quantity) : undefined;
        if (existing) {
          updateRow(db, 'inventory_items', existing.id, rest);
          if (qty !== undefined && qty !== existing.quantity) {
            run('UPDATE inventory_items SET quantity = ? WHERE id = ?', qty, existing.id);
            insertRow(db, 'inventory_movements', {
              item_id: existing.id, change: qty - existing.quantity, reason: 'api_sync', note: `Synced from ${conn.name}`, user_id: userId,
            });
          }
          updated++;
        } else {
          if (!rest.name) rest.name = m.sku;
          const id = insertRow(db, 'inventory_items', { ...rest, quantity: qty || 0 });
          if (qty) insertRow(db, 'inventory_movements', { item_id: id, change: qty, reason: 'api_sync', note: `Imported from ${conn.name}`, user_id: userId });
          created++;
        }
      } else if (conn.target === 'jobs') {
        if (!m.title && !m.external_ref) { skipped++; continue; }
        const { status, customer_name: customerName, ...rest } = m;
        if (rest.priority && !['low', 'normal', 'high', 'urgent'].includes(rest.priority.toLowerCase())) delete rest.priority;
        else if (rest.priority) rest.priority = rest.priority.toLowerCase();
        if (status) {
          let st = get('SELECT id FROM job_statuses WHERE lower(name) = lower(?)', status);
          if (!st) {
            const order = (get('SELECT MAX(sort_order) AS m FROM job_statuses').m || 0) + 1;
            st = { id: insertRow(db, 'job_statuses', { name: status, sort_order: order }) };
          }
          rest.status_id = st.id;
        }
        if (customerName) {
          const c = get('SELECT id FROM customers WHERE name = ? OR company = ?', customerName, customerName);
          rest.customer_id = c ? c.id : insertRow(db, 'customers', { name: customerName });
        }
        const existing = rest.external_ref ? get('SELECT * FROM jobs WHERE external_ref = ?', rest.external_ref) : null;
        const statusName = (id) => (id ? get('SELECT name FROM job_statuses WHERE id = ?', id)?.name : null);
        if (existing) {
          updateRow(db, 'jobs', existing.id, rest);
          if (rest.status_id && rest.status_id !== existing.status_id) {
            insertRow(db, 'job_status_history', {
              job_id: existing.id, from_status: statusName(existing.status_id), to_status: statusName(rest.status_id),
              note: `Status synced from ${conn.name}`, user_id: userId,
            });
          }
          updated++;
        } else {
          if (!rest.title) rest.title = rest.external_ref;
          if (!rest.status_id) rest.status_id = get('SELECT id FROM job_statuses ORDER BY sort_order, id LIMIT 1')?.id ?? null;
          rest.number = nextNumber('job');
          const id = insertRow(db, 'jobs', rest);
          insertRow(db, 'job_status_history', {
            job_id: id, to_status: statusName(rest.status_id), note: `Imported from ${conn.name}`, user_id: userId,
          });
          created++;
        }
      }
    }
  });
  return { created, updated, skipped };
}

/** Fetches (and optionally imports) a connection, recording a log entry. Used by routes and the scheduler. */
async function runConnection(conn, { doImport, userId }) {
  let result;
  let logEntry;
  try {
    result = await fetchConnection(conn);
    let summary = null;
    if (result.ok && doImport && conn.target !== 'none') summary = importRecords(conn, result.records, userId);
    const message = !result.ok
      ? `HTTP ${result.status}`
      : summary ? `Imported: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped`
        : `Fetched ${result.records.length} record(s)`;
    logEntry = { ok: result.ok ? 1 : 0, status_code: result.status, record_count: result.records.length, imported: summary ? 1 : 0, message };
    result.summary = summary;
  } catch (err) {
    logEntry = { ok: 0, status_code: null, record_count: 0, imported: 0, message: err.name === 'TimeoutError' ? 'Request timed out' : err.message };
    result = { ok: false, error: logEntry.message, records: [] };
  }
  let payload = result.raw !== undefined ? JSON.stringify(result.raw) : null;
  if (payload && payload.length > MAX_PAYLOAD_LOG) payload = `${payload.slice(0, MAX_PAYLOAD_LOG)}…(truncated)`;
  insertRow(db, 'api_fetch_logs', { connection_id: conn.id, ...logEntry, payload });
  run("UPDATE api_connections SET last_run_at = datetime('now'), last_status = ? WHERE id = ?", logEntry.message, conn.id);
  return { ...result, message: logEntry.message };
}

router.get('/targets', (req, res) => res.json(TARGET_FIELDS));

router.get('/', (req, res) => {
  res.json(all('SELECT * FROM api_connections ORDER BY name').map(redact));
});

router.get('/:id', (req, res) => {
  const conn = get('SELECT * FROM api_connections WHERE id = ?', req.params.id);
  if (!conn) throw notFound('Connection');
  conn.logs = all(
    'SELECT id, ok, status_code, record_count, imported, message, created_at FROM api_fetch_logs WHERE connection_id = ? ORDER BY id DESC LIMIT 25',
    conn.id);
  res.json(redact(conn));
});

router.get('/:id/logs/:logId', (req, res) => {
  const log = get('SELECT * FROM api_fetch_logs WHERE id = ? AND connection_id = ?', req.params.logId, req.params.id);
  if (!log) throw notFound('Log entry');
  res.json(log);
});

router.post('/', requireAdmin, (req, res) => {
  const data = pick(req.body, FIELDS);
  requireFields(data, ['name', 'url']);
  validate(data);
  const id = insertRow(db, 'api_connections', data);
  res.status(201).json(redact(get('SELECT * FROM api_connections WHERE id = ?', id)));
});

router.put('/:id', requireAdmin, (req, res) => {
  const data = pick(req.body, FIELDS);
  // The UI shows a placeholder for stored secrets; only overwrite when a new value is supplied.
  if (data.auth_value === '••••••••' || (req.body.keep_secret && !data.auth_value)) delete data.auth_value;
  validate(data);
  if (!updateRow(db, 'api_connections', req.params.id, data)) throw notFound('Connection');
  res.json(redact(get('SELECT * FROM api_connections WHERE id = ?', req.params.id)));
});

router.delete('/:id', requireAdmin, (req, res) => {
  if (!run('DELETE FROM api_connections WHERE id = ?', req.params.id).changes) throw notFound('Connection');
  res.json({ ok: true });
});

/** POST /:id/run  { import: boolean } — fetch now; returns a preview of records. */
router.post('/:id/run', async (req, res) => {
  const conn = get('SELECT * FROM api_connections WHERE id = ?', req.params.id);
  if (!conn) throw notFound('Connection');
  const result = await runConnection(conn, { doImport: !!req.body?.import, userId: req.user.id });
  res.json({
    ok: result.ok, status: result.status, message: result.message, summary: result.summary || null,
    record_count: result.records.length, preview: result.records.slice(0, 50),
    raw_preview: result.records.length ? undefined : result.raw,
  });
});

/** Runs any connections whose schedule is due. Called periodically from server/index.js. */
async function runScheduled() {
  const due = all(
    `SELECT * FROM api_connections WHERE schedule_minutes > 0 AND target != 'none'
     AND (last_run_at IS NULL OR datetime(last_run_at, '+' || schedule_minutes || ' minutes') <= datetime('now'))`);
  for (const conn of due) await runConnection(conn, { doImport: true, userId: null });
}

module.exports = router;
module.exports.runScheduled = runScheduled;
module.exports.parseCsv = parseCsv;
