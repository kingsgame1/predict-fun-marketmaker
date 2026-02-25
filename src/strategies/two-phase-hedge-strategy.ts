/**
 * 两阶段循环对冲策略
 *
 * 完整策略：
 * 第一阶段：建立对冲库存（买入端）
 *   - 在 YES 和 NO 的第二档挂 Buy 单
 *   - NO Buy 单被成交 → 立刻市价买入 YES
 *   - 结果：持有 1:1 YES/NO
 *
 * 第二阶段：赚取积分并平仓（卖出端）
 *   - 在 YES 和 NO 的第二档挂 Sell 单
 *   - 持续刷挂单积分
 *   - YES Sell 单被成交 → 立刻市价卖出 NO
 *   - 结果：库存清空，资金回笼
 *
 * 循环：第一阶段 → 第二阶段 → 第一阶段 → ...
 */

import { Market, Position } from '../types.js';

export interface TwoPhaseHedgeConfig {
  enabled: boolean;
  tolerance: number;
  minHedgeSize: number;
  maxHedgeSize: number;
  buySpreadBps: number;      // Buy 单价差（基点）
  sellSpreadBps: number;     // Sell 单价差（基点）
  flattenSlippageBps: number; // 平仓滑点（基点）
}

export enum TwoPhaseState {
  EMPTY = 'EMPTY',           // 空仓，第一阶段：挂 Buy 单
  HEDGED = 'HEDGED',         // 持有 1:1 对冲，第二阶段：挂 Sell 单
}

export interface TwoPhaseHedgeAction {
  needsAction: boolean;
  phase: 'BUY_SIDE' | 'SELL_SIDE';
  type: 'PLACE_BUY_ORDERS' | 'PLACE_SELL_ORDERS' | 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'NONE';
  shares: number;
  reason: string;
}

export class TwoPhaseHedgeStrategy {
  private config: TwoPhaseHedgeConfig;

  constructor(config: Partial<TwoPhaseHedgeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,
      minHedgeSize: config.minHedgeSize ?? 10,
      maxHedgeSize: config.maxHedgeSize ?? 500,
      buySpreadBps: config.buySpreadBps ?? 150,
      sellSpreadBps: config.sellSpreadBps ?? 150,
      flattenSlippageBps: config.flattenSlippageBps ?? 250,
    };
  }

  /**
   * 分析当前状态并给出操作建议
   */
  analyze(market: Market, position: Position, yesPrice: number, noPrice: number): {
    state: TwoPhaseState;
    action: TwoPhaseHedgeAction;
    canPlaceOrders: boolean;
  } {
    const yesShares = position.yes_amount;
    const noShares = position.no_amount;
    const totalShares = yesShares + noShares;
    const avgShares = totalShares / 2;
    // HIGH FIX #4: 避免除零，使用有限值代替 Infinity
    const ratio = (avgShares > 0 && noShares > 0) ? yesShares / noShares : (yesShares > 0 ? 999 : 0);
    const deviation = avgShares > 0 ? Math.abs(yesShares - noShares) / avgShares : 0;
    const isBalanced = deviation <= this.config.tolerance;

    // 判断阶段
    let state: TwoPhaseState;
    if (totalShares === 0) {
      state = TwoPhaseState.EMPTY;
    } else if (isBalanced && totalShares >= this.config.minHedgeSize) {
      state = TwoPhaseState.HEDGED;
    } else {
      // 不平衡状态，根据实际情况判断
      if (yesShares === 0 || noShares === 0) {
        // 只有一边，还没对冲完成
        state = TwoPhaseState.EMPTY;
      } else {
        // 两边都有但不平衡，继续第二阶段
        state = TwoPhaseState.HEDGED;
      }
    }

    // 根据阶段决定操作
    let action: TwoPhaseHedgeAction;
    let canPlaceOrders = false;

    switch (state) {
      case TwoPhaseState.EMPTY:
        // 第一阶段：挂 Buy 单建立对冲
        action = {
          needsAction: true,
          phase: 'BUY_SIDE',
          type: 'PLACE_BUY_ORDERS',
          shares: 0,
          reason: 'Empty position, place BUY orders at tier 2 to establish hedge',
        };
        canPlaceOrders = true;
        break;

      case TwoPhaseState.HEDGED:
        // 第二阶段：挂 Sell 单赚取积分
        action = {
          needsAction: true,
          phase: 'SELL_SIDE',
          type: 'PLACE_SELL_ORDERS',
          shares: 0,
          reason: `Hedged position (${yesShares} YES + ${noShares} NO), place SELL orders to earn points`,
        };
        canPlaceOrders = true;
        break;
    }

    return { state, action, canPlaceOrders };
  }

  /**
   * 处理订单成交
   */
  handleOrderFill(
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    filledShares: number,
    currentYesShares: number,
    currentNoShares: number,
    currentState: TwoPhaseState
  ): TwoPhaseHedgeAction {
    console.log(`📝 Order fill detected: ${token} ${side} order filled for ${filledShares} shares`);
    console.log(`   Current state: ${currentState}`);
    console.log(`   Before: ${currentYesShares} YES + ${currentNoShares} NO`);

    // 第一阶段：挂 Buy 单时
    if (currentState === TwoPhaseState.EMPTY && side === 'BUY') {
      if (token === 'NO') {
        // NO Buy 单被成交 → 立刻买入 YES
        return {
          needsAction: true,
          phase: 'BUY_SIDE',
          type: 'BUY_YES',
          shares: filledShares,
          reason: `Phase 1: NO BUY order filled (${filledShares}), immediately buy YES to establish 1:1 hedge`,
        };
      } else if (token === 'YES') {
        // YES Buy 单被成交 → 立刻买入 NO
        return {
          needsAction: true,
          phase: 'BUY_SIDE',
          type: 'BUY_NO',
          shares: filledShares,
          reason: `Phase 1: YES BUY order filled (${filledShares}), immediately buy NO to establish 1:1 hedge`,
        };
      }
    }

    // 第二阶段：挂 Sell 单时
    if (currentState === TwoPhaseState.HEDGED && side === 'SELL') {
      const wasBalanced = Math.abs(currentYesShares - currentNoShares) <= this.config.tolerance * (currentYesShares + currentNoShares) / 2;

      if (wasBalanced) {
        if (token === 'YES') {
          // YES Sell 单被成交 → 立刻卖出 NO
          return {
            needsAction: true,
            phase: 'SELL_SIDE',
            type: 'SELL_NO',
            shares: currentNoShares,
            reason: `Phase 2: YES SELL order filled (${filledShares}), immediately sell all NO (${currentNoShares}) to flatten`,
          };
        } else if (token === 'NO') {
          // NO Sell 单被成交 → 立刻卖出 YES
          return {
            needsAction: true,
            phase: 'SELL_SIDE',
            type: 'SELL_YES',
            shares: currentYesShares,
            reason: `Phase 2: NO SELL order filled (${filledShares}), immediately sell all YES (${currentYesShares}) to flatten`,
          };
        }
      }
    }

    return {
      needsAction: false,
      phase: currentState === TwoPhaseState.EMPTY ? 'BUY_SIDE' : 'SELL_SIDE',
      type: 'NONE',
      shares: 0,
      reason: 'Will be handled by analyze() method',
    };
  }

  /**
   * 建议挂单价格
   */
  suggestOrderPrices(
    yesPrice: number,
    noPrice: number,
    phase: TwoPhaseState
  ): {
    yesBid?: number;    // Buy 单价格（第一阶段）
    yesAsk?: number;    // Sell 单价格（第二阶段）
    noBid?: number;     // Buy 单价格（第一阶段）
    noAsk?: number;     // Sell 单价格（第二阶段）
  } {
    const buySpread = this.config.buySpreadBps / 10000;
    const sellSpread = this.config.sellSpreadBps / 10000;

    if (phase === TwoPhaseState.EMPTY) {
      // 第一阶段：挂 Buy 单（第二档）
      return {
        yesBid: Math.max(0.01, yesPrice * (1 - buySpread)),
        noBid: Math.max(0.01, noPrice * (1 - buySpread)),
      };
    } else {
      // 第二阶段：挂 Sell 单（第二档）
      return {
        yesAsk: Math.min(0.99, yesPrice * (1 + sellSpread)),
        noAsk: Math.min(0.99, noPrice * (1 + sellSpread)),
      };
    }
  }

  /**
   * 检查市场是否适合
   */
  isMarketSuitable(yesPrice: number, noPrice: number): boolean {
    const sum = yesPrice + noPrice;
    return sum <= 1.05;
  }

  /**
   * 获取配置
   */
  getConfig(): TwoPhaseHedgeConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<TwoPhaseHedgeConfig>): void {
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
export const twoPhaseHedgeStrategy = new TwoPhaseHedgeStrategy();
