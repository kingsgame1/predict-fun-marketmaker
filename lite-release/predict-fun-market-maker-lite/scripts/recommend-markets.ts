import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import axios from 'axios';
import { PredictAPI } from '../src/api/client.js';
import { PolymarketAPI } from '../src/api/polymarket-client.js';
import { MarketSelector } from '../src/market-selector.js';
import type { Market, Orderbook, OrderbookEntry } from '../src/types.js';

interface Args {
  venue: 'predict' | 'polymarket';
  top: number;
  scan: number;
  apply: boolean;
  json: boolean;
  envPath: string;
}

interface EnvMap extends Map<string, string> {}

interface RecentRiskPenalty {
  penalty: number;
  reason: string;
  cooldownRemainingMs?: number;
  cooldownReason?: string;
  fillPenaltyBps?: number;
  riskThrottleFactor?: number;
  cancelRate?: number;
  avgCancelLifetimeMs?: number;
  avgFillLifetimeMs?: number;
  cancelPenalty?: number;
  lifetimePenalty?: number;
  cancelNearTouch?: number;
  cancelRefresh?: number;
  cancelVwap?: number;
  cancelAggressive?: number;
  cancelUnsafe?: number;
}

interface HourRiskPenalty {
  penalty: number;
  reason: string;
  hour: number;
}

interface PatternMemoryPenalty {
  penalty: number;
  reason: string;
  dominance?: number;
  dominantReason?: string;
  ageMs?: number;
  ttlRemainingMs?: number;
  decayFactor?: number;
  reasonMix?: Record<string, number>;
  learnedRetreatMix?: Record<string, number>;
  learnedSizeMix?: Record<string, number>;
  learnedRetreat?: number;
  learnedSize?: number;
}

const RETRYABLE_NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);
const PREDICT_SAFE_MAX_SPREAD = 0.06;
const PREDICT_SAFE_MIN_L1_NOTIONAL = 25;
const PREDICT_SAFE_MIN_L2_NOTIONAL = 10;
const PREDICT_SAFE_MIN_PRICE = 0.08;
const PREDICT_SAFE_MAX_PRICE = 0.92;
const PREDICT_SAFE_MAX_LEVEL_GAP = 0.02;
const PREDICT_SAFE_MIN_L2_TO_L1_RATIO = 0.25;

interface PredictSafetyConfig {
  maxSpread: number;
  minL1Notional: number;
  minL2Notional: number;
  minPrice: number;
  maxPrice: number;
  maxLevelGap: number;
  minL2ToL1Ratio: number;
}

interface MakerQuality {
  supportRatio: number;
  levelGap: number;
  symmetry: number;
  centerScore: number;
  liquidityScore: number;
}

interface PolymarketIncentiveSummary {
  enabled: boolean;
  minSize: number | null;
  maxSpread: number | null;
  dailyRate: number | null;
  hourlyRate: number | null;
  fitScore: number | null;
  spreadFit: number | null;
  l1SizeFit: number | null;
  l2SizeFit: number | null;
  crowdingMultiple: number | null;
  capitalEstimateUsd: number | null;
  efficiency: number | null;
  netEfficiency: number | null;
  netDailyRate: number | null;
  effectiveNetEfficiency: number | null;
  effectiveNetDailyRate: number | null;
  estimatedCostBps: number | null;
  riskThrottleFactor: number | null;
  hourRiskFactor: number | null;
  queueHours: number | null;
  flowToQueuePerHour: number | null;
  targetQueueHours: number | null;
  targetQueueFactor: number | null;
  targetQueuePenalty: number | null;
  targetQueueReason: string | null;
  rewardDiagnostic: 'pass' | 'watch' | 'defend' | 'block';
  rewardDiagnosticReason: string | null;
  marketState: string | null;
  marketStateReason: string | null;
}

function slugifyQuestion(question: string): string {
  return String(question || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[$]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

interface MarketLinkResolution {
  url: string;
  label: '打开市场';
  source: 'direct' | 'slug' | 'cache' | 'search' | 'fallback';
}

interface MarketLinkCacheEntry {
  url: string;
  label: '打开市场';
  source: MarketLinkResolution['source'];
  expiresAt: number;
  updatedAt: number;
}

type MarketLinkCache = Record<string, MarketLinkCacheEntry>;

function buildMarketLink(venue: 'predict' | 'polymarket', market: Market): string {
  const explicit = String(market.market_url || '').trim();
  if (explicit && !explicit.includes('api.predict.fun') && !explicit.includes('gamma-api.polymarket.com') && !explicit.includes('clob.polymarket.com')) {
    return explicit;
  }

  const slug = String(market.market_slug || '').trim();
  if (slug) {
    return venue === 'predict'
      ? `https://predict.fun/market/${encodeURIComponent(slug)}?ref=B0CE6`
      : `https://polymarket.com/event/${encodeURIComponent(slug)}`;
  }

  if (venue === 'predict') {
    const derivedSlug = slugifyQuestion(String(market.question || ''));
    if (derivedSlug) {
      return `https://predict.fun/market/${encodeURIComponent(derivedSlug)}?ref=B0CE6`;
    }
  }
  if (venue === 'polymarket') {
    const derivedSlug = slugifyQuestion(String(market.question || ''));
    if (derivedSlug) {
      return `https://polymarket.com/event/${encodeURIComponent(derivedSlug)}`;
    }
  }
  return venue === 'predict' ? 'https://predict.fun' : 'https://polymarket.com';
}

function buildMarketLinkLabel(venue: 'predict' | 'polymarket', market: Market): string {
  const explicit = String(market.market_url || '').trim();
  const slug = String(market.market_slug || '').trim();
  if ((explicit && !explicit.includes('api.predict.fun') && !explicit.includes('gamma-api.polymarket.com') && !explicit.includes('clob.polymarket.com')) || slug) {
    return '打开市场';
  }
  if (venue === 'predict' && slugifyQuestion(String(market.question || ''))) {
    return '打开市场';
  }
  if (venue === 'polymarket' && slugifyQuestion(String(market.question || ''))) {
    return '打开市场';
  }
  return '打开市场';
}

function getMarketLinkCachePath(envPath: string): string {
  return path.join(path.dirname(envPath), 'market-link-cache.json');
}

function loadMarketLinkCache(cachePath: string): MarketLinkCache {
  try {
    if (!fs.existsSync(cachePath)) return {};
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as MarketLinkCache) : {};
  } catch {
    return {};
  }
}

function saveMarketLinkCache(cachePath: string, cache: MarketLinkCache): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function normalizeQuestion(question: string): string {
  return String(question || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMarketLinkCacheKey(venue: 'predict' | 'polymarket', market: Market): string {
  return [
    venue,
    market.event_id || '',
    market.condition_id || '',
    market.market_slug || '',
    normalizeQuestion(market.question || ''),
  ].join('|');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function unwrapSearchUrl(url: string): string {
  const text = decodeHtmlEntities(url);
  try {
    const parsed = new URL(text, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return text;
  }
}

function isValidDirectMarketUrl(venue: 'predict' | 'polymarket', url: string): boolean {
  try {
    const parsed = new URL(url);
    const expectedHost = venue === 'predict' ? 'predict.fun' : 'polymarket.com';
    const expectedPrefix = venue === 'predict' ? '/market/' : '/event/';
    const host = parsed.hostname.toLowerCase();
    return (host === expectedHost || host === `www.${expectedHost}`) && parsed.pathname.startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

async function searchDirectMarketUrl(
  venue: 'predict' | 'polymarket',
  market: Market
): Promise<string | null> {
  const site = venue === 'predict' ? 'predict.fun/market' : 'polymarket.com/event';
  const searchUrl = 'https://html.duckduckgo.com/html/';
  const query = `"${market.question || ''}" site:${site}`;
  try {
    const response = await httpGetWithRetry(searchUrl, {
      params: { q: query },
      timeout: 12000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      },
      transformResponse: [(data: unknown) => data],
    });
    const html = String(response.data || '');
    const hrefMatches = [...html.matchAll(/href=\"([^\"]+)\"/g)];
    for (const match of hrefMatches) {
      const candidate = unwrapSearchUrl(match[1] || '');
      if (isValidDirectMarketUrl(venue, candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveMarketLink(
  venue: 'predict' | 'polymarket',
  market: Market,
  cache: MarketLinkCache,
  cachePath: string
): Promise<MarketLinkResolution> {
  const cacheKey = buildMarketLinkCacheKey(venue, market);
  const now = Date.now();
  const cached = cache[cacheKey];
  if (cached && cached.expiresAt > now) {
    return { url: cached.url, label: cached.label, source: 'cache' };
  }

  const directUrl = buildMarketLink(venue, market);
  if (isValidDirectMarketUrl(venue, directUrl)) {
    cache[cacheKey] = {
      url: directUrl,
      label: '打开市场',
      source: market.market_slug ? 'slug' : 'direct',
      updatedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };
    saveMarketLinkCache(cachePath, cache);
    return { url: directUrl, label: '打开市场', source: market.market_slug ? 'slug' : 'direct' };
  }

  const searchedUrl = await searchDirectMarketUrl(venue, market);
  if (searchedUrl) {
    cache[cacheKey] = {
      url: searchedUrl,
      label: '打开市场',
      source: 'search',
      updatedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };
    saveMarketLinkCache(cachePath, cache);
    return { url: searchedUrl, label: '打开市场', source: 'search' };
  }

  const fallbackUrl = buildMarketLink(venue, market);
  cache[cacheKey] = {
    url: fallbackUrl,
    label: '打开市场',
    source: 'fallback',
    updatedAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };
  saveMarketLinkCache(cachePath, cache);
  return { url: fallbackUrl, label: '打开市场', source: 'fallback' };
}

async function hydratePredictMarketLink(api: PredictAPI, market: Market): Promise<Market> {
  if (market.market_url || market.market_slug || !market.event_id) {
    return market;
  }

  try {
    const detail = await api.getMarket(String(market.event_id));
    return {
      ...market,
      market_url: detail.market_url || market.market_url,
      market_slug: detail.market_slug || market.market_slug,
    };
  } catch {
    return market;
  }
}

function toFiniteNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sortByLiquidityAndVolume<T extends Partial<Market>>(
  items: T[],
  getLiquidity: (item: T) => number,
  getVolume: (item: T) => number
): T[] {
  const scoreItem = (item: T): number => {
    const liquidity = Math.log10(getLiquidity(item) + 1) * 4;
    const volume = Math.log10(getVolume(item) + 1) * 2.5;
    const rewardDaily = toFiniteNumber(item.polymarket_reward_daily_rate);
    const rewardMaxSpread = toFiniteNumber(item.polymarket_reward_max_spread);
    const rewardScore = item.polymarket_rewards_enabled
      ? 6 + Math.log10(rewardDaily + 1) * 5 + Math.min(3, rewardMaxSpread * 60)
      : 0;
    return liquidity + volume + rewardScore;
  };

  return [...items].sort((a, b) => scoreItem(b) - scoreItem(a));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function curlJson(url: string, params?: Record<string, unknown>): Promise<any> {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
  }
  const fullUrl = qs.toString() ? `${url}${url.includes('?') ? '&' : '?'}${qs.toString()}` : url;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('curl', ['-sS', '--max-time', '15', fullUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(out);
    });
  });
  return JSON.parse(stdout);
}

async function httpGetWithRetry(url: string, config: any, retries = 3): Promise<any> {
  let lastError: any = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await axios.get(url, config);
    } catch (error: any) {
      lastError = error;
      const code = String(error?.code || '');
      const retryable = RETRYABLE_NET_CODES.has(code);
      if (!retryable || i >= retries - 1) {
        const params = config?.params;
        if (RETRYABLE_NET_CODES.has(code)) {
          try {
            const data = await curlJson(url, params);
            return { data };
          } catch {
            // ignore curl fallback error and rethrow original error
          }
        }
        throw error;
      }
      await sleep(250 * (i + 1));
    }
  }
  throw lastError;
}

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  npx tsx scripts/recommend-markets.ts [--venue predict|polymarket] [--top 10] [--scan 60] [--apply] [--json] [--env .env]',
      '',
      'Examples:',
      '  npx tsx scripts/recommend-markets.ts --venue predict --top 12',
      '  npx tsx scripts/recommend-markets.ts --venue polymarket --apply',
    ].join('\n')
  );
}

function parseArgs(argv: string[]): Args {
  const defaults: Args = {
    venue: 'predict',
    top: 10,
    scan: 60,
    apply: false,
    json: false,
    envPath: path.resolve(process.cwd(), '.env'),
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    if (token === '--venue') {
      const value = (rest.shift() || '').toLowerCase();
      if (value !== 'predict' && value !== 'polymarket') {
        throw new Error('--venue must be "predict" or "polymarket"');
      }
      defaults.venue = value;
      continue;
    }
    if (token === '--top') {
      const value = Number(rest.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--top must be a positive number');
      }
      defaults.top = Math.floor(value);
      continue;
    }
    if (token === '--scan') {
      const value = Number(rest.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--scan must be a positive number');
      }
      defaults.scan = Math.floor(value);
      continue;
    }
    if (token === '--apply') {
      defaults.apply = true;
      continue;
    }
    if (token === '--json') {
      defaults.json = true;
      continue;
    }
    if (token === '--env') {
      const value = rest.shift();
      if (!value) throw new Error('--env requires a path');
      defaults.envPath = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return defaults;
}

function parseEnv(text: string): EnvMap {
  const map = new Map<string, string>();
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx < 0) return;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) map.set(key, value);
    });
  return map;
}

function upsertEnv(text: string, updates: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  const keyLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!keyLine.has(key)) keyLine.set(key, i);
  }
  for (const [key, value] of Object.entries(updates)) {
    const next = `${key}=${value}`;
    if (keyLine.has(key)) {
      lines[keyLine.get(key)!] = next;
    } else {
      lines.push(next);
    }
  }
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

function toArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((x) => String(x));
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function normalizeOrderbook(tokenId: string, raw: any): Orderbook {
  const payload = raw?.result || raw?.data || raw || {};
  const toLevels = (items: any[]): OrderbookEntry[] =>
    items
      .map((item) => ({
        price: String(item?.price ?? item?.[0] ?? 0),
        shares: String(item?.shares ?? item?.size ?? item?.[1] ?? 0),
      }))
      .filter((x) => Number(x.price) > 0 && Number(x.shares) > 0);

  const bids = toLevels(Array.isArray(payload?.bids) ? payload.bids : []).sort(
    (a, b) => Number(b.price) - Number(a.price)
  );
  const asks = toLevels(Array.isArray(payload?.asks) ? payload.asks : []).sort(
    (a, b) => Number(a.price) - Number(b.price)
  );
  const bestBid = bids.length > 0 ? Number(bids[0].price) : undefined;
  const bestAsk = asks.length > 0 ? Number(asks[0].price) : undefined;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
  const spreadPct =
    spread !== undefined && bestBid !== undefined && bestBid > 0 ? (spread / bestBid) * 100 : undefined;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;
  return {
    token_id: tokenId,
    bids,
    asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread,
    spread_pct: spreadPct,
    mid_price: mid,
  };
}

async function populateOrderbooksWithConcurrency(
  markets: Market[],
  concurrency: number,
  fetcher: (market: Market) => Promise<Orderbook>
): Promise<Map<string, Orderbook>> {
  const orderbooks = new Map<string, Orderbook>();
  const batchSize = Math.max(1, concurrency);

  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(async (market) => {
        const book = await fetcher(market);
        orderbooks.set(market.token_id, book);
        market.best_bid = book.best_bid;
        market.best_ask = book.best_ask;
        market.spread_pct = book.spread_pct;
        market.total_orders = (book.bids?.length || 0) + (book.asks?.length || 0);
      })
    );

    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`订单簿抓取失败 ${batch[index]?.token_id}:`, result.reason instanceof Error ? result.reason.message : result.reason);
      }
    });
  }

  return orderbooks;
}

async function loadPredictMarkets(env: EnvMap, scan: number): Promise<{ markets: Market[]; orderbooks: Map<string, Orderbook>; api: PredictAPI }> {
  const apiBaseUrl = env.get('API_BASE_URL') || 'https://api.predict.fun';
  const apiKey = env.get('API_KEY');
  const jwtToken = env.get('JWT_TOKEN') || undefined;
  if (!apiKey) {
    throw new Error('Predict venue requires API_KEY in .env');
  }
  const api = new PredictAPI(apiBaseUrl, apiKey, jwtToken);
  const allMarkets = await api.getMarkets();
  const rankedMarkets = sortByLiquidityAndVolume(
    allMarkets,
    (market) => toFiniteNumber(market.liquidity_24h),
    (market) => toFiniteNumber(market.volume_24h)
  );
  const selected = rankedMarkets.slice(0, Math.min(rankedMarkets.length, Math.max(scan * 4, 60)));
  const orderbooks = await populateOrderbooksWithConcurrency(selected, 4, async (market) =>
    api.getOrderbook(market.token_id)
  );
  console.error(`[Predict] 订单簿抓取成功: ${orderbooks.size}/${selected.length}`);
  return { markets: selected, orderbooks, api };
}

async function loadPolymarketMarkets(env: EnvMap, scan: number): Promise<{ markets: Market[]; orderbooks: Map<string, Orderbook>; api: PolymarketAPI }> {
  const api = new PolymarketAPI({
    gammaUrl: env.get('POLYMARKET_GAMMA_URL') || 'https://gamma-api.polymarket.com',
    clobUrl: env.get('POLYMARKET_CLOB_URL') || 'https://clob.polymarket.com',
    privateKey: env.get('POLYMARKET_PRIVATE_KEY') || env.get('PRIVATE_KEY') || '',
    chainId: Number(env.get('POLYMARKET_CHAIN_ID') || 137),
    maxMarkets: Number(env.get('POLYMARKET_MAX_MARKETS') || Math.max(scan * 4, 120)),
    feeBps: Number(env.get('POLYMARKET_FEE_BPS') || 0),
    apiKey: env.get('POLYMARKET_API_KEY') || undefined,
    apiSecret: env.get('POLYMARKET_API_SECRET') || undefined,
    apiPassphrase: env.get('POLYMARKET_API_PASSPHRASE') || undefined,
    autoDeriveApiKey: (env.get('POLYMARKET_AUTO_DERIVE_API_KEY') || 'true').toLowerCase() !== 'false',
    funderAddress: env.get('POLYMARKET_FUNDER_ADDRESS') || undefined,
    signatureType: Number(env.get('POLYMARKET_SIGNATURE_TYPE') || 0),
  });
  const allMarkets = await api.getMarkets();
  const eligibleMarkets = allMarkets.filter(
    (market) => market.polymarket_accepting_orders !== false && market.polymarket_enable_order_book !== false
  );
  const rankedMarkets = sortByLiquidityAndVolume(
    eligibleMarkets.length > 0 ? eligibleMarkets : allMarkets,
    (market) => toFiniteNumber(market.liquidity_24h),
    (market) => toFiniteNumber(market.volume_24h)
  );
  const selected = rankedMarkets.slice(0, Math.min(rankedMarkets.length, Math.max(scan * 4, 60)));
  const orderbooks = await populateOrderbooksWithConcurrency(selected, 5, async (market) => api.getOrderbook(market.token_id));
  return { markets: selected, orderbooks, api };
}

function readNumber(env: EnvMap, key: string, fallback: number): number {
  const value = Number(env.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function getPredictSafetyConfig(env: EnvMap): PredictSafetyConfig {
  return {
    maxSpread: readNumber(env, 'PREDICT_SAFE_MAX_SPREAD', PREDICT_SAFE_MAX_SPREAD),
    minL1Notional: readNumber(env, 'PREDICT_SAFE_MIN_L1_NOTIONAL', PREDICT_SAFE_MIN_L1_NOTIONAL),
    minL2Notional: readNumber(env, 'PREDICT_SAFE_MIN_L2_NOTIONAL', PREDICT_SAFE_MIN_L2_NOTIONAL),
    minPrice: readNumber(env, 'PREDICT_SAFE_MIN_PRICE', PREDICT_SAFE_MIN_PRICE),
    maxPrice: readNumber(env, 'PREDICT_SAFE_MAX_PRICE', PREDICT_SAFE_MAX_PRICE),
    maxLevelGap: readNumber(env, 'PREDICT_SAFE_MAX_LEVEL_GAP', PREDICT_SAFE_MAX_LEVEL_GAP),
    minL2ToL1Ratio: readNumber(env, 'PREDICT_SAFE_MIN_L2_TO_L1_RATIO', PREDICT_SAFE_MIN_L2_TO_L1_RATIO),
  };
}

function resolvePolymarketPatternMemoryPath(metricsPath: string, envPath: string): string {
  const resolvedMetricsPath = path.isAbsolute(metricsPath)
    ? metricsPath
    : path.resolve(path.dirname(envPath), metricsPath);
  const ext = path.extname(resolvedMetricsPath);
  if (ext) {
    return resolvedMetricsPath.slice(0, -ext.length) + ' .polymarket-pattern-memory.json'.trimStart();
  }
  return resolvedMetricsPath + ' .polymarket-pattern-memory.json'.trimStart();
}

function loadPolymarketPatternMemory(
  env: EnvMap,
  envPath: string,
  ttlMs: number,
  maxPenalty: number
): Map<string, PatternMemoryPenalty> {
  const penalties = new Map<string, PatternMemoryPenalty>();
  const metricsPath = env.get('MM_METRICS_PATH');
  if (!metricsPath) return penalties;
  try {
    const memoryPath = resolvePolymarketPatternMemoryPath(metricsPath, envPath);
    if (!fs.existsSync(memoryPath)) return penalties;
    const raw = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as {
      updatedAt?: number;
      markets?: Array<{
        tokenId?: string;
        updatedAt?: number;
        penalty?: number;
        dominance?: number;
        dominantReason?: string;
        reason?: string;
        reasonMix?: Record<string, number>;
        learnedRetreatMix?: Record<string, number>;
        learnedSizeMix?: Record<string, number>;
        learnedRetreat?: number;
        learnedSize?: number;
      }>;
    };
    const cutoff = Date.now() - ttlMs;
    for (const market of raw.markets || []) {
      const tokenId = String(market.tokenId || '');
      if (!tokenId) continue;
      const updatedAt = Number(market.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) continue;
      const penalty = Math.max(0, Math.min(maxPenalty, Number(market.penalty || 0)));
      if (!(penalty > 0)) continue;
      const remainingMs = Math.max(0, updatedAt + ttlMs - Date.now());
      const ageMs = Math.max(0, Date.now() - updatedAt);
      const decayFactor = ttlMs > 0 ? Math.max(0, Math.min(1, 1 - ageMs / ttlMs)) : 1;
      penalties.set(tokenId, {
        penalty,
        reason: String(market.reason || market.dominantReason || '长期撤单模式风险'),
        dominance: Number.isFinite(Number(market.dominance)) ? Number(market.dominance) : undefined,
        dominantReason: market.dominantReason ? String(market.dominantReason) : undefined,
        ageMs,
        ttlRemainingMs: remainingMs,
        decayFactor,
        reasonMix: market.reasonMix && typeof market.reasonMix === 'object' ? market.reasonMix : undefined,
        learnedRetreatMix:
          market.learnedRetreatMix && typeof market.learnedRetreatMix === 'object'
            ? market.learnedRetreatMix
            : undefined,
        learnedSizeMix:
          market.learnedSizeMix && typeof market.learnedSizeMix === 'object' ? market.learnedSizeMix : undefined,
        learnedRetreat: Number.isFinite(Number(market.learnedRetreat)) ? Number(market.learnedRetreat) : undefined,
        learnedSize: Number.isFinite(Number(market.learnedSize)) ? Number(market.learnedSize) : undefined,
      });
    }
  } catch {
    return penalties;
  }
  return penalties;
}

function getPolymarketSelectorOptions(env: EnvMap) {
  return {
    polymarketRewardMinFitScore: readNumber(env, 'POLYMARKET_REWARD_MIN_FIT_SCORE', 0.6),
    polymarketRewardMinDailyRate: readNumber(env, 'POLYMARKET_REWARD_MIN_DAILY_RATE', 0),
    polymarketRewardMinEfficiency: readNumber(env, 'POLYMARKET_REWARD_MIN_EFFICIENCY', 0.0015),
    polymarketRewardMinNetEfficiency: readNumber(env, 'POLYMARKET_REWARD_MIN_NET_EFFICIENCY', 0.0008),
    polymarketRewardNetCostBpsMultiplier: readNumber(env, 'POLYMARKET_REWARD_NET_COST_BPS_MULTIPLIER', 1),
    polymarketRewardRequireFit: env.get('POLYMARKET_REWARD_REQUIRE_FIT') !== 'false',
    polymarketRewardRequireEnabled: env.get('POLYMARKET_REWARD_REQUIRE_ENABLED') !== 'false',
    polymarketRewardMaxQueueMultiple: readNumber(env, 'POLYMARKET_REWARD_MAX_QUEUE_MULTIPLE', 12),
    polymarketRewardCrowdingPenaltyStart: readNumber(env, 'POLYMARKET_REWARD_CROWDING_PENALTY_START', 4),
    polymarketRewardCrowdingPenaltyMax: readNumber(env, 'POLYMARKET_REWARD_CROWDING_PENALTY_MAX', 12),
    polymarketRewardMinQueueHours: readNumber(env, 'POLYMARKET_REWARD_MIN_QUEUE_HOURS', 0.75),
    polymarketRewardFastFlowPenaltyMax: readNumber(env, 'POLYMARKET_REWARD_FAST_FLOW_PENALTY_MAX', 8),
    polymarketRewardTargetQueueHours: readNumber(env, 'POLYMARKET_REWARD_TARGET_QUEUE_HOURS', 1.5),
    polymarketRewardTargetQueueTolerance: readNumber(env, 'POLYMARKET_REWARD_TARGET_QUEUE_TOLERANCE', 0.5),
    polymarketRewardTargetPenaltyMax: readNumber(env, 'POLYMARKET_REWARD_TARGET_PENALTY_MAX', 6),
    polymarketRecentRiskBlockPenalty: readNumber(env, 'POLYMARKET_RECENT_RISK_BLOCK_PENALTY', 12),
    polymarketHourRiskBlockPenalty: readNumber(env, 'POLYMARKET_HOUR_RISK_BLOCK_PENALTY', 6),
    polymarketHourRiskSizeFactorMin: readNumber(env, 'POLYMARKET_HOUR_RISK_SIZE_FACTOR_MIN', 0.55),
    polymarketPatternMemoryMaxPenalty: readNumber(env, 'POLYMARKET_PATTERN_MEMORY_MAX_PENALTY', 8),
    polymarketPatternMemoryBlockPenalty: readNumber(env, 'POLYMARKET_PATTERN_MEMORY_BLOCK_PENALTY', 6),
    polymarketPatternMemoryTtlMs: readNumber(env, 'POLYMARKET_PATTERN_MEMORY_TTL_MS', 604800000),
  };
}

function loadRecentPolymarketRiskPenalty(
  env: EnvMap,
  envPath: string,
  lookbackMs: number = 6 * 60 * 60 * 1000,
  maxPenalty: number = 16
): Map<string, RecentRiskPenalty> {
  const penalties = new Map<string, RecentRiskPenalty>();
  const metricsPath = env.get('MM_METRICS_PATH');
  if (!metricsPath) {
    return penalties;
  }
  try {
    const resolved = path.isAbsolute(metricsPath)
      ? metricsPath
      : path.resolve(path.dirname(envPath), metricsPath);
    if (!fs.existsSync(resolved)) {
      return penalties;
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
      events?: Array<{ ts?: number; type?: string; tokenId?: string; message?: string }>;
      markets?: Array<{
        tokenId?: string;
        fillPenaltyBps?: number;
        riskThrottleFactor?: number;
        cancelRate?: number;
        avgCancelLifetimeMs?: number;
        avgFillLifetimeMs?: number;
        cancelPenalty?: number;
        lifetimePenalty?: number;
        cancelNearTouch?: number;
        cancelRefresh?: number;
        cancelVwap?: number;
        cancelAggressive?: number;
        cancelUnsafe?: number;
      }>;
    };
    const cutoff = Date.now() - lookbackMs;
    const scores = new Map<
      string,
      {
        penalty: number;
        adverse: number;
        postOnly: number;
        pauses: number;
        cooldownRemainingMs: number;
        cooldownReason: string;
        fillPenaltyBps: number;
        riskThrottleFactor: number;
      }
    >();
    const postOnlyPauseMs = readNumber(env, 'POLYMARKET_POST_ONLY_PAUSE_MS', 1800000);
    const rewardPauseMs = readNumber(env, 'POLYMARKET_REWARD_PAUSE_MS', 1800000);
    const adverseFillPauseMs = readNumber(env, 'POLYMARKET_ADVERSE_FILL_PAUSE_MS', 2700000);
    const positionLossPauseMs = readNumber(env, 'POLYMARKET_POSITION_LOSS_PAUSE_MS', 1800000);
    const getPauseDurationMs = (type: string, message: string): number => {
      if (type === 'POLYMARKET_POST_ONLY_FUSE' || message.includes('polymarket-post-only')) return postOnlyPauseMs;
      if (type === 'POLYMARKET_ADVERSE_FILL' || message.includes('polymarket-adverse-fill')) return adverseFillPauseMs;
      if (message.includes('polymarket-position-loss')) return positionLossPauseMs;
      if (message.includes('polymarket-reward-gate')) return rewardPauseMs;
      return 0;
    };
    for (const event of raw.events || []) {
      const tokenId = String(event.tokenId || '');
      if (!tokenId) continue;
      const ts = Number(event.ts || 0);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const type = String(event.type || '');
      const message = String(event.message || '');
      const entry = scores.get(tokenId) || {
        penalty: 0,
        adverse: 0,
        postOnly: 0,
        pauses: 0,
        cooldownRemainingMs: 0,
        cooldownReason: '',
        fillPenaltyBps: 0,
        riskThrottleFactor: 1,
        cancelRate: 0,
        avgCancelLifetimeMs: 0,
        avgFillLifetimeMs: 0,
        cancelPenalty: 0,
        lifetimePenalty: 0,
        cancelNearTouch: 0,
        cancelRefresh: 0,
        cancelVwap: 0,
        cancelAggressive: 0,
        cancelUnsafe: 0,
      };
      if (type === 'POLYMARKET_ADVERSE_FILL') {
        entry.penalty += 2;
        entry.adverse += 1;
      } else if (type === 'POLYMARKET_POST_ONLY_FUSE') {
        entry.penalty += 4;
        entry.postOnly += 1;
      } else if (type === 'MARKET_PAUSE' && message.includes('polymarket-')) {
        entry.penalty += 5;
        entry.pauses += 1;
      }
      const pauseDurationMs = getPauseDurationMs(type, message);
      if (pauseDurationMs > 0) {
        const remainingMs = Math.max(0, ts + pauseDurationMs - Date.now());
        if (remainingMs > entry.cooldownRemainingMs) {
          entry.cooldownRemainingMs = remainingMs;
          entry.cooldownReason = message || type;
        }
      }
      scores.set(tokenId, entry);
    }
    for (const metric of raw.markets || []) {
      const tokenId = String(metric.tokenId || '');
      if (!tokenId) continue;
      const entry = scores.get(tokenId) || {
        penalty: 0,
        adverse: 0,
        postOnly: 0,
        pauses: 0,
        cooldownRemainingMs: 0,
        cooldownReason: '',
        fillPenaltyBps: 0,
        riskThrottleFactor: 1,
        cancelRate: 0,
        avgCancelLifetimeMs: 0,
        avgFillLifetimeMs: 0,
        cancelPenalty: 0,
        lifetimePenalty: 0,
        cancelNearTouch: 0,
        cancelRefresh: 0,
        cancelVwap: 0,
        cancelAggressive: 0,
        cancelUnsafe: 0,
      };
      const fillPenaltyBps = Number(metric.fillPenaltyBps || 0);
      const riskThrottleFactor = Number(metric.riskThrottleFactor || 1);
      const cancelRate = Number(metric.cancelRate || 0);
      const avgCancelLifetimeMs = Number(metric.avgCancelLifetimeMs || 0);
      const avgFillLifetimeMs = Number(metric.avgFillLifetimeMs || 0);
      const derivedCancelPenalty = Number(metric.cancelPenalty || 0);
      const derivedLifetimePenalty = Number(metric.lifetimePenalty || 0);
      const cancelNearTouch = Number(metric.cancelNearTouch || 0);
      const cancelRefresh = Number(metric.cancelRefresh || 0);
      const cancelVwap = Number(metric.cancelVwap || 0);
      const cancelAggressive = Number(metric.cancelAggressive || 0);
      const cancelUnsafe = Number(metric.cancelUnsafe || 0);
      const cancelRatePenaltyStart = readNumber(env, 'POLYMARKET_CANCEL_RATE_PENALTY_START', 0.8);
      const cancelRatePenaltyMax = readNumber(env, 'POLYMARKET_CANCEL_RATE_PENALTY_MAX', 6);
      const minAvgOrderLifetimeMs = readNumber(env, 'POLYMARKET_MIN_AVG_ORDER_LIFETIME_MS', 120000);
      const shortLifetimePenaltyMax = readNumber(env, 'POLYMARKET_SHORT_LIFETIME_PENALTY_MAX', 5);
      if (Number.isFinite(fillPenaltyBps) && fillPenaltyBps > 0) {
        entry.penalty += Math.min(4, fillPenaltyBps / 6);
        entry.fillPenaltyBps = Math.max(entry.fillPenaltyBps, fillPenaltyBps);
      }
      if (Number.isFinite(riskThrottleFactor) && riskThrottleFactor > 0 && riskThrottleFactor < 1) {
        entry.penalty += Math.min(4, (1 - riskThrottleFactor) * 6);
        entry.riskThrottleFactor = Math.min(entry.riskThrottleFactor, riskThrottleFactor);
      }
      if (Number.isFinite(cancelRate) && cancelRate > 0) {
        const cancelPenalty =
          derivedCancelPenalty > 0
            ? derivedCancelPenalty
            : cancelRate <= cancelRatePenaltyStart
              ? 0
              : Math.min(
                  cancelRatePenaltyMax,
                  ((cancelRate - cancelRatePenaltyStart) / Math.max(0.01, 1 - cancelRatePenaltyStart)) *
                    cancelRatePenaltyMax
                );
        entry.penalty += cancelPenalty;
        entry.cancelRate = Math.max(entry.cancelRate, cancelRate);
        entry.cancelPenalty = Math.max(entry.cancelPenalty, cancelPenalty);
      }
      const totalCancelReasons = cancelNearTouch + cancelRefresh + cancelVwap + cancelAggressive + cancelUnsafe;
      if (Number.isFinite(totalCancelReasons) && totalCancelReasons >= 3) {
        const reasonPenalty =
          Math.min(4, (cancelNearTouch / totalCancelReasons) * 3.5) +
          Math.min(4, (cancelAggressive / totalCancelReasons) * 4) +
          Math.min(3, (cancelUnsafe / totalCancelReasons) * 2.5) +
          Math.min(2, (cancelVwap / totalCancelReasons) * 1.5) +
          Math.min(1.5, (cancelRefresh / totalCancelReasons) * 1);
        entry.penalty += reasonPenalty;
      }
      entry.cancelNearTouch = Math.max(entry.cancelNearTouch, cancelNearTouch);
      entry.cancelRefresh = Math.max(entry.cancelRefresh, cancelRefresh);
      entry.cancelVwap = Math.max(entry.cancelVwap, cancelVwap);
      entry.cancelAggressive = Math.max(entry.cancelAggressive, cancelAggressive);
      entry.cancelUnsafe = Math.max(entry.cancelUnsafe, cancelUnsafe);
      if (Number.isFinite(avgCancelLifetimeMs) && avgCancelLifetimeMs > 0) {
        entry.avgCancelLifetimeMs =
          entry.avgCancelLifetimeMs > 0 ? Math.min(entry.avgCancelLifetimeMs, avgCancelLifetimeMs) : avgCancelLifetimeMs;
      }
      if (Number.isFinite(avgFillLifetimeMs) && avgFillLifetimeMs > 0) {
        entry.avgFillLifetimeMs =
          entry.avgFillLifetimeMs > 0 ? Math.min(entry.avgFillLifetimeMs, avgFillLifetimeMs) : avgFillLifetimeMs;
      }
      const comparableLifetimeMs = avgCancelLifetimeMs > 0 ? avgCancelLifetimeMs : avgFillLifetimeMs;
      if (Number.isFinite(comparableLifetimeMs) && comparableLifetimeMs > 0) {
        const lifetimePenalty =
          derivedLifetimePenalty > 0
            ? derivedLifetimePenalty
            : Math.max(
                0,
                Math.min(
                  shortLifetimePenaltyMax,
                  ((minAvgOrderLifetimeMs - comparableLifetimeMs) / Math.max(1, minAvgOrderLifetimeMs)) *
                    shortLifetimePenaltyMax
                )
              );
        entry.penalty += lifetimePenalty;
        entry.lifetimePenalty = Math.max(entry.lifetimePenalty, lifetimePenalty);
      }
      scores.set(tokenId, entry);
    }
    for (const [tokenId, entry] of scores) {
      const penalty = Math.min(maxPenalty, entry.penalty);
      if (penalty <= 0) continue;
      const parts: string[] = [];
      if (entry.adverse > 0) parts.push(`不利成交${entry.adverse}次`);
      if (entry.postOnly > 0) parts.push(`postOnly熔断${entry.postOnly}次`);
      if (entry.pauses > 0) parts.push(`风控暂停${entry.pauses}次`);
      if (entry.cancelRate > 0) parts.push(`撤单率${(entry.cancelRate * 100).toFixed(0)}%`);
      if (entry.avgCancelLifetimeMs > 0) parts.push(`平均撤单寿命${Math.round(entry.avgCancelLifetimeMs / 1000)}s`);
      if (entry.cancelNearTouch > 0) parts.push(`近触撤单${entry.cancelNearTouch}次`);
      if (entry.cancelAggressive > 0) parts.push(`追价撤单${entry.cancelAggressive}次`);
      if (entry.cancelUnsafe > 0) parts.push(`风控撤单${entry.cancelUnsafe}次`);
      penalties.set(tokenId, {
        penalty,
        reason: `${parts.join(' / ') || '近期风险'} (-${penalty.toFixed(1)})`,
        cooldownRemainingMs: entry.cooldownRemainingMs > 0 ? entry.cooldownRemainingMs : undefined,
        cooldownReason: entry.cooldownReason || undefined,
        fillPenaltyBps: entry.fillPenaltyBps > 0 ? entry.fillPenaltyBps : undefined,
        riskThrottleFactor: entry.riskThrottleFactor > 0 && entry.riskThrottleFactor < 1 ? entry.riskThrottleFactor : undefined,
        cancelRate: entry.cancelRate > 0 ? entry.cancelRate : undefined,
        avgCancelLifetimeMs: entry.avgCancelLifetimeMs > 0 ? entry.avgCancelLifetimeMs : undefined,
        avgFillLifetimeMs: entry.avgFillLifetimeMs > 0 ? entry.avgFillLifetimeMs : undefined,
        cancelPenalty: entry.cancelPenalty > 0 ? entry.cancelPenalty : undefined,
        lifetimePenalty: entry.lifetimePenalty > 0 ? entry.lifetimePenalty : undefined,
        cancelNearTouch: entry.cancelNearTouch > 0 ? entry.cancelNearTouch : undefined,
        cancelRefresh: entry.cancelRefresh > 0 ? entry.cancelRefresh : undefined,
        cancelVwap: entry.cancelVwap > 0 ? entry.cancelVwap : undefined,
        cancelAggressive: entry.cancelAggressive > 0 ? entry.cancelAggressive : undefined,
        cancelUnsafe: entry.cancelUnsafe > 0 ? entry.cancelUnsafe : undefined,
      });
    }
  } catch (error) {
    console.error('[Polymarket] 读取近期风险记忆失败，已忽略:', error);
  }
  return penalties;
}

function loadPolymarketHourRiskPenalty(
  env: EnvMap,
  envPath: string,
  lookbackDays: number = 7,
  maxPenalty: number = 8
): HourRiskPenalty {
  const currentHour = new Date().getHours();
  const metricsPath = env.get('MM_METRICS_PATH');
  if (!metricsPath) {
    return { penalty: 0, reason: '', hour: currentHour };
  }
  try {
    const resolved = path.isAbsolute(metricsPath)
      ? metricsPath
      : path.resolve(path.dirname(envPath), metricsPath);
    if (!fs.existsSync(resolved)) {
      return { penalty: 0, reason: '', hour: currentHour };
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
      events?: Array<{ ts?: number; type?: string; message?: string }>;
    };
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    let penalty = 0;
    let adverse = 0;
    let postOnly = 0;
    let pauses = 0;
    for (const event of raw.events || []) {
      const ts = Number(event.ts || 0);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (new Date(ts).getHours() !== currentHour) continue;
      const type = String(event.type || '');
      const message = String(event.message || '');
      if (type === 'POLYMARKET_ADVERSE_FILL') {
        penalty += 1.5;
        adverse += 1;
      } else if (type === 'POLYMARKET_POST_ONLY_FUSE') {
        penalty += 2;
        postOnly += 1;
      } else if (type === 'MARKET_PAUSE' && message.includes('polymarket-')) {
        penalty += 1.25;
        pauses += 1;
      }
    }
    const bounded = Math.min(maxPenalty, penalty);
    if (bounded <= 0) {
      return { penalty: 0, reason: '', hour: currentHour };
    }
    const parts: string[] = [];
    if (adverse > 0) parts.push(`不利成交${adverse}次`);
    if (postOnly > 0) parts.push(`postOnly熔断${postOnly}次`);
    if (pauses > 0) parts.push(`风控暂停${pauses}次`);
    return {
      penalty: bounded,
      reason: `${currentHour}点时段近期偏危险: ${parts.join(' / ') || '风险偏高'} (-${bounded.toFixed(1)})`,
      hour: currentHour,
    };
  } catch (error) {
    console.error('[Polymarket] 读取分时段风险失败，已忽略:', error);
    return { penalty: 0, reason: '', hour: currentHour };
  }
}

function getSelectorConfig(env: EnvMap, venue: 'predict' | 'polymarket'): [number, number, number, number] {
  const predictSafety = getPredictSafetyConfig(env);
  const defaults =
    venue === 'polymarket'
      ? { minLiquidity: 0, minVolume24h: 0, maxSpread: 0.12, minOrders: 0 }
      : { minLiquidity: 0, minVolume24h: 0, maxSpread: predictSafety.maxSpread, minOrders: 0 };

  const configuredMaxSpread = readNumber(env, 'MARKET_SELECTOR_MAX_SPREAD', defaults.maxSpread);
  const maxSpread =
    venue === 'predict' ? Math.min(predictSafety.maxSpread, configuredMaxSpread) : configuredMaxSpread;

  return [
    readNumber(env, 'MARKET_SELECTOR_MIN_LIQUIDITY', defaults.minLiquidity),
    readNumber(env, 'MARKET_SELECTOR_MIN_VOLUME_24H', defaults.minVolume24h),
    maxSpread,
    readNumber(env, 'MARKET_SELECTOR_MIN_ORDERS', defaults.minOrders),
  ];
}

function toFixedOrNull(value: number | null | undefined, digits: number): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function getBookSpread(orderbook: Orderbook | undefined): number | null {
  const bestBid = Number(orderbook?.best_bid ?? 0);
  const bestAsk = Number(orderbook?.best_ask ?? 0);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
    return null;
  }
  return bestAsk - bestBid;
}

function isSafePredictOrderbook(orderbook: Orderbook | undefined, safety: PredictSafetyConfig): boolean {
  const spread = getBookSpread(orderbook);
  if (spread === null || spread > safety.maxSpread) {
    return false;
  }
  const mid = Number(orderbook?.mid_price ?? 0);
  if (!Number.isFinite(mid) || mid < safety.minPrice || mid > safety.maxPrice) {
    return false;
  }
  const bid1 = readLevel(orderbook, 'bids', 0).notional ?? 0;
  const ask1 = readLevel(orderbook, 'asks', 0).notional ?? 0;
  const bid2 = readLevel(orderbook, 'bids', 1).notional ?? 0;
  const ask2 = readLevel(orderbook, 'asks', 1).notional ?? 0;
  return (
    Math.min(bid1, ask1) >= safety.minL1Notional &&
    Math.min(bid2, ask2) >= safety.minL2Notional &&
    getLevelGap(orderbook, 'bids') <= safety.maxLevelGap &&
    getLevelGap(orderbook, 'asks') <= safety.maxLevelGap &&
    getSupportRatio(orderbook, 'bids') >= safety.minL2ToL1Ratio &&
    getSupportRatio(orderbook, 'asks') >= safety.minL2ToL1Ratio
  );
}

function readLevel(orderbook: Orderbook | undefined, side: 'bids' | 'asks', levelIndex: number): {
  price: number | null;
  shares: number | null;
  notional: number | null;
} {
  const levels = Array.isArray(orderbook?.[side]) ? [...(orderbook?.[side] || [])] : [];
  levels.sort((a, b) => {
    const pa = Number(a.price || 0);
    const pb = Number(b.price || 0);
    return side === 'bids' ? pb - pa : pa - pb;
  });
  const level = levels[levelIndex];
  if (!level) {
    return { price: null, shares: null, notional: null };
  }
  const price = Number(level.price);
  const shares = Number(level.shares);
  if (!Number.isFinite(price) || !Number.isFinite(shares) || price <= 0 || shares <= 0) {
    return { price: null, shares: null, notional: null };
  }
  return {
    price,
    shares,
    notional: price * shares,
  };
}

function getLevelGap(orderbook: Orderbook | undefined, side: 'bids' | 'asks'): number {
  const l1 = readLevel(orderbook, side, 0).price;
  const l2 = readLevel(orderbook, side, 1).price;
  if (l1 === null || l2 === null) {
    return Number.POSITIVE_INFINITY;
  }
  return side === 'bids' ? l1 - l2 : l2 - l1;
}

function getSupportRatio(orderbook: Orderbook | undefined, side: 'bids' | 'asks'): number {
  const l1 = readLevel(orderbook, side, 0).shares;
  const l2 = readLevel(orderbook, side, 1).shares;
  if (l1 === null || l2 === null || l1 <= 0 || l2 <= 0) {
    return 0;
  }
  return l2 / l1;
}

function getBookSymmetry(orderbook: Orderbook | undefined): number {
  const bid = readLevel(orderbook, 'bids', 0).notional ?? 0;
  const ask = readLevel(orderbook, 'asks', 0).notional ?? 0;
  if (bid <= 0 || ask <= 0) {
    return 0;
  }
  const minSide = Math.min(bid, ask);
  const maxSide = Math.max(bid, ask);
  return maxSide > 0 ? minSide / maxSide : 0;
}

function getCenterScore(orderbook: Orderbook | undefined): number {
  const mid = Number(orderbook?.mid_price ?? 0);
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    return 0;
  }
  const distance = Math.abs(mid - 0.5);
  return Math.max(0, 1 - distance / 0.45);
}

function getMakerQuality(orderbook: Orderbook | undefined): MakerQuality {
  const supportRatio = Math.min(getSupportRatio(orderbook, 'bids'), getSupportRatio(orderbook, 'asks'));
  const levelGap = Math.max(getLevelGap(orderbook, 'bids'), getLevelGap(orderbook, 'asks'));
  const symmetry = getBookSymmetry(orderbook);
  const centerScore = getCenterScore(orderbook);
  const liquidityScore =
    Math.log10((readLevel(orderbook, 'bids', 0).notional ?? 0) + (readLevel(orderbook, 'asks', 0).notional ?? 0) + 1) +
    Math.log10((readLevel(orderbook, 'bids', 1).notional ?? 0) + (readLevel(orderbook, 'asks', 1).notional ?? 0) + 1);
  return { supportRatio, levelGap, symmetry, centerScore, liquidityScore };
}

function getPolymarketIncentiveSummary(market: Market, orderbook: Orderbook | undefined): PolymarketIncentiveSummary {
  const enabled = Boolean(market.polymarket_rewards_enabled);
  const minSize = toFiniteNumber(market.polymarket_reward_min_size);
  const maxSpread = toFiniteNumber(market.polymarket_reward_max_spread);
  const dailyRate = toFiniteNumber(market.polymarket_reward_daily_rate);
  if (!enabled || minSize <= 0 || maxSpread <= 0 || dailyRate <= 0) {
    return {
      enabled: false,
      minSize: null,
      maxSpread: null,
      dailyRate: null,
      hourlyRate: null,
      fitScore: null,
      spreadFit: null,
      l1SizeFit: null,
      l2SizeFit: null,
      crowdingMultiple: null,
      capitalEstimateUsd: null,
      efficiency: null,
      netEfficiency: null,
      netDailyRate: null,
      effectiveNetEfficiency: null,
      effectiveNetDailyRate: null,
      estimatedCostBps: null,
      riskThrottleFactor: null,
      hourRiskFactor: null,
      queueHours: null,
      flowToQueuePerHour: null,
      targetQueueHours: null,
      targetQueueFactor: null,
      targetQueuePenalty: null,
      targetQueueReason: null,
      rewardDiagnostic: 'block',
      rewardDiagnosticReason: '当前无流动性激励，不适合奖励做市',
      marketState: null,
      marketStateReason: null,
    };
  }

  const bid1Shares = readLevel(orderbook, 'bids', 0).shares ?? 0;
  const ask1Shares = readLevel(orderbook, 'asks', 0).shares ?? 0;
  const bid2Shares = readLevel(orderbook, 'bids', 1).shares ?? 0;
  const ask2Shares = readLevel(orderbook, 'asks', 1).shares ?? 0;
  const l1MinShares = bid1Shares > 0 && ask1Shares > 0 ? Math.min(bid1Shares, ask1Shares) : 0;
  const l2MinShares = bid2Shares > 0 && ask2Shares > 0 ? Math.min(bid2Shares, ask2Shares) : 0;
  const l1SizeFit = Math.min(1.25, l1MinShares / minSize);
  const l2SizeFit = Math.min(1.25, l2MinShares / minSize);
  const rawSpread = getBookSpread(orderbook);
  const spreadFit = rawSpread === null ? 0 : Math.max(0, Math.min(1, 1 - rawSpread / maxSpread));
  const fitScore = Math.max(0, Math.min(1.1, 0.3 * spreadFit + 0.25 * (l1SizeFit / 1.25) + 0.45 * (l2SizeFit / 1.25)));
  const crowdingMultiple = (l1MinShares + l2MinShares) / Math.max(1, minSize);
  const midPrice = toFiniteNumber(orderbook?.mid_price);
  const capitalEstimateUsd = midPrice > 0 ? minSize * midPrice * 2 : null;
  const efficiency = capitalEstimateUsd && capitalEstimateUsd > 0 ? dailyRate / capitalEstimateUsd : null;
  const netEfficiency = toFiniteNumber(market.polymarket_reward_net_efficiency);
  const netDailyRate = toFiniteNumber(market.polymarket_reward_net_daily_rate);
  const effectiveNetEfficiency = toFiniteNumber(market.polymarket_reward_effective_net_efficiency);
  const effectiveNetDailyRate = toFiniteNumber(market.polymarket_reward_effective_net_daily_rate);
  const estimatedCostBps = toFiniteNumber(market.polymarket_reward_estimated_cost_bps);
  const riskThrottleFactor = toFiniteNumber(market.polymarket_recent_risk_throttle_factor) || 1;
  const hourRiskFactor =
    netEfficiency > 0 && effectiveNetEfficiency > 0 ? Math.max(0, Math.min(1, effectiveNetEfficiency / netEfficiency)) : 1;
  const queueAheadShares = l1MinShares + l2MinShares;
  const volume24h = toFiniteNumber(market.volume_24h);
  const hourlyTurnoverShares = midPrice > 0 ? volume24h / midPrice / 24 : 0;
  const queueHours = queueAheadShares > 0 && hourlyTurnoverShares > 0 ? queueAheadShares / hourlyTurnoverShares : null;
  const flowToQueuePerHour =
    queueAheadShares > 0 && hourlyTurnoverShares > 0 ? hourlyTurnoverShares / queueAheadShares : null;
  const targetQueueHours = toFiniteNumber(market.polymarket_reward_queue_target_hours);
  const targetQueueFactor = toFiniteNumber(market.polymarket_reward_queue_target_factor);
  const targetQueuePenalty = toFiniteNumber(market.polymarket_reward_queue_target_penalty);
  const targetQueueReason = String(market.polymarket_reward_queue_target_reason || '').trim() || null;
  const marketState = String(market.polymarket_state || '').trim() || null;
  const marketStateReason = String(market.polymarket_state_reason || '').trim() || null;
  const eventRiskPenalty = Math.max(0, toFiniteNumber(market.polymarket_event_risk_penalty));
  const recentRiskPenalty = Math.max(0, toFiniteNumber(market.polymarket_recent_risk_penalty));
  const cooldownRemainingMs = Math.max(0, toFiniteNumber(market.polymarket_recent_risk_cooldown_remaining_ms));
  let rewardDiagnostic: 'pass' | 'watch' | 'defend' | 'block' = 'pass';
  let rewardDiagnosticReason: string | null = null;

  if (cooldownRemainingMs > 0 || marketState === 'COOLDOWN' || marketState === 'EXIT') {
    rewardDiagnostic = 'block';
    rewardDiagnosticReason = marketStateReason || targetQueueReason || '市场处于冷却或退出状态';
  } else if ((targetQueueFactor > 0 && targetQueueFactor < 0.72) || eventRiskPenalty >= 4) {
    rewardDiagnostic = 'defend';
    rewardDiagnosticReason = targetQueueReason || marketStateReason || '目标排队位置偏离过大，需明显退后并缩单';
  } else if (
    (effectiveNetEfficiency > 0 && effectiveNetEfficiency < 0.001) ||
    recentRiskPenalty >= 4 ||
    marketState === 'PROBE' ||
    marketState === 'DEFEND' ||
    marketState === 'OBSERVE'
  ) {
    rewardDiagnostic = 'watch';
    rewardDiagnosticReason = marketStateReason || targetQueueReason || '奖励净效率或风险状态一般，建议先试挂观察';
  }

  return {
    enabled: true,
    minSize,
    maxSpread,
    dailyRate,
    hourlyRate: dailyRate / 24,
    fitScore,
    spreadFit,
    l1SizeFit,
    l2SizeFit,
    crowdingMultiple,
    capitalEstimateUsd,
    efficiency,
    netEfficiency: netEfficiency > 0 ? netEfficiency : efficiency,
    netDailyRate: netDailyRate > 0 ? netDailyRate : dailyRate,
    effectiveNetEfficiency: effectiveNetEfficiency > 0 ? effectiveNetEfficiency : netEfficiency > 0 ? netEfficiency : efficiency,
    effectiveNetDailyRate: effectiveNetDailyRate > 0 ? effectiveNetDailyRate : netDailyRate > 0 ? netDailyRate : dailyRate,
    estimatedCostBps,
    riskThrottleFactor,
    hourRiskFactor,
    queueHours,
    flowToQueuePerHour,
    targetQueueHours,
    targetQueueFactor,
    targetQueuePenalty,
    targetQueueReason,
    rewardDiagnostic,
    rewardDiagnosticReason,
    marketState,
    marketStateReason,
  };
}

function normalizeGroupKey(market: Market): string {
  const question = String(market.question || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return String(market.condition_id || market.event_id || question);
}

function diversifyRecommendations(scored: ReturnType<MarketSelector['selectMarkets']>, count: number) {
  const selected: typeof scored = [];
  const perGroup = new Map<string, number>();
  for (const entry of scored) {
    const key = normalizeGroupKey(entry.market);
    const used = perGroup.get(key) || 0;
    if (used >= 2) {
      continue;
    }
    selected.push(entry);
    perGroup.set(key, used + 1);
    if (selected.length >= count) {
      break;
    }
  }
  return selected;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.envPath)) {
    throw new Error(`Missing env file: ${args.envPath}`);
  }

  const envText = fs.readFileSync(args.envPath, 'utf8');
  const env = parseEnv(envText);
  const predictSafety = getPredictSafetyConfig(env);
  const polymarketSelectorOptions = getPolymarketSelectorOptions(env);
  const recentRiskPenalty = loadRecentPolymarketRiskPenalty(env, args.envPath);
  const hourRiskPenalty = loadPolymarketHourRiskPenalty(
    env,
    args.envPath,
    readNumber(env, 'POLYMARKET_HOUR_RISK_LOOKBACK_DAYS', 7),
    readNumber(env, 'POLYMARKET_HOUR_RISK_PENALTY_MAX', 8)
  );
  const patternMemoryPenalty = loadPolymarketPatternMemory(
    env,
    args.envPath,
    readNumber(env, 'POLYMARKET_PATTERN_MEMORY_TTL_MS', 604800000),
    readNumber(env, 'POLYMARKET_PATTERN_MEMORY_MAX_PENALTY', 8)
  );
  polymarketSelectorOptions.polymarketRecentRiskPenalty = recentRiskPenalty;
  polymarketSelectorOptions.polymarketHourRiskPenalty = hourRiskPenalty;
  polymarketSelectorOptions.polymarketPatternMemoryPenalty = patternMemoryPenalty;
  const [minLiquidity, minVolume24h, maxSpread, minOrders] = getSelectorConfig(env, args.venue);
  const selector = new MarketSelector(
    minLiquidity,
    minVolume24h,
    maxSpread,
    minOrders,
    args.venue === 'polymarket' ? polymarketSelectorOptions : {}
  );

  const { markets, orderbooks, api: linkApi } =
    args.venue === 'polymarket'
      ? await loadPolymarketMarkets(env, args.scan)
      : await loadPredictMarkets(env, args.scan);

  let scored = selector.selectMarkets(markets, orderbooks);
  if (scored.length === 0 && args.venue === 'predict' && markets.length > 0 && orderbooks.size > 0) {
    const relaxedSelector = new MarketSelector(0, 0, predictSafety.maxSpread, 0, {});
    const relaxedScored = relaxedSelector.selectMarkets(markets, orderbooks);
    if (relaxedScored.length > 0) {
      console.error(
        `[Predict] 严格阈值下无结果，已自动回退到宽松筛选（候选 ${relaxedScored.length} 个）`
      );
      scored = relaxedScored;
    }
  }
  if (scored.length === 0 && args.venue === 'predict' && orderbooks.size > 0) {
    const fallback = markets
      .filter((market) => {
        const book = orderbooks.get(market.token_id);
        return isSafePredictOrderbook(book, predictSafety);
      })
      .slice(0, Math.max(args.top * 3, 12))
      .map((market) => {
        const book = orderbooks.get(market.token_id)!;
        const l1Bid = readLevel(book, 'bids', 0).notional ?? 0;
        const l1Ask = readLevel(book, 'asks', 0).notional ?? 0;
        const score = l1Bid + l1Ask + ((book.best_bid ?? 0) > 0 && (book.best_ask ?? 0) > 0 ? 1000 : 0);
        return {
          market,
          score,
          reasons: ['使用盘口兜底排序（API 统计字段缺失或筛选过严）'],
        };
      })
      .sort((a, b) => b.score - a.score);
    if (fallback.length > 0) {
      console.error(`[Predict] 常规筛选无结果，已回退到安全盘口兜底排序（候选 ${fallback.length} 个）`);
      scored = fallback;
    }
  }
  if (scored.length === 0 && args.venue === 'predict') {
    console.error(
      `[Predict] 未找到安全盘口：自动推荐仅返回价差<=${(predictSafety.maxSpread * 100).toFixed(0)}%、中间价位于 ${(predictSafety.minPrice * 100).toFixed(0)}%-${(predictSafety.maxPrice * 100).toFixed(0)}%、且 L1/L2 深度达标的市场`
    );
  }
  const top = diversifyRecommendations(scored, Math.max(1, args.top));
  const tokenIds = top.map((s) => s.market.token_id);
  const linkCachePath = getMarketLinkCachePath(args.envPath);
  const linkCache = loadMarketLinkCache(linkCachePath);
  const recommendations = await Promise.all(top.map(async (entry, idx) => {
    const book = orderbooks.get(entry.market.token_id);
    const bid1 = readLevel(book, 'bids', 0);
    const ask1 = readLevel(book, 'asks', 0);
    const bid2 = readLevel(book, 'bids', 1);
    const ask2 = readLevel(book, 'asks', 1);
    const l1Notional =
      (bid1.notional && Number.isFinite(bid1.notional) ? bid1.notional : 0) +
      (ask1.notional && Number.isFinite(ask1.notional) ? ask1.notional : 0);
    const l2Notional =
      (bid2.notional && Number.isFinite(bid2.notional) ? bid2.notional : 0) +
      (ask2.notional && Number.isFinite(ask2.notional) ? ask2.notional : 0);
    const l1Usable =
      bid1.notional && ask1.notional && Number.isFinite(bid1.notional) && Number.isFinite(ask1.notional)
        ? Math.min(bid1.notional, ask1.notional)
        : 0;
    const l2Usable =
      bid2.notional && ask2.notional && Number.isFinite(bid2.notional) && Number.isFinite(ask2.notional)
        ? Math.min(bid2.notional, ask2.notional)
        : 0;
    const quality = getMakerQuality(book);
    const incentive = getPolymarketIncentiveSummary(entry.market, book);
    const linkedMarket =
      args.venue === 'predict' ? await hydratePredictMarketLink(linkApi as PredictAPI, entry.market) : entry.market;
    const marketLink = await resolveMarketLink(args.venue, linkedMarket, linkCache, linkCachePath);

    return {
      rank: idx + 1,
      score: Number(entry.score.toFixed(3)),
      tokenId: entry.market.token_id,
      marketUrl: marketLink.url,
      marketLinkLabel: marketLink.label,
      marketLinkSource: marketLink.source,
      question: (entry.market.question || '').replace(/\s+/g, ' ').trim(),
      spreadPct:
        entry.market.spread_pct !== undefined && Number.isFinite(entry.market.spread_pct)
          ? Number(entry.market.spread_pct.toFixed(4))
          : null,
      bestBid:
        entry.market.best_bid !== undefined && Number.isFinite(entry.market.best_bid)
          ? Number(entry.market.best_bid.toFixed(6))
          : null,
      bestAsk:
        entry.market.best_ask !== undefined && Number.isFinite(entry.market.best_ask)
          ? Number(entry.market.best_ask.toFixed(6))
          : null,
      bid1Price: toFixedOrNull(bid1.price, 6),
      ask1Price: toFixedOrNull(ask1.price, 6),
      bid2Price: toFixedOrNull(bid2.price, 6),
      ask2Price: toFixedOrNull(ask2.price, 6),
      bid1Shares: toFixedOrNull(bid1.shares, 2),
      ask1Shares: toFixedOrNull(ask1.shares, 2),
      bid2Shares: toFixedOrNull(bid2.shares, 2),
      ask2Shares: toFixedOrNull(ask2.shares, 2),
      l1NotionalUsd: toFixedOrNull(l1Notional > 0 ? l1Notional : null, 2),
      l2NotionalUsd: toFixedOrNull(l2Notional > 0 ? l2Notional : null, 2),
      l1UsableUsd: toFixedOrNull(l1Usable > 0 ? l1Usable : null, 2),
      l2UsableUsd: toFixedOrNull(l2Usable > 0 ? l2Usable : null, 2),
      supportRatio: toFixedOrNull(quality.supportRatio, 3),
      maxLevelGap: toFixedOrNull(quality.levelGap, 4),
      symmetry: toFixedOrNull(quality.symmetry, 3),
      centerScore: toFixedOrNull(quality.centerScore, 3),
      rewardEnabled: incentive.enabled,
      rewardMinSize: toFixedOrNull(incentive.minSize, 0),
      rewardMaxSpread: toFixedOrNull(incentive.maxSpread, 4),
      rewardMaxSpreadCents: toFixedOrNull(incentive.maxSpread !== null ? incentive.maxSpread * 100 : null, 2),
      rewardDailyRate: toFixedOrNull(incentive.dailyRate, 0),
      rewardHourlyRate: toFixedOrNull(incentive.hourlyRate, 2),
      rewardFitScore: toFixedOrNull(incentive.fitScore, 3),
      rewardSpreadFit: toFixedOrNull(incentive.spreadFit, 3),
      rewardL1SizeFit: toFixedOrNull(incentive.l1SizeFit, 3),
      rewardL2SizeFit: toFixedOrNull(incentive.l2SizeFit, 3),
      rewardCrowdingMultiple: toFixedOrNull(incentive.crowdingMultiple, 2),
      rewardCapitalEstimateUsd: toFixedOrNull(incentive.capitalEstimateUsd, 2),
      rewardEfficiency: toFixedOrNull(incentive.efficiency, 4),
      rewardNetEfficiency: toFixedOrNull(incentive.netEfficiency, 4),
      rewardNetDailyRate: toFixedOrNull(incentive.netDailyRate, 2),
      rewardEffectiveNetEfficiency: toFixedOrNull(incentive.effectiveNetEfficiency, 4),
      rewardEffectiveNetDailyRate: toFixedOrNull(incentive.effectiveNetDailyRate, 2),
      rewardEstimatedCostBps: toFixedOrNull(incentive.estimatedCostBps, 2),
      rewardRiskThrottleFactor: toFixedOrNull(incentive.riskThrottleFactor, 3),
      rewardHourRiskFactor: toFixedOrNull(incentive.hourRiskFactor, 3),
      rewardQueueHours: toFixedOrNull(incentive.queueHours, 2),
      rewardFlowToQueuePerHour: toFixedOrNull(incentive.flowToQueuePerHour, 2),
      rewardTargetQueueHours: toFixedOrNull(incentive.targetQueueHours, 2),
      rewardTargetQueueFactor: toFixedOrNull(incentive.targetQueueFactor, 3),
      rewardTargetQueuePenalty: toFixedOrNull(incentive.targetQueuePenalty, 2),
      rewardTargetQueueReason: incentive.targetQueueReason,
      rewardDiagnostic: incentive.rewardDiagnostic,
      rewardDiagnosticReason: incentive.rewardDiagnosticReason,
      marketState: incentive.marketState,
      marketStateReason: incentive.marketStateReason,
      eventRiskPenalty: toFixedOrNull(entry.market.polymarket_event_risk_penalty ?? null, 1),
      eventRiskReason: entry.market.polymarket_event_risk_reason || null,
      eventRiskSizeFactor: toFixedOrNull(entry.market.polymarket_event_risk_size_factor ?? null, 3),
      recentRiskPenalty: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.penalty ?? null, 1),
      recentFillPenaltyBps: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.fillPenaltyBps ?? null, 2),
      recentRiskThrottleFactor: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.riskThrottleFactor ?? null, 3),
      recentCancelRate: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.cancelRate ?? null, 3),
      recentAvgCancelLifetimeMs: toFixedOrNull(
        recentRiskPenalty.get(entry.market.token_id)?.avgCancelLifetimeMs ?? null,
        0
      ),
      recentAvgFillLifetimeMs: toFixedOrNull(
        recentRiskPenalty.get(entry.market.token_id)?.avgFillLifetimeMs ?? null,
        0
      ),
      recentCancelPenalty: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.cancelPenalty ?? null, 2),
      recentLifetimePenalty: toFixedOrNull(recentRiskPenalty.get(entry.market.token_id)?.lifetimePenalty ?? null, 2),
      recentRiskReason: recentRiskPenalty.get(entry.market.token_id)?.reason || null,
      recentRiskCooldownMinutes:
        recentRiskPenalty.get(entry.market.token_id)?.cooldownRemainingMs != null
          ? Math.max(1, Math.ceil((recentRiskPenalty.get(entry.market.token_id)?.cooldownRemainingMs || 0) / 60000))
          : null,
      recentRiskCooldownReason: recentRiskPenalty.get(entry.market.token_id)?.cooldownReason || null,
      hourRiskPenalty: toFixedOrNull(hourRiskPenalty.penalty || null, 1),
      hourRiskReason: hourRiskPenalty.reason || null,
      hourRiskHour: Number.isFinite(hourRiskPenalty.hour) ? hourRiskPenalty.hour : null,
      marketHourRiskPenalty: toFixedOrNull(entry.market.polymarket_market_hour_risk_penalty ?? null, 1),
      marketHourRiskReason: entry.market.polymarket_market_hour_risk_reason || null,
      patternMemoryPenalty: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.penalty ?? null, 1),
      patternMemoryReason: patternMemoryPenalty.get(entry.market.token_id)?.reason || null,
      patternMemoryDominance: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.dominance ?? null, 3),
      patternMemoryDominantReason: patternMemoryPenalty.get(entry.market.token_id)?.dominantReason || null,
      patternMemoryAgeHours:
        toFixedOrNull(
          patternMemoryPenalty.get(entry.market.token_id)?.ageMs != null
            ? Number(patternMemoryPenalty.get(entry.market.token_id)?.ageMs) / 3600000
            : null,
          1
        ),
      patternMemoryTtlHours:
        toFixedOrNull(
          patternMemoryPenalty.get(entry.market.token_id)?.ttlRemainingMs != null
            ? Number(patternMemoryPenalty.get(entry.market.token_id)?.ttlRemainingMs) / 3600000
            : null,
          1
        ),
      patternMemoryDecayFactor: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.decayFactor ?? null, 3),
      patternMemoryNearTouch: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.reasonMix?.nearTouch ?? null, 3),
      patternMemoryRefresh: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.reasonMix?.refresh ?? null, 3),
      patternMemoryVwap: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.reasonMix?.vwap ?? null, 3),
      patternMemoryAggressive: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.reasonMix?.aggressive ?? null, 3),
      patternMemoryUnsafe: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.reasonMix?.unsafe ?? null, 3),
      patternMemoryLearnedRetreat: toFixedOrNull(
        patternMemoryPenalty.get(entry.market.token_id)?.learnedRetreat ?? null,
        3
      ),
      patternMemoryLearnedSize: toFixedOrNull(patternMemoryPenalty.get(entry.market.token_id)?.learnedSize ?? null, 3),
      liquidity24h:
        entry.market.liquidity_24h !== undefined && Number.isFinite(entry.market.liquidity_24h)
          ? Number(entry.market.liquidity_24h.toFixed(2))
          : null,
      volume24h:
        entry.market.volume_24h !== undefined && Number.isFinite(entry.market.volume_24h)
          ? Number(entry.market.volume_24h.toFixed(2))
          : null,
      reasons: entry.reasons || [],
    };
  }));

  const result: Record<string, unknown> = {
    venue: args.venue,
    scannedMarkets: markets.length,
    validMarkets: scored.length,
    topCount: top.length,
    recommendations,
  };

  if (args.apply) {
    if (tokenIds.length === 0) {
      throw new Error('No markets to apply. Check API credentials/filters.');
    }
    const nextEnv = upsertEnv(envText, { MARKET_TOKEN_IDS: tokenIds.join(',') });
    fs.writeFileSync(args.envPath, nextEnv, 'utf8');
    result.applied = true;
    result.appliedTokenIds = tokenIds;
    result.envPath = args.envPath;
  } else {
    result.applied = false;
  }

  if (args.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Venue: ${args.venue}`);
  console.log(`Scanned markets: ${markets.length}`);
  console.log(`Valid scored markets: ${scored.length}`);
  console.log(`Top ${top.length} recommendations:\n`);
  top.forEach((entry, idx) => {
    const market = entry.market;
    const spreadText =
      market.spread_pct !== undefined && Number.isFinite(market.spread_pct)
        ? `${market.spread_pct.toFixed(2)}%`
        : 'n/a';
    const q = (market.question || '').replace(/\s+/g, ' ').slice(0, 72);
    console.log(
      `${String(idx + 1).padStart(2, '0')}. score=${entry.score.toFixed(1)} token=${market.token_id} spread=${spreadText} question="${q}"`
    );
  });

  if (args.apply) {
    console.log(`\nApplied MARKET_TOKEN_IDS to ${args.envPath}`);
  } else {
    console.log('\nTip: run with --apply to write MARKET_TOKEN_IDS into .env');
  }
}

main().catch((error) => {
  console.error(`Market recommendation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
