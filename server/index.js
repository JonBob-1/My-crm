'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { db, all, get, run, getSettings, setSetting } = require('./db');
const auth = require('./auth');
const { HttpError, badRequest, requireFields, insertRow, today, round2 } = require('./util');
const invoices = require('./routes/invoices');
const integrations = require('./routes/integrations');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Basic CSRF defence: state-changing API calls must come from this origin.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  next();
});

// ---------- Auth ----------
const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - rec.start > 15 * 60e3) { rec.count = 0; rec.start = now; }
  rec.count++;
  loginAttempts.set(ip, rec);
  return rec.count > 20;
}

app.get('/api/auth/status', (req, res) => {
  res.json({ user: auth.currentUser(req), needsSetup: auth.userCount() === 0, company: getSettings().company_name });
});

app.post('/api/auth/setup', (req, res) => {
  if (auth.userCount() > 0) throw badRequest('Setup already completed');
  const { username, name, password, company_name: companyName } = req.body || {};
  requireFields({ username, name, password }, ['username', 'name', 'password']);
  if (String(password).length < 8) throw badRequest('Password must be at least 8 characters');
  const id = insertRow(db, 'users', { username, name, password_hash: auth.hashPassword(password), role: 'admin' });
  if (companyName) setSetting('company_name', companyName);
  auth.createSession(res, id, req.secure);
  res.json({ user: { id, username, name, role: 'admin' } });
});

app.post('/api/auth/login', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE username = ?', String(username || ''));
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  loginAttempts.delete(req.ip);
  auth.createSession(res, user.id, req.secure);
  res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// Everything below requires a signed-in user.
app.use('/api', auth.requireAuth);

app.post('/api/auth/password', (req, res) => {
  const { current, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(current || '', user.password_hash)) throw badRequest('Current password is incorrect');
  if (String(password || '').length < 8) throw badRequest('New password must be at least 8 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
  res.json({ ok: true });
});

// ---------- Users (admin) ----------
app.get('/api/users', (req, res) => res.json(auth.listUsers()));

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const { username, name, password, role = 'staff' } = req.body || {};
  requireFields({ username, name, password }, ['username', 'name', 'password']);
  if (String(password).length < 8) throw badRequest('Password must be at least 8 characters');
  if (!['admin', 'staff'].includes(role)) throw badRequest('Invalid role');
  if (get('SELECT id FROM users WHERE username = ?', username)) throw badRequest('Username already taken');
  insertRow(db, 'users', { username, name, role, password_hash: auth.hashPassword(password) });
  res.status(201).json(auth.listUsers());
});

app.put('/api/users/:id', auth.requireAdmin, (req, res) => {
  const { name, role, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  if (role && !['admin', 'staff'].includes(role)) throw badRequest('Invalid role');
  if (role === 'staff' && user.role === 'admin' && get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n <= 1) {
    throw badRequest('At least one admin is required');
  }
  if (name) run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  if (role) run('UPDATE users SET role = ? WHERE id = ?', role, user.id);
  if (password) {
    if (String(password).length < 8) throw badRequest('Password must be at least 8 characters');
    run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
  }
  res.json(auth.listUsers());
});

app.delete('/api/users/:id', auth.requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) throw badRequest('You cannot delete your own account');
  run('DELETE FROM users WHERE id = ?', req.params.id);
  res.json(auth.listUsers());
});

// ---------- Settings ----------
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', auth.requireAdmin, (req, res) => {
  const current = getSettings();
  for (const [k, v] of Object.entries(req.body || {})) if (k in current) setSetting(k, v);
  res.json(getSettings());
});

// ---------- Dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const inv = all('SELECT * FROM invoices WHERE status != \'void\'').map(invoices.withTotals);
  const monthStart = `${today().slice(0, 7)}-01`;
  const paidThisMonth = get('SELECT IFNULL(SUM(amount),0) AS s FROM payments WHERE date >= ?', monthStart).s;
  res.json({
    counts: {
      customers: get('SELECT COUNT(*) AS n FROM customers').n,
      open_jobs: get('SELECT COUNT(*) AS n FROM jobs j LEFT JOIN job_statuses s ON s.id = j.status_id WHERE IFNULL(s.is_closed,0) = 0').n,
      inventory_items: get('SELECT COUNT(*) AS n FROM inventory_items').n,
      draft_remittances: get("SELECT COUNT(*) AS n FROM remittances WHERE status = 'draft'").n,
      documents: get('SELECT COUNT(*) AS n FROM documents').n,
    },
    money: {
      outstanding: round2(inv.filter((i) => i.status === 'sent').reduce((s, i) => s + i.balance, 0)),
      overdue: round2(inv.filter((i) => i.display_status === 'overdue').reduce((s, i) => s + i.balance, 0)),
      overdue_count: inv.filter((i) => i.display_status === 'overdue').length,
      paid_this_month: round2(paidThisMonth),
      draft_count: inv.filter((i) => i.status === 'draft').length,
    },
    jobs_by_status: all(
      `SELECT s.id, s.name, s.color, s.is_closed, COUNT(j.id) AS count FROM job_statuses s
       LEFT JOIN jobs j ON j.status_id = s.id GROUP BY s.id ORDER BY s.sort_order, s.id`),
    jobs_due: all(
      `SELECT j.id, j.number, j.title, j.due_date, j.priority, s.name AS status, s.color AS status_color, c.name AS customer_name
       FROM jobs j LEFT JOIN job_statuses s ON s.id = j.status_id LEFT JOIN customers c ON c.id = j.customer_id
       WHERE IFNULL(s.is_closed,0) = 0 AND j.due_date IS NOT NULL ORDER BY j.due_date LIMIT 8`),
    recent_activity: all(
      `SELECT h.*, j.number, j.title, u.name AS user_name FROM job_status_history h
       JOIN jobs j ON j.id = h.job_id LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 10`),
    low_stock: all('SELECT id, sku, name, quantity, reorder_level, unit FROM inventory_items WHERE quantity <= reorder_level ORDER BY name LIMIT 10'),
    overdue_invoices: inv.filter((i) => i.display_status === 'overdue').slice(0, 8)
      .map((i) => ({ ...i, customer_name: get('SELECT name FROM customers WHERE id = ?', i.customer_id)?.name })),
  });
});

// ---------- Feature routers ----------
app.use('/api/customers', require('./routes/customers'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/invoices', invoices);
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/remittances', require('./routes/remittances'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/integrations', integrations);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Front end ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- Errors ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (String(err.message).includes('FOREIGN KEY constraint failed')) {
    return res.status(400).json({ error: 'A linked record does not exist or is still in use' });
  }
  if (String(err.message).includes('CHECK constraint failed')) return res.status(400).json({ error: 'Invalid value supplied' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

// ---------- Start ----------
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => console.log(`CRM running at http://localhost:${PORT}`));

  // Scheduled API pulls + expired session cleanup.
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
      await integrations.runScheduled();
    } catch (err) {
      console.error('Scheduler error:', err);
    } finally {
      busy = false;
    }
  }, 60_000).unref();
}

module.exports = app;
