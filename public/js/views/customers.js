import {
  api, html, raw, $, date, money, statusPill, modal, confirmDialog, toast, showError,
  field, input, textarea, pageHeader, emptyState, debounce, badge, query, setQuery,
} from '../lib.js';
import { docPanel } from './doc-panel.js';

export default async function customers(el, [id], alive) {
  if (id === 'new') {
    await list(el, alive);
    return editCustomer(null, (c) => { location.hash = `#/customers/${c.id}`; });
  }
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

async function list(el, alive) {
  const q = query().q || '';
  el.innerHTML = html`${raw(pageHeader('Customers', { search: true, searchValue: q, actions: '<button class="btn btn-primary" data-new>New customer</button>' }))}
    <div id="list"></div>`;
  const load = async (term) => {
    const rows = await api(`/customers?q=${encodeURIComponent(term)}`);
    if (!alive()) return;
    $('#list', el).innerHTML = rows.length ? html`<div class="table-wrap card flush"><table class="table">
      <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th class="num">Jobs</th><th class="num">Invoices</th></tr></thead>
      <tbody>${raw(rows.map((c) => html`<tr class="clickable" data-href="#/customers/${c.id}">
        <td><strong>${c.name}</strong></td><td>${c.company || ''}</td>
        <td>${raw(c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : '')}</td>
        <td class="nowrap">${c.phone || ''}</td><td class="num">${c.job_count}</td><td class="num">${c.invoice_count}</td>
      </tr>`).join(''))}</tbody></table></div>`
      : emptyState(term ? 'No customers match your search.' : 'No customers yet. Add your first one.');
  };
  $('[data-search]', el).addEventListener('input', debounce((e) => { setQuery({ q: e.target.value }); load(e.target.value); }));
  $('[data-new]', el).onclick = () => editCustomer(null, (c) => { location.hash = `#/customers/${c.id}`; });
  await load(q);
}

export function editCustomer(c, onSaved) {
  modal({
    title: c ? 'Edit customer' : 'New customer',
    body: html`<div class="form-grid">
      ${raw(field('Name *', input('name', c?.name, { required: true })))}
      ${raw(field('Company', input('company', c?.company)))}
      ${raw(field('Email', input('email', c?.email, { type: 'email' })))}
      ${raw(field('Phone', input('phone', c?.phone, { type: 'tel' })))}
      ${raw(field('Address', textarea('address', c?.address), { cls: 'span-2' }))}
      ${raw(field('Notes', textarea('notes', c?.notes), { cls: 'span-2' }))}
      ${raw(field('External reference', input('external_ref', c?.external_ref), { hint: 'ID of this customer in another system (used by API imports).' }))}
    </div>`,
    onSubmit: async (data) => {
      const saved = await api(c ? `/customers/${c.id}` : '/customers', { method: c ? 'PUT' : 'POST', body: data });
      toast('Customer saved');
      onSaved(saved);
    },
  });
}

async function detail(el, id, alive) {
  const c = await api(`/customers/${id}`);
  if (!alive()) return;
  el.innerHTML = html`
    <div class="page-head">
      <div><a href="#/customers" class="back">← Customers</a><h1>${c.name}</h1>${raw(c.company ? html`<div class="muted">${c.company}</div>` : '')}</div>
      <div class="page-actions">
        <a class="btn" href="#/jobs/new?customer_id=${c.id}">New job</a>
        <a class="btn" href="#/invoices/new?customer_id=${c.id}">New invoice</a>
        <button class="btn" data-edit>Edit</button>
        <button class="btn btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Contact details</h3></div>
        <dl class="details">
          <dt>Email</dt><dd>${raw(c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : '—')}</dd>
          <dt>Phone</dt><dd>${raw(c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a>` : '—')}</dd>
          <dt>Address</dt><dd class="pre">${c.address || '—'}</dd>
          <dt>Notes</dt><dd class="pre">${c.notes || '—'}</dd>
          ${raw(c.external_ref ? html`<dt>External ref</dt><dd>${c.external_ref}</dd>` : '')}
          <dt>Added</dt><dd>${date(c.created_at)}</dd>
        </dl>
      </section>
      <section class="card">
        <div class="card-head"><h3>Jobs</h3></div>
        ${raw(c.jobs.length ? html`<table class="table table-compact"><tbody>${raw(c.jobs.map((j) => html`
          <tr class="clickable" data-href="#/jobs/${j.id}"><td><strong>${j.number}</strong> ${j.title}</td>
          <td>${raw(statusPill(j.status, j.status_color))}</td><td class="nowrap">${date(j.due_date)}</td></tr>`).join(''))}</tbody></table>`
          : emptyState('No jobs yet.'))}
      </section>
      <section class="card">
        <div class="card-head"><h3>Invoices</h3></div>
        <div id="cust-invoices"></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Remittances</h3></div>
        ${raw(c.remittances.length ? html`<table class="table table-compact"><tbody>${raw(c.remittances.map((r) => html`
          <tr class="clickable" data-href="#/remittances/${r.id}"><td><strong>${r.number}</strong></td>
          <td>${r.direction}</td><td>${raw(badge(r.status, `b-${r.status}`))}</td><td class="nowrap">${date(r.date)}</td></tr>`).join(''))}</tbody></table>`
          : emptyState('No remittances yet.'))}
      </section>
    </div>
    <div id="docs"></div>`;

  api(`/invoices?customer_id=${c.id}`).then((rows) => {
    if (!alive()) return;
    $('#cust-invoices', el).innerHTML = rows.length ? html`<table class="table table-compact"><tbody>${raw(rows.map((i) => html`
      <tr class="clickable" data-href="#/invoices/${i.id}"><td><strong>${i.number}</strong></td>
      <td>${raw(badge(i.display_status, `b-${i.display_status}`))}</td><td class="num">${money(i.total)}</td>
      <td class="num muted">${i.balance > 0 && i.status !== 'void' ? `${money(i.balance)} due` : ''}</td></tr>`).join(''))}</tbody></table>`
      : emptyState('No invoices yet.');
  }).catch(showError);

  $('[data-edit]', el).onclick = () => editCustomer(c, () => detail(el, id, alive));
  $('[data-delete]', el).onclick = async () => {
    if (!(await confirmDialog(`Delete ${c.name}? Their jobs and invoices will be kept but unlinked.`))) return;
    try {
      await api(`/customers/${c.id}`, { method: 'DELETE' });
      toast('Customer deleted');
      location.hash = '#/customers';
    } catch (err) { showError(err); }
  };
  await docPanel($('#docs', el), 'customer', c.id);
}
