/**
 * 统一做市商策略（Unified Market Maker Strategy）
 *
 * 整合了所有策略的优点：
 * - 两阶段循环对冲（V5）的基础逻辑
 * - 颗粒度对冲的异步对冲逻辑
 * - 双轨并行操作的积分最大化
 *
 * 核心特性：
 * 1. 异步对冲：成交一点 → 立即对冲一点（不撤单）
 * 2. 双轨并行：同时在买入端和卖出端赚积分
 * 3. 恒定价值：YES + NO = 1，持有 1:1 时风险为零
 * 4. 积分最大化：不间断挂单，持续赚取积分
 *
 * 工作流程：
 * - 初始：挂 YES Buy + NO Buy（第二档）
 * - 被成交：立刻对冲（买入对面）→ 1:1 持仓
 * - 双轨并行：
 *   - 轨道 A：继续挂 Buy 单（赚取买入端积分）
 *   - 轨道 B：挂 Sell 单（赚取卖出端积分）
 * - 持续循环：积分收益最大化
 */

import { Market, Position } from '../types.js';

export interface UnifiedMarketMakerConfig {
  enabled: boolean;
  tolerance: number;              // 对冲偏差容忍度（0.05 = 5%）
  minHedgeSize: number;           // 最小对冲数量
  maxHedgeSize: number;           // 最大对冲数量
  buySpreadBps: number;           // Buy 单价差（基点）- 备用
  sellSpreadBps: number;          // Sell 单价差（基点）- 备用
  hedgeSlippageBps: number;       // 对冲滑点（基点）
  asyncHedging: boolean;          // 启用异步对冲（不撤单）
  dualTrackMode: boolean;         // 启用双轨并行模式
  dynamicOffsetMode: boolean;     // 启用动态偏移模式（第二档挂单）
  buyOffsetBps?: number;          // Buy 单偏移量（基点，相对于第一档）
  sellOffsetBps?: number;         // Sell 单偏移量（基点，相对于第一档）
}

export enum UnifiedState {
  EMPTY = 'EMPTY',                 // 空仓
  HEDGED = 'HEDGED',             // 已对冲（1:1）
  DUAL_TRACK = 'DUAL_TRACK',     // 双轨并行（最优状态）
}

export interface UnifiedAction {
  needsAction: boolean;
  type: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'PLACE_ORDERS' | 'NONE';
  shares: number;
  reason: string;
  priority: 'URGENT' | 'NORMAL';
}

/**
 * 统一做市商策略
 */
export class UnifiedMarketMakerStrategy {
  private config: UnifiedMarketMakerConfig;

  constructor(config: Partial<UnifiedMarketMakerConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,
      minHedgeSize: config.minHedgeSize ?? 10,
      maxHedgeSize: config.maxHedgeSize ?? 500,
      buySpreadBps: config.buySpreadBps ?? 150,
      sellSpreadBps: config.sellSpreadBps ?? 150,
      hedgeSlippageBps: config.hedgeSlippageBps ?? 250,
      asyncHedging: config.asyncHedging ?? true,        // 默认启用异步对冲
      dualTrackMode: config.dualTrackMode ?? true,      // 默认启用双轨并行
      dynamicOffsetMode: config.dynamicOffsetMode ?? true, // 默认启用动态偏移
      buyOffsetBps: config.buyOffsetBps ?? 100,         // 默认 1% 偏移
      sellOffsetBps: config.sellOffsetBps ?? 100,       // 默认 1% 偏移
    };
  }

  /**
   * 分析当前状态并给出操作建议
   */
  analyze(market: Market, position: Position, yesPrice: number, noPrice: number): {
    state: UnifiedState;
    shouldPlaceBuyOrders: boolean;
    shouldPlaceSellOrders: boolean;
    buyOrderSize: number;
    sellOrderSize: number;
  } {
    const yesShares = position.yes_amount;
    const noShares = position.no_amount;
    const totalShares = yesShares + noShares;

    // 计算偏差
    const avgShares = totalShares / 2;
    const deviation = avgShares > 0 ? Math.abs(yesShares - noShares) / avgShares : 0;
    const isBalanced = deviation <= this.config.tolerance;

    // 判断状态
    let state: UnifiedState;
    let shouldPlaceBuyOrders = false;
    let shouldPlaceSellOrders = false;

    if (totalShares === 0) {
      state = UnifiedState.EMPTY;
      shouldPlaceBuyOrders = true;
    } else if (isBalanced && totalShares >= this.config.minHedgeSize) {
      // 已对冲，启用双轨并行
      state = UnifiedState.DUAL_TRACK;
      shouldPlaceBuyOrders = true;
      shouldPlaceSellOrders = true;
    } else if (!isBalanced) {
      // 不平衡，需要继续对冲
      state = UnifiedState.HEDGED;
      shouldPlaceBuyOrders = true;
      shouldPlaceSellOrders = yesShares > 0 || noShares > 0;
    } else {
      state = UnifiedState.EMPTY;
      shouldPlaceBuyOrders = true;
    }

    // 计算订单大小
    const baseOrderSize = Math.max(10, Math.floor(this.config.minHedgeSize));
    const buyOrderSize = shouldPlaceBuyOrders ? baseOrderSize : 0;
    const sellOrderSize = shouldPlaceSellOrders ? Math.min(baseOrderSize, Math.floor(totalShares / 2)) : 0;

    return {
      state,
      shouldPlaceBuyOrders,
      shouldPlaceSellOrders,
      buyOrderSize,
      sellOrderSize,
    };
  }

  /**
   * 处理订单成交（异步对冲逻辑）
   */
  handleOrderFill(
    tokenId: string,
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    filledShares: number,
    currentYesShares: number,
    currentNoShares: number
  ): UnifiedAction {
    console.log(`📝 订单成交: ${token} ${side} ${filledShares} 股`);
    console.log(`   当前持仓: ${currentYesShares} YES + ${currentNoShares} NO`);

    // 计算成交后的持仓
    let newYesShares = currentYesShares;
    let newNoShares = currentNoShares;

    if (side === 'BUY') {
      if (token === 'YES') {
        newYesShares += filledShares;
      } else {
        newNoShares += filledShares;
      }
    } else {
      if (token === 'YES') {
        newYesShares -= filledShares;
      } else {
        newNoShares -= filledShares;
      }
    }

    console.log(`   成交后: ${newYesShares} YES + ${newNoShares} NO`);

    // 计算偏差
    const totalShares = newYesShares + newNoShares;
    const avgShares = totalShares / 2;
    const deviation = avgShares > 0 ? Math.abs(newYesShares - newNoShares) / avgShares : 0;

    console.log(`   偏差: ${(deviation * 100).toFixed(2)}% (容忍度: ${(this.config.tolerance * 100).toFixed(2)}%)`);

    // 如果偏差超过容忍度，执行异步对冲
    if (deviation > this.config.tolerance && totalShares >= this.config.minHedgeSize) {
      if (newYesShares > newNoShares) {
        // YES 过多，需要买入 NO
        const excessYes = newYesShares - newNoShares;
        const hedgeShares = Math.min(excessYes, this.config.maxHedgeSize);

        console.log(`🔄 异步对冲: YES 过多，买入 ${hedgeShares} NO 恢复平衡`);

        return {
          needsAction: true,
          type: 'BUY_NO',
          shares: hedgeShares,
          reason: `异步对冲：${token} 被成交 ${filledShares}，买入 ${hedgeShares} NO 恢复平衡（保留剩余挂单继续赚积分）`,
          priority: 'URGENT',
        };
      } else {
        // NO 过多，需要买入 YES
        const excessNo = newNoShares - newYesShares;
        const hedgeShares = Math.min(excessNo, this.config.maxHedgeSize);

        console.log(`🔄 异步对冲: NO 过多，买入 ${hedgeShares} YES 恢复平衡`);

        return {
          needsAction: true,
          type: 'BUY_YES',
          shares: hedgeShares,
          reason: `异步对冲：${token} 被成交 ${filledShares}，买入 ${hedgeShares} YES 恢复平衡（保留剩余挂单继续赚积分）`,
          priority: 'URGENT',
        };
      }
    }

    return {
      needsAction: false,
      type: 'NONE',
      shares: 0,
      reason: '持仓平衡，无需对冲',
      priority: 'NORMAL',
    };
  }

  /**
   * 建议挂单价格（同时提供 Buy 和 Sell 价格）
   *
   * 第二档动态挂单策略：
   * - 根据第一档价格动态偏移（避免成为第一档）
   * - 例如：第一档买价 99.1 → 我们挂 99.0（偏移 -0.1%）
   */
  suggestOrderPrices(
    yesPrice: number,
    noPrice: number,
    yesOrderbook?: { bids: Array<{ price: string }>; asks: Array<{ price: string }>; best_bid?: number; best_ask?: number },
    noOrderbook?: { bids: Array<{ price: string }>; asks: Array<{ price: string }>; best_bid?: number; best_ask?: number }
  ): {
    yesBid: number;    // YES Buy 单价格
    yesAsk: number;    // YES Sell 单价格
    noBid: number;     // NO Buy 单价格
    noAsk: number;     // NO Sell 单价格
    source: 'DYNAMIC_OFFSET' | 'FIXED_SPREAD';  // 价格来源
  } {
    let yesBid: number;
    let yesAsk: number;
    let noBid: number;
    let noAsk: number;
    let source: 'DYNAMIC_OFFSET' | 'FIXED_SPREAD' = 'FIXED_SPREAD';

    if (this.config.dynamicOffsetMode) {
      // 动态偏移模式：根据第一档价格计算
      const buyOffset = (this.config.buyOffsetBps ?? 100) / 10000;  // 默认 1%
      const sellOffset = (this.config.sellOffsetBps ?? 100) / 10000; // 默认 1%

      // YES: 根据第一档价格偏移
      const yesBestBid = yesOrderbook?.best_bid ?? yesPrice;
      const yesBestAsk = yesOrderbook?.best_ask ?? (yesPrice * 1.01);

      yesBid = Math.max(0.01, yesBestBid * (1 - buyOffset));   // 低于第一档买价
      yesAsk = Math.max(0.01, yesBestAsk * (1 + sellOffset));  // 高于第一档卖价

      // NO: 根据第一档价格偏移
      const noBestBid = noOrderbook?.best_bid ?? noPrice;
      const noBestAsk = noOrderbook?.best_ask ?? (noPrice * 1.01);

      noBid = Math.max(0.01, noBestBid * (1 - buyOffset));     // 低于第一档买价
      noAsk = Math.max(0.01, noBestAsk * (1 + sellOffset));    // 高于第一档卖价

      source = 'DYNAMIC_OFFSET';
    } else {
      // 固定价差模式（备用）
      const buySpread = this.config.buySpreadBps / 10000;
      const sellSpread = this.config.sellSpreadBps / 10000;

      yesBid = Math.max(0.01, yesPrice * (1 - buySpread));
      yesAsk = Math.min(0.99, yesPrice * (1 + sellSpread));
      noBid = Math.max(0.01, noPrice * (1 - buySpread));
      noAsk = Math.min(0.99, noPrice * (1 + sellSpread));

      source = 'FIXED_SPREAD';
    }

    return {
      yesBid,
      yesAsk: Math.min(0.99, yesAsk),
      noBid,
      noAsk: Math.min(0.99, noAsk),
      source,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): UnifiedMarketMakerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<UnifiedMarketMakerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * 全局单例
 */
export const unifiedMarketMakerStrategy = new UnifiedMarketMakerStrategy();
