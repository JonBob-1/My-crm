import {
  api, state, html, raw, $, $$, date, dateTime, statusPill, modal, confirmDialog, toast, showError,
  field, input, textarea, select, pageHeader, emptyState, debounce, badge, query, setQuery, customerOptions,
} from '../lib.js';
import { docPanel } from './doc-panel.js';

const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const statusOptions = () => state.statuses.map((s) => [s.id, s.name]);
const userOptions = () => state.users.map((u) => [u.id, u.name]);

export default async function jobs(el, [id], alive) {
  if (id === 'new') {
    await list(el, alive);
    return editJob(null, (j) => { location.hash = `#/jobs/${j.id}`; }, query());
  }
  if (id) return detail(el, id, alive);
  return list(el, alive);
}

let viewMode = localStorageGet('jobs.view', 'board');
function localStorageGet(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

async function list(el, alive) {
  const params = query();
  if (params.status_id) viewMode = 'list';
  el.innerHTML = html`${raw(pageHeader('Jobs', {
    search: true,
    searchValue: params.q || '',
    actions: html`
      ${raw(select('status_id', statusOptions(), params.status_id, { blank: 'All statuses', attrs: 'data-filter' }))}
      <div class="seg" role="group" aria-label="View">
        <button class="seg-btn ${viewMode === 'board' ? 'on' : ''}" data-mode="board">Board</button>
        <button class="seg-btn ${viewMode === 'list' ? 'on' : ''}" data-mode="list">List</button>
      </div>
      <button class="btn btn-primary" data-new>New job</button>`,
  }))}<div id="jobs"></div>`;

  const load = async () => {
    const q = $('[data-search]', el).value;
    const statusId = $('[data-filter]', el).value;
    setQuery({ q, status_id: statusId });
    const rows = await api(`/jobs?q=${encodeURIComponent(q)}${statusId ? `&status_id=${statusId}` : ''}`);
    if (!alive()) return;
    const box = $('#jobs', el);
    if (viewMode === 'board') renderBoard(box, rows, load, statusId);
    else renderList(box, rows);
  };
  $('[data-search]', el).addEventListener('input', debounce(load));
  $('[data-filter]', el).addEventListener('change', load);
  $$('[data-mode]', el).forEach((b) => b.addEventListener('click', () => {
    viewMode = b.dataset.mode;
    localStorageSet('jobs.view', viewMode);
    $$('[data-mode]', el).forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  $('[data-new]', el).onclick = () => editJob(null, (j) => { location.hash = `#/jobs/${j.id}`; });
  await load();
}

function renderList(box, rows) {
  box.innerHTML = rows.length ? html`<div class="table-wrap card flush"><table class="table">
    <thead><tr><th>Job</th><th>Customer</th><th>Status</th><th>Priority</th><th>Assigned</th><th>Due</th><th>Updated</th></tr></thead>
    <tbody>${raw(rows.map((j) => html`<tr class="clickable" data-href="#/jobs/${j.id}">
      <td><strong>${j.number}</strong> ${j.title}</td><td>${j.customer_name || ''}</td>
      <td>${raw(statusPill(j.status, j.status_color))}</td><td>${raw(badge(j.priority, `p-${j.priority}`))}</td>
      <td>${j.assigned_name || ''}</td><td class="nowrap ${isLate(j) ? 'text-danger' : ''}">${date(j.due_date)}</td>
      <td class="nowrap muted">${dateTime(j.updated_at)}</td></tr>`).join(''))}</tbody></table></div>`
    : emptyState('No jobs found.');
}

const isLate = (j) => j.due_date && !j.is_closed && j.due_date < new Date().toISOString().slice(0, 10);

function renderBoard(box, rows, reload, onlyStatus) {
  const cols = state.statuses.filter((s) => !onlyStatus || String(s.id) === String(onlyStatus));
  box.innerHTML = html`<div class="board">${raw(cols.map((s) => {
    const items = rows.filter((j) => j.status_id === s.id);
    return html`<div class="board-col" data-status="${s.id}">
      <div class="board-col-head" style="--c:${s.color}"><span>${s.name}</span><span class="count">${items.length}</span></div>
      <div class="board-cards">${raw(items.map((j) => html`
        <div class="job-card" draggable="true" data-job="${j.id}" data-href="#/jobs/${j.id}">
          <div class="job-card-top"><strong>${j.number}</strong>${raw(j.priority !== 'normal' ? badge(j.priority, `p-${j.priority}`) : '')}</div>
          <div>${j.title}</div>
          <div class="muted small">${j.customer_name || ''}</div>
          ${raw(j.due_date ? html`<div class="small ${isLate(j) ? 'text-danger' : 'muted'}">Due ${date(j.due_date)}</div>` : '')}
          ${raw(j.assigned_name ? html`<div class="small muted">👤 ${j.assigned_name}</div>` : '')}
        </div>`).join(''))}</div>
    </div>`;
  }).join(''))}</div>`;

  // Drag a card to another column to change its status.
  $$('.job-card', box).forEach((card) => {
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.dataset.job); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  $$('.board-col', box).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const jobId = e.dataTransfer.getData('text/plain');
      const job = rows.find((j) => String(j.id) === jobId);
      if (!job || String(job.status_id) === col.dataset.status) return;
      try {
        await api(`/jobs/${jobId}`, { method: 'PUT', body: { status_id: Number(col.dataset.status) } });
        toast(`${job.number} moved`);
        reload();
      } catch (err) { showError(err); }
    });
  });
}

export async function editJob(j, onSaved, defaults = {}) {
  const customers = await customerOptions();
  modal({
    title: j ? `Edit ${j.number}` : 'New job',
    wide: true,
    body: html`<div class="form-grid">
      ${raw(field('Title *', input('title', j?.title, { required: true }), { cls: 'span-2' }))}
      ${raw(field('Customer', select('customer_id', customers, j?.customer_id ?? defaults.customer_id, { blank: '— none —' })))}
      ${raw(field('Status', select('status_id', statusOptions(), j?.status_id ?? state.statuses[0]?.id)))}
      ${raw(field('Priority', select('priority', PRIORITIES, j?.priority || 'normal')))}
      ${raw(field('Assigned to', select('assigned_to', userOptions(), j?.assigned_to, { blank: '— unassigned —' })))}
      ${raw(field('Start date', input('start_date', j?.start_date, { type: 'date' })))}
      ${raw(field('Due date', input('due_date', j?.due_date, { type: 'date' })))}
      ${raw(field('Description', textarea('description', j?.description, { rows: 5 }), { cls: 'span-2' }))}
      ${raw(field('External reference', input('external_ref', j?.external_ref), { hint: 'Job ID at a partner company (used to sync status via API).' }))}
    </div>`,
    onSubmit: async (data) => {
      const saved = await api(j ? `/jobs/${j.id}` : '/jobs', { method: j ? 'PUT' : 'POST', body: data });
      toast('Job saved');
      onSaved(saved);
    },
  });
}

async function detail(el, id, alive) {
  const j = await api(`/jobs/${id}`);
  if (!alive()) return;
  const idx = state.statuses.findIndex((s) => s.id === j.status_id);
  el.innerHTML = html`
    <div class="page-head">
      <div><a href="#/jobs" class="back">← Jobs</a>
        <h1>${j.number} · ${j.title}</h1>
        <div class="muted">${raw(j.customer_id ? html`<a href="#/customers/${j.customer_id}">${j.customer_name}</a>` : 'No customer')}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/invoices/new?job_id=${j.id}${j.customer_id ? `&customer_id=${j.customer_id}` : ''}">Create invoice</a>
        <a class="btn" href="#/remittances/new?job_id=${j.id}${j.customer_id ? `&customer_id=${j.customer_id}` : ''}">Create remittance</a>
        <button class="btn" data-edit>Edit</button>
        <button class="btn btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>

    <section class="card">
      <div class="card-head"><h3>Process status</h3>${raw(statusPill(j.status, j.status_color))}</div>
      <ol class="stepper">${raw(state.statuses.map((s, i) => html`
        <li class="${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}" style="--c:${s.color}">
          <button type="button" data-set-status="${s.id}" ${raw(i === idx ? 'disabled' : '')} title="Move to ${s.name}">
            <span class="dot"></span><span class="step-label">${s.name}</span>
          </button>
        </li>`).join(''))}
      </ol>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Details</h3></div>
        <dl class="details">
          <dt>Priority</dt><dd>${raw(badge(j.priority, `p-${j.priority}`))}</dd>
          <dt>Assigned to</dt><dd>${j.assigned_name || '—'}</dd>
          <dt>Start date</dt><dd>${date(j.start_date) || '—'}</dd>
          <dt>Due date</dt><dd class="${isLate(j) ? 'text-danger' : ''}">${date(j.due_date) || '—'}</dd>
          ${raw(j.external_ref ? html`<dt>External ref</dt><dd>${j.external_ref}</dd>` : '')}
          <dt>Description</dt><dd class="pre">${j.description || '—'}</dd>
        </dl>
        <h4>Invoices</h4>
        ${raw(j.invoices.length ? html`<ul class="plain">${raw(j.invoices.map((i) => html`<li><a href="#/invoices/${i.id}">${i.number}</a> ${raw(badge(i.status, `b-${i.status}`))} <span class="muted">${date(i.issue_date)}</span></li>`).join(''))}</ul>` : '<p class="muted">None</p>')}
        <h4>Remittances</h4>
        ${raw(j.remittances.length ? html`<ul class="plain">${raw(j.remittances.map((r) => html`<li><a href="#/remittances/${r.id}">${r.number}</a> ${r.direction} ${raw(badge(r.status, `b-${r.status}`))}</li>`).join(''))}</ul>` : '<p class="muted">None</p>')}
      </section>

      <section class="card">
        <div class="card-head"><h3>Status history &amp; notes</h3></div>
        <form class="note-form" data-note>
          <textarea name="note" rows="2" placeholder="Add a note or update…" required></textarea>
          <button class="btn btn-sm" type="submit">Add note</button>
        </form>
        <ul class="timeline">${raw(j.history.map((h) => html`<li>
          ${raw(h.from_status !== h.to_status ? html`<div>${raw(h.from_status ? html`<span class="muted">${h.from_status} →</span> ` : '')}<strong>${h.to_status || ''}</strong></div>` : '')}
          ${raw(h.note ? html`<div class="pre">${h.note}</div>` : '')}
          <div class="muted small">${dateTime(h.created_at)}${h.user_name ? ` · ${h.user_name}` : ''}</div>
        </li>`).join(''))}</ul>
      </section>
    </div>
    <div id="docs"></div>`;

  const reload = () => detail(el, id, alive);
  $$('[data-set-status]', el).forEach((b) => b.addEventListener('click', () => {
    const target = state.statuses.find((s) => String(s.id) === b.dataset.setStatus);
    modal({
      title: `Move to "${target.name}"`,
      body: field('Note (optional)', textarea('status_note', '', { placeholder: 'What changed?' })),
      submitLabel: 'Update status',
      onSubmit: async (data) => {
        await api(`/jobs/${j.id}`, { method: 'PUT', body: { status_id: target.id, status_note: data.status_note } });
        toast(`Status updated to ${target.name}`);
        reload();
      },
    });
  }));
  $('[data-note]', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/jobs/${j.id}/notes`, { method: 'POST', body: { note: e.target.note.value } });
      reload();
    } catch (err) { showError(err); }
  });
  $('[data-edit]', el).onclick = () => editJob(j, reload);
  $('[data-delete]', el).onclick = async () => {
    if (!(await confirmDialog(`Delete job ${j.number}? Its history will be lost.`))) return;
    try {
      await api(`/jobs/${j.id}`, { method: 'DELETE' });
      toast('Job deleted');
      location.hash = '#/jobs';
    } catch (err) { showError(err); }
  };
  await docPanel($('#docs', el), 'job', j.id);
}
