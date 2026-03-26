/**
 * 永久对冲策略
 *
 * 核心逻辑：
 * 1. 基础：第二档挂单做市（保持不变）
 * 2. 第一次被吃单：立即买入对边 → 建立 1:1 对冲
 * 3. 持有 1:1 对冲时：继续挂 YES 卖单 + NO 卖单（第二档）
 * 4. 再次被吃单：卖出另一边的多余部分 → 保持 1:1 对冲
 * 5. 永远保持对冲状态，不平仓！
 *
 * 关键：始终保持 YES:NO = 1:1
 */

import { Market, Position } from '../types.js';

export interface PerpetualHedgeConfig {
  enabled: boolean;
  tolerance: number;           // 对冲偏差容忍度（0.05 = 5%）
  minHedgeSize: number;        // 最小对冲数量
  maxHedgeSize: number;        // 最大对冲数量
  autoRebalance: boolean;      // 自动重新平衡
  rebalanceSlippageBps: number; // 重新平衡滑点
}

export enum HedgePhase {
  EMPTY = 'EMPTY',           // 0 头寸，等待建立对冲
  HEDGED = 'HEDGED',         // 1:1 对冲状态，正常做市
  UNBALANCED = 'UNBALANCED', // 不平衡，需要重新平衡
}

export interface HedgeState {
  phase: HedgePhase;
  yesShares: number;
  noShares: number;
  ratio: number;             // YES/NO 比例
  isBalanced: boolean;
  hedgeSize: number;         // 对冲规模（min(yes, no)）
}

export interface HedgeAction {
  needsAction: boolean;
  type: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'NONE';
  shares: number;
  reason: string;
}

export class PerpetualHedgeStrategy {
  private config: PerpetualHedgeConfig;

  constructor(config: Partial<PerpetualHedgeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,
      minHedgeSize: config.minHedgeSize ?? 10,
      maxHedgeSize: config.maxHedgeSize ?? 500,
      autoRebalance: config.autoRebalance ?? true,
      rebalanceSlippageBps: config.rebalanceSlippageBps ?? 300,
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
    const hedgeSize = Math.min(yesShares, noShares);

    // 判断阶段
    let phase: HedgePhase;
    if (totalShares === 0) {
      phase = HedgePhase.EMPTY;
    } else if (isBalanced && hedgeSize >= this.config.minHedgeSize) {
      phase = HedgePhase.HEDGED;
    } else {
      phase = HedgePhase.UNBALANCED;
    }

    // 根据阶段决定操作
    let action: HedgeAction;
    let canPlaceOrders = false;

    switch (phase) {
      case HedgePhase.EMPTY:
        // 空仓状态，可以挂单等待被吃
        action = {
          needsAction: false,
          type: 'NONE',
          shares: 0,
          reason: 'Empty position, waiting for orders to be filled to establish hedge',
        };
        canPlaceOrders = true;
        break;

      case HedgePhase.HEDGED:
        // 1:1 对冲状态，可以继续挂单
        action = {
          needsAction: false,
          type: 'NONE',
          shares: 0,
          reason: `Hedged position (${yesShares} YES + ${noShares} NO), continue making market`,
        };
        canPlaceOrders = true;
        break;

      case HedgePhase.UNBALANCED:
        // 不平衡状态，需要重新平衡
        if (this.config.autoRebalance) {
          const diff = Math.abs(yesShares - noShares);

          if (yesShares > noShares) {
            // YES 过多，卖出多余的 YES
            action = {
              needsAction: true,
              type: 'SELL_YES',
              shares: diff,
              reason: `Unbalanced: ${yesShares} YES vs ${noShares} NO, sell ${diff} YES to restore 1:1 hedge`,
            };
          } else {
            // NO 过多，卖出多余的 NO
            action = {
              needsAction: true,
              type: 'SELL_NO',
              shares: diff,
              reason: `Unbalanced: ${yesShares} YES vs ${noShares} NO, sell ${diff} NO to restore 1:1 hedge`,
            };
          }
        } else {
          action = {
            needsAction: false,
            type: 'NONE',
            shares: 0,
            reason: 'Unbalanced but auto-rebalance disabled',
          };
        }
        break;
    }

    const state: HedgeState = {
      phase,
      yesShares,
      noShares,
      ratio,
      isBalanced,
      hedgeSize,
    };

    return { state, action, canPlaceOrders };
  }

  /**
   * 处理订单成交后的状态变化
   *
   * 关键方法：根据之前的持仓状态和新成交，决定如何操作
   */
  handleOrderFill(
    side: 'YES' | 'NO',
    filledShares: number,
    currentYesShares: number,
    currentNoShares: number,
    previousState: HedgePhase
  ): HedgeAction {
    // 当我们的卖单被成交时，我们是在卖出，减少持仓
    const newYesShares = currentYesShares - (side === 'YES' ? filledShares : 0);
    const newNoShares = currentNoShares - (side === 'NO' ? filledShares : 0);

    console.log(`📝 Order fill detected: ${side} SELL order filled for ${filledShares} shares`);
    console.log(`   Previous state: ${previousState}`);
    console.log(`   Before: ${currentYesShares} YES + ${currentNoShares} NO`);
    console.log(`   After: ${newYesShares} YES + ${newNoShares} NO`);

    // 情况1: 之前是空仓（EMPTY），卖单被成交 → 被迫买入（空仓不能卖）
    // 这种情况实际上是：我们的卖单被成交，但我们没有持仓，所以被"空卖"
    // 在实际交易中，这意味着我们被迫买入（short selling 被覆盖）
    // 所以应该是：买入对边来对冲
    if (previousState === HedgePhase.EMPTY && (currentYesShares === 0 && currentNoShares === 0)) {
      const hedgeSide = side === 'YES' ? 'BUY_NO' : 'BUY_YES';
      return {
        needsAction: true,
        type: hedgeSide,
        shares: filledShares,
        reason: `Initial fill: SELL order filled but no position, immediately buy ${hedgeSide === 'BUY_YES' ? 'YES' : 'NO'} to establish hedge`,
      };
    }

    // 情况2: 之前是 1:1 对冲（HEDGED），现在一边被卖出
    if (previousState === HedgePhase.HEDGED) {
      const wasBalanced = Math.abs(currentYesShares - currentNoShares) <= this.config.tolerance * (currentYesShares + currentNoShares) / 2;

      if (wasBalanced) {
        // 计算新的对冲规模（取两边较小的）
        const targetHedgeSize = Math.min(newYesShares, newNoShares);

        if (side === 'YES') {
          // YES 卖单被成交 → YES 减少
          // 如果 newYes < newNo，需要卖出多余的 NO 保持 1:1
          if (newYesShares < newNoShares) {
            const sellNo = newNoShares - newYesShares;
            return {
              needsAction: true,
              type: 'SELL_NO',
              shares: sellNo,
              reason: `YES sold (${filledShares}), sell ${sellNo} NO to maintain 1:1 (${currentYesShares}:${currentNoShares} → ${newYesShares}:${newYesShares})`,
            };
          }
        } else if (side === 'NO') {
          // NO 卖单被成交 → NO 减少
          // 如果 newNo < newYes，需要卖出多余的 YES 保持 1:1
          if (newNoShares < newYesShares) {
            const sellYes = newYesShares - newNoShares;
            return {
              needsAction: true,
              type: 'SELL_YES',
              shares: sellYes,
              reason: `NO sold (${filledShares}), sell ${sellYes} YES to maintain 1:1 (${currentYesShares}:${currentNoShares} → ${newNoShares}:${newNoShares})`,
            };
          }
        }
      }
    }

    // 情况3: 其他状态，使用 analyze() 方法处理
    return {
      needsAction: false,
      type: 'NONE',
      shares: 0,
      reason: 'Will be handled by analyze() method',
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
  getConfig(): PerpetualHedgeConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<PerpetualHedgeConfig>): void {
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
export const perpetualHedgeStrategy = new PerpetualHedgeStrategy();
