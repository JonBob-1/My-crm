import { api, html, raw, money, qty, date, dateTime, statusPill, emptyState } from '../lib.js';

export default async function dashboard(el, _params, alive) {
  const d = await api('/dashboard');
  if (!alive()) return;
  const maxJobs = Math.max(1, ...d.jobs_by_status.map((s) => s.count));
  el.innerHTML = html`
    <div class="page-head"><h1>Dashboard</h1>
      <div class="page-actions">
        <a class="btn" href="#/jobs/new">New job</a>
        <a class="btn btn-primary" href="#/invoices/new">New invoice</a>
      </div>
    </div>

    <div class="stats">
      <a class="stat" href="#/invoices?status=sent"><span>Outstanding</span><strong>${money(d.money.outstanding)}</strong></a>
      <a class="stat ${d.money.overdue_count ? 'stat-warn' : ''}" href="#/invoices?status=overdue"><span>Overdue (${d.money.overdue_count})</span><strong>${money(d.money.overdue)}</strong></a>
      <div class="stat"><span>Paid this month</span><strong>${money(d.money.paid_this_month)}</strong></div>
      <a class="stat" href="#/jobs"><span>Open jobs</span><strong>${d.counts.open_jobs}</strong></a>
      <a class="stat" href="#/customers"><span>Customers</span><strong>${d.counts.customers}</strong></a>
      <a class="stat" href="#/remittances"><span>Draft remittances</span><strong>${d.counts.draft_remittances}</strong></a>
    </div>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Jobs by status</h3><a href="#/jobs" class="small">Board →</a></div>
        <div class="bars">${raw(d.jobs_by_status.map((s) => html`
          <a class="bar-row" href="#/jobs?status_id=${s.id}">
            <span class="bar-label">${s.name}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(s.count / maxJobs) * 100}%;background:${s.color}"></span></span>
            <span class="bar-val">${s.count}</span>
          </a>`).join(''))}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Upcoming due jobs</h3></div>
        ${raw(d.jobs_due.length ? html`<table class="table table-compact"><tbody>${raw(d.jobs_due.map((j) => html`
          <tr class="clickable" data-href="#/jobs/${j.id}">
            <td><strong>${j.number}</strong> ${j.title}<div class="muted small">${j.customer_name || ''}</div></td>
            <td>${raw(statusPill(j.status, j.status_color))}</td>
            <td class="nowrap ${j.due_date < new Date().toISOString().slice(0, 10) ? 'text-danger' : ''}">${date(j.due_date)}</td>
          </tr>`).join(''))}</tbody></table>` : emptyState('No open jobs with due dates.'))}
      </section>

      <section class="card">
        <div class="card-head"><h3>Overdue invoices</h3></div>
        ${raw(d.overdue_invoices.length ? html`<table class="table table-compact"><tbody>${raw(d.overdue_invoices.map((i) => html`
          <tr class="clickable" data-href="#/invoices/${i.id}">
            <td><strong>${i.number}</strong><div class="muted small">${i.customer_name || ''}</div></td>
            <td class="nowrap text-danger">Due ${date(i.due_date)}</td>
            <td class="num">${money(i.balance)}</td>
          </tr>`).join(''))}</tbody></table>` : emptyState('Nothing overdue. 🎉'))}
      </section>

      <section class="card">
        <div class="card-head"><h3>Low stock</h3><a href="#/inventory?low=1" class="small">All →</a></div>
        ${raw(d.low_stock.length ? html`<table class="table table-compact"><tbody>${raw(d.low_stock.map((i) => html`
          <tr class="clickable" data-href="#/inventory/${i.id}">
            <td><strong>${i.sku}</strong> ${i.name}</td>
            <td class="num text-danger">${qty(i.quantity)} ${i.unit || ''}</td>
            <td class="num muted">min ${qty(i.reorder_level)}</td>
          </tr>`).join(''))}</tbody></table>` : emptyState('All stock levels are healthy.'))}
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h3>Recent job activity</h3></div>
      ${raw(d.recent_activity.length ? html`<ul class="timeline">${raw(d.recent_activity.map((h) => html`
        <li><a href="#/jobs/${h.job_id}"><strong>${h.number}</strong> ${h.title}</a>
          — ${raw(h.from_status && h.from_status !== h.to_status ? html`<span class="muted">${h.from_status} →</span> <strong>${h.to_status}</strong>` : html`<strong>${h.to_status || ''}</strong>`)}
          ${raw(h.note ? html`<div class="small">${h.note}</div>` : '')}
          <div class="muted small">${dateTime(h.created_at)} ${h.user_name ? `· ${h.user_name}` : ''}</div></li>`).join(''))}</ul>`
        : emptyState('No activity yet.'))}
    </section>`;
}
