/* eslint-disable */
/**
 * Unified Strategy - Async Hedging + Dual Track Mode
 *
 * 核心功能:
 * 1. 异步对冲 (Async Hedging): 二档买单成交后立即市价对冲
 *    - 当二档买单部分成交 q 股时：
 *    - 不取消：剩余 Q-q 订单继续排队赚取积分
 *    - 立即对冲：市价买入反向 q 股
 *    - 状态更新：现在有 q 对 1:1 对冲库存
 *
 * 2. 双轨并行 (Dual Track Mode): 同时在买卖两侧赚取积分
 *    - Track A (买入侧): 挂买单在二档 → 赚买入积分
 *    - Track B (卖出侧): 对冲库存挂卖单在二档 → 赚卖出积分
 *    - 最大化积分收益
 */
import type { Market, Position, Orderbook } from '../types.js';

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

  // 价格偏移 (基点, 100bps = 1%)
  buyOffsetBps: number;        // 买单价格偏移 (从最佳买价向下)
  sellOffsetBps: number;       // 卖单价格偏移 (从最佳卖价向上)

  // 对冲设置
  hedgeSlippageBps: number;    // 对冲滑点 (基点)
  maxUnhedgedShares: number;   // 最大未对冲股数 (风险控制)

  // 模式开关
  asyncHedging: boolean;       // 异步对冲模式
  dualTrackMode: boolean;      // 双轨并行模式
  dynamicOffsetMode: boolean;  // 动态偏移模式
}

export enum UnifiedState {
  EMPTY = 'EMPTY',             // 空仓状态 - 只买入
  ACCUMULATING = 'ACCUMULATING', // 累积状态 - 积累对冲库存
  HEDGED = 'HEDGED',           // 已对冲状态 - 等待对冲完成
  DUAL_TRACK = 'DUAL_TRACK',   // 双轨并行状态 - 同时买卖
}

export interface DualTrackState {
  // 挂单状态
  pendingBuyShares: number;    // 挂单中的买单数量
  pendingBuyPrice: number;     // 买单价格
  pendingSellShares: number;   // 挂单中的卖单数量
  pendingSellPrice: number;    // 卖单价格

  // 对冲状态
  hedgedShares: number;        // 已对冲的股数 (可卖出的库存)
  unhedgedShares: number;      // 未对冲的股数 (风险敞口)

  // 成交统计
  totalBuyFilled: number;      // 累计买单成交
  totalHedgeFilled: number;    // 累计对冲成交
  totalSellFilled: number;     // 累计卖单成交

  // 积分统计
  buyPointsEarned: number;     // 买入侧积分
  sellPointsEarned: number;    // 卖出侧积分

  // 时间戳
  lastBuyFillAt: number;       // 最后买单成交时间
  lastSellFillAt: number;      // 最后卖单成交时间
  lastHedgeAt: number;         // 最后对冲时间

  // 价格追踪
  avgBuyPrice: number;         // 平均买入价格
  avgHedgePrice: number;       // 平均对冲价格
}

export interface HedgeInstruction {
  shouldHedge: boolean;
  shares: number;
  side: 'YES' | 'NO';          // 对冲方向 (买入哪一边)
  price: number;               // 建议对冲价格
  urgency: 'LOW' | 'MEDIUM' | 'HIGH'; // 对冲紧急程度
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

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_CONFIG: UnifiedStrategyConfig = {
  enabled: false,
  tolerance: 0.05,
  minSize: 10,
  maxSize: 500,
  buyOffsetBps: 100,           // 1% 偏移
  sellOffsetBps: 100,          // 1% 偏移
  hedgeSlippageBps: 250,       // 2.5% 滑点
  maxUnhedgedShares: 100,      // 最多 100 股未对冲
  asyncHedging: true,
  dualTrackMode: true,
  dynamicOffsetMode: true,
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
      hedgedShares: 0,
      unhedgedShares: 0,
      totalBuyFilled: 0,
      totalHedgeFilled: 0,
      totalSellFilled: 0,
      buyPointsEarned: 0,
      sellPointsEarned: 0,
      lastBuyFillAt: 0,
      lastSellFillAt: 0,
      lastHedgeAt: 0,
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
  // 核心分析
  // --------------------------------------------------------------------------

  /**
   * 分析当前市场状态，返回状态和建议
   */
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
  } {
    const state = this.getState(market.token_id);
    const yes = position.yes_amount || 0;
    const no = position.no_amount || 0;
    const total = yes + no;

    // 计算仓位平衡度
    const avg = total / 2;
    const deviation = avg > 0 ? Math.abs(yes - no) / avg : 0;
    const balanced = deviation <= this.config.tolerance;

    // 计算未对冲风险
    const unhedgedRisk = state.unhedgedShares;

    // 确定当前状态
    let currentState: UnifiedState;
    let shouldBuy = false;
    let shouldSell = false;

    if (total === 0) {
      // 空仓：开始买入
      currentState = UnifiedState.EMPTY;
      shouldBuy = true;
    } else if (unhedgedRisk > 0) {
      // 有未对冲仓位：等待对冲
      currentState = UnifiedState.HEDGED;
      shouldBuy = false; // 对冲期间暂停新买入
      shouldSell = state.hedgedShares > 0; // 可以卖出已对冲的部分
    } else if (balanced && state.hedgedShares >= this.config.minSize) {
      // 仓位平衡且有足够对冲库存：双轨并行
      currentState = UnifiedState.DUAL_TRACK;
      shouldBuy = true;
      shouldSell = true;
    } else {
      // 累积阶段
      currentState = UnifiedState.ACCUMULATING;
      shouldBuy = true;
      shouldSell = state.hedgedShares > 0;
    }

    // 计算订单大小
    const baseSize = Math.max(this.config.minSize, 10);
    const buySize = shouldBuy ? Math.min(baseSize, this.config.maxSize) : 0;
    const sellSize = shouldSell
      ? Math.min(state.hedgedShares, baseSize, this.config.maxSize)
      : 0;

    // 生成对冲指令
    const hedgeInstruction = this.generateHedgeInstruction(
      state,
      yesPrice,
      orderbook
    );

    return {
      state: currentState,
      shouldBuy,
      shouldSell,
      buySize,
      sellSize,
      hedgeInstruction,
    };
  }

  /**
   * 生成对冲指令
   */
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

    // 计算对冲价格 (使用 NO 的 ask 价格)
    const noAsk = orderbook?.best_ask
      ? 1 - orderbook.best_ask + 0.01 // NO ask = 1 - YES bid + spread
      : (1 - yesPrice) * 1.01;

    const slippage = this.config.hedgeSlippageBps / 10000;
    const hedgePrice = Math.min(0.99, noAsk * (1 + slippage));

    // 确定紧急程度
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
      side: 'NO', // 买入 YES 后对冲 NO
      price: hedgePrice,
      urgency,
    };
  }

  // --------------------------------------------------------------------------
  // 价格计算
  // --------------------------------------------------------------------------

  /**
   * 计算买卖价格（二档价格）
   *
   * 关键逻辑：
   * - 买单价格 = 最佳买价 * (1 - buyOffset) → 比最佳买价更低
   * - 卖单价格 = 最佳卖价 * (1 - sellOffset) → 比最佳卖价更高
   */
  suggestPrices(
    yesPrice: number,
    bestBid?: number,
    bestAsk?: number
  ): {
    bid: number;   // 买入价格 (YES 侧)
    ask: number;   // 卖出价格 (YES 侧)
    noBid: number; // NO 侧买入价格
    noAsk: number; // NO 侧卖出价格
  } {
    // 基础偏移
    let buyOffset = this.config.buyOffsetBps / 10000;
    let sellOffset = this.config.sellOffsetBps / 10000;

    // 动态偏移模式：可以根据波动性调整
    // TODO: 实现 volatility-based 动态调整

    // 使用提供的最优价格，或基于 yesPrice 估算
    const bid = bestBid ?? yesPrice * 0.99;
    const ask = bestAsk ?? yesPrice * 1.01;

    // YES 侧价格
    const yesBid = Math.max(0.01, bid * (1 - buyOffset));  // 买得更便宜
    const yesAsk = Math.min(0.99, ask * (1 + sellOffset)); // 卖得更贵

    // NO 侧价格 (对称)
    const noBid = Math.max(0.01, (1 - ask) * (1 - buyOffset));
    const noAsk = Math.min(0.99, (1 - bid) * (1 + sellOffset));

    return {
      bid: yesBid,
      ask: yesAsk,
      noBid,
      noAsk,
    };
  }

  /**
   * 计算对冲价格
   */
  calculateHedgePrice(
    yesPrice: number,
    bestAsk: number,
    side: 'YES' | 'NO'
  ): number {
    const slippage = this.config.hedgeSlippageBps / 10000;

    if (side === 'NO') {
      // 对冲 NO：买入 NO
      // NO 的 ask ≈ 1 - YES 的 bid
      const noAsk = 1 - yesPrice + 0.01;
      return Math.min(0.99, noAsk * (1 + slippage));
    } else {
      // 对冲 YES：买入 YES
      return Math.min(0.99, bestAsk * (1 + slippage));
    }
  }

  // --------------------------------------------------------------------------
  // 挂单管理
  // --------------------------------------------------------------------------

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
   * 获取双轨订单建议
   */
  getDualTrackOrders(
    tokenId: string,
    yesPrice: number,
    bestBid: number,
    bestAsk: number,
    position: Position
  ): DualTrackOrders {
    if (!this.config.dualTrackMode) {
      return { buyOrder: null, sellOrder: null };
    }

    const state = this.getState(tokenId);
    const prices = this.suggestPrices(yesPrice, bestBid, bestAsk);
    const analysis = this.analyze(
      { token_id: tokenId } as Market,
      position,
      yesPrice
    );

    let buyOrder: DualTrackOrders['buyOrder'] = null;
    let sellOrder: DualTrackOrders['sellOrder'] = null;

    // Track A: 买单（二档买入 YES）
    if (analysis.shouldBuy && analysis.buySize > 0) {
      buyOrder = {
        shares: analysis.buySize,
        price: prices.bid,
        side: 'YES',
      };
    }

    // Track B: 卖单（二档卖出 YES）- 使用对冲库存
    if (analysis.shouldSell && state.hedgedShares > 0 && analysis.sellSize > 0) {
      sellOrder = {
        shares: Math.min(state.hedgedShares, analysis.sellSize),
        price: prices.ask,
        side: 'YES',
      };
    }

    return { buyOrder, sellOrder };
  }

  // --------------------------------------------------------------------------
  // 成交处理
  // --------------------------------------------------------------------------

  /**
   * 处理买单成交
   *
   * 核心逻辑：
   * 1. 更新成交统计
   * 2. 更新平均买入价格
   * 3. 增加未对冲股数
   * 4. 返回对冲指令
   */
  onBuyFill(
    tokenId: string,
    filledShares: number,
    fillPrice: number,
    side: 'YES' | 'NO' = 'YES'
  ): HedgeInstruction {
    const state = this.getState(tokenId);
    const now = Date.now();

    // 更新成交统计
    state.totalBuyFilled += filledShares;
    state.lastBuyFillAt = now;

    // 更新挂单中的买单数量
    state.pendingBuyShares = Math.max(0, state.pendingBuyShares - filledShares);

    // 更新平均买入价格
    const totalCost = state.avgBuyPrice * (state.totalBuyFilled - filledShares);
    state.avgBuyPrice = (totalCost + filledShares * fillPrice) / state.totalBuyFilled;

    // 增加未对冲股数
    state.unhedgedShares += filledShares;

    // 计算积分
    const points = this.calculatePoints(filledShares, fillPrice, 'BUY');
    state.buyPointsEarned += points;

    // 生成对冲指令
    if (this.config.asyncHedging && state.unhedgedShares > 0) {
      const urgency = state.unhedgedShares >= this.config.maxUnhedgedShares
        ? 'HIGH'
        : state.unhedgedShares >= this.config.maxUnhedgedShares / 2
          ? 'MEDIUM'
          : 'LOW';

      return {
        shouldHedge: true,
        shares: state.unhedgedShares,
        side: side === 'YES' ? 'NO' : 'YES', // 对冲反向
        price: fillPrice, // 实际对冲价格需要从 orderbook 计算
        urgency,
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

  /**
   * 处理卖单成交
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
    state.lastSellFillAt = now;

    // 更新挂单中的卖单数量
    state.pendingSellShares = Math.max(0, state.pendingSellShares - filledShares);

    // 减少对冲库存
    state.hedgedShares = Math.max(0, state.hedgedShares - filledShares);

    // 计算积分
    const points = this.calculatePoints(filledShares, fillPrice, 'SELL');
    state.sellPointsEarned += points;
  }

  /**
   * 记录对冲成交
   */
  onHedgeFill(
    tokenId: string,
    hedgedShares: number,
    hedgePrice: number
  ): void {
    const state = this.getState(tokenId);
    const now = Date.now();

    // 更新对冲统计
    state.totalHedgeFilled += hedgedShares;
    state.hedgedShares += hedgedShares;
    state.lastHedgeAt = now;

    // 减少未对冲股数
    state.unhedgedShares = Math.max(0, state.unhedgedShares - hedgedShares);

    // 更新平均对冲价格
    const totalCost = state.avgHedgePrice * (state.totalHedgeFilled - hedgedShares);
    state.avgHedgePrice = (totalCost + hedgedShares * hedgePrice) / state.totalHedgeFilled;
  }

  // --------------------------------------------------------------------------
  // 积分计算
  // --------------------------------------------------------------------------

  /**
   * 计算赚取的积分
   *
   * 简化模型：基于成交金额
   * 实际积分 = 订单金额 × 持仓时间 × 平台系数
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

  // --------------------------------------------------------------------------
  // 统计与报告
  // --------------------------------------------------------------------------

  /**
   * 获取统计摘要
   */
  getSummary(tokenId: string): {
    totalBuyFilled: number;
    totalSellFilled: number;
    totalHedgeFilled: number;
    totalPoints: number;
    hedgedShares: number;
    unhedgedShares: number;
    avgBuyPrice: number;
    avgHedgePrice: number;
    pnl: number;
  } {
    const state = this.getState(tokenId);

    // 估算 PnL
    // 买入成本 = totalBuyFilled * avgBuyPrice
    // 对冲成本 = totalHedgeFilled * avgHedgePrice
    // 卖出收入 = totalSellFilled * avgSellPrice (简化使用 avgBuyPrice)
    const buyCost = state.totalBuyFilled * state.avgBuyPrice;
    const hedgeCost = state.totalHedgeFilled * state.avgHedgePrice;
    const sellRevenue = state.totalSellFilled * state.avgBuyPrice; // 简化
    const pnl = sellRevenue - buyCost - hedgeCost;

    return {
      totalBuyFilled: state.totalBuyFilled,
      totalSellFilled: state.totalSellFilled,
      totalHedgeFilled: state.totalHedgeFilled,
      totalPoints: state.buyPointsEarned + state.sellPointsEarned,
      hedgedShares: state.hedgedShares,
      unhedgedShares: state.unhedgedShares,
      avgBuyPrice: state.avgBuyPrice,
      avgHedgePrice: state.avgHedgePrice,
      pnl,
    };
  }

  /**
   * 打印状态摘要
   */
  printSummary(tokenId: string): void {
    const s = this.getState(tokenId);
    const summary = this.getSummary(tokenId);

    console.log(`\n╔${'═'.repeat(70)}╗`);
    console.log(`║ 📊 Unified Strategy - Dual Track State`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 挂单状态:`);
    console.log(`║    Track A (Buy):  ${s.pendingBuyShares} shares @ $${s.pendingBuyPrice.toFixed(4)}`);
    console.log(`║    Track B (Sell): ${s.pendingSellShares} shares @ $${s.pendingSellPrice.toFixed(4)}`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 对冲状态:`);
    console.log(`║    Hedged: ${s.hedgedShares} shares | Unhedged: ${s.unhedgedShares} shares`);
    console.log(`║    Avg Buy: $${s.avgBuyPrice.toFixed(4)} | Avg Hedge: $${s.avgHedgePrice.toFixed(4)}`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 成交统计:`);
    console.log(`║    Buy=${s.totalBuyFilled} | Hedge=${s.totalHedgeFilled} | Sell=${s.totalSellFilled}`);
    console.log(`║    Points: Buy=${s.buyPointsEarned.toFixed(2)} | Sell=${s.sellPointsEarned.toFixed(2)}`);
    console.log(`║    Total Points: ${summary.totalPoints.toFixed(2)}`);
    console.log(`╠${'═'.repeat(70)}╣`);
    console.log(`║ 📌 盈亏估算: $${summary.pnl.toFixed(2)}`);
    console.log(`╚${'═'.repeat(70)}╝`);
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const unifiedStrategy = new UnifiedStrategy();
