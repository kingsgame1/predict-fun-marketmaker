import axios from 'axios';
import type { PlatformMarket, PlatformProvider } from './types.js';
import type { ProbableWebSocketFeed } from './probable-ws.js';

interface ProbableConfig {
  marketApiUrl: string;
  orderbookApiUrl: string;
  maxMarkets: number;
  feeBps: number;
  depthLevels?: number;
  useWebSocket?: boolean;
  requireWebSocket?: boolean;
  cacheTtlMs?: number;
  wsMaxAgeMs?: number;
}

interface ProbableMarket {
  id?: string;
  marketId?: string;
  question?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  clobTokenIds?: string[] | string;
  clob_token_ids?: string[] | string;
  tokenIds?: string[] | string;
  tokens?: string[] | string;
  outcomes?: string[] | string;
  outcomeNames?: string[] | string;
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

function ensureProbableApiPath(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (trimmed.includes('/public/api/v1')) {
    return `${trimmed}${suffix}`;
  }
  return `${trimmed}/public/api/v1${suffix}`;
}

function parseOrderbook(
  data: any,
  depthLevels?: number
): {
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  bids?: { price: number; shares: number }[];
  asks?: { price: number; shares: number }[];
} {
  const payload = data?.result || data?.data || data || {};
  const bids: any[] = payload?.bids || [];
  const asks: any[] = payload?.asks || [];

  const bidEntry = bids[0] || bids.sort((a, b) => Number(b.price) - Number(a.price))[0];
  const askEntry = asks[0] || asks.sort((a, b) => Number(a.price) - Number(b.price))[0];

  const bid = bidEntry ? Number(bidEntry.price ?? bidEntry[0]) : undefined;
  const ask = askEntry ? Number(askEntry.price ?? askEntry[0]) : undefined;
  const bidSize = bidEntry ? Number(bidEntry.size ?? bidEntry.shares ?? bidEntry[1]) : undefined;
  const askSize = askEntry ? Number(askEntry.size ?? askEntry.shares ?? askEntry[1]) : undefined;

  const bidLevels = bids
    .map((level) => ({
      price: Number(level.price ?? level[0]),
      shares: Number(level.size ?? level.shares ?? level[1]),
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.shares) && level.shares > 0)
    .sort((a, b) => b.price - a.price);

  const askLevels = asks
    .map((level) => ({
      price: Number(level.price ?? level[0]),
      shares: Number(level.size ?? level.shares ?? level[1]),
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.shares) && level.shares > 0)
    .sort((a, b) => a.price - b.price);

  const limit = depthLevels && depthLevels > 0 ? depthLevels : undefined;
  const limitedBids = limit ? bidLevels.slice(0, limit) : bidLevels;
  const limitedAsks = limit ? askLevels.slice(0, limit) : askLevels;

  return {
    bid: Number.isFinite(bid) ? bid : undefined,
    ask: Number.isFinite(ask) ? ask : undefined,
    bidSize: Number.isFinite(bidSize) ? bidSize : undefined,
    askSize: Number.isFinite(askSize) ? askSize : undefined,
    bids: limitedBids,
    asks: limitedAsks,
  };
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await fn(current));
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export class ProbableDataProvider implements PlatformProvider {
  platform: PlatformProvider['platform'] = 'Probable';
  private config: ProbableConfig;
  private wsFeed?: ProbableWebSocketFeed;
  private cachedMarkets: ProbableMarket[] = [];
  private cacheTimestamp = 0;

  constructor(config: ProbableConfig, wsFeed?: ProbableWebSocketFeed) {
    this.config = config;
    this.wsFeed = wsFeed;
  }

  async getMarkets(): Promise<PlatformMarket[]> {
    const results: PlatformMarket[] = [];
    const markets = await this.loadMarkets();
    const usable = markets.slice(0, this.config.maxMarkets);

    await mapWithLimit(usable, 6, async (market) => {
      const question = market.question || market.title || '';
      const outcomes = toArray<string>(market.outcomes || market.outcomeNames);
      const tokens = toArray<string>(
        market.clobTokenIds || market.clob_token_ids || market.tokenIds || market.tokens
      );

      if (outcomes.length < 2 || tokens.length < 2) {
        return;
      }

      const yesIndex = outcomes.findIndex((o) => String(o).toUpperCase() === 'YES');
      const noIndex = outcomes.findIndex((o) => String(o).toUpperCase() === 'NO');
      if (yesIndex < 0 || noIndex < 0) {
        return;
      }

      const yesTokenId = tokens[yesIndex];
      const noTokenId = tokens[noIndex];
      if (!yesTokenId || !noTokenId) {
        return;
      }

      if (this.wsFeed && this.config.useWebSocket) {
        this.wsFeed.subscribeTokens([yesTokenId, noTokenId]);
      }

      const yesBook = this.wsFeed?.getOrderbook(yesTokenId, this.config.wsMaxAgeMs);
      const noBook = this.wsFeed?.getOrderbook(noTokenId, this.config.wsMaxAgeMs);

      let yesTop = yesBook;
      let noTop = noBook;

      const needsDepth = (this.config.depthLevels || 0) > 0;
      const hasDepth = Boolean(yesBook?.bids?.length && yesBook?.asks?.length && noBook?.bids?.length && noBook?.asks?.length);

      if (this.config.requireWebSocket) {
        const hasTop = Boolean(yesTop?.bestBid && yesTop?.bestAsk && noTop?.bestBid && noTop?.bestAsk);
        if (!hasTop || (needsDepth && !hasDepth)) {
          return;
        }
      }

      if (!yesTop || !yesTop.bestBid || !yesTop.bestAsk || !noTop || !noTop.bestBid || !noTop.bestAsk || (needsDepth && !hasDepth)) {
        const base = this.config.orderbookApiUrl;
        const url = ensureProbableApiPath(base, '/book');
        const [yesRaw, noRaw] = await Promise.all([
          axios.get(url, { params: { token_id: yesTokenId }, timeout: 8000 }).then((r) => r.data),
          axios.get(url, { params: { token_id: noTokenId }, timeout: 8000 }).then((r) => r.data),
        ]);

        const yesParsed = parseOrderbook(yesRaw, this.config.depthLevels);
        const noParsed = parseOrderbook(noRaw, this.config.depthLevels);
        yesTop = {
          bestBid: yesParsed.bid,
          bestAsk: yesParsed.ask,
          bidSize: yesParsed.bidSize,
          askSize: yesParsed.askSize,
          bids: yesParsed.bids,
          asks: yesParsed.asks,
        };
        noTop = {
          bestBid: noParsed.bid,
          bestAsk: noParsed.ask,
          bidSize: noParsed.bidSize,
          askSize: noParsed.askSize,
          bids: noParsed.bids,
          asks: noParsed.asks,
        };
      }

      if (!yesTop?.bestBid || !yesTop?.bestAsk || !noTop?.bestBid || !noTop?.bestAsk) {
        return;
      }

      results.push({
        platform: 'Probable',
        marketId: market.id || market.marketId || `${yesTokenId}-${noTokenId}`,
        question,
        yesTokenId,
        noTokenId,
        yesBid: yesTop.bestBid,
        yesAsk: yesTop.bestAsk,
        noBid: noTop.bestBid,
        noAsk: noTop.bestAsk,
        yesBidSize: yesTop.bidSize,
        yesAskSize: yesTop.askSize,
        noBidSize: noTop.bidSize,
        noAskSize: noTop.askSize,
        yesMid: (yesTop.bestBid + yesTop.bestAsk) / 2,
        noMid: (noTop.bestBid + noTop.bestAsk) / 2,
        feeBps: this.config.feeBps,
        yesBids: yesTop.bids,
        yesAsks: yesTop.asks,
        noBids: noTop.bids,
        noAsks: noTop.asks,
        timestamp: Date.now(),
      });
    });

    return results;
  }

  private async loadMarkets(): Promise<ProbableMarket[]> {
    const ttl = this.config.cacheTtlMs ?? 60000;
    if (this.cachedMarkets.length > 0 && Date.now() - this.cacheTimestamp < ttl) {
      return this.cachedMarkets.slice(0, this.config.maxMarkets);
    }

    const url = ensureProbableApiPath(this.config.marketApiUrl, '/markets/');
    const response = await axios.get(url, {
      params: {
        active: true,
        closed: false,
        limit: this.config.maxMarkets,
      },
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

    const usable = markets.filter((m) => (m.active ?? true) && !(m.closed ?? false));
    this.cachedMarkets = usable;
    this.cacheTimestamp = Date.now();
    return usable;
  }
}
