import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import axios from 'axios';
import { PredictAPI } from '../src/api/client.js';
import { MarketSelector } from '../src/market-selector.js';
import type { Market, Orderbook, OrderbookEntry } from '../src/types.js';

interface Args {
  venue: 'predict' | 'probable';
  top: number;
  scan: number;
  apply: boolean;
  json: boolean;
  envPath: string;
}

interface EnvMap extends Map<string, string> {}

const RETRYABLE_NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);
const PREDICT_SAFE_MAX_SPREAD = 0.06;
const PREDICT_SAFE_MIN_L1_NOTIONAL = 25;
const PREDICT_SAFE_MIN_L2_NOTIONAL = 10;
const PREDICT_SAFE_MIN_PRICE = 0.08;
const PREDICT_SAFE_MAX_PRICE = 0.92;
const PREDICT_SAFE_MAX_LEVEL_GAP = 0.02;

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
      '  npx tsx scripts/recommend-markets.ts [--venue predict|probable] [--top 10] [--scan 60] [--apply] [--json] [--env .env]',
      '',
      'Examples:',
      '  npx tsx scripts/recommend-markets.ts --venue predict --top 12',
      '  npx tsx scripts/recommend-markets.ts --venue probable --apply',
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
      if (value !== 'predict' && value !== 'probable') {
        throw new Error('--venue must be "predict" or "probable"');
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

function toFiniteNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sortByLiquidityAndVolume<T>(
  items: T[],
  getLiquidity: (item: T) => number,
  getVolume: (item: T) => number
): T[] {
  return [...items].sort((a, b) => {
    const liquidityDiff = getLiquidity(b) - getLiquidity(a);
    if (liquidityDiff !== 0) return liquidityDiff;
    const volumeDiff = getVolume(b) - getVolume(a);
    if (volumeDiff !== 0) return volumeDiff;
    return 0;
  });
}

function getProbableLiquidity(item: any): number {
  return toFiniteNumber(
    item?.liquidity_24h ??
      item?.liquidity24h ??
      item?.liquidity ??
      item?.totalLiquidityUsd ??
      item?.stats?.liquidity24hUsd ??
      0
  );
}

function getProbableVolume(item: any): number {
  return toFiniteNumber(
    item?.volume_24h ?? item?.volume24h ?? item?.volume24hr ?? item?.volume24hUsd ?? item?.stats?.volume24hUsd ?? 0
  );
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

    settled.forEach((result) => {
      if (result.status === 'rejected') {
        // ignore single market failures and continue
      }
    });
  }

  return orderbooks;
}

async function loadPredictMarkets(env: EnvMap, scan: number): Promise<{ markets: Market[]; orderbooks: Map<string, Orderbook> }> {
  const apiBaseUrl = env.get('API_BASE_URL') || 'https://api.predict.fun';
  const apiKey = env.get('API_KEY');
  const jwtToken = env.get('JWT_TOKEN') || undefined;
  if (!apiKey) {
    throw new Error('Predict venue requires API_KEY in .env');
  }
  const api = new PredictAPI(apiBaseUrl, apiKey, jwtToken);
  const allMarkets = await api.getMarkets();

  // 筛选活跃市场：active=true, closed=false, end_date 在未来
  const now = Date.now();
  const activeMarkets = allMarkets.filter((m) => {
    // 检查是否已关闭
    const isClosed = (m as any).closed === true || (m as any).is_closed === true;
    if (isClosed) return false;

    // 检查是否活跃
    const isActive = (m as any).active === true || (m as any).is_active === true || (m as any).active === undefined;
    if (!isActive) return false;

    // 检查结束日期（如果有）
    const endDate = m.end_date ? new Date(m.end_date).getTime() : null;
    if (endDate && endDate < now) return false;

    return true;
  });

  const rankedActiveMarkets = sortByLiquidityAndVolume(
    activeMarkets,
    (market) => toFiniteNumber(market.liquidity_24h),
    (market) => toFiniteNumber(market.volume_24h)
  );
  const candidateCount = Math.min(rankedActiveMarkets.length, Math.max(scan * 3, 36));
  const selected = rankedActiveMarkets.slice(0, candidateCount);
  console.error(
    `[Predict] 筛选: ${allMarkets.length} -> ${activeMarkets.length} 活跃市场 (按流动性排序取前 ${selected.length}, scan=${scan})`
  );

  const orderbooks = await populateOrderbooksWithConcurrency(selected, 3, async (market) => api.getOrderbook(market.token_id));
  console.error(`[Predict] 订单簿抓取成功: ${orderbooks.size}/${selected.length}`);
  return { markets: selected, orderbooks };
}

async function loadProbableMarkets(env: EnvMap, scan: number): Promise<{ markets: Market[]; orderbooks: Map<string, Orderbook> }> {
  const marketApiUrl = env.get('PROBABLE_MARKET_API_URL') || 'https://market-api.probable.markets';
  const orderbookApiUrl = env.get('PROBABLE_ORDERBOOK_API_URL') || 'https://api.probable.markets/public/api/v1';
  const url = `${marketApiUrl.replace(/\/+$/g, '')}/public/api/v1/markets/`;
  const rawLimit = Math.min(Math.max(scan * 6, 120), 400);
  const response = await httpGetWithRetry(url, {
    params: { active: true, closed: false, limit: rawLimit },
    timeout: 10000,
  });
  const raw = response.data;
  const list = Array.isArray(raw?.markets)
    ? raw.markets
    : Array.isArray(raw?.data?.markets)
    ? raw.data.markets
    : Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.result)
    ? raw.result
    : Array.isArray(raw)
    ? raw
    : [];

  const sortedList = sortByLiquidityAndVolume(list, getProbableLiquidity, getProbableVolume);

  const markets: Market[] = [];
  for (const item of sortedList) {
    if (item?.active === false || item?.closed === true) continue;
    const outcomes = toArray(item?.outcomes || item?.outcomeNames);
    const tokens = toArray(item?.clobTokenIds || item?.clob_token_ids || item?.tokens || item?.tokenIds);
    if (outcomes.length < 2 || tokens.length < 2) continue;
    const question = item?.question || item?.title || 'Probable Market';
    const eventId = String(item?.id || item?.marketId || '');
    const volume24h = getProbableVolume(item);
    const liquidity24h = getProbableLiquidity(item);
    for (let i = 0; i < Math.min(tokens.length, outcomes.length); i += 1) {
      const tokenId = String(tokens[i] || '');
      if (!tokenId) continue;
      markets.push({
        token_id: tokenId,
        question,
        condition_id: eventId,
        event_id: eventId,
        outcome: String(outcomes[i] || ''),
        volume_24h: volume24h,
        liquidity_24h: liquidity24h,
        is_neg_risk: false,
        is_yield_bearing: false,
        fee_rate_bps: Number(env.get('PROBABLE_FEE_BPS') || 0),
      });
    }
  }

  const rankedMarkets = sortByLiquidityAndVolume(
    markets,
    (market) => toFiniteNumber(market.liquidity_24h),
    (market) => toFiniteNumber(market.volume_24h)
  );
  const candidateCount = Math.min(rankedMarkets.length, Math.max(scan * 4, 120));

  const orderbooks = await populateOrderbooksWithConcurrency(
    rankedMarkets.slice(0, candidateCount),
    8,
    async (market) => {
      const bookResponse = await httpGetWithRetry(`${orderbookApiUrl.replace(/\/+$/g, '')}/book`, {
        params: { token_id: market.token_id },
        timeout: 8000,
      });
      return normalizeOrderbook(market.token_id, bookResponse.data);
    }
  );

  console.error(
    `[Probable] 筛选: ${list.length} 原始市场 -> ${markets.length} outcome 市场 (按流动性排序取前 ${candidateCount}, scan=${scan})`
  );

  return { markets: rankedMarkets.slice(0, candidateCount), orderbooks };
}

function readNumber(env: EnvMap, key: string, fallback: number): number {
  const value = Number(env.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function getSelectorConfig(env: EnvMap, venue: 'predict' | 'probable'): [number, number, number, number] {
  const defaults =
    venue === 'probable'
      ? { minLiquidity: 0, minVolume24h: 0, maxSpread: 0.2, minOrders: 0 }
      : { minLiquidity: 0, minVolume24h: 0, maxSpread: PREDICT_SAFE_MAX_SPREAD, minOrders: 0 };

  const configuredMaxSpread = readNumber(env, 'MARKET_SELECTOR_MAX_SPREAD', defaults.maxSpread);
  const maxSpread =
    venue === 'predict' ? Math.min(PREDICT_SAFE_MAX_SPREAD, configuredMaxSpread) : configuredMaxSpread;

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

function minPositive(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.min(a, b);
}

function getBookSpread(orderbook: Orderbook | undefined): number | null {
  const bestBid = Number(orderbook?.best_bid ?? 0);
  const bestAsk = Number(orderbook?.best_ask ?? 0);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
    return null;
  }
  return bestAsk - bestBid;
}

function isSafePredictOrderbook(orderbook: Orderbook | undefined): boolean {
  const spread = getBookSpread(orderbook);
  if (spread === null || spread > PREDICT_SAFE_MAX_SPREAD) {
    return false;
  }
  const mid = Number(orderbook?.mid_price ?? 0);
  if (!Number.isFinite(mid) || mid < PREDICT_SAFE_MIN_PRICE || mid > PREDICT_SAFE_MAX_PRICE) {
    return false;
  }
  const bid1 = readLevel(orderbook, 'bids', 0).notional ?? 0;
  const ask1 = readLevel(orderbook, 'asks', 0).notional ?? 0;
  const bid2 = readLevel(orderbook, 'bids', 1).notional ?? 0;
  const ask2 = readLevel(orderbook, 'asks', 1).notional ?? 0;
  return (
    Math.min(bid1, ask1) >= PREDICT_SAFE_MIN_L1_NOTIONAL &&
    Math.min(bid2, ask2) >= PREDICT_SAFE_MIN_L2_NOTIONAL &&
    getLevelGap(orderbook, 'bids') <= PREDICT_SAFE_MAX_LEVEL_GAP &&
    getLevelGap(orderbook, 'asks') <= PREDICT_SAFE_MAX_LEVEL_GAP
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.envPath)) {
    throw new Error(`Missing env file: ${args.envPath}`);
  }

  const envText = fs.readFileSync(args.envPath, 'utf8');
  const env = parseEnv(envText);
  const [minLiquidity, minVolume24h, maxSpread, minOrders] = getSelectorConfig(env, args.venue);
  const selector = new MarketSelector(minLiquidity, minVolume24h, maxSpread, minOrders);

  const { markets, orderbooks } =
    args.venue === 'probable'
      ? await loadProbableMarkets(env, args.scan)
      : await loadPredictMarkets(env, args.scan);

  let scored = selector.selectMarkets(markets, orderbooks);
  if (scored.length === 0 && args.venue === 'predict' && markets.length > 0 && orderbooks.size > 0) {
    const relaxedSelector = new MarketSelector(0, 0, PREDICT_SAFE_MAX_SPREAD, 0);
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
        return isSafePredictOrderbook(book);
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
      `[Predict] 未找到安全盘口：自动推荐仅返回价差<=${(PREDICT_SAFE_MAX_SPREAD * 100).toFixed(0)}%、中间价位于 ${(PREDICT_SAFE_MIN_PRICE * 100).toFixed(0)}%-${(PREDICT_SAFE_MAX_PRICE * 100).toFixed(0)}%、且 L1/L2 深度达标的市场`
    );
  }
  const top = scored.slice(0, Math.max(1, args.top));
  const tokenIds = top.map((s) => s.market.token_id);
  const recommendations = top.map((entry, idx) => {
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
    const l1Usable = minPositive(bid1.notional, ask1.notional);
    const l2Usable = minPositive(bid2.notional, ask2.notional);
    const hasBalancedBook = (entry.market.best_bid ?? 0) > 0 && (entry.market.best_ask ?? 0) > (entry.market.best_bid ?? 0);
    const activeStatus = hasBalancedBook ? '活跃' : '活跃/盘口薄';

    return {
      rank: idx + 1,
      score: Number(entry.score.toFixed(3)),
      activeStatus,
      tokenId: entry.market.token_id,
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
      bid1Shares: toFixedOrNull(bid1.shares, 2),
      ask1Shares: toFixedOrNull(ask1.shares, 2),
      bid2Shares: toFixedOrNull(bid2.shares, 2),
      ask2Shares: toFixedOrNull(ask2.shares, 2),
      l1NotionalUsd: toFixedOrNull(l1Notional > 0 ? l1Notional : null, 2),
      l2NotionalUsd: toFixedOrNull(l2Notional > 0 ? l2Notional : null, 2),
      l1UsableUsd: toFixedOrNull(l1Usable, 2),
      l2UsableUsd: toFixedOrNull(l2Usable, 2),
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
  });

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
    const updates: Record<string, string> = { MARKET_TOKEN_IDS: tokenIds.join(',') };
    if (args.venue === 'probable') {
      updates.PROBABLE_MAX_MARKETS = String(Math.max(args.scan * 6, 200));
    }
    const nextEnv = upsertEnv(envText, updates);
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
