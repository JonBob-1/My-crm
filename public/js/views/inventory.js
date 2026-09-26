import {
  api, html, raw, $, money, qty, dateTime, modal, confirmDialog, toast, showError,
  field, input, textarea, pageHeader, emptyState, debounce, query, setQuery,
} from '../lib.js';
import { docPanel } from './doc-panel.js';

const REASONS = {
  opening: 'Opening stock', adjustment: 'Manual adjustment', remittance_in: 'Remittance in',
  remittance_out: 'Remittance out', remittance_void: 'Remittance voided', api_sync: 'API sync',
};

export default async function inventory(el, [id], alive) {
  if (id === 'new') {
    await list(el, alive);
    return editItem(null, (it) => { location.hash = `#/inventory/${it.id}`; });
  }
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

async function list(el, alive) {
  const params = query();
  el.innerHTML = html`${raw(pageHeader('Inventory', {
    search: true,
    searchValue: params.q || '',
    actions: html`<label class="check"><input type="checkbox" data-low ${raw(params.low === '1' ? 'checked' : '')}> Low stock only</label>
      <a class="btn" href="#/remittances/new">New remittance</a>
      <button class="btn btn-primary" data-new>New item</button>`,
  }))}<div id="list"></div>`;
  const load = async () => {
    const q = $('[data-search]', el).value;
    const low = $('[data-low]', el).checked ? '1' : '';
    setQuery({ q, low });
    const rows = await api(`/inventory?q=${encodeURIComponent(q)}&low=${low}`);
    if (!alive()) return;
    const value = rows.reduce((s, r) => s + r.quantity * r.unit_cost, 0);
    $('#list', el).innerHTML = rows.length ? html`<div class="table-wrap card flush"><table class="table">
      <thead><tr><th>SKU</th><th>Name</th><th>Location</th><th class="num">On hand</th><th class="num">Reorder at</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Stock value</th></tr></thead>
      <tbody>${raw(rows.map((r) => html`<tr class="clickable" data-href="#/inventory/${r.id}">
        <td><strong>${r.sku}</strong></td><td>${r.name}</td><td>${r.location || ''}</td>
        <td class="num ${r.quantity <= r.reorder_level ? 'text-danger' : ''}">${qty(r.quantity)} <span class="muted small">${r.unit || ''}</span></td>
        <td class="num muted">${qty(r.reorder_level)}</td><td class="num">${money(r.unit_cost)}</td><td class="num">${money(r.unit_price)}</td>
        <td class="num">${money(r.quantity * r.unit_cost)}</td></tr>`).join(''))}</tbody>
      <tfoot><tr><td colspan="7">${rows.length} item(s)</td><td class="num">${money(value)}</td></tr></tfoot></table></div>`
      : emptyState('No inventory items found.');
  };
  $('[data-search]', el).addEventListener('input', debounce(load));
  $('[data-low]', el).addEventListener('change', load);
  $('[data-new]', el).onclick = () => editItem(null, (it) => { location.hash = `#/inventory/${it.id}`; });
  await load();
}

function editItem(it, onSaved) {
  modal({
    title: it ? `Edit ${it.sku}` : 'New inventory item',
    wide: true,
    body: html`<div class="form-grid cols-3">
      ${raw(field('SKU *', input('sku', it?.sku, { required: true })))}
      ${raw(field('Name *', input('name', it?.name, { required: true }), { cls: 'span-2' }))}
      ${raw(field('Unit', input('unit', it?.unit ?? 'each')))}
      ${raw(field('Location', input('location', it?.location, { placeholder: 'Warehouse / bin' })))}
      ${raw(it ? '' : field('Opening quantity', input('quantity', 0, { type: 'number', attrs: 'step="any"' })))}
      ${raw(field('Reorder level', input('reorder_level', it?.reorder_level ?? 0, { type: 'number', attrs: 'step="any"' })))}
      ${raw(field('Unit cost', input('unit_cost', it?.unit_cost ?? 0, { type: 'number', attrs: 'step="0.01"' })))}
      ${raw(field('Sale price', input('unit_price', it?.unit_price ?? 0, { type: 'number', attrs: 'step="0.01"' })))}
      ${raw(field('Description', textarea('description', it?.description), { cls: 'span-3' }))}
    </div>`,
    onSubmit: async (data) => {
      const saved = await api(it ? `/inventory/${it.id}` : '/inventory', { method: it ? 'PUT' : 'POST', body: data });
      toast('Item saved');
      onSaved(saved);
    },
  });
}

async function detail(el, id, alive) {
  const it = await api(`/inventory/${id}`);
  if (!alive()) return;
  el.innerHTML = html`
    <div class="page-head">
      <div><a href="#/inventory" class="back">← Inventory</a><h1>${it.sku} · ${it.name}</h1></div>
      <div class="page-actions">
        <button class="btn btn-primary" data-adjust>Adjust stock</button>
        <button class="btn" data-edit>Edit</button>
        <button class="btn btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat ${it.quantity <= it.reorder_level ? 'stat-warn' : ''}"><span>On hand</span><strong>${qty(it.quantity)} ${it.unit || ''}</strong></div>
      <div class="stat"><span>Reorder level</span><strong>${qty(it.reorder_level)}</strong></div>
      <div class="stat"><span>Unit cost / price</span><strong>${money(it.unit_cost)} / ${money(it.unit_price)}</strong></div>
      <div class="stat"><span>Stock value</span><strong>${money(it.quantity * it.unit_cost)}</strong></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Details</h3></div>
        <dl class="details"><dt>Location</dt><dd>${it.location || '—'}</dd><dt>Description</dt><dd class="pre">${it.description || '—'}</dd></dl>
      </section>
      <section class="card">
        <div class="card-head"><h3>Stock movements</h3></div>
        ${raw(it.movements.length ? html`<table class="table table-compact"><tbody>${raw(it.movements.map((m) => html`<tr>
          <td class="nowrap">${dateTime(m.created_at)}<div class="muted small">${m.user_name || ''}</div></td>
          <td>${REASONS[m.reason] || m.reason}${raw(m.reference_type === 'remittance' ? html` <a href="#/remittances/${m.reference_id}">${m.reference_number || ''}</a>` : '')}
            ${raw(m.note && m.reference_type !== 'remittance' ? html`<div class="muted small">${m.note}</div>` : '')}</td>
          <td class="num ${m.change < 0 ? 'text-danger' : 'text-ok'}">${m.change > 0 ? '+' : ''}${qty(m.change)}</td></tr>`).join(''))}</tbody></table>`
          : emptyState('No movements yet.'))}
      </section>
    </div>
    <div id="docs"></div>`;
  const reload = () => detail(el, id, alive);
  $('[data-edit]', el).onclick = () => editItem(it, reload);
  $('[data-adjust]', el).onclick = () => modal({
    title: `Adjust stock — ${it.sku}`,
    body: html`<div class="form-grid">
      ${raw(field('Change *', input('change', '', { type: 'number', required: true, attrs: 'step="any"' }), { hint: 'Positive to add stock, negative to remove (e.g. -3).' }))}
      ${raw(field('Reason / note', input('note', '', { placeholder: 'Stock count, damaged, etc.' })))}
    </div>`,
    submitLabel: 'Apply',
    onSubmit: async (data) => {
      await api(`/inventory/${it.id}/adjust`, { method: 'POST', body: data });
      toast('Stock adjusted');
      reload();
    },
  });
  $('[data-delete]', el).onclick = async () => {
    if (!(await confirmDialog(`Delete ${it.sku}? Its movement history will be removed.`))) return;
    try {
      await api(`/inventory/${it.id}`, { method: 'DELETE' });
      toast('Item deleted');
      location.hash = '#/inventory';
    } catch (err) { showError(err); }
  };
  await docPanel($('#docs', el), 'inventory', it.id);
}
