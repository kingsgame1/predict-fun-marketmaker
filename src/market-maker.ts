/**
 * Market Maker Core
 * Production-oriented quoting + risk controls
 */

import type { Config, Market, Orderbook, Order, OrderbookEntry, Position } from './types.js';
import { PredictAPI } from './api/client.js';
import { OrderManager } from './order-manager.js';
import { ValueMismatchDetector } from './arbitrage/value-detector.js';
import { estimateBuy, estimateSell } from './arbitrage/orderbook-vwap.js';
import { CrossPlatformAggregator } from './external/aggregator.js';
import { CrossPlatformExecutionRouter } from './external/execution.js';
import { findBestMatch } from './external/match.js';
import type { PlatformLeg, PlatformMarket } from './external/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface QuotePrices {
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spread: number;
  pressure?: number;
  inventoryBias: number;
  valueBias?: number;
  valueConfidence?: number;
  depth?: number;
  depthTrend?: number;
  imbalance?: number;
  profile?: 'CALM' | 'NORMAL' | 'VOLATILE';
  volatility?: number;
}

interface OrderSizeResult {
  shares: number;
  usdt: number;
}

export class MarketMaker {
  private static readonly MIN_TICK = 0.0001;
  private static readonly MAX_ALLOWED_BOOK_SPREAD = 0.2;

  private readonly api: PredictAPI;
  private readonly config: Config;

  private openOrders: Map<string, Order> = new Map();
  private positions: Map<string, Position> = new Map();
  private lastPrices: Map<string, number> = new Map();
  private lastPriceAt: Map<string, number> = new Map();
  private lastBestBid: Map<string, number> = new Map();
  private lastBestAsk: Map<string, number> = new Map();
  private lastBestAt: Map<string, number> = new Map();
  private lastBestBidSize: Map<string, number> = new Map();
  private lastBestAskSize: Map<string, number> = new Map();
  private prevBestBid: Map<string, number> = new Map();
  private prevBestAsk: Map<string, number> = new Map();
  private prevBestAt: Map<string, number> = new Map();
  private prevBestBidSize: Map<string, number> = new Map();
  private prevBestAskSize: Map<string, number> = new Map();
  private lastBidDeltaBps: Map<string, number> = new Map();
  private lastAskDeltaBps: Map<string, number> = new Map();
  private prevBidDeltaBps: Map<string, number> = new Map();
  private prevAskDeltaBps: Map<string, number> = new Map();
  private lastBookSpread: Map<string, number> = new Map();
  private lastBookSpreadAt: Map<string, number> = new Map();
  private volatilityEma: Map<string, number> = new Map();
  private depthEma: Map<string, number> = new Map();
  private totalDepthEma: Map<string, number> = new Map();
  private depthTrend: Map<string, number> = new Map();
  private lastDepth: Map<string, number> = new Map();
  private lastDepthSpeedBps: Map<string, number> = new Map();
  private lastBidDepthSpeedBps: Map<string, number> = new Map();
  private lastAskDepthSpeedBps: Map<string, number> = new Map();
  private lastImbalance: Map<string, number> = new Map();
  private lastActionAt: Map<string, number> = new Map();
  private actionBurst: Map<string, { count: number; windowStart: number }> = new Map();
  private actionLockUntil: Map<string, number> = new Map();
  private cooldownUntil: Map<string, number> = new Map();
  private pauseUntil: Map<string, number> = new Map();
  private lastNetShares: Map<string, number> = new Map();
  private lastHedgeAt: Map<string, number> = new Map();
  private lastIcebergAt: Map<string, number> = new Map();
  private lastFillAt: Map<string, number> = new Map();
  private lastProfile: Map<string, 'CALM' | 'NORMAL' | 'VOLATILE'> = new Map();
  private lastProfileAt: Map<string, number> = new Map();
  private icebergPenalty: Map<string, { value: number; ts: number }> = new Map();
  private nearTouchHoldUntil: Map<string, number> = new Map();
  private repriceHoldUntil: Map<string, number> = new Map();
  private cancelHoldUntil: Map<string, number> = new Map();
  private sizePenalty: Map<string, { value: number; ts: number; auto?: boolean }> = new Map();
  private recheckCooldownUntil: Map<string, number> = new Map();
  private fillPressure: Map<string, { score: number; ts: number }> = new Map();
  private cancelBoost: Map<string, { value: number; ts: number }> = new Map();
  private nearTouchPenalty: Map<string, { value: number; ts: number }> = new Map();
  private fillPenalty: Map<string, { value: number; ts: number }> = new Map();
  private layerPanicUntil: Map<string, number> = new Map();
  private layerRetreatUntil: Map<string, number> = new Map();
  private layerRestoreAt: Map<string, number> = new Map();
  private layerRestoreStartAt: Map<string, number> = new Map();
  private layerRestoreExitPending: Map<string, boolean> = new Map();
  private layerRestoreExitRampStartAt: Map<string, number> = new Map();
  private layerRestoreExitRampUntil: Map<string, number> = new Map();
  private layerRestoreExitSizeRampStartAt: Map<string, number> = new Map();
  private layerRestoreExitSizeRampUntil: Map<string, number> = new Map();
  private layerRestoreExitRepricePending: Set<string> = new Set();
  private safeModeExitUntil: Map<string, number> = new Map();
  private autoTuneState: Map<
    string,
    { mult: number; windowStart: number; placed: number; canceled: number; filled: number; lastUpdate: number }
  > = new Map();
  private mmMetrics: Map<string, Record<string, unknown>> = new Map();
  private mmLastFlushAt = 0;
  private valueDetector?: ValueMismatchDetector;
  private crossAggregator?: CrossPlatformAggregator;
  private crossExecutionRouter?: CrossPlatformExecutionRouter;

  private orderManager?: OrderManager;
  private tradingHalted = false;
  private sessionPnL = 0;
  private warnedNoExecution = false;

  constructor(api: PredictAPI, config: Config) {
    this.api = api;
    this.config = config;
    if (this.config.useValueSignal) {
      this.valueDetector = new ValueMismatchDetector(0, 0);
    }
    if (this.config.hedgeMode === 'CROSS' || this.config.crossPlatformEnabled) {
      this.crossAggregator = new CrossPlatformAggregator(this.config);
    }
  }

  async initialize(): Promise<void> {
    if (!this.config.enableTrading) {
      return;
    }

    if (!this.config.jwtToken) {
      throw new Error('ENABLE_TRADING=true requires JWT_TOKEN in .env');
    }

    this.orderManager = await OrderManager.create(this.config);
    console.log(`✅ OrderManager initialized (maker: ${this.orderManager.getMakerAddress()})`);

    if (this.config.hedgeMode === 'CROSS' && this.crossAggregator) {
      this.crossExecutionRouter = new CrossPlatformExecutionRouter(this.config, this.api, this.orderManager);
    }
  }

  async updateState(makerAddress: string): Promise<void> {
    try {
      const orders = await this.api.getOrders(makerAddress);
      this.openOrders.clear();
      for (const order of orders) {
        if (order.status === 'OPEN') {
          this.openOrders.set(order.order_hash, order);
        }
      }

      const positionsData = await this.api.getPositions(makerAddress);
      this.positions.clear();

      for (const pos of positionsData) {
        const tokenId = String(pos.token_id ?? pos.tokenId ?? pos.market?.tokenId ?? '');
        if (!tokenId) {
          continue;
        }

        const current = this.positions.get(tokenId) || {
          token_id: tokenId,
          question: pos.question || pos.market?.question || 'Unknown',
          yes_amount: 0,
          no_amount: 0,
          total_value: 0,
          avg_entry_price: 0,
          current_price: 0,
          pnl: 0,
        };

        const outcome = String(pos.outcome ?? pos.side ?? '').toUpperCase();
        const size = Number(pos.amount ?? pos.shares ?? pos.size ?? 0);

        if (outcome === 'YES' || outcome === 'BUY_YES') {
          current.yes_amount += size;
        } else if (outcome === 'NO' || outcome === 'BUY_NO') {
          current.no_amount += size;
        } else {
          current.yes_amount += Number(pos.yes_amount ?? 0);
          current.no_amount += Number(pos.no_amount ?? 0);
        }

        current.total_value += Number(pos.total_value ?? pos.value ?? 0);
        current.avg_entry_price = Number(pos.avg_price ?? pos.avgEntryPrice ?? current.avg_entry_price);
        current.current_price = Number(pos.current_price ?? pos.currentPrice ?? current.current_price);
        current.pnl += Number(pos.pnl ?? 0);

        this.positions.set(tokenId, current);
      }

      this.sessionPnL = Array.from(this.positions.values()).reduce((sum, p) => sum + p.pnl, 0);

      const maxDailyLoss = this.getEffectiveMaxDailyLoss();
      if (this.sessionPnL <= -Math.abs(maxDailyLoss)) {
        if (!this.tradingHalted) {
          console.log(`🛑 Trading halted: session PnL ${this.sessionPnL.toFixed(2)} <= -${Math.abs(maxDailyLoss)}`);
        }
        this.tradingHalted = true;
      }

      console.log(
        `📈 State updated: ${this.openOrders.size} open orders, ${this.positions.size} positions, session PnL ${this.sessionPnL.toFixed(2)}`
      );

      if (this.config.hedgeOnFill && this.orderManager) {
        await this.detectAndHedgeFills();
      }
    } catch (error) {
      console.error('Error updating state:', error);
    }
  }

  shouldCancelOrders(tokenId: string, orderbook: Orderbook): boolean {
    const lastPrice = this.lastPrices.get(tokenId);
    if (!lastPrice || !orderbook.mid_price || lastPrice <= 0) {
      return false;
    }

    const priceChange = Math.abs(orderbook.mid_price - lastPrice) / lastPrice;
    const base = this.config.cancelThreshold;
    const mult = this.getVolatilityMultiplier(tokenId, this.config.mmCancelVolMultiplier ?? 2);
    const boost = this.getCancelBoost(tokenId);
    const noFill = this.getNoFillPenalty(tokenId);
    let threshold = (base + (noFill.cancelBps || 0) / 10000) / mult / boost;
    let buffer = Math.max(0, this.config.mmCancelBufferBps ?? 0);
    if (
      this.isSafeModeActive(tokenId, {
        volEma: this.volatilityEma.get(tokenId) ?? 0,
        depthTrend: this.depthTrend.get(tokenId) ?? 0,
        depthSpeedBps: this.lastDepthSpeedBps.get(tokenId) ?? 0,
      })
    ) {
      const mult = Math.max(1, this.config.mmSafeModeCancelThresholdMult ?? 1);
      threshold = threshold / mult;
      const add = Math.max(0, this.config.mmSafeModeCancelBufferAddBps ?? 0);
      if (add > 0) {
        buffer += add / 10000;
      }
    }
    const hard = threshold * (1 + buffer);
    if (priceChange > hard) {
      this.cancelHoldUntil.delete(tokenId);
      return true;
    }
    if (priceChange > threshold) {
      const confirmMs = Math.max(0, this.config.mmCancelConfirmMs ?? 0);
      if (confirmMs <= 0) {
        return true;
      }
      const until = this.cancelHoldUntil.get(tokenId) || 0;
      if (!until) {
        this.cancelHoldUntil.set(tokenId, Date.now() + confirmMs);
        return false;
      }
      if (Date.now() >= until) {
        this.cancelHoldUntil.delete(tokenId);
        return true;
      }
      return false;
    }
    this.cancelHoldUntil.delete(tokenId);

    const depthDropRatio = this.config.mmDepthDropRatio ?? 0;
    if (depthDropRatio > 0) {
      const currentDepth = this.getTopDepth(orderbook).shares;
      const lastDepth = this.lastDepth.get(tokenId);
      if (lastDepth && lastDepth > 0 && currentDepth / lastDepth < 1 - depthDropRatio) {
        return true;
      }
    }

    return false;
  }

  private getAdaptiveMinInterval(tokenId: string): number {
    const base = this.config.minOrderIntervalMs ?? 3000;
    let multiplier = 1;
    const profile = this.lastProfile.get(tokenId);
    if (profile === 'VOLATILE') {
      multiplier *= this.config.mmIntervalProfileVolatileMultiplier ?? 1.3;
    } else if (profile === 'CALM') {
      multiplier *= this.config.mmIntervalProfileCalmMultiplier ?? 0.8;
    }
    if (this.config.mmAdaptiveParams !== false) {
      const vol = this.volatilityEma.get(tokenId) ?? 0;
      const threshold = this.config.mmIntervalVolatilityBps ?? 0.01;
      const mult = this.config.mmIntervalVolMultiplier ?? 1.6;
      if (vol >= threshold) {
        multiplier *= mult;
      }
    }
    if (this.isLayerPanicActive(tokenId)) {
      const panicMult = Math.max(1, this.config.mmLayerPanicIntervalMult ?? 1);
      multiplier *= panicMult;
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const restoreMult = Math.max(1, this.config.mmLayerRestoreIntervalMult ?? 1);
      multiplier *= restoreMult;
    }
    const panicRestoreMult =
      this.isLayerRestoreActive(tokenId) && this.config.mmPanicRestoreIntervalMult
        ? Math.max(1, this.config.mmPanicRestoreIntervalMult ?? 1)
        : 1;
    if (panicRestoreMult > 1) {
      multiplier *= panicRestoreMult;
    }
    multiplier *= this.getFillSlowdownMultiplier(tokenId);
    return Math.max(500, Math.round(base * multiplier));
  }

  private canSendAction(tokenId: string): boolean {
    const now = Date.now();
    const lockUntil = this.actionLockUntil.get(tokenId) || 0;
    if (lockUntil > now) {
      return false;
    }
    let minInterval = this.getAdaptiveMinInterval(tokenId);
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthTrend: this.depthTrend.get(tokenId) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(tokenId) ?? 0,
    });
    if (safeModeActive) {
      const safeMin = Math.max(0, this.config.mmSafeModeMinIntervalMs ?? 0);
      if (safeMin > minInterval) {
        minInterval = safeMin;
      }
    }
    const lastAt = this.lastActionAt.get(tokenId) || 0;
    const cooldownUntil = this.cooldownUntil.get(tokenId) || 0;
    return now - lastAt >= minInterval && now >= cooldownUntil;
  }

  private markAction(tokenId: string): void {
    this.lastActionAt.set(tokenId, Date.now());
    if (this.config.mmActionBurstLimit) {
      this.recordActionBurst(tokenId);
    }
    if (this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreForceCleanup) {
      void this.cancelOrdersForMarket(tokenId);
    }
  }

  private recordActionBurst(tokenId: string): void {
    const limit = Math.max(0, this.config.mmActionBurstLimit ?? 0);
    if (!limit) {
      return;
    }
    const windowMs = Math.max(1, this.config.mmActionBurstWindowMs ?? 10000);
    const cooldownMs = Math.max(0, this.config.mmActionBurstCooldownMs ?? 0);
    const now = Date.now();
    const entry = this.actionBurst.get(tokenId) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    this.actionBurst.set(tokenId, entry);
    if (entry.count >= limit && cooldownMs > 0) {
      this.actionLockUntil.set(tokenId, now + cooldownMs);
      if (this.config.mmActionBurstRestoreHoldMs) {
        this.layerRestoreAt.set(tokenId, now + Math.max(0, this.config.mmActionBurstRestoreHoldMs));
        this.layerRestoreStartAt.set(tokenId, now);
      }
    }
  }

  private markCooldown(tokenId: string, durationMs: number): void {
    this.cooldownUntil.set(tokenId, Date.now() + durationMs);
  }

  private sleep(ms: number): Promise<void> {
    if (!ms || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isPaused(tokenId: string): boolean {
    const until = this.pauseUntil.get(tokenId) || 0;
    return Date.now() < until;
  }

  private pauseForVolatility(tokenId: string): void {
    const pauseMs = this.config.pauseAfterVolatilityMs ?? 8000;
    this.pauseUntil.set(tokenId, Date.now() + pauseMs);
  }

  private parseShares(entry?: OrderbookEntry): number {
    if (!entry) {
      return 0;
    }

    const shares = Number(entry.shares);
    return Number.isFinite(shares) && shares > 0 ? shares : 0;
  }

  private sumDepthLevels(entries: OrderbookEntry[] | undefined, levels: number): number {
    if (!entries || entries.length === 0) {
      return 0;
    }
    const capped = levels > 0 ? entries.slice(0, levels) : entries;
    return capped.reduce((sum, entry) => sum + this.parseShares(entry), 0);
  }

  private updateDepthMetrics(tokenId: string, orderbook: Orderbook): {
    totalDepth: number;
    bidDepth: number;
    askDepth: number;
    imbalance: number;
    depthTrend: number;
    depthSpeedBps: number;
    bidDepthSpeedBps: number;
    askDepthSpeedBps: number;
  } {
    const levels = this.config.mmDepthLevels ?? 3;
    const bidDepth = this.sumDepthLevels(orderbook.bids, levels);
    const askDepth = this.sumDepthLevels(orderbook.asks, levels);
    const totalDepth = bidDepth + askDepth;

    const alpha = this.config.mmDepthEmaAlpha ?? 0.2;
    const prevEma = this.totalDepthEma.get(tokenId) ?? totalDepth;
    const ema = prevEma + alpha * (totalDepth - prevEma);
    this.totalDepthEma.set(tokenId, ema);

    const depthTrend = ema > 0 ? (totalDepth - ema) / ema : 0;
    this.depthTrend.set(tokenId, depthTrend);

    const denom = bidDepth + askDepth;
    const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : 0;
    this.lastImbalance.set(tokenId, this.clamp(imbalance, -1, 1));

    const speedWindow = Math.max(0, this.config.mmDepthSpeedWindowMs ?? 0);
    let depthSpeedBps = 0;
    let bidSpeedBps = 0;
    let askSpeedBps = 0;
    if (speedWindow > 0) {
      const prevAt = this.prevBestAt.get(tokenId) || 0;
      if (prevAt > 0 && Date.now() - prevAt <= speedWindow) {
        const prevBidDepth = this.prevBestBidSize.get(tokenId) ?? 0;
        const prevAskDepth = this.prevBestAskSize.get(tokenId) ?? 0;
        const prevTotal = prevBidDepth + prevAskDepth;
        if (prevTotal > 0 && totalDepth > 0) {
          depthSpeedBps = ((prevTotal - totalDepth) / prevTotal) * 10000;
        }
        if (prevBidDepth > 0 && bidDepth > 0) {
          bidSpeedBps = ((prevBidDepth - bidDepth) / prevBidDepth) * 10000;
        }
        if (prevAskDepth > 0 && askDepth > 0) {
          askSpeedBps = ((prevAskDepth - askDepth) / prevAskDepth) * 10000;
        }
      }
    }

    return {
      totalDepth,
      bidDepth,
      askDepth,
      imbalance,
      depthTrend,
      depthSpeedBps,
      bidDepthSpeedBps: bidSpeedBps,
      askDepthSpeedBps: askSpeedBps,
    };
  }

  private updateBestPrices(tokenId: string, orderbook: Orderbook): void {
    const now = Date.now();
    const prevBid = this.lastBestBid.get(tokenId);
    const prevAsk = this.lastBestAsk.get(tokenId);
    const prevAt = this.lastBestAt.get(tokenId);
    const prevBidSize = this.lastBestBidSize.get(tokenId);
    const prevAskSize = this.lastBestAskSize.get(tokenId);
    const prevBidDelta = this.lastBidDeltaBps.get(tokenId);
    const prevAskDelta = this.lastAskDeltaBps.get(tokenId);
    if (prevBid !== undefined) {
      this.prevBestBid.set(tokenId, prevBid);
    }
    if (prevAsk !== undefined) {
      this.prevBestAsk.set(tokenId, prevAsk);
    }
    if (prevAt !== undefined) {
      this.prevBestAt.set(tokenId, prevAt);
    }
    if (prevBidSize !== undefined) {
      this.prevBestBidSize.set(tokenId, prevBidSize);
    }
    if (prevAskSize !== undefined) {
      this.prevBestAskSize.set(tokenId, prevAskSize);
    }
    if (orderbook.best_bid !== undefined && orderbook.best_bid > 0) {
      if (prevBid !== undefined && prevBid > 0) {
        const delta = ((orderbook.best_bid - prevBid) / prevBid) * 10000;
        if (prevBidDelta !== undefined) {
          this.prevBidDeltaBps.set(tokenId, prevBidDelta);
        }
        this.lastBidDeltaBps.set(tokenId, delta);
      }
      this.lastBestBid.set(tokenId, orderbook.best_bid);
    }
    if (orderbook.best_ask !== undefined && orderbook.best_ask > 0) {
      if (prevAsk !== undefined && prevAsk > 0) {
        const delta = ((orderbook.best_ask - prevAsk) / prevAsk) * 10000;
        if (prevAskDelta !== undefined) {
          this.prevAskDeltaBps.set(tokenId, prevAskDelta);
        }
        this.lastAskDeltaBps.set(tokenId, delta);
      }
      this.lastBestAsk.set(tokenId, orderbook.best_ask);
    }
    const bidSize = this.parseShares(orderbook.bids?.[0]);
    const askSize = this.parseShares(orderbook.asks?.[0]);
    if (bidSize > 0) {
      this.lastBestBidSize.set(tokenId, bidSize);
    }
    if (askSize > 0) {
      this.lastBestAskSize.set(tokenId, askSize);
    }
    this.lastBestAt.set(tokenId, now);
  }

  private calculateMicroPrice(orderbook: Orderbook): number | null {
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;

    if (bestBid === undefined || bestAsk === undefined) {
      return null;
    }

    const topBidShares = this.parseShares(orderbook.bids[0]);
    const topAskShares = this.parseShares(orderbook.asks[0]);

    if (topBidShares > 0 && topAskShares > 0) {
      return (bestAsk * topBidShares + bestBid * topAskShares) / (topBidShares + topAskShares);
    }

    return (bestBid + bestAsk) / 2;
  }

  private calculateOrderbookImbalance(orderbook: Orderbook): number {
    const levels = Math.max(1, this.config.mmImbalanceLevels ?? 3);
    const bids = orderbook.bids.slice(0, levels);
    const asks = orderbook.asks.slice(0, levels);
    let bidShares = 0;
    let askShares = 0;
    for (const entry of bids) {
      bidShares += this.parseShares(entry);
    }
    for (const entry of asks) {
      askShares += this.parseShares(entry);
    }
    const total = bidShares + askShares;
    if (total <= 0) {
      return 0;
    }
    return this.clamp((bidShares - askShares) / total, -1, 1);
  }

  private getVolatilityMultiplier(tokenId: string, multiplier: number): number {
    const vol = this.volatilityEma.get(tokenId) ?? 0;
    if (!multiplier || multiplier <= 0) {
      return 1;
    }
    return 1 + vol * multiplier;
  }

  private checkVolatility(tokenId: string, orderbook: Orderbook): boolean {
    if (!orderbook.mid_price) {
      return false;
    }

    const lastMid = this.lastPrices.get(tokenId);
    const lastAt = this.lastPriceAt.get(tokenId) || 0;
    const lookback = this.config.volatilityLookbackMs ?? 10000;

    if (!lastMid || Date.now() - lastAt > lookback) {
      return false;
    }

    const change = Math.abs(orderbook.mid_price - lastMid) / lastMid;
    const threshold = this.config.volatilityPauseBps ?? 0.01;

    if (change >= threshold) {
      this.pauseForVolatility(tokenId);
      return true;
    }

    return false;
  }

  private checkSpreadJump(tokenId: string, orderbook: Orderbook): boolean {
    const thresholdBps = Math.max(0, this.config.mmSpreadJumpBps ?? 0);
    if (!thresholdBps) {
      return false;
    }
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0) {
      return false;
    }
    const spread = (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
    const now = Date.now();
    const last = this.lastBookSpread.get(tokenId);
    const lastAt = this.lastBookSpreadAt.get(tokenId) || 0;
    this.lastBookSpread.set(tokenId, spread);
    this.lastBookSpreadAt.set(tokenId, now);
    const windowMs = Math.max(0, this.config.mmSpreadJumpWindowMs ?? 0);
    if (!last || (windowMs > 0 && now - lastAt > windowMs)) {
      return false;
    }
    const deltaBps = Math.abs(spread - last) * 10000;
    return deltaBps >= thresholdBps;
  }

  private evaluateOrderRisk(
    order: Order,
    orderbook: Orderbook
  ): { cancel: boolean; panic: boolean; reason: string } {
    const refreshMs = this.config.mmOrderRefreshMs ?? 0;
    if (refreshMs > 0 && Date.now() - order.timestamp > refreshMs) {
      return { cancel: true, panic: false, reason: 'refresh' };
    }

    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0) {
      return { cancel: true, panic: true, reason: 'invalid price' };
    }

    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    if (bestBid === undefined || bestAsk === undefined) {
      return { cancel: false, panic: false, reason: '' };
    }

    let nearTouchBase = this.config.nearTouchBps ?? 0.0015;
    let antiFillBase = this.config.antiFillBps ?? 0.002;
    if (this.isLayerRestoreActive(order.token_id)) {
      const restoreMult = this.config.mmLayerRestoreNearTouchMult ?? 0;
      if (restoreMult > 0) {
        nearTouchBase *= restoreMult;
        antiFillBase *= restoreMult;
      }
      const restoreAdd = this.config.mmLayerRestoreNearTouchAddBps ?? 0;
      if (restoreAdd > 0) {
        nearTouchBase += restoreAdd / 10000;
        antiFillBase += restoreAdd / 10000;
      }
      const restoreCancelMult = this.config.mmLayerRestoreCancelMult ?? 0;
      if (restoreCancelMult > 0) {
        nearTouchBase *= restoreCancelMult;
        antiFillBase *= restoreCancelMult;
      }
    }
    const safeModeActive = this.isSafeModeActive(order.token_id, {
      volEma: this.volatilityEma.get(order.token_id) ?? 0,
      depthTrend: this.depthTrend.get(order.token_id) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(order.token_id) ?? 0,
    });
    if (safeModeActive) {
      const mult = Math.max(1, this.config.mmSafeModeNearTouchMult ?? 1);
      nearTouchBase *= mult;
      const antiMult = Math.max(1, this.config.mmSafeModeAntiFillMult ?? mult);
      antiFillBase *= antiMult;
      const add = Math.max(0, this.config.mmSafeModeNearTouchAddBps ?? 0);
      if (add > 0) {
        nearTouchBase += add / 10000;
        antiFillBase += add / 10000;
      }
      const cancelMult = Math.max(1, this.config.mmSafeModeCancelMult ?? 1);
      nearTouchBase *= cancelMult;
      antiFillBase *= cancelMult;
    }
    const autoTuneMult = this.getAutoTuneMultiplier(order.token_id);
    if (autoTuneMult !== 1) {
      nearTouchBase *= autoTuneMult;
      antiFillBase *= autoTuneMult;
    }
    const depthSpeedThreshold = Math.max(0, this.config.mmNearTouchDepthSpeedBps ?? 0);
    if (depthSpeedThreshold > 0) {
      const depthSpeed = this.lastDepthSpeedBps.get(order.token_id) ?? 0;
      if (depthSpeed >= depthSpeedThreshold) {
        const nearSpeedMult = Math.max(1, this.config.mmNearTouchDepthSpeedMult ?? 1);
        const antiSpeedMult = Math.max(1, this.config.mmAntiFillDepthSpeedMult ?? nearSpeedMult);
        nearTouchBase *= nearSpeedMult;
        antiFillBase *= antiSpeedMult;
      }
    }
    const nearMult = this.getVolatilityMultiplier(order.token_id, this.config.mmNearTouchVolMultiplier ?? 1.5);
    const antiMult = this.getVolatilityMultiplier(order.token_id, this.config.mmAntiFillVolMultiplier ?? 1.5);
    const nearTouch = nearTouchBase * nearMult;
    const antiFill = antiFillBase * antiMult;
    const softCancel = this.config.mmSoftCancelBps ?? nearTouch;
    const hardCancel = this.config.mmHardCancelBps ?? antiFill;
    const holdMs = this.config.mmHoldNearTouchMs ?? 800;
    const holdMax = this.config.mmHoldNearTouchMaxBps ?? nearTouch;
    const aggressiveMove = this.config.mmAggressiveMoveBps ?? 0.002;
    const aggressiveWindow = this.config.mmAggressiveMoveWindowMs ?? 1500;
    const hitWarnBps = Math.max(0, this.config.mmHitWarningBps ?? 0);
    const hitWarn = hitWarnBps > 0 ? hitWarnBps / 10000 : 0;
    const hitTopSizeMin = Math.max(0, this.config.mmHitTopSizeMinShares ?? 0);
    const hitTopSizeFactor = Math.max(0, this.config.mmHitTopSizeFactor ?? 0);
    const hitDepthLevels = Math.max(0, this.config.mmHitDepthLevels ?? 0);
    const hitDepthMinShares = Math.max(0, this.config.mmHitDepthMinShares ?? 0);
    const hitSpeedBps = Math.max(0, this.config.mmHitSpeedBps ?? 0);
    const hitSpeedWindow = Math.max(0, this.config.mmHitSpeedWindowMs ?? 1200);
    const hitSizeDropRatio = Math.max(0, this.config.mmHitSizeDropRatio ?? 0);
    const hitSizeDropWindow = Math.max(0, this.config.mmHitSizeDropWindowMs ?? 1200);
    const orderShares = Number(order.shares);
    const restoreNoNearTouch = this.isLayerRestoreActive(order.token_id) && this.config.mmLayerRestoreNoNearTouch;
    const restoreNearTouchBps = Math.max(0, this.config.mmLayerRestoreNearTouchBps ?? 0);
    const restoreNearTouch = restoreNearTouchBps > 0 ? restoreNearTouchBps / 10000 : nearTouch;
    const vwapThresholdBps = Math.max(0, this.config.mmOrderRiskVwapBps ?? 0);
    const vwapLevels = Math.max(0, this.config.mmOrderRiskVwapLevels ?? 0);
    const vwapFeeBps = Math.max(0, this.config.mmOrderRiskVwapFeeBps ?? 0);
    const vwapSlippageBps = Math.max(0, this.config.mmOrderRiskVwapSlippageBps ?? 0);
    const vwapBaseShares = Math.max(0, this.config.mmOrderRiskVwapShares ?? 0);
    const vwapMult = Math.max(0, this.config.mmOrderRiskVwapMult ?? 0);
    let vwapTargetShares = vwapBaseShares;
    if (Number.isFinite(orderShares) && orderShares > 0) {
      if (vwapMult > 0) {
        vwapTargetShares = Math.max(vwapTargetShares, orderShares * vwapMult);
      }
      if (!vwapTargetShares) {
        vwapTargetShares = orderShares;
      }
    }

    const prevAt = this.prevBestAt.get(order.token_id) || 0;
    const prevBid = this.prevBestBid.get(order.token_id);
    const prevAsk = this.prevBestAsk.get(order.token_id);
    const elapsed = prevAt > 0 ? Date.now() - prevAt : 0;
    if (elapsed > 0 && elapsed <= aggressiveWindow) {
      if (order.side === 'BUY' && prevAsk && bestAsk < prevAsk * (1 - aggressiveMove)) {
        return { cancel: true, panic: true, reason: 'aggressive-move' };
      }
      if (order.side === 'SELL' && prevBid && bestBid > prevBid * (1 + aggressiveMove)) {
        return { cancel: true, panic: true, reason: 'aggressive-move' };
      }
    }

    const accelBps = Math.max(0, this.config.mmPriceAccelBps ?? 0);
    const accelWindow = Math.max(0, this.config.mmPriceAccelWindowMs ?? 0);
    if (accelBps > 0 && accelWindow > 0 && elapsed > 0 && elapsed <= accelWindow) {
      if (order.side === 'BUY') {
        const lastDelta = this.lastAskDeltaBps.get(order.token_id) ?? 0;
        const prevDelta = this.prevAskDeltaBps.get(order.token_id) ?? 0;
        if (lastDelta < 0 && lastDelta - prevDelta <= -accelBps) {
          return { cancel: true, panic: true, reason: 'price-accel' };
        }
      } else {
        const lastDelta = this.lastBidDeltaBps.get(order.token_id) ?? 0;
        const prevDelta = this.prevBidDeltaBps.get(order.token_id) ?? 0;
        if (lastDelta > 0 && lastDelta - prevDelta >= accelBps) {
          return { cancel: true, panic: true, reason: 'price-accel' };
        }
      }
    }

    if (order.side === 'BUY') {
      const distance = (bestAsk - price) / price;
      if (restoreNoNearTouch && distance <= restoreNearTouch) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'restore-no-near-touch' };
      }
      if (vwapThresholdBps > 0 && vwapTargetShares > 0) {
        const vwap = estimateSell(
          orderbook.bids,
          vwapTargetShares,
          vwapFeeBps,
          undefined,
          undefined,
          vwapSlippageBps,
          vwapLevels
        );
        if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn <= price) {
          const vwapDistanceBps = ((price - vwap.avgAllIn) / price) * 10000;
          if (vwapDistanceBps <= vwapThresholdBps) {
            return { cancel: true, panic: true, reason: 'vwap-risk' };
          }
        }
      }
      if (hitSpeedBps > 0 && elapsed > 0 && elapsed <= hitSpeedWindow && prevAsk && bestAsk < prevAsk) {
        const moveBps = ((prevAsk - bestAsk) / prevAsk) * 10000;
        if (hitWarn > 0 && distance <= hitWarn && moveBps >= hitSpeedBps) {
          return { cancel: true, panic: true, reason: 'hit-warning-speed' };
        }
      }
      if (hitWarn > 0 && distance <= hitWarn) {
        const topSize = this.lastBestBidSize.get(order.token_id) ?? this.parseShares(orderbook.bids?.[0]);
        const relativeCap =
          hitTopSizeFactor > 0 && Number.isFinite(orderShares) && orderShares > 0
            ? orderShares * hitTopSizeFactor
            : 0;
        const sizeThreshold = Math.max(hitTopSizeMin, relativeCap);
        if (sizeThreshold > 0 && topSize > 0 && topSize <= sizeThreshold) {
          return { cancel: true, panic: true, reason: 'hit-warning-top' };
        }
        if (hitDepthLevels > 0 && hitDepthMinShares > 0) {
          const depthShares = this.sumDepthLevels(orderbook.bids, hitDepthLevels);
          if (depthShares > 0 && depthShares <= hitDepthMinShares) {
            return { cancel: true, panic: true, reason: 'hit-warning-depth' };
          }
        }
        if (hitSizeDropRatio > 0 && elapsed > 0 && elapsed <= hitSizeDropWindow) {
          const prevSize = this.prevBestBidSize.get(order.token_id) ?? 0;
          if (prevSize > 0 && topSize > 0) {
            const drop = (prevSize - topSize) / prevSize;
            if (drop >= hitSizeDropRatio) {
              return { cancel: true, panic: true, reason: 'hit-warning-size-drop' };
            }
          }
        }
      }
      if (distance <= hardCancel || distance <= antiFill) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'anti-fill' };
      }
      if (distance <= holdMax) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'near-touch-max' };
      }
      if (distance <= nearTouch || distance <= softCancel) {
        const until = this.nearTouchHoldUntil.get(order.order_hash) || 0;
        if (!until) {
          this.nearTouchHoldUntil.set(order.order_hash, Date.now() + holdMs);
          return { cancel: false, panic: false, reason: 'near-touch-hold' };
        }
        if (Date.now() >= until) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          return { cancel: true, panic: false, reason: 'near-touch' };
        }
        return { cancel: false, panic: false, reason: 'near-touch-hold' };
      }
    } else {
      const distance = (price - bestBid) / price;
      if (restoreNoNearTouch && distance <= restoreNearTouch) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'restore-no-near-touch' };
      }
      if (vwapThresholdBps > 0 && vwapTargetShares > 0) {
        const vwap = estimateBuy(
          orderbook.asks,
          vwapTargetShares,
          vwapFeeBps,
          undefined,
          undefined,
          vwapSlippageBps,
          vwapLevels
        );
        if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn >= price) {
          const vwapDistanceBps = ((vwap.avgAllIn - price) / price) * 10000;
          if (vwapDistanceBps <= vwapThresholdBps) {
            return { cancel: true, panic: true, reason: 'vwap-risk' };
          }
        }
      }
      if (hitSpeedBps > 0 && elapsed > 0 && elapsed <= hitSpeedWindow && prevBid && bestBid > prevBid) {
        const moveBps = ((bestBid - prevBid) / prevBid) * 10000;
        if (hitWarn > 0 && distance <= hitWarn && moveBps >= hitSpeedBps) {
          return { cancel: true, panic: true, reason: 'hit-warning-speed' };
        }
      }
      if (hitWarn > 0 && distance <= hitWarn) {
        const topSize = this.lastBestAskSize.get(order.token_id) ?? this.parseShares(orderbook.asks?.[0]);
        const relativeCap =
          hitTopSizeFactor > 0 && Number.isFinite(orderShares) && orderShares > 0
            ? orderShares * hitTopSizeFactor
            : 0;
        const sizeThreshold = Math.max(hitTopSizeMin, relativeCap);
        if (sizeThreshold > 0 && topSize > 0 && topSize <= sizeThreshold) {
          return { cancel: true, panic: true, reason: 'hit-warning-top' };
        }
        if (hitDepthLevels > 0 && hitDepthMinShares > 0) {
          const depthShares = this.sumDepthLevels(orderbook.asks, hitDepthLevels);
          if (depthShares > 0 && depthShares <= hitDepthMinShares) {
            return { cancel: true, panic: true, reason: 'hit-warning-depth' };
          }
        }
        if (hitSizeDropRatio > 0 && elapsed > 0 && elapsed <= hitSizeDropWindow) {
          const prevSize = this.prevBestAskSize.get(order.token_id) ?? 0;
          if (prevSize > 0 && topSize > 0) {
            const drop = (prevSize - topSize) / prevSize;
            if (drop >= hitSizeDropRatio) {
              return { cancel: true, panic: true, reason: 'hit-warning-size-drop' };
            }
          }
        }
      }
      if (distance <= hardCancel || distance <= antiFill) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'anti-fill' };
      }
      if (distance <= holdMax) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'near-touch-max' };
      }
      if (distance <= nearTouch || distance <= softCancel) {
        const until = this.nearTouchHoldUntil.get(order.order_hash) || 0;
        if (!until) {
          this.nearTouchHoldUntil.set(order.order_hash, Date.now() + holdMs);
          return { cancel: false, panic: false, reason: 'near-touch-hold' };
        }
        if (Date.now() >= until) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          return { cancel: true, panic: false, reason: 'near-touch' };
        }
        return { cancel: false, panic: false, reason: 'near-touch-hold' };
      }
    }

    return { cancel: false, panic: false, reason: '' };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getAccountEquityUsd(): number {
    const equity = this.config.mmAccountEquityUsd ?? 0;
    if (equity > 0) {
      return equity;
    }
    const positionsValue = Array.from(this.positions.values()).reduce((sum, p) => sum + (p.total_value || 0), 0);
    return Math.max(0, positionsValue);
  }

  private getEffectiveMaxPosition(): number {
    const pct = this.config.mmMaxPositionPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return Math.max(1, this.config.maxPosition);
  }

  private getEffectiveOrderSize(): number {
    const pct = this.config.mmOrderSizePct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return this.config.orderSize;
  }

  private getEffectiveMaxSingleOrderValue(): number {
    const pct = this.config.mmMaxSingleOrderPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return this.config.maxSingleOrderValue ?? Number.POSITIVE_INFINITY;
  }

  private getEffectiveMaxDailyLoss(): number {
    const pct = this.config.mmMaxDailyLossPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return this.config.maxDailyLoss ?? 200;
  }

  private getTopDepth(orderbook: Orderbook): { shares: number; usd: number } {
    const levels = Math.max(1, this.config.mmDepthLevels ?? 1);
    const bids = orderbook.bids.slice(0, levels);
    const asks = orderbook.asks.slice(0, levels);
    let shares = 0;
    let usd = 0;
    for (const entry of bids) {
      const s = this.parseShares(entry);
      const p = Number(entry.price);
      if (s > 0 && Number.isFinite(p)) {
        shares += s;
        usd += s * p;
      }
    }
    for (const entry of asks) {
      const s = this.parseShares(entry);
      const p = Number(entry.price);
      if (s > 0 && Number.isFinite(p)) {
        shares += s;
        usd += s * p;
      }
    }
    return { shares, usd };
  }

  private updateMarketMetrics(
    tokenId: string,
    orderbook: Orderbook
  ): {
    volEma: number;
    depthEma: number;
    topDepth: number;
    topDepthUsd: number;
    depthTrend: number;
    depthSpeedBps: number;
    bidDepthSpeedBps: number;
    askDepthSpeedBps: number;
  } {
    const micro = this.calculateMicroPrice(orderbook);
    if (micro && micro > 0) {
      const lastMid = this.lastPrices.get(tokenId);
      const alpha = this.config.mmVolEmaAlpha ?? 0.2;
      if (lastMid && lastMid > 0) {
        const ret = Math.abs(micro - lastMid) / lastMid;
        const prev = this.volatilityEma.get(tokenId) ?? 0;
        const next = prev === 0 ? ret : prev * (1 - alpha) + ret * alpha;
        this.volatilityEma.set(tokenId, next);
      }
    }

    const depth = this.getTopDepth(orderbook);
    const depthAlpha = this.config.mmDepthEmaAlpha ?? 0.2;
    const prevDepth = this.depthEma.get(tokenId) ?? 0;
    const nextDepth = prevDepth === 0 ? depth.shares : prevDepth * (1 - depthAlpha) + depth.shares * depthAlpha;
    this.depthEma.set(tokenId, nextDepth);
    this.lastDepth.set(tokenId, depth.shares);

    const depthTrend = nextDepth > 0 ? depth.shares / nextDepth : 1;
    const speedWindow = Math.max(0, this.config.mmDepthSpeedWindowMs ?? 0);
    let depthSpeedBps = 0;
    let bidSpeedBps = 0;
    let askSpeedBps = 0;
    if (speedWindow > 0) {
      const prevAt = this.prevBestAt.get(tokenId) || 0;
      if (prevAt > 0 && Date.now() - prevAt <= speedWindow) {
        const prevBid = this.prevBestBidSize.get(tokenId) ?? 0;
        const prevAsk = this.prevBestAskSize.get(tokenId) ?? 0;
        const curBid = this.parseShares(orderbook.bids?.[0]);
        const curAsk = this.parseShares(orderbook.asks?.[0]);
        const prevTotal = prevBid + prevAsk;
        const curTotal = curBid + curAsk;
        if (prevTotal > 0 && curTotal > 0) {
          depthSpeedBps = ((prevTotal - curTotal) / prevTotal) * 10000;
        }
        if (prevBid > 0 && curBid > 0) {
          bidSpeedBps = ((prevBid - curBid) / prevBid) * 10000;
        }
        if (prevAsk > 0 && curAsk > 0) {
          askSpeedBps = ((prevAsk - curAsk) / prevAsk) * 10000;
        }
      }
    }

    this.lastDepthSpeedBps.set(tokenId, depthSpeedBps);
    this.lastBidDepthSpeedBps.set(tokenId, bidSpeedBps);
    this.lastAskDepthSpeedBps.set(tokenId, askSpeedBps);

    return {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthEma: nextDepth,
      topDepth: depth.shares,
      topDepthUsd: depth.usd,
      depthTrend,
      depthSpeedBps,
      bidDepthSpeedBps: bidSpeedBps,
      askDepthSpeedBps: askSpeedBps,
    };
  }

  private resolveAdaptiveProfile(volEma: number, depthEma: number, depthTrend: number): 'CALM' | 'NORMAL' | 'VOLATILE' {
    const configured = (this.config.mmAdaptiveProfile || 'AUTO').toUpperCase();
    if (configured === 'CALM' || configured === 'NORMAL' || configured === 'VOLATILE') {
      return configured;
    }
    const overrideLow = this.config.mmVolatilityLowBps ?? 0;
    const overrideHigh = this.config.mmVolatilityHighBps ?? 0;
    const calm = overrideLow > 0 ? overrideLow : this.config.mmVolatilityCalmBps ?? 0.004;
    const volatile = overrideHigh > 0 ? overrideHigh : this.config.mmVolatilityVolatileBps ?? 0.02;
    const hysteresis = this.config.mmProfileVolHysteresisBps ?? 0.002;
    const depthRef = this.config.mmDepthRefShares ?? 200;
    const depthRatio = depthRef > 0 ? depthEma / depthRef : 1;
    const low = this.config.mmProfileLiquidityLow ?? 0.5;
    const high = this.config.mmProfileLiquidityHigh ?? 1.2;
    const trendDrop = this.config.mmDepthTrendDropRatio ?? 0.4;
    if (depthTrend < 1 - trendDrop) return 'VOLATILE';
    if (depthRatio <= low) return 'VOLATILE';
    if (volEma >= volatile + hysteresis) return 'VOLATILE';
    if (volEma <= calm - hysteresis && depthRatio >= high) return 'CALM';
    return 'NORMAL';
  }

  private stabilizeProfile(tokenId: string, desired: 'CALM' | 'NORMAL' | 'VOLATILE'): 'CALM' | 'NORMAL' | 'VOLATILE' {
    const current = this.lastProfile.get(tokenId);
    if (!current) {
      this.lastProfile.set(tokenId, desired);
      this.lastProfileAt.set(tokenId, Date.now());
      return desired;
    }
    if (current === desired) {
      return current;
    }
    const holdMs = this.config.mmProfileHoldMs ?? 15000;
    const lastAt = this.lastProfileAt.get(tokenId) || 0;
    if (Date.now() - lastAt < holdMs) {
      return current;
    }
    this.lastProfile.set(tokenId, desired);
    this.lastProfileAt.set(tokenId, Date.now());
    return desired;
  }

  private applyIceberg(shares: number): number {
    if (!this.config.mmIcebergEnabled) {
      return shares;
    }
    const ratio = this.config.mmIcebergRatio ?? 0.3;
    const chunkMax = this.config.mmIcebergMaxChunkShares ?? 15;
    const penalty = this.getIcebergPenalty(this.config.mmIcebergFillPenalty ?? 0.6);
    const next = Math.max(1, Math.floor(shares * Math.max(0.05, ratio) * penalty));
    return Math.min(next, chunkMax);
  }

  private getIcebergPenalty(defaultPenalty: number): number {
    const entry = this.icebergPenalty.get('global');
    if (!entry) {
      return 1;
    }
    const decayMs = this.config.mmIcebergPenaltyDecayMs ?? 60000;
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const recovered = entry.value + (1 - entry.value) * Math.min(1, elapsed / decayMs);
    return this.clamp(recovered, entry.value, 1);
  }

  private applyIcebergPenalty(tokenId: string): void {
    if (!this.config.mmIcebergEnabled) {
      return;
    }
    const penalty = this.config.mmIcebergFillPenalty ?? 0.6;
    this.icebergPenalty.set('global', { value: this.clamp(penalty, 0.2, 1), ts: Date.now() });
  }

  private applySizePenalty(tokenId: string, penalty: number, auto: boolean = false): void {
    const value = this.clamp(penalty, 0.2, 1);
    const current = this.sizePenalty.get(tokenId);
    if (!current) {
      this.sizePenalty.set(tokenId, { value, ts: Date.now(), auto });
      return;
    }
    const next = Math.min(current.value, value);
    this.sizePenalty.set(tokenId, { value: next, ts: Date.now(), auto: current.auto || auto });
  }

  private getSizePenalty(tokenId: string): number {
    const entry = this.sizePenalty.get(tokenId);
    if (!entry) {
      return 1;
    }
    const decayMs = entry.auto
      ? this.config.mmAutoSizeOnFillDecayMs ?? 90000
      : this.config.mmPartialFillPenaltyDecayMs ?? 60000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const recovered = entry.value + (1 - entry.value) * Math.min(1, elapsed / decayMs);
    return this.clamp(recovered, entry.value, 1);
  }

  private applyNearTouchPenalty(tokenId: string, intensity: number = 1): void {
    const base = this.config.mmNearTouchPenaltyBps ?? 0;
    if (!base || base <= 0) {
      return;
    }
    const maxBps = this.config.mmNearTouchPenaltyMaxBps ?? base * 4;
    const current = this.nearTouchPenalty.get(tokenId);
    const scaled = base * this.clamp(intensity, 0.2, 2);
    const next = Math.min((current?.value ?? 0) + scaled, maxBps);
    this.nearTouchPenalty.set(tokenId, { value: next, ts: Date.now() });
  }

  private getNearTouchPenalty(tokenId: string): number {
    const entry = this.nearTouchPenalty.get(tokenId);
    if (!entry) {
      return 0;
    }
    const decayMs = this.config.mmNearTouchPenaltyDecayMs ?? 60000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const decay = Math.exp(-elapsed / decayMs);
    const value = entry.value * decay;
    if (value <= 0.01) {
      this.nearTouchPenalty.delete(tokenId);
      return 0;
    }
    return value;
  }

  private applyFillPenalty(tokenId: string, intensity: number = 1): void {
    const base = this.config.mmFillPenaltyBps ?? 0;
    if (!base || base <= 0) {
      return;
    }
    const maxBps = this.config.mmFillPenaltyMaxBps ?? base * 5;
    const current = this.fillPenalty.get(tokenId);
    const scaled = base * this.clamp(intensity, 0.2, 2);
    const next = Math.min((current?.value ?? 0) + scaled, maxBps);
    this.fillPenalty.set(tokenId, { value: next, ts: Date.now() });
  }

  private getFillPenalty(tokenId: string): number {
    const entry = this.fillPenalty.get(tokenId);
    if (!entry) {
      return 0;
    }
    const decayMs = this.config.mmFillPenaltyDecayMs ?? 90000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const decay = Math.exp(-elapsed / decayMs);
    const value = entry.value * decay;
    if (value <= 0.01) {
      this.fillPenalty.delete(tokenId);
      return 0;
    }
    return value;
  }

  private getNoFillPenalty(tokenId: string): { spreadBps: number; sizeFactor: number; touchBps: number; repriceBps: number; cancelBps: number } {
    const threshold = Math.max(0, this.config.mmNoFillPassiveMs ?? 0);
    if (threshold <= 0) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const last = this.lastFillAt.get(tokenId);
    if (!last) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const elapsed = Date.now() - last;
    if (elapsed <= threshold) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const rampMs = Math.max(1, this.config.mmNoFillRampMs ?? 30000);
    const intensity = this.clamp((elapsed - threshold) / rampMs, 0, 1);
    const base = Math.max(0, this.config.mmNoFillPenaltyBps ?? 0);
    const maxBps = Math.max(base, this.config.mmNoFillPenaltyMaxBps ?? base * 4);
    const spreadBps = base > 0 ? base + (maxBps - base) * intensity : 0;
    const sizePenalty = this.clamp(this.config.mmNoFillSizePenalty ?? 1, 0.2, 1);
    const sizeFactor = 1 - (1 - sizePenalty) * intensity;
    const touchBase = Math.max(0, this.config.mmNoFillTouchBps ?? 0);
    const touchMax = Math.max(touchBase, this.config.mmNoFillTouchMaxBps ?? touchBase * 2);
    const touchBps = touchBase > 0 ? touchBase + (touchMax - touchBase) * intensity : 0;
    const repriceBase = Math.max(0, this.config.mmNoFillRepriceBps ?? 0);
    const repriceMax = Math.max(repriceBase, this.config.mmNoFillRepriceMaxBps ?? repriceBase * 2);
    const repriceBps = repriceBase > 0 ? repriceBase + (repriceMax - repriceBase) * intensity : 0;

    const cancelBase = Math.max(0, this.config.mmNoFillCancelBps ?? 0);
    const cancelMax = Math.max(cancelBase, this.config.mmNoFillCancelMaxBps ?? cancelBase * 2);
    const cancelBps = cancelBase > 0 ? cancelBase + (cancelMax - cancelBase) * intensity : 0;
    return { spreadBps, sizeFactor, touchBps, repriceBps, cancelBps };
  }

  private canRecheck(tokenId: string): boolean {
    const cooldown = Math.max(0, this.config.mmRecheckCooldownMs ?? 0);
    if (!cooldown) {
      return true;
    }
    const until = this.recheckCooldownUntil.get(tokenId) || 0;
    if (Date.now() < until) {
      return false;
    }
    this.recheckCooldownUntil.set(tokenId, Date.now() + cooldown);
    return true;
  }

  private updateFillPressure(tokenId: string, shares: number): void {
    if (!Number.isFinite(shares) || shares <= 0) {
      return;
    }
    const windowMs = Math.max(1, this.config.mmFillSlowdownWindowMs ?? 60000);
    const threshold = Math.max(1, this.config.mmPartialFillShares ?? 5);
    const entry = this.fillPressure.get(tokenId);
    const now = Date.now();
    let score = entry?.score ?? 0;
    if (entry) {
      const elapsed = now - entry.ts;
      const decay = Math.exp(-elapsed / windowMs);
      score *= decay;
    }
    score += shares / threshold;
    this.fillPressure.set(tokenId, { score, ts: now });
  }

  private bumpCancelBoost(tokenId: string, intensity: number): void {
    if (this.config.mmDynamicCancelOnFill !== true) {
      return;
    }
    const now = Date.now();
    const current = this.cancelBoost.get(tokenId);
    let value = current?.value ?? 1;
    const boost = Math.max(0, this.config.mmDynamicCancelBoost ?? 0.4);
    value = value + boost * intensity;
    const maxBoost = Math.max(1, this.config.mmDynamicCancelMaxBoost ?? 2);
    this.cancelBoost.set(tokenId, { value: Math.min(maxBoost, value), ts: now });
  }

  private getCancelBoost(tokenId: string): number {
    if (this.config.mmDynamicCancelOnFill !== true) {
      return 1;
    }
    const entry = this.cancelBoost.get(tokenId);
    if (!entry) {
      return 1;
    }
    const decayMs = Math.max(1, this.config.mmDynamicCancelDecayMs ?? 60000);
    const elapsed = Date.now() - entry.ts;
    const decay = Math.exp(-elapsed / decayMs);
    const value = 1 + (entry.value - 1) * decay;
    return Math.max(1, value);
  }

  private getFillSlowdownMultiplier(tokenId: string): number {
    const entry = this.fillPressure.get(tokenId);
    if (!entry) {
      return 1;
    }
    const windowMs = Math.max(1, this.config.mmFillSlowdownWindowMs ?? 60000);
    const elapsed = Date.now() - entry.ts;
    const decay = Math.exp(-elapsed / windowMs);
    const score = entry.score * decay;
    const factor = Math.max(0, this.config.mmFillSlowdownFactor ?? 0.15);
    const maxMult = Math.max(1, this.config.mmFillSlowdownMaxMultiplier ?? 2);
    const multiplier = 1 + score * factor;
    return Math.min(maxMult, Math.max(1, multiplier));
  }

  private getAutoTuneState(tokenId: string): {
    mult: number;
    windowStart: number;
    placed: number;
    canceled: number;
    filled: number;
    lastUpdate: number;
  } {
    const now = Date.now();
    const existing = this.autoTuneState.get(tokenId);
    if (existing) {
      return existing;
    }
    const state = { mult: 1, windowStart: now, placed: 0, canceled: 0, filled: 0, lastUpdate: now };
    this.autoTuneState.set(tokenId, state);
    return state;
  }

  private recordAutoTuneEvent(tokenId: string, type: 'PLACED' | 'CANCELED' | 'FILLED'): void {
    if (!this.config.mmAutoTuneEnabled) {
      return;
    }
    const now = Date.now();
    const windowMs = Math.max(1000, this.config.mmAutoTuneWindowMs ?? 60000);
    const state = this.getAutoTuneState(tokenId);
    if (now - state.windowStart > windowMs) {
      state.windowStart = now;
      state.placed = 0;
      state.canceled = 0;
      state.filled = 0;
    }
    if (type === 'PLACED') {
      state.placed += 1;
    } else if (type === 'CANCELED') {
      state.canceled += 1;
    } else {
      state.filled += 1;
    }
    this.updateAutoTuneMultiplier(state, now);
  }

  private updateAutoTuneMultiplier(
    state: { mult: number; placed: number; canceled: number; filled: number; lastUpdate: number },
    now: number
  ): void {
    const minEvents = Math.max(1, this.config.mmAutoTuneMinEvents ?? 20);
    const updateMs = Math.max(0, this.config.mmAutoTuneUpdateMs ?? 2000);
    const total = state.placed + state.canceled + state.filled;
    if (total < minEvents || now - state.lastUpdate < updateMs) {
      return;
    }
    const placed = Math.max(1, state.placed);
    const fillRate = state.filled / placed;
    const cancelRate = state.canceled / placed;
    const targetFill = Math.max(0, this.config.mmAutoTuneTargetFillRate ?? 0.02);
    const targetCancel = Math.max(0, this.config.mmAutoTuneTargetCancelRate ?? 0.6);
    const step = Math.max(0, this.config.mmAutoTuneStep ?? 0.05);
    const minMult = Math.max(0.1, this.config.mmAutoTuneMinMult ?? 0.6);
    const maxMult = Math.max(minMult, this.config.mmAutoTuneMaxMult ?? 2.5);
    let mult = state.mult ?? 1;
    if (targetFill > 0 && fillRate > targetFill) {
      mult = Math.min(maxMult, mult + step);
    } else if (targetFill > 0 && fillRate < targetFill * 0.5 && targetCancel > 0 && cancelRate > targetCancel) {
      mult = Math.max(minMult, mult - step * 0.5);
    }
    state.mult = mult;
    state.lastUpdate = now;
  }

  private getAutoTuneMultiplier(tokenId: string): number {
    if (!this.config.mmAutoTuneEnabled) {
      return 1;
    }
    const state = this.getAutoTuneState(tokenId);
    const panicBoost = this.isLayerPanicActive(tokenId)
      ? Math.max(0, this.config.mmPanicAutoTuneBoost ?? 0)
      : 0;
    return Math.max(0.1, (state.mult || 1) + panicBoost);
  }

  private getAutoTuneSnapshot(tokenId: string): { mult: number; fillRate: number; cancelRate: number } {
    const state = this.autoTuneState.get(tokenId);
    if (!state || !this.config.mmAutoTuneEnabled) {
      return { mult: 1, fillRate: 0, cancelRate: 0 };
    }
    const placed = Math.max(1, state.placed);
    return {
      mult: state.mult || 1,
      fillRate: state.filled / placed,
      cancelRate: state.canceled / placed,
    };
  }

  private async flushMmMetrics(): Promise<void> {
    const target = this.config.mmMetricsPath;
    const interval = this.config.mmMetricsFlushMs ?? 0;
    if (!target || !interval) {
      return;
    }
    const now = Date.now();
    if (now - this.mmLastFlushAt < interval) {
      return;
    }
    this.mmLastFlushAt = now;
    try {
      const payload = {
        version: 1,
        ts: now,
        tradingHalted: this.tradingHalted,
        sessionPnL: this.sessionPnL,
        openOrders: this.openOrders.size,
        positions: this.positions.size,
        markets: Array.from(this.mmMetrics.values()),
      };
      const resolved = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, resolved);
    } catch (error) {
      console.warn('MM metrics flush failed:', error);
    }
  }

  private recordMmMetrics(
    market: Market,
    orderbook: Orderbook,
    prices: QuotePrices,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    metrics: {
      volEma: number;
      depthEma: number;
      topDepth: number;
      topDepthUsd: number;
      depthTrend: number;
      depthSpeedBps: number;
      bidDepthSpeedBps: number;
      askDepthSpeedBps: number;
    }
  ): void {
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    const entry = {
      tokenId: market.token_id,
      question: market.question?.slice(0, 80),
      profile,
      spread: prices.spread,
      bid: prices.bidPrice,
      ask: prices.askPrice,
      volEma: metrics.volEma,
      depthEma: metrics.depthEma,
      depthTrend: metrics.depthTrend,
      depthSpeedBps: metrics.depthSpeedBps,
      bidDepthSpeedBps: metrics.bidDepthSpeedBps,
      askDepthSpeedBps: metrics.askDepthSpeedBps,
      topDepth: metrics.topDepth,
      topDepthUsd: metrics.topDepthUsd,
      imbalance,
      pressure: prices.pressure,
      inventoryBias: prices.inventoryBias,
      nearTouchPenaltyBps: this.getNearTouchPenalty(market.token_id),
      fillPenaltyBps: this.getFillPenalty(market.token_id),
      noFillPenaltyBps: this.getNoFillPenalty(market.token_id).spreadBps,
      autoTune: this.getAutoTuneSnapshot(market.token_id),
      updatedAt: Date.now(),
    };
    this.mmMetrics.set(market.token_id, entry);
    void this.flushMmMetrics();
  }

  private canRequoteIceberg(tokenId: string, depthTrend: number): boolean {
    const base = this.config.mmIcebergRequoteMs ?? 4000;
    const volMult = this.getVolatilityMultiplier(tokenId, this.config.mmIcebergRequoteVolMultiplier ?? 1.2);
    const depthMult = depthTrend < 1 ? 1 + (1 - depthTrend) * (this.config.mmIcebergRequoteDepthMultiplier ?? 1.0) : 1;
    const interval = Math.round(base * volMult * depthMult);
    const last = this.lastIcebergAt.get(tokenId) || 0;
    if (Date.now() - last >= interval) {
      this.lastIcebergAt.set(tokenId, Date.now());
      return true;
    }
    return false;
  }

  private buildLayerTargets(basePrice: number, side: 'BUY' | 'SELL', count: number, stepBps: number): number[] {
    const safeCount = Math.max(1, Math.floor(count || 1));
    const safeStepBps = Math.max(0, stepBps || 0);
    if (count <= 1 || stepBps <= 0) {
      return [basePrice];
    }
    const step = safeStepBps / 10000;
    const targets: number[] = [];
    let last = basePrice;
    for (let i = 0; i < safeCount; i += 1) {
      let price =
        side === 'BUY'
          ? basePrice * (1 - step * i)
          : basePrice * (1 + step * i);
      price = this.clamp(price, 0.01, 0.99);
      if (i > 0) {
        if (side === 'BUY' && price >= last) {
          price = Math.max(0.01, last - MarketMaker.MIN_TICK);
        }
        if (side === 'SELL' && price <= last) {
          price = Math.min(0.99, last + MarketMaker.MIN_TICK);
        }
      }
      targets.push(price);
      last = price;
    }
    return targets;
  }

  private buildLayerSizes(
    baseShares: number,
    minShares: number,
    allowBelowMin: boolean,
    count: number,
    minFactor: number
  ): number[] {
    const safeCount = Math.max(1, Math.floor(count || 1));
    const decay = this.clamp(this.config.mmLayerSizeDecay ?? 0.6, 0.1, 1);
    const floor = this.clamp(minFactor || 1, 0.05, 1);
    const sizes: number[] = [];
    for (let i = 0; i < safeCount; i += 1) {
      const scaled = i === 0 ? baseShares : baseShares * Math.pow(decay, i);
      let size = Math.max(1, Math.floor(scaled * floor));
      if (minShares > 0 && size < minShares && !allowBelowMin) {
        size = 0;
      }
      sizes.push(size);
    }
    return sizes;
  }

  private applyLayerPanic(tokenId: string): void {
    const holdMs = Math.max(0, this.config.mmLayerPanicHoldMs ?? 0);
    if (!holdMs) {
      return;
    }
    const now = Date.now();
    const until = now + holdMs;
    const current = this.layerPanicUntil.get(tokenId) || 0;
    this.layerPanicUntil.set(tokenId, Math.max(current, until));
    const restoreHold = Math.max(0, this.config.mmPanicRestoreHoldMs ?? 0);
    const restoreCount = Math.max(0, this.config.mmPanicRestoreCount ?? 0);
    if (restoreHold > 0 && restoreCount > 0) {
      this.layerRestoreAt.set(tokenId, now + restoreHold);
      this.layerRestoreStartAt.set(tokenId, now);
      if (this.config.mmPanicCleanupOnRestore) {
        this.layerRestoreExitPending.set(tokenId, true);
      }
    }
  }

  private isLayerPanicActive(tokenId: string): boolean {
    const until = this.layerPanicUntil.get(tokenId) || 0;
    return until > Date.now();
  }

  private isSafeModeActive(
    tokenId: string,
    metrics: { volEma: number; depthTrend: number; depthSpeedBps: number }
  ): boolean {
    if (!this.config.mmSafeModeEnabled) {
      return false;
    }
    const now = Date.now();
    const holdUntil = this.safeModeExitUntil.get(tokenId) || 0;
    if (holdUntil > now) {
      return true;
    }
    const volThreshold = Math.max(0, this.config.mmSafeModeVolBps ?? 0);
    const depthThreshold = this.config.mmSafeModeDepthTrend ?? 0;
    const depthSpeedThreshold = Math.max(0, this.config.mmSafeModeDepthSpeedBps ?? 0);
    const volTrigger = volThreshold > 0 && metrics.volEma >= volThreshold;
    const depthTrigger = depthThreshold > 0 && metrics.depthTrend <= depthThreshold;
    const depthSpeedTrigger = depthSpeedThreshold > 0 && metrics.depthSpeedBps >= depthSpeedThreshold;
    const active = volTrigger || depthTrigger || depthSpeedTrigger;
    if (!active && holdUntil) {
      this.safeModeExitUntil.delete(tokenId);
    }
    return active;
  }

  private applyLayerRetreat(tokenId: string): void {
    const holdMs = Math.max(0, this.config.mmLayerRetreatHoldMs ?? 0);
    if (!holdMs) {
      return;
    }
    const now = Date.now();
    const until = now + holdMs;
    const current = this.layerRetreatUntil.get(tokenId) || 0;
    this.layerRetreatUntil.set(tokenId, Math.max(current, until));
    this.layerRestoreAt.delete(tokenId);
    this.layerRestoreStartAt.delete(tokenId);
  }

  private isLayerRetreatActive(tokenId: string): boolean {
    const until = this.layerRetreatUntil.get(tokenId) || 0;
    return until > Date.now();
  }

  private isLayerRestoreActive(tokenId: string): boolean {
    const until = this.layerRestoreAt.get(tokenId) || 0;
    if (until > Date.now()) {
      return true;
    }
    if (until > 0) {
      this.layerRestoreAt.delete(tokenId);
      this.layerRestoreStartAt.delete(tokenId);
      const now = Date.now();
      const exitRampMs = Math.max(0, this.config.mmRestoreExitRampMs ?? 0);
      if (exitRampMs > 0) {
        this.layerRestoreExitRampStartAt.set(tokenId, now);
        this.layerRestoreExitRampUntil.set(tokenId, now + exitRampMs);
      } else {
        this.layerRestoreExitRampStartAt.delete(tokenId);
        this.layerRestoreExitRampUntil.delete(tokenId);
      }
      const exitSizeRampMs = Math.max(0, this.config.mmRestoreExitSizeRampMs ?? 0);
      if (exitSizeRampMs > 0) {
        this.layerRestoreExitSizeRampStartAt.set(tokenId, now);
        this.layerRestoreExitSizeRampUntil.set(tokenId, now + exitSizeRampMs);
      } else {
        this.layerRestoreExitSizeRampStartAt.delete(tokenId);
        this.layerRestoreExitSizeRampUntil.delete(tokenId);
      }
      if (this.config.mmRestoreExitForceReprice) {
        this.layerRestoreExitRepricePending.add(tokenId);
      }
      if (this.config.mmLayerRestoreExitCleanup) {
        this.layerRestoreExitPending.set(tokenId, true);
      }
    }
    return false;
  }

  private shouldForceSingleLayer(tokenId: string): boolean {
    if (this.config.mmLayerRetreatForceSingle !== true) {
      return false;
    }
    return this.isLayerRetreatActive(tokenId);
  }

  private getEffectiveLayerCount(
    tokenId: string,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    depthTrend: number,
    depthSpeedBps: number
  ): number {
    const base = Math.max(1, Math.floor(this.config.mmLayerCount ?? 1));
    const minCount = Math.max(1, Math.floor(this.config.mmLayerMinCount ?? 1));
    let effective = base;
    if (profile === 'VOLATILE') {
      const cap = Math.max(0, Math.floor(this.config.mmLayerVolatileCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const depthDrop = Math.max(0, this.config.mmLayerDepthTrendDrop ?? 0);
    if (depthDrop > 0 && depthTrend < -depthDrop) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerThinCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    if (this.isLayerPanicActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerPanicCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const speedThreshold = Math.max(0, this.config.mmLayerDepthSpeedBps ?? 0);
    if (speedThreshold > 0 && depthSpeedBps >= speedThreshold) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerSpeedCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const retreatThreshold = Math.max(0, this.config.mmLayerDepthSpeedRetreatBps ?? 0);
    if (retreatThreshold > 0 && depthSpeedBps >= retreatThreshold) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerRetreatCount ?? 0));
      this.applyLayerRetreat(tokenId);
      if (this.config.mmLayerRetreatOnlyFar) {
        this.actionLockUntil.set(tokenId, Date.now() + Math.max(0, this.config.mmLayerRetreatHoldMs ?? 0));
      }
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    if (this.isLayerRetreatActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerRetreatCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    } else if (this.config.mmLayerRestoreHoldMs && this.config.mmLayerRestoreCount) {
      const holdMs = Math.max(0, this.config.mmLayerRestoreHoldMs ?? 0);
      const now = Date.now();
      if (holdMs > 0) {
        const restoreUntil = this.layerRestoreAt.get(tokenId) || 0;
        if (!restoreUntil || restoreUntil <= now) {
          this.layerRestoreAt.set(tokenId, now + holdMs);
          this.layerRestoreStartAt.set(tokenId, now);
        }
      }
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.getRestoreLayerCount(tokenId)));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
      const hardCap = Math.max(0, Math.floor(this.config.mmRestoreLayerCountCap ?? 0));
      const panicCap = Math.max(0, Math.floor(this.config.mmPanicRestoreLayerCountCap ?? 0));
      const appliedCap = this.isLayerPanicActive(tokenId) && panicCap > 0 ? panicCap : hardCap;
      if (appliedCap > 0) {
        effective = Math.min(effective, appliedCap);
      }
    }
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthTrend,
      depthSpeedBps,
    });
    if (safeModeActive) {
      const cap = Math.max(0, Math.floor(this.config.mmSafeModeLayerCountCap ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    return Math.max(minCount, effective);
  }

  private getRestoreLayerCount(tokenId: string): number {
    const base = Math.max(0, Math.floor(this.config.mmLayerRestoreCount ?? 0));
    const panicRestoreCount = Math.max(0, Math.floor(this.config.mmPanicRestoreCount ?? 0));
    const restoreCount = panicRestoreCount > 0 ? panicRestoreCount : base;
    const stepMs = Math.max(0, this.config.mmLayerRestoreStepMs ?? 0);
    const stepCount = Math.max(0, this.config.mmLayerRestoreStepCount ?? 0);
    const rampMs = Math.max(0, this.config.mmLayerRestoreRampMs ?? 0);
    if (!restoreCount) {
      return restoreCount;
    }
    const now = Date.now();
    const start = this.layerRestoreStartAt.get(tokenId) || 0;
    if (!start) {
      return restoreCount;
    }
    const max = Math.max(restoreCount, Math.floor(this.config.mmLayerCount ?? restoreCount));
    const elapsed = Math.max(0, now - start);
    if (stepMs > 0 && stepCount > 0) {
      const steps = Math.floor(elapsed / stepMs);
      const target = Math.max(restoreCount, Math.min(max, restoreCount + steps * stepCount));
      return target;
    }
    if (!rampMs) {
      return restoreCount;
    }
    const fraction = Math.min(1, elapsed / rampMs);
    const target = Math.max(restoreCount, Math.floor(restoreCount + (max - restoreCount) * fraction));
    return Math.min(max, target);
  }

  private getRestoreExitRampCap(tokenId: string, layerCount: number): number {
    const until = this.layerRestoreExitRampUntil.get(tokenId) || 0;
    if (!until || until <= Date.now()) {
      this.layerRestoreExitRampStartAt.delete(tokenId);
      this.layerRestoreExitRampUntil.delete(tokenId);
      return layerCount;
    }
    const start = this.layerRestoreExitRampStartAt.get(tokenId) || 0;
    if (!start) {
      return layerCount;
    }
    const elapsed = Math.max(0, Date.now() - start);
    const totalMs = Math.max(1, this.config.mmRestoreExitRampMs ?? 0);
    const steps = Math.max(1, this.config.mmRestoreExitRampSteps ?? 0);
    if (!steps) {
      return layerCount;
    }
    const perStep = totalMs / steps;
    const currentStep = Math.min(steps, Math.floor(elapsed / perStep));
    const base = Math.max(1, Math.floor(this.config.mmLayerMinCount ?? 1));
    const cap = Math.min(layerCount, base + currentStep);
    return Math.max(base, cap);
  }

  private getRestoreExitSizeFactor(tokenId: string): number {
    const until = this.layerRestoreExitSizeRampUntil.get(tokenId) || 0;
    if (!until || until <= Date.now()) {
      this.layerRestoreExitSizeRampStartAt.delete(tokenId);
      this.layerRestoreExitSizeRampUntil.delete(tokenId);
      return 1;
    }
    const start = this.layerRestoreExitSizeRampStartAt.get(tokenId) || 0;
    if (!start) {
      return 1;
    }
    const totalMs = Math.max(1, this.config.mmRestoreExitSizeRampMs ?? 0);
    const minFactor = this.clamp(this.config.mmRestoreExitSizeRampMinFactor ?? 0, 0.1, 1);
    if (minFactor >= 1) {
      return 1;
    }
    const elapsed = Math.max(0, Date.now() - start);
    const progress = Math.min(1, elapsed / totalMs);
    return this.clamp(minFactor + (1 - minFactor) * progress, minFactor, 1);
  }

  private getEffectiveLayerStepBps(
    tokenId: string,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    depthTrend: number,
    depthSpeedBps: number
  ): number {
    let step = Math.max(0, this.config.mmLayerSpreadStepBps ?? 0);
    if (profile === 'VOLATILE') {
      step += Math.max(0, this.config.mmLayerStepBpsVolatileAdd ?? 0);
    }
    const depthDrop = Math.max(0, this.config.mmLayerDepthTrendDrop ?? 0);
    if (depthDrop > 0 && depthTrend < -depthDrop) {
      step += Math.max(0, this.config.mmLayerStepBpsThinAdd ?? 0);
    }
    if (this.isLayerPanicActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsPanicAdd ?? 0);
    }
    const speedThreshold = Math.max(0, this.config.mmLayerDepthSpeedBps ?? 0);
    if (speedThreshold > 0 && depthSpeedBps >= speedThreshold) {
      step += Math.max(0, this.config.mmLayerStepBpsSpeedAdd ?? 0);
    }
    if (this.isLayerRetreatActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRetreatAdd ?? 0);
    }
    if (this.isLayerRestoreActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRestoreAdd ?? 0);
    }
    if (this.isLayerRestoreActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRestoreExtra ?? 0);
      step += Math.max(0, this.config.mmRestoreLayerStepBpsAdd ?? 0);
    }
    if (this.isLayerPanicActive(tokenId)) {
      const mult = Math.max(1, this.config.mmPanicStepBpsMult ?? 1);
      step *= mult;
    } else if (this.isLayerRestoreActive(tokenId)) {
      const mult = Math.max(1, this.config.mmRestoreStepBpsMult ?? 1);
      step *= mult;
    }
    return step;
  }

  private isLiquidityThin(metrics: { topDepth: number; topDepthUsd: number }): boolean {
    const minShares = this.config.mmMinTopDepthShares ?? 0;
    const minUsd = this.config.mmMinTopDepthUsd ?? 0;
    if (minShares > 0 && metrics.topDepth < minShares) {
      return true;
    }
    if (minUsd > 0 && metrics.topDepthUsd < minUsd) {
      return true;
    }
    return false;
  }

  private calculateInventoryBias(tokenId: string): number {
    const position = this.positions.get(tokenId);
    if (!position) {
      return 0;
    }

    const netShares = position.yes_amount - position.no_amount;
    const maxPosition = this.getEffectiveMaxPosition();
    const normalized = netShares / maxPosition;

    return this.clamp(normalized, -1, 1);
  }

  calculatePrices(market: Market, orderbook: Orderbook): QuotePrices | null {
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;

    if (bestBid === undefined || bestAsk === undefined) {
      return null;
    }

    if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
      return null;
    }

    const bookSpread = (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
    if (bookSpread > MarketMaker.MAX_ALLOWED_BOOK_SPREAD) {
      return null;
    }

    this.updateBestPrices(market.token_id, orderbook);
    const depthMetrics = this.updateDepthMetrics(market.token_id, orderbook);
    const minDepth = this.config.mmDepthMinShares ?? 0;
    if (minDepth > 0 && depthMetrics.totalDepth < minDepth) {
      return null;
    }
    const safeModeEarly = this.isSafeModeActive(market.token_id, {
      volEma: this.volatilityEma.get(market.token_id) ?? 0,
      depthTrend: depthMetrics.depthTrend,
      depthSpeedBps: depthMetrics.depthSpeedBps,
    });
    if (safeModeEarly && this.config.mmSafeModeRejectThin) {
      const topDepth = this.getTopDepth(orderbook);
      if (this.isLiquidityThin({ topDepth: topDepth.shares, topDepthUsd: topDepth.usd })) {
        return null;
      }
    }
    

    const microPrice = this.calculateMicroPrice(orderbook);
    if (!microPrice || microPrice <= 0 || microPrice >= 1) {
      return null;
    }
    const mid = (bestBid + bestAsk) / 2;
    const pressureMax = Math.max(0, this.config.mmPressureMaxRatio ?? 0);
    const rawPressure = mid > 0 ? (microPrice - mid) / mid : 0;
    const pressure = pressureMax > 0 ? this.clamp(rawPressure, -pressureMax, pressureMax) : rawPressure;

    const baseSpread = this.config.spread;
    let minSpread = this.config.minSpread ?? 0.01;
    let maxSpread = this.config.maxSpread ?? 0.08;

    const lastMid = this.lastPrices.get(market.token_id);
    const volatilityComponent =
      lastMid && lastMid > 0 ? Math.abs(microPrice - lastMid) / lastMid : 0;

    const volEma = this.volatilityEma.get(market.token_id) ?? volatilityComponent;
    const depthRef = this.config.mmDepthRefShares ?? 200;
    const depthEma = this.depthEma.get(market.token_id) ?? 0;
    const topDepth = this.getTopDepth(orderbook).shares;
    const depthTrend = depthEma > 0 ? topDepth / depthEma : 1;
    const depthFactor =
      depthRef > 0 && depthEma > 0 ? this.clamp(depthEma / depthRef, 0.2, 3) : 1;
    const liquidityPenalty = depthFactor < 1 ? 1 / depthFactor - 1 : 0;

    const rawProfile = this.resolveAdaptiveProfile(volEma, depthEma, depthTrend);
    const profile = this.stabilizeProfile(market.token_id, rawProfile);
    if (this.config.mmAdaptiveParams !== false) {
      if (profile === 'CALM') {
        minSpread = this.config.mmProfileSpreadMinCalm ?? minSpread;
        maxSpread = this.config.mmProfileSpreadMaxCalm ?? maxSpread;
      } else if (profile === 'VOLATILE') {
        minSpread = this.config.mmProfileSpreadMinVolatile ?? minSpread;
        maxSpread = this.config.mmProfileSpreadMaxVolatile ?? maxSpread;
      }
    }
    if (this.isLayerRestoreActive(market.token_id)) {
      minSpread += Math.max(0, this.config.mmLayerRestoreMinSpreadAdd ?? 0);
      const cancelBufferAdd = Math.max(0, this.config.mmLayerRestoreCancelBufferAddBps ?? 0);
      if (cancelBufferAdd > 0) {
        minSpread += cancelBufferAdd / 10000;
      }
    }
    if (this.isLayerPanicActive(market.token_id)) {
      minSpread += Math.max(0, this.config.mmPanicSpreadAdd ?? 0);
    }

    const bookWeight = this.config.mmBookSpreadWeight ?? 0.35;
    const volWeight = this.config.mmSpreadVolWeight ?? 1.2;
    const liqWeight = this.config.mmSpreadLiquidityWeight ?? 0.5;

    let adaptiveSpread =
      this.config.mmAdaptiveParams === false
        ? baseSpread + bookSpread * 0.35 + volatilityComponent * 0.5
        : baseSpread * (1 + volEma * volWeight + liquidityPenalty * liqWeight) +
          bookSpread * bookWeight;

    const fillRiskBps = Math.max(0, this.config.mmFillRiskSpreadBps ?? 0);
    if (fillRiskBps > 0) {
      const fillRisk = this.getFillSlowdownMultiplier(market.token_id) - 1;
      if (fillRisk > 0) {
        adaptiveSpread += fillRisk * (fillRiskBps / 10000);
      }
    }

    const nearTouchPenalty = this.getNearTouchPenalty(market.token_id);
    if (nearTouchPenalty > 0) {
      adaptiveSpread += nearTouchPenalty / 10000;
    }
    const fillPenalty = this.getFillPenalty(market.token_id);
    if (fillPenalty > 0) {
      adaptiveSpread += fillPenalty / 10000;
    }
    const noFillPenalty = this.getNoFillPenalty(market.token_id);
    if (noFillPenalty.spreadBps > 0) {
      adaptiveSpread += noFillPenalty.spreadBps / 10000;
    }

    const depthTarget = this.config.mmDepthTargetShares ?? 0;
    if (depthTarget > 0) {
      const depthRatio = this.clamp(depthMetrics.totalDepth / depthTarget, 0, 1);
      const depthPenaltyWeight = this.config.mmDepthPenaltyWeight ?? 0.6;
      adaptiveSpread += (1 - depthRatio) * baseSpread * depthPenaltyWeight;
    }

    const pressureSpreadWeight = this.config.mmPressureSpreadWeight ?? 0;
    if (pressureSpreadWeight > 0) {
      adaptiveSpread += Math.abs(pressure) * pressureSpreadWeight;
    }

    if (depthMetrics.depthTrend < 0) {
      adaptiveSpread += Math.abs(depthMetrics.depthTrend) * baseSpread * 0.4;
    }

    if (profile === 'VOLATILE') {
      adaptiveSpread *= 1.1;
    } else if (profile === 'CALM') {
      adaptiveSpread *= 0.95;
    }

    if (market.liquidity_activation?.max_spread) {
      adaptiveSpread = Math.min(adaptiveSpread, market.liquidity_activation.max_spread * 0.95);
    }

    const safeModeActive = this.isSafeModeActive(market.token_id, {
      volEma,
      depthTrend: depthMetrics.depthTrend,
      depthSpeedBps: depthMetrics.depthSpeedBps,
    });
    if (safeModeActive) {
      const spreadMult = Math.max(1, this.config.mmSafeModeSpreadMult ?? 1);
      adaptiveSpread *= spreadMult;
      const spreadAdd = Math.max(0, this.config.mmSafeModeSpreadAdd ?? 0);
      if (spreadAdd > 0) {
        adaptiveSpread += spreadAdd;
      }
      const cancelBufferAdd = Math.max(0, this.config.mmSafeModeCancelBufferAddBps ?? 0);
      if (cancelBufferAdd > 0) {
        adaptiveSpread += cancelBufferAdd / 10000;
      }
    } else {
      const holdMs = Math.max(0, this.config.mmSafeModeExitHoldMs ?? 0);
      if (holdMs > 0) {
        this.safeModeExitUntil.set(market.token_id, Date.now() + holdMs);
      }
    }

    if (safeModeActive) {
      const safeMin = Math.max(0, this.config.mmSafeModeMinSpread ?? 0);
      const safeMax = Math.max(0, this.config.mmSafeModeMaxSpread ?? 0);
      if (safeMin > minSpread) {
        minSpread = safeMin;
      }
      if (safeMax > 0 && (maxSpread === 0 || safeMax < maxSpread)) {
        maxSpread = safeMax;
      }
    }

    adaptiveSpread = this.clamp(adaptiveSpread, minSpread, maxSpread);

    const inventoryBias = this.calculateInventoryBias(market.token_id);
    let inventorySkewFactor = this.config.inventorySkewFactor ?? 0.15;
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    if (this.config.mmAdaptiveParams !== false) {
      const volSkewWeight = this.config.mmInventorySkewVolWeight ?? 1.0;
      const liqSkewWeight = this.config.mmInventorySkewDepthWeight ?? 0.4;
      inventorySkewFactor =
        inventorySkewFactor * (1 + volEma * volSkewWeight + liquidityPenalty * liqSkewWeight);
    }

    let fairPrice = microPrice * (1 - inventoryBias * inventorySkewFactor * adaptiveSpread);
    if (this.config.mmAdaptiveParams !== false) {
      const imbalanceWeight = this.config.mmImbalanceWeight ?? 0.25;
      const imbalanceMax = this.config.mmImbalanceMaxSkew ?? 0.6;
      const skew = this.clamp(imbalance * imbalanceWeight, -imbalanceMax, imbalanceMax);
      fairPrice = fairPrice * (1 + skew * adaptiveSpread);
    }
    let valueBias = 0;
    let valueConfidence = 0;

    if (this.config.useValueSignal && this.valueDetector) {
      const analysis = this.valueDetector.analyzeMarket(market, orderbook);
      if (analysis) {
        const confidenceMin = this.config.valueConfidenceMin ?? 0.6;
        if (analysis.confidence >= confidenceMin) {
          const weight = this.config.valueSignalWeight ?? 0.35;
          const blend = this.clamp(weight * analysis.confidence, 0, 0.9);
          const valueFair = analysis.fairTokenPrice ?? analysis.estimatedProbability;
          const blended = fairPrice * (1 - blend) + valueFair * blend;
          valueBias = blended - fairPrice;
          valueConfidence = analysis.confidence;
          fairPrice = blended;
        }
      }
    }

    const inventorySpreadWeight = this.config.mmInventorySpreadWeight ?? 0.2;
    const imbalanceSpreadWeight = this.config.mmImbalanceSpreadWeight ?? 0.2;
    const spreadBoost =
      1 +
      Math.abs(inventoryBias) * inventorySpreadWeight +
      Math.abs(imbalance) * imbalanceSpreadWeight;
    const half = (adaptiveSpread * spreadBoost) / 2;
    const invWeight = this.config.mmAsymSpreadInventoryWeight ?? 0.4;
    const imbWeight = this.config.mmAsymSpreadImbalanceWeight ?? 0.35;
    const minFactor = this.config.mmAsymSpreadMinFactor ?? 0.6;
    const maxFactor = this.config.mmAsymSpreadMaxFactor ?? 1.8;
    const depthImbalance = depthMetrics.imbalance;

    const bidFactor = this.clamp(1 + inventoryBias * invWeight - depthImbalance * imbWeight, minFactor, maxFactor);
    const askFactor = this.clamp(1 - inventoryBias * invWeight + depthImbalance * imbWeight, minFactor, maxFactor);
    let quoteOffset = Math.max(0, this.config.mmQuoteOffsetBps ?? 0) / 10000;
    if (market.liquidity_activation?.max_spread) {
      const maxAllowed = market.liquidity_activation.max_spread * 0.95;
      const remaining = Math.max(0, maxAllowed - adaptiveSpread);
      quoteOffset = Math.min(quoteOffset, remaining / 2);
    }
    const pressureOffsetWeight = this.config.mmPressureOffsetWeight ?? 0;
    if (pressureOffsetWeight > 0) {
      quoteOffset += Math.abs(pressure) * pressureOffsetWeight;
    }

    let bid = fairPrice * (1 - half * bidFactor - quoteOffset);
    let ask = fairPrice * (1 + half * askFactor + quoteOffset);

    // Keep maker-friendly but never cross top of book
    let touchBufferBps = Math.max(0, this.config.mmTouchBufferBps ?? 0) + (noFillPenalty.touchBps || 0);
    if (this.isLayerRestoreActive(market.token_id)) {
      touchBufferBps += Math.max(0, this.config.mmLayerRestoreTouchBufferBps ?? 0);
    }
    if (this.isLayerRestoreActive(market.token_id) && this.config.mmLayerRestoreNoNearTouch) {
      const extra = Math.max(0, this.config.mmLayerRestoreNearTouchBps ?? 0);
      if (extra > 0) {
        touchBufferBps += extra;
      } else {
        touchBufferBps += Math.max(touchBufferBps, 6);
      }
    }
    if (this.isLayerPanicActive(market.token_id)) {
      touchBufferBps += Math.max(0, this.config.mmPanicTouchBufferBps ?? 0);
    }
    if (safeModeActive) {
      touchBufferBps += Math.max(0, this.config.mmSafeModeTouchBufferBps ?? 0);
    }
    if (touchBufferBps > 0) {
      const buffer = touchBufferBps / 10000;
      const maxBid = bestBid * (1 - buffer);
      const minAsk = bestAsk * (1 + buffer);
      bid = Math.min(bid, maxBid);
      ask = Math.max(ask, minAsk);
    } else {
      bid = Math.max(bid, bestBid + MarketMaker.MIN_TICK);
      ask = Math.min(ask, bestAsk - MarketMaker.MIN_TICK);
    }

    bid = this.clamp(bid, 0.01, 0.99);
    ask = this.clamp(ask, 0.01, 0.99);

    if (bid >= ask - MarketMaker.MIN_TICK) {
      return null;
    }

    return {
      bidPrice: bid,
      askPrice: ask,
      midPrice: microPrice,
      spread: adaptiveSpread,
      pressure,
      inventoryBias,
      valueBias,
      valueConfidence,
      depth: depthMetrics.totalDepth,
      depthTrend: depthMetrics.depthTrend,
      imbalance: depthImbalance,
      profile,
      volatility: volatilityComponent,
    };
  }

  calculateOrderSize(
    market: Market,
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    price: number
  ): OrderSizeResult {
    if (!Number.isFinite(price) || price <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const positionValue = this.positions.get(market.token_id)?.total_value || 0;
    const effectiveMaxPosition = this.getEffectiveMaxPosition();
    const remainingRiskBudget = Math.max(0, effectiveMaxPosition - positionValue);

    if (remainingRiskBudget <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const effectiveOrderSize = this.getEffectiveOrderSize();
    const effectiveMaxSingle = this.getEffectiveMaxSingleOrderValue();
    const targetOrderValue = Math.min(effectiveOrderSize, effectiveMaxSingle, remainingRiskBudget);

    if (targetOrderValue <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const safeModeActive = this.isSafeModeActive(market.token_id, {
      volEma: this.volatilityEma.get(market.token_id) ?? 0,
      depthTrend: this.depthTrend.get(market.token_id) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(market.token_id) ?? 0,
    });

    let shares = Math.floor(targetOrderValue / price);
    const depthUsage = this.config.mmOrderDepthUsage ?? 0;
    const topDepth = this.lastDepth.get(market.token_id);
    if (depthUsage > 0 && topDepth && topDepth > 0) {
      let cap = Math.max(1, Math.floor(topDepth * depthUsage));
      if (safeModeActive) {
        const mult = Math.max(0, this.config.mmSafeModeDepthUsageMult ?? 1);
        if (mult > 0) {
          cap = Math.max(1, Math.floor(cap * mult));
        }
      }
      shares = Math.min(shares, cap);
    }

    const depthFactor = this.config.mmDepthShareFactor ?? 0;
    let depthCap = 0;
    if (depthFactor > 0) {
      const levels = this.config.mmDepthLevels ?? 3;
      const sideLevels = side === 'BUY' ? orderbook.bids : orderbook.asks;
      depthCap = Math.floor(this.sumDepthLevels(sideLevels, levels) * depthFactor);
      if (safeModeActive) {
        const mult = Math.max(0, this.config.mmSafeModeDepthCapMult ?? 1);
        if (mult > 0) {
          depthCap = Math.max(1, Math.floor(depthCap * mult));
        }
      }
    }

    const inventoryBias = this.calculateInventoryBias(market.token_id);
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    const sizeInvWeight = this.config.mmSizeInventoryWeight ?? 0.4;
    const sizeImbWeight = this.config.mmSizeImbalanceWeight ?? 0.3;
    const sizeMin = this.config.mmSizeMinFactor ?? 0.3;
    const sizeMax = this.config.mmSizeMaxFactor ?? 1.4;
    let sizeFactor = 1;
    if (side === 'BUY') {
      sizeFactor *= 1 - inventoryBias * sizeInvWeight;
      sizeFactor *= 1 + imbalance * sizeImbWeight;
    } else {
      sizeFactor *= 1 + inventoryBias * sizeInvWeight;
      sizeFactor *= 1 - imbalance * sizeImbWeight;
    }
    sizeFactor = this.clamp(sizeFactor, sizeMin, sizeMax);
    const penalty = this.getSizePenalty(market.token_id);
    const noFill = this.getNoFillPenalty(market.token_id);
    shares = Math.floor(shares * sizeFactor * penalty * (noFill.sizeFactor || 1));

    const minShares = market.liquidity_activation?.min_shares || 0;
    if (minShares > 0 && shares < minShares) {
      const minOrderValue = minShares * price;
      const hardCap = this.config.maxSingleOrderValue ?? Number.POSITIVE_INFINITY;
      if (minOrderValue <= hardCap && minOrderValue <= remainingRiskBudget) {
        if (!depthCap || minShares <= depthCap) {
          shares = minShares;
        }
      }
    }

    if (market.liquidity_activation?.active && this.config.mmPointsMinOnly && minShares > 0) {
      const multiplier = Math.max(1, this.config.mmPointsMinMultiplier ?? 1);
      const cap = Math.max(minShares, Math.floor(minShares * multiplier));
      shares = Math.min(shares, cap);
      if (shares < minShares) {
        shares = minShares;
      }
    }

    if (depthCap > 0) {
      shares = Math.min(shares, depthCap);
    }

    const maxShares = this.config.mmMaxSharesPerOrder ?? 0;
    if (maxShares > 0) {
      shares = Math.min(shares, Math.floor(maxShares));
    }
    if (safeModeActive) {
      const maxSafe = this.config.mmSafeModeMaxSharesPerOrder ?? 0;
      if (maxSafe > 0) {
        shares = Math.min(shares, Math.floor(maxSafe));
      }
    }

    if (shares <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const usdt = shares * price;
    const maxSingleOrderValue = effectiveMaxSingle;

    if (usdt > maxSingleOrderValue) {
      const cappedShares = Math.max(0, Math.floor(maxSingleOrderValue / price));
      return {
        shares: cappedShares,
        usdt: cappedShares * price,
      };
    }

    return { shares, usdt };
  }

  checkLiquidityPointsEligibility(market: Market, orderbook: Orderbook): boolean {
    if (!market.liquidity_activation?.active) {
      return false;
    }

    if (market.liquidity_activation.max_spread_cents && orderbook.spread) {
      const maxSpread = market.liquidity_activation.max_spread_cents / 100;
      if (orderbook.spread > maxSpread) {
        return false;
      }
    }

    return true;
  }

  isNearBestPrice(
    price: number,
    side: 'BUY' | 'SELL',
    orderbook: Orderbook,
    threshold: number = 0.005
  ): boolean {
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;

    if (side === 'BUY' && bestBid && price >= bestBid * (1 - threshold)) {
      return true;
    }

    if (side === 'SELL' && bestAsk && price <= bestAsk * (1 + threshold)) {
      return true;
    }

    return false;
  }

  private shouldRepriceOrder(order: Order, targetPrice: number): boolean {
    const current = Number(order.price);
    if (!Number.isFinite(current) || current <= 0) {
      return true;
    }

    const diff = Math.abs(targetPrice - current) / current;
    const base = this.config.repriceThreshold ?? 0.003;
    const mult = this.getVolatilityMultiplier(order.token_id, this.config.mmRepriceVolMultiplier ?? 1.5);
    const noFill = this.getNoFillPenalty(order.token_id);
    let threshold = (base + (noFill.repriceBps || 0) / 10000) / mult;
    let buffer = Math.max(0, this.config.mmRepriceBufferBps ?? 0);
    let confirmMs = Math.max(0, this.config.mmRepriceConfirmMs ?? 0);
    if (
      this.isSafeModeActive(order.token_id, {
        volEma: this.volatilityEma.get(order.token_id) ?? 0,
        depthTrend: this.depthTrend.get(order.token_id) ?? 0,
        depthSpeedBps: this.lastDepthSpeedBps.get(order.token_id) ?? 0,
      })
    ) {
      const mult = Math.max(1, this.config.mmSafeModeRepriceMult ?? 1);
      threshold = threshold / mult;
      const add = Math.max(0, this.config.mmSafeModeRepriceBufferAddBps ?? 0);
      if (add > 0) {
        buffer += add / 10000;
      }
      const confirmMult = Math.max(1, this.config.mmSafeModeRepriceConfirmMult ?? 1);
      confirmMs = Math.round(confirmMs * confirmMult);
    }
    const hard = threshold * (1 + buffer);
    if (diff >= hard) {
      this.repriceHoldUntil.delete(order.order_hash);
      return true;
    }
    if (diff < threshold) {
      this.repriceHoldUntil.delete(order.order_hash);
      return false;
    }
    if (confirmMs <= 0) {
      return true;
    }
    const until = this.repriceHoldUntil.get(order.order_hash) || 0;
    if (!until) {
      this.repriceHoldUntil.set(order.order_hash, Date.now() + confirmMs);
      return false;
    }
    if (Date.now() >= until) {
      this.repriceHoldUntil.delete(order.order_hash);
      return true;
    }
    return false;
  }

  private getAdaptiveCooldown(tokenId: string, baseMs: number): number {
    if (this.config.mmAdaptiveParams === false) {
      return baseMs;
    }
    const mult = this.getVolatilityMultiplier(tokenId, this.config.mmCooldownVolMultiplier ?? 1.2);
    return Math.round(baseMs * mult);
  }

  private trimExcessOrders(tokenId: string, orders: Order[]): Order[] {
    const maxOrders = this.getEffectiveMaxOrdersPerMarket();
    if (orders.length <= maxOrders) {
      return orders;
    }

    const sorted = [...orders].sort((a, b) => b.timestamp - a.timestamp);
    const keep = sorted.slice(0, maxOrders);
    const cancel = sorted.slice(maxOrders);

    for (const order of cancel) {
      void this.cancelOrder(order);
    }

    return keep;
  }

  private getEffectiveMaxOrdersPerMarket(): number {
    const base = this.config.maxOrdersPerMarket ?? 2;
    const layerCount = Math.max(1, Math.floor(this.config.mmLayerCount ?? 1));
    if (layerCount <= 1) {
      return base;
    }
    return Math.max(base, layerCount * 2);
  }

  async placeMMOrders(market: Market, orderbook: Orderbook): Promise<void> {
    if (!this.config.enableTrading) {
      console.log('⚠️  Trading is disabled. Set ENABLE_TRADING=true to enable.');
      return;
    }

    if (this.tradingHalted) {
      console.log('🛑 Trading halted by risk controls.');
      return;
    }

    if (!this.orderManager) {
      if (!this.warnedNoExecution) {
        console.log('⚠️  OrderManager is not initialized, skip live order placement.');
        this.warnedNoExecution = true;
      }
      return;
    }

    const tokenId = market.token_id;
    this.updateBestPrices(tokenId, orderbook);
    if (!this.lastFillAt.has(tokenId)) {
      this.lastFillAt.set(tokenId, Date.now());
    }

    if (this.isPaused(tokenId)) {
      return;
    }

    if (this.layerRestoreExitPending.get(tokenId)) {
      await this.cancelOrdersForMarket(tokenId);
      this.layerRestoreExitPending.delete(tokenId);
      const cooldown = Math.max(0, this.config.mmLayerRestoreExitCooldownMs ?? 0);
      const immediateRequote = this.config.mmLayerRestoreExitImmediateRequote === true;
      if (cooldown > 0) {
        if (immediateRequote) {
          this.cooldownUntil.delete(tokenId);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
      if (immediateRequote) {
        this.lastActionAt.delete(tokenId);
      } else {
        this.markAction(tokenId);
        return;
      }
    }

    const metrics = this.updateMarketMetrics(tokenId, orderbook);
    if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
      const pauseMs = Math.max(0, this.config.mmSafeModePauseMs ?? 0);
      if (pauseMs > 0) {
        this.pauseUntil.set(tokenId, Date.now() + pauseMs);
      }
    }
    if (this.layerRestoreExitRepricePending.has(tokenId)) {
      let effectiveMetrics = metrics;
      if (this.config.mmRestoreExitResync) {
        const freshBook = await this.api.getOrderbook(tokenId);
        effectiveMetrics = this.updateMarketMetrics(tokenId, freshBook);
      }
      const minShares = Math.max(0, this.config.mmRestoreExitMinDepthShares ?? 0);
      const minUsd = Math.max(0, this.config.mmRestoreExitMinDepthUsd ?? 0);
      if (
        (minShares > 0 && effectiveMetrics.topDepth < minShares) ||
        (minUsd > 0 && effectiveMetrics.topDepthUsd < minUsd)
      ) {
        await this.cancelOrdersForMarket(tokenId);
        const cooldown =
          Math.max(0, this.config.mmRestoreExitDepthCooldownMs ?? 0) ||
          (this.config.cooldownAfterCancelMs ?? 4000);
        this.markCooldown(tokenId, cooldown);
        return;
      }
      if (this.config.mmRestoreExitCleanupOnReprice) {
        await this.cancelOrdersForMarket(tokenId);
      }
    }

    if (!this.canSendAction(tokenId)) {
      return;
    }
    if (this.isLiquidityThin(metrics)) {
      console.log(`⚠️ Low liquidity for ${tokenId}, skipping quotes...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    const qualifiesForPoints = this.checkLiquidityPointsEligibility(market, orderbook);
    if (this.config.mmOnlyPointsMarkets && !qualifiesForPoints) {
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    if (this.checkVolatility(tokenId, orderbook)) {
      console.log(`⚠️ Volatility spike detected for ${tokenId}, pausing quoting...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
      return;
    }

    if (this.checkSpreadJump(tokenId, orderbook)) {
      console.log(`⚠️ Spread jump detected for ${tokenId}, pausing quoting...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
      return;
    }

    if (this.shouldCancelOrders(tokenId, orderbook)) {
      console.log(`🚨 Price moved significantly for ${tokenId}, canceling orders...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    let prices = this.calculatePrices(market, orderbook);
    if (!prices) {
      return;
    }

    const rawProfile = this.resolveAdaptiveProfile(metrics.volEma, metrics.depthEma, metrics.depthTrend);
    const profile = this.stabilizeProfile(tokenId, rawProfile);

    this.recordMmMetrics(market, orderbook, prices, profile, metrics);

    let existingOrders = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );
    existingOrders = this.trimExcessOrders(tokenId, existingOrders);

    const existingBids = existingOrders
      .filter((o) => o.side === 'BUY')
      .sort((a, b) => Number(b.price) - Number(a.price));
    const existingAsks = existingOrders
      .filter((o) => o.side === 'SELL')
      .sort((a, b) => Number(a.price) - Number(b.price));

    const layerCount = this.getEffectiveLayerCount(
      tokenId,
      profile,
      metrics.depthTrend,
      metrics.depthSpeedBps
    );
    const rampedLayerCount = this.getRestoreExitRampCap(tokenId, layerCount);
    let layerStepBps = this.getEffectiveLayerStepBps(
      tokenId,
      profile,
      metrics.depthTrend,
      metrics.depthSpeedBps
    );
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: metrics.volEma,
      depthTrend: metrics.depthTrend,
      depthSpeedBps: metrics.depthSpeedBps,
    });
    if (safeModeActive) {
      const stepMult = Math.max(1, this.config.mmSafeModeStepMult ?? 1);
      layerStepBps *= stepMult;
    }
    let bidPriceBase = prices.bidPrice;
    let askPriceBase = prices.askPrice;
    const panicSingleSide = this.isLayerPanicActive(tokenId)
      ? (this.config.mmPanicSingleSide || 'NONE').toUpperCase()
      : 'NONE';
    const safeSingleSide =
      panicSingleSide === 'NONE' && safeModeActive
        ? (this.config.mmSafeModeSingleSide || 'NONE').toUpperCase()
        : 'NONE';
    const effectiveSingleSide = panicSingleSide !== 'NONE' ? panicSingleSide : safeSingleSide;
    const panicSingleSideOffsetBps = Math.max(0, this.config.mmPanicSingleSideOffsetBps ?? 0);
    const safeSingleSideOffsetBps = Math.max(0, this.config.mmSafeModeSingleSideOffsetBps ?? 0);
    const singleSideOffsetBps = panicSingleSide !== 'NONE' ? panicSingleSideOffsetBps : safeSingleSideOffsetBps;
    if (singleSideOffsetBps > 0 && effectiveSingleSide !== 'NONE') {
      const offset = singleSideOffsetBps / 10000;
      if (effectiveSingleSide === 'BUY') {
        bidPriceBase = Math.max(0.01, bidPriceBase * (1 - offset));
      } else if (effectiveSingleSide === 'SELL') {
        askPriceBase = Math.min(0.99, askPriceBase * (1 + offset));
      }
    }
    const bidTargets = this.buildLayerTargets(bidPriceBase, 'BUY', rampedLayerCount, layerStepBps);
    const askTargets = this.buildLayerTargets(askPriceBase, 'SELL', rampedLayerCount, layerStepBps);
    const bidLayers = bidTargets.length;
    const askLayers = askTargets.length;
    const canceledOrders = new Set<string>();

    for (let i = 0; i < existingBids.length; i += 1) {
      const existingBid = existingBids[i];
      const targetPrice = bidTargets[i];
      if (targetPrice === undefined) {
        await this.cancelOrder(existingBid);
        canceledOrders.add(existingBid.order_hash);
        continue;
      }
      let risk = this.evaluateOrderRisk(existingBid, orderbook);
      let shouldReprice = this.shouldRepriceOrder(existingBid, targetPrice);
      if (this.layerRestoreExitRepricePending.has(tokenId)) {
        shouldReprice = true;
      }
      if ((risk.cancel || shouldReprice) && this.canRecheck(tokenId)) {
        const delay = risk.cancel
          ? Math.max(0, this.config.mmCancelRecheckMs ?? 0)
          : Math.max(0, this.config.mmRepriceRecheckMs ?? 0);
        if (delay > 0) {
          await this.sleep(delay);
          const freshBook = await this.api.getOrderbook(tokenId);
          if (risk.cancel) {
            const freshRisk = this.evaluateOrderRisk(existingBid, freshBook);
            risk = freshRisk;
          }
          if (shouldReprice) {
            const freshPrices = this.calculatePrices(market, freshBook);
            if (freshPrices) {
              prices = freshPrices;
              const refreshTargets = this.buildLayerTargets(prices.bidPrice, 'BUY', layerCount, layerStepBps);
              const nextTarget = refreshTargets[i] ?? targetPrice;
              shouldReprice = this.shouldRepriceOrder(existingBid, nextTarget);
            }
          }
        }
      }
      if (risk.cancel || shouldReprice) {
        if (
          risk.cancel &&
          (risk.reason.startsWith('near-touch') ||
            risk.reason === 'anti-fill' ||
            risk.reason.startsWith('hit-warning') ||
            risk.reason === 'aggressive-move' ||
            risk.reason === 'price-accel' ||
            risk.reason === 'vwap-risk' ||
            risk.reason.startsWith('restore-no-near-touch'))
        ) {
          const intensity = risk.panic ? 1.5 : 1;
          this.applyNearTouchPenalty(tokenId, intensity);
          if (risk.panic) {
            this.applyLayerPanic(tokenId);
            const panicPause = Math.max(0, this.config.mmPanicPauseMs ?? 0);
            if (panicPause > 0) {
              this.pauseUntil.set(tokenId, Date.now() + panicPause);
            }
          }
          const sizePenalty = this.config.mmNearTouchSizePenalty ?? 0;
          if (sizePenalty > 0 && sizePenalty < 1) {
            this.applySizePenalty(tokenId, sizePenalty, true);
          }
        }
        await this.cancelOrder(existingBid);
        canceledOrders.add(existingBid.order_hash);
        const softCooldown = this.config.mmSoftCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const hardCooldown = this.config.mmHardCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const baseCooldown = risk.panic ? hardCooldown : softCooldown;
        let cooldown = this.getAdaptiveCooldown(tokenId, baseCooldown);
        if (this.isLayerPanicActive(tokenId)) {
          const mult = Math.max(1, this.config.mmPanicCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        } else if (this.isLayerRestoreActive(tokenId)) {
          const mult = Math.max(1, this.config.mmRestoreCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
          const mult = Math.max(1, this.config.mmSafeModeCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (risk.panic) {
          this.pauseForVolatility(tokenId);
          this.markCooldown(tokenId, cooldown + 2000);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
    }

    for (let i = 0; i < existingAsks.length; i += 1) {
      const existingAsk = existingAsks[i];
      const targetPrice = askTargets[i];
      if (targetPrice === undefined) {
        await this.cancelOrder(existingAsk);
        canceledOrders.add(existingAsk.order_hash);
        continue;
      }
      let risk = this.evaluateOrderRisk(existingAsk, orderbook);
      let shouldReprice = this.shouldRepriceOrder(existingAsk, targetPrice);
      if (this.layerRestoreExitRepricePending.has(tokenId)) {
        shouldReprice = true;
      }
      if ((risk.cancel || shouldReprice) && this.canRecheck(tokenId)) {
        const delay = risk.cancel
          ? Math.max(0, this.config.mmCancelRecheckMs ?? 0)
          : Math.max(0, this.config.mmRepriceRecheckMs ?? 0);
        if (delay > 0) {
          await this.sleep(delay);
          const freshBook = await this.api.getOrderbook(tokenId);
          if (risk.cancel) {
            const freshRisk = this.evaluateOrderRisk(existingAsk, freshBook);
            risk = freshRisk;
          }
          if (shouldReprice) {
            const freshPrices = this.calculatePrices(market, freshBook);
            if (freshPrices) {
              prices = freshPrices;
              const refreshTargets = this.buildLayerTargets(prices.askPrice, 'SELL', layerCount, layerStepBps);
              const nextTarget = refreshTargets[i] ?? targetPrice;
              shouldReprice = this.shouldRepriceOrder(existingAsk, nextTarget);
            }
          }
        }
      }
      if (risk.cancel || shouldReprice) {
        if (
          risk.cancel &&
          (risk.reason.startsWith('near-touch') ||
            risk.reason === 'anti-fill' ||
            risk.reason.startsWith('hit-warning') ||
            risk.reason === 'aggressive-move' ||
            risk.reason === 'price-accel' ||
            risk.reason === 'vwap-risk' ||
            risk.reason.startsWith('restore-no-near-touch'))
        ) {
          const intensity = risk.panic ? 1.5 : 1;
          this.applyNearTouchPenalty(tokenId, intensity);
          if (risk.panic) {
            this.applyLayerPanic(tokenId);
            const panicPause = Math.max(0, this.config.mmPanicPauseMs ?? 0);
            if (panicPause > 0) {
              this.pauseUntil.set(tokenId, Date.now() + panicPause);
            }
          }
          const sizePenalty = this.config.mmNearTouchSizePenalty ?? 0;
          if (sizePenalty > 0 && sizePenalty < 1) {
            this.applySizePenalty(tokenId, sizePenalty, true);
          }
        }
        await this.cancelOrder(existingAsk);
        canceledOrders.add(existingAsk.order_hash);
        const softCooldown = this.config.mmSoftCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const hardCooldown = this.config.mmHardCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const baseCooldown = risk.panic ? hardCooldown : softCooldown;
        let cooldown = this.getAdaptiveCooldown(tokenId, baseCooldown);
        if (this.isLayerPanicActive(tokenId)) {
          const mult = Math.max(1, this.config.mmPanicCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        } else if (this.isLayerRestoreActive(tokenId)) {
          const mult = Math.max(1, this.config.mmRestoreCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
          const mult = Math.max(1, this.config.mmSafeModeCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (risk.panic) {
          this.pauseForVolatility(tokenId);
          this.markCooldown(tokenId, cooldown + 2000);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
    }

    const refreshedOrders = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );

    const remainingBids = refreshedOrders
      .filter((o) => o.side === 'BUY' && !canceledOrders.has(o.order_hash))
      .sort((a, b) => Number(b.price) - Number(a.price));
    const remainingAsks = refreshedOrders
      .filter((o) => o.side === 'SELL' && !canceledOrders.has(o.order_hash))
      .sort((a, b) => Number(a.price) - Number(b.price));
    let hasBid = remainingBids.length > 0;
    let hasAsk = remainingAsks.length > 0;
    if (this.layerRestoreExitRepricePending.has(tokenId)) {
      this.layerRestoreExitRepricePending.delete(tokenId);
    }

    const bidOrderSize = this.calculateOrderSize(market, orderbook, 'BUY', prices.bidPrice);
    const askOrderSize = this.calculateOrderSize(market, orderbook, 'SELL', prices.askPrice);

    const profileScale = profile === 'CALM' ? 1.0 : profile === 'VOLATILE' ? 0.6 : 0.85;
    const canIceberg = this.config.mmIcebergEnabled && this.canRequoteIceberg(tokenId, metrics.depthTrend);
    if (canIceberg) {
      await this.cancelOrdersForMarket(tokenId);
      hasBid = false;
      hasAsk = false;
    }

    console.log(`📝 Market ${market.question.substring(0, 40)}...`);
    const valueInfo =
      prices.valueConfidence && Math.abs(prices.valueBias ?? 0) > 0
        ? ` valueBias=${prices.valueBias?.toFixed(4)} conf=${(prices.valueConfidence * 100).toFixed(0)}%`
        : '';

    const imbalance = prices.imbalance ?? this.calculateOrderbookImbalance(orderbook);
    const depthInfo = prices.depth && prices.depth > 0 ? ` depth=${prices.depth.toFixed(0)}` : '';
    console.log(
      `   bid=${prices.bidPrice.toFixed(4)} ask=${prices.askPrice.toFixed(4)} spread=${(prices.spread * 100).toFixed(2)}% ` +
        `bias=${prices.inventoryBias.toFixed(2)} imb=${imbalance.toFixed(2)}${depthInfo}${valueInfo} ${qualifiesForPoints ? '✨' : ''} profile=${profile}`
    );

    const suppressBuy = prices.inventoryBias > 0.85;
    const suppressSell = prices.inventoryBias < -0.85;

    let placed = false;
    const allowBelowMin = this.config.mmLayerAllowBelowMinShares === true;
    let sizeFloor = 1;
    if (this.isLayerPanicActive(tokenId)) {
      const floor = this.config.mmLayerPanicSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    if (this.isLayerRetreatActive(tokenId)) {
      const floor = this.config.mmLayerRetreatSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const floor = this.config.mmLayerRestoreSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    const speedFloor = this.config.mmLayerSpeedSizeMinFactor ?? 0;
    const retreatFloor = this.config.mmLayerRetreatSizeMinFactor ?? 0;
    if (speedFloor > 0 && metrics.depthSpeedBps >= (this.config.mmLayerDepthSpeedBps ?? 0)) {
      sizeFloor = Math.min(sizeFloor, speedFloor);
    }
    if (retreatFloor > 0 && metrics.depthSpeedBps >= (this.config.mmLayerDepthSpeedRetreatBps ?? 0)) {
      sizeFloor = Math.min(sizeFloor, retreatFloor);
    }
    const minShares = market.liquidity_activation?.min_shares || 0;
    let targetBidShares = Math.max(1, Math.floor(bidOrderSize.shares * profileScale));
    let targetAskShares = Math.max(1, Math.floor(askOrderSize.shares * profileScale));
    if (this.isLayerRestoreActive(tokenId)) {
      const scale = this.config.mmLayerRestoreSizeScale ?? 0;
      if (scale > 0 && scale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
      }
      const panicScale = this.config.mmPanicRestoreSizeScale ?? 0;
      if (panicScale > 0 && panicScale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * panicScale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * panicScale));
      }
    }
    if (safeModeActive) {
      const scale = this.config.mmSafeModeSizeScale ?? 0;
      if (scale > 0 && scale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
      }
    }
    const cooldownUntil = this.cooldownUntil.get(tokenId) || 0;
    if (cooldownUntil > Date.now()) {
      if (this.isLayerPanicActive(tokenId)) {
        const scale = this.config.mmPanicCooldownSizeScale ?? 0;
        if (scale > 0 && scale < 1) {
          targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
          targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
        }
      } else if (this.isLayerRestoreActive(tokenId)) {
        const scale = this.config.mmRestoreCooldownSizeScale ?? 0;
        if (scale > 0 && scale < 1) {
          targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
          targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
        }
      }
    }
    const exitSizeFactor = this.getRestoreExitSizeFactor(tokenId);
    if (exitSizeFactor < 1) {
      targetBidShares = Math.max(1, Math.floor(targetBidShares * exitSizeFactor));
      targetAskShares = Math.max(1, Math.floor(targetAskShares * exitSizeFactor));
    }

    if (effectiveSingleSide === 'BUY') {
      targetAskShares = 0;
    } else if (effectiveSingleSide === 'SELL') {
      targetBidShares = 0;
    }
    const restoreCap =
      this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreMaxShares
        ? Math.max(1, this.config.mmLayerRestoreMaxShares)
        : 0;
    const bidSizeBase = restoreCap > 0 ? Math.min(targetBidShares, restoreCap) : targetBidShares;
    const askSizeBase = restoreCap > 0 ? Math.min(targetAskShares, restoreCap) : targetAskShares;
    const bidSizes = this.buildLayerSizes(bidSizeBase, minShares, allowBelowMin, layerCount, sizeFloor).slice(0, bidLayers);
    const askSizes = this.buildLayerSizes(askSizeBase, minShares, allowBelowMin, layerCount, sizeFloor).slice(0, askLayers);

    const retreatOnlyFar =
      this.config.mmLayerRetreatOnlyFar === true &&
      (this.isLayerRetreatActive(tokenId) ||
        (this.config.mmLayerDepthSpeedRetreatBps &&
          metrics.depthSpeedBps >= this.config.mmLayerDepthSpeedRetreatBps));
    const restoreOnlyFar = this.config.mmLayerRestoreOnlyFar === true && this.isLayerRestoreActive(tokenId);
    const panicOnlyFar = this.config.mmLayerPanicOnlyFar === true && this.isLayerPanicActive(tokenId);
    const panicSingleSideMode = (this.config.mmPanicSingleSideMode || 'NORMAL').toUpperCase();
    const panicRemoteOnly = panicSingleSide !== 'NONE' && panicSingleSideMode === 'REMOTE';
    const safeSingleSideMode = (this.config.mmSafeModeSingleSideMode || 'NORMAL').toUpperCase();
    const safeRemoteOnly = safeSingleSide !== 'NONE' && safeSingleSideMode === 'REMOTE';
    const forceSingle = this.shouldForceSingleLayer(tokenId);
    const safeModeOnlyFar = safeModeActive && this.config.mmSafeModeOnlyFar === true;
    const farOnly = retreatOnlyFar || restoreOnlyFar || panicOnlyFar || panicRemoteOnly || safeRemoteOnly || safeModeOnlyFar;
    const safeOnlyFarLayers = safeModeActive ? Math.max(0, this.config.mmSafeModeOnlyFarLayers ?? 0) : 0;
    const bidStart = farOnly
      ? bidLayers - 1
      : safeOnlyFarLayers > 0
        ? Math.max(0, bidLayers - safeOnlyFarLayers)
        : 0;
    const askStart = farOnly
      ? askLayers - 1
      : safeOnlyFarLayers > 0
        ? Math.max(0, askLayers - safeOnlyFarLayers)
        : 0;
    const restoreSparse = this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreSparseOdd;

    if (!suppressBuy && bidOrderSize.shares > 0) {
      for (let i = bidStart; i < bidLayers; i += 1) {
        if (restoreSparse && i % 2 === 1) {
          continue;
        }
        if (remainingBids[i]) {
          continue;
        }
        const size = bidSizes[i] ?? 0;
        if (size <= 0) {
          continue;
        }
        const shares = this.applyIceberg(size);
        await this.placeLimitOrder(market, 'BUY', bidTargets[i], shares);
        placed = true;
        if (forceSingle) {
          break;
        }
      }
      hasBid = hasBid || placed;
    }

    if (!suppressSell && askOrderSize.shares > 0) {
      for (let i = askStart; i < askLayers; i += 1) {
        if (restoreSparse && i % 2 === 1) {
          continue;
        }
        if (remainingAsks[i]) {
          continue;
        }
        const size = askSizes[i] ?? 0;
        if (size <= 0) {
          continue;
        }
        const shares = this.applyIceberg(size);
        await this.placeLimitOrder(market, 'SELL', askTargets[i], shares);
        placed = true;
        if (forceSingle) {
          break;
        }
      }
      hasAsk = hasAsk || placed;
    }

    if (placed) {
      this.markAction(tokenId);
    }

    this.lastPrices.set(tokenId, prices.midPrice);
    this.lastPriceAt.set(tokenId, Date.now());
  }

  private async placeLimitOrder(
    market: Market,
    side: 'BUY' | 'SELL',
    price: number,
    shares: number
  ): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    try {
      const payload = await this.orderManager.buildLimitOrderPayload({ market, side, price, shares });
      const response = await this.api.createOrder(payload);
      const orderHash =
        response?.order?.hash ||
        response?.data?.order?.hash ||
        payload?.data?.order?.hash ||
        `local-${Date.now()}`;

      this.openOrders.set(String(orderHash), {
        order_hash: String(orderHash),
        id: response?.id ? String(response.id) : undefined,
        token_id: market.token_id,
        maker: this.orderManager.getMakerAddress(),
        signer: this.orderManager.getSignerAddress(),
        order_type: 'LIMIT',
        side,
        price: price.toString(),
        shares: shares.toString(),
        is_neg_risk: market.is_neg_risk,
        is_yield_bearing: market.is_yield_bearing,
        status: 'OPEN',
        timestamp: Date.now(),
      });

      this.recordAutoTuneEvent(market.token_id, 'PLACED');
      console.log(`✅ ${side} order submitted at ${price.toFixed(4)} (${shares} shares)`);
    } catch (error) {
      console.error(`Error placing ${side} order:`, error);
    }
  }

  async cancelOrdersForMarket(tokenId: string): Promise<void> {
    const ordersToCancel = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );

    for (const order of ordersToCancel) {
      await this.cancelOrder(order);
    }
    if (this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreForceRefresh) {
      this.markAction(tokenId);
    }
  }

  async cancelOrder(order: Order): Promise<void> {
    try {
      const id = order.id || order.order_hash;
      await this.api.removeOrders([id]);
      this.openOrders.delete(order.order_hash);
      this.recordAutoTuneEvent(order.token_id, 'CANCELED');
      console.log(`❌ Canceled ${order.order_hash.substring(0, 10)}...`);
    } catch (error) {
      console.error('Error canceling order:', error);
    }
  }

  async closePosition(tokenId: string): Promise<void> {
    const position = this.positions.get(tokenId);
    if (!position || !this.orderManager) {
      return;
    }

    try {
      const market = await this.api.getMarket(tokenId);
      const orderbook = await this.api.getOrderbook(tokenId);

      if (position.yes_amount > 0) {
        const payload = await this.orderManager.buildMarketOrderPayload({
          market,
          side: 'SELL',
          shares: position.yes_amount,
          orderbook,
          slippageBps: '250',
        });
        await this.api.createOrder(payload);
      }

      console.log(`✅ Position close request sent for ${tokenId}`);
    } catch (error) {
      console.error(`Error closing position ${tokenId}:`, error);
    }
  }

  private async detectAndHedgeFills(): Promise<void> {
    const triggerShares = this.config.hedgeTriggerShares ?? 50;
    if (this.lastNetShares.size === 0) {
      for (const [tokenId, position] of this.positions.entries()) {
        const net = position.yes_amount - position.no_amount;
        this.lastNetShares.set(tokenId, net);
      }
      return;
    }

    for (const [tokenId, position] of this.positions.entries()) {
      const net = position.yes_amount - position.no_amount;
      const prev = this.lastNetShares.get(tokenId) ?? 0;
      const delta = net - prev;
      const absDelta = Math.abs(delta);
      const restoreActive = this.isLayerRestoreActive(tokenId);
      const disableHedge = restoreActive && this.config.mmLayerRestoreDisableHedge;
      const disablePartial = restoreActive && this.config.mmLayerRestoreDisablePartialHedge;
      if (absDelta > 0) {
        this.updateFillPressure(tokenId, absDelta);
        this.lastFillAt.set(tokenId, Date.now());
        this.recordAutoTuneEvent(tokenId, 'FILLED');
      }
      const partialThreshold = this.config.mmPartialFillShares ?? 5;
      if (absDelta > 0) {
        const intensity = this.clamp(absDelta / Math.max(1, partialThreshold), 0.2, 2);
        this.applyFillPenalty(tokenId, intensity);
      }
      if (absDelta > 0 && this.config.mmDynamicCancelOnFill) {
        const intensity = this.clamp(absDelta / Math.max(1, partialThreshold), 0.2, 2);
        this.bumpCancelBoost(tokenId, intensity);
      }
      if (absDelta >= partialThreshold) {
        const penalty = this.config.mmPartialFillPenalty ?? 0.6;
        this.applySizePenalty(tokenId, penalty);
      }
      if (absDelta > 0 && this.config.mmAutoSizeOnFill !== false) {
        const minFactor = this.config.mmAutoSizeMinFactor ?? 0.4;
        const factor = this.clamp(1 - absDelta / (partialThreshold * 5), minFactor, 1);
        this.applySizePenalty(tokenId, factor, true);
      }
      if (absDelta >= triggerShares) {
        this.applyIcebergPenalty(tokenId);
        if (!disableHedge) {
          await this.handleFillHedge(tokenId, delta, position.question);
        }
      } else if (absDelta >= partialThreshold && this.config.mmPartialFillHedge) {
        const maxShares = this.config.mmPartialFillHedgeMaxShares ?? 20;
        const hedgeShares = Math.min(absDelta, maxShares);
        if (hedgeShares > 0) {
          if (!disableHedge && !disablePartial) {
            await this.flattenOnPredict(tokenId, delta, hedgeShares, this.config.mmPartialFillHedgeSlippageBps);
          }
        }
      }
      this.lastNetShares.set(tokenId, net);
    }
  }

  private async handleFillHedge(tokenId: string, delta: number, question: string): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    const lastHedge = this.lastHedgeAt.get(tokenId) || 0;
    if (Date.now() - lastHedge < (this.config.minOrderIntervalMs ?? 3000)) {
      return;
    }

    const mode = this.config.hedgeMode ?? 'FLATTEN';
    const shares = Math.abs(delta);

    if (mode === 'CROSS' && this.crossAggregator && this.crossExecutionRouter) {
      try {
        const hedgeLeg = await this.buildCrossHedgeLeg(tokenId, question, delta, shares);
        if (hedgeLeg) {
          await this.crossExecutionRouter.execute([hedgeLeg]);
          this.lastHedgeAt.set(tokenId, Date.now());
          console.log(`🛡️ Cross-platform hedge executed (${hedgeLeg.platform} ${hedgeLeg.outcome})`);
          return;
        }
      } catch (error) {
        console.error('Cross-platform hedge failed, fallback to flatten:', error);
      }
    }

    await this.flattenOnPredict(tokenId, delta, shares);
    this.lastHedgeAt.set(tokenId, Date.now());
  }

  private async buildCrossHedgeLeg(
    tokenId: string,
    question: string,
    delta: number,
    shares: number
  ): Promise<PlatformLeg | null> {
    if (!this.crossAggregator) {
      return null;
    }

    const platformMap = await this.crossAggregator.getPlatformMarkets([], new Map());
    const mappingStore = this.crossAggregator.getMappingStore();
    if (mappingStore && this.config.crossPlatformUseMapping !== false) {
      try {
        const marketMeta = await this.api.getMarket(tokenId);
        const predictMarket: PlatformMarket = {
          platform: 'Predict',
          marketId: marketMeta.condition_id || marketMeta.event_id || tokenId,
          question: marketMeta.question || question,
          timestamp: Date.now(),
          metadata: {
            conditionId: marketMeta.condition_id || '',
            eventId: marketMeta.event_id || '',
          },
        };
        const mapped = mappingStore.resolveMatches(predictMarket, platformMap);
        if (mapped.length > 0) {
          const match = mapped[0];
          const outcome = delta > 0 ? 'NO' : 'YES';
          const token = outcome === 'YES' ? match.yesTokenId : match.noTokenId;
          const price = outcome === 'YES' ? match.yesAsk : match.noAsk;
          if (token && price) {
            return {
              platform: match.platform,
              tokenId: token,
              side: 'BUY',
              price,
              shares,
              outcome,
            };
          }
        }
      } catch (error) {
        console.error('Mapping hedge lookup failed:', error);
      }
    }
    const candidates: PlatformMarket[] = [];
    for (const [platform, list] of platformMap.entries()) {
      if (platform === 'Predict') continue;
      candidates.push(...list);
    }

    if (candidates.length === 0) {
      return null;
    }

    const minSimilarity = this.config.crossPlatformMinSimilarity ?? 0.78;
    const { match } = findBestMatch(question, candidates, minSimilarity);
    if (!match) {
      return null;
    }

    const outcome = delta > 0 ? 'NO' : 'YES';
    const matchTokenId = outcome === 'YES' ? match.yesTokenId : match.noTokenId;
    const price = outcome === 'YES' ? match.yesAsk : match.noAsk;

    if (!matchTokenId || !price) {
      return null;
    }

    return {
      platform: match.platform,
      tokenId: matchTokenId,
      side: 'BUY',
      price,
      shares,
      outcome,
    };
  }

  private async flattenOnPredict(
    tokenId: string,
    delta: number,
    shares: number,
    slippageOverride?: number
  ): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    const side = delta > 0 ? 'SELL' : 'BUY';
    const market = await this.api.getMarket(tokenId);
    const orderbook = await this.api.getOrderbook(tokenId);
    const payload = await this.orderManager.buildMarketOrderPayload({
      market,
      side,
      shares,
      orderbook,
      slippageBps: String(slippageOverride ?? this.config.hedgeMaxSlippageBps ?? 250),
    });
    await this.api.createOrder(payload);
    console.log(`🛡️ Flattened position on Predict (${side} ${shares})`);
  }

  printStatus(): void {
    console.log('\n📊 Market Maker Status:');
    console.log('─'.repeat(80));
    console.log(`Trading Halted: ${this.tradingHalted ? 'YES' : 'NO'}`);
    console.log(`Open Orders: ${this.openOrders.size}`);
    console.log(`Positions: ${this.positions.size}`);
    console.log(`Session PnL: ${this.sessionPnL.toFixed(2)}`);

    if (this.positions.size > 0) {
      console.log('\nPositions:');
      for (const [tokenId, position] of this.positions) {
        console.log(`  ${tokenId}:`);
        console.log(`    YES: ${position.yes_amount.toFixed(2)} | NO: ${position.no_amount.toFixed(2)}`);
        console.log(`    Value: $${position.total_value.toFixed(2)} | PnL: $${position.pnl.toFixed(2)}`);
      }
    }

    console.log('─'.repeat(80) + '\n');
  }
}
