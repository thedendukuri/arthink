// ══════════════════════════════════════════════════════════════
// ārthink. — server.js
//
// Data sources (priority order):
//   1. Schwab Developer API (real-time, US stocks/indices)
//      → requires schwab_tokens.json from python schwab_refresh.py
//   2. yahoo-finance2 (fallback for Indian / international symbols
//      and any US symbol that Schwab fails on)
//
// Schwab gives you:
//   • True real-time quotes (no 15-min delay)
//   • Proper intraday minute bars (1m / 5m / 15m / 30m)
//   • Price history up to years back at daily/weekly resolution
// ══════════════════════════════════════════════════════════════
import express      from 'express';
import path         from 'path';
import { fileURLToPath } from 'url';
import * as dotenv  from 'dotenv';
import YahooFinance from 'yahoo-finance2';
import {
  isSchwabSupported,
  schwabQuotes,
  schwabPriceHistory,
  schwabStatus,
} from './schwab.js';

dotenv.config();
const yahooFinance = new YahooFinance();
const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const app          = express();
const PORT         = process.env.PORT || 3000;

// ── In-memory cache ─────────────────────────────────────────
const cache = new Map();
function getCache(key, ttlMs) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.ts < ttlMs ? hit.data : null;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Status on boot ───────────────────────────────────────────
const _schwabStatus = schwabStatus();
console.log(`[schwab] ${_schwabStatus.ready ? '✓ ready' : '✗ unavailable'} — ${_schwabStatus.reason}`);
let schwabAvailable = _schwabStatus.ready;

// ── HTTPS redirect (production only) ────────────────────────
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1') || host.includes('railway.internal');
  const proto = req.headers['x-forwarded-proto'];
  if (!isLocal && proto && proto !== 'https') {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
});

// ── Serve front-end ─────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bharatiya-finance.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));

// ── GET /api/quote?syms=^NSEI,TCS.NS,AAPL,^GSPC ─────────────
// Splits by data source, fetches in parallel, merges results.
app.get('/api/quote', async (req, res) => {
  const syms = req.query.syms || '';
  if (!syms) return res.status(400).json({ error: 'syms param required' });

  const cached = getCache('q:' + syms, 15_000); // 15-second cache
  if (cached) return res.json(cached);

  const symbols = syms.split(',').map(s => s.trim()).filter(Boolean);

  try {
    const results = await fetchQuotes(symbols);
    const payload = { quoteResponse: { result: results, error: null } };
    setCache('q:' + syms, payload);
    res.json(payload);
  } catch (err) {
    console.error('[quote]', err.message);
    res.status(502).json({ error: 'upstream_failed', detail: err.message });
  }
});

async function fetchQuotes(symbols) {
  // When Schwab is available: route US symbols to Schwab, rest to Yahoo.
  // When Schwab is unavailable: fall back ALL symbols to Yahoo so nothing vanishes.
  const schwabSyms = schwabAvailable ? symbols.filter(isSchwabSupported) : [];
  const yahooSyms  = schwabAvailable
    ? symbols.filter(s => !isSchwabSupported(s))
    : symbols; // full fallback — every symbol goes to Yahoo

  const [schwabResults, yahooResults] = await Promise.allSettled([
    schwabSyms.length ? schwabQuotes(schwabSyms) : Promise.resolve([]),
    yahooSyms.length  ? yahooQuotes(yahooSyms)   : Promise.resolve([]),
  ]);

  let results = [];

  // Schwab results — if Schwab call fails, fetch those symbols from Yahoo too
  if (schwabResults.status === 'fulfilled') {
    results.push(...schwabResults.value);
    // Also catch any symbols Schwab returned with no price (filtered out in schwabQuotes)
    const gotSyms = new Set(results.map(q => q.symbol));
    const missing = schwabSyms.filter(s => !gotSyms.has(s));
    if (missing.length) {
      try { results.push(...await yahooQuotes(missing)); } catch {}
    }
  } else {
    console.warn('[schwab quote fail]', schwabResults.reason?.message);
    if (schwabSyms.length) {
      try { results.push(...await yahooQuotes(schwabSyms)); } catch {}
    }
  }

  // Yahoo results
  if (yahooResults.status === 'fulfilled') {
    results.push(...yahooResults.value);
  } else {
    console.warn('[yahoo quote fail]', yahooResults.reason?.message);
  }

  return results;
}

async function yahooQuotes(symbols) {
  const raw = await yahooFinance.quote(symbols, {
    fields: [
      'regularMarketPrice','regularMarketChange','regularMarketChangePercent',
      'regularMarketVolume','regularMarketOpen','regularMarketDayHigh',
      'regularMarketDayLow','regularMarketPreviousClose',
      'fiftyTwoWeekHigh','fiftyTwoWeekLow','marketCap','symbol',
    ],
  });
  return Array.isArray(raw) ? raw : [raw];
}

// ── GET /api/chart?sym=AAPL&period=1d&interval=5m ───────────
// Uses Schwab for US symbols (real-time intraday), Yahoo for others.
// Also supports: ?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/chart', async (req, res) => {
  const { sym, period = '1mo', interval = '1d' } = req.query;
  if (!sym) return res.status(400).json({ error: 'sym param required' });

  const isCustom = period === 'custom' && req.query.from && req.query.to;
  const key = `c:${sym}:${period}:${interval}:${req.query.from||''}:${req.query.to||''}`;
  const ttl = (period === '1d' || interval.includes('m')) ? 60_000 : 5 * 60_000;
  const cached = getCache(key, ttl);
  if (cached) return res.json(cached);

  try {
    let ohlc;
    const useSchwab = schwabAvailable && isSchwabSupported(sym);

    if (useSchwab) {
      try {
        ohlc = await schwabPriceHistory(sym, {
          period   : isCustom ? 'custom' : period,
          interval,
          from     : req.query.from,
          to       : req.query.to,
        });
      } catch (schwabErr) {
        console.warn(`[schwab chart fail ${sym}]`, schwabErr.message, '— falling back to Yahoo');
        ohlc = null;
      }
    }

    // Fall back to Yahoo if Schwab not available or failed
    if (!ohlc) {
      ohlc = await yahooChart(sym, period, interval, req.query.from, req.query.to, isCustom);
    }

    const payload = { ohlc, meta: { symbol: sym, source: useSchwab && ohlc?.length ? 'schwab' : 'yahoo' } };
    setCache(key, payload);
    res.json(payload);
  } catch (err) {
    console.error('[chart]', err.message);
    res.status(502).json({ error: 'upstream_failed', detail: err.message });
  }
});

async function yahooChart(sym, period, interval, from, to, isCustom) {
  let period1, period2;
  if (isCustom) {
    period1 = new Date(from);
    period2 = new Date(to);
    period2.setHours(23, 59, 59, 999);
  } else {
    const daysBack = { '1d':1, '5d':5, '1mo':30, '3mo':92, '1y':365 };
    const days = daysBack[period] || 30;
    period1 = new Date(Date.now() - days * 86400_000);
    period2 = new Date();
  }
  const chart = await yahooFinance.chart(sym, { period1, period2, interval });
  return (chart?.quotes ?? [])
    .filter(b => b.close != null)
    .map(b => ({
      date : new Date(b.date).toISOString(),
      open : b.open,
      high : b.high,
      low  : b.low,
      close: b.close,
      vol  : b.volume || 0,
    }));
}

// ── GET /api/sparks?syms=^NSEI,^NSEBANK,TCS.NS  ──────────────────────────────
// Returns last 20 daily closes per symbol for sparkline rendering.
// Cached 10 minutes — accurate enough for decorative mini-charts.
app.get('/api/sparks', async (req, res) => {
  const syms = (req.query.syms || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!syms.length) return res.status(400).json({ error: 'syms required' });

  const cacheKey = 'sparks:' + syms.join(',');
  const cached = getCache(cacheKey, 10 * 60_000);
  if (cached) return res.json(cached);

  const period1 = new Date(Date.now() - 30 * 86400_000);
  const period2 = new Date();

  const results = {};
  await Promise.allSettled(syms.map(async sym => {
    try {
      const chart = await yahooFinance.chart(sym, { period1, period2, interval: '1d' });
      const closes = (chart?.quotes ?? [])
        .filter(b => b.close != null)
        .map(b => b.close)
        .slice(-20);
      if (closes.length >= 2) results[sym] = closes;
    } catch {}
  }));

  setCache(cacheKey, results);
  res.json(results);
});

// ── GET /api/news?sym=RELIANCE.NS  (optional sym for ticker news) ────────────
// General: merges ET, Moneycontrol, Business Standard, Mint RSS feeds.
// Ticker:  uses yahoo-finance2 search for stock/index-specific headlines.
// Cache:   30 minutes (news doesn't need to be fresher than that).

// Yahoo Finance search queries for India market news
const YF_INDIA_QUERIES = [
  '^NSEI', '^BSESN', 'India stock market NSE Nifty',
  'RBI India economy', 'India IPO BSE',
];

// Yahoo Finance search queries for global markets
const YF_WORLD_QUERIES = [
  '^GSPC', '^DJI', '^IXIC', 'Federal Reserve interest rates',
  'global markets economy', 'Wall Street earnings',
];

// Google News RSS — aggregates ET/MC/BS/Mint automatically
const GOOGLE_NEWS_FEEDS = [
  { url: 'https://news.google.com/rss/search?q=india+stock+market+NSE+Nifty&hl=en-IN&gl=IN&ceid=IN:en', src: null, region: 'india' },
  { url: 'https://news.google.com/rss/search?q=BSE+Sensex+India+economy&hl=en-IN&gl=IN&ceid=IN:en',    src: null, region: 'india' },
  { url: 'https://news.google.com/rss/search?q=RBI+india+rupee+market&hl=en-IN&gl=IN&ceid=IN:en',      src: null, region: 'india' },
  { url: 'https://news.google.com/rss/search?q=global+stock+market+Wall+Street+fed&hl=en&gl=US&ceid=US:en', src: null, region: 'world' },
];

// India RSS feeds
const INDIA_RSS_FEEDS = [
  { url: 'https://economictimes.indiatimes.com/markets/rss.cms',                src: 'Economic Times'    },
  { url: 'https://economictimes.indiatimes.com/markets/stocks/rss.cms',         src: 'Economic Times'    },
  { url: 'https://www.business-standard.com/rss/markets-106.rss',               src: 'Business Standard' },
  { url: 'https://www.business-standard.com/rss/economy-policy-104.rss',        src: 'Business Standard' },
  { url: 'https://www.livemint.com/rss/markets',                                src: 'Mint'              },
  { url: 'https://www.livemint.com/rss/economy',                                src: 'Mint'              },
  { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml',                      src: 'Moneycontrol'      },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml',                  src: 'Moneycontrol'      },
  { url: 'https://www.financialexpress.com/market/rss.xml',                     src: 'Financial Express' },
  { url: 'https://www.thehindubusinessline.com/markets/?service=rss',           src: 'BusinessLine'      },
];

// World RSS feeds
const WORLD_RSS_FEEDS = [
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                      src: 'WSJ'               },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',                    src: 'WSJ'               },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',         src: 'MarketWatch'       },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',              src: 'CNBC'              },
  { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html',               src: 'CNBC'              },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                      src: 'Reuters'           },
  { url: 'https://feeds.reuters.com/reuters/INbusinessNews',                    src: 'Reuters'           },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',          src: 'NYT'               },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',                     src: 'BBC'               },
  { url: 'https://www.ft.com/?format=rss',                                     src: 'FT'                },
  { url: 'https://feeds.apnews.com/apnews/Business',                           src: 'AP'                },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135', src: 'CNBC' },
];

const NEWS_24H = 24 * 60 * 60 * 1000; // 24-hour window for "today" articles

app.get('/api/news', async (req, res) => {
  const sym = req.query.sym || null;
  const key = sym ? `news:${sym}` : 'news:general';
  const cached = getCache(key, 30 * 60_000); // 30-minute cache
  if (cached) return res.json(cached);

  try {
    const all = sym ? await fetchYahooNews(sym) : await fetchGeneralNews();
    const cutoff = Date.now() - NEWS_24H;
    const articles = all.filter(a => new Date(a.pubDate).getTime() >= cutoff);
    const archives  = all.filter(a => new Date(a.pubDate).getTime() <  cutoff);
    const payload = {
      articles,
      archives,
      ts: new Date().toISOString(),
      count: articles.length,
    };
    setCache(key, payload);
    res.json(payload);
  } catch (err) {
    console.error('[news]', err.message);
    res.status(502).json({ error: err.message, articles: [], archives: [] });
  }
});

function normalizeYahooNewsItem(n, region = 'world') {
  return {
    id       : n.uuid,
    title    : n.title,
    link     : n.link,
    source   : n.publisher,
    pubDate  : n.providerPublishTime
                ? new Date(n.providerPublishTime * 1000).toISOString()
                : new Date().toISOString(),
    excerpt  : '',
    thumbnail: n.thumbnail?.resolutions?.find(r => r.width >= 200)?.url
             || n.thumbnail?.resolutions?.[0]?.url
             || null,
    category : categorizeNews(n.title),
    region,
  };
}

function tagRegion(article, region) {
  article.region = region;
  return article;
}

function detectRegion(title = '', source = '') {
  const t = (title + ' ' + source).toLowerCase();
  if (/nse|bse|sensex|nifty|rbi|rupee|india|₹|crore|lakh|sebi|dalal/.test(t)) return 'india';
  return 'world';
}

async function fetchYahooNews(sym) {
  const result = await yahooFinance.search(sym, { newsCount: 20, enableFuzzyQuery: false });
  return (result.news || []).map(n => normalizeYahooNewsItem(n, detectRegion(n.title, n.publisher)));
}

async function fetchGeneralNews() {
  // Run ALL sources in parallel — merge whatever succeeds for maximum diversity
  const [yfIndiaSettled, yfWorldSettled, googleSettled, indiaSettled, worldSettled] = await Promise.all([
    // ── Yahoo Finance India ────────────────────────────────────
    Promise.allSettled(
      YF_INDIA_QUERIES.map(q =>
        yahooFinance.search(q, { newsCount: 10, enableFuzzyQuery: false })
      )
    ).catch(() => []),
    // ── Yahoo Finance World ────────────────────────────────────
    Promise.allSettled(
      YF_WORLD_QUERIES.map(q =>
        yahooFinance.search(q, { newsCount: 10, enableFuzzyQuery: false })
      )
    ).catch(() => []),
    // ── Google News RSS ────────────────────────────────────────
    Promise.allSettled(
      GOOGLE_NEWS_FEEDS.map(f => parseRSS(f.url, f.src).then(items => items.map(a => tagRegion(a, f.region || detectRegion(a.title, a.source)))))
    ).catch(() => []),
    // ── India direct RSS ───────────────────────────────────────
    Promise.allSettled(
      INDIA_RSS_FEEDS.map(f => parseRSS(f.url, f.src).then(items => items.map(a => tagRegion(a, 'india'))))
    ).catch(() => []),
    // ── World direct RSS ───────────────────────────────────────
    Promise.allSettled(
      WORLD_RSS_FEEDS.map(f => parseRSS(f.url, f.src).then(items => items.map(a => tagRegion(a, 'world'))))
    ).catch(() => []),
  ]);

  const seen     = new Set();
  const articles = [];
  const srcCounts = {};

  function ingest(items, region) {
    for (const a of items) {
      const key = a.id || a.link;
      if (!key || seen.has(key) || !a.title) continue;
      seen.add(key);
      if (region) a.region = region;
      articles.push(a);
      srcCounts[a.source] = (srcCounts[a.source] || 0) + 1;
    }
  }

  // Yahoo India
  let yfIn = 0, yfWorld = 0;
  for (const r of yfIndiaSettled) {
    if (r.status !== 'fulfilled') continue;
    for (const n of (r.value.news || [])) {
      if (!n.title || seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      articles.push(normalizeYahooNewsItem(n, 'india'));
      yfIn++;
    }
  }
  // Yahoo World
  for (const r of yfWorldSettled) {
    if (r.status !== 'fulfilled') continue;
    for (const n of (r.value.news || [])) {
      if (!n.title || seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      articles.push(normalizeYahooNewsItem(n, detectRegion(n.title, n.publisher)));
      yfWorld++;
    }
  }

  // Google News
  for (const r of googleSettled) {
    if (r.status !== 'fulfilled') { console.warn('[rss google]', r.reason?.message); continue; }
    ingest(r.value);
  }
  // India direct
  for (const r of indiaSettled) {
    if (r.status !== 'fulfilled') { console.warn('[rss india]', r.reason?.message); continue; }
    ingest(r.value, 'india');
  }
  // World direct
  for (const r of worldSettled) {
    if (r.status !== 'fulfilled') { console.warn('[rss world]', r.reason?.message); continue; }
    ingest(r.value, 'world');
  }

  console.log(`[news] merged: YF-India=${yfIn} YF-World=${yfWorld} Sources=${JSON.stringify(srcCounts)} total=${articles.length}`);
  if (!articles.length) throw new Error('All news sources failed');

  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = articles.slice(0, 100);
  await enrichWithOgImages(top.slice(0, 30));
  return top;
}

// ── og:image scraper ─────────────────────────────────────────
// Persistent cache (survives news cache expiry — og:images don't change)
const _ogCache = new Map();

async function fetchOgImage(url) {
  if (_ogCache.has(url)) return _ogCache.get(url);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept'    : 'text/html',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) { _ogCache.set(url, null); return null; }

    // Stream only the first 10 KB — og:image is always in <head>
    const reader = resp.body.getReader();
    let html = '';
    while (html.length < 10_240) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      // Stop once we've passed </head>
      if (html.includes('</head>') || html.includes('<body')) break;
    }
    reader.cancel().catch(() => {});

    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    const img = match?.[1] || null;
    _ogCache.set(url, img);
    return img;
  } catch {
    _ogCache.set(url, null);
    return null;
  }
}

async function enrichWithOgImages(articles) {
  await Promise.all(
    articles
      .filter(a => !a.thumbnail && a.link && a.link.startsWith('http'))
      .map(async a => {
        a.thumbnail = await fetchOgImage(a.link);
      })
  );
}

async function parseRSS(url, sourceName) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    signal : AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`${sourceName} ${resp.status}`);
  const xml = await resp.text();

  const items = [];
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const raw   = m[1];
    const get   = tag => {
      const r = raw.match(
        new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}(?:\\s[^>]*)?>([^<]*)<\\/${tag}>`)
      );
      return r ? (r[1] ?? r[2] ?? '').trim() : '';
    };
    const title = get('title'); if (!title) continue;
    const link  = get('link') || raw.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || '';
    const thumb = raw.match(/media:thumbnail[^>]+url="([^"]+)"/)?.[1]
               || raw.match(/enclosure[^>]+url="([^"]+)"/)?.[1]
               || null;
    const pubDate = get('pubDate') || get('dc:date');
    // Google News wraps the real publisher in <source url="...">Publisher Name</source>
    const realSource = raw.match(/<source[^>]*>([^<]+)<\/source>/)?.[1]?.trim()
                    || sourceName
                    || 'News';
    items.push({
      id      : get('guid') || link,
      title,
      link,
      source  : realSource,
      pubDate : pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      excerpt : get('description').replace(/<[^>]+>/g, '').slice(0, 220),
      thumbnail: thumb,
      category: categorizeNews(title),
    });
  }
  return items;
}

function categorizeNews(title) {
  if (!title) return 'MARKETS';
  const t = title.toLowerCase();
  if (/\bipo\b|listing|subscribe|allot|gmp/.test(t))                                         return 'IPO';
  if (/rbi|repo|inflation|gdp|economy|rupee|forex|rate cut|rate hike|monetary|budget/.test(t)) return 'ECONOMY';
  if (/fed\b|federal reserve|wall street|nasdaq|dow|nikkei|hang seng|ftse|global|us market|china|europe/.test(t)) return 'GLOBAL';
  if (/result|profit|revenue|earnings|q[1-4]\b|quarterly|ebitda/.test(t))                    return 'RESULTS';
  if (/crude|oil\b|gold|silver|commodity|brent|opec/.test(t))                                return 'COMMODITY';
  return 'MARKETS';
}

// ── GET /api/geodata?src=india-claimed ───────────────────────
// Proxies authoritative GeoJSON so the browser avoids CORS restrictions.
// Source: Datameet India composite (based on Survey of India official claim line).
// Fixes GeoJSON winding order server-side so d3.geoPath renders correctly.

const GEODATA_SOURCES = {
  // Full India boundary as per Government of Bhaarat / Survey of India:
  // includes J&K (PoK, Gilgit-Baltistan), Aksai Chin, Arunachal Pradesh in full.
  'india-claimed': 'https://raw.githubusercontent.com/datameet/maps/master/Country/india-composite.geojson',
};

// Shoelace signed area — positive = CCW (GeoJSON exterior ring spec)
function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++)
    area += ring[i][0] * ring[i+1][1] - ring[i+1][0] * ring[i][1];
  return area / 2;
}

function fixWindingOrder(geojson) {
  const fixPoly = coords => {
    // Exterior ring must be CCW (area > 0)
    if (signedArea(coords[0]) < 0) coords[0] = coords[0].slice().reverse();
    // Holes must be CW (area < 0)
    for (let i = 1; i < coords.length; i++)
      if (signedArea(coords[i]) > 0) coords[i] = coords[i].slice().reverse();
    return coords;
  };
  const fixFeature = f => {
    if (!f.geometry) return f;
    if (f.geometry.type === 'Polygon')
      f.geometry.coordinates = fixPoly(f.geometry.coordinates);
    if (f.geometry.type === 'MultiPolygon')
      f.geometry.coordinates = f.geometry.coordinates.map(fixPoly);
    return f;
  };
  if (geojson.type === 'FeatureCollection')
    geojson.features = geojson.features.map(fixFeature);
  else if (geojson.type === 'Feature')
    fixFeature(geojson);
  return geojson;
}

app.get('/api/geodata', async (req, res) => {
  const src = req.query.src;
  const url = GEODATA_SOURCES[src];
  if (!url) return res.status(400).json({ error: `Unknown src '${src}'` });

  const cacheKey = 'geo:' + src;
  const cached = getCache(cacheKey, 24 * 60 * 60_000); // 24-hour cache
  if (cached) return res.json(cached);

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Upstream HTTP ${r.status} from ${url}`);
    const raw = await r.json();
    const fixed = fixWindingOrder(raw);
    setCache(cacheKey, fixed);
    console.log(`[geodata] fetched & cached: ${src} (${JSON.stringify(fixed).length} bytes)`);
    res.json(fixed);
  } catch (err) {
    console.error('[geodata]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/status ──────────────────────────────────────────
// Health-check — shows which data sources are live.
app.get('/api/status', async (req, res) => {
  const status = schwabStatus();
  let yahooOk = false;
  try {
    await yahooFinance.quote(['^GSPC'], { fields:['regularMarketPrice'] });
    yahooOk = true;
  } catch {}
  res.json({
    schwab: { ...status },
    yahoo : { ready: yahooOk },
    time  : new Date().toISOString(),
  });
});

// ── GET /api/test ────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  try {
    const results = await fetchQuotes(['^GSPC', '^NSEI', '^BSESN']);
    res.json({ status:'live', quotes: results.map(q=>({
      symbol: q.symbol,
      price : q.regularMarketPrice,
      change: `${q.regularMarketChangePercent?.toFixed(2)}%`,
      source: isSchwabSupported(q.symbol) && schwabAvailable ? 'schwab' : 'yahoo',
    }))});
  } catch (err) {
    res.status(500).json({ status:'error', detail: err.message });
  }
});

// ── GET /api/charttest ───────────────────────────────────────
app.get('/api/charttest', async (req, res) => {
  try {
    const sym = req.query.sym || 'AAPL';
    const bars = await schwabPriceHistory(sym, { period:'1d', interval:'5m' });
    res.json({ sym, source:'schwab', total_bars:bars.length, first_5:bars.slice(0,5) });
  } catch (err) {
    // Fall back to Nifty via Yahoo for sanity check
    try {
      const bars = await yahooChart('^NSEI','1d','5m',null,null,false);
      res.json({ sym:'^NSEI', source:'yahoo', total_bars:bars.length, first_5:bars.slice(0,5) });
    } catch (e) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Serve stock detail page ──────────────────────────────────
app.get('/stock/:sym', (req, res) =>
  res.sendFile(path.join(__dirname, 'stock.html'))
);

// ── GET /api/stock/:sym/summary ──────────────────────────────
// Price + company profile + key stats. 5-minute cache.
// Strategy: quote() first (no field restriction = most reliable),
// then quoteSummary() per-module with validateResult:false so one
// bad module never kills the entire response.
app.get('/api/stock/:sym/summary', async (req, res) => {
  const sym = decodeURIComponent(req.params.sym);
  const key = `stock-summary:${sym}`;
  const cached = getCache(key, 5 * 60_000);
  if (cached) return res.json(cached);
  try {
    // Full quote — no fields filter so we get trailingPE, eps, beta, etc.
    const quote = await yahooFinance.quote(sym, {}, { validateResult: false });

    // Helper: fetch one quoteSummary module without throwing
    const safeModule = async (mod) => {
      try {
        const r = await yahooFinance.quoteSummary(sym, { modules: [mod] }, { validateResult: false });
        return r[mod] || null;
      } catch { return null; }
    };

    // Fetch profile modules independently — a missing one won't break the rest
    const [profile, summaryDetail, stats, financial] = await Promise.all([
      safeModule('assetProfile'),
      safeModule('summaryDetail'),
      safeModule('defaultKeyStatistics'),
      safeModule('financialData'),
    ]);

    // Normalise regularMarketTime — yahoo-finance2 returns a Date object
    if (quote.regularMarketTime instanceof Date) {
      quote.regularMarketTime = Math.floor(quote.regularMarketTime.getTime() / 1000);
    }

    const data = { quote, profile, summaryDetail, stats, financial };
    setCache(key, data);
    res.json(data);
  } catch (err) {
    console.error('[stock-summary]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/stock/:sym/financials ───────────────────────────
// Income / Balance / Cash-Flow statements + earnings. 30-minute cache.
// Fetch each statement type independently so one failure doesn't wipe all data.
app.get('/api/stock/:sym/financials', async (req, res) => {
  const sym = decodeURIComponent(req.params.sym);
  const key = `stock-fin:${sym}`;
  const cached = getCache(key, 30 * 60_000);
  if (cached) return res.json(cached);

  const safeModule = async (mod) => {
    try {
      const r = await yahooFinance.quoteSummary(sym, { modules: [mod] }, { validateResult: false });
      return { [mod]: r[mod] || null };
    } catch { return { [mod]: null }; }
  };

  try {
    const modules = [
      'incomeStatementHistory',
      'incomeStatementHistoryQuarterly',
      'balanceSheetHistory',
      'balanceSheetHistoryQuarterly',
      'cashflowStatementHistory',
      'cashflowStatementHistoryQuarterly',
      'earningsHistory',
    ];
    const results = await Promise.all(modules.map(safeModule));
    const data = Object.assign({}, ...results);
    setCache(key, data);
    res.json(data);
  } catch (err) {
    console.error('[stock-financials]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// India Full Stock List  (NSE + BSE)
// Loaded at startup by fetchNSEList() + fetchBSEList().
// Served via /api/markets/india/stocks (paginated).
// Prices fetched on-demand via /api/markets/india/prices.
// ══════════════════════════════════════════════════════════════

let INDIA_STOCKS = []; // { sym, shortSym, name, isin, exchange, sector }

function extractCookies(response) {
  try {
    const arr = response.headers.getSetCookie?.() || [];
    if (arr.length) return arr.map(c => c.split(';')[0]).join('; ');
  } catch {}
  return (response.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0]).join('; ');
}

async function fetchNSEList() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
  // Establish NSE session (get cookies)
  const homeRes = await fetch('https://www.nseindia.com', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(12_000),
    redirect: 'follow',
  });
  const cookies = extractCookies(homeRes);
  await new Promise(r => setTimeout(r, 1200)); // brief pause — NSE rate-limits

  const csvRes = await fetch('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.nseindia.com/',
      'Accept': 'text/csv,text/plain,*/*',
      'Cookie': cookies,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!csvRes.ok) throw new Error(`NSE CSV HTTP ${csvRes.status}`);
  const text = await csvRes.text();

  // CSV columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
  const stocks = [];
  for (const line of text.split('\n').slice(1)) {
    const p = line.split(',');
    if (p.length < 7) continue;
    const sym = p[0].trim();
    const name = p[1].trim().replace(/^"|"$/g, '');
    const isin = p[6].trim();
    if (!sym || !name || sym === 'SYMBOL') continue;
    stocks.push({ sym: sym + '.NS', shortSym: sym, name, isin, exchange: 'NSE', sector: '' });
  }
  return stocks;
}

async function fetchBSEList() {
  const res = await fetch(
    'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Type=0&Scode=',
    {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!res.ok) throw new Error(`BSE API HTTP ${res.status}`);
  const data = await res.json();
  return (data.Table || [])
    .map(s => ({
      sym      : String(s.SCRIP_CD).trim() + '.BO',
      shortSym : String(s.SCRIP_CD).trim(),
      name     : (s.LONG_NAME || s.SHORT_NAME || '').trim(),
      isin     : (s.ISIN_NO || '').trim(),
      exchange : 'BSE',
      sector   : (s.INDUSTRY || '').trim(),
    }))
    .filter(s => s.name && s.shortSym);
}

async function loadIndiaStocks() {
  console.log('[india-stocks] Starting load…');
  let nse = [], bse = [];

  try { nse = await fetchNSEList(); console.log(`[india-stocks] NSE: ${nse.length} stocks`); }
  catch (e) { console.warn('[india-stocks] NSE fetch failed:', e.message); }

  try { bse = await fetchBSEList(); console.log(`[india-stocks] BSE: ${bse.length} stocks`); }
  catch (e) { console.warn('[india-stocks] BSE fetch failed:', e.message); }

  // Merge: add BSE stocks not already present on NSE (dedup by ISIN)
  const nseIsins = new Set(nse.map(s => s.isin).filter(Boolean));
  const bseOnly  = bse.filter(s => !s.isin || !nseIsins.has(s.isin));

  INDIA_STOCKS = [...nse, ...bseOnly];
  INDIA_STOCKS.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[india-stocks] Total loaded: ${INDIA_STOCKS.length}`);
}

// ── GET /api/markets/india/stocks ────────────────────────────
// Paginated, filterable list of all NSE+BSE stocks.
// Query params: page (default 1), limit (default 50, max 100),
//               search, exchange (NSE|BSE), sector
app.get('/api/markets/india/stocks', (req, res) => {
  const { page = '1', limit = '50', search = '', exchange = '', sector = '' } = req.query;

  let list = INDIA_STOCKS;
  if (exchange) list = list.filter(s => s.exchange === exchange.toUpperCase());
  if (sector)   list = list.filter(s => s.sector?.toLowerCase().includes(sector.toLowerCase()));
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.shortSym.toLowerCase().includes(q) ||
      (s.isin && s.isin.toLowerCase() === q)
    );
  }

  const total   = list.length;
  const pageNum = Math.max(1, parseInt(page)  || 1);
  const pgSize  = Math.min(100, Math.max(10, parseInt(limit) || 50));
  const offset  = (pageNum - 1) * pgSize;

  // Collect unique sectors for filter dropdown
  const sectors = [...new Set(INDIA_STOCKS.map(s => s.sector).filter(Boolean))].sort();

  res.json({
    stocks : list.slice(offset, offset + pgSize),
    total,
    page   : pageNum,
    pages  : Math.ceil(total / pgSize) || 1,
    loaded : INDIA_STOCKS.length > 0,
    sectors,
  });
});

// ── GET /api/markets/india/prices?syms=SYM1.NS,SYM2.NS,… ────
// Batch price fetch for up to 100 symbols. 5-minute cache.
app.get('/api/markets/india/prices', async (req, res) => {
  const syms = (req.query.syms || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  if (!syms.length) return res.status(400).json({ error: 'syms required' });

  const cacheKey = 'india-prices:' + syms.slice().sort().join(',');
  const cached   = getCache(cacheKey, 5 * 60_000);
  if (cached) return res.json(cached);

  try {
    const raw  = await yahooFinance.quote(syms, {
      fields: ['regularMarketPrice','regularMarketChangePercent','regularMarketChange',
               'regularMarketVolume','marketCap','symbol'],
    }, { validateResult: false });

    const quotes = Array.isArray(raw) ? raw : [raw];
    const result = {};
    for (const q of quotes) {
      if (!q?.symbol) continue;
      result[q.symbol] = {
        price  : q.regularMarketPrice,
        pct    : q.regularMarketChangePercent,
        chg    : q.regularMarketChange,
        vol    : q.regularMarketVolume,
        mktCap : q.marketCap,
      };
    }
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[india-prices]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   ārthink. is running                     ║
  ║   → http://localhost:${PORT}                 ║
  ║   → /api/status   to check data sources   ║
  ║   → /api/test     to verify live quotes   ║
  ╚═══════════════════════════════════════════╝
  `);
  // Load India stock list in the background — don't block startup
  loadIndiaStocks().catch(e => console.error('[india-stocks] load error:', e.message));
  // Refresh every 24 hours
  setInterval(() => {
    loadIndiaStocks().catch(e => console.error('[india-stocks] refresh error:', e.message));
  }, 24 * 60 * 60_000);
});
