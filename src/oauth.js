import { config } from './config.js';
import db from './db.js';

function basicAuthHeader() {
  const raw = `${config.acceloClientId}:${config.acceloClientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// Exchange an Accelo authorization code for tokens.
export async function exchangeAcceloCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });
  const res = await fetch(`${config.acceloOAuthUrl}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Accelo token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Per-subject in-flight refresh promises. When a token is near expiry and many
// concurrent calls arrive (e.g. a burst of write tools), only the first starts
// the network refresh; the rest await the same promise. This prevents a
// "refresh stampede" of simultaneous POSTs to Accelo's token endpoint, which
// previously raced and rejected each other and could wedge the server.
const inFlightRefreshes = new Map();

// Perform the actual Accelo refresh-token round-trip and persist the result.
async function doRefresh(subject) {
  const row = db.prepare('SELECT * FROM accelo_tokens WHERE subject = ?').get(subject);
  if (!row) throw new Error('No Accelo token for subject');
  if (!row.refresh_token) throw new Error('No Accelo refresh token available; re-authorization required');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });
  const res = await fetch(`${config.acceloOAuthUrl}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Accelo token refresh failed: ${res.status} ${await res.text()}`);
  }
  const tok = await res.json();
  const expiresAt = Date.now() + (tok.expires_in ? tok.expires_in * 1000 : 3600 * 1000);
  db.prepare(
    'UPDATE accelo_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE subject = ?'
  ).run(tok.access_token, tok.refresh_token || null, expiresAt, subject);
  return tok.access_token;
}

// Refresh the Accelo token for a subject, coalescing concurrent refreshes so
// only one network call happens at a time per subject. Uses double-checked
// locking: once the lock is acquired, if another caller already refreshed the
// token (now valid), return it without a redundant round-trip.
export async function refreshAcceloToken(subject) {
  const existing = inFlightRefreshes.get(subject);
  if (existing) return existing;

  const p = (async () => {
    // Double-check: another concurrent caller may have just refreshed.
    const row = db.prepare('SELECT * FROM accelo_tokens WHERE subject = ?').get(subject);
    if (row && Date.now() < row.expires_at - 60000) return row.access_token;
    return doRefresh(subject);
  })();

  inFlightRefreshes.set(subject, p);
  try {
    return await p;
  } finally {
    inFlightRefreshes.delete(subject);
  }
}

// Return a valid Accelo access token for the subject, refreshing if near expiry.
export async function getValidAcceloToken(subject) {
  const row = db.prepare('SELECT * FROM accelo_tokens WHERE subject = ?').get(subject);
  if (!row) throw new Error('Not authorized with Accelo');
  if (Date.now() < row.expires_at - 60000) return row.access_token;
  return refreshAcceloToken(subject);
}
