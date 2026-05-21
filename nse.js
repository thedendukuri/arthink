// ══════════════════════════════════════════════════════════════
// nse.js — NSE India Direct API
//
// Replaces Yahoo Finance for all Indian market data:
//   • Live quotes for NSE stocks and indices
//   • Historical OHLCV (daily / weekly / monthly)
//   • Sparkline data (last 20 daily closes)
//
// Session strategy:
//   NSE requires a valid browser session cookie on every API call.
//   We acquire it by hitting the NSE homepage with browser-like
//   headers, then reuse that cookie for all subsequent calls.
//   A background timer refreshes the session every 25 minutes.
// ══════════════════════════════════════════════════════════════

// ── Symbol maps ──────────────────────────────────────────────
// Yahoo-format → NSE index name (for /api/allIndices)
const INDEX_MAP = {
  '^NSEI'     : 'NIFTY 50',
  '^NSEBANK'  : 'NIFTY BANK',
  '^CNXIT'    : 'NIFTY IT',
  '^CNXAUTO'  : 'NIFTY AUTO',
  '^CNXPHARMA': 'NIFTY PHARMA',
  '^NSMIDCP'  : 'NIFTY MIDCAP 100',
  '^CNXSMALL' : 'NIFTY SMALLCAP 100',
  '^CNXFMCG'  : 'NIFTY FMCG',
  '^CNXMETAL' : 'NIFTY METAL',
  '^CNXREALTY': 'NIFTY REALTY',
  '^CNXENERGY': 'NIFTY ENERGY',
  '^CNXINFRA' : 'NIFTY INFRASTRUCTURE',
  'NIFTY_FIN_SERVICE': 'NIFTY FINANCIAL SERVICES',
};

// Reverse map: NSE index name → Yahoo symbol (for response normalisation)
const INDEX_MAP_REV = Object.fromEntries(Object.entries(INDEX_MAP).map(([k,v]) => [v,k]));

// Returns true if this Yahoo-format symbol is handled by NSE Direct
export function isNseSupported(sym) {
  if (!sym) return false;
  return sym.endsWith('.NS') || sym.endsWith('.BO') || sym in INDEX_MAP;
}

// Convert Yahoo symbol → NSE equity ticker (strip suffix)
export function toNseTicker(sym) {
  return sym.replace(/\.(NS|BO)$/, '').toUpperCase();
}

// ── Session state ─────────────────────────────────────────────
const SESSION_TTL   = 25 * 60 * 1000; // 25 minutes
const NSE_BASE      = 'https://www.nseindia.com';

const _session = {
  cookies : '',         // raw cookie string to pass in requests
  fetchedAt: 0,         // timestamp of last successful session init
  pending : null,       // in-flight init promise (prevents thundering herd)
};

// Browser-like headers — NSE blocks requests without these
function browserHeaders(extra = {}) {
  return {
    'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : 'https://www.nseindia.com/',
    'Origin'         : 'https://www.nseindia.com',
    'Connection'     : 'keep-alive',
    'Sec-Fetch-Dest' : 'empty',
    'Sec-Fetch-Mode' : 'cors',
    'Sec-Fetch-Site' : 'same-origin',
    'Cache-Control'  : 'no-cache',
    ...(extra),
  };
}

// Extract Set-Cookie headers → single cookie string
function parseCookies(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

// Merge new cookies into existing cookie string
function mergeCookies(existing, fresh) {
  const map = new Map();
  for (const pair of (existing + '; ' + fresh).split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) map.set(k.trim(), v.join('=').trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function initSession() {
  console.log('[nse] acquiring session…');
  try {
    // Step 1 — hit the homepage to get the initial cookie set
    const r1 = await fetch(NSE_BASE + '/', {
      headers: browserHeaders({ Accept: 'text/html,application/xhtml+xml,*/*' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    let cookies = parseCookies(r1.headers);

    // Step 2 — hit a data page to warm up Akamai / bot-check cookies
    const r2 = await fetch(NSE_BASE + '/market-data/live-equity-market', {
      headers: browserHeaders({ Cookie: cookies }),
      signal: AbortSignal.timeout(10_000),
    });
    cookies = mergeCookies(cookies, parseCookies(r2.headers));

    if (!cookies) throw new Error('No cookies received from NSE');

    _session.cookies   = cookies;
    _session.fetchedAt = Date.now();
    console.log('[nse] session ready');
    return cookies;
  } catch (err) {
    console.error('[nse] session init failed:', err.message);
    throw err;
  }
}

// Get (or lazily init) a valid session — safe to call concurrently
async function getSession() {
  if (_session.cookies && Date.now() - _session.fetchedAt < SESSION_TTL) {
    return _session.cookies;
  }
  // Prevent thundering herd — only one init at a time
  if (!_session.pending) {
    _session.pending = initSession().finally(() => { _session.pending = null; });
  }
  return _session.pending;
}

// Background refresh — keeps session alive even when no requests come in
function startSessionRefresh() {
  setInterval(async () => {
    try { await initSession(); } catch {}
  }, SESSION_TTL - 2 * 60_000); // refresh 2 min before expiry
}

// ── Core fetch wrapper ────────────────────────────────────────
async function nseGet(path, retried = false) {
  const cookies = await getSession();
  const url     = NSE_BASE + path;

  const res = await fetch(url, {
    headers: browserHeaders({ Cookie: cookies }),
    signal : AbortSignal.timeout(8_000),
  });

  // Merge any new cookies NSE sends mid-session
  const fresh = parseCookies(res.headers);
  if (fresh) _session.cookies = mergeCookies(_session.cookies, fresh);

  if (res.status === 401 || res.status === 403) {
    if (retried) throw new Error(`NSE returned ${res.status} for ${path}`);
    // Session expired — force re-init and retry once
    _session.fetchedAt = 0;
    await initSession();
    return nseGet(path, true);
  }

  if (!res.ok) throw new Error(`NSE HTTP ${res.status} for ${path}`);
  return res.json();
}

// ── Quote — all indices in one call ──────────────────────────
let _indexCache = null;
let _indexCacheTs = 0;

async function fetchAllIndices() {
  if (_indexCache && Date.now() - _indexCacheTs < 10_000) return _indexCache;
  const data = await nseGet('/api/allIndices');
  _indexCache   = data?.data ?? [];
  _indexCacheTs = Date.now();
  return _indexCache;
}

// Normalise one NSE index record → Yahoo-compat quote shape
function normaliseIndex(rec, yahoSym) {
  return {
    symbol                     : yahoSym ?? INDEX_MAP_REV[rec.index] ?? rec.index,
    regularMarketPrice         : rec.last,
    regularMarketChange        : rec.variation,
    regularMarketChangePercent : rec.percentChange,
    regularMarketOpen          : rec.open,
    regularMarketDayHigh       : rec.high,
    regularMarketDayLow        : rec.low,
    regularMarketPreviousClose : rec.previousClose,
    regularMarketVolume        : null,
    fiftyTwoWeekHigh           : rec.yearHigh,
    fiftyTwoWeekLow            : rec.yearLow,
    marketCap                  : null,
    _source                    : 'nse',
  };
}

// Normalise one NSE equity quote-equity response → Yahoo-compat shape
function normaliseEquity(data, yahoSym) {
  const pi = data.priceInfo ?? {};
  const si = data.securityInfo ?? {};
  return {
    symbol                     : yahoSym,
    regularMarketPrice         : pi.lastPrice,
    regularMarketChange        : pi.change,
    regularMarketChangePercent : pi.pChange,
    regularMarketOpen          : pi.open,
    regularMarketDayHigh       : pi.intraDayHighLow?.max,
    regularMarketDayLow        : pi.intraDayHighLow?.min,
    regularMarketPreviousClose : pi.close,   // NSE 'close' = previous close
    regularMarketVolume        : si.totalTradedVolume ?? null,
    fiftyTwoWeekHigh           : pi.weekHighLow?.max,
    fiftyTwoWeekLow            : pi.weekHighLow?.min,
    marketCap                  : null,
    _source                    : 'nse',
  };
}

// ── Public: fetch quotes for a list of Yahoo-format symbols ──
export async function nseQuotes(symbols) {
  const indexSyms  = symbols.filter(s => s in INDEX_MAP);
  const equitySyms = symbols.filter(s => s.endsWith('.NS') || s.endsWith('.BO'));

  const results = [];

  // ── Indices — one call returns all of them ──
  if (indexSyms.length) {
    try {
      const all  = await fetchAllIndices();
      const byName = new Map(all.map(r => [r.index?.toUpperCase(), r]));
      for (const sym of indexSyms) {
        const nseKey = INDEX_MAP[sym]?.toUpperCase();
        const rec    = byName.get(nseKey);
        if (rec) results.push(normaliseIndex(rec, sym));
        else console.warn(`[nse] index not found in allIndices: ${sym} → ${nseKey}`);
      }
    } catch (err) {
      console.error('[nse] allIndices failed:', err.message);
      throw err;
    }
  }

  // ── Equities — one call per symbol (parallel) ──
  if (equitySyms.length) {
    const settled = await Promise.allSettled(
      equitySyms.map(async sym => {
        const ticker = toNseTicker(sym);
        const data   = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(ticker)}`);
        return normaliseEquity(data, sym);
      })
    );
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') {
        results.push(settled[i].value);
      } else {
        console.warn(`[nse] equity quote failed for ${equitySyms[i]}:`, settled[i].reason?.message);
      }
    }
  }

  return results;
}

// ── Historical OHLCV ─────────────────────────────────────────
// Returns array of { date, open, high, low, close, vol }
// date format: ISO string (YYYY-MM-DDTHH:mm:ss.000Z)

function fmtNseDate(d) {
  // NSE historical API wants DD-MM-YYYY
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// Equity historical: /api/historical/cm/equity
async function equityHistory(ticker, from, to) {
  const url = `/api/historical/cm/equity?symbol=${encodeURIComponent(ticker)}&series=["EQ"]&from=${fmtNseDate(from)}&to=${fmtNseDate(to)}`;
  const json = await nseGet(url);
  return (json?.data ?? []).map(r => ({
    date : new Date(r.CH_TIMESTAMP).toISOString(),
    open : r.CH_OPENING_PRICE,
    high : r.CH_TRADE_HIGH_PRICE,
    low  : r.CH_TRADE_LOW_PRICE,
    close: r.CH_CLOSING_PRICE,
    vol  : r.CH_TOT_TRADED_QTY ?? 0,
  })).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Index historical: /api/historical/indicesHistory
async function indexHistory(nseIndexName, from, to) {
  const url = `/api/historical/indicesHistory?indexType=${encodeURIComponent(nseIndexName)}&from=${fmtNseDate(from)}&to=${fmtNseDate(to)}`;
  const json = await nseGet(url);
  const records = json?.data?.indexCloseOnlineRecords ?? [];
  return records.map(r => ({
    date : new Date(r.EOD_TIMESTAMP).toISOString(),
    open : r.EOD_OPEN_INDEX_VAL,
    high : r.EOD_HIGH_INDEX_VAL,
    low  : r.EOD_LOW_INDEX_VAL,
    close: r.EOD_CLOSING_INDEX_VAL,
    vol  : 0,
  })).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── Public: fetch OHLCV history for a Yahoo-format symbol ────
// period: '1d' | '5d' | '1mo' | '3mo' | '1y' | '5y' | 'custom'
// interval: '1d' | '1wk' | '1mo'  (intraday not supported — use Yahoo)
export async function nseHistory(sym, { period = '1y', interval = '1d', from, to } = {}) {
  const isIndex  = sym in INDEX_MAP;
  const isEquity = sym.endsWith('.NS') || sym.endsWith('.BO');
  if (!isIndex && !isEquity) throw new Error(`nseHistory: unsupported symbol ${sym}`);

  // Resolve date range
  let dateFrom, dateTo;
  if (period === 'custom' && from && to) {
    dateFrom = new Date(from);
    dateTo   = new Date(to);
  } else {
    const daysMap = { '1d': 1, '5d': 7, '1mo': 35, '3mo': 95, '6mo': 185, '1y': 370, '2y': 740, '5y': 1850 };
    const days    = daysMap[period] ?? 370;
    dateFrom      = new Date(Date.now() - days * 86_400_000);
    dateTo        = new Date();
  }

  let bars;
  if (isIndex) {
    bars = await indexHistory(INDEX_MAP[sym], dateFrom, dateTo);
  } else {
    bars = await equityHistory(toNseTicker(sym), dateFrom, dateTo);
  }

  // Downsample to weekly/monthly if requested
  if (interval === '1wk')  bars = resample(bars, 'week');
  if (interval === '1mo')  bars = resample(bars, 'month');

  return bars;
}

// Resample daily bars → weekly or monthly OHLCV
function resample(bars, unit) {
  const buckets = new Map();
  for (const b of bars) {
    const d   = new Date(b.date);
    const key = unit === 'week'
      ? `${d.getFullYear()}-W${isoWeek(d)}`
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets.has(key)) {
      buckets.set(key, { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, vol: b.vol });
    } else {
      const bk = buckets.get(key);
      bk.high   = Math.max(bk.high, b.high);
      bk.low    = Math.min(bk.low,  b.low);
      bk.close  = b.close;
      bk.vol   += b.vol;
    }
  }
  return [...buckets.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
}

function isoWeek(d) {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const y1  = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp - y1) / 86_400_000) + 1) / 7);
}

// ── Public: sparkline closes (last N daily bars) ─────────────
export async function nseSparks(sym, n = 20) {
  const bars = await nseHistory(sym, { period: '3mo', interval: '1d' });
  return bars.slice(-n).map(b => b.close);
}

// ── Boot ─────────────────────────────────────────────────────
// Call once at server startup — warms up the session immediately
export async function nseInit() {
  try {
    await initSession();
    startSessionRefresh();
  } catch (err) {
    console.error('[nse] init failed — will retry on first request:', err.message);
  }
}
