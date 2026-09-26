import {
  api, state, html, raw, $, $$, date, money, qty, modal, confirmDialog, toast, showError,
  field, input, textarea, select, pageHeader, emptyState, debounce, badge, query, setQuery,
  customerOptions, jobOptions, todayISO,
} from '../lib.js';
import { docPanel } from './doc-panel.js';

const STATUS_TABS = [['', 'All'], ['draft', 'Draft'], ['sent', 'Unpaid'], ['partial', 'Part paid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void']];

export default async function invoices(el, [id, action], alive) {
  if (id === 'new') return editor(el, null, alive);
  if (id && action === 'edit') return editor(el, id, alive);
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

async function list(el, alive) {
  const params = query();
  el.innerHTML = html`${raw(pageHeader('Invoices', { search: true, searchValue: params.q || '', actions: '<a class="btn btn-primary" href="#/invoices/new">New invoice</a>' }))}
    <div class="tabs">${raw(STATUS_TABS.map(([v, l]) => html`<button class="tab ${(params.status || '') === v ? 'on' : ''}" data-status="${v}">${l}</button>`).join(''))}</div>
    <div id="list"></div>`;
  let status = params.status || '';
  const load = async () => {
    const q = $('[data-search]', el).value;
    setQuery({ q, status });
    const rows = await api(`/invoices?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`);
    if (!alive()) return;
    const total = rows.filter((r) => r.status !== 'void').reduce((s, r) => s + r.total, 0);
    const due = rows.filter((r) => r.status === 'sent').reduce((s, r) => s + r.balance, 0);
    $('#list', el).innerHTML = rows.length ? html`<div class="table-wrap card flush"><table class="table">
      <thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
      <tbody>${raw(rows.map((i) => html`<tr class="clickable" data-href="#/invoices/${i.id}">
        <td><strong>${i.number}</strong></td><td>${i.customer_name || ''}</td>
        <td class="nowrap">${date(i.issue_date)}</td><td class="nowrap">${date(i.due_date)}</td>
        <td>${raw(badge(i.display_status, `b-${i.display_status}`))}</td>
        <td class="num">${money(i.total)}</td><td class="num">${i.status === 'void' ? '' : money(i.balance)}</td></tr>`).join(''))}</tbody>
      <tfoot><tr><td colspan="5">${rows.length} invoice(s)</td><td class="num">${money(total)}</td><td class="num">${money(due)}</td></tr></tfoot>
      </table></div>` : emptyState('No invoices found.', '<a class="btn btn-primary" href="#/invoices/new">Create an invoice</a>');
  };
  $('[data-search]', el).addEventListener('input', debounce(load));
  $$('[data-status]', el).forEach((b) => b.addEventListener('click', () => {
    status = b.dataset.status;
    $$('[data-status]', el).forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  await load();
}

async function editor(el, id, alive) {
  const [inv, customers, jobs, items] = await Promise.all([
    id ? api(`/invoices/${id}`) : null, customerOptions(), jobOptions(), api('/inventory'),
  ]);
  if (!alive()) return;
  const defaults = query();
  const lines = inv?.items?.length ? inv.items : [{ description: '', quantity: 1, unit_price: 0 }];
  el.innerHTML = html`
    <div class="page-head"><div><a href="${id ? `#/invoices/${id}` : '#/invoices'}" class="back">← Back</a>
      <h1>${inv ? `Edit ${inv.number}` : 'New invoice'}</h1></div></div>
    <form class="card" id="inv-form" novalidate>
      <div class="form-grid cols-4">
        ${raw(field('Customer', select('customer_id', customers, inv?.customer_id ?? defaults.customer_id, { blank: '— select —' })))}
        ${raw(field('Job', select('job_id', jobs, inv?.job_id ?? defaults.job_id, { blank: '— none —' })))}
        ${raw(field('Issue date', input('issue_date', inv?.issue_date || todayISO(), { type: 'date', required: true })))}
        ${raw(field('Due date', input('due_date', inv?.due_date, { type: 'date' }), { hint: inv ? '' : `Defaults to ${state.settings.payment_terms_days} days` }))}
      </div>
      <h3>Line items</h3>
      <datalist id="inv-items">${raw(items.map((it) => html`<option value="${it.sku} — ${it.name}"></option>`).join(''))}</datalist>
      <div class="table-wrap"><table class="table lines">
        <thead><tr><th style="width:45%">Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody id="lines"></tbody>
      </table></div>
      <button type="button" class="btn btn-sm" data-add-line>+ Add line</button>
      <div class="totals-row">
        <div class="form-grid">
          ${raw(field('Notes / payment instructions', textarea('notes', inv?.notes ?? '', { rows: 4 }), { cls: 'span-2' }))}
        </div>
        <table class="totals">
          <tr><td>Subtotal</td><td class="num" id="t-sub"></td></tr>
          <tr><td>Discount</td><td class="num"><input name="discount" type="number" step="0.01" min="0" value="${inv?.discount ?? 0}" class="input-sm"></td></tr>
          <tr><td>Tax rate %</td><td class="num"><input name="tax_rate" type="number" step="0.01" min="0" value="${inv?.tax_rate ?? state.settings.default_tax_rate ?? 0}" class="input-sm"></td></tr>
          <tr><td>Tax</td><td class="num" id="t-tax"></td></tr>
          <tr class="grand"><td>Total</td><td class="num" id="t-total"></td></tr>
        </table>
      </div>
      <div class="form-actions">
        <a class="btn" href="${id ? `#/invoices/${id}` : '#/invoices'}">Cancel</a>
        ${raw(!inv || inv.status === 'draft' ? '<button class="btn" type="submit" data-status="draft">Save draft</button>' : '')}
        <button class="btn btn-primary" type="submit" data-status="${inv && inv.status !== 'draft' ? inv.status : 'sent'}">${inv && inv.status !== 'draft' ? 'Save' : 'Save &amp; mark sent'}</button>
      </div>
    </form>`;

  const tbody = $('#lines', el);
  const lineRow = (l) => html`<tr>
    <td><input name="description" list="inv-items" value="${l.description}" placeholder="Item or service" data-item-id="${l.item_id || ''}"></td>
    <td class="num"><input name="quantity" type="number" step="any" value="${l.quantity}" class="input-sm"></td>
    <td class="num"><input name="unit_price" type="number" step="0.01" value="${l.unit_price}" class="input-sm"></td>
    <td class="num amount"></td>
    <td><button type="button" class="icon-btn" data-remove title="Remove line">✕</button></td></tr>`;
  const recalc = () => {
    let sub = 0;
    $$('tr', tbody).forEach((tr) => {
      const a = (Number($('[name=quantity]', tr).value) || 0) * (Number($('[name=unit_price]', tr).value) || 0);
      sub += a;
      $('.amount', tr).textContent = money(a);
    });
    const form = $('#inv-form', el);
    const taxable = Math.max(0, sub - (Number(form.discount.value) || 0));
    const tax = Math.round(taxable * (Number(form.tax_rate.value) || 0)) / 100;
    $('#t-sub', el).textContent = money(sub);
    $('#t-tax', el).textContent = money(tax);
    $('#t-total', el).textContent = money(taxable + tax);
  };
  const addLine = (l) => {
    tbody.insertAdjacentHTML('beforeend', lineRow(l));
    const tr = tbody.lastElementChild;
    const desc = $('[name=description]', tr);
    desc.addEventListener('change', () => {
      // Picking an inventory item from the list fills in its name and price.
      const match = items.find((it) => `${it.sku} — ${it.name}` === desc.value);
      if (match) {
        desc.value = match.name;
        desc.dataset.itemId = match.id;
        $('[name=unit_price]', tr).value = match.unit_price;
        recalc();
      } else if (!desc.value) desc.dataset.itemId = '';
    });
    $('[data-remove]', tr).onclick = () => { tr.remove(); recalc(); };
  };
  lines.forEach(addLine);
  $('[data-add-line]', el).onclick = () => { addLine({ description: '', quantity: 1, unit_price: 0 }); $('tr:last-child input', tbody).focus(); };
  $('#inv-form', el).addEventListener('input', recalc);
  recalc();

  let submitStatus = 'draft';
  $$('button[type=submit]', el).forEach((b) => b.addEventListener('click', () => { submitStatus = b.dataset.status; }));
  $('#inv-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      customer_id: f.customer_id.value, job_id: f.job_id.value, issue_date: f.issue_date.value, due_date: f.due_date.value,
      notes: f.notes.value, discount: f.discount.value, tax_rate: f.tax_rate.value, status: submitStatus,
      items: $$('tr', tbody).map((tr) => ({
        description: $('[name=description]', tr).value,
        item_id: $('[name=description]', tr).dataset.itemId || null,
        quantity: $('[name=quantity]', tr).value,
        unit_price: $('[name=unit_price]', tr).value,
      })),
    };
    if (!body.items.some((i) => i.description.trim())) return showError(new Error('Add at least one line item'));
    try {
      const saved = await api(id ? `/invoices/${id}` : '/invoices', { method: id ? 'PUT' : 'POST', body });
      toast('Invoice saved');
      location.hash = `#/invoices/${saved.id}`;
    } catch (err) { showError(err); }
  });
}

/** Printable invoice document. */
function paper(inv) {
  const s = state.settings;
  return html`<article class="paper">
    <header class="paper-head">
      <div><h2 class="paper-company">${s.company_name}</h2>
        <div class="pre small">${s.company_address}</div>
        <div class="small">${[s.company_email, s.company_phone].filter(Boolean).join(' · ')}</div></div>
      <div class="paper-title"><h1>INVOICE</h1><div><strong>${inv.number}</strong></div>
        ${raw(inv.status === 'paid' ? '<div class="stamp">PAID</div>' : inv.status === 'void' ? '<div class="stamp stamp-void">VOID</div>' : '')}</div>
    </header>
    <section class="paper-meta">
      <div><h4>Bill to</h4>
        <div><strong>${inv.customer_name || '—'}</strong></div>
        ${raw(inv.customer_company ? html`<div>${inv.customer_company}</div>` : '')}
        <div class="pre">${inv.customer_address || ''}</div>
        <div>${inv.customer_email || ''}</div></div>
      <dl><dt>Issue date</dt><dd>${date(inv.issue_date)}</dd>
        <dt>Due date</dt><dd>${date(inv.due_date)}</dd>
        ${raw(inv.job_number ? html`<dt>Job</dt><dd>${inv.job_number}</dd>` : '')}</dl>
    </section>
    <table class="table paper-lines">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${raw(inv.items.map((i) => html`<tr><td>${i.description}${raw(i.sku ? html` <span class="muted small">(${i.sku})</span>` : '')}</td>
        <td class="num">${qty(i.quantity)}</td><td class="num">${money(i.unit_price)}</td><td class="num">${money(i.quantity * i.unit_price)}</td></tr>`).join(''))}</tbody>
    </table>
    <table class="totals paper-totals">
      <tr><td>Subtotal</td><td class="num">${money(inv.subtotal)}</td></tr>
      ${raw(inv.discount ? html`<tr><td>Discount</td><td class="num">−${money(inv.discount)}</td></tr>` : '')}
      <tr><td>Tax (${inv.tax_rate}%)</td><td class="num">${money(inv.tax)}</td></tr>
      <tr class="grand"><td>Total</td><td class="num">${money(inv.total)}</td></tr>
      ${raw(inv.paid ? html`<tr><td>Paid</td><td class="num">−${money(inv.paid)}</td></tr>
      <tr class="grand"><td>Balance due</td><td class="num">${money(inv.balance)}</td></tr>` : '')}
    </table>
    ${raw(inv.notes ? html`<section class="paper-notes"><h4>Notes</h4><div class="pre">${inv.notes}</div></section>` : '')}
    ${raw(s.invoice_footer ? html`<footer class="paper-foot">${s.invoice_footer}</footer>` : '')}
  </article>`;
}

async function detail(el, id, alive) {
  const inv = await api(`/invoices/${id}`);
  if (!alive()) return;
  const subject = encodeURIComponent(`Invoice ${inv.number} from ${state.settings.company_name}`);
  const bodyText = encodeURIComponent(`Hello ${inv.customer_name || ''},\n\nPlease find invoice ${inv.number} for ${money(inv.total)}, due ${date(inv.due_date)}.\n\nThank you,\n${state.settings.company_name}`);
  el.innerHTML = html`
    <div class="page-head no-print">
      <div><a href="#/invoices" class="back">← Invoices</a>
        <h1>${inv.number} ${raw(badge(inv.display_status, `b-${inv.display_status}`))}</h1>
        <div class="muted">${inv.customer_name || ''} · ${money(inv.total)}${inv.status !== 'void' && inv.balance > 0 ? ` · ${money(inv.balance)} outstanding` : ''}</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-print>Print / PDF</button>
        ${raw(inv.customer_email ? html`<a class="btn" href="mailto:${inv.customer_email}?subject=${subject}&body=${bodyText}">Email</a>` : '')}
        ${raw(inv.status === 'draft' ? '<button class="btn" data-mark="sent">Mark sent</button>' : '')}
        ${raw(['sent', 'draft'].includes(inv.status) && inv.balance > 0 ? '<button class="btn btn-primary" data-pay>Record payment</button>' : '')}
        ${raw(inv.status !== 'void' ? html`<a class="btn" href="#/invoices/${inv.id}/edit">Edit</a>` : '')}
        <button class="btn" data-dup>Duplicate</button>
        ${raw(inv.status !== 'void' && inv.status !== 'paid' ? '<button class="btn btn-danger-ghost" data-mark="void">Void</button>' : '')}
        ${raw(inv.status === 'draft' || inv.status === 'void' ? '<button class="btn btn-danger-ghost" data-delete>Delete</button>' : '')}
      </div>
    </div>
    <div class="invoice-layout">
      ${raw(paper(inv))}
      <aside class="no-print">
        <section class="card">
          <div class="card-head"><h3>Payments received</h3></div>
          ${raw(inv.payments.length ? html`<table class="table table-compact"><tbody>${raw(inv.payments.map((p) => html`<tr>
            <td class="nowrap">${date(p.date)}<div class="muted small">${[p.method, p.reference].filter(Boolean).join(' · ')}</div></td>
            <td class="num">${money(p.amount)}</td>
            <td><button class="icon-btn" data-del-pay="${p.id}" title="Remove payment">✕</button></td></tr>`).join(''))}</tbody></table>`
            : '<p class="muted">No payments recorded.</p>')}
        </section>
        <div id="docs"></div>
      </aside>
    </div>`;

  const reload = () => detail(el, id, alive);
  $('[data-print]', el).onclick = () => window.print();
  $$('[data-mark]', el).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.mark === 'void' && !(await confirmDialog('Void this invoice? It will no longer count as money owed.', { label: 'Void' }))) return;
    try {
      await api(`/invoices/${inv.id}`, { method: 'PUT', body: { status: b.dataset.mark } });
      toast(`Invoice ${b.dataset.mark === 'void' ? 'voided' : 'marked as sent'}`);
      reload();
    } catch (err) { showError(err); }
  }));
  $('[data-pay]', el)?.addEventListener('click', () => modal({
    title: `Record payment — ${inv.number}`,
    body: html`<div class="form-grid">
      ${raw(field('Amount *', input('amount', inv.balance, { type: 'number', required: true, attrs: 'step="0.01" min="0.01"' })))}
      ${raw(field('Date', input('date', todayISO(), { type: 'date' })))}
      ${raw(field('Method', select('method', [['Bank transfer', 'Bank transfer'], ['Card', 'Card'], ['Cash', 'Cash'], ['Cheque', 'Cheque'], ['Other', 'Other']], 'Bank transfer')))}
      ${raw(field('Reference', input('reference', '', { placeholder: 'Remittance / transaction ref' })))}
      ${raw(field('Notes', textarea('notes', ''), { cls: 'span-2' }))}
    </div>`,
    submitLabel: 'Record payment',
    onSubmit: async (data) => {
      await api(`/invoices/${inv.id}/payments`, { method: 'POST', body: data });
      toast('Payment recorded');
      reload();
    },
  }));
  $$('[data-del-pay]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove this payment?', { label: 'Remove' }))) return;
    try {
      await api(`/invoices/${inv.id}/payments/${b.dataset.delPay}`, { method: 'DELETE' });
      reload();
    } catch (err) { showError(err); }
  }));
  $('[data-dup]', el).onclick = async () => {
    try {
      const copy = await api('/invoices', {
        method: 'POST',
        body: {
          customer_id: inv.customer_id, job_id: inv.job_id, tax_rate: inv.tax_rate, discount: inv.discount, notes: inv.notes,
          items: inv.items.map(({ description, quantity, unit_price: unitPrice, item_id: itemId }) => ({ description, quantity, unit_price: unitPrice, item_id: itemId })),
        },
      });
      toast(`Created ${copy.number}`);
      location.hash = `#/invoices/${copy.id}/edit`;
    } catch (err) { showError(err); }
  };
  $('[data-delete]', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete ${inv.number}?`))) return;
    try {
      await api(`/invoices/${inv.id}`, { method: 'DELETE' });
      toast('Invoice deleted');
      location.hash = '#/invoices';
    } catch (err) { showError(err); }
  });
  await docPanel($('#docs', el), 'invoice', inv.id, { title: 'Attachments' });
}
