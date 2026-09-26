'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.CRM_DATA_DIR = tmp;
const app = require('../server/index');

let base;
let cookie = '';
let server;
let partner;

async function call(method, url, body, { form, raw } = {}) {
  const headers = { cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const data = await res.json();
  return { status: res.status, data };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // A fake "other company" API.
  partner = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer s3cret') { res.writeHead(401); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jobs') {
      return res.end(JSON.stringify({ data: { orders: [
        { ref: 'P-1', name: 'Install boiler', state: 'In Progress', client: { name: 'Partner Co' } },
        { ref: 'P-2', name: 'Survey site', state: 'Awaiting Parts', client: { name: 'Partner Co' } },
      ] } }));
    }
    if (req.url === '/stock') return res.end(JSON.stringify([{ code: 'W-1', title: 'Widget', qty: 40, price: 2.5 }]));
    res.writeHead(404); res.end('{}');
  });
  partner.listen(0);
  await new Promise((r) => partner.once('listening', r));
});

test.after(() => {
  server.close();
  partner.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('auth: setup, protected routes, login', async () => {
  assert.equal((await call('GET', '/customers')).status, 401);
  const st = await call('GET', '/auth/status');
  assert.equal(st.data.needsSetup, true);
  const setup = await call('POST', '/auth/setup', { username: 'admin', name: 'Admin', password: 'password123', company_name: 'Test Co' });
  assert.equal(setup.status, 200);
  assert.equal((await call('POST', '/auth/setup', { username: 'x', name: 'x', password: 'password123' })).status, 400);
  await call('POST', '/auth/logout');
  assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'password123' })).status, 200);
  assert.equal((await call('GET', '/settings')).data.company_name, 'Test Co');
});

let customerId;
let jobId;
test('customers and jobs with status history', async () => {
  const c = await call('POST', '/customers', { name: 'Jane Smith', company: 'Smith Ltd', email: 'jane@example.com' });
  assert.equal(c.status, 201);
  customerId = c.data.id;
  assert.equal((await call('POST', '/customers', { company: 'no name' })).status, 400);

  const statuses = (await call('GET', '/jobs/statuses')).data;
  const j = await call('POST', '/jobs', { title: 'Fit kitchen', customer_id: customerId });
  assert.equal(j.status, 201);
  assert.equal(j.data.number, 'JOB-1001');
  assert.equal(j.data.status, statuses[0].name);
  jobId = j.data.id;
  const inProgress = statuses.find((s) => s.name === 'In Progress');
  await call('PUT', `/jobs/${jobId}`, { status_id: inProgress.id, status_note: 'Started work' });
  await call('POST', `/jobs/${jobId}/notes`, { note: 'Materials ordered' });
  const detail = (await call('GET', `/jobs/${jobId}`)).data;
  assert.equal(detail.status, 'In Progress');
  assert.equal(detail.history.length, 3);
  assert.equal(detail.history.find((h) => h.note === 'Started work').from_status, 'New');
});

test('invoices: totals, payments, status', async () => {
  const inv = await call('POST', '/invoices', {
    customer_id: customerId, job_id: jobId, tax_rate: 10, discount: 5, status: 'sent',
    items: [{ description: 'Labour', quantity: 2, unit_price: 50 }, { description: 'Parts', quantity: 1, unit_price: 5 }],
  });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.number, 'INV-1001');
  assert.equal(inv.data.subtotal, 105);
  assert.equal(inv.data.tax, 10);
  assert.equal(inv.data.total, 110);
  assert.ok(inv.data.due_date > inv.data.issue_date);
  const id = inv.data.id;
  let p = await call('POST', `/invoices/${id}/payments`, { amount: 60, reference: 'REMIT-9' });
  assert.equal(p.data.display_status, 'partial');
  p = await call('POST', `/invoices/${id}/payments`, { amount: 50 });
  assert.equal(p.data.status, 'paid');
  assert.equal(p.data.balance, 0);
  const d = await call('DELETE', `/invoices/${id}/payments/${p.data.payments[1].id}`);
  assert.equal(d.data.status, 'sent');
  assert.equal((await call('POST', `/invoices/${id}/payments`, { amount: -1 })).status, 400);
  const overdue = await call('POST', '/invoices', { customer_id: customerId, issue_date: '2020-01-01', due_date: '2020-01-31', status: 'sent', items: [{ description: 'x', quantity: 1, unit_price: 10 }] });
  assert.equal(overdue.data.display_status, 'overdue');
  const dash = (await call('GET', '/dashboard')).data;
  assert.equal(dash.money.overdue_count, 1);
  assert.equal(dash.money.outstanding, 60);
});

test('inventory remittances post and void stock', async () => {
  const item = await call('POST', '/inventory', { sku: 'BOLT-1', name: 'Bolt', quantity: 10, unit_cost: 1, unit_price: 2, reorder_level: 3 });
  assert.equal(item.status, 201);
  assert.equal((await call('POST', '/inventory', { sku: 'bolt-1', name: 'dup' })).status, 400);
  const rem = await call('POST', '/remittances', {
    direction: 'outgoing', customer_id: customerId, job_id: jobId, reference: 'PO-77',
    items: [{ item_id: item.data.id, quantity: 8, unit_value: 2 }],
  });
  assert.equal(rem.data.number, 'REM-1001');
  assert.equal(rem.data.total_value, 16);
  let stock = (await call('GET', `/inventory/${item.data.id}`)).data;
  assert.equal(stock.quantity, 10, 'draft does not move stock');
  const posted = await call('POST', `/remittances/${rem.data.id}/post`, {});
  assert.equal(posted.data.status, 'posted');
  stock = (await call('GET', `/inventory/${item.data.id}`)).data;
  assert.equal(stock.quantity, 2);
  assert.equal((await call('PUT', `/remittances/${rem.data.id}`, { items: [] })).status, 400);
  assert.equal((await call('DELETE', `/remittances/${rem.data.id}`)).status, 400);

  // Insufficient stock is refused unless explicitly allowed.
  const big = await call('POST', '/remittances', { direction: 'outgoing', items: [{ item_id: item.data.id, quantity: 5 }] });
  assert.equal((await call('POST', `/remittances/${big.data.id}/post`, {})).status, 400);

  await call('POST', `/remittances/${rem.data.id}/void`, {});
  stock = (await call('GET', `/inventory/${item.data.id}`)).data;
  assert.equal(stock.quantity, 10);
  assert.deepEqual(stock.movements.map((m) => m.reason).sort(), ['opening', 'remittance_out', 'remittance_void']);

  await call('POST', `/inventory/${item.data.id}/adjust`, { change: -8, note: 'count' });
  const low = (await call('GET', '/inventory?low=1')).data;
  assert.equal(low.length, 1);
});

test('documents upload, list, download, delete', async () => {
  const form = new FormData();
  form.append('files', new Blob(['hello world'], { type: 'text/plain' }), 'notes é.txt');
  form.append('entity_type', 'job');
  form.append('entity_id', String(jobId));
  const up = await call('POST', '/documents', undefined, { form });
  assert.equal(up.status, 201);
  assert.equal(up.data[0].original_name, 'notes é.txt');
  const list = (await call('GET', `/documents?entity_type=job&entity_id=${jobId}`)).data;
  assert.equal(list.length, 1);
  const dl = await call('GET', `/documents/${list[0].id}/download`, undefined, { raw: true });
  assert.equal(await dl.text(), 'hello world');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal((await call('DELETE', `/documents/${list[0].id}`)).status, 200);
  assert.equal(fs.readdirSync(path.join(tmp, 'uploads')).length, 0);
});

test('API connections: fetch and import jobs + inventory', async () => {
  const partnerUrl = `http://127.0.0.1:${partner.address().port}`;
  const conn = await call('POST', '/integrations', {
    name: 'Partner jobs', url: `${partnerUrl}/jobs`, auth_type: 'bearer', auth_value: 's3cret',
    data_path: 'data.orders', target: 'jobs',
    field_map: JSON.stringify({ external_ref: 'ref', title: 'name', status: 'state', customer_name: 'client.name' }),
  });
  assert.equal(conn.status, 201);
  assert.equal(conn.data.auth_value, '••••••••', 'secret is redacted');
  const preview = await call('POST', `/integrations/${conn.data.id}/run`, { import: false });
  assert.equal(preview.data.record_count, 2);
  const imp = await call('POST', `/integrations/${conn.data.id}/run`, { import: true });
  assert.deepEqual(imp.data.summary, { created: 2, updated: 0, skipped: 0 });
  const jobs = (await call('GET', '/jobs?q=Install')).data;
  assert.equal(jobs[0].status, 'In Progress');
  assert.equal(jobs[0].customer_name, 'Partner Co');
  assert.ok((await call('GET', '/jobs/statuses')).data.some((s) => s.name === 'Awaiting Parts'));
  const again = await call('POST', `/integrations/${conn.data.id}/run`, { import: true });
  assert.deepEqual(again.data.summary, { created: 0, updated: 2, skipped: 0 });

  // Updating without a new secret keeps the stored one.
  await call('PUT', `/integrations/${conn.data.id}`, { name: 'Partner jobs 2', keep_secret: true });
  assert.equal((await call('POST', `/integrations/${conn.data.id}/run`, {})).data.ok, true);

  const stock = await call('POST', '/integrations', {
    name: 'Stock', url: `${partnerUrl}/stock`, auth_type: 'bearer', auth_value: 's3cret', target: 'inventory',
    field_map: { sku: 'code', name: 'title', quantity: 'qty', unit_price: 'price' },
  });
  const r = await call('POST', `/integrations/${stock.data.id}/run`, { import: true });
  assert.equal(r.data.summary.created, 1);
  const w = (await call('GET', '/inventory?q=W-1')).data[0];
  assert.equal(w.quantity, 40);
  assert.equal(w.unit_price, 2.5);

  const bad = await call('POST', '/integrations', { name: 'x', url: 'file:///etc/passwd' });
  assert.equal(bad.status, 400);
});

test('staff users cannot manage admin-only areas', async () => {
  await call('POST', '/users', { username: 'staff', name: 'Staff', password: 'password123' });
  await call('POST', '/auth/logout');
  await call('POST', '/auth/login', { username: 'staff', password: 'password123' });
  assert.equal((await call('PUT', '/settings', { company_name: 'Hacked' })).status, 403);
  assert.equal((await call('POST', '/integrations', { name: 'x', url: 'https://x.com' })).status, 403);
  assert.equal((await call('GET', '/customers')).status, 200);
});
