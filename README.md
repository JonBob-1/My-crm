# My CRM

A browser-based CRM for running a service/trade business. Everything runs from one small Node.js server with a
built-in SQLite database — no separate database server to install.

## Features

| Area | What you can do |
| --- | --- |
| **Dashboard** | Money outstanding / overdue / paid this month, jobs by status, jobs due soon, low stock, recent activity. |
| **Customers** | Contact details, notes, and every job, invoice, remittance and document for that customer. |
| **Jobs & process statuses** | Kanban board (drag cards between stages) or list view. Each job has a status stepper, full status history with who/when, notes, and attached files. Stages are customisable in Settings. |
| **Invoices** | Line items (pick from inventory to auto-fill price), discount, tax, auto numbering and due dates. Record payments/remittances received; status moves Draft → Sent → Part paid → Paid, with overdue flagged automatically. Print or save as PDF, email link, duplicate, void. |
| **Inventory** | Items with SKU, location, cost/sale price and reorder level. Stock movement log for every change; low-stock alerts; manual adjustments. |
| **Inventory remittances** | Documents recording stock **sent out** to or **received** from a customer/supplier. Save as draft, then *post* to update stock (warns on insufficient stock); *void* reverses the movement. Printable remittance / goods-received note with signature lines. |
| **Documents** | Drag-and-drop uploads (up to 25 MB each by default), attached to customers, jobs, invoices, remittances or inventory items, or kept as general documents. Searchable. |
| **API data** | Connect to other companies' APIs (JSON or CSV; no auth, bearer token, basic auth or API key). Preview records, map their fields to CRM fields, and import/update **customers**, **inventory** (e.g. supplier stock levels) or **jobs & job statuses** (e.g. a partner's job tracker). Run manually or on a schedule (15 min – daily). Every run is logged with the raw response. |
| **Users** | Sign-in with admin and staff roles. Admins manage settings, users, job stages and API connections. |

## Run it

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start
```

Open <http://localhost:3000>. The first visit asks you to create the admin account and company name.

Data (database + uploaded files) is stored in `./data`. **Back up this folder.**

### Settings via environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `CRM_DATA_DIR` | `./data` | Where the database and uploads live |
| `CRM_MAX_UPLOAD_MB` | `25` | Per-file upload limit |
| `TRUST_PROXY` | – | Set to `1` when running behind a reverse proxy (nginx, Caddy, a cloud load balancer) |

### Putting it on the internet

1. Run it on a server/VPS (or any host that runs Docker):
   ```bash
   docker build -t my-crm .
   docker run -d -p 3000:3000 -v crm-data:/data --restart unless-stopped my-crm
   ```
2. Put it behind HTTPS. The simplest option is [Caddy](https://caddyserver.com/):
   `caddy reverse-proxy --from crm.yourdomain.com --to localhost:3000`, and set `TRUST_PROXY=1`.
   Always use HTTPS on the public internet — passwords are sent over the connection.
3. Create a user for each member of staff under **Settings → Users**.

## Using API connections

Example: a supplier publishes stock at `https://api.supplier.com/v1/stock` returning
`{"data": {"items": [{"code": "W-1", "title": "Widget", "qty": 40, "price": 2.5}]}}`.

1. **API Data → New connection**, paste the URL, choose the authentication and paste your key.
2. Set **Records path** to `data.items` and **Import into** to *Inventory items*. Save.
3. Click **Fetch preview** — the detected field names become suggestions in the field mapping.
4. Map `sku → code`, `name → title`, `quantity → qty`, `unit_price → price`, save, then **Fetch & import now**
   (or pick a schedule).

For partner job trackers, import into *Jobs & statuses* and map `external_ref` to their job ID and `status` to their
status field; status changes appear in each job's history.

## Development

```bash
npm run dev    # restarts on file changes
npm test       # API tests
```

```
server/            Express API
  index.js         app setup, auth, users, settings, dashboard, scheduler
  db.js            SQLite schema and helpers
  routes/          customers, jobs, invoices, inventory, remittances, documents, integrations
public/            the browser app (plain JavaScript modules, no build step)
test/              API tests (node:test)
```
