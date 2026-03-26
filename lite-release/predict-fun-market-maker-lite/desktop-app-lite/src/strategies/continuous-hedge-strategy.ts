/**
 * 颗粒度对冲策略（Continuous Hedging Strategy）- 双轨并行版本
 *
 * 核心思想：
 * - 异步对冲逻辑（Asynchronous Hedging）
 * - 双轨并行操作：同时在买入端和卖出端赚积分
 * - 不撤单：保留剩余挂单继续排队
 * - 即时补齐：立刻触发市价单对冲
 *
 * 工作流程：
 * 1. 状态 A（空仓挂单）：挂 YES Buy + NO Buy（第二档）
 * 2. YES Buy 被成交 q 股：
 *    - 保留剩余 Q - q 股 Buy 单继续赚积分（状态 A）
 *    - 立刻市价买入 q 股 NO（对冲）
 * 3. 状态 B（持仓挂单）：挂 YES Sell + NO Sell（第二档）
 * 4. 已对冲的 q 组库存开始赚取卖出端积分
 * 5. 结果：同时在买入端和卖出端赚积分！
 *
 * 关键创新：
 * - 不是两阶段分离
 * - 而是同时维护两个轨道
 * - 状态 A + 状态 B 并行运行
 */

import { Market, Position } from '../types.js';

export interface ContinuousHedgeConfig {
  enabled: boolean;
  tolerance: number;              // 对冲偏差容忍度（0.05 = 5%）
  minHedgeSize: number;           // 最小对冲数量
  maxHedgeSize: number;           // 最大对冲数量
  buySpreadBps: number;           // Buy 单价差（基点）
  sellSpreadBps: number;          // Sell 单价差（基点）
  hedgeSlippageBps: number;       // 对冲滑点（基点）
  alwaysQuoting: boolean;         // 是否始终挂单（不间断）
  autoRebalance: boolean;         // 是否自动平衡
  dualTrackMode: boolean;         // 启用双轨并行模式
}

export enum ContinuousHedgeState {
  BALANCED = 'BALANCED',       // YES ≈ NO（平衡状态）
  YES_HEAVY = 'YES_HEAVY',     // YES > NO（多头过多）
  NO_HEAVY = 'NO_HEAVY',       // NO > YES（空头过多）
  EMPTY = 'EMPTY',             // 空仓
  DUAL_TRACK = 'DUAL_TRACK',   // 双轨并行：同时有空仓挂单和持仓挂单
}

export interface ContinuousHedgeAction {
  needsAction: boolean;
  type: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'NONE' | 'PLACE_BUY_ORDERS' | 'PLACE_SELL_ORDERS';
  shares: number;
  reason: string;
  priority: 'URGENT' | 'NORMAL' | 'LOW';
  track?: 'A' | 'B';           // 轨道标识：A=空仓挂单，B=持仓挂单
}

/**
 * 双轨并行状态管理
 */
export interface DualTrackState {
  trackA: {                      // 轨道 A：空仓挂单
    active: boolean;
    pendingBuyOrders: number;    // 待成交的 Buy 单数量
  };
  trackB: {                      // 轨道 B：持仓挂单
    active: boolean;
    hedgedShares: number;        // 已对冲的库存数量
  };
}

export class ContinuousHedgeStrategy {
  private config: ContinuousHedgeConfig;
  private dualTrackState: Map<string, DualTrackState> = new Map();

  constructor(config: Partial<ContinuousHedgeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,
      minHedgeSize: config.minHedgeSize ?? 10,
      maxHedgeSize: config.maxHedgeSize ?? 500,
      buySpreadBps: config.buySpreadBps ?? 150,
      sellSpreadBps: config.sellSpreadBps ?? 150,
      hedgeSlippageBps: config.hedgeSlippageBps ?? 250,
      alwaysQuoting: config.alwaysQuoting ?? true,
      autoRebalance: config.autoRebalance ?? true,
      dualTrackMode: config.dualTrackMode ?? true,  // 默认启用双轨模式
    };
  }

  /**
   * 分析当前状态并给出操作建议（双轨并行版本）
   */
  analyze(market: Market, position: Position, yesPrice: number, noPrice: number): {
    state: ContinuousHedgeState;
    canQuoteBuy: boolean;
    canQuoteSell: boolean;
    needsRebalancing: boolean;
    rebalanceAction?: ContinuousHedgeAction;
    dualTrack?: DualTrackState;
  } {
    const tokenId = market.token_id;
    const yesShares = position.yes_amount;
    const noShares = position.no_amount;
    const totalShares = yesShares + noShares;

    // 获取或初始化双轨状态
    let dualTrack = this.dualTrackState.get(tokenId);
    if (!dualTrack) {
      dualTrack = {
        trackA: { active: false, pendingBuyOrders: 0 },
        trackB: { active: false, hedgedShares: 0 },
      };
      this.dualTrackState.set(tokenId, dualTrack);
    }

    // 计算偏差
    const avgShares = totalShares / 2;
    const deviation = avgShares > 0 ? Math.abs(yesShares - noShares) / avgShares : 0;
    const isBalanced = deviation <= this.config.tolerance;

    // 判断状态
    let state: ContinuousHedgeState;
    if (totalShares === 0) {
      state = ContinuousHedgeState.EMPTY;
      // 空仓时，轨道 A 激活，轨道 B 停用
      dualTrack.trackA.active = true;
      dualTrack.trackB.active = false;
    } else if (isBalanced && totalShares >= this.config.minHedgeSize) {
      // 有持仓且平衡时，双轨并行
      state = ContinuousHedgeState.DUAL_TRACK;
      dualTrack.trackA.active = true;
      dualTrack.trackB.active = true;
      dualTrack.trackB.hedgedShares = Math.min(yesShares, noShares);  // 已对冲的数量
    } else if (yesShares > noShares) {
      state = ContinuousHedgeState.YES_HEAVY;
    } else {
      state = ContinuousHedgeState.NO_HEAVY;
    }

    // 判断是否可以挂单（不间断挂单）
    // 双轨模式：始终可以挂 Buy 和 Sell 单
    const canQuoteBuy = this.config.alwaysQuoting;
    const canQuoteSell = this.config.alwaysQuoting;

    // 判断是否需要平衡
    let needsRebalancing = false;
    let rebalanceAction: ContinuousHedgeAction | undefined;

    if (this.config.autoRebalance && !isBalanced && totalShares > this.config.minHedgeSize) {
      needsRebalancing = true;

      if (yesShares > noShares) {
        const excessYes = yesShares - noShares;
        const hedgeShares = Math.min(excessYes, this.config.maxHedgeSize);
        rebalanceAction = {
          needsAction: true,
          type: 'BUY_NO',
          shares: hedgeShares,
          reason: `Rebalance: YES heavy (${yesShares} > ${noShares}), buy NO to restore balance`,
          priority: 'NORMAL',
        };
      } else {
        const excessNo = noShares - yesShares;
        const hedgeShares = Math.min(excessNo, this.config.maxHedgeSize);
        rebalanceAction = {
          needsAction: true,
          type: 'BUY_YES',
          shares: hedgeShares,
          reason: `Rebalance: NO heavy (${noShares} > ${yesShares}), buy YES to restore balance`,
          priority: 'NORMAL',
        };
      }
    }

    return {
      state,
      canQuoteBuy,
      canQuoteSell,
      needsRebalancing,
      rebalanceAction,
      dualTrack,
    };
  }

  /**
   * 处理订单成交（异步对冲逻辑 - 双轨并行版本）
   */
  handleOrderFill(
    tokenId: string,
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    filledShares: number,
    currentYesShares: number,
    currentNoShares: number
  ): ContinuousHedgeAction {
    console.log(`📝 Order fill detected: ${token} ${side} order filled for ${filledShares} shares`);
    console.log(`   Before: ${currentYesShares} YES + ${currentNoShares} NO`);

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

    console.log(`   After: ${newYesShares} YES + ${newNoShares} NO`);

    // 计算新的偏差
    const totalShares = newYesShares + newNoShares;
    const avgShares = totalShares / 2;
    const deviation = avgShares > 0 ? Math.abs(newYesShares - newNoShares) / avgShares : 0;

    console.log(`   Deviation: ${(deviation * 100).toFixed(2)}% (tolerance: ${(this.config.tolerance * 100).toFixed(2)}%)`);

    // 异步对冲逻辑
    if (deviation > this.config.tolerance && totalShares >= this.config.minHedgeSize) {
      if (newYesShares > newNoShares) {
        // YES 过多，需要买入 NO
        const excessYes = newYesShares - newNoShares;
        const hedgeShares = Math.min(excessYes, this.config.maxHedgeSize);

        // 更新双轨状态
        const dualTrack = this.dualTrackState.get(tokenId);
        if (dualTrack) {
          dualTrack.trackB.hedgedShares += hedgeShares;
          dualTrack.trackB.active = true;
        }

        return {
          needsAction: true,
          type: 'BUY_NO',
          shares: hedgeShares,
          reason: `🔄 异步对冲：YES 被成交 ${filledShares}，立刻买入 ${hedgeShares} NO 恢复平衡（保留剩余挂单继续赚积分）`,
          priority: 'URGENT',
          track: side === 'BUY' ? 'A' : 'B',
        };
      } else {
        // NO 过多，需要买入 YES
        const excessNo = newNoShares - newYesShares;
        const hedgeShares = Math.min(excessNo, this.config.maxHedgeSize);

        // 更新双轨状态
        const dualTrack = this.dualTrackState.get(tokenId);
        if (dualTrack) {
          dualTrack.trackB.hedgedShares += hedgeShares;
          dualTrack.trackB.active = true;
        }

        return {
          needsAction: true,
          type: 'BUY_YES',
          shares: hedgeShares,
          reason: `🔄 异步对冲：NO 被成交 ${filledShares}，立刻买入 ${hedgeShares} YES 恢复平衡（保留剩余挂单继续赚积分）`,
          priority: 'URGENT',
          track: side === 'BUY' ? 'A' : 'B',
        };
      }
    }

    return {
      needsAction: false,
      type: 'NONE',
      shares: 0,
      reason: 'Position balanced, no hedge needed',
      priority: 'LOW',
    };
  }

  /**
   * 建议挂单价格（同时提供 Buy 和 Sell 价格）
   */
  suggestOrderPrices(
    yesPrice: number,
    noPrice: number
  ): {
    yesBid: number;    // YES Buy 单价格
    yesAsk: number;    // YES Sell 单价格
    noBid: number;     // NO Buy 单价格
    noAsk: number;     // NO Sell 单价格
  } {
    const buySpread = this.config.buySpreadBps / 10000;
    const sellSpread = this.config.sellSpreadBps / 10000;

    return {
      yesBid: Math.max(0.01, yesPrice * (1 - buySpread)),
      yesAsk: Math.min(0.99, yesPrice * (1 + sellSpread)),
      noBid: Math.max(0.01, noPrice * (1 - buySpread)),
      noAsk: Math.min(0.99, noPrice * (1 + sellSpread)),
    };
  }

  /**
   * 获取双轨状态
   */
  getDualTrackState(tokenId: string): DualTrackState | undefined {
    return this.dualTrackState.get(tokenId);
  }

  /**
   * 重置双轨状态
   */
  resetDualTrackState(tokenId: string): void {
    this.dualTrackState.delete(tokenId);
  }

  /**
   * 获取配置
   */
  getConfig(): ContinuousHedgeConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<ContinuousHedgeConfig>): void {
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
export const continuousHedgeStrategy = new ContinuousHedgeStrategy();
