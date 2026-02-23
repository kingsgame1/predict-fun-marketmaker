/**
 * 🎯 Kelly准则仓位管理
 *
 * 基于Kelly准则动态调整仓位大小，最大化长期增长
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

/**
 * Kelly参数
 */
export interface KellyParams {
  winRate: number;        // 胜率 (0-1)
  avgWin: number;         // 平均盈利（百分比）
  avgLoss: number;        // 平均亏损（百分比）
  kellyFraction: number;  // Kelly分数（0-1，建议0.25-0.5）
}

/**
 * 仓位建议
 */
export interface PositionSizing {
  optimalKellyPercent: number;  // 最优Kelly百分比
  halfKellyPercent: number;     // 半Kelly百分比（推荐）
  quarterKellyPercent: number;  // 四分之一Kelly（保守）
  recommendedPercent: number;   // 推荐仓位
  reasoning: string;            // 原因说明
  riskLevel: 'aggressive' | 'moderate' | 'conservative';
}

/**
 * 交易历史记录
 */
export interface TradeRecord {
  profit: number;        // 盈亏（百分比）
  amount: number;        // 金额
  timestamp: number;
  strategy: string;
}

/**
 * Kelly准则计算器
 */
export class KellyCriterion {
  private tradeHistory: TradeRecord[] = [];
  private maxHistorySize = 100;

  /**
   * 计算Kelly准则
   */
  calculateKelly(winRate: number, avgWin: number, avgLoss: number): number {
    // Kelly公式: f = (bp - q) / b
    // 其中: b = 平均盈利/平均亏损 (赔率)
    //      p = 胜率
    //      q = 败率 = 1 - p

    if (avgLoss <= 0) {
      throw new Error('平均亏损必须大于0');
    }

    const odds = avgWin / avgLoss;  // 赔率
    const edge = (winRate * odds) - (1 - winRate);  // 优势

    const kelly = edge / odds;

    return Math.max(0, kelly);  // Kelly不能为负
  }

  /**
   * 根据历史数据计算Kelly
   */
  calculateFromHistory(trades: TradeRecord[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit < 0);

    const winRate = winningTrades.length / trades.length;
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.profit, 0) / winningTrades.length
      : 0;
    const avgLoss = losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0)) / losingTrades.length
      : 0.01;  // 避免除零

    return this.calculateKelly(winRate, avgWin, avgLoss);
  }

  /**
   * 获取仓位建议
   */
  getPositionSizing(params: KellyParams): PositionSizing {
    const optimalKelly = this.calculateKelly(
      params.winRate,
      params.avgWin,
      params.avgLoss
    );

    const halfKelly = optimalKelly * 0.5;
    const quarterKelly = optimalKelly * 0.25;

    // 根据Kelly分数选择推荐仓位
    let recommendedPercent: number;
    let riskLevel: 'aggressive' | 'moderate' | 'conservative';
    let reasoning: string;

    if (params.kellyFraction <= 0.25) {
      // 保守：使用四分之一Kelly
      recommendedPercent = quarterKelly;
      riskLevel = 'conservative';
      reasoning = '使用四分之一Kelly，最大化资本保值';
    } else if (params.kellyFraction <= 0.5) {
      // 适中：使用半Kelly（推荐）
      recommendedPercent = halfKelly;
      riskLevel = 'moderate';
      reasoning = '使用半Kelly，平衡增长和风险';
    } else {
      // 激进：使用全Kelly
      recommendedPercent = optimalKelly;
      riskLevel = 'aggressive';
      reasoning = '使用全Kelly，最大化增长（高风险）';
    }

    // 安全限制：单次仓位不超过30%
    recommendedPercent = Math.min(recommendedPercent, 0.3);

    return {
      optimalKellyPercent: optimalKelly,
      halfKellyPercent: halfKelly,
      quarterKellyPercent: quarterKelly,
      recommendedPercent,
      reasoning,
      riskLevel
    };
  }

  /**
   * 根据历史数据获取仓位建议
   */
  getPositionSizingFromHistory(kellyFraction: number = 0.5): PositionSizing {
    const kelly = this.calculateFromHistory(this.tradeHistory);

    const winningTrades = this.tradeHistory.filter(t => t.profit > 0);
    const losingTrades = this.tradeHistory.filter(t => t.profit < 0);

    const winRate = this.tradeHistory.length > 0
      ? winningTrades.length / this.tradeHistory.length
      : 0.5;
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.profit, 0) / winningTrades.length
      : 0.02;
    const avgLoss = losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0)) / losingTrades.length
      : 0.01;

    return this.getPositionSizing({
      winRate,
      avgWin,
      avgLoss,
      kellyFraction
    });
  }

  /**
   * 添加交易记录
   */
  addTradeRecord(record: TradeRecord): void {
    this.tradeHistory.push(record);

    // 限制历史大小
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.shift();
    }
  }

  /**
   * 获取历史统计
   */
  getHistoryStats(): {
    totalTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    totalReturn: number;
    sharpeRatio: number;
  } {
    if (this.tradeHistory.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        totalReturn: 0,
        sharpeRatio: 0
      };
    }

    const winningTrades = this.tradeHistory.filter(t => t.profit > 0);
    const losingTrades = this.tradeHistory.filter(t => t.profit < 0);

    const winRate = winningTrades.length / this.tradeHistory.length;
    const avgWin = winningTrades.reduce((sum, t) => sum + t.profit, 0) / winningTrades.length;
    const avgLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0)) / losingTrades.length;
    const totalReturn = this.tradeHistory.reduce((sum, t) => sum + t.profit, 0);

    // 计算夏普比率
    const returns = this.tradeHistory.map(t => t.profit);
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;

    return {
      totalTrades: this.tradeHistory.length,
      winRate,
      avgWin,
      avgLoss,
      totalReturn,
      sharpeRatio
    };
  }

  /**
   * 清空历史
   */
  clearHistory(): void {
    this.tradeHistory = [];
  }
}

/**
 * 全局Kelly实例
 */
let globalKelly: KellyCriterion | null = null;

/**
 * 获取全局Kelly实例
 */
export function getKellyCriterion(): KellyCriterion {
  if (!globalKelly) {
    globalKelly = new KellyCriterion();
  }
  return globalKelly;
}

/**
 * 便捷函数：计算仓位大小
 */
export function calculateOptimalPositionSize(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  kellyFraction: number = 0.5
): number {
  const kelly = getKellyCriterion();
  const sizing = kelly.getPositionSizing({
    winRate,
    avgWin,
    avgLoss,
    kellyFraction
  });

  return sizing.recommendedPercent;
}
