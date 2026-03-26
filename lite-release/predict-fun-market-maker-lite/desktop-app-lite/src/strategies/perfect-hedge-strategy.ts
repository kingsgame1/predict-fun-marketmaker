/**
 * 完美对冲做市策略（积分版）
 *
 * 核心思想：
 * 1. 初始状态：0 头寸（0 YES + 0 NO）
 * 2. 双边挂单赚积分：同时挂 YES 和 NO 的卖单
 * 3. 被吃单后立即对冲：买入对边恢复 1:1 对冲
 *
 * 实际场景：
 * - 挂 YES 卖单 + NO 卖单（价格较高，不易被吃）
 * - YES 卖单被吃 → 被迫买入 YES → 立即市价买入 NO 对冲
 * - NO 卖单被吃 → 被迫买入 NO → 立即市价买入 YES 对冲
 *
 * 数学原理：
 * - 如果 YES + NO = 1，持有 N YES + N NO 的总价值永远是 N
 * - 无论价格怎么变，完全对冲，无方向性风险
 * - 利润来源：积分收益 + 价差收益
 */

import { Market, Position, Orderbook } from '../types.js';

export interface PerfectHedgeConfig {
  // 启用完美对冲策略
  enabled: boolean;

  // 对冲偏差容忍度（允许 YES 和 NO 数量的差异比例）
  // 0.05 = 允许 5% 的偏差
  tolerance: number;

  // 最小对冲数量（至少持有多少股才对冲）
  minHedgeSize: number;

  // 最大对冲数量（最多持有多少股）
  maxHedgeSize: number;

  // 是否自动平衡（当不平衡时自动恢复 1:1）
  autoBalance: boolean;

  // 平衡滑点（基点）
  balanceSlippageBps: number;
}

export interface HedgeRatio {
  yesShares: number;
  noShares: number;
  ratio: number;          // YES/NO 比例，1 = 完美对冲
  isBalanced: boolean;     // 是否在容忍度内
  deviation: number;       // 偏差百分比
}

export interface HedgeAction {
  needsRebalance: boolean;
  side: 'BUY_YES' | 'SELL_YES' | 'BUY_NO' | 'SELL_NO' | 'NONE';
  shares: number;
  reason: string;
}

export class PerfectHedgeStrategy {
  private config: PerfectHedgeConfig;

  constructor(config: Partial<PerfectHedgeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      tolerance: config.tolerance ?? 0.05,  // 5% 容忍度
      minHedgeSize: config.minHedgeSize ?? 50,  // 至少 50 股
      maxHedgeSize: config.maxHedgeSize ?? 500,  // 最多 500 股
      autoBalance: config.autoBalance ?? true,
      balanceSlippageBps: config.balanceSlippageBps ?? 300,  // 3% 滑点
    };
  }

  /**
   * 检查市场是否适合完美对冲
   * 条件：YES + NO ≤ 1（允许小误差）
   */
  isMarketSuitable(market: Market, yesPrice: number, noPrice: number): boolean {
    const sum = yesPrice + noPrice;

    // YES + NO 应该 ≤ 1.05（允许 5% 误差）
    const isSuitable = sum <= 1.05;

    if (!isSuitable) {
      console.log(`   ⚠️  Market not suitable for perfect hedge: YES+NO=${sum.toFixed(4)} > 1.05`);
    }

    return isSuitable;
  }

  /**
   * 计算对冲比例
   */
  calculateHedgeRatio(position: Position): HedgeRatio {
    const yesShares = position.yes_amount;
    const noShares = position.no_amount;

    // 计算比例（避免除零）
    const ratio = noShares > 0 ? yesShares / noShares : yesShares > 0 ? Infinity : 0;

    // 计算偏差百分比
    const avgShares = (yesShares + noShares) / 2;
    const deviation = avgShares > 0
      ? Math.abs(yesShares - noShares) / avgShares
      : 0;

    // 判断是否平衡
    const isBalanced = deviation <= this.config.tolerance;

    return {
      yesShares,
      noShares,
      ratio,
      isBalanced,
      deviation,
    };
  }

  /**
   * 分析当前对冲状态并给出建议
   */
  analyzeHedgeState(market: Market, position: Position): {
    ratio: HedgeRatio;
    action: HedgeAction;
    canPlaceOrders: boolean;
  } {
    const ratio = this.calculateHedgeRatio(position);

    // 检查是否有足够的持仓
    const hasPosition = ratio.yesShares >= this.config.minHedgeSize ||
                       ratio.noShares >= this.config.minHedgeSize;

    if (!hasPosition) {
      return {
        ratio,
        action: {
          needsRebalance: false,
          side: 'NONE',
          shares: 0,
          reason: `Position too small (YES=${ratio.yesShares}, NO=${ratio.noShares}), need ${this.config.minHedgeSize}+`,
        },
        canPlaceOrders: false,
      };
    }

    // 检查是否需要平衡
    let action: HedgeAction;
    if (ratio.isBalanced) {
      // 已经平衡，可以正常做市
      action = {
        needsRebalance: false,
        side: 'NONE',
        shares: 0,
        reason: `Hedge balanced (YES=${ratio.yesShares}, NO=${ratio.noShares}, deviation=${(ratio.deviation * 100).toFixed(1)}%)`,
      };
    } else if (this.config.autoBalance) {
      // 需要平衡 - 关键改变：买入对边，而不是卖出多余边
      const missingShares = Math.abs(ratio.yesShares - ratio.noShares);

      if (ratio.yesShares > ratio.noShares) {
        // YES 过多（被吃了 YES 卖单）→ 买入 NO 对冲
        action = {
          needsRebalance: true,
          side: 'BUY_NO',
          shares: missingShares,
          reason: `YES order filled (${ratio.yesShares} YES), buy ${missingShares} NO to hedge`,
        };
      } else {
        // NO 过多（被吃了 NO 卖单）→ 买入 YES 对冲
        action = {
          needsRebalance: true,
          side: 'BUY_YES',
          shares: missingShares,
          reason: `NO order filled (${ratio.noShares} NO), buy ${missingShares} YES to hedge`,
        };
      }
    } else {
      // 不自动平衡，但警告
      action = {
        needsRebalance: false,
        side: 'NONE',
        shares: 0,
        reason: `Hedge unbalanced (deviation=${(ratio.deviation * 100).toFixed(1)}%), but auto-balance disabled`,
      };
    }

    // 只有平衡状态下才允许挂单
    const canPlaceOrders = !action.needsRebalance;

    return {
      ratio,
      action,
      canPlaceOrders,
    };
  }

  /**
   * 建议双边挂单价格
   *
   * 策略：
   * - 同时挂 YES 和 NO 的卖单（价格较高，不易被吃）
   * - 如果 YES 卖单被吃 → 被迫买入 YES → 立即市价买入 NO 对冲
   * - 如果 NO 卖单被吃 → 被迫买入 NO → 立即市价买入 YES 对冲
   */
  suggestQuotePrices(
    yesPrice: number,
    noPrice: number,
    spreadBps: number = 150  // 默认 1.5% 价差
  ): {
    yesAsk: number;
    noAsk: number;
    spreadBps: number;
  } {
    const spread = spreadBps / 10000;

    // 卖单价 = 市场价 × (1 + 价差)
    const yesAsk = Math.min(0.99, yesPrice * (1 + spread));
    const noAsk = Math.min(0.99, noPrice * (1 + spread));

    return {
      yesAsk,
      noAsk,
      spreadBps,
    };
  }

  /**
   * 计算最优对冲规模
   *
   * 根据当前持仓和市场条件，建议应该持有的对冲规模
   */
  calculateOptimalHedgeSize(
    position: Position,
    marketLiquidity: number,
    targetRatio: number = 0.5  // 目标持仓占总资金的比例
  ): number {
    const currentValue = position.total_value;

    // 目标对冲价值
    const targetValue = currentValue * targetRatio;

    // 根据当前价格计算股数
    const currentPrice = position.current_price;
    const targetShares = targetValue / currentPrice;

    // 限制在最小和最大之间
    const clampedShares = Math.max(
      this.config.minHedgeSize,
      Math.min(this.config.maxHedgeSize, targetShares)
    );

    return Math.floor(clampedShares);
  }

  /**
   * 验证对冲是否真的完美
   * 检查 YES + NO 是否真的接近 1
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
      quality = 'EXCELLENT';  // ≤1% 偏差
    } else if (deviation <= 0.03) {
      quality = 'GOOD';       // ≤3% 偏差
    } else if (deviation <= 0.05) {
      quality = 'FAIR';       // ≤5% 偏差
    } else {
      quality = 'POOR';       // >5% 偏差
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
  getConfig(): PerfectHedgeConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<PerfectHedgeConfig>): void {
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
 * 全局单例（可选）
 */
export const perfectHedgeStrategy = new PerfectHedgeStrategy();
