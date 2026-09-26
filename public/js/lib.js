// Shared helpers: API client, HTML escaping, formatting, modals and toasts.

export const state = { user: null, settings: {}, statuses: [], users: [] };

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) {
    location.hash = '#/login';
    location.reload();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Escapes text for safe insertion into HTML. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const str = Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join('')
      : v && v.__raw ? v.value : esc(v);
    return out + str + s;
  }, '');
}
export const raw = (value) => ({ __raw: true, value: String(value ?? '') });

export function money(n) {
  const currency = state.settings.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(n) || 0);
  } catch {
    return `${currency} ${(Number(n) || 0).toFixed(2)}`;
  }
}

export function qty(n) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(Number(n) || 0);
}

export function date(d) {
  if (!d) return '';
  const dt = new Date(d.length <= 10 ? `${d}T00:00:00` : `${d.replace(' ', 'T')}Z`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(d) {
  if (!d) return '';
  const dt = new Date(`${d.replace(' ', 'T')}${d.includes('Z') || d.includes('+') ? '' : 'Z'}`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Query parameters from the hash, e.g. #/jobs?status_id=2 */
export function query() {
  return Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
}

/** Updates hash query params without adding a history entry or re-rendering. */
export function setQuery(params) {
  const base = location.hash.split('?')[0];
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  history.replaceState(null, '', `${base}${qs ? `?${qs}` : ''}`);
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function badge(text, cls = '') {
  return html`<span class="badge ${cls}">${text}</span>`;
}

export function statusPill(name, color) {
  if (!name) return '<span class="muted">—</span>';
  return html`<span class="pill" style="--c:${color || '#64748b'}">${name}</span>`;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export function showError(err) {
  toast(err.message || String(err), 'error');
}

/** Opens a modal. Returns { el, close }. onSubmit receives FormData-derived object when a <form> submits. */
export function modal({ title, body, wide = false, submitLabel = 'Save', onSubmit, footer = true }) {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = html`
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <form class="modal-form" novalidate>
        <header class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
        <div class="modal-body">${raw(body)}</div>
        ${raw(footer ? html`<footer class="modal-foot">
          <button type="button" class="btn" data-close>Cancel</button>
          ${raw(onSubmit ? html`<button type="submit" class="btn btn-primary">${submitLabel}</button>` : '')}
        </footer>` : '')}
      </form>
    </div>`;
  document.body.appendChild(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  const form = $('form', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    if (!form.reportValidity()) return;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const result = await onSubmit(formData(form), { el: root, close });
      if (result !== false) close();
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
    }
  });
  setTimeout(() => $('input:not([type=hidden]),select,textarea', root)?.focus(), 30);
  return { el: root, close };
}

export function confirmDialog(message, { danger = true, label = 'Delete' } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Please confirm',
      body: html`<p>${message}</p>`,
      footer: false,
    });
    const foot = document.createElement('footer');
    foot.className = 'modal-foot';
    foot.innerHTML = html`<button type="button" class="btn" data-no>Cancel</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${label}</button>`;
    $('form', m.el).appendChild(foot);
    $('[data-no]', foot).onclick = () => { m.close(); resolve(false); };
    $('[data-yes]', foot).onclick = () => { m.close(); resolve(true); };
    $('[data-yes]', foot).focus();
  });
}

/** Converts a form to a plain object (checkboxes -> booleans). */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'file') continue;
    else out[el.name] = el.value;
  }
  return out;
}

export function field(label, input, { hint = '', cls = '' } = {}) {
  return html`<label class="field ${cls}"><span>${label}</span>${raw(input)}${raw(hint ? html`<small class="muted">${hint}</small>` : '')}</label>`;
}

export function input(name, value = '', { type = 'text', required = false, placeholder = '', attrs = '' } = {}) {
  return html`<input name="${name}" type="${type}" value="${value ?? ''}" placeholder="${placeholder}" ${raw(required ? 'required' : '')} ${raw(attrs)}>`;
}

export function textarea(name, value = '', { rows = 3, placeholder = '' } = {}) {
  return html`<textarea name="${name}" rows="${rows}" placeholder="${placeholder}">${value ?? ''}</textarea>`;
}

/** options: array of [value, label]. */
export function select(name, options, value, { blank = null, attrs = '' } = {}) {
  const opts = (blank !== null ? [['', blank], ...options] : options)
    .map(([v, l]) => html`<option value="${v}" ${raw(String(v) === String(value ?? '') ? 'selected' : '')}>${l}</option>`).join('');
  return html`<select name="${name}" ${raw(attrs)}>${raw(opts)}</select>`;
}

export function emptyState(text, action = '') {
  return html`<div class="empty"><p>${text}</p>${raw(action)}</div>`;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Standard list page header with search box and primary action. */
export function pageHeader(title, { search = false, searchValue = '', actions = '' } = {}) {
  return html`<div class="page-head">
    <h1>${title}</h1>
    <div class="page-actions">
      ${raw(search ? html`<input type="search" class="search" placeholder="Search…" value="${searchValue}" data-search>` : '')}
      ${raw(actions)}
    </div>
  </div>`;
}

export const customerOptions = async () => (await api('/customers')).map((c) => [c.id, c.company ? `${c.name} (${c.company})` : c.name]);
export const jobOptions = async () => (await api('/jobs')).map((j) => [j.id, `${j.number} — ${j.title}`]);
