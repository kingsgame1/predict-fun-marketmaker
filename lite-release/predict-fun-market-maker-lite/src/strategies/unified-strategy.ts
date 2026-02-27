/* eslint-disable */
/**
 * Unified Strategy - Async Hedging + Dual Track Mode
 *
 * 核心功能:
 * 1. 异步对冲 (Async Hedging): 二档买单成交后立即市价对冲
 * 2. 双轨并行 (Dual Track Mode): 同时在买卖两侧赚取积分
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
  EMPTY = 'EMPTY',           // 空仓状态
  HEDGED = 'HEDGED',         // 已对冲状态
  DUAL_TRACK = 'DUAL_TRACK', // 双轨并行状态
}

export interface DualTrackState {
  // 挂单状态
  pendingBuyShares: number;   // 挂单中的买单数量
  pendingBuyPrice: number;    // 买单价格
  pendingSellShares: number;  // 挂单中的卖单数量
  pendingSellPrice: number;   // 卖单价格

  // 对冲状态
  hedgedShares: number;       // 已对冲的股数

  // 成交统计
  totalBuyFilled: number;     // 累计买单成交
  totalHedgeFilled: number;   // 累计对冲成交
  totalSellFilled: number;    // 累计卖单成交

  // 积分统计
  buyPointsEarned: number;    // 买入侧积分
  sellPointsEarned: number;   // 卖出侧积分

  // 时间戳
  lastFillAt: number;         // 最后成交时间
  lastHedgeAt: number;        // 最后对冲时间
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
        lastFillAt: 0, lastHedgeAt: 0,
      });
    }
    return this.states.get(tokenId)!;
  }

  /**
   * 重置指定 token 的状态
   */
  resetState(tokenId: string): void {
    this.states.delete(tokenId);
  }

  /**
   * 重置所有状态
   */
  resetAll(): void {
    this.states.clear();
  }

  /**
   * 分析当前仓位状态，决定买卖行为
   */
  analyze(market: Market, position: Position, yesPrice: number): {
    state: UnifiedState;
    shouldBuy: boolean;
    shouldSell: boolean;
    buySize: number;
    sellSize: number;
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
      // 空仓：只买入
      state = UnifiedState.EMPTY;
      shouldBuy = true;
    } else if (balanced && total >= this.config.minSize) {
      // 仓位平衡且足够大：双轨并行
      state = UnifiedState.DUAL_TRACK;
      shouldBuy = true;
      shouldSell = true;
    } else {
      // 仓位不平衡：需要对冲
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

  /**
   * 计算买卖价格（二档价格）
   */
  suggestPrices(yesPrice: number, bestBid?: number, bestAsk?: number): {
    bid: number;
    ask: number;
  } {
    let buyOffset = this.config.buyOffsetBps / 10000;
    let sellOffset = this.config.sellOffsetBps / 10000;

    // 动态偏移模式：根据波动性调整偏移
    // TODO: 可以根据市场波动性动态调整

    const bid = Math.max(0.01, (bestBid ?? yesPrice) * (1 - buyOffset));
    const ask = Math.min(0.99, (bestAsk ?? yesPrice * 1.01) * (1 + sellOffset));

    return { bid, ask };
  }

  /**
   * 更新挂单状态
   */
  updatePendingOrders(
    tokenId: string,
    buyShares: number,
    buyPrice: number,
    sellShares: number,
    sellPrice: number
  ): void {
    const state = this.getState(tokenId);
    state.pendingBuyShares = buyShares;
    state.pendingBuyPrice = buyPrice;
    state.pendingSellShares = sellShares;
    state.pendingSellPrice = sellPrice;
  }

  /**
   * 处理买单成交事件
   * @returns 需要对冲的股数
   */
  onBuyFill(
    tokenId: string,
    filledShares: number,
    fillPrice: number
  ): { hedgeShares: number; hedgeSide: 'YES' | 'NO' } {
    const state = this.getState(tokenId);
    const now = Date.now();

    // 更新成交统计
    state.totalBuyFilled += filledShares;
    state.lastFillAt = now;

    // 更新挂单中的买单数量
    state.pendingBuyShares = Math.max(0, state.pendingBuyShares - filledShares);

    // 计算积分（假设每秒每单赚取一定积分）
    const points = this.calculatePoints(filledShares, fillPrice, 'BUY');
    state.buyPointsEarned += points;

    // 异步对冲：返回需要对冲的数量
    if (this.config.asyncHedging && filledShares > 0) {
      return {
        hedgeShares: filledShares,
        hedgeSide: 'NO', // 买入 YES 成交，对冲 NO
      };
    }

    return { hedgeShares: 0, hedgeSide: 'YES' };
  }

  /**
   * 处理卖单成交事件
   */
  onSellFill(
    tokenId: string,
    filledShares: number,
    fillPrice: number
  ): void {
    const state = this.getState(tokenId);
    const now = Date.now();

    // 更新成交统计
    state.totalSellFilled += filledShares;
    state.lastFillAt = now;

    // 更新挂单中的卖单数量
    state.pendingSellShares = Math.max(0, state.pendingSellShares - filledShares);

    // 更新对冲库存
    state.hedgedShares = Math.max(0, state.hedgedShares - filledShares);

    // 计算积分
    const points = this.calculatePoints(filledShares, fillPrice, 'SELL');
    state.sellPointsEarned += points;
  }

  /**
   * 记录对冲成交
   */
  onHedgeFill(tokenId: string, hedgedShares: number): void {
    const state = this.getState(tokenId);
    const now = Date.now();

    state.totalHedgeFilled += hedgedShares;
    state.hedgedShares += hedgedShares;
    state.lastHedgeAt = now;
  }

  /**
   * 计算对冲价格（市价 + 滑点）
   */
  calculateHedgePrice(
    bestAsk: number,
    side: 'BUY' | 'SELL'
  ): number {
    const slippage = this.config.hedgeSlippageBps / 10000;

    if (side === 'BUY') {
      // 买入时使用 ask 价 + 滑点
      return Math.min(0.99, bestAsk * (1 + slippage));
    } else {
      // 卖出时使用 bid 价 - 滑点
      return Math.max(0.01, bestAsk * (1 - slippage));
    }
  }

  /**
   * 计算赚取的积分
   * 简化计算：基于成交金额和持仓时间
   */
  calculatePoints(
    shares: number,
    price: number,
    side: 'BUY' | 'SELL'
  ): number {
    // 简化：每 $1 成交额 = 1 积分
    const value = shares * price;
    return value;
  }

  /**
   * 获取双轨订单建议
   */
  getDualTrackOrders(
    tokenId: string,
    yesPrice: number,
    bestBid: number,
    bestAsk: number,
    position: Position
  ): {
    buyOrder: { shares: number; price: number } | null;
    sellOrder: { shares: number; price: number } | null;
  } {
    const state = this.getState(tokenId);
    const prices = this.suggestPrices(yesPrice, bestBid, bestAsk);
    const analysis = this.analyze({} as Market, position, yesPrice);

    let buyOrder: { shares: number; price: number } | null = null;
    let sellOrder: { shares: number; price: number } | null = null;

    // Track A: 买单（二档买入）
    if (analysis.shouldBuy && this.config.dualTrackMode) {
      buyOrder = {
        shares: Math.min(analysis.buySize, this.config.maxSize),
        price: prices.bid,
      };
    }

    // Track B: 卖单（二档卖出）- 使用对冲库存
    if (analysis.shouldSell && state.hedgedShares > 0 && this.config.dualTrackMode) {
      sellOrder = {
        shares: Math.min(state.hedgedShares, analysis.sellSize, this.config.maxSize),
        price: prices.ask,
      };
    }

    return { buyOrder, sellOrder };
  }

  /**
   * 获取统计摘要
   */
  getSummary(tokenId: string): {
    totalBuyFilled: number;
    totalSellFilled: number;
    totalHedgeFilled: number;
    totalPoints: number;
    hedgedShares: number;
  } {
    const state = this.getState(tokenId);
    return {
      totalBuyFilled: state.totalBuyFilled,
      totalSellFilled: state.totalSellFilled,
      totalHedgeFilled: state.totalHedgeFilled,
      totalPoints: state.buyPointsEarned + state.sellPointsEarned,
      hedgedShares: state.hedgedShares,
    };
  }

  /**
   * 打印状态摘要
   */
  printSummary(tokenId: string): void {
    const s = this.getState(tokenId);
    console.log(`\n╔${'═'.repeat(60)}╗`);
    console.log(`║ 📊 Unified Strategy - Dual Track State`);
    console.log(`╠${'═'.repeat(60)}╣`);
    console.log(`║ Track A (Buy):  ${s.pendingBuyShares} shares @ $${s.pendingBuyPrice.toFixed(4)}`);
    console.log(`║ Track B (Sell): ${s.pendingSellShares} shares @ $${s.pendingSellPrice.toFixed(4)}`);
    console.log(`║ Hedged: ${s.hedgedShares} pairs`);
    console.log(`╠${'═'.repeat(60)}╣`);
    console.log(`║ Total Filled: Buy=${s.totalBuyFilled} Hedge=${s.totalHedgeFilled} Sell=${s.totalSellFilled}`);
    console.log(`║ Points Earned: Buy=${s.buyPointsEarned.toFixed(2)} Sell=${s.sellPointsEarned.toFixed(2)}`);
    console.log(`║ Total Points: ${(s.buyPointsEarned + s.sellPointsEarned).toFixed(2)}`);
    console.log(`╚${'═'.repeat(60)}╝`);
  }
}

export const unifiedStrategy = new UnifiedStrategy();
