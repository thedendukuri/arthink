// ══════════════════════════════════════════════════════════════
// schwab.js — Schwab Developer API client for Node.js
//
// Auth model:
//   • Tokens are stored in schwab_tokens.json by schwab_refresh.py
//     (first-time interactive OAuth must be done via the Python script)
//   • This module reads that file, auto-refreshes the access token
//     when it expires (30 min), and falls back gracefully when
//     tokens aren't present (server keeps running on Yahoo Finance)
//
// Symbol model:
//   • Yahoo-style symbols used throughout (^GSPC, AAPL, etc.)
//   • Internally mapped to Schwab symbols where they differ
//   • Indian / international symbols flagged as unsupported →
//     caller falls back to Yahoo Finance for those
// ══════════════════════════════════════════════════════════════
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, 'schwab_tokens.json');
const AUTH_BASE   = 'https://api.schwabapi.com/v1/oauth';
const MD_BASE     = 'https://api.schwabapi.com/marketdata/v1';

// ── Symbol mapping: Yahoo → Schwab ──────────────────────────
const YAHOO_TO_SCHWAB = {
  '^GSPC' : '$SPX.X',
  '^IXIC' : '$COMPQ',
  '^DJI'  : '$DJI',
  '^RUT'  : '$RUT.X',
  '^VIX'  : '$VIX.X',
};
const SCHWAB_TO_YAHOO = Object.fromEntries(
  Object.entries(YAHOO_TO_SCHWAB).map(([y, s]) => [s, y])
);

// Symbols Schwab Market Data doesn't carry (non-US exchanges)
const UNSUPPORTED = new Set([
  '^NSEI','^BSESN','^NSEBANK','^CNXIT','^CNXAUTO','^CNXPHARMA',
  '^FTSE','^GDAXI','^FCHI','^STOXX50E','^IBEX',
  '^N225','^TOPX',
  '000001.SS','399001.SZ','^HSI',
  '^AXJO','^STI','^KS11','^TWII',
  '^BVSP','^MXX',
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','ICICIBANK.NS',
  'HINDUNILVR.NS','ITC.NS','SBIN.NS','BAJFINANCE.NS','WIPRO.NS',
  'MARUTI.NS','SUNPHARMA.NS','LT.NS','TATASTEEL.NS','ADANIPORTS.NS','HCLTECH.NS',
]);

export const isSchwabSupported = sym => !UNSUPPORTED.has(sym);

function toSchwabSym(sym) { return YAHOO_TO_SCHWAB[sym] ?? sym; }
function toYahooSym(sym)  { return SCHWAB_TO_YAHOO[sym] ?? sym; }

// ── Token management ─────────────────────────────────────────
let _tokens = null;

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE))
      _tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {}
  return _tokens;
}

function saveTokens(data) {
  const now = Date.now();
  data.access_token_expires_at  = new Date(now + (data.expires_in  - 60) * 1000).toISOString();
  data.refresh_token_expires_at = new Date(now + 6 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
  _tokens = data;
}

function basicAuthHeader() {
  const k = process.env.SCHWAB_APP_KEY;
  const s = process.env.SCHWAB_APP_SECRET;
  if (!k || !s) return null;
  return 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64');
}

async function refreshAccessToken() {
  const t = _tokens || loadTokens();
  if (!t?.refresh_token) throw new Error('No refresh token — run: python schwab_refresh.py');
  const auth = basicAuthHeader();
  if (!auth) throw new Error('SCHWAB_APP_KEY / SCHWAB_APP_SECRET not set in .env');

  const resp = await fetch(`${AUTH_BASE}/token`, {
    method : 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  if (!data.refresh_token) data.refresh_token = t.refresh_token; // Schwab sometimes omits it
  saveTokens(data);
  console.log('[schwab] access token refreshed');
  return data.access_token;
}

async function getAccessToken() {
  const t = _tokens || loadTokens();
  if (!t) return null; // tokens not set up yet — caller should fall back to Yahoo

  // Token still valid?
  if (t.access_token_expires_at && new Date(t.access_token_expires_at) > new Date())
    return t.access_token;

  // Refresh token still valid?
  if (t.refresh_token_expires_at && new Date(t.refresh_token_expires_at) <= new Date()) {
    console.warn('[schwab] refresh token expired — re-run: python schwab_refresh.py');
    return null;
  }

  return refreshAccessToken();
}

// ── Quote normaliser ─────────────────────────────────────────
// Converts Schwab's response shape → same object shape yahoo-finance2 returns,
// so the frontend doesn't need any changes.
function normalizeQuote(yahooSym, schwabEntry) {
  const q = schwabEntry?.quote ?? {};
  return {
    symbol                       : yahooSym,
    regularMarketPrice           : q.lastPrice,
    regularMarketChange          : q.netChange,
    regularMarketChangePercent   : q.netPercentChange,
    regularMarketVolume          : q.totalVolume,
    regularMarketOpen            : q.openPrice,
    regularMarketDayHigh         : q.highPrice,
    regularMarketDayLow          : q.lowPrice,
    regularMarketPreviousClose   : q.closePrice,
    fiftyTwoWeekHigh             : q['52WeekHigh'],
    fiftyTwoWeekLow              : q['52WeekLow'],
    marketCap                    : q.marketCap ?? null,
  };
}

// ── Public API ───────────────────────────────────────────────

/**
 * Fetch real-time quotes for a list of Yahoo-style symbols.
 * Returns an array matching the shape yahoo-finance2 .quote() returns.
 * Throws if Schwab tokens aren't available (caller should fall back).
 */
export async function schwabQuotes(yahooSymbols) {
  const token = await getAccessToken();
  if (!token) throw new Error('schwab: no token');

  const schwabSyms = yahooSymbols.map(toSchwabSym);
  const resp = await fetch(
    `${MD_BASE}/quotes?symbols=${encodeURIComponent(schwabSyms.join(','))}&fields=quote,reference`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
  );
  if (!resp.ok) throw new Error(`schwab quotes: ${resp.status}`);
  const data = await resp.json();

  return yahooSymbols.map(yahoSym => {
    const schwabSym = toSchwabSym(yahoSym);
    const entry = data[schwabSym] ?? data[yahoSym] ?? {};
    return normalizeQuote(yahoSym, entry);
  }).filter(q => q.regularMarketPrice != null);
}

/**
 * Fetch OHLC candles for a Yahoo-style symbol.
 * period:   '1d' | '5d' | '1mo' | '3mo' | '1y'
 * interval: '1m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk'
 * from/to:  ISO date strings for custom range
 *
 * Returns array of { date (ISO), open, high, low, close, vol }
 */
export async function schwabPriceHistory(yahooSym, { period = '1mo', interval = '1d', from, to } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('schwab: no token');

  const schwabSym = toSchwabSym(yahooSym);
  const params = new URLSearchParams({ symbol: schwabSym });

  if (from && to) {
    // Custom date range
    params.set('startDate', String(new Date(from).getTime()));
    params.set('endDate',   String(new Date(to + 'T23:59:59').getTime()));
    // Derive frequency from interval
    const { ft, f } = intervalToFreq(interval);
    params.set('periodType',    ft === 'minute' ? 'day' : 'month');
    params.set('frequencyType', ft);
    params.set('frequency',     String(f));
  } else {
    // Named period
    const { periodType, periodCount, frequencyType, frequency } = periodParams(period, interval);
    params.set('periodType',    periodType);
    params.set('period',        String(periodCount));
    params.set('frequencyType', frequencyType);
    params.set('frequency',     String(frequency));
  }

  const resp = await fetch(`${MD_BASE}/pricehistory?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal : AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=>'');
    throw new Error(`schwab pricehistory ${schwabSym}: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return (data.candles ?? []).map(c => ({
    date : new Date(c.datetime).toISOString(),
    open : c.open,
    high : c.high,
    low  : c.low,
    close: c.close,
    vol  : c.volume ?? 0,
  }));
}

// ── Period / interval helpers ─────────────────────────────────
function intervalToFreq(interval) {
  const map = {
    '1m': { ft:'minute', f:1 },
    '5m': { ft:'minute', f:5 },
    '15m':{ ft:'minute', f:15 },
    '30m':{ ft:'minute', f:30 },
    '60m':{ ft:'minute', f:30 }, // Schwab max is 30m; closest to 1h
    '1h': { ft:'minute', f:30 },
    '1d': { ft:'daily',  f:1 },
    '1wk':{ ft:'weekly', f:1 },
  };
  return map[interval] ?? { ft:'daily', f:1 };
}

function periodParams(period, interval) {
  // Base period shape
  const base = {
    '1d' : { periodType:'day',   periodCount:1,  frequencyType:'minute', frequency:5  },
    '5d' : { periodType:'day',   periodCount:5,  frequencyType:'minute', frequency:30 },
    '1mo': { periodType:'month', periodCount:1,  frequencyType:'daily',  frequency:1  },
    '3mo': { periodType:'month', periodCount:3,  frequencyType:'daily',  frequency:1  },
    '1y' : { periodType:'year',  periodCount:1,  frequencyType:'weekly', frequency:1  },
  }[period] ?? { periodType:'month', periodCount:1, frequencyType:'daily', frequency:1 };

  // Override frequency with explicit interval if provided
  const { ft, f } = intervalToFreq(interval);
  return { ...base, frequencyType: ft, frequency: f };
}

// ── Startup check ─────────────────────────────────────────────
export function schwabStatus() {
  const t = loadTokens();
  if (!t) return { ready: false, reason: 'No schwab_tokens.json found. Run: python schwab_refresh.py' };
  if (t.refresh_token_expires_at && new Date(t.refresh_token_expires_at) <= new Date())
    return { ready: false, reason: 'Refresh token expired. Re-run: python schwab_refresh.py' };
  if (t.access_token_expires_at && new Date(t.access_token_expires_at) <= new Date())
    return { ready: true, reason: 'Access token needs refresh (will auto-refresh on first request)' };
  return { ready: true, reason: 'Tokens valid' };
}
