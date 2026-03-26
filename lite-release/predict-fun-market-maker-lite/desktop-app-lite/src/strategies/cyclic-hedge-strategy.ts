/**
 * 循环对冲策略
 *
 * 核心逻辑：
 * 1. 初始：0 头寸，挂 YES 卖单 + NO 卖单
 * 2. 被吃单后立即对冲（买入对边）→ 1:1 持仓
 * 3. 继续挂单（YES 卖单 + NO 卖单）
 * 4. 一边被成交 → 立即卖出对边 → 回到 0 头寸
 * 5. 重复循环
 *
 * 关键：每个周期结束后清空持仓，重新开始
 */

import { Market, Position } from '../types.js';

export interface CyclicHedgeConfig {
  enabled: boolean;
  tolerance: number;           // 对冲偏差容忍度
  minHedgeSize: number;        // 最小对冲数量
  maxHedgeSize: number;        // 最大对冲数量
  autoBalance: boolean;        // 自动平衡
  balanceSlippageBps: number;  // 平衡滑点
  flattenSlippageBps: number;  // 平仓滑点
}

export enum HedgePhase {
  EMPTY = 'EMPTY',           // 0 头寸，等待被吃单
  HEDGED = 'HEDGED',         // 1:1 对冲，挂单中
  UNBALANCED = 'UNBALANCED', // 不平衡，需要处理
}

export interface HedgeState {
  phase: HedgePhase;
  yesShares: number;
  noShares: number;
  ratio: number;
  isBalanced: boolean;
}

export interface HedgeAction {
  needsAction: boolean;
  type: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'FLATTEN_ALL' | 'NONE';
  shares: number;
  reason: string;
}

export class CyclicHedgeStrategy {
  private config: CyclicHedgeConfig;

  constructor(config: Partial<CyclicHedgeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,
      minHedgeSize: config.minHedgeSize ?? 10,
      maxHedgeSize: config.maxHedgeSize ?? 500,
      autoBalance: config.autoBalance ?? true,
      balanceSlippageBps: config.balanceSlippageBps ?? 300,
      flattenSlippageBps: config.flattenSlippageBps ?? 250,
    };
  }

  /**
   * 分析当前状态并给出操作建议
   */
  analyze(market: Market, position: Position): {
    state: HedgeState;
    action: HedgeAction;
    canPlaceOrders: boolean;
  } {
    const yesShares = position.yes_amount;
    const noShares = position.no_amount;
    const totalShares = yesShares + noShares;

    // 计算对冲比例
    const avgShares = totalShares / 2;
    const ratio = avgShares > 0 ? yesShares / noShares : (yesShares > 0 ? Infinity : 0);
    const deviation = avgShares > 0 ? Math.abs(yesShares - noShares) / avgShares : 0;
    const isBalanced = deviation <= this.config.tolerance;

    // 判断阶段
    let phase: HedgePhase;
    if (totalShares === 0) {
      phase = HedgePhase.EMPTY;
    } else if (isBalanced && totalShares >= this.config.minHedgeSize) {
      phase = HedgePhase.HEDGED;
    } else {
      phase = HedgePhase.UNBALANCED;
    }

    // 根据阶段决定操作
    let action: HedgeAction;
    let canPlaceOrders = false;

    switch (phase) {
      case HedgePhase.EMPTY:
        // 阶段1: 空仓，可以挂单等待被吃
        action = {
          needsAction: false,
          type: 'NONE',
          shares: 0,
          reason: 'Empty position, waiting for orders to be filled',
        };
        canPlaceOrders = true;
        break;

      case HedgePhase.HEDGED:
        // 阶段2: 1:1 对冲，可以继续挂单
        // 如果一边被成交，会进入 UNBALANCED 状态，然后平仓
        action = {
          needsAction: false,
          type: 'NONE',
          shares: 0,
          reason: `Hedged position (${yesShares} YES + ${noShares} NO), continue making market`,
        };
        canPlaceOrders = true;
        break;

      case HedgePhase.UNBALANCED:
        // 阶段3: 不平衡，需要处理

        // 情况A: 只有 YES 或只有 NO（被吃单后还未对冲）
        if (yesShares === 0 || noShares === 0) {
          if (this.config.autoBalance) {
            // 需要对冲：买入缺少的一边
            if (yesShares === 0 && noShares > 0) {
              action = {
                needsAction: true,
                type: 'BUY_YES',
                shares: noShares,
                reason: `Only ${noShares} NO held, buy ${noShares} YES to hedge`,
              };
            } else if (noShares === 0 && yesShares > 0) {
              action = {
                needsAction: true,
                type: 'BUY_NO',
                shares: yesShares,
                reason: `Only ${yesShares} YES held, buy ${yesShares} NO to hedge`,
              };
            } else {
              action = {
                needsAction: false,
                type: 'NONE',
                shares: 0,
                reason: 'Both sides zero, should be EMPTY phase',
              };
            }
          } else {
            action = {
              needsAction: false,
              type: 'NONE',
              shares: 0,
              reason: 'Unbalanced but auto-balance disabled',
            };
          }
        }
        // 情况B: 两边都有但不平衡（一边被部分成交）
        else {
          if (this.config.autoBalance) {
            // 检查是否严重不平衡（可能是被成交了很多）
            if (deviation > 0.5) {
              // 严重不平衡，直接平仓所有，重新开始
              action = {
                needsAction: true,
                type: 'FLATTEN_ALL',
                shares: totalShares,
                reason: `Severely unbalanced (${yesShares} YES vs ${noShares} NO), flatten all and restart`,
              };
            } else {
              // 轻微不平衡，买入缺少的对边
              if (yesShares > noShares) {
                action = {
                  needsAction: true,
                  type: 'BUY_NO',
                  shares: yesShares - noShares,
                  reason: `Slightly unbalanced, buy ${yesShares - noShares} NO to balance`,
                };
              } else {
                action = {
                  needsAction: true,
                  type: 'BUY_YES',
                  shares: noShares - yesShares,
                  reason: `Slightly unbalanced, buy ${noShares - yesShares} YES to balance`,
                };
              }
            }
          } else {
            action = {
              needsAction: false,
              type: 'NONE',
              shares: 0,
              reason: 'Unbalanced but auto-balance disabled',
            };
          }
        }
        break;
    }

    const state: HedgeState = {
      phase,
      yesShares,
      noShares,
      ratio,
      isBalanced,
    };

    return { state, action, canPlaceOrders };
  }

  /**
   * 处理订单成交后的状态变化
   *
   * 当我们挂的卖单被成交时调用此方法
   */
  handleOrderFill(
    side: 'YES' | 'NO',
    filledShares: number,
    currentYesShares: number,
    currentNoShares: number
  ): HedgeAction {
    // 当我们的卖单被成交时，我们是在卖出，减少持仓！
    const newYesShares = currentYesShares - (side === 'YES' ? filledShares : 0);
    const newNoShares = currentNoShares - (side === 'NO' ? filledShares : 0);

    console.log(`📝 Order fill detected: ${side} SELL order filled for ${filledShares} shares`);
    console.log(`   Before: ${currentYesShares} YES + ${currentNoShares} NO`);
    console.log(`   After: ${newYesShares} YES + ${newNoShares} NO`);

    // 情况1: 之前是空仓，卖单被成交 → 被迫买入（实际上是被"空卖"）
    if (currentYesShares === 0 && currentNoShares === 0) {
      // 我们的卖单被成交但我们没有持仓，意味着我们被迫买入（short selling 被覆盖）
      // 所以应该立即买入对边来对冲
      const hedgeSide = side === 'YES' ? 'BUY_NO' : 'BUY_YES';
      return {
        needsAction: true,
        type: hedgeSide,
        shares: filledShares,
        reason: `Initial fill: SELL order filled but no position, immediately buy ${hedgeSide === 'BUY_YES' ? 'YES' : 'NO'} to establish hedge`,
      };
    }

    // 情况2: 之前是 1:1 对冲，现在一边被卖出（需要立即平仓对边，回到 0 头寸）
    const wasBalanced = Math.abs(currentYesShares - currentNoShares) <= this.config.tolerance * (currentYesShares + currentNoShares) / 2;

    if (wasBalanced) {
      // 之前是对冲状态，现在一边被卖出
      const flattenSide = side === 'YES' ? 'SELL_NO' : 'SELL_YES';
      const remainingShares = side === 'YES' ? newNoShares : newYesShares; // 使用新的持仓数量

      return {
        needsAction: true,
        type: flattenSide,
        shares: remainingShares,
        reason: `Hedge position filled: sold ${side} (${filledShares}), immediately flatten ${flattenSide === 'SELL_YES' ? 'YES' : 'NO'} (${remainingShares}) to return to EMPTY`,
      };
    }

    // 情况3: 其他情况，让 analyze() 方法处理
    return {
      needsAction: false,
      type: 'NONE',
      shares: 0,
      reason: 'Complex state, will be handled by analyze()',
    };
  }

  /**
   * 检查市场是否适合此策略
   */
  isMarketSuitable(yesPrice: number, noPrice: number): boolean {
    const sum = yesPrice + noPrice;
    const isSuitable = sum <= 1.05;

    if (!isSuitable) {
      console.log(`   ⚠️  Market not suitable: YES+NO=${sum.toFixed(4)} > 1.05`);
    }

    return isSuitable;
  }

  /**
   * 建议挂单价格
   */
  suggestQuotePrices(
    yesPrice: number,
    noPrice: number,
    spreadBps: number = 150
  ): {
    yesAsk: number;
    noAsk: number;
  } {
    const spread = spreadBps / 10000;

    return {
      yesAsk: Math.min(0.99, yesPrice * (1 + spread)),
      noAsk: Math.min(0.99, noPrice * (1 + spread)),
    };
  }

  /**
   * 验证对冲质量
   */
  verifyHedgeQuality(yesPrice: number, noPrice: number): {
    isPerfect: boolean;
    sum: number;
    deviation: number;
    quality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  } {
    const sum = yesPrice + noPrice;
    const deviation = Math.abs(sum - 1);

    let quality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';

    if (deviation <= 0.01) {
      quality = 'EXCELLENT';
    } else if (deviation <= 0.03) {
      quality = 'GOOD';
    } else if (deviation <= 0.05) {
      quality = 'FAIR';
    } else {
      quality = 'POOR';
    }

    return {
      isPerfect: deviation <= 0.05,
      sum,
      deviation,
      quality,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): CyclicHedgeConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<CyclicHedgeConfig>): void {
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
export const cyclicHedgeStrategy = new CyclicHedgeStrategy();
