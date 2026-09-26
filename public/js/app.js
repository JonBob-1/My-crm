import { api, state, html, raw, $, $$, showError, toast } from './lib.js';
import dashboard from './views/dashboard.js';
import customers from './views/customers.js';
import jobs from './views/jobs.js';
import invoices from './views/invoices.js';
import inventory from './views/inventory.js';
import remittances from './views/remittances.js';
import documents from './views/documents.js';
import integrations from './views/integrations.js';
import settings from './views/settings.js';

const NAV = [
  ['dashboard', 'Dashboard', '◧'],
  ['customers', 'Customers', '☺'],
  ['jobs', 'Jobs', '▤'],
  ['invoices', 'Invoices', '$'],
  ['inventory', 'Inventory', '▦'],
  ['remittances', 'Remittances', '⇄'],
  ['documents', 'Documents', '▯'],
  ['integrations', 'API Data', '⇣'],
  ['settings', 'Settings', '⚙'],
];

const VIEWS = { dashboard, customers, jobs, invoices, inventory, remittances, documents, integrations, settings };

const app = $('#app');

function renderShell() {
  app.innerHTML = html`
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark">◆</span><span>${state.settings.company_name || 'CRM'}</span></div>
        <nav>${raw(NAV.map(([key, label, icon]) => html`
          <a href="#/${key}" data-nav="${key}"><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`).join(''))}
        </nav>
        <div class="sidebar-foot">
          <div class="me"><strong>${state.user.name}</strong><small>${state.user.role}</small></div>
          <button class="btn btn-ghost btn-sm" id="logout">Sign out</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu" aria-label="Menu">☰</button>
          <span class="topbar-title" id="topbar-title"></span>
        </header>
        <main id="view" class="view"></main>
      </div>
    </div>`;
  $('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    location.hash = '';
    location.reload();
  };
  $('#menu').onclick = () => $('#sidebar').classList.toggle('open');
}

let renderToken = 0;
async function route() {
  if (!state.user) return;
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [section = 'dashboard', ...rest] = parts;
  const view = VIEWS[section] || dashboard;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (VIEWS[section] ? section : 'dashboard')));
  $('#sidebar').classList.remove('open');
  document.body.classList.remove('print-mode');
  const label = NAV.find(([k]) => k === section)?.[1] || 'Dashboard';
  $('#topbar-title').textContent = label;
  document.title = `${label} · ${state.settings.company_name || 'CRM'}`;
  const el = $('#view');
  const token = ++renderToken;
  el.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await view(el, rest, () => token === renderToken);
  } catch (err) {
    if (token === renderToken) el.innerHTML = html`<div class="empty"><p>Could not load this page: ${err.message}</p></div>`;
  }
  window.scrollTo(0, 0);
}

export async function refreshLookups() {
  [state.settings, state.statuses, state.users] = await Promise.all([api('/settings'), api('/jobs/statuses'), api('/users')]);
}

function authScreen({ needsSetup, company }) {
  document.title = needsSetup ? 'Set up your CRM' : `Sign in · ${company || 'CRM'}`;
  app.innerHTML = html`
    <div class="auth-wrap">
      <form class="auth-card" id="auth-form">
        <div class="brand brand-lg"><span class="brand-mark">◆</span><span>${needsSetup ? 'Welcome' : company || 'CRM'}</span></div>
        <p class="muted">${needsSetup ? 'Create the first administrator account to get started.' : 'Sign in to continue.'}</p>
        ${raw(needsSetup ? html`
          <label class="field"><span>Company name</span><input name="company_name" placeholder="Acme Ltd"></label>
          <label class="field"><span>Your name</span><input name="name" required></label>` : '')}
        <label class="field"><span>Username</span><input name="username" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" minlength="${needsSetup ? 8 : 1}" required></label>
        <button class="btn btn-primary btn-block" type="submit">${needsSetup ? 'Create account' : 'Sign in'}</button>
        <p class="form-error" id="auth-error" role="alert"></p>
      </form>
    </div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    try {
      const res = await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body });
      state.user = res.user;
      await start();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });
  $('input', app).focus();
}

async function start() {
  try {
    const status = await api('/auth/status');
    if (!status.user) return authScreen(status);
    state.user = status.user;
    await refreshLookups();
    renderShell();
    if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
    else route();
  } catch (err) {
    showError(err);
  }
}

window.addEventListener('hashchange', route);
// Table rows etc. can navigate with data-href (ignoring clicks on inner links/buttons).
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a,button,input,select,label')) location.hash = row.dataset.href;
});
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || 'Something went wrong', 'error'));
start();
