/**
 * 🎯 机会质量过滤系统
 *
 * 在执行套利前进行多维度质量检查，过滤掉低质量机会
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { OrderBook } from './types.js';

/**
 * 机会质量评级
 */
export enum OpportunityQuality {
  EXCELLENT = 'excellent',  // 优秀 - 立即执行
  GOOD = 'good',            // 良好 - 可以执行
  FAIR = 'fair',            // 一般 - 谨慎执行
  POOR = 'poor',            // 较差 - 不建议执行
  SKIP = 'skip'             // 跳过 - 不执行
}

/**
 * 机会评分结果
 */
export interface OpportunityScore {
  quality: OpportunityQuality;
  score: number;            // 0-100
  confidence: number;       // 0-1

  // 评分详情
  details: {
    profitPotential: number;    // 利润潜力 0-100
    riskLevel: number;          // 风险水平 0-100 (越低越好)
    liquidity: number;          // 流动性评分 0-100
    priceQuality: number;       // 价格质量 0-100
    timingScore: number;        // 时机评分 0-100
  };

  // 风险警告
  warnings: string[];

  // 建议
  recommendation: {
    shouldExecute: boolean;
    reason: string;
    suggestedPositionSize: number;  // 建议仓位 0-1
  };
}

/**
 * 机会过滤配置
 */
export interface OpportunityFilterConfig {
  // 最低要求
  minProfitPercent: number;        // 最低利润百分比
  minLiquidityUsd: number;         // 最低流动性（美元）
  minOrderBookDepth: number;       // 最低订单簿深度
  maxPriceSpread: number;          // 最大价格买卖差

  // 风险控制
  maxSlippagePercent: number;      // 最大滑点
  maxExposurePerMarket: number;    // 单市场最大敞口
  maxTotalExposure: number;        // 总最大敞口

  // 质量阈值
  minQualityScore: number;         // 最低质量分数
  requireCounterParty: boolean;    // 要求有对手方
  requireMinAgeSeconds: number;    // 市场最少存在时间

  // 过滤规则
  filterIlliquidMarkets: boolean;  // 过滤低流动性市场
  filterNewMarkets: boolean;       // 过滤新市场
  filterVolatileMarkets: boolean;  // 过滤高波动市场
  filterLowProfit: boolean;        // 过滤低利润机会
}

/**
 * 默认配置（保守）
 */
const DEFAULT_CONSERVATIVE_CONFIG: OpportunityFilterConfig = {
  // 最低要求 - 保守设置
  minProfitPercent: 2.0,           // 至少2%利润
  minLiquidityUsd: 5000,           // 至少$5000流动性
  minOrderBookDepth: 1000,         // 至少$1000订单簿深度
  maxPriceSpread: 0.05,            // 最大5%买卖差

  // 风险控制 - 保守
  maxSlippagePercent: 1.0,         // 最大1%滑点
  maxExposurePerMarket: 0.1,       // 单市场最多10%资金
  maxTotalExposure: 0.3,           // 总最多30%资金

  // 质量阈值
  minQualityScore: 70,             // 最低70分
  requireCounterParty: true,       // 要求有对手方
  requireMinAgeSeconds: 3600,      // 市场至少存在1小时

  // 过滤规则 - 全部启用
  filterIlliquidMarkets: true,
  filterNewMarkets: true,
  filterVolatileMarkets: true,
  filterLowProfit: true,
};

/**
 * 默认配置（激进）
 */
const DEFAULT_AGGRESSIVE_CONFIG: OpportunityFilterConfig = {
  // 最低要求 - 激进设置
  minProfitPercent: 0.5,           // 至少0.5%利润
  minLiquidityUsd: 1000,           // 至少$1000流动性
  minOrderBookDepth: 500,          // 至少$500订单簿深度
  maxPriceSpread: 0.10,            // 最大10%买卖差

  // 风险控制 - 激进
  maxSlippagePercent: 2.0,         // 最大2%滑点
  maxExposurePerMarket: 0.2,       // 单市场最多20%资金
  maxTotalExposure: 0.5,           // 总最多50%资金

  // 质量阈值
  minQualityScore: 50,             // 最低50分
  requireCounterParty: true,       // 要求有对手方
  requireMinAgeSeconds: 600,       // 市场至少存在10分钟

  // 过滤规则 - 大部分启用
  filterIlliquidMarkets: true,
  filterNewMarkets: false,
  filterVolatileMarkets: false,
  filterLowProfit: true,
};

/**
 * 机会过滤器
 */
export class OpportunityFilter {
  private config: OpportunityFilterConfig;
  private marketHistory = new Map<string, any[]>();

  constructor(config: Partial<OpportunityFilterConfig> = {}, mode: 'conservative' | 'aggressive' = 'conservative') {
    const baseConfig = mode === 'conservative'
      ? DEFAULT_CONSERVATIVE_CONFIG
      : DEFAULT_AGGRESSIVE_CONFIG;

    this.config = { ...baseConfig, ...config };
  }

  /**
   * 评估套利机会
   */
  async evaluateOpportunity(params: {
    marketId: string;
    marketTitle: string;
    outcomes: any[];
    orderBooks: Map<string, OrderBook>;
    profitPercent: number;
    estimatedProfitUsd: number;
    requiredCapital: number;
    marketCreatedAt?: number;
  }): Promise<OpportunityScore> {
    const {
      marketId,
      marketTitle,
      outcomes,
      orderBooks,
      profitPercent,
      estimatedProfitUsd,
      requiredCapital,
      marketCreatedAt
    } = params;

    const warnings: string[] = [];

    // 1. 利润潜力评估 (0-100)
    const profitPotential = this.assessProfitPotential(profitPercent, estimatedProfitUsd);

    // 2. 风险水平评估 (0-100, 越低越好)
    const riskLevel = await this.assessRiskLevel(outcomes, orderBooks, marketCreatedAt, warnings);

    // 3. 流动性评估 (0-100)
    const liquidity = this.assessLiquidity(orderBooks, warnings);

    // 4. 价格质量评估 (0-100)
    const priceQuality = this.assessPriceQuality(orderBooks, warnings);

    // 5. 时机评分 (0-100)
    const timingScore = this.assessTiming(marketId, marketCreatedAt);

    // 综合评分 (加权平均)
    const score = this.calculateWeightedScore({
      profitPotential,
      riskLevel: 100 - riskLevel, // 转换为正向指标
      liquidity,
      priceQuality,
      timingScore
    });

    // 质量等级
    const quality = this.determineQuality(score);

    // 置信度（基于数据完整性和历史表现）
    const confidence = this.calculateConfidence(orderBooks, marketId);

    // 生成建议
    const recommendation = this.generateRecommendation(
      quality,
      score,
      profitPercent,
      requiredCapital,
      warnings
    );

    return {
      quality,
      score,
      confidence,
      details: {
        profitPotential,
        riskLevel,
        liquidity,
        priceQuality,
        timingScore
      },
      warnings,
      recommendation
    };
  }

  /**
   * 利润潜力评估
   */
  private assessProfitPotential(profitPercent: number, estimatedProfitUsd: number): number {
    let score = 0;

    // 利润率评分 (0-60分)
    if (profitPercent >= 5.0) {
      score += 60;
    } else if (profitPercent >= 3.0) {
      score += 50;
    } else if (profitPercent >= 2.0) {
      score += 40;
    } else if (profitPercent >= 1.0) {
      score += 30;
    } else if (profitPercent >= 0.5) {
      score += 20;
    } else {
      score += 10;
    }

    // 绝对利润评分 (0-40分)
    if (estimatedProfitUsd >= 100) {
      score += 40;
    } else if (estimatedProfitUsd >= 50) {
      score += 30;
    } else if (estimatedProfitUsd >= 20) {
      score += 20;
    } else if (estimatedProfitUsd >= 10) {
      score += 10;
    }

    return Math.min(100, score);
  }

  /**
   * 风险水平评估
   */
  private async assessRiskLevel(
    outcomes: any[],
    orderBooks: Map<string, OrderBook>,
    marketCreatedAt: number | undefined,
    warnings: string[]
  ): Promise<number> {
    let riskScore = 0;

    // 1. 市场年龄风险
    if (marketCreatedAt) {
      const age = Date.now() - marketCreatedAt;
      const ageMinutes = age / (1000 * 60);

      if (ageMinutes < 10) {
        riskScore += 30;
        warnings.push('⚠️ 市场很新，可能不稳定');
      } else if (ageMinutes < 60) {
        riskScore += 15;
      }
    }

    // 2. 流动性风险
    let totalLiquidity = 0;
    for (const [tokenId, orderBook] of orderBooks) {
      totalLiquidity += (orderBook.bids[0]?.amount || 0) + (orderBook.asks[0]?.amount || 0);
    }

    if (totalLiquidity < 500) {
      riskScore += 30;
      warnings.push('⚠️ 流动性很低，可能无法成交');
    } else if (totalLiquidity < 1000) {
      riskScore += 15;
    }

    // 3. 价格平衡风险
    let imbalanceCount = 0;
    for (const [tokenId, orderBook] of orderBooks) {
      const bidVolume = orderBook.bids[0]?.amount || 0;
      const askVolume = orderBook.asks[0]?.amount || 0;

      if (bidVolume === 0 || askVolume === 0) {
        imbalanceCount++;
      }
    }

    if (imbalanceCount > 0) {
      riskScore += imbalanceCount * 10;
      warnings.push(`⚠️ ${imbalanceCount}个选项缺乏买一或卖一`);
    }

    // 4. 选项数量风险
    if (outcomes.length < 2) {
      riskScore += 20;
      warnings.push('⚠️ 选项太少，可能无法对冲');
    }

    return Math.min(100, riskScore);
  }

  /**
   * 流动性评估
   */
  private assessLiquidity(orderBooks: Map<string, OrderBook>, warnings: string[]): number {
    let totalScore = 0;
    let count = 0;

    for (const [tokenId, orderBook] of orderBooks) {
      // 买一量评分
      const bidAmount = orderBook.bids[0]?.amount || 0;
      // 卖一量评分
      const askAmount = orderBook.asks[0]?.amount || 0;

      // 买一评分
      let bidScore = 0;
      if (bidAmount >= 10000) {
        bidScore = 100;
      } else if (bidAmount >= 5000) {
        bidScore = 80;
      } else if (bidAmount >= 1000) {
        bidScore = 60;
      } else if (bidAmount >= 500) {
        bidScore = 40;
      } else if (bidAmount >= 100) {
        bidScore = 20;
      }

      // 卖一评分
      let askScore = 0;
      if (askAmount >= 10000) {
        askScore = 100;
      } else if (askAmount >= 5000) {
        askScore = 80;
      } else if (askAmount >= 1000) {
        askScore = 60;
      } else if (askAmount >= 500) {
        askScore = 40;
      } else if (askAmount >= 100) {
        askScore = 20;
      }

      totalScore += (bidScore + askScore) / 2;
      count++;

      if (bidAmount < 100 || askAmount < 100) {
        warnings.push(`⚠️ ${tokenId}流动性不足`);
      }
    }

    return count > 0 ? totalScore / count : 0;
  }

  /**
   * 价格质量评估
   */
  private assessPriceQuality(orderBooks: Map<string, OrderBook>, warnings: string[]): number {
    let totalScore = 0;
    let count = 0;

    for (const [tokenId, orderBook] of orderBooks) {
      const bestBid = orderBook.bids[0]?.price || 0;
      const bestAsk = orderBook.asks[0]?.price || 0;

      if (bestBid === 0 || bestAsk === 0) {
        count++;
        continue;
      }

      // 买卖价差评分
      const spread = bestAsk - bestBid;
      const spreadPercent = (spread / bestBid) * 100;

      let spreadScore = 100;
      if (spreadPercent > 10) {
        spreadScore = 20;
        warnings.push(`⚠️ ${tokenId}买卖价差过大: ${spreadPercent.toFixed(1)}%`);
      } else if (spreadPercent > 5) {
        spreadScore = 40;
      } else if (spreadPercent > 2) {
        spreadScore = 60;
      } else if (spreadPercent > 1) {
        spreadScore = 80;
      }

      // 价格合理性评分（0.01-0.99范围内）
      let rangeScore = 100;
      if (bestBid < 0.01 || bestAsk > 0.99) {
        rangeScore = 50;
        warnings.push(`⚠️ ${tokenId}价格超出合理范围`);
      }

      totalScore += (spreadScore + rangeScore) / 2;
      count++;
    }

    return count > 0 ? totalScore / count : 0;
  }

  /**
   * 时机评分
   */
  private assessTiming(marketId: string, marketCreatedAt?: number): number {
    // 基于历史数据评估时机
    const history = this.marketHistory.get(marketId) || [];

    if (history.length === 0) {
      return 50; // 中性评分
    }

    // 检查最近的表现
    const recentHistory = history.slice(-10);
    const successCount = recentHistory.filter(h => h.success).length;
    const successRate = successCount / recentHistory.length;

    return successRate * 100;
  }

  /**
   * 计算加权分数
   */
  private calculateWeightedScore(scores: {
    profitPotential: number;
    riskLevel: number;
    liquidity: number;
    priceQuality: number;
    timingScore: number;
  }): number {
    // 权重分配
    const weights = {
      profitPotential: 0.30,  // 30%
      riskLevel: 0.25,        // 25%
      liquidity: 0.20,        // 20%
      priceQuality: 0.15,     // 15%
      timingScore: 0.10       // 10%
    };

    return (
      scores.profitPotential * weights.profitPotential +
      scores.riskLevel * weights.riskLevel +
      scores.liquidity * weights.liquidity +
      scores.priceQuality * weights.priceQuality +
      scores.timingScore * weights.timingScore
    );
  }

  /**
   * 确定质量等级
   */
  private determineQuality(score: number): OpportunityQuality {
    if (score >= 90) return OpportunityQuality.EXCELLENT;
    if (score >= 75) return OpportunityQuality.GOOD;
    if (score >= 60) return OpportunityQuality.FAIR;
    if (score >= 40) return OpportunityQuality.POOR;
    return OpportunityQuality.SKIP;
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(orderBooks: Map<string, OrderBook>, marketId: string): number {
    let confidence = 0.5; // 基础50%

    // 有完整订单簿数据
    if (orderBooks.size > 0) {
      confidence += 0.2;
    }

    // 有历史数据
    const history = this.marketHistory.get(marketId);
    if (history && history.length > 0) {
      confidence += 0.1;
    }

    // 订单簿深度充足
    let totalDepth = 0;
    for (const orderBook of orderBooks.values()) {
      totalDepth += orderBook.bids.length + orderBook.asks.length;
    }
    if (totalDepth > 20) {
      confidence += 0.2;
    }

    return Math.min(1.0, confidence);
  }

  /**
   * 生成建议
   */
  private generateRecommendation(
    quality: OpportunityQuality,
    score: number,
    profitPercent: number,
    requiredCapital: number,
    warnings: string[]
  ): OpportunityScore['recommendation'] {
    let shouldExecute = false;
    let reason = '';
    let suggestedPositionSize = 0;

    switch (quality) {
      case OpportunityQuality.EXCELLENT:
        shouldExecute = true;
        suggestedPositionSize = 0.2; // 20%仓位
        reason = '✅ 优秀机会，建议立即执行';
        break;

      case OpportunityQuality.GOOD:
        shouldExecute = true;
        suggestedPositionSize = 0.15; // 15%仓位
        reason = '✅ 良好机会，可以执行';
        break;

      case OpportunityQuality.FAIR:
        shouldExecute = warnings.length < 3;
        suggestedPositionSize = 0.1; // 10%仓位
        reason = warnings.length < 3
          ? '⚠️ 一般机会，谨慎执行'
          : '❌ 风险较多，建议跳过';
        break;

      case OpportunityQuality.POOR:
        shouldExecute = false;
        suggestedPositionSize = 0;
        reason = '❌ 质量较差，不建议执行';
        break;

      case OpportunityQuality.SKIP:
        shouldExecute = false;
        suggestedPositionSize = 0;
        reason = '❌ 不符合执行条件';
        break;
    }

    // 根据利润率调整仓位
    if (profitPercent > 5.0 && shouldExecute) {
      suggestedPositionSize = Math.min(0.3, suggestedPositionSize * 1.5);
    } else if (profitPercent < 1.0 && shouldExecute) {
      suggestedPositionSize *= 0.5;
    }

    return {
      shouldExecute,
      reason,
      suggestedPositionSize
    };
  }

  /**
   * 更新历史记录
   */
  updateHistory(marketId: string, result: { success: boolean; profit: number; actualSlippage?: number }): void {
    if (!this.marketHistory.has(marketId)) {
      this.marketHistory.set(marketId, []);
    }

    const history = this.marketHistory.get(marketId)!;
    history.push({
      timestamp: Date.now(),
      ...result
    });

    // 只保留最近100条记录
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * 获取市场统计
   */
  getMarketStats(marketId: string): {
    totalAttempts: number;
    successRate: number;
    totalProfit: number;
    avgProfit: number;
  } | null {
    const history = this.marketHistory.get(marketId);
    if (!history || history.length === 0) {
      return null;
    }

    const totalAttempts = history.length;
    const successCount = history.filter(h => h.success).length;
    const successRate = successCount / totalAttempts;
    const totalProfit = history.reduce((sum, h) => sum + h.profit, 0);
    const avgProfit = totalProfit / totalAttempts;

    return {
      totalAttempts,
      successRate,
      totalProfit,
      avgProfit
    };
  }

  /**
   * 导出配置
   */
  exportConfig(): OpportunityFilterConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<OpportunityFilterConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

/**
 * 便捷函数：创建保守过滤器
 */
export function createConservativeFilter(): OpportunityFilter {
  return new OpportunityFilter({}, 'conservative');
}

/**
 * 便捷函数：创建激进过滤器
 */
export function createAggressiveFilter(): OpportunityFilter {
  return new OpportunityFilter({}, 'aggressive');
}
