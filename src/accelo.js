import { config } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), '[accelo]', ...a);

// Fields we request back from Accelo for quotes. Accelo hides most fields
// unless explicitly requested via _fields, and omits null/empty fields from
// responses. Includes the client-facing body sections (introduction,
// conclusion, terms_and_conditions) so reads round-trip what writes can set.
const QUOTE_FIELDS = [
  'id', 'title', 'against_type', 'against_id', 'affiliation_id', 'contact_id',
  'manager_id', 'standing', 'date_created', 'date_modified', 'date_issued',
  'date_due', 'date_expiry', 'total', 'tax', 'subtotal', 'currency_id',
  'notes', 'introduction', 'conclusion', 'terms_and_conditions',
  'client_portal_access',
].join(',');

async function acceloFetch(token, pathname, { method = 'GET', query, body } = {}) {
  const url = new URL(config.acceloBaseUrl + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    // Log the failing method + path + status + Accelo message (no token/body).
    log('ERROR', method, pathname, res.status, '-', msg);
    throw new Error(`Accelo API ${method} ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

export async function listQuotes(token, { search, limit = 25, page = 0, filters } = {}) {
  const query = { _fields: QUOTE_FIELDS, _limit: limit, _page: page };
  if (search) query._search = search;
  if (filters) query._filters = filters;
  const json = await acceloFetch(token, '/quotes', { query });
  return json.response;
}

export async function getQuote(token, id) {
  const json = await acceloFetch(token, `/quotes/${encodeURIComponent(id)}`, {
    query: { _fields: QUOTE_FIELDS },
  });
  return json.response;
}

export async function createQuote(token, fields) {
  const json = await acceloFetch(token, '/quotes', { method: 'POST', body: fields });
  return json.response;
}

export async function updateQuote(token, id, fields) {
  const json = await acceloFetch(token, `/quotes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: fields,
  });
  return json.response;
}

// Accelo calls deals/sales "prospects". A quote's parent deal is its
// against_id when against_type == "prospect". _fields=_ALL returns the full
// deal record (title, value, standing, date_actioned/date_won, etc).
export async function getDeal(token, id) {
  const json = await acceloFetch(token, `/prospects/${encodeURIComponent(id)}`, {
    query: { _fields: '_ALL' },
  });
  return json.response;
}
