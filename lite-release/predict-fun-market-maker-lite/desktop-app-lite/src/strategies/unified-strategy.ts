/* eslint-disable */
/**
 * Unified Strategy - Async Hedging + Dual Track Mode
 */
import type { Market, Position } from '../types.js';

export interface UnifiedStrategyConfig {
  enabled: boolean;
  tolerance: number;
  minSize: number;
  maxSize: number;
  buyOffsetBps: number;
  sellOffsetBps: number;
  hedgeSlippageBps: number;
  asyncHedging: boolean;
  dualTrackMode: boolean;
  dynamicOffsetMode: boolean;
}

export enum UnifiedState {
  EMPTY = 'EMPTY',
  HEDGED = 'HEDGED',
  DUAL_TRACK = 'DUAL_TRACK',
}

export interface DualTrackState {
  pendingBuyShares: number;
  pendingBuyPrice: number;
  hedgedShares: number;
  pendingSellShares: number;
  pendingSellPrice: number;
  totalBuyFilled: number;
  totalHedgeFilled: number;
  totalSellFilled: number;
  buyPointsEarned: number;
  sellPointsEarned: number;
}

export const DEFAULT_CONFIG: UnifiedStrategyConfig = {
  enabled: false,
  tolerance: 0.05,
  minSize: 10,
  maxSize: 500,
  buyOffsetBps: 100,
  sellOffsetBps: 100,
  hedgeSlippageBps: 250,
  asyncHedging: true,
  dualTrackMode: true,
  dynamicOffsetMode: true,
};

export class UnifiedStrategy {
  private config: UnifiedStrategyConfig;
  private states: Map<string, DualTrackState> = new Map();

  constructor(config: Partial<UnifiedStrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isEnabled(): boolean { return this.config.enabled; }
  getConfig(): UnifiedStrategyConfig { return { ...this.config }; }

  getState(tokenId: string): DualTrackState {
    if (!this.states.has(tokenId)) {
      this.states.set(tokenId, {
        pendingBuyShares: 0, pendingBuyPrice: 0, hedgedShares: 0,
        pendingSellShares: 0, pendingSellPrice: 0, totalBuyFilled: 0,
        totalHedgeFilled: 0, totalSellFilled: 0, buyPointsEarned: 0, sellPointsEarned: 0,
      });
    }
    return this.states.get(tokenId)!;
  }

  analyze(market: Market, position: Position, yesPrice: number): {
    state: UnifiedState; shouldBuy: boolean; shouldSell: boolean;
    buySize: number; sellSize: number;
  } {
    const yes = position.yes_amount || 0;
    const no = position.no_amount || 0;
    const total = yes + no;
    const avg = total / 2;
    const deviation = avg > 0 ? Math.abs(yes - no) / avg : 0;
    const balanced = deviation <= this.config.tolerance;

    let state: UnifiedState;
    let shouldBuy = false;
    let shouldSell = false;

    if (total === 0) {
      state = UnifiedState.EMPTY;
      shouldBuy = true;
    } else if (balanced && total >= this.config.minSize) {
      state = UnifiedState.DUAL_TRACK;
      shouldBuy = true;
      shouldSell = true;
    } else {
      state = UnifiedState.HEDGED;
      shouldBuy = true;
      shouldSell = yes > 0 || no > 0;
    }

    const baseSize = Math.max(this.config.minSize, 10);
    return {
      state,
      shouldBuy,
      shouldSell,
      buySize: shouldBuy ? baseSize : 0,
      sellSize: shouldSell ? Math.min(baseSize, Math.floor(total / 2)) : 0,
    };
  }

  suggestPrices(yesPrice: number, bestBid?: number, bestAsk?: number): {
    bid: number;
    ask: number;
  } {
    const buyOffset = this.config.buyOffsetBps / 10000;
    const sellOffset = this.config.sellOffsetBps / 10000;

    const bid = Math.max(0.01, (bestBid ?? yesPrice) * (1 - buyOffset));
    const ask = Math.min(0.99, (bestAsk ?? yesPrice * 1.01) * (1 + sellOffset));

    return { bid, ask };
  }

  updatePendingOrders(tokenId: string, buyShares: number, buyPrice: number, sellShares: number, sellPrice: number): void {
    const state = this.getState(tokenId);
    state.pendingBuyShares = buyShares;
    state.pendingBuyPrice = buyPrice;
    state.pendingSellShares = sellShares;
    state.pendingSellPrice = sellPrice;
  }

  printSummary(tokenId: string): void {
    const s = this.getState(tokenId);
    console.log(`\n╔${'═'.repeat(50)}╗`);
    console.log(`║ 📊 Dual Track State`);
    console.log(`╠${'═'.repeat(50)}╣`);
    console.log(`║ Track A: Buy ${s.pendingBuyShares} @ $${s.pendingBuyPrice.toFixed(4)}`);
    console.log(`║ Track B: Sell ${s.pendingSellShares} @ $${s.pendingSellPrice.toFixed(4)}`);
    console.log(`║ Hedged: ${s.hedgedShares} pairs`);
    console.log(`║ Points: Buy=${s.buyPointsEarned} Sell=${s.sellPointsEarned}`);
    console.log(`╚${'═'.repeat(50)}╝`);
  }
}

export const unifiedStrategy = new UnifiedStrategy();
