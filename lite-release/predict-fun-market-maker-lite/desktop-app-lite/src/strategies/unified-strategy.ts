/* eslint-disable */
/**
 * Unified Strategy - 二档追踪 + 异步对冲 + 双轨并行
 *
 * 核心功能:
 * 1. 二档追踪 (Second Tier Tracking): 实时监控订单簿，保持挂单在第二档
 *    - 监控第一档价格变化
 *    - 自动计算第二档价格
 *    - 判断是否需要重新挂单
 *    - 减少被吃单的情况
 *
 * 2. 异步对冲 (Async Hedging): 二档买单成交后立即市价对冲
 *    - 不取消剩余订单
 *    - 立即市价对冲
 *
 * 3. 双轨并行 (Dual Track Mode): 同时在买卖两侧赚取积分
 */
import type { Market, Position, Orderbook, OrderbookEntry } from '../types.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface UnifiedStrategyConfig {
  enabled: boolean;

  // 仓位平衡
  tolerance: number;           // 仓位平衡容忍度 (0.05 = 5%)

  // 订单大小
  minSize: number;             // 最小订单大小
  maxSize: number;             // 最大订单大小

  // 二档追踪
  tickSize: number;            // 最小价格变动 (default: 0.01 = 1 cent)
  minSpreadCents: number;      // 最小价差 (cents) - 与第一档的最小距离
  maxSpreadCents: number;      // 最大价差 (cents) - 与第一档的最大距离
  repriceThresholdCents: number; // 重新挂单阈值 (cents) - 价格偏移超过此值需要重新挂单

  // 价格偏移 (基点, 100bps = 1%) - 仅用于动态偏移模式
  buyOffsetBps: number;
  sellOffsetBps: number;

  // 对冲设置
  hedgeSlippageBps: number;
  maxUnhedgedShares: number;

  // 模式开关
  asyncHedging: boolean;
  dualTrackMode: boolean;
  dynamicOffsetMode: boolean;
}

export enum UnifiedState {
  EMPTY = 'EMPTY',
  ACCUMULATING = 'ACCUMULATING',
  HEDGED = 'HEDGED',
  DUAL_TRACK = 'DUAL_TRACK',
}

export interface DualTrackState {
  // 挂单状态
  pendingBuyShares: number;
  pendingBuyPrice: number;
  pendingSellShares: number;
  pendingSellPrice: number;

  // 追踪的第一档价格
  trackedBidPrice: number;     // 追踪的买一价
  trackedAskPrice: number;     // 追踪的卖一价
  trackedAt: number;           // 追踪时间

  // 对冲状态
  hedgedShares: number;
  unhedgedShares: number;

  // 成交统计
  totalBuyFilled: number;
  totalHedgeFilled: number;
  totalSellFilled: number;
  totalReprices: number;       // 重新挂单次数

  // 积分统计
  buyPointsEarned: number;
  sellPointsEarned: number;

  // 时间戳
  lastBuyFillAt: number;
  lastSellFillAt: number;
  lastHedgeAt: number;
  lastRepriceAt: number;

  // 价格追踪
  avgBuyPrice: number;
  avgHedgePrice: number;
}

export interface HedgeInstruction {
  shouldHedge: boolean;
  shares: number;
  side: 'YES' | 'NO';
  price: number;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DualTrackOrders {
  buyOrder: {
    shares: number;
    price: number;
    side: 'YES' | 'NO';
  } | null;
  sellOrder: {
    shares: number;
    price: number;
    side: 'YES' | 'NO';
  } | null;
}

export interface RepriceDecision {
  needsReprice: boolean;
  reason: string;
  newBuyPrice?: number;
  newSellPrice?: number;
  currentBuyPrice: number;
  currentSellPrice: number;
  targetBuyPrice: number;
  targetSellPrice: number;
  priceDelta: number;          // 价格偏移量 (cents)
}

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_CONFIG: UnifiedStrategyConfig = {
  enabled: false,
  tolerance: 0.05,
  minSize: 10,
  maxSize: 500,

  // 二档追踪配置
  tickSize: 0.01,              // 1 cent
  minSpreadCents: 1,           // 最小距离 1 cent
  maxSpreadCents: 6,           // 最大距离 6 cents (Predict.fun 积分要求)
  repriceThresholdCents: 1,    // 偏移超过 1 cent 需要重新挂单

  // 价格偏移
  buyOffsetBps: 100,
  sellOffsetBps: 100,

  // 对冲设置
  hedgeSlippageBps: 250,
  maxUnhedgedShares: 100,

  // 模式开关
  asyncHedging: true,
  dualTrackMode: true,
  dynamicOffsetMode: false,    // 默认使用固定二档追踪
};

// ============================================================================
// 策略类
// ============================================================================

export class UnifiedStrategy {
  private config: UnifiedStrategyConfig;
  private states: Map<string, DualTrackState> = new Map();

  constructor(config: Partial<UnifiedStrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // 配置方法
  // --------------------------------------------------------------------------

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): UnifiedStrategyConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<UnifiedStrategyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // --------------------------------------------------------------------------
  // 状态管理
  // --------------------------------------------------------------------------

  getState(tokenId: string): DualTrackState {
    if (!this.states.has(tokenId)) {
      this.states.set(tokenId, this.createInitialState());
    }
    return this.states.get(tokenId)!;
  }

  private createInitialState(): DualTrackState {
    return {
      pendingBuyShares: 0,
      pendingBuyPrice: 0,
      pendingSellShares: 0,
      pendingSellPrice: 0,
      trackedBidPrice: 0,
      trackedAskPrice: 0,
      trackedAt: 0,
      hedgedShares: 0,
      unhedgedShares: 0,
      totalBuyFilled: 0,
      totalHedgeFilled: 0,
      totalSellFilled: 0,
      totalReprices: 0,
      buyPointsEarned: 0,
      sellPointsEarned: 0,
      lastBuyFillAt: 0,
      lastSellFillAt: 0,
      lastHedgeAt: 0,
      lastRepriceAt: 0,
      avgBuyPrice: 0,
      avgHedgePrice: 0,
    };
  }

  resetState(tokenId: string): void {
    this.states.delete(tokenId);
  }

  resetAll(): void {
    this.states.clear();
  }

  // --------------------------------------------------------------------------
  // 核心: 二档追踪
  // --------------------------------------------------------------------------

  /**
   * 计算第二档价格
   *
   * 逻辑:
   * - 买二价 = 买一价 - spread
   * - 卖二价 = 卖一价 + spread
   *
   * spread 在 [minSpreadCents, maxSpreadCents] 范围内
   */
  calculateSecondTierPrices(
    bestBid: number,
    bestAsk: number
  ): { secondBid: number; secondAsk: number } {
    const tickSize = this.config.tickSize;
    const minSpread = this.config.minSpreadCents * tickSize;
    const maxSpread = this.config.maxSpreadCents * tickSize;

    // 计算第二档价格
    // 买二价 = 买一价 - minSpread (尽量靠近第一档，但不在第一档)
    // 卖二价 = 卖一价 + minSpread
    const secondBid = Math.max(0.01, bestBid - minSpread);
    const secondAsk = Math.min(0.99, bestAsk + minSpread);

    return { secondBid, secondAsk };
  }

  /**
   * 检查是否需要重新挂单
   *
   * 触发重新挂单的条件:
   * 1. 当前挂单价格与目标价格偏移超过阈值
   * 2. 当前挂单变成了第一档 (被吃单风险)
   * 3. 当前挂单距离第一档太远 (超过 maxSpreadCents)
   */
  checkRepriceNeeded(
    tokenId: string,
    orderbook: Orderbook,
    currentBuyOrderPrice?: number,
    currentSellOrderPrice?: number
  ): RepriceDecision {
    const state = this.getState(tokenId);
    const tickSize = this.config.tickSize;
    const threshold = this.config.repriceThresholdCents * tickSize;
    const maxSpread = this.config.maxSpreadCents * tickSize;

    // 获取订单簿第一档
    const bestBid = orderbook.best_bid ?? (orderbook.bids[0] ? parseFloat(orderbook.bids[0].price) : 0);
    const bestAsk = orderbook.best_ask ?? (orderbook.asks[0] ? parseFloat(orderbook.asks[0].price) : 0);

    if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
      return {
        needsReprice: false,
        reason: 'Invalid orderbook',
        currentBuyPrice: currentBuyOrderPrice ?? 0,
        currentSellPrice: currentSellOrderPrice ?? 0,
        targetBuyPrice: 0,
        targetSellPrice: 0,
        priceDelta: 0,
      };
    }

    // 计算目标第二档价格
    const { secondBid, secondAsk } = this.calculateSecondTierPrices(bestBid, bestAsk);

    // 当前挂单价格
    const currentBuy = currentBuyOrderPrice ?? state.pendingBuyPrice;
    const currentSell = currentSellOrderPrice ?? state.pendingSellPrice;

    // 计算价格偏移
    const buyDelta = currentBuy > 0 ? Math.abs(currentBuy - secondBid) : 0;
    const sellDelta = currentSell > 0 ? Math.abs(currentSell - secondAsk) : 0;
    const maxDelta = Math.max(buyDelta, sellDelta);

    // 检查是否需要重新挂单
    let needsReprice = false;
    let reason = '';

    // 1. 价格偏移超过阈值
    if (buyDelta > threshold || sellDelta > threshold) {
      needsReprice = true;
      reason = `Price drift: buyΔ=${(buyDelta * 100).toFixed(2)}c sellΔ=${(sellDelta * 100).toFixed(2)}c`;
    }

    // 2. 检查是否变成了第一档
    if (currentBuy > 0 && currentBuy >= bestBid - tickSize / 2) {
      needsReprice = true;
      reason = `Buy order at best bid! (${currentBuy} >= ${bestBid})`;
    }
    if (currentSell > 0 && currentSell <= bestAsk + tickSize / 2) {
      needsReprice = true;
      reason = `Sell order at best ask! (${currentSell} <= ${bestAsk})`;
    }

    // 3. 检查距离第一档是否太远
    if (currentBuy > 0 && bestBid - currentBuy > maxSpread) {
      needsReprice = true;
      reason = `Buy order too far from best bid (${((bestBid - currentBuy) * 100).toFixed(2)}c > ${this.config.maxSpreadCents}c)`;
    }
    if (currentSell > 0 && currentSell - bestAsk > maxSpread) {
      needsReprice = true;
      reason = `Sell order too far from best ask (${((currentSell - bestAsk) * 100).toFixed(2)}c > ${this.config.maxSpreadCents}c)`;
    }

    // 更新追踪的第一档价格
    state.trackedBidPrice = bestBid;
    state.trackedAskPrice = bestAsk;
    state.trackedAt = Date.now();

    return {
      needsReprice,
      reason,
      newBuyPrice: needsReprice ? secondBid : undefined,
      newSellPrice: needsReprice ? secondAsk : undefined,
      currentBuyPrice: currentBuy,
      currentSellPrice: currentSell,
      targetBuyPrice: secondBid,
      targetSellPrice: secondAsk,
      priceDelta: maxDelta * 100, // 转换为 cents
    };
  }

  /**
   * 记录重新挂单
   */
  recordReprice(tokenId: string): void {
    const state = this.getState(tokenId);
    state.totalReprices++;
    state.lastRepriceAt = Date.now();
  }

  // --------------------------------------------------------------------------
  // 核心分析
  // --------------------------------------------------------------------------

  analyze(
    market: Market,
    position: Position,
    yesPrice: number,
    orderbook?: Orderbook
  ): {
    state: UnifiedState;
    shouldBuy: boolean;
    shouldSell: boolean;
    buySize: number;
    sellSize: number;
    hedgeInstruction: HedgeInstruction;
    repriceDecision?: RepriceDecision;
  } {
    const state = this.getState(market.token_id);
    const yes = position.yes_amount || 0;
    const no = position.no_amount || 0;
    const total = yes + no;

    const avg = total / 2;
    const deviation = avg > 0 ? Math.abs(yes - no) / avg : 0;
    const balanced = deviation <= this.config.tolerance;

    const unhedgedRisk = state.unhedgedShares;

    let currentState: UnifiedState;
    let shouldBuy = false;
    let shouldSell = false;

    if (total === 0) {
      currentState = UnifiedState.EMPTY;
      shouldBuy = true;
    } else if (unhedgedRisk > 0) {
      currentState = UnifiedState.HEDGED;
      shouldBuy = false;
      shouldSell = state.hedgedShares > 0;
    } else if (balanced && state.hedgedShares >= this.config.minSize) {
      currentState = UnifiedState.DUAL_TRACK;
      shouldBuy = true;
      shouldSell = true;
    } else {
      currentState = UnifiedState.ACCUMULATING;
      shouldBuy = true;
      shouldSell = state.hedgedShares > 0;
    }

    const baseSize = Math.max(this.config.minSize, 10);
    const buySize = shouldBuy ? Math.min(baseSize, this.config.maxSize) : 0;
    const sellSize = shouldSell
      ? Math.min(state.hedgedShares, baseSize, this.config.maxSize)
      : 0;

    const hedgeInstruction = this.generateHedgeInstruction(state, yesPrice, orderbook);

    // 检查是否需要重新挂单
    let repriceDecision: RepriceDecision | undefined;
    if (orderbook && (state.pendingBuyShares > 0 || state.pendingSellShares > 0)) {
      repriceDecision = this.checkRepriceNeeded(
        market.token_id,
        orderbook,
        state.pendingBuyPrice,
        state.pendingSellPrice
      );
    }

    return {
      state: currentState,
      shouldBuy,
      shouldSell,
      buySize,
      sellSize,
      hedgeInstruction,
      repriceDecision,
    };
  }

  private generateHedgeInstruction(
    state: DualTrackState,
    yesPrice: number,
    orderbook?: Orderbook
  ): HedgeInstruction {
    if (!this.config.asyncHedging || state.unhedgedShares <= 0) {
      return {
        shouldHedge: false,
        shares: 0,
        side: 'YES',
        price: 0,
        urgency: 'LOW',
      };
    }

    const shares = state.unhedgedShares;

    const noAsk = orderbook?.best_ask
      ? 1 - orderbook.best_ask + 0.01
      : (1 - yesPrice) * 1.01;

    const slippage = this.config.hedgeSlippageBps / 10000;
    const hedgePrice = Math.min(0.99, noAsk * (1 + slippage));

    let urgency: 'LOW' | 'MEDIUM' | 'HIGH';
    if (shares >= this.config.maxUnhedgedShares) {
      urgency = 'HIGH';
    } else if (shares >= this.config.maxUnhedgedShares / 2) {
      urgency = 'MEDIUM';
    } else {
      urgency = 'LOW';
    }

    return {
      shouldHedge: true,
      shares,
      side: 'NO',
      price: hedgePrice,
      urgency,
    };
  }

  // --------------------------------------------------------------------------
  // 订单建议
  // --------------------------------------------------------------------------

  /**
   * 获取双轨订单建议 (使用二档追踪)
   */
  getDualTrackOrders(
    tokenId: string,
    orderbook: Orderbook,
    position: Position
  ): DualTrackOrders & { repriceDecision?: RepriceDecision } {
    if (!this.config.dualTrackMode) {
      return { buyOrder: null, sellOrder: null };
    }

    const state = this.getState(tokenId);
    const bestBid = orderbook.best_bid ?? (orderbook.bids[0] ? parseFloat(orderbook.bids[0].price) : 0);
    const bestAsk = orderbook.best_ask ?? (orderbook.asks[0] ? parseFloat(orderbook.asks[0].price) : 0);

    if (bestBid <= 0 || bestAsk <= 0) {
      return { buyOrder: null, sellOrder: null };
    }

    // 计算第二档价格
    const { secondBid, secondAsk } = this.calculateSecondTierPrices(bestBid, bestAsk);

    const analysis = this.analyze(
      { token_id: tokenId } as Market,
      position,
      (bestBid + bestAsk) / 2,
      orderbook
    );

    let buyOrder: DualTrackOrders['buyOrder'] = null;
    let sellOrder: DualTrackOrders['sellOrder'] = null;

    // Track A: 买单（二档买入 YES）
    if (analysis.shouldBuy && analysis.buySize > 0) {
      buyOrder = {
        shares: analysis.buySize,
        price: secondBid,
        side: 'YES',
      };
    }

    // Track B: 卖单（二档卖出 YES）
    if (analysis.shouldSell && state.hedgedShares > 0 && analysis.sellSize > 0) {
      sellOrder = {
        shares: Math.min(state.hedgedShares, analysis.sellSize),
        price: secondAsk,
        side: 'YES',
      };
    }

    return {
      buyOrder,
      sellOrder,
      repriceDecision: analysis.repriceDecision,
    };
  }

  // --------------------------------------------------------------------------
  // 挂单管理
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // 成交处理
  // --------------------------------------------------------------------------

  onBuyFill(
    tokenId: string,
    filledShares: number,
    fillPrice: number,
    side: 'YES' | 'NO' = 'YES'
  ): HedgeInstruction {
    const state = this.getState(tokenId);
    const now = Date.now();

    state.totalBuyFilled += filledShares;
    state.lastBuyFillAt = now;
    state.pendingBuyShares = Math.max(0, state.pendingBuyShares - filledShares);

    if (state.totalBuyFilled > 0) {
      const totalCost = state.avgBuyPrice * (state.totalBuyFilled - filledShares);
      state.avgBuyPrice = (totalCost + filledShares * fillPrice) / state.totalBuyFilled;
    }

    state.unhedgedShares += filledShares;

    const points = this.calculatePoints(filledShares, fillPrice, 'BUY');
    state.buyPointsEarned += points;

    // 🔥 核心逻辑：被吃单后立即对冲，不等待累积！
    // 无论数量多少，都立即以 HIGH urgency 对冲
    if (this.config.asyncHedging && state.unhedgedShares > 0) {
      // 计算对冲价格：使用滑点补偿
      const slippage = this.config.hedgeSlippageBps / 10000;
      // 如果买的是 YES，对冲买 NO，需要用 NO 的卖价
      const hedgeSide = side === 'YES' ? 'NO' : 'YES';
      // 对冲价格：1 - 成交价 + 滑点 (确保能成交)
      const hedgePrice = hedgeSide === 'NO'
        ? Math.min(0.99, (1 - fillPrice) * (1 + slippage))
        : Math.min(0.99, fillPrice * (1 + slippage));

      console.log(`⚡ [AsyncHedge] 买 ${side} 成交 ${filledShares} 股 @ $${fillPrice.toFixed(4)}，立即对冲买 ${hedgeSide} ${state.unhedgedShares} 股`);

      return {
        shouldHedge: true,
        shares: state.unhedgedShares,  // 对冲所有未对冲的
        side: hedgeSide,
        price: hedgePrice,
        urgency: 'HIGH',  // 🔥 始终 HIGH，立即执行！
      };
    }

    return {
      shouldHedge: false,
      shares: 0,
      side: 'YES',
      price: 0,
      urgency: 'LOW',
    };
  }

  onSellFill(
    tokenId: string,
    filledShares: number,
    fillPrice: number
  ): void {
    const state = this.getState(tokenId);
    const now = Date.now();

    state.totalSellFilled += filledShares;
    state.lastSellFillAt = now;
    state.pendingSellShares = Math.max(0, state.pendingSellShares - filledShares);
    state.hedgedShares = Math.max(0, state.hedgedShares - filledShares);

    const points = this.calculatePoints(filledShares, fillPrice, 'SELL');
    state.sellPointsEarned += points;
  }

  onHedgeFill(
    tokenId: string,
    hedgedShares: number,
    hedgePrice: number
  ): void {
    const state = this.getState(tokenId);
    const now = Date.now();

    state.totalHedgeFilled += hedgedShares;
    state.hedgedShares += hedgedShares;
    state.lastHedgeAt = now;
    state.unhedgedShares = Math.max(0, state.unhedgedShares - hedgedShares);

    if (state.totalHedgeFilled > 0) {
      const totalCost = state.avgHedgePrice * (state.totalHedgeFilled - hedgedShares);
      state.avgHedgePrice = (totalCost + hedgedShares * hedgePrice) / state.totalHedgeFilled;
    }
  }

  // --------------------------------------------------------------------------
  // 积分计算
  // --------------------------------------------------------------------------

  calculatePoints(
    shares: number,
    price: number,
    side: 'BUY' | 'SELL'
  ): number {
    const value = shares * price;
    return value;
  }

  // --------------------------------------------------------------------------
  // 统计与报告
  // --------------------------------------------------------------------------

  getSummary(tokenId: string): {
    totalBuyFilled: number;
    totalSellFilled: number;
    totalHedgeFilled: number;
    totalReprices: number;
    totalPoints: number;
    hedgedShares: number;
    unhedgedShares: number;
    avgBuyPrice: number;
    avgHedgePrice: number;
    pnl: number;
    currentSpread: { buy: number; sell: number };
  } {
    const state = this.getState(tokenId);

    const buyCost = state.totalBuyFilled * state.avgBuyPrice;
    const hedgeCost = state.totalHedgeFilled * state.avgHedgePrice;
    const sellRevenue = state.totalSellFilled * state.avgBuyPrice;
    const pnl = sellRevenue - buyCost - hedgeCost;

    // 计算当前挂单与第一档的距离
    const buySpread = state.trackedBidPrice > 0 && state.pendingBuyPrice > 0
      ? (state.trackedBidPrice - state.pendingBuyPrice) * 100
      : 0;
    const sellSpread = state.trackedAskPrice > 0 && state.pendingSellPrice > 0
      ? (state.pendingSellPrice - state.trackedAskPrice) * 100
      : 0;

    return {
      totalBuyFilled: state.totalBuyFilled,
      totalSellFilled: state.totalSellFilled,
      totalHedgeFilled: state.totalHedgeFilled,
      totalReprices: state.totalReprices,
      totalPoints: state.buyPointsEarned + state.sellPointsEarned,
      hedgedShares: state.hedgedShares,
      unhedgedShares: state.unhedgedShares,
      avgBuyPrice: state.avgBuyPrice,
      avgHedgePrice: state.avgHedgePrice,
      pnl,
      currentSpread: { buy: buySpread, sell: sellSpread },
    };
  }

  printSummary(tokenId: string): void {
    const s = this.getState(tokenId);
    const summary = this.getSummary(tokenId);

    console.log(`\n╔${'═'.repeat(70)}╗`);
    console.log(`║ 📊 Unified Strategy - 二档追踪 + 双轨并行`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 订单簿追踪:`);
    console.log(`║    买一: $${s.trackedBidPrice.toFixed(4)} | 卖一: $${s.trackedAskPrice.toFixed(4)}`);
    console.log(`║    买二: $${s.pendingBuyPrice.toFixed(4)} (${summary.currentSpread.buy.toFixed(1)}c)`);
    console.log(`║    卖二: $${s.pendingSellPrice.toFixed(4)} (${summary.currentSpread.sell.toFixed(1)}c)`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 挂单状态:`);
    console.log(`║    Track A (买): ${s.pendingBuyShares} 股`);
    console.log(`║    Track B (卖): ${s.pendingSellShares} 股`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 成交统计:`);
    console.log(`║    买=${s.totalBuyFilled} | 对冲=${s.totalHedgeFilled} | 卖=${s.totalSellFilled}`);
    console.log(`║    重新挂单次数: ${s.totalReprices}`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 积分: ${summary.totalPoints.toFixed(2)} | PnL: $${summary.pnl.toFixed(2)}`);
    console.log(`╚${'═'.repeat(70)}╝`);
  }
}

export const unifiedStrategy = new UnifiedStrategy();
