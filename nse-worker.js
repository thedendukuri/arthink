// ══════════════════════════════════════════════════════════════
// nse-worker.js — Cloudflare Worker  (NSE India API Proxy)
//
// Paste this into the Cloudflare Workers dashboard editor and deploy.
//
// What it does:
//   • Acquires NSE session cookies by hitting the NSE homepage
//     (Cloudflare's edge IPs are not on Akamai's datacenter blocklist)
//   • Caches the session in isolate-level globals (stays warm for
//     multiple requests on the same CF isolate — typically minutes)
//   • Forwards any /api/* request to NSE and returns the JSON
//   • Auto-retries with a fresh session on 401/403
//
// Environment variables (set in CF dashboard → Worker → Settings → Variables):
//   NSE_PROXY_TOKEN   A secret string. Railway will send this in
//                     X-Proxy-Token so random callers can't use your Worker.
//
// Railway env vars to set after deploying:
//   NSE_PROXY_URL     https://your-worker.your-account.workers.dev
//   NSE_PROXY_TOKEN   (same secret as above)
// ══════════════════════════════════════════════════════════════

const NSE = 'https://www.nseindia.com';
const COOKIE_TTL = 22 * 60 * 1000; // 22 min — refresh before NSE's 25-min expiry
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Isolate-level session cache ───────────────────────────────
// CF isolates are reused across requests on the same edge node,
// so this gives us warm sessions without KV storage.
let _cookies   = '';
let _cookiesAt = 0;

// ── Header builders ───────────────────────────────────────────
function htmlHeaders(cookies = '') {
  return {
    'User-Agent'     : UA,
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection'     : 'keep-alive',
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

function apiHeaders(cookies) {
  return {
    'User-Agent'     : UA,
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : NSE + '/',
    'Origin'         : NSE,
    'Sec-Fetch-Dest' : 'empty',
    'Sec-Fetch-Mode' : 'cors',
    'Sec-Fetch-Site' : 'same-origin',
    'Cache-Control'  : 'no-cache',
    'Cookie'         : cookies,
  };
}

// ── Cookie helpers ────────────────────────────────────────────
function extractCookies(headers) {
  // CF Workers expose getAll() for multi-value headers
  const vals = typeof headers.getAll === 'function'
    ? headers.getAll('set-cookie')
    : [headers.get('set-cookie') || ''];
  return vals
    .join(',')
    .split(',')
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookies(existing, fresh) {
  const map = new Map();
  for (const pair of (existing + '; ' + fresh).split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Session acquisition ───────────────────────────────────────
async function acquireSession() {
  // Step 1: hit NSE homepage — gets initial bm_sz / nsit cookies
  const r1 = await fetch(NSE + '/', {
    headers : htmlHeaders(),
    redirect: 'follow',
  });
  let cookies = extractCookies(r1.headers);

  // Step 2: hit a data page — triggers Akamai bot-check and
  // sets ak_bmsc / bm_sv cookies needed for API calls
  const r2 = await fetch(NSE + '/market-data/live-equity-market', {
    headers : htmlHeaders(cookies),
    redirect: 'follow',
  });
  cookies = mergeCookies(cookies, extractCookies(r2.headers));

  if (!cookies) throw new Error('NSE returned no cookies');
  return cookies;
}

async function getSession() {
  if (_cookies && Date.now() - _cookiesAt < COOKIE_TTL) return _cookies;
  _cookies   = await acquireSession();
  _cookiesAt = Date.now();
  return _cookies;
}

// ── NSE API fetch (with auto-retry on session expiry) ─────────
async function nseApiFetch(path) {
  const cookies = await getSession();
  const res = await fetch(NSE + path, { headers: apiHeaders(cookies) });

  // Absorb any fresh cookies NSE sends mid-session
  const fresh = extractCookies(res.headers);
  if (fresh) _cookies = mergeCookies(_cookies, fresh);

  if (res.status === 401 || res.status === 403) {
    // Session was rejected — force re-acquire once
    _cookies   = '';
    _cookiesAt = 0;
    const newCookies = await getSession();
    const retry = await fetch(NSE + path, { headers: apiHeaders(newCookies) });
    if (!retry.ok) throw new Error(`NSE ${retry.status} (after session refresh)`);
    return retry;
  }

  if (!res.ok) throw new Error(`NSE ${res.status} for ${path}`);
  return res;
}

// ── Main handler ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin' : '*',
          'Access-Control-Allow-Headers': 'X-Proxy-Token',
          'Access-Control-Allow-Methods': 'GET',
        },
      });
    }

    // ── Auth ──
    if (env.NSE_PROXY_TOKEN) {
      const tok = request.headers.get('x-proxy-token');
      if (tok !== env.NSE_PROXY_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status : 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Validate NSE path ──
    // Only allow /api/* paths — never proxy arbitrary NSE pages
    const nsePath = url.pathname; // Worker receives requests at /api/...
    if (!nsePath.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Only /api/* paths are proxied' }), {
        status : 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Preserve original query string (NSE historical endpoints need ?symbol=...&from=...&to=...)
    const nseFullPath = nsePath + (url.search || '');

    try {
      const nseRes = await nseApiFetch(nseFullPath);
      const body   = await nseRes.text();

      return new Response(body, {
        status : 200,
        headers: {
          'Content-Type'                : 'application/json',
          'Access-Control-Allow-Origin' : '*',
          'Cache-Control'               : 'no-store',
          'X-NSE-Proxy'                 : 'cf-worker',
        },
      });
    } catch (err) {
      _cookies   = ''; // reset so next request tries a fresh session
      _cookiesAt = 0;
      return new Response(JSON.stringify({ error: err.message }), {
        status : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
