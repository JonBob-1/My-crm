import { api, html, raw, $, $$, fileSize, dateTime, toast, showError, confirmDialog } from '../lib.js';

/**
 * Renders an upload drop zone plus the documents attached to a record.
 * With entityType null, files are uploaded unattached and only the drop zone is shown (onUploaded is called after).
 */
export async function docPanel(container, entityType, entityId, { title = 'Documents', subtitle = '', onUploaded } = {}) {
  const docs = entityType ? await api(`/documents?entity_type=${entityType}&entity_id=${entityId}`) : [];
  const rerender = () => docPanel(container, entityType, entityId, { title, subtitle, onUploaded });
  container.innerHTML = html`
    <section class="card">
      <div class="card-head"><h3>${title}</h3><span class="muted">${subtitle || `${docs.length} file(s)`}</span></div>
      <label class="dropzone" data-drop>
        <input type="file" multiple hidden data-file>
        <span><strong>Drop files here</strong> or click to upload</span>
      </label>
      ${raw(docs.length ? docTable(docs, !entityType) : '')}
    </section>`;
  const zone = $('[data-drop]', container);
  const inputEl = $('[data-file]', container);
  const upload = async (files) => {
    if (!files.length) return;
    const form = new FormData();
    [...files].forEach((f) => form.append('files', f));
    if (entityType) { form.append('entity_type', entityType); form.append('entity_id', entityId); }
    zone.classList.add('busy');
    try {
      await api('/documents', { method: 'POST', form });
      toast(`${files.length} file(s) uploaded`);
      await rerender();
      onUploaded?.();
    } catch (err) {
      showError(err);
      zone.classList.remove('busy');
    }
  };
  inputEl.addEventListener('change', () => upload(inputEl.files));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); upload(e.dataTransfer.files); });
  bindDocActions(container, rerender);
}

const PREVIEWABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'];

export function docTable(docs, showLink = true) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>File</th>${raw(showLink ? '<th>Linked to</th>' : '')}<th>Size</th><th>Uploaded</th><th></th></tr></thead>
    <tbody>${raw(docs.map((d) => html`<tr>
      <td><a href="/api/documents/${d.id}/download${PREVIEWABLE.includes(d.mime_type) ? '?inline=1' : ''}" target="_blank" rel="noopener">${d.original_name}</a>
        ${raw(d.description ? html`<div class="muted small">${d.description}</div>` : '')}</td>
      ${raw(showLink ? html`<td>${raw(d.entity_type ? html`<a href="#/${linkFor(d.entity_type)}/${d.entity_id}">${d.entity_type}: ${d.entity_label || `#${d.entity_id}`}</a>` : '<span class="muted">—</span>')}</td>` : '')}
      <td class="nowrap">${fileSize(d.size)}</td>
      <td class="nowrap">${dateTime(d.created_at)}<div class="muted small">${d.uploaded_by_name || ''}</div></td>
      <td class="row-actions">
        <a class="btn btn-sm" href="/api/documents/${d.id}/download">Download</a>
        <button class="btn btn-sm btn-ghost" data-del-doc="${d.id}" title="Delete">✕</button>
      </td></tr>`).join(''))}
    </tbody></table></div>`;
}

export function bindDocActions(root, reload) {
  $$('[data-del-doc]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this document permanently?'))) return;
    try {
      await api(`/documents/${b.dataset.delDoc}`, { method: 'DELETE' });
      toast('Document deleted');
      reload();
    } catch (err) { showError(err); }
  }));
}

function linkFor(type) {
  return { customer: 'customers', job: 'jobs', invoice: 'invoices', remittance: 'remittances', inventory: 'inventory' }[type];
}
