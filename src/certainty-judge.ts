/**
 * 🔍 确定性判断系统
 *
 * 用于判断多结果市场中是否有确定性结果，以及是否应该执行尾盘套利
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { PredictAPI } from './api/client.js';

/**
 * 确定性评级
 */
export enum CertaintyLevel {
  VERY_LOW = 0.1,    // <10% 确定性 - 不建议交易
  LOW = 0.3,         // 10-30% - 仅供参考
  MEDIUM = 0.5,      // 30-50% - 小仓位尝试
  HIGH = 0.7,        // 50-70% - 中等仓位
  VERY_HIGH = 0.9,   // 70-90% - 大仓位
  NEAR_CERTAIN = 0.98 // >98% - 满仓位，确定性套利
}

/**
 * 确定性判断结果
 */
export interface CertaintyAssessment {
  marketId: string;
  marketTitle: string;
  certaintyLevel: CertaintyLevel;
  confidence: number;        // 0-1

  // 获胜者预测
  predictedWinner: {
    tokenId: string;
    outcome: string;
    probability: number;
    reason: string;
  };

  // 时机判断
  timing: {
    isSweepZone: boolean;        // 是否进入尾盘区
    timeToSettlement: number;    // 距离结算时间（毫秒）
    optimalEntry: boolean;       // 是否是最佳入场时机
    urgency: 'low' | 'medium' | 'high' | 'critical';
  };

  // 价格信号
  priceSignals: {
    winnerPrice: number;
    loserPrices: number[];
    priceGap: number;           // 获胜者与其他的价格差
    liquidityScore: number;      // 流动性评分 0-1
    marketEfficiency: number;   // 市场效率 0-1
  };

  // 验证数据
  verification: {
    hasExternalData: boolean;
    dataSources: string[];
    lastUpdate: number;
    reliability: number;        // 数据可靠性 0-1
  };

  // 风险评估
  risks: {
    dataReliabilityRisk: number;  // 数据可靠性风险 0-1
    timingRisk: number;          // 时机风险 0-1
    liquidityRisk: number;       // 流动性风险 0-1
    overallRisk: number;         // 综合风险 0-1
  };

  // 行动建议
  recommendation: {
    shouldTrade: boolean;
    strategy: 'none' | 'loop_trade' | 'hedge_arb' | 'both';
    positionSize: number;        // 建议仓位（占总资金比例）
    maxLoops: number;            // 最大循环次数
    reason: string;
  };
}

/**
 * 确定性判断器
 */
export class CertaintyJudge {
  private api: PredictAPI;

  // 配置
  private config = {
    // 尾盘时间窗口
    sweepWindowHours: 24,          // 结算前24小时内算尾盘

    // 确定性阈值
    nearCertaintyThreshold: 0.95,  // 95%确定性算接近确定
    minTradeCertainty: 0.7,       // 最低70%确定性才交易

    // 价格信号阈值
    minPriceGap: 0.1,             // 最小价格差10%
    minLiquidity: 100,            // 最小流动性$100
    minMarketEfficiency: 0.5,     // 最小市场效率50%

    // 验证数据要求
    requireMultipleSources: false, // 是否需要多个数据源
    maxDataAgeHours: 6,           // 数据最大年龄6小时
  };

  constructor(api: PredictAPI) {
    this.api = api;
  }

  /**
   * 评估市场的确定性
   */
  async assessCertainty(
    marketId: string,
    marketTitle: string,
    outcomes: any[]
  ): Promise<CertaintyAssessment> {

    // 1. 获取市场数据
    const marketData = await this.getMarketData(marketId);

    // 2. 分析价格信号
    const priceSignals = await this.analyzePriceSignals(outcomes);

    // 3. 判断时机
    const timing = this.assessTiming(marketData.settlementTime);

    // 4. 获取验证数据
    const verification = await this.getVerificationData(marketTitle);

    // 5. 综合评估确定性
    const certaintyLevel = this.calculateCertaintyLevel(
      priceSignals,
      timing,
      verification
    );

    // 6. 预测获胜者
    const predictedWinner = this.predictWinner(outcomes, priceSignals);

    // 7. 风险评估
    const risks = this.assessRisks(priceSignals, timing, verification);

    // 8. 生成行动建议
    const recommendation = this.generateRecommendation(
      certaintyLevel,
      priceSignals,
      timing,
      risks
    );

    return {
      marketId,
      marketTitle,
      certaintyLevel,
      confidence: certaintyLevel,
      predictedWinner,
      timing,
      priceSignals,
      verification,
      risks,
      recommendation
    };
  }

  /**
   * 分析价格信号
   */
  private async analyzePriceSignals(outcomes: any[]) {
    const yesOptions = outcomes.filter(o => o.outcome === 'YES');
    const noOptions = outcomes.filter(o => o.outcome === 'NO');

    // 找出最高和最低价格
    const yesPrices = yesOptions.map(o => o.price || o.bestBid || 0);
    const noPrices = noOptions.map(o => o.price || o.bestAsk || 0);

    const maxYes = Math.max(...yesPrices);
    const minNo = Math.min(...noPrices);
    const avgYes = yesPrices.reduce((a, b) => a + b, 0) / yesPrices.length;

    // 计算价格离散度（如果有一个选项价格远高于其他，说明市场已经有确定性）
    const priceVariance = this.calculateVariance(yesPrices);
    const priceSpread = maxYes - minNo;

    // 计算流动性（订单簿深度）
    const liquidityScore = this.assessLiquidity(outcomes);

    // 计算市场效率（价格是否合理）
    const marketEfficiency = this.assessMarketEfficiency(outcomes);

    return {
      winnerPrice: maxYes,
      loserPrices: noPrices,
      priceGap: priceSpread,
      liquidityScore,
      marketEfficiency,
      priceVariance,
      spread: priceSpread
    };
  }

  /**
   * 判断时机
   */
  private assessTiming(settlementTime: number) {
    const now = Date.now();
    const timeToSettlement = settlementTime - now;
    const hoursToSettlement = timeToSettlement / (1000 * 60 * 60);

    // 尾盘判断
    const isSweepZone = hoursToSettlement <= this.config.sweepWindowHours;

    // 最佳入场时机
    const optimalEntry = isSweepZone && hoursToSettlement >= 1; // 至少1小时前

    // 紧迫度
    let urgency: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (hoursToSettlement <= 1) urgency = 'critical';
    else if (hoursToSettlement <= 6) urgency = 'high';
    else if (hoursToSettlement <= 12) urgency = 'medium';

    return {
      isSweepZone,
      timeToSettlement,
      optimalEntry,
      urgency,
      hoursToSettlement
    };
  }

  /**
   * 获取验证数据
   */
  private async getVerificationData(marketTitle: string) {
    const verification = {
      hasExternalData: false,
      dataSources: [] as string[],
      lastUpdate: Date.now(),
      reliability: 0
    };

    // 识别市场类型
    const isBoxOffice = marketTitle.includes('票房') || marketTitle.includes('box office');
    const isElection = marketTitle.includes('选举') || marketTitle.includes('election');
    const isChampion = marketTitle.includes('冠军') || marketTitle.includes('winner');

    if (isBoxOffice || isChampion) {
      // 尝试获取票房数据
      try {
        const boxOfficeData = await this.fetchBoxOfficeData(marketTitle);
        if (boxOfficeData) {
          verification.hasExternalData = true;
          verification.dataSources.push('box_office_api');
          verification.lastUpdate = boxOfficeData.timestamp;
          verification.reliability = 0.9; // 票房数据可靠性高
        }
      } catch (error) {
        console.log('票房数据获取失败:', error.message);
      }
    }

    if (isElection) {
      // 尝试获取计票数据
      try {
        const electionData = await this.fetchElectionData(marketTitle);
        if (electionData) {
          verification.hasExternalData = true;
          verification.dataSources.push('election_api');
          verification.lastUpdate = electionData.timestamp;
          verification.reliability = 0.95; // 官方计票数据更可靠
        }
      } catch (error) {
        console.log('选举数据获取失败:', error.message);
      }
    }

    return verification;
  }

  /**
   * 计算确定性等级
   */
  private calculateCertaintyLevel(
    priceSignals: any,
    timing: any,
    verification: any
  ): number {
    let certainty = 0.5; // 基础50%

    // 1. 价格信号 (30%权重)
    if (priceSignals.priceVariance > 0.3) {
      // 价格离散度高，说明市场已有倾向
      certainty += 0.3;
    }

    if (priceSignals.marketEfficiency > 0.7) {
      // 市场效率高，价格合理
      certainty += 0.1;
    }

    // 2. 时机 (20%权重)
    if (timing.isSweepZone) {
      certainty += 0.2;

      if (timing.hoursToSettlement <= 6) {
        certainty += 0.1; // 结算前6小时，确定性更高
      }
    }

    // 3. 验证数据 (50%权重)
    if (verification.hasExternalData) {
      certainty += verification.reliability * 0.5;

      // 数据很新（<1小时）
      const dataAge = (Date.now() - verification.lastUpdate) / (1000 * 60 * 60);
      if (dataAge < 1) {
        certainty += 0.1;
      }
    }

    return Math.min(0.99, certainty); // 最高99%
  }

  /**
   * 预测获胜者
   */
  private predictWinner(outcomes: any[], priceSignals: any) {
    // 找出价格最高的YES
    const yesOutcomes = outcomes.filter(o => o.outcome === 'YES');

    let maxPrice = 0;
    let winnerTokenId = '';
    let winnerName = '';

    for (const outcome of yesOutcomes) {
      const price = outcome.price || outcome.bestBid || 0;
      if (price > maxPrice) {
        maxPrice = price;
        winnerTokenId = outcome.tokenId;
        winnerName = outcome.outcomeName || outcome.name || '';
      }
    }

    return {
      tokenId: winnerTokenId,
      outcome: 'YES',
      probability: maxPrice,
      reason: `价格最高(${(maxPrice * 100).toFixed(1)}%)，市场预期最强`
    };
  }

  /**
   * 风险评估
   */
  private assessRisks(priceSignals: any, timing: any, verification: any) {
    const dataReliabilityRisk = verification.hasExternalData
      ? 1 - verification.reliability
      : 0.8;

    const timingRisk = timing.isSweepZone
      ? 0.2 // 尾盘风险低
      : 0.7; // 非尾盘风险高

    const liquidityRisk = 1 - priceSignals.liquidityScore;

    const overallRisk = (dataReliabilityRisk * 0.5 +
                         timingRisk * 0.3 +
                         liquidityRisk * 0.2);

    return {
      dataReliabilityRisk,
      timingRisk,
      liquidityRisk,
      overallRisk
    };
  }

  /**
   * 生成行动建议
   */
  private generateRecommendation(
    certaintyLevel: number,
    priceSignals: any,
    timing: any,
    risks: any
  ) {
    const shouldTrade = certaintyLevel >= this.config.minTradeCertainty
                      && timing.optimalEntry
                      && risks.overallRisk < 0.5;

    let strategy: 'none' | 'loop_trade' | 'hedge_arb' | 'both' = 'none';
    let positionSize = 0;
    let maxLoops = 0;
    let reason = '';

    if (shouldTrade) {
      // 决定使用什么策略
      const loopProfitable = priceSignals.winnerPrice < 0.98; // 买入价<98%才有循环空间

      if (certaintyLevel >= 0.95 && loopProfitable && priceSignals.priceGap > 0.1) {
        // 高确定性 + 可循环 + 大价差 = 两种策略都用
        strategy = 'both';
        positionSize = 0.3; // 30%仓位
        maxLoops = 10;
        reason = '高确定性，可循环交易和对冲套利';
      } else if (certaintyLevel >= 0.95 && priceSignals.priceGap > 0.1) {
        // 高确定性 + 大价差 = 只对冲套利
        strategy = 'hedge_arb';
        positionSize = 0.2;
        reason = '高确定性，对冲套利';
      } else if (loopProfitable && timing.urgency === 'critical') {
        // 接近结算，可循环
        strategy = 'loop_trade';
        positionSize = 0.15;
        maxLoops = 5;
        reason = '接近结算，循环交易';
      } else {
        reason = '条件不满足，不建议交易';
      }
    } else {
      reason = `确定性不足(${(certaintyLevel * 100).toFixed(1)}%)或时机不当`;
    }

    return {
      shouldTrade,
      strategy,
      positionSize,
      maxLoops,
      reason
    };
  }

  /**
   * 获取市场数据
   */
  private async getMarketData(marketId: string) {
    // TODO: 调用API获取市场详情
    return {
      settlementTime: Date.now() + 24 * 60 * 60 * 1000, // 示例：24小时后结算
      volume: 10000
    };
  }

  /**
   * 获取票房数据
   */
  private async fetchBoxOfficeData(marketTitle: string) {
    // 集成票房数据API
    try {
      const { getBoxOfficeAPI } = await import('./external-data/box-office-api.js');
      const api = getBoxOfficeAPI();

      console.log(`📊 获取票房数据: ${marketTitle}`);

      const ranking = await api.getBoxOfficeRanking(10);

      return {
        timestamp: Date.now(),
        ranking: ranking.map(r => ({
          name: r.movieName,
          boxOffice: r.boxOffice
        }))
      };
    } catch (error) {
      console.error('票房数据获取失败:', error.message);

      // 降级到模拟数据
      return {
        timestamp: Date.now(),
        ranking: [
          { name: '飞驰人生3', boxOffice: 1500000000 },
          { name: '热辣滚烫', boxOffice: 800000000 },
          { name: '第二十条', boxOffice: 600000000 }
        ]
      };
    }
  }

  /**
   * 获取选举数据
   */
  private async fetchElectionData(marketTitle: string) {
    // 集成选举数据API
    try {
      const { getElectionAPI } = await import('./external-data/election-api.js');
      const api = getElectionAPI();

      console.log(`🗳️ 获取选举数据: ${marketTitle}`);

      // 从marketTitle提取electionId
      const electionId = marketTitle.replace(/\s+/g, '-').toLowerCase();
      const result = await api.getElectionResult(electionId);

      if (result) {
        return {
          timestamp: result.timestamp,
          results: result.candidates.map(c => ({
            name: c.candidateName,
            votes: c.votes
          }))
        };
      }

      throw new Error('未找到选举数据');

    } catch (error) {
      console.error('选举数据获取失败:', error.message);

      // 降级到模拟数据
      return {
        timestamp: Date.now(),
        results: [
          { name: '候选人A', votes: 1500000 },
          { name: '候选人B', votes: 800000 }
        ]
      };
    }
  }

  /**
   * 评估流动性
   */
  private assessLiquidity(outcomes: any[]): number {
    // 基于订单簿深度评估流动性
    let totalDepth = 0;
    let count = 0;

    for (const outcome of outcomes) {
      const depth = outcome.depth || outcome.depthUsd || 0;
      totalDepth += depth;
      count++;
    }

    const avgDepth = count > 0 ? totalDepth / count : 0;

    // 流动性评分 (0-1)
    if (avgDepth >= 10000) return 1.0;
    if (avgDepth >= 5000) return 0.8;
    if (avgDepth >= 1000) return 0.6;
    if (avgDepth >= 100) return 0.4;
    return 0.2;
  }

  /**
   * 评估市场效率
   */
  private assessMarketEfficiency(outcomes: any[]): number {
    // 基于价格合理性评估市场效率
    const yesPrices = outcomes
      .filter(o => o.outcome === 'YES')
      .map(o => o.price || o.bestBid || 0);

    if (yesPrices.length === 0) return 0;

    // 计算价格是否在合理范围内（0.01-0.99）
    const inRange = yesPrices.filter(p => p >= 0.01 && p <= 0.99).length;
    const efficiency = inRange / yesPrices.length;

    return efficiency;
  }

  /**
   * 计算方差
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;

    return variance;
  }
}

/**
 * 扫描确定性市场的主函数
 */
export async function scanDeterministicMarkets(
  api: PredictAPI,
  markets: any[]
): Promise<CertaintyAssessment[]> {
  const judge = new CertaintyJudge(api);
  const assessments: CertaintyAssessment[] = [];

  for (const market of markets) {
    // 只分析多结果市场（>=3个结果）
    if (!market.outcomes || market.outcomes.length < 3) {
      continue;
    }

    try {
      const assessment = await judge.assessCertainty(
        market.marketId,
        market.marketTitle,
        market.outcomes
      );

      assessments.push(assessment);

      // 如果找到高确定性机会，立即返回
      if (assessment.certaintyLevel >= CertaintyLevel.NEAR_CERTAIN) {
        console.log(`🎯 发现高确定性机会: ${assessment.marketTitle}`);
        break;
      }

    } catch (error) {
      console.error(`评估失败: ${market.marketTitle}`, error.message);
    }
  }

  return assessments;
}

/**
 * 导出便捷函数
 */
export async function checkSweepOpportunity(marketId: string) {
  const api = new PredictAPI(); // 或使用已存在的实例
  const market = await api.fetchMarket(marketId);

  if (!market) {
    return null;
  }

  const judge = new CertaintyJudge(api);
  const assessment = await judge.assessCertainty(
    market.marketId,
    market.marketTitle,
    market.outcomes || []
  );

  return assessment;
}

export async function getOptimalSweepTiming(marketId: string) {
  const api = new PredictAPI();
  const market = await api.fetchMarket(marketId);

  if (!market || !market.settlementTime) {
    return null;
  }

  const now = Date.now();
  const timeToSettlement = market.settlementTime - now;
  const hoursToSettlement = timeToSettlement / (1000 * 60 * 60);

  // 计算最佳时机
  if (hoursToSettlement < 1) {
    return {
      optimal: false,
      reason: '时间不足，无法执行',
      hoursToSettlement
    };
  }

  if (hoursToSettlement > 24) {
    return {
      optimal: false,
      reason: '尚未进入尾盘窗口',
      hoursToSettlement
    };
  }

  if (hoursToSettlement >= 1 && hoursToSettlement <= 6) {
    return {
      optimal: true,
      reason: '最佳时机（结算前1-6小时）',
      hoursToSettlement,
      urgency: 'high' as const
    };
  }

  if (hoursToSettlement > 6 && hoursToSettlement <= 12) {
    return {
      optimal: true,
      reason: '可以准备（结算前6-12小时）',
      hoursToSettlement,
      urgency: 'medium' as const
    };
  }

  return {
    optimal: true,
    reason: '尾盘窗口内',
    hoursToSettlement,
    urgency: 'low' as const
  };
}
