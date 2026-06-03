import { config } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), '[accelo]', ...a);

// Fields we request back from Accelo for quotes. Accelo hides most fields
// unless explicitly requested via _fields.
const QUOTE_FIELDS = [
  'id', 'title', 'against_type', 'against_id', 'affiliation_id', 'contact_id',
  'manager_id', 'standing', 'date_created', 'date_modified', 'date_issued',
  'date_due', 'total', 'tax', 'subtotal', 'currency_id', 'notes',
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
  log('->', method, url.toString(), body ? `body=${opts.body}` : '');
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    log('<-', res.status, 'ERROR body=', text.slice(0, 800));
    const msg = (json && json.meta && json.meta.message) || text;
    throw new Error(`Accelo API ${method} ${pathname} failed: ${res.status} ${msg}`);
  }
  log('<-', res.status, 'ok; response keys=', json && json.response ? (Array.isArray(json.response) ? `array[${json.response.length}]` : Object.keys(json.response).join(',')) : 'none');
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
