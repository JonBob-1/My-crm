'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

/** Picks allowed keys from body, converting '' to null. */
function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body && Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      out[k] = v === '' || v === undefined ? null : v;
    }
  }
  return out;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] == null || String(obj[f]).trim() === '') throw badRequest(`"${f}" is required`);
  }
}

/** Builds an UPDATE ... SET for the given fields. Returns number of rows changed. */
function updateRow(db, table, id, fields, touch = true) {
  const keys = Object.keys(fields);
  if (!keys.length) return 0;
  const sets = keys.map((k) => `${k} = ?`);
  if (touch) sets.push("updated_at = datetime('now')");
  const res = db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return res.changes;
}

function insertRow(db, table, fields) {
  const keys = Object.keys(fields);
  const res = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => fields[k]));
  return Number(res.lastInsertRowid);
}

const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Reads a value from an object with a dot/bracket path, e.g. "data.items[0].name". */
function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

module.exports = { HttpError, badRequest, notFound, pick, num, requireFields, updateRow, insertRow, today, round2, getPath };
