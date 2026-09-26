import {
  api, state, html, raw, $, $$, date, dateTime, money, qty, confirmDialog, toast, showError,
  field, input, textarea, select, pageHeader, emptyState, debounce, badge, query, setQuery,
  customerOptions, jobOptions, todayISO,
} from '../lib.js';
import { docPanel } from './doc-panel.js';

const DIRECTIONS = [['outgoing', 'Outgoing — stock sent out'], ['incoming', 'Incoming — stock received']];

export default async function remittances(el, [id, action], alive) {
  if (id === 'new') return editor(el, null, alive);
  if (id && action === 'edit') return editor(el, id, alive);
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

async function list(el, alive) {
  const params = query();
  el.innerHTML = html`${raw(pageHeader('Inventory remittances', {
    search: true,
    searchValue: params.q || '',
    actions: html`
      ${raw(select('direction', [['outgoing', 'Outgoing'], ['incoming', 'Incoming']], params.direction, { blank: 'All directions', attrs: 'data-dir' }))}
      ${raw(select('status', [['draft', 'Draft'], ['posted', 'Posted'], ['void', 'Void']], params.status, { blank: 'All statuses', attrs: 'data-status' }))}
      <a class="btn btn-primary" href="#/remittances/new">New remittance</a>`,
  }))}
  <p class="muted intro">Remittances record inventory sent to or received from a customer or supplier. Posting one updates stock levels.</p>
  <div id="list"></div>`;
  const load = async () => {
    const q = $('[data-search]', el).value;
    const direction = $('[data-dir]', el).value;
    const status = $('[data-status]', el).value;
    setQuery({ q, direction, status });
    const rows = await api(`/remittances?q=${encodeURIComponent(q)}&direction=${direction}&status=${status}`);
    if (!alive()) return;
    $('#list', el).innerHTML = rows.length ? html`<div class="table-wrap card flush"><table class="table">
      <thead><tr><th>Number</th><th>Direction</th><th>Party</th><th>Date</th><th>Reference</th><th>Status</th><th class="num">Lines</th><th class="num">Value</th></tr></thead>
      <tbody>${raw(rows.map((r) => html`<tr class="clickable" data-href="#/remittances/${r.id}">
        <td><strong>${r.number}</strong></td><td>${r.direction === 'incoming' ? '⇣ In' : '⇡ Out'}</td>
        <td>${r.customer_name || r.counterparty || ''}</td><td class="nowrap">${date(r.date)}</td><td>${r.reference || ''}</td>
        <td>${raw(badge(r.status, `b-${r.status}`))}</td><td class="num">${r.line_count}</td><td class="num">${money(r.total_value)}</td></tr>`).join(''))}</tbody>
      </table></div>` : emptyState('No remittances found.', '<a class="btn btn-primary" href="#/remittances/new">Create a remittance</a>');
  };
  $('[data-search]', el).addEventListener('input', debounce(load));
  $('[data-dir]', el).addEventListener('change', load);
  $('[data-status]', el).addEventListener('change', load);
  await load();
}

async function editor(el, id, alive) {
  const [rem, customers, jobs, items] = await Promise.all([
    id ? api(`/remittances/${id}`) : null, customerOptions(), jobOptions(), api('/inventory'),
  ]);
  if (!alive()) return;
  if (rem && rem.status !== 'draft') { location.hash = `#/remittances/${id}`; return; }
  const defaults = query();
  const itemOpts = items.map((i) => [i.id, `${i.sku} — ${i.name} (${qty(i.quantity)} on hand)`]);
  el.innerHTML = html`
    <div class="page-head"><div><a href="${id ? `#/remittances/${id}` : '#/remittances'}" class="back">← Back</a>
      <h1>${rem ? `Edit ${rem.number}` : 'New inventory remittance'}</h1></div></div>
    <form class="card" id="rem-form" novalidate>
      <div class="form-grid cols-3">
        ${raw(field('Direction', select('direction', DIRECTIONS, rem?.direction || defaults.direction || 'outgoing')))}
        ${raw(field('Date', input('date', rem?.date || todayISO(), { type: 'date', required: true })))}
        ${raw(field('Reference', input('reference', rem?.reference, { placeholder: 'PO / delivery / consignment no.' })))}
        ${raw(field('Customer / supplier', select('customer_id', customers, rem?.customer_id ?? defaults.customer_id, { blank: '— none —' })))}
        ${raw(field('Or other party name', input('counterparty', rem?.counterparty, { placeholder: 'Company not in customers' })))}
        ${raw(field('Job', select('job_id', jobs, rem?.job_id ?? defaults.job_id, { blank: '— none —' })))}
      </div>
      <h3>Items</h3>
      ${raw(items.length ? '' : '<p class="text-danger">You have no inventory items yet. <a href="#/inventory/new">Add one first.</a></p>')}
      <div class="table-wrap"><table class="table lines">
        <thead><tr><th style="width:45%">Item</th><th class="num">Quantity</th><th class="num">Unit value</th><th class="num">Line value</th><th>Note</th><th></th></tr></thead>
        <tbody id="lines"></tbody>
        <tfoot><tr><td colspan="3">Total</td><td class="num" id="t-total"></td><td colspan="2"></td></tr></tfoot>
      </table></div>
      <button type="button" class="btn btn-sm" data-add-line>+ Add item</button>
      ${raw(field('Notes', textarea('notes', rem?.notes), { cls: 'mt' }))}
      <div class="form-actions">
        <a class="btn" href="${id ? `#/remittances/${id}` : '#/remittances'}">Cancel</a>
        <button class="btn" type="submit" data-then="">Save draft</button>
        <button class="btn btn-primary" type="submit" data-then="post">Save &amp; post stock</button>
      </div>
    </form>`;

  const tbody = $('#lines', el);
  const recalc = () => {
    let total = 0;
    $$('tr', tbody).forEach((tr) => {
      const v = (Number($('[name=quantity]', tr).value) || 0) * (Number($('[name=unit_value]', tr).value) || 0);
      total += v;
      $('.amount', tr).textContent = money(v);
    });
    $('#t-total', el).textContent = money(total);
  };
  const addLine = (l = {}) => {
    tbody.insertAdjacentHTML('beforeend', html`<tr>
      <td>${raw(select('item_id', itemOpts, l.item_id, { blank: '— select item —' }))}</td>
      <td class="num"><input name="quantity" type="number" step="any" min="0" value="${l.quantity ?? 1}" class="input-sm"></td>
      <td class="num"><input name="unit_value" type="number" step="0.01" value="${l.unit_value ?? 0}" class="input-sm"></td>
      <td class="num amount"></td>
      <td><input name="note" value="${l.note || ''}"></td>
      <td><button type="button" class="icon-btn" data-remove title="Remove">✕</button></td></tr>`);
    const tr = tbody.lastElementChild;
    $('[name=item_id]', tr).addEventListener('change', (e) => {
      const it = items.find((i) => String(i.id) === e.target.value);
      if (it) {
        const incoming = $('#rem-form [name=direction]', el).value === 'incoming';
        $('[name=unit_value]', tr).value = incoming ? it.unit_cost : it.unit_price;
        recalc();
      }
    });
    $('[data-remove]', tr).onclick = () => { tr.remove(); recalc(); };
  };
  (rem?.items?.length ? rem.items : [{}]).forEach(addLine);
  $('[data-add-line]', el).onclick = () => addLine();
  $('#rem-form', el).addEventListener('input', recalc);
  recalc();

  let then = '';
  $$('button[type=submit]', el).forEach((b) => b.addEventListener('click', () => { then = b.dataset.then; }));
  $('#rem-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      direction: f.direction.value, date: f.date.value, reference: f.reference.value, customer_id: f.customer_id.value,
      counterparty: f.counterparty.value, job_id: f.job_id.value, notes: f.notes.value,
      items: $$('tr', tbody).map((tr) => ({
        item_id: $('[name=item_id]', tr).value, quantity: $('[name=quantity]', tr).value,
        unit_value: $('[name=unit_value]', tr).value, note: $('[name=note]', tr).value,
      })).filter((i) => i.item_id),
    };
    try {
      const saved = await api(id ? `/remittances/${id}` : '/remittances', { method: id ? 'PUT' : 'POST', body });
      if (then === 'post') await postRemittance(saved);
      else toast('Remittance saved');
      location.hash = `#/remittances/${saved.id}`;
    } catch (err) { showError(err); }
  });
}

async function postRemittance(rem) {
  try {
    await api(`/remittances/${rem.id}/post`, { method: 'POST', body: {} });
    toast(`${rem.number} posted — stock updated`);
    return true;
  } catch (err) {
    if (!/Insufficient stock/.test(err.message)) throw err;
    const go = await confirmDialog(`${err.message}. Post anyway and allow negative stock?`, { label: 'Post anyway' });
    if (!go) return false;
    await api(`/remittances/${rem.id}/post`, { method: 'POST', body: { allow_negative: true } });
    toast(`${rem.number} posted — stock updated`);
    return true;
  }
}

function paper(r) {
  const s = state.settings;
  const party = r.customer_name || r.counterparty || '—';
  return html`<article class="paper">
    <header class="paper-head">
      <div><h2 class="paper-company">${s.company_name}</h2><div class="pre small">${s.company_address}</div>
        <div class="small">${[s.company_email, s.company_phone].filter(Boolean).join(' · ')}</div></div>
      <div class="paper-title"><h1>${r.direction === 'incoming' ? 'GOODS RECEIVED' : 'INVENTORY REMITTANCE'}</h1>
        <div><strong>${r.number}</strong></div>
        ${raw(r.status === 'void' ? '<div class="stamp stamp-void">VOID</div>' : '')}</div>
    </header>
    <section class="paper-meta">
      <div><h4>${r.direction === 'incoming' ? 'Received from' : 'Remitted to'}</h4><div><strong>${party}</strong></div>
        ${raw(r.customer_company ? html`<div>${r.customer_company}</div>` : '')}<div class="pre">${r.customer_address || ''}</div></div>
      <dl><dt>Date</dt><dd>${date(r.date)}</dd>
        ${raw(r.reference ? html`<dt>Reference</dt><dd>${r.reference}</dd>` : '')}
        ${raw(r.job_number ? html`<dt>Job</dt><dd>${r.job_number}</dd>` : '')}
        <dt>Status</dt><dd>${r.status}</dd></dl>
    </section>
    <table class="table paper-lines">
      <thead><tr><th>SKU</th><th>Item</th><th class="num">Qty</th><th class="num">Unit value</th><th class="num">Value</th></tr></thead>
      <tbody>${raw(r.items.map((i) => html`<tr><td>${i.sku}</td><td>${i.name}${raw(i.note ? html`<div class="muted small">${i.note}</div>` : '')}</td>
        <td class="num">${qty(i.quantity)} ${i.unit || ''}</td><td class="num">${money(i.unit_value)}</td><td class="num">${money(i.quantity * i.unit_value)}</td></tr>`).join(''))}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${qty(r.total_quantity)}</td><td></td><td class="num">${money(r.total_value)}</td></tr></tfoot>
    </table>
    ${raw(r.notes ? html`<section class="paper-notes"><h4>Notes</h4><div class="pre">${r.notes}</div></section>` : '')}
    <section class="signatures"><div>Dispatched by</div><div>Received by</div></section>
  </article>`;
}

async function detail(el, id, alive) {
  const r = await api(`/remittances/${id}`);
  if (!alive()) return;
  el.innerHTML = html`
    <div class="page-head no-print">
      <div><a href="#/remittances" class="back">← Remittances</a>
        <h1>${r.number} ${raw(badge(r.status, `b-${r.status}`))}</h1>
        <div class="muted">${r.direction === 'incoming' ? 'Incoming from' : 'Outgoing to'} ${r.customer_name || r.counterparty || '—'}
          ${r.posted_at ? ` · posted ${dateTime(r.posted_at)}` : ''}</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-print>Print / PDF</button>
        ${raw(r.status === 'draft' ? html`<a class="btn" href="#/remittances/${r.id}/edit">Edit</a><button class="btn btn-primary" data-post>Post stock</button>` : '')}
        ${raw(r.status !== 'void' ? '<button class="btn btn-danger-ghost" data-void>Void</button>' : '')}
        ${raw(r.status !== 'posted' ? '<button class="btn btn-danger-ghost" data-delete>Delete</button>' : '')}
      </div>
    </div>
    ${raw(r.status === 'draft' ? '<div class="notice no-print">This remittance is a draft. Stock levels change only when it is posted.</div>' : '')}
    <div class="invoice-layout">${raw(paper(r))}<aside class="no-print" id="docs"></aside></div>`;
  const reload = () => detail(el, id, alive);
  $('[data-print]', el).onclick = () => window.print();
  $('[data-post]', el)?.addEventListener('click', async () => {
    try { if (await postRemittance(r)) reload(); } catch (err) { showError(err); }
  });
  $('[data-void]', el)?.addEventListener('click', async () => {
    const msg = r.status === 'posted' ? 'Void this remittance? Its stock movements will be reversed.' : 'Void this draft remittance?';
    if (!(await confirmDialog(msg, { label: 'Void' }))) return;
    try {
      await api(`/remittances/${r.id}/void`, { method: 'POST', body: {} });
      toast('Remittance voided');
      reload();
    } catch (err) { showError(err); }
  });
  $('[data-delete]', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete ${r.number}?`))) return;
    try {
      await api(`/remittances/${r.id}`, { method: 'DELETE' });
      toast('Remittance deleted');
      location.hash = '#/remittances';
    } catch (err) { showError(err); }
  });
  await docPanel($('#docs', el), 'remittance', r.id, { title: 'Attachments' });
}
