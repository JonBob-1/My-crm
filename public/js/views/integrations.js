import {
  api, state, html, raw, $, $$, dateTime, toast, showError, confirmDialog,
  field, input, textarea, select, pageHeader, emptyState, badge,
} from '../lib.js';

const AUTH_TYPES = [['none', 'No authentication'], ['bearer', 'Bearer token'], ['basic', 'Basic (user:password)'], ['apikey', 'API key header / query param']];
const TARGETS = [['none', 'Preview only (no import)'], ['customers', 'Customers'], ['inventory', 'Inventory items'], ['jobs', 'Jobs & statuses']];

export default async function integrations(el, [id], alive) {
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

const isAdmin = () => state.user.role === 'admin';

async function list(el, alive) {
  const rows = await api('/integrations');
  if (!alive()) return;
  el.innerHTML = html`${raw(pageHeader('API data connections', { actions: isAdmin() ? '<a class="btn btn-primary" href="#/integrations/new">New connection</a>' : '' }))}
    <p class="muted intro">Pull data from other companies’ APIs — supplier stock feeds, partner job trackers, customer lists and more.
      Requests run from the server, so credentials never reach the browser. Records can be imported into customers,
      inventory or jobs (including job statuses) manually or on a schedule.</p>
    ${raw(rows.length ? html`<div class="table-wrap card flush"><table class="table">
      <thead><tr><th>Name</th><th>Endpoint</th><th>Imports into</th><th>Schedule</th><th>Last run</th></tr></thead>
      <tbody>${raw(rows.map((c) => html`<tr class="clickable" data-href="#/integrations/${c.id}">
        <td><strong>${c.name}</strong></td><td class="mono small ellipsis">${c.method} ${c.url}</td>
        <td>${TARGETS.find(([v]) => v === c.target)?.[1] || c.target}</td>
        <td>${c.schedule_minutes ? `Every ${c.schedule_minutes} min` : 'Manual'}</td>
        <td>${c.last_run_at ? dateTime(c.last_run_at) : 'Never'}<div class="muted small">${c.last_status || ''}</div></td></tr>`).join(''))}</tbody>
      </table></div>` : emptyState('No API connections yet.', isAdmin() ? '<a class="btn btn-primary" href="#/integrations/new">Add a connection</a>' : ''))}`;
}

/** Collects dot-paths of scalar values from a sample record, for field-map suggestions. */
function samplePaths(obj, prefix = '', out = [], depth = 0) {
  if (obj == null || typeof obj !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) samplePaths(v, p, out, depth + 1);
    else if (!Array.isArray(v)) out.push(p);
  }
  return out;
}

async function detail(el, id, alive) {
  const isNew = id === 'new';
  const [conn, targets] = await Promise.all([isNew ? null : api(`/integrations/${id}`), api('/integrations/targets')]);
  if (!alive()) return;
  const c = conn || { method: 'GET', auth_type: 'none', target: 'none', schedule_minutes: 0 };
  const fieldMap = c.field_map ? JSON.parse(c.field_map) : {};
  const readOnly = !isAdmin();

  el.innerHTML = html`
    <div class="page-head"><div><a href="#/integrations" class="back">← API connections</a><h1>${isNew ? 'New API connection' : c.name}</h1>
      ${raw(!isNew ? html`<div class="muted">Last run: ${c.last_run_at ? dateTime(c.last_run_at) : 'never'} ${c.last_status ? `· ${c.last_status}` : ''}</div>` : '')}</div>
      <div class="page-actions">
        ${raw(!isNew ? '<button class="btn" data-run>Fetch preview</button>' : '')}
        ${raw(!isNew && c.target !== 'none' ? '<button class="btn btn-primary" data-import>Fetch &amp; import now</button>' : '')}
        ${raw(!isNew && isAdmin() ? '<button class="btn btn-danger-ghost" data-delete>Delete</button>' : '')}
      </div>
    </div>
    <form class="card" id="conn-form" novalidate>
      <fieldset ${raw(readOnly ? 'disabled' : '')}>
      <div class="form-grid cols-4">
        ${raw(field('Name *', input('name', c.name, { required: true, placeholder: 'Supplier stock feed' }), { cls: 'span-2' }))}
        ${raw(field('Method', select('method', [['GET', 'GET'], ['POST', 'POST']], c.method)))}
        ${raw(field('Schedule', select('schedule_minutes', [[0, 'Manual only'], [15, 'Every 15 min'], [60, 'Hourly'], [360, 'Every 6 hours'], [1440, 'Daily']], c.schedule_minutes), { hint: 'Scheduled runs import automatically.' }))}
        ${raw(field('URL *', input('url', c.url, { type: 'url', required: true, placeholder: 'https://api.partner.com/v1/orders' }), { cls: 'span-4' }))}
        ${raw(field('Authentication', select('auth_type', AUTH_TYPES, c.auth_type)))}
        ${raw(field('Header / param name', input('auth_key', c.auth_key, { placeholder: 'X-API-Key or ?api_key' }), { hint: 'API key only. Prefix with ? to send as query param.', cls: 'auth-key' }))}
        ${raw(field('Secret', input('auth_value', '', { type: 'password', placeholder: c.has_secret ? 'Saved — leave blank to keep' : 'Token / key / user:password', attrs: 'autocomplete="new-password"' }), { cls: 'span-2' }))}
        ${raw(field('Extra headers (JSON)', textarea('headers', c.headers || '', { rows: 2, placeholder: '{"Accept": "application/json"}' }), { cls: 'span-2' }))}
        ${raw(field('Request body (POST, JSON)', textarea('body', c.body || '', { rows: 2 }), { cls: 'span-2' }))}
        ${raw(field('Records path', input('data_path', c.data_path, { placeholder: 'e.g. data.items' }), { hint: 'Where the list of records sits in the JSON response. Blank = top level.', cls: 'span-2' }))}
        ${raw(field('Import into', select('target', TARGETS, c.target), { cls: 'span-2' }))}
      </div>
      <div id="map"></div>
      ${raw(readOnly ? '' : '<div class="form-actions"><button class="btn btn-primary" type="submit">Save connection</button></div>')}
      </fieldset>
    </form>
    <div id="result"></div>
    ${raw(!isNew ? html`<section class="card"><div class="card-head"><h3>Run history</h3></div>
      ${raw(c.logs.length ? html`<table class="table table-compact"><thead><tr><th>When</th><th>Result</th><th class="num">HTTP</th><th class="num">Records</th><th></th></tr></thead><tbody>${raw(c.logs.map((l) => html`<tr>
        <td class="nowrap">${dateTime(l.created_at)}</td><td>${raw(badge(l.ok ? (l.imported ? 'imported' : 'ok') : 'error', l.ok ? 'b-paid' : 'b-overdue'))} ${l.message || ''}</td>
        <td class="num">${l.status_code ?? ''}</td><td class="num">${l.record_count ?? ''}</td>
        <td><button class="btn btn-sm btn-ghost" data-log="${l.id}">Raw</button></td></tr>`).join(''))}</tbody></table>` : '<p class="muted">Not run yet.</p>')}
    </section>` : '')}`;

  const form = $('#conn-form', el);
  // form.elements avoids clashes between input names (name, method, target) and built-in form properties.
  const f = form.elements;
  let paths = [];
  const renderMap = () => {
    const target = f.target.value;
    const fields = targets[target] || [];
    $('#map', el).innerHTML = fields.length ? html`
      <h3>Field mapping</h3>
      <p class="muted small">For each CRM field, enter the field name (or dot path, e.g. <code>address.city</code>) in the API records.
        ${target === 'inventory' ? 'Items are matched by SKU. A mapped quantity overwrites stock on hand (logged as an API sync).' : ''}
        ${target === 'customers' ? 'Customers are matched by external ref, then email, then name.' : ''}
        ${target === 'jobs' ? 'Jobs are matched by external ref. Status names are matched to your job statuses (new ones are created), and changes are logged in the job history.' : ''}</p>
      <datalist id="paths">${raw(paths.map((p) => html`<option value="${p}"></option>`).join(''))}</datalist>
      <div class="form-grid cols-3">${raw(fields.map((f) => field(f, html`<input name="map_${f}" value="${fieldMap[f] || ''}" list="paths" placeholder="source field">`)).join(''))}</div>`
      : '';
  };
  const toggleAuth = () => {
    $('.auth-key', el).style.display = f.auth_type.value === 'apikey' ? '' : 'none';
    f.auth_value.closest('.field').style.display = f.auth_type.value === 'none' ? 'none' : '';
  };
  f.target.addEventListener('change', () => {
    $$('[name^=map_]', form).forEach((i) => { fieldMap[i.name.slice(4)] = i.value; });
    renderMap();
  });
  f.auth_type.addEventListener('change', toggleAuth);
  renderMap();
  toggleAuth();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const map = {};
    $$('[name^=map_]', form).forEach((i) => { if (i.value.trim()) map[i.name.slice(4)] = i.value.trim(); });
    const body = {
      name: f.name.value, url: f.url.value, method: f.method.value, schedule_minutes: f.schedule_minutes.value,
      auth_type: f.auth_type.value, auth_key: f.auth_key.value, headers: f.headers.value, body: f.body.value,
      data_path: f.data_path.value, target: f.target.value, field_map: JSON.stringify(map), keep_secret: true,
    };
    if (f.auth_value.value) body.auth_value = f.auth_value.value;
    try {
      const saved = await api(isNew ? '/integrations' : `/integrations/${id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast('Connection saved');
      if (isNew) location.hash = `#/integrations/${saved.id}`;
      else detail(el, id, alive);
    } catch (err) { showError(err); }
  });

  const run = async (doImport, btn) => {
    btn.disabled = true;
    const box = $('#result', el);
    box.innerHTML = '<section class="card"><div class="loading">Contacting API…</div></section>';
    try {
      const r = await api(`/integrations/${id}/run`, { method: 'POST', body: { import: doImport } });
      if (!alive()) return;
      paths = r.preview[0] ? samplePaths(r.preview[0]) : [];
      const cols = paths.slice(0, 8);
      box.innerHTML = html`<section class="card">
        <div class="card-head"><h3>Result</h3>${raw(badge(r.ok ? 'success' : 'failed', r.ok ? 'b-paid' : 'b-overdue'))}</div>
        <p><strong>${r.message}</strong> ${raw(r.status ? html`<span class="muted">(HTTP ${r.status})</span>` : '')}</p>
        ${raw(r.preview.length ? html`<p class="muted small">Showing ${r.preview.length} of ${r.record_count} record(s). Detected fields are now suggested in the field mapping.</p>
          <div class="table-wrap"><table class="table table-compact"><thead><tr>${raw(cols.map((p) => html`<th>${p}</th>`).join(''))}</tr></thead>
          <tbody>${raw(r.preview.slice(0, 20).map((rec) => html`<tr>${raw(cols.map((p) => html`<td>${String(p.split('.').reduce((o, k) => o?.[k], rec) ?? '')}</td>`).join(''))}</tr>`).join(''))}</tbody></table></div>`
          : html`<p class="muted">No records found at the configured path. Raw response:</p><pre class="raw">${JSON.stringify(r.raw_preview, null, 2)?.slice(0, 5000) || ''}</pre>`)}
      </section>`;
      $$('[name^=map_]', form).forEach((i) => { fieldMap[i.name.slice(4)] = i.value; });
      renderMap();
      if (doImport) toast(r.message, r.ok ? 'ok' : 'error');
    } catch (err) {
      box.innerHTML = '';
      showError(err);
    } finally {
      btn.disabled = false;
    }
  };
  $('[data-run]', el)?.addEventListener('click', (e) => run(false, e.currentTarget));
  $('[data-import]', el)?.addEventListener('click', (e) => run(true, e.currentTarget));
  $$('[data-log]', el).forEach((b) => b.addEventListener('click', async () => {
    const log = await api(`/integrations/${id}/logs/${b.dataset.log}`);
    let pretty = log.payload || '';
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* truncated or not JSON */ }
    $('#result', el).innerHTML = html`<section class="card"><div class="card-head"><h3>Raw response — ${dateTime(log.created_at)}</h3></div>
      <pre class="raw">${pretty.slice(0, 50000)}</pre></section>`;
    $('#result', el).scrollIntoView({ behavior: 'smooth' });
  }));
  $('[data-delete]', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete connection "${c.name}" and its history?`))) return;
    try {
      await api(`/integrations/${id}`, { method: 'DELETE' });
      toast('Connection deleted');
      location.hash = '#/integrations';
    } catch (err) { showError(err); }
  });
}
