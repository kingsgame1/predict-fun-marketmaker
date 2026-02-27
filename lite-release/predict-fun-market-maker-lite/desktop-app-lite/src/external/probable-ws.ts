import type { PlatformOrderbook } from './types.js';
import { createClobClient } from '@prob/clob';

export interface ProbableWsConfig {
  baseUrl: string;
  wsUrl: string;
  chainId: number;
  staleTimeoutMs?: number;
  resetOnReconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

type OrderbookLevels = { price: number; shares: number }[];

interface OrderbookState {
  bids: OrderbookLevels;
  asks: OrderbookLevels;
  bestBid?: number;
  bestAsk?: number;
  bidSize?: number;
  askSize?: number;
  timestamp: number;
}

export class ProbableWebSocketFeed {
  private config: ProbableWsConfig;
  private client: any;
  private subscription: any;
  private connected = false;
  private reconnectDelay: number;
  private reconnectTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private subscribed = new Set<string>();
  private books = new Map<string, OrderbookState>();
  private lastMessageAt = 0;
  private messageCount = 0;
  private hasConnected = false;
  private orderbookSubscribers = new Set<(tokenId: string, orderbook: PlatformOrderbook) => void>();

  constructor(config: ProbableWsConfig) {
    this.config = config;
    this.reconnectDelay = config.reconnectMinMs ?? 1000;
    this.client = createClobClient({
      baseUrl: config.baseUrl,
      wsUrl: config.wsUrl,
      chainId: config.chainId,
    } as any);
  }

  start(): void {
    if (this.subscription || this.connected) {
      return;
    }
    if (this.subscribed.size === 0) {
      return;
    }
    this.subscribeInternal();
    this.startStaleMonitor();
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
    }
    this.unsubscribeInternal();
    this.connected = false;
  }

  subscribeTokens(tokenIds: string[]): void {
    const fresh = tokenIds.filter((id) => id && !this.subscribed.has(id));
    if (fresh.length === 0 && this.subscription) {
      return;
    }
    fresh.forEach((id) => this.subscribed.add(id));
    if (this.subscribed.size > 0) {
      this.refreshSubscription();
    }
  }

  onOrderbook(callback: (tokenId: string, orderbook: PlatformOrderbook) => void): () => void {
    this.orderbookSubscribers.add(callback);
    return () => {
      this.orderbookSubscribers.delete(callback);
    };
  }

  getStatus(): {
    connected: boolean;
    subscribed: number;
    cacheSize: number;
    lastMessageAt: number;
    messageCount: number;
  } {
    return {
      connected: this.connected,
      subscribed: this.subscribed.size,
      cacheSize: this.books.size,
      lastMessageAt: this.lastMessageAt,
      messageCount: this.messageCount,
    };
  }

  getOrderbook(tokenId: string, maxAgeMs?: number): PlatformOrderbook | undefined {
    const book = this.books.get(tokenId);
    if (!book) {
      return undefined;
    }
    if (maxAgeMs && Date.now() - book.timestamp > maxAgeMs) {
      return undefined;
    }
    return {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      bidSize: book.bidSize,
      askSize: book.askSize,
      bids: book.bids,
      asks: book.asks,
    };
  }

  private refreshSubscription(): void {
    if (this.subscription) {
      this.unsubscribeInternal();
    }
    this.subscribeInternal();
  }

  private subscribeInternal(): void {
    const topics = Array.from(this.subscribed).map((tokenId) => `book:${tokenId}`);
    if (topics.length === 0) {
      return;
    }
    try {
      this.subscription = this.client.subscribePublicStream(topics, (message: any) => this.onMessage(message));
      if (this.subscription?.on) {
        this.subscription.on('open', () => this.onOpen());
        this.subscription.on('close', () => this.onClose());
        this.subscription.on('error', () => this.onClose());
      } else {
        this.onOpen();
      }
    } catch (error) {
      console.warn('Probable WS subscribe failed:', error);
      this.scheduleReconnect();
    }
  }

  private unsubscribeInternal(): void {
    if (this.subscription?.unsubscribe) {
      try {
        this.subscription.unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscription = undefined;
    this.connected = false;
  }

  private onOpen(): void {
    this.connected = true;
    this.reconnectDelay = this.config.reconnectMinMs ?? 1000;
    if (this.hasConnected && this.config.resetOnReconnect !== false) {
      this.books.clear();
    }
    this.hasConnected = true;
    this.lastMessageAt = Date.now();
  }

  private onClose(): void {
    this.connected = false;
    this.subscription = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const maxDelay = this.config.reconnectMaxMs ?? 15000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.refreshSubscription();
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, maxDelay);
    }, this.reconnectDelay);
  }

  private startStaleMonitor(): void {
    const timeoutMs = this.config.staleTimeoutMs ?? 0;
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
    }
    const interval = Math.min(timeoutMs, 5000);
    this.staleTimer = setInterval(() => {
      if (!this.connected) return;
      if (!this.lastMessageAt) return;
      if (Date.now() - this.lastMessageAt > timeoutMs) {
        this.refreshSubscription();
      }
    }, interval);
  }

  private onMessage(message: any): void {
    this.lastMessageAt = Date.now();
    this.messageCount += 1;
    const tokenId = this.extractTokenId(message);
    if (!tokenId) {
      return;
    }
    const payload = this.extractPayload(message);
    const bids = this.parseLevels(payload?.bids || payload?.book?.bids, 'BID');
    const asks = this.parseLevels(payload?.asks || payload?.book?.asks, 'ASK');

    let bestBid = payload?.bestBid ?? payload?.best_bid;
    let bestAsk = payload?.bestAsk ?? payload?.best_ask;
    let bidSize = payload?.bidSize ?? payload?.bid_size;
    let askSize = payload?.askSize ?? payload?.ask_size;

    if ((!bestBid || !bidSize) && bids.length > 0) {
      bestBid = bids[0].price;
      bidSize = bids[0].shares;
    }
    if ((!bestAsk || !askSize) && asks.length > 0) {
      bestAsk = asks[0].price;
      askSize = asks[0].shares;
    }

    const snapshot: OrderbookState = {
      bids,
      asks,
      bestBid: Number.isFinite(Number(bestBid)) ? Number(bestBid) : undefined,
      bestAsk: Number.isFinite(Number(bestAsk)) ? Number(bestAsk) : undefined,
      bidSize: Number.isFinite(Number(bidSize)) ? Number(bidSize) : undefined,
      askSize: Number.isFinite(Number(askSize)) ? Number(askSize) : undefined,
      timestamp: Date.now(),
    };

    if (!snapshot.bestBid || !snapshot.bestAsk) {
      return;
    }

    this.books.set(tokenId, snapshot);
    const orderbook: PlatformOrderbook = {
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      bidSize: snapshot.bidSize,
      askSize: snapshot.askSize,
      bids: snapshot.bids,
      asks: snapshot.asks,
    };
    for (const cb of this.orderbookSubscribers) {
      cb(tokenId, orderbook);
    }
  }

  private extractTokenId(message: any): string | null {
    const topic = message?.topic || message?.channel || message?.stream;
    if (typeof topic === 'string' && topic.startsWith('book:')) {
      return topic.slice(5);
    }
    const tokenId = message?.token_id || message?.tokenId || message?.asset_id || message?.assetId || message?.data?.token_id;
    return tokenId ? String(tokenId) : null;
  }

  private extractPayload(message: any): any {
    if (!message) return {};
    if (message.data) return message.data;
    if (message.payload) return message.payload;
    if (message.book) return message;
    return message;
  }

  private parseLevels(raw: any, side: 'BID' | 'ASK'): OrderbookLevels {
    if (!Array.isArray(raw)) {
      return [];
    }
    const levels = raw
      .map((level) => ({
        price: Number(level?.price ?? level?.[0]),
        shares: Number(level?.size ?? level?.shares ?? level?.[1]),
      }))
      .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.shares) && level.shares > 0)
      .sort((a, b) => (side === 'BID' ? b.price - a.price : a.price - b.price));
    return levels;
  }
}
