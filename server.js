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
import { readFileSync }  from 'fs';
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
  }, { validateResult: false });
  return Array.isArray(raw) ? raw : [raw];
}

// Global safety net — log unhandled rejections instead of crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

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

    // 1D intraday returns 0 bars when the market is closed (weekends/holidays).
    // Auto-fall back to 5D (15m bars) so the chart always shows something.
    if (!ohlc.length && period === '1d' && !isCustom) {
      console.log(`[chart] ${sym} 1d empty (market closed?) — falling back to 5d`);
      ohlc = await yahooChart(sym, '5d', '15m', null, null, false);
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
  const chart = await yahooFinance.chart(
    sym,
    { period1, period2, interval },
    { validateResult: false }
  );
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
      const chart = await yahooFinance.chart(
        sym,
        { period1, period2, interval: '1d' },
        { validateResult: false }
      );
      const closes = (chart?.quotes ?? [])
        .filter(b => b.close != null)
        .map(b => b.close)
        .slice(-20);
      if (closes.length >= 2) results[sym] = closes;
    } catch (e) { console.warn('[sparks]', sym, e.message); }
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
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',          src: 'NYT'               },
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

// Local bundled geodata files (committed to repo — no external fetch needed)
const GEODATA_LOCAL = {
  'india-claimed': path.join(__dirname, 'geodata', 'india-claimed.geojson'),
};
// Remote fallback if local file is missing (e.g. fresh clone without geodata/)
const GEODATA_REMOTE = {
  'india-claimed': 'https://cdn.jsdelivr.net/gh/datameet/maps@master/Country/india-composite.geojson',
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
  if (!GEODATA_LOCAL[src] && !GEODATA_REMOTE[src])
    return res.status(400).json({ error: `Unknown src '${src}'` });

  const cacheKey = 'geo:' + src;
  const cached = getCache(cacheKey, 24 * 60 * 60_000); // 24-hour in-memory cache
  if (cached) return res.json(cached);

  // ── 1. Try local bundled file (instant, no network) ──────────
  try {
    const raw  = JSON.parse(readFileSync(GEODATA_LOCAL[src], 'utf8'));
    const fixed = fixWindingOrder(raw);
    setCache(cacheKey, fixed);
    console.log(`[geodata] served from local file: ${src}`);
    return res.json(fixed);
  } catch (localErr) {
    console.warn(`[geodata] local file missing for '${src}', falling back to remote:`, localErr.message);
  }

  // ── 2. Fallback: fetch from jsDelivr CDN ─────────────────────
  const url = GEODATA_REMOTE[src];
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    const raw  = await r.json();
    const fixed = fixWindingOrder(raw);
    setCache(cacheKey, fixed);
    console.log(`[geodata] fetched & cached from remote: ${src}`);
    res.json(fixed);
  } catch (err) {
    console.error('[geodata] remote fetch failed:', err.message);
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

// ── Serve index detail page ──────────────────────────────────
app.get('/index/:sym', (req, res) =>
  res.sendFile(path.join(__dirname, 'index-detail.html'))
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
// India Full Stock List  (NSE — ~700 major symbols)
// Strategy: static seed list of known NSE tickers → batch
// yahoo-finance2 quote() calls at startup (~5-10 seconds total).
// Much faster and more reliable than screener pagination.
// Served via /api/markets/india/stocks (paginated, searchable).
// Prices fetched on-demand via /api/markets/india/prices.
// ══════════════════════════════════════════════════════════════

let INDIA_STOCKS = []; // { sym, shortSym, name, isin, exchange, sector }

const delay = ms => new Promise(r => setTimeout(r, ms));

// ~700 major NSE tickers (append .NS for Yahoo Finance).
// Covers Nifty 50, Next 50, Midcap 150, Smallcap 250, and other
// well-known names across all sectors.
const NSE_SEED = [
  // ── Nifty 50 ──────────────────────────────────────────────
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','ITC',
  'SBIN','BHARTIARTL','KOTAKBANK','LT','AXISBANK','MARUTI','ASIANPAINT',
  'HCLTECH','BAJFINANCE','SUNPHARMA','TITAN','BAJAJFINSV','WIPRO',
  'ULTRACEMCO','ONGC','NESTLEIND','POWERGRID','TECHM','NTPC',
  'INDUSINDBK','TATAMOTORS','GRASIM','JSWSTEEL','ADANIENT','TATASTEEL',
  'ADANIPORTS','HINDALCO','COALINDIA','DIVISLAB','DRREDDY','CIPLA',
  'APOLLOHOSP','EICHERMOT','HEROMOTOCO','BPCL','BRITANNIA','SBILIFE',
  'BAJAJ-AUTO','M&M','HDFCLIFE','SHREECEM','TATACONSUM','UPL',
  // ── Nifty Next 50 ─────────────────────────────────────────
  'ADANIGREEN','SIEMENS','ABB','HAVELLS','PIDILITIND','MARICO',
  'BERGEPAINT','PAGEIND','TORNTPHARM','MUTHOOTFIN','LICHSGFIN','PNB',
  'BANKBARODA','CANBK','UNIONBANK','INDIGO','IRCTC','DMART','JUBLFOOD',
  'NYKAA','ZOMATO','POLICYBZR','LICI','ADANITRANS','ADANIPOWER',
  'ATGL','LTIM','LTTS','MPHASIS','PERSISTENT','COFORGE','OFSS','KPIT',
  'TATACOMM','TATACHEM','GODREJCP','GODREJPROP','OBEROIRLTY',
  'PRESTIGE','DLF','PHOENIXLTD',
  // ── IT & Technology ───────────────────────────────────────
  'TATAELXSI','MASTEK','ZENSAR','BSOFT','RATEGAIN','HAPPSTMNDS',
  'NIIT','MPHASIS','CYIENT','INTELLECT','KFINTECH','CDSL','BSE',
  'NSDL','TANLA','LATENTVIEW','DATAMATICS','EMUDHRA','ROUTE',
  // ── Banks ─────────────────────────────────────────────────
  'FEDERALBNK','IDFCFIRSTB','KARURVYSYA','SOUTHBANK','RBLBANK',
  'YESBANK','BANDHANBNK','AUBANK','EQUITASBNK','UJJIVANSFB',
  'IOB','MAHABANK','CENTRALBANK','INDIANB','UCO','ESAFSFB',
  // ── NBFCs & Finance ───────────────────────────────────────
  'CHOLAFIN','MANAPPURAM','BAJAJHLDNG','SBICARD','ICICIPRULI',
  'HDFCAMC','NIACL','GICRE','ABCAPITAL','M&MFIN','PNBHOUSING',
  'CANFINHOME','SUNDARMFIN','MOTILALOFS','ANGELONE','5PAISA',
  'IIFL','MOFSL','GEOJITFSL','EDELWEISS',
  // ── Insurance ─────────────────────────────────────────────
  'MAXHEALTH','STARHEALTH','HDFCLIFE','SBILIFE','ICICIPRULI',
  'GICRE','NIACL','GODIGIT',
  // ── Auto & Auto Ancillaries ───────────────────────────────
  'TVSMOTOR','ASHOKLEY','MOTHERSON','BOSCHLTD','BHARATFORG','MRF',
  'APOLLOTYRE','CEATLTD','BALKRISIND','EXIDEIND','AMARARAJA',
  'TIINDIA','SUPRAJIT','ENDURANCE','WABCOINDIA','GABRIEL',
  'LUMAXIND','SBCL','CRAFTSMAN',
  // ── Pharma & Healthcare ───────────────────────────────────
  'BIOCON','FORTIS','AUROPHARMA','LUPIN','ALKEM','GLENMARK',
  'IPCA','PFIZER','ABBOTINDIA','GLAXO','SANOFI','NATCOPHARM',
  'AJANTPHARM','GRANULES','LALPATHLAB','METROPOLIS','THYROCARE',
  'MAXHEALTH','NARAYANAMRN','MEDANTA','YATHARTH','JBCHEPHARM',
  'SOLARA','MARKSANS','LAURUSLABS','SEQUENT','CONCORD',
  // ── FMCG ──────────────────────────────────────────────────
  'COLPAL','DABUR','EMAMILTD','RADICO','UBL','VARUNBEV',
  'MCDOWELL-N','JYOTHYLAB','ZYDUSWELL','GILLETTE','HONASA',
  'BIKAJI','BECTORFOOD','HATSUN','HERITAGE','KRBL',
  // ── Cement & Building Materials ───────────────────────────
  'AMBUJACEM','ACC','JKCEMENT','RAMCOCEM','DALMIACEMBE',
  'HEIDELBERG','BIRLACARBON','NUVOCO','JTLIND','PRISM','SANGHI',
  'ASTRAL','SUPREMEIND','FINOLEX','CERA','SOMANYCER',
  // ── Metals & Mining ───────────────────────────────────────
  'VEDL','NMDC','MOIL','SAIL','NATIONALUM','APLAPOLLO','JSPL',
  'JINDALSAW','RATNAMANI','WELSPUN','APL','SANDUMA','HLEGLAS',
  'HFCL','TINPLATE','KALYANKJIL','GOLDIAM',
  // ── Energy & Power ────────────────────────────────────────
  'TATAPOWER','CESC','TORNTPOWER','JPPOWER','NHPC','SJVN','IREDA',
  'IOC','GAIL','PETRONET','IGL','MGL','AEGISCHEM','GUJGASLTD',
  'INOXGREEN','ORIENTGREEN','GREENPANEL',
  // ── Real Estate & Infrastructure ──────────────────────────
  'MAHLIFE','BRIGADE','KOLTEPATIL','SOBHA','LODHA','IRCON','NBCC',
  'RITES','NCC','KNR','AHLUCONT','CAPACITE','PSP','HGINFRA',
  'PNCINFRA','WELCORP',
  // ── Capital Goods & Engineering ───────────────────────────
  'HAL','BEL','COCHINSHIP','GRINDWELL','CUMMINS','APAR','KEI',
  'POLYCAB','CROMPTON','VOLTAS','BLUESTAR','BHEL','GARDENREACH',
  'MAZAGONDOCK','MIDHANI','DATAVOLT','SKIPPER','KALPATPOWR',
  'THERMAX','ELGIEQUIP','KENNAMETAL','TIMKEN','SKF',
  // ── Consumer Discretionary ────────────────────────────────
  'TITAN','JUBLFOOD','DMART','BATA','RELAXO','DEVYANI','WESTLIFE',
  'TRENT','VMART','RAYMOND','MANYAVAR','VEDANT','SAPPHIREFDS',
  'SHOPERSTOP','PVRINOX','INOXLEISUR','WONDERLA',
  // ── Logistics & Transportation ────────────────────────────
  'BLUEDART','CONCOR','VRL','MAHLOG','GESHIP','SCI',
  'DELHIVERY','XPRESSBEES','ALLCARGO','MPSLTD','TCI',
  // ── Telecom & Media ───────────────────────────────────────
  'INDIAMART','INFOEDGE','JUSTDIAL','RAILTEL','STLTECH',
  'TVSUPPLY','NETWEB','ZENTEC','CYBERMEDINDL',
  // ── Chemicals & Specialty ─────────────────────────────────
  'DEEPAKNTR','SUDARSCHEM','NAVINFLUOR','GNFC','VINATIORGA',
  'AARTIIND','GALAXYSURF','TATACHEM','BASF','VINATI',
  'ALKYLAMINE','ANUPAMR','CLEAN','FINEORG','ROSSARI',
  'DHARAMSI','CAMLIN','NOCIL','PCBL',
  // ── New Age / Tech ────────────────────────────────────────
  'PAYTM','CARTRADE','MAPMYINDIA','EASEMYTRIP','NAUKRI',
  'JUSTDIAL','POLICYBZR','NYKAA','ZOMATO','SWIGGY',
  // ── Railways & Defense ────────────────────────────────────
  'IRFC','RVNL','IRCON','RAILTEL','IRCTC','HAL','BEL',
  'BEML','GRSE','MDL','DPSCG','COCHINSHIP',
  // ── Textiles ──────────────────────────────────────────────
  'RAYMOND','TRIDENT','VARDHMAN','RUPA','KITEX','SIYARAM',
  'ARVIND','WELSPUN','SUTLEJTEX','GOKEX',
  // ── Agricultural & Fertilizers ────────────────────────────
  'UPL','COROMANDEL','PIIND','CHAMBAL','NFL','GNFC',
  'IFFCO TOKIO','ZUARIIND','KSCL','RALLIS',
  // ── PSU Misc ──────────────────────────────────────────────
  'ONGC','BPCL','IOC','GAIL','COALINDIA','POWERGRID','NTPC',
  'NHPC','SJVN','IREDA','RECLTD','PFC','HUDCO',
  // ── Diversified Conglomerates ─────────────────────────────
  'ADANIENT','TATAMOTORS','M&M','GODREJIND','DCMSHRIRAM',
  'MAHINDCIE','BAJAJHLDNG','TATAELXSI',
];

// Phase 1 — instant: seed the list from NSE_SEED so the table is
// always available (zero loading spinner). Symbols with spaces or
// invalid chars are filtered out here.
function seedIndiaStocks() {
  const valid = NSE_SEED.filter(s => s && !/\s/.test(s));
  INDIA_STOCKS = valid.map(s => ({
    sym     : s + '.NS',
    shortSym: s,
    name    : s,       // overwritten by enrichment
    isin    : '',
    exchange: 'NSE',
    sector  : '',      // overwritten by enrichment
  }));
  INDIA_STOCKS.sort((a, b) => a.shortSym.localeCompare(b.shortSym));
  console.log(`[india-stocks] Seeded ${INDIA_STOCKS.length} symbols instantly`);
}

// Phase 2 — background: enrich with real names & sectors from Yahoo.
// Removes symbols that return no price (delisted / invalid).
async function enrichIndiaStocks() {
  const syms      = INDIA_STOCKS.map(s => s.sym);
  const batchSize = 50;
  console.log(`[india-stocks] Enriching ${syms.length} symbols…`);

  for (let i = 0; i < syms.length; i += batchSize) {
    const batch = syms.slice(i, i + batchSize);
    try {
      const raw = await yahooFinance.quote(
        batch,
        { fields: ['symbol','longname','shortname','sector','regularMarketPrice'] },
        { validateResult: false }
      );
      const quotes = Array.isArray(raw) ? raw : [raw];
      for (const q of quotes) {
        if (!q?.symbol) continue;
        const idx = INDIA_STOCKS.findIndex(s => s.sym === q.symbol);
        if (idx === -1) continue;
        if (q.regularMarketPrice == null) {
          // Delisted or invalid — remove
          INDIA_STOCKS.splice(idx, 1);
          continue;
        }
        INDIA_STOCKS[idx].name   = (q.longname || q.shortname || INDIA_STOCKS[idx].shortSym).trim();
        INDIA_STOCKS[idx].sector = (q.sector || '').trim();
      }
    } catch (e) {
      console.warn(`[india-stocks] enrich batch ${i}–${i + batchSize}:`, e.message);
    }
    if (i + batchSize < syms.length) await delay(200);
  }

  INDIA_STOCKS.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[india-stocks] Enriched — ${INDIA_STOCKS.length} valid stocks`);
}

async function loadIndiaStocks() {
  seedIndiaStocks();          // synchronous — stocks available immediately
  await enrichIndiaStocks();  // async background — fills names & sectors
}

// ── GET /api/markets/india/stocks ────────────────────────────
// Paginated, filterable list of all NSE+BSE stocks.
// Query params: page (default 1), limit (default 50, max 100),
//               search, exchange (NSE|BSE), sector
// `loading: true` means the screener is still running in the bg.
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

  const isLoading = INDIA_STOCKS.length === 0;
  res.json({
    stocks  : list.slice(offset, offset + pgSize),
    total,
    page    : pageNum,
    pages   : Math.ceil(total / pgSize) || 1,
    loaded  : !isLoading,
    loading : isLoading,
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
