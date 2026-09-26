import { api, html, raw, $, pageHeader, emptyState, debounce, query, setQuery, select } from '../lib.js';
import { docPanel, docTable, bindDocActions } from './doc-panel.js';

const TYPES = [['customer', 'Customers'], ['job', 'Jobs'], ['invoice', 'Invoices'], ['remittance', 'Remittances'], ['inventory', 'Inventory']];

export default async function documents(el, _params, alive) {
  const params = query();
  el.innerHTML = html`${raw(pageHeader('Documents', {
    search: true,
    searchValue: params.q || '',
    actions: select('entity_type', TYPES, params.type, { blank: 'All documents', attrs: 'data-type' }),
  }))}
  <div id="upload"></div>
  <section class="card flush"><div id="list"></div></section>`;

  const load = async () => {
    const q = $('[data-search]', el).value;
    const type = $('[data-type]', el).value;
    setQuery({ q, type });
    const docs = await api(`/documents?q=${encodeURIComponent(q)}${type ? `&entity_type=${type}` : ''}`);
    if (!alive()) return;
    const box = $('#list', el);
    box.innerHTML = docs.length ? docTable(docs, true) : emptyState('No documents found.');
    bindDocActions(box, load);
  };
  $('[data-search]', el).addEventListener('input', debounce(load));
  $('[data-type]', el).addEventListener('change', load);

  await docPanel($('#upload', el), null, null, {
    title: 'Upload documents',
    subtitle: 'To attach files to a customer, job, invoice or remittance, upload from that record’s page.',
    onUploaded: load,
  });
  await load();
}
