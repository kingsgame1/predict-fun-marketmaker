import axios from 'axios';
import { execFile } from 'node:child_process';
import type { Market, Orderbook, OrderbookEntry, Order, Position } from '../types.js';
import type { MakerApi } from '../mm/venue.js';
import { createClobClient } from '@prob/clob';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';

interface ProbableConfig {
  marketApiUrl: string;
  orderbookApiUrl: string;
  wsUrl: string;
  privateKey: string;
  chainId: number;
  rpcUrl?: string;
  maxMarkets?: number;
  feeBps?: number;
}

interface ProbableMarket {
  id?: string;
  marketId?: string;
  question?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  outcomes?: string[] | string;
  outcomeNames?: string[] | string;
  clobTokenIds?: string[] | string;
  clob_token_ids?: string[] | string;
  tokenIds?: string[] | string;
  tokens?: string[] | string;
}

const RETRYABLE_NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);

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

function toArray<T>(value: T[] | string | undefined): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

function toFiniteNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getProbableVolume(market: any): number {
  return toFiniteNumber(
    market?.volume_24h ?? market?.volume24h ?? market?.volume24hr ?? market?.volume24hUsd ?? market?.stats?.volume24hUsd ?? 0
  );
}

function getProbableLiquidity(market: any): number {
  return toFiniteNumber(
    market?.liquidity_24h ??
      market?.liquidity24h ??
      market?.liquidity ??
      market?.totalLiquidityUsd ??
      market?.stats?.liquidity24hUsd ??
      0
  );
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

function parseOrderbook(data: any): Orderbook {
  const payload = data?.result || data?.data || data || {};
  const bids = Array.isArray(payload?.bids) ? payload.bids : [];
  const asks = Array.isArray(payload?.asks) ? payload.asks : [];
  const parseSide = (levels: any[]): OrderbookEntry[] =>
    levels
      .map((level) => ({
        price: String(level?.price ?? level?.[0] ?? 0),
        shares: String(level?.size ?? level?.shares ?? level?.[1] ?? 0),
      }))
      .filter((level) => Number(level.price) > 0 && Number(level.shares) > 0);
  const parsedBids = parseSide(bids).sort((a, b) => Number(b.price) - Number(a.price));
  const parsedAsks = parseSide(asks).sort((a, b) => Number(a.price) - Number(b.price));
  const bestBid = parsedBids.length > 0 ? Number(parsedBids[0].price) : undefined;
  const bestAsk = parsedAsks.length > 0 ? Number(parsedAsks[0].price) : undefined;
  const midValue =
    Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (Number(bestBid) + Number(bestAsk)) / 2 : undefined;
  const spreadValue =
    Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? Number(bestAsk) - Number(bestBid) : undefined;
  let spreadPct: number | undefined;
  if (typeof spreadValue === 'number' && typeof midValue === 'number' && midValue > 0) {
    spreadPct = (spreadValue / midValue) * 100;
  }
  return {
    token_id: String(payload?.token_id ?? payload?.tokenId ?? ''),
    bids: parsedBids,
    asks: parsedAsks,
    best_bid: Number.isFinite(bestBid) ? Number(bestBid) : undefined,
    best_ask: Number.isFinite(bestAsk) ? Number(bestAsk) : undefined,
    spread: spreadValue,
    spread_pct: spreadPct,
    mid_price: midValue,
  };
}

export class ProbableAPI implements MakerApi {
  private config: ProbableConfig;
  private client: any;
  private apiReady = false;
  private cachedMarkets: Market[] = [];
  private cacheTimestamp = 0;
  private tokenIndex = new Map<string, Market>();

  constructor(config: ProbableConfig) {
    this.config = config;
    const normalized = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    const account = privateKeyToAccount(normalized as `0x${string}`);
    const chain = config.chainId === bscTestnet.id ? bscTestnet : bsc;
    const transport = config.rpcUrl ? http(config.rpcUrl) : http();
    const wallet = createWalletClient({ account, chain, transport });
    this.client = createClobClient({
      baseUrl: config.orderbookApiUrl,
      wsUrl: config.wsUrl,
      chainId: config.chainId,
      wallet,
    } as any);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getMarkets();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureApiKey(): Promise<void> {
    if (this.apiReady) return;
    try {
      const clientAny = this.client as any;
      if (typeof clientAny.generateApiKey === 'function') {
        await clientAny.generateApiKey();
      }
      this.apiReady = true;
    } catch {
      // ignore
    }
  }

  async getMarkets(): Promise<Market[]> {
    const ttl = 60000;
    if (this.cachedMarkets.length > 0 && Date.now() - this.cacheTimestamp < ttl) {
      return this.cachedMarkets.slice();
    }
    const limit = Math.min(500, Math.max(80, this.config.maxMarkets || 200));
    const url = joinUrl(this.config.marketApiUrl, '/public/api/v1/markets/');
    const response = await httpGetWithRetry(url, {
      params: { active: true, closed: false, limit },
      timeout: 10000,
    });
    const raw = response.data;
    const markets: ProbableMarket[] = Array.isArray(raw?.markets)
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

    const sortedMarkets = sortByLiquidityAndVolume(markets, getProbableLiquidity, getProbableVolume);

    const mapped: Market[] = [];
    for (const market of sortedMarkets) {
      if (market?.active === false || market?.closed === true) continue;
      const outcomes = toArray<string>(market.outcomes || market.outcomeNames);
      const tokens = toArray<string>(
        market.clobTokenIds || market.clob_token_ids || market.tokenIds || market.tokens
      );
      if (outcomes.length < 2 || tokens.length < 2) continue;
      const question = market.question || market.title || 'Probable Market';
      const eventId = String(market.id || market.marketId || '');
      const volume24h = getProbableVolume(market);
      const liquidity24h = getProbableLiquidity(market);
      for (let i = 0; i < Math.min(outcomes.length, tokens.length); i += 1) {
        const tokenId = String(tokens[i] || '');
        if (!tokenId) continue;
        const outcome = String(outcomes[i] || '');
        mapped.push({
          token_id: tokenId,
          question,
          condition_id: eventId,
          event_id: eventId,
          outcome,
          volume_24h: Number.isFinite(volume24h) ? volume24h : 0,
          liquidity_24h: Number.isFinite(liquidity24h) ? liquidity24h : 0,
          is_neg_risk: false,
          is_yield_bearing: false,
          fee_rate_bps: Number(this.config.feeBps || 0),
        });
      }
    }

    const rankedMapped = sortByLiquidityAndVolume(
      mapped,
      (market) => toFiniteNumber(market.liquidity_24h),
      (market) => toFiniteNumber(market.volume_24h)
    );

    this.cachedMarkets = rankedMapped;
    this.cacheTimestamp = Date.now();
    this.tokenIndex.clear();
    for (const market of rankedMapped) {
      this.tokenIndex.set(market.token_id, market);
    }
    return rankedMapped.slice();
  }

  async getMarket(tokenId: string): Promise<Market> {
    const cached = this.tokenIndex.get(tokenId);
    if (cached) return cached;
    await this.getMarkets();
    return (
      this.tokenIndex.get(tokenId) || {
        token_id: tokenId,
        question: 'Probable Market',
        is_neg_risk: false,
        is_yield_bearing: false,
        fee_rate_bps: Number(this.config.feeBps || 0),
      }
    );
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    const url = joinUrl(this.config.orderbookApiUrl, '/book');
    const response = await httpGetWithRetry(url, { params: { token_id: tokenId }, timeout: 8000 });
    const book = parseOrderbook(response.data);
    book.token_id = tokenId;
    return book;
  }

  async createOrder(payload: any): Promise<any> {
    await this.ensureApiKey();
    const order = payload?.order || payload;
    return (this.client as any).postOrder(order);
  }

  async removeOrders(orderIds: string[]): Promise<void> {
    if (!orderIds || orderIds.length === 0) return;
    const clientAny = this.client as any;
    if (typeof clientAny.cancelOrders === 'function') {
      await clientAny.cancelOrders(orderIds);
      return;
    }
    if (typeof clientAny.cancelOrder === 'function') {
      for (const id of orderIds) {
        await clientAny.cancelOrder(id);
      }
    }
  }

  async getOrders(_makerAddress: string): Promise<Order[]> {
    const clientAny = this.client as any;
    if (typeof clientAny.getOpenOrders !== 'function') {
      return [];
    }
    const response = await clientAny.getOpenOrders();
    const list = Array.isArray(response)
      ? response
      : Array.isArray(response?.orders)
      ? response.orders
      : Array.isArray(response?.data)
      ? response.data
      : [];
    return list
      .map((order: any) => {
        const tokenId = String(order?.tokenId ?? order?.token_id ?? '');
        if (!tokenId) return null;
        const sideRaw = order?.side ?? order?.orderSide ?? '';
        const side = String(sideRaw).toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
        const price = Number(order?.price ?? order?.pricePerShare ?? 0);
        const shares = Number(order?.size ?? order?.shares ?? order?.quantity ?? 0);
        const id = String(order?.id ?? order?.orderId ?? order?.orderID ?? '');
        if (!id) return null;
        return {
          order_hash: id,
          id,
          token_id: tokenId,
          maker: String(order?.maker ?? ''),
          signer: String(order?.signer ?? ''),
          order_type: 'LIMIT',
          side,
          price: String(price || 0),
          shares: String(shares || 0),
          is_neg_risk: false,
          is_yield_bearing: false,
          status: 'OPEN',
          timestamp: Date.now(),
        } as Order;
      })
      .filter((order: Order | null): order is Order => Boolean(order));
  }

  async getPositions(_makerAddress: string): Promise<Position[]> {
    return [];
  }
}
