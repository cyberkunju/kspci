'use strict';

/**
 * Obtains a Zoho OAuth access token (scope: QuickML.deployment.READ) for calling
 * the GLM chat endpoint, using a self-client refresh token.
 *
 * Required function env vars (set in catalyst-config.json / console):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *   ZOHO_ACCOUNTS_URL (default https://accounts.zoho.in)
 *
 * Token is cached in-process until ~2 min before expiry. Also mirrors to
 * Catalyst Cache when available so warm instances share it.
 */

let _cache = { token: null, exp: 0 };

async function getQuickMLToken(app) {
  const now = Date.now();
  if (_cache.token && now < _cache.exp - 120000) return _cache.token;

  // Try Catalyst Cache first (cross-instance reuse)
  try {
    if (app && app.cache) {
      const seg = app.cache().segment();
      const cached = await seg.getValue('glm_access_token');
      const val = cached && (cached.cache_value || cached.value || cached);
      if (typeof val === 'string' && val.startsWith('{')) {
        const parsed = JSON.parse(val);
        if (parsed.token && now < parsed.exp - 120000) {
          _cache = parsed;
          return parsed.token;
        }
      }
    }
  } catch (_) { /* cache optional */ }

  const accounts = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN || '',
    client_id: process.env.ZOHO_CLIENT_ID || '',
    client_secret: process.env.ZOHO_CLIENT_SECRET || '',
    grant_type: 'refresh_token'
  });
  const r = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth token error: ' + JSON.stringify(j).slice(0, 300));

  _cache = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  try {
    if (app && app.cache) {
      await app.cache().segment().put('glm_access_token', JSON.stringify(_cache), 1);
    }
  } catch (_) { /* ignore */ }
  return _cache.token;
}

module.exports = { getQuickMLToken };
