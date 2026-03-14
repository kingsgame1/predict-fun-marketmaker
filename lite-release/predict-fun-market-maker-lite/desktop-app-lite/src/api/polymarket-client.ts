import axios from 'axios';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import type { MakerApi } from '../mm/venue.js';
import type { Market, Order, Orderbook, OrderbookEntry, Position } from '../types.js';

interface PolymarketConfig {
  gammaUrl: string;
  clobUrl: string;
  privateKey: string;
  chainId: number;
  maxMarkets?: number;
  feeBps?: number;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  autoDeriveApiKey?: boolean;
}

interface GammaMarket {
  id?: string;
  conditionId?: string;
  condition_id?: string;
  question?: string;
  title?: string;
  description?: string;
  slug?: string;
  market_slug?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  accepting_orders?: boolean;
  endDate?: string;
  end_date?: string;
  volume?: number | string;
  volume24hr?: number | string;
  liquidity?: number | string;
  liquidityNum?: number | string;
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
  outcomePrices?: number[] | string;
  markets?: any[];
}

interface SimplifiedRewardRate {
  asset_address?: string;
  rewards_daily_rate?: number | string;
}

interface SimplifiedRewards {
  rates?: SimplifiedRewardRate[];
  min_size?: number | string;
  max_spread?: number | string;
  event_start_date?: string;
  event_end_date?: string;
  in_game_multiplier?: number | string;
  reward_epoch?: number | string;
}

interface SimplifiedMarket {
  condition_id?: string;
  rewards?: SimplifiedRewards;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
}

interface RewardSnapshot {
  conditionId: string;
  rewardEnabled: boolean;
  rewardMinSize: number;
  rewardMaxSpread: number;
  rewardDailyRate: number;
  rewardHourlyRate: number;
  rewardEpoch?: number;
  inGameMultiplier?: number;
  acceptingOrders?: boolean;
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

function toFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toOptionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return undefined;
}

function normalizeRewardSpread(value: unknown): number {
  const numeric = toFiniteNumber(value);
  if (!numeric) return 0;
  return numeric > 1 ? numeric / 100 : numeric;
}

function mapEntries(levels: any[], side: 'bids' | 'asks'): OrderbookEntry[] {
  return levels
    .map((level) => ({
      price: String(level?.price ?? level?.priceFloat ?? level?.[0] ?? ''),
      shares: String(level?.size ?? level?.shares ?? level?.[1] ?? ''),
    }))
    .filter((entry) => {
      const price = Number(entry.price);
      const shares = Number(entry.shares);
      return Number.isFinite(price) && price > 0 && Number.isFinite(shares) && shares > 0;
    })
    .sort((a, b) => (side === 'bids' ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price)));
}

function buildOrderbook(tokenId: string, payload: any): Orderbook {
  const bids = mapEntries(Array.isArray(payload?.bids) ? payload.bids : [], 'bids');
  const asks = mapEntries(Array.isArray(payload?.asks) ? payload.asks : [], 'asks');
  const bestBid = bids.length > 0 ? Number(bids[0].price) : undefined;
  const bestAsk = asks.length > 0 ? Number(asks[0].price) : undefined;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;
  return {
    token_id: tokenId,
    bids,
    asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread,
    spread_pct: spread !== undefined && mid ? (spread / mid) * 100 : undefined,
    mid_price: mid,
  };
}

function buildRewardSnapshot(entry: SimplifiedMarket): RewardSnapshot | null {
  const conditionId = String(entry?.condition_id || '').trim();
  if (!conditionId) return null;
  const rewards = entry?.rewards || {};
  const dailyRate = Array.isArray(rewards.rates)
    ? rewards.rates.reduce((sum, rate) => sum + toFiniteNumber(rate?.rewards_daily_rate), 0)
    : 0;
  const minSize = toFiniteNumber(rewards.min_size);
  const maxSpread = normalizeRewardSpread(rewards.max_spread);
  const rewardEnabled = dailyRate > 0 || minSize > 0 || maxSpread > 0;
  return {
    conditionId,
    rewardEnabled,
    rewardMinSize: minSize,
    rewardMaxSpread: maxSpread,
    rewardDailyRate: dailyRate,
    rewardHourlyRate: dailyRate > 0 ? dailyRate / 24 : 0,
    rewardEpoch: toFiniteNumber(rewards.reward_epoch) || undefined,
    inGameMultiplier: toFiniteNumber(rewards.in_game_multiplier) || undefined,
    acceptingOrders: toOptionalBoolean(entry.accepting_orders),
  };
}

export class PolymarketAPI implements MakerApi {
  private config: PolymarketConfig;
  private client: ClobClient;
  private cachedMarkets: Market[] = [];
  private cacheTimestamp = 0;
  private tokenIndex = new Map<string, Market>();
  private rewardIndex = new Map<string, RewardSnapshot>();
  private rewardCacheTimestamp = 0;
  private credsReady = false;

  constructor(config: PolymarketConfig) {
    this.config = config;
    const rawPrivateKey = String(config.privateKey || '').trim();
    const fallbackPrivateKey = '0x' + '11'.repeat(32);
    const normalized = rawPrivateKey ? (rawPrivateKey.startsWith('0x') ? rawPrivateKey : '0x' + rawPrivateKey) : fallbackPrivateKey;
    const signer = new Wallet(normalized);
    this.client = new ClobClient(config.clobUrl.replace(/\/+$/g, ''), config.chainId, signer);
    const clientAny = this.client as any;
    if (config.apiKey && config.apiSecret && config.apiPassphrase) {
      clientAny.creds = {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
      };
      this.credsReady = true;
    }
  }

  private async ensureApiCreds(): Promise<void> {
    if (this.credsReady || this.config.autoDeriveApiKey === false) return;
    const clientAny = this.client as any;
    let creds: any;
    if (typeof clientAny.deriveApiKey === 'function') {
      creds = await clientAny.deriveApiKey();
    } else if (typeof clientAny.createApiKey === 'function') {
      creds = await clientAny.createApiKey();
    } else if (typeof clientAny.createOrDeriveApiKey === 'function') {
      creds = await clientAny.createOrDeriveApiKey();
    }
    if (creds) {
      clientAny.creds = {
        key: creds.apiKey || creds.key,
        secret: creds.apiSecret || creds.secret,
        passphrase: creds.apiPassphrase || creds.passphrase,
      };
      this.credsReady = true;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getMarkets();
      return true;
    } catch {
      return false;
    }
  }

  private async loadGammaMarkets(): Promise<GammaMarket[]> {
    const limit = Math.max(60, this.config.maxMarkets || 120);
    const url = this.config.gammaUrl.replace(/\/+$/g, '') + '/markets';
    const response = await axios.get(url, {
      params: { active: true, closed: false, limit },
      timeout: 12000,
    });
    const raw = response.data;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.markets)
      ? raw.markets
      : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw?.data?.markets)
      ? raw.data.markets
      : [];
    return list.flatMap((entry: GammaMarket) => {
      if (Array.isArray(entry?.markets) && entry.markets.length > 0) {
        return entry.markets.map((child) => ({ ...entry, ...child }));
      }
      return [entry];
    });
  }

  private async loadRewardMarkets(): Promise<Map<string, RewardSnapshot>> {
    const ttl = 120000;
    if (this.rewardIndex.size > 0 && Date.now() - this.rewardCacheTimestamp < ttl) {
      return new Map(this.rewardIndex);
    }

    const baseUrl = this.config.clobUrl.replace(/\/+$/g, '');
    const endpoints = ['/sampling-simplified-markets', '/simplified-markets'];
    const nextIndex = new Map<string, RewardSnapshot>();

    for (const endpoint of endpoints) {
      let nextCursor = '';
      let pages = 0;
      try {
        while (pages < 20) {
          const response = await axios.get(baseUrl + endpoint, {
            params: nextCursor ? { next_cursor: nextCursor } : {},
            timeout: 12000,
          });
          const payload = response.data || {};
          const data = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.data)
            ? payload.data
            : [];

          for (const entry of data as SimplifiedMarket[]) {
            const snapshot = buildRewardSnapshot(entry);
            if (!snapshot || !snapshot.rewardEnabled) continue;
            nextIndex.set(snapshot.conditionId, snapshot);
          }

          nextCursor = String(payload?.next_cursor || '');
          pages += 1;
          if (!nextCursor || nextCursor === 'LTE=') {
            break;
          }
        }
      } catch {
        continue;
      }
      if (nextIndex.size > 0) {
        break;
      }
    }

    this.rewardIndex = nextIndex;
    this.rewardCacheTimestamp = Date.now();
    return new Map(this.rewardIndex);
  }

  private getMarketPriority(market: Market): number {
    const liquidity = Math.log10(Number(market.liquidity_24h || 0) + 1) * 4;
    const volume = Math.log10(Number(market.volume_24h || 0) + 1) * 2.5;
    const rewardDaily = Number(market.polymarket_reward_daily_rate || 0);
    const rewardMaxSpread = Number(market.polymarket_reward_max_spread || 0);
    const rewardScore = market.polymarket_rewards_enabled
      ? 6 + Math.log10(rewardDaily + 1) * 5 + Math.min(3, rewardMaxSpread * 60)
      : 0;
    return liquidity + volume + rewardScore;
  }

  async getMarkets(): Promise<Market[]> {
    const ttl = 60000;
    if (this.cachedMarkets.length > 0 && Date.now() - this.cacheTimestamp < ttl) {
      return this.cachedMarkets.slice();
    }

    const [rawMarkets, rewardIndex] = await Promise.all([this.loadGammaMarkets(), this.loadRewardMarkets()]);
    const mapped: Market[] = [];

    for (const item of rawMarkets) {
      if (item?.active === false || item?.closed === true || item?.archived === true) continue;
      const outcomes = toArray<string>(item.outcomes);
      const tokenIds = toArray<string>(item.clobTokenIds);
      if (outcomes.length === 0 || tokenIds.length === 0) continue;

      const question = item.question || item.title || 'Polymarket Market';
      const conditionId = String(item.conditionId || item.condition_id || item.id || '').trim();
      const eventId = String(item.id || conditionId).trim();
      const slug = String(item.slug || item.market_slug || '').trim();
      const marketUrl = slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : undefined;
      const volume24h = toFiniteNumber(item.volume24hr, item.volume);
      const liquidity24h = toFiniteNumber(item.liquidityNum, item.liquidity);
      const rewards = rewardIndex.get(conditionId);
      const acceptingOrders = toOptionalBoolean(item.acceptingOrders, item.accepting_orders, rewards?.acceptingOrders);

      for (let i = 0; i < Math.min(outcomes.length, tokenIds.length); i += 1) {
        const tokenId = String(tokenIds[i] || '').trim();
        if (!tokenId) continue;
        mapped.push({
          token_id: tokenId,
          question,
          description: item.description,
          venue: 'polymarket',
          condition_id: conditionId || eventId,
          event_id: eventId,
          market_url: marketUrl,
          market_slug: slug || undefined,
          outcome: String(outcomes[i] || ''),
          end_date: String(item.endDate || item.end_date || ''),
          is_neg_risk: false,
          is_yield_bearing: false,
          fee_rate_bps: Number(this.config.feeBps || 0),
          volume_24h: volume24h,
          liquidity_24h: liquidity24h,
          polymarket_rewards_enabled: rewards?.rewardEnabled || false,
          polymarket_reward_min_size: rewards?.rewardMinSize,
          polymarket_reward_max_spread: rewards?.rewardMaxSpread,
          polymarket_reward_daily_rate: rewards?.rewardDailyRate,
          polymarket_reward_hourly_rate: rewards?.rewardHourlyRate,
          polymarket_reward_epoch: rewards?.rewardEpoch,
          polymarket_reward_in_game_multiplier: rewards?.inGameMultiplier,
          polymarket_accepting_orders: acceptingOrders,
        });
      }
    }

    mapped.sort((a, b) => this.getMarketPriority(b) - this.getMarketPriority(a));
    this.cachedMarkets = mapped;
    this.cacheTimestamp = Date.now();
    this.tokenIndex.clear();
    for (const market of mapped) {
      this.tokenIndex.set(market.token_id, market);
    }
    return mapped.slice();
  }

  async getMarket(tokenId: string): Promise<Market> {
    const cached = this.tokenIndex.get(tokenId);
    if (cached) return cached;
    await this.getMarkets();
    return this.tokenIndex.get(tokenId) || {
      token_id: tokenId,
      question: 'Polymarket Market',
      venue: 'polymarket',
      is_neg_risk: false,
      is_yield_bearing: false,
      fee_rate_bps: Number(this.config.feeBps || 0),
    };
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    try {
      const clientAny = this.client as any;
      const payload = typeof clientAny.getOrderBook === 'function'
        ? await clientAny.getOrderBook(tokenId)
        : await axios.get(this.config.clobUrl.replace(/\/+$/g, '') + '/book', {
            params: { token_id: tokenId },
            timeout: 10000,
          }).then((res) => res.data);
      return buildOrderbook(tokenId, payload);
    } catch {
      const payload = await axios.get(this.config.clobUrl.replace(/\/+$/g, '') + '/book', {
        params: { token_id: tokenId },
        timeout: 10000,
      }).then((res) => res.data);
      return buildOrderbook(tokenId, payload);
    }
  }

  async createOrder(payload: any): Promise<any> {
    await this.ensureApiCreds();
    const clientAny = this.client as any;
    const order = payload?.order || payload;
    const orderType = payload?.orderType || 'GTC';
    return await clientAny.postOrder(order, orderType);
  }

  async removeOrders(orderIds: string[]): Promise<void> {
    if (!orderIds || orderIds.length === 0) return;
    await this.ensureApiCreds();
    const clientAny = this.client as any;
    if (typeof clientAny.cancelOrders === 'function') {
      await clientAny.cancelOrders(orderIds);
      return;
    }
    if (typeof clientAny.cancelOrder === 'function') {
      for (const orderId of orderIds) {
        await clientAny.cancelOrder(orderId);
      }
    }
  }

  async getOrders(makerAddress: string): Promise<Order[]> {
    await this.ensureApiCreds();
    const clientAny = this.client as any;
    if (typeof clientAny.getOpenOrders !== 'function') {
      return [];
    }
    const response = await clientAny.getOpenOrders({ owner: makerAddress });
    const list = Array.isArray(response)
      ? response
      : Array.isArray(response?.orders)
      ? response.orders
      : Array.isArray(response?.data)
      ? response.data
      : [];

    return list.map((order: any) => ({
      id: order?.id ? String(order.id) : undefined,
      order_hash: String(order?.orderID || order?.orderId || order?.order_hash || order?.hash || order?.id || ''),
      token_id: String(order?.asset_id || order?.tokenId || order?.token_id || ''),
      maker: String(order?.owner || order?.maker || makerAddress || ''),
      signer: order?.signer ? String(order.signer) : undefined,
      order_type: 'LIMIT',
      side: String(order?.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: String(order?.price ?? order?.limit_price ?? ''),
      shares: String(order?.original_size ?? order?.size ?? order?.quantity ?? ''),
      is_neg_risk: false,
      is_yield_bearing: false,
      fee_rate_bps: Number(this.config.feeBps || 0),
      status: 'OPEN',
      timestamp: Date.now(),
    })).filter((order: Order) => Boolean(order.order_hash) && Boolean(order.token_id));
  }

  async getPositions(_makerAddress: string): Promise<Position[]> {
    return [];
  }
}
