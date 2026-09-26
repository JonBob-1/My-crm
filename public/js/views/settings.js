import {
  api, state, html, raw, $, $$, modal, confirmDialog, toast, showError, field, input, textarea, select, date,
} from '../lib.js';
import { refreshLookups } from '../app.js';

export default async function settings(el, _params, alive) {
  await refreshLookups();
  if (!alive()) return;
  const s = state.settings;
  const admin = state.user.role === 'admin';
  const statuses = await api('/jobs/statuses');
  if (!alive()) return;

  el.innerHTML = html`
    <div class="page-head"><h1>Settings</h1></div>
    <form class="card" id="company" novalidate>
      <div class="card-head"><h3>Company &amp; invoicing</h3></div>
      <fieldset ${raw(admin ? '' : 'disabled')}>
      <div class="form-grid cols-3">
        ${raw(field('Company name', input('company_name', s.company_name)))}
        ${raw(field('Email', input('company_email', s.company_email, { type: 'email' })))}
        ${raw(field('Phone', input('company_phone', s.company_phone)))}
        ${raw(field('Address (shown on invoices)', textarea('company_address', s.company_address), { cls: 'span-3' }))}
        ${raw(field('Currency code', input('currency', s.currency, { placeholder: 'USD, GBP, EUR, AUD…', attrs: 'maxlength="3"' })))}
        ${raw(field('Default tax rate %', input('default_tax_rate', s.default_tax_rate, { type: 'number', attrs: 'step="0.01"' })))}
        ${raw(field('Payment terms (days)', input('payment_terms_days', s.payment_terms_days, { type: 'number' })))}
        ${raw(field('Invoice prefix', input('invoice_prefix', s.invoice_prefix)))}
        ${raw(field('Next invoice number', input('invoice_next', s.invoice_next, { type: 'number' })))}
        ${raw(field('Invoice footer', input('invoice_footer', s.invoice_footer)))}
        ${raw(field('Job prefix', input('job_prefix', s.job_prefix)))}
        ${raw(field('Next job number', input('job_next', s.job_next, { type: 'number' })))}
        <span></span>
        ${raw(field('Remittance prefix', input('remittance_prefix', s.remittance_prefix)))}
        ${raw(field('Next remittance number', input('remittance_next', s.remittance_next, { type: 'number' })))}
      </div>
      ${raw(admin ? '<div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>' : '<p class="muted">Only admins can change these settings.</p>')}
      </fieldset>
    </form>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Job process statuses</h3>${raw(admin ? '<button class="btn btn-sm" data-add-status>Add status</button>' : '')}</div>
        <p class="muted small">These are the stages jobs move through, in order. “Closed” stages don’t count as open work.</p>
        <table class="table table-compact"><tbody>${raw(statuses.map((st) => html`<tr>
          <td><span class="swatch" style="background:${st.color}"></span> <strong>${st.name}</strong>${raw(st.is_closed ? ' <span class="muted small">(closed)</span>' : '')}</td>
          <td class="num muted">${st.job_count} job(s)</td>
          <td class="row-actions">${raw(admin ? html`<button class="btn btn-sm btn-ghost" data-edit-status="${st.id}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-del-status="${st.id}">✕</button>` : '')}</td></tr>`).join(''))}</tbody></table>
      </section>

      <section class="card">
        <div class="card-head"><h3>Users</h3>${raw(admin ? '<button class="btn btn-sm" data-add-user>Add user</button>' : '')}</div>
        <table class="table table-compact"><tbody>${raw(state.users.map((u) => html`<tr>
          <td><strong>${u.name}</strong><div class="muted small">${u.username}</div></td><td>${u.role}</td><td class="muted small">${date(u.created_at)}</td>
          <td class="row-actions">${raw(admin ? html`<button class="btn btn-sm btn-ghost" data-edit-user="${u.id}">Edit</button>
            ${raw(u.id !== state.user.id ? html`<button class="btn btn-sm btn-ghost" data-del-user="${u.id}">✕</button>` : '')}` : '')}</td></tr>`).join(''))}</tbody></table>
        <button class="btn btn-sm" data-password>Change my password</button>
      </section>
    </div>`;

  const reload = () => settings(el, _params, alive);

  $('#company', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (body.currency) body.currency = body.currency.toUpperCase();
    try {
      await api('/settings', { method: 'PUT', body });
      toast('Settings saved');
      await refreshLookups();
      $('.brand span:last-child').textContent = state.settings.company_name;
    } catch (err) { showError(err); }
  });

  const statusForm = (st) => modal({
    title: st ? `Edit status "${st.name}"` : 'New status',
    body: html`<div class="form-grid">
      ${raw(field('Name *', input('name', st?.name, { required: true })))}
      ${raw(field('Colour', input('color', st?.color || '#6366f1', { type: 'color' })))}
      ${raw(field('Order', input('sort_order', st?.sort_order ?? statuses.length + 1, { type: 'number' })))}
      <label class="check"><input type="checkbox" name="is_closed" ${raw(st?.is_closed ? 'checked' : '')}> Closed stage (work finished)</label>
    </div>`,
    onSubmit: async (data) => {
      await api(st ? `/jobs/statuses/${st.id}` : '/jobs/statuses', { method: st ? 'PUT' : 'POST', body: data });
      toast('Status saved');
      reload();
    },
  });
  $('[data-add-status]', el)?.addEventListener('click', () => statusForm(null));
  $$('[data-edit-status]', el).forEach((b) => b.addEventListener('click', () => statusForm(statuses.find((x) => String(x.id) === b.dataset.editStatus))));
  $$('[data-del-status]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this status?'))) return;
    try { await api(`/jobs/statuses/${b.dataset.delStatus}`, { method: 'DELETE' }); reload(); } catch (err) { showError(err); }
  }));

  const userForm = (u) => modal({
    title: u ? `Edit ${u.name}` : 'New user',
    body: html`<div class="form-grid">
      ${raw(u ? '' : field('Username *', input('username', '', { required: true, attrs: 'autocomplete="off"' })))}
      ${raw(field('Full name *', input('name', u?.name, { required: true })))}
      ${raw(field('Role', select('role', [['staff', 'Staff'], ['admin', 'Admin']], u?.role || 'staff')))}
      ${raw(field(u ? 'New password' : 'Password *', input('password', '', { type: 'password', required: !u, attrs: 'minlength="8" autocomplete="new-password"' }), { hint: u ? 'Leave blank to keep current password.' : 'At least 8 characters.' }))}
    </div>`,
    onSubmit: async (data) => {
      if (u && !data.password) delete data.password;
      await api(u ? `/users/${u.id}` : '/users', { method: u ? 'PUT' : 'POST', body: data });
      toast('User saved');
      reload();
    },
  });
  $('[data-add-user]', el)?.addEventListener('click', () => userForm(null));
  $$('[data-edit-user]', el).forEach((b) => b.addEventListener('click', () => userForm(state.users.find((u) => String(u.id) === b.dataset.editUser))));
  $$('[data-del-user]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this user? Records they created are kept.'))) return;
    try { await api(`/users/${b.dataset.delUser}`, { method: 'DELETE' }); reload(); } catch (err) { showError(err); }
  }));
  $('[data-password]', el).onclick = () => modal({
    title: 'Change password',
    body: html`${raw(field('Current password', input('current', '', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })))}
      ${raw(field('New password', input('password', '', { type: 'password', required: true, attrs: 'minlength="8" autocomplete="new-password"' })))}`,
    onSubmit: async (data) => {
      await api('/auth/password', { method: 'POST', body: data });
      toast('Password changed');
    },
  });
}
