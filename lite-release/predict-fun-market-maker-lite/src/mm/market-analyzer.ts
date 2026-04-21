/**
 * 市场分析器 - 用于市场选择和推荐
 *
 * 功能：
 * - 计算 1% 差价内的流动性
 * - 分析市场评分和推荐配置
 * - 批量分析多个市场
 */

import type { Market, Orderbook, LiquidityActivation } from '../types.js';
import type { PredictAPI } from '../api/client.js';

/**
 * 流动性信息（指定价格范围内）
 */
export interface LiquidityInfo {
  bidShares: number;
  bidUsd: number;
  askShares: number;
  askUsd: number;
  totalShares: number;
  totalUsd: number;
}

/**
 * 市场分析结果
 */
export interface MarketAnalysis {
  // 基础信息
  market: Market;
  orderbook: Orderbook;

  // 评分信息
  overallScore: number;
  pointsScore?: number;
  priority: number;

  // 价差信息
  spread: number;
  spreadPct: number;
  spreadCents: number;
  midPrice: number;

  // 流动性信息（1% 范围内）
  liquidity1Pct: LiquidityInfo;

  // 订单簿深度信息
  depthTop3: {
    bidShares: number;
    bidUsd: number;
    askShares: number;
    askUsd: number;
    totalShares: number;
    totalUsd: number;
  };

  // 推荐配置
  recommended: {
    spread: number;
    spreadCents: number;
    orderSize: number;
    maxPosition: number;
    minShares: number;
    reasons: string[];
  };

  // 积分激活信息
  pointsEligible: boolean;
  pointsReason: string;

  // 交易量信息
  volume24h?: number;
  liquidity24h?: number;

  // 分析时间戳
  timestamp: number;
}

/**
 * 市场分析器配置
 */
export interface AnalyzerConfig {
  // 1% 流动性计算范围（默认 1%）
  liquidityRangePct?: number;
  // 深度计算层级（默认 3）
  depthLevels?: number;
  // 最小推荐价差（默认 1.5%）
  minRecommendedSpread?: number;
  // 最大推荐价差（默认 5%）
  maxRecommendedSpread?: number;
}

/**
 * 市场分析器类
 */
export class MarketAnalyzer {
  private api: PredictAPI;
  private config: AnalyzerConfig;

  constructor(api: PredictAPI, config: AnalyzerConfig = {}) {
    this.api = api;
    this.config = {
      liquidityRangePct: config.liquidityRangePct ?? 0.01,
      depthLevels: config.depthLevels ?? 3,
      minRecommendedSpread: config.minRecommendedSpread ?? 0.015,
      maxRecommendedSpread: config.maxRecommendedSpread ?? 0.05,
    };
  }

  /**
   * 计算指定价格范围内的流动性
   *
   * @param orderbook - 订单簿
   * @param midPrice - 中间价
   * @param rangePct - 价格范围（默认 0.01 = 1%）
   * @returns 流动性信息
   */
  calculateLiquidityWithinRange(
    orderbook: Orderbook,
    midPrice: number,
    rangePct: number = this.config.liquidityRangePct ?? 0.01
  ): LiquidityInfo {
    const priceRange = midPrice * rangePct;
    const lowerBound = midPrice - priceRange;
    const upperBound = midPrice + priceRange;

    let bidShares = 0;
    let bidUsd = 0;

    // 累计买单在范围内的流动性
    // bids 按价格降序排列，所以从最高价开始
    for (const bid of orderbook.bids) {
      const price = Number(bid.price);
      if (price < lowerBound) break; // 超出范围（价格太低）

      const shares = Number(bid.shares);
      bidShares += shares;
      bidUsd += shares * price;
    }

    let askShares = 0;
    let askUsd = 0;

    // 累计卖单在范围内的流动性
    // asks 按价格升序排列，所以从最低价开始
    for (const ask of orderbook.asks) {
      const price = Number(ask.price);
      if (price > upperBound) break; // 超出范围（价格太高）

      const shares = Number(ask.shares);
      askShares += shares;
      askUsd += shares * price;
    }

    return {
      bidShares,
      bidUsd,
      askShares,
      askUsd,
      totalShares: bidShares + askShares,
      totalUsd: bidUsd + askUsd,
    };
  }

  /**
   * 计算订单簿深度（Top N 层级）
   *
   * @param orderbook - 订单簿
   * @param levels - 层级数（默认 3）
   * @returns 深度信息
   */
  private calculateDepth(orderbook: Orderbook, levels: number = this.config.depthLevels ?? 3): {
    bidShares: number;
    bidUsd: number;
    askShares: number;
    askUsd: number;
    totalShares: number;
    totalUsd: number;
  } {
    const bids = orderbook.bids.slice(0, levels);
    const asks = orderbook.asks.slice(0, levels);

    let bidShares = 0;
    let bidUsd = 0;

    for (const bid of bids) {
      const shares = Number(bid.shares);
      const price = Number(bid.price);
      if (shares > 0 && Number.isFinite(price)) {
        bidShares += shares;
        bidUsd += shares * price;
      }
    }

    let askShares = 0;
    let askUsd = 0;

    for (const ask of asks) {
      const shares = Number(ask.shares);
      const price = Number(ask.price);
      if (shares > 0 && Number.isFinite(price)) {
        askShares += shares;
        askUsd += shares * price;
      }
    }

    return {
      bidShares,
      bidUsd,
      askShares,
      askUsd,
      totalShares: bidShares + askShares,
      totalUsd: bidUsd + askUsd,
    };
  }

  /**
   * 检查市场是否符合积分激活规则
   *
   * @param market - 市场信息
   * @param orderbook - 订单簿
   * @returns 是否符合积分规则及原因
   */
  private checkPointsEligibility(
    market: Market,
    orderbook: Orderbook
  ): { eligible: boolean; reason: string } {
    const rules = market.liquidity_activation;

    if (!rules || !rules.active) {
      return { eligible: false, reason: '积分未激活' };
    }

    const currentSpread = orderbook.spread ?? 0;
    const currentSpreadCents = currentSpread * 100;

    // 检查价差限制
    if (rules.max_spread_cents !== undefined && currentSpreadCents > rules.max_spread_cents) {
      return {
        eligible: false,
        reason: `价差过大 (${currentSpreadCents.toFixed(2)}¢ > ${rules.max_spread_cents}¢)`
      };
    }

    if (rules.max_spread !== undefined && currentSpread > rules.max_spread) {
      return {
        eligible: false,
        reason: `价差过大 (${(currentSpread * 100).toFixed(2)}% > ${(rules.max_spread * 100).toFixed(2)}%)`
      };
    }

    // 检查最小订单大小
    // 我们不检查具体订单大小，只检查市场是否有足够的流动性
    const liquidity = this.calculateLiquidityWithinRange(orderbook, orderbook.mid_price ?? 0.5);
    if (rules.min_shares !== undefined && liquidity.totalShares < rules.min_shares) {
      return {
        eligible: false,
        reason: `流动性不足 (${liquidity.totalShares.toFixed(0)} < ${rules.min_shares})`
      };
    }

    return { eligible: true, reason: '符合积分要求 ✓' };
  }

  /**
   * 生成推荐配置
   *
   * @param market - 市场信息
   * @param orderbook - 订单簿
   * @param liquidity1Pct - 1% 流动性信息
   * @param pointsEligible - 是否符合积分规则
   * @returns 推荐配置
   */
  private generateRecommendation(
    market: Market,
    orderbook: Orderbook,
    liquidity1Pct: LiquidityInfo,
    pointsEligible: boolean
  ): {
    spread: number;
    spreadCents: number;
    orderSize: number;
    maxPosition: number;
    minShares: number;
    reasons: string[];
  } {
    const reasons: string[] = [];
    const currentSpread = orderbook.spread_pct ?? 0;
    const midPrice = orderbook.mid_price ?? 0.5;

    // 推荐价差
    let recommendedSpread = currentSpread * 0.8; // 默认低于当前价差 20%
    const rules = market.liquidity_activation;

    if (pointsEligible && rules?.max_spread) {
      // 如果符合积分规则，使用积分允许的最大价差
      recommendedSpread = Math.min(recommendedSpread, rules.max_spread * 0.9);
      reasons.push(`价差符合积分要求 (<${(rules.max_spread * 100).toFixed(1)}%)`);
    } else if (pointsEligible && rules?.max_spread_cents) {
      // 使用美分单位的价差限制
      const maxSpreadCents = rules.max_spread_cents / 100;
      recommendedSpread = Math.min(recommendedSpread, maxSpreadCents * 0.9);
      reasons.push(`价差符合积分要求 (<${rules.max_spread_cents}¢)`);
    }

    // 确保在合理范围内
    recommendedSpread = Math.max(
      this.config.minRecommendedSpread ?? 0.015,
      Math.min(this.config.maxRecommendedSpread ?? 0.05, recommendedSpread)
    );

    // 推荐订单大小
    const liquidityScore = liquidity1Pct.totalUsd;
    let orderSize = 25; // 默认 $25

    if (liquidityScore >= 2000) {
      orderSize = 50;
      reasons.push('高流动性，建议大额订单 ($50)');
    } else if (liquidityScore >= 1000) {
      orderSize = 25;
      reasons.push('中等流动性，标准订单 ($25)');
    } else if (liquidityScore >= 500) {
      orderSize = 15;
      reasons.push('流动性较低，建议小额订单 ($15)');
    } else {
      orderSize = 10;
      reasons.push('低流动性，建议最小订单 ($10)');
    }

    // 推荐最大持仓
    const maxPosition = orderSize * 4; // 4 倍订单大小

    // 推荐最小股数
    let minShares = rules?.min_shares ?? 100;
    if (pointsEligible && minShares > 0) {
      reasons.push(`最小 ${minShares} shares (积分要求)`);
    } else {
      minShares = Math.ceil(orderSize / midPrice);
      reasons.push(`最小 ${minShares} shares (基于订单大小)`);
    }

    // 添加收益评估
    if (currentSpread >= 0.03) {
      reasons.push('价差较大，收益潜力高 ⭐⭐⭐⭐⭐');
    } else if (currentSpread >= 0.02) {
      reasons.push('价差适中，收益潜力良好 ⭐⭐⭐⭐');
    } else if (currentSpread >= 0.015) {
      reasons.push('价差较小，收益潜力一般 ⭐⭐⭐');
    } else {
      reasons.push('价差很小，收益潜力较低 ⭐⭐');
    }

    return {
      spread: recommendedSpread,
      spreadCents: recommendedSpread * 100,
      orderSize,
      maxPosition,
      minShares,
      reasons,
    };
  }

  /**
   * 分析单个市场
   *
   * @param market - 市场信息
   * @param orderbook - 订单簿
   * @param score - 市场评分（可选）
   * @returns 市场分析结果
   */
  analyzeMarket(
    market: Market,
    orderbook: Orderbook,
    score?: { overallScore: number; pointsScore?: number; priority: number }
  ): MarketAnalysis {
    // 计算价差信息
    const bestBid = orderbook.best_bid ?? 0;
    const bestAsk = orderbook.best_ask ?? 0;
    const midPrice = orderbook.mid_price ?? ((bestBid + bestAsk) / 2);
    const spread = orderbook.spread ?? (bestAsk - bestBid);
    const spreadPct = orderbook.spread_pct ?? (midPrice > 0 ? (spread / midPrice) : 0);
    const spreadCents = spread * 100;

    // 计算 1% 流动性
    const liquidity1Pct = this.calculateLiquidityWithinRange(orderbook, midPrice);

    // 计算深度
    const depthTop3 = this.calculateDepth(orderbook, 3);

    // 检查积分资格
    const pointsCheck = this.checkPointsEligibility(market, orderbook);

    // 生成推荐配置
    const recommended = this.generateRecommendation(
      market,
      orderbook,
      liquidity1Pct,
      pointsCheck.eligible
    );

    return {
      market,
      orderbook,

      // 评分
      overallScore: score?.overallScore ?? 0,
      pointsScore: score?.pointsScore,
      priority: score?.priority ?? 0,

      // 价差信息
      spread,
      spreadPct,
      spreadCents,
      midPrice,

      // 流动性信息
      liquidity1Pct,

      // 深度信息
      depthTop3,

      // 推荐配置
      recommended,

      // 积分信息
      pointsEligible: pointsCheck.eligible,
      pointsReason: pointsCheck.reason,

      // 交易量信息
      volume24h: market.volume_24h,
      liquidity24h: market.liquidity_24h,

      // 时间戳
      timestamp: Date.now(),
    };
  }

  /**
   * 批量分析市场
   *
   * @param markets - 市场列表
   * @param scores - 市场评分 Map（可选）
   * @returns 市场分析结果列表（已按评分降序排序）
   */
  async analyzeMarkets(
    markets: Market[],
    scores?: Map<string, { overallScore: number; pointsScore?: number; priority: number }>
  ): Promise<MarketAnalysis[]> {
    console.log(`⏳ 正在分析 ${markets.length} 个市场...\n`);

    const batchSize = 10; // 每批处理 10 个市场
    const analyses: MarketAnalysis[] = [];

    for (let i = 0; i < markets.length; i += batchSize) {
      const batch = markets.slice(i, i + batchSize);
      const batchPromises = batch.map(async (market) => {
        try {
          const orderbook = await this.api.getOrderbook(market.token_id);
          const score = scores?.get(market.token_id);
          return this.analyzeMarket(market, orderbook, score);
        } catch (error) {
          console.error(`❌ 分析市场 ${market.token_id.slice(0, 8)}... 失败:`, error);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result) {
          analyses.push(result);
        }
      }

      // 显示进度
      const progress = Math.min(i + batchSize, markets.length);
      console.log(`   进度: ${progress}/${markets.length} (${((progress / markets.length) * 100).toFixed(0)}%)`);
    }

    // 按评分降序排序
    analyses.sort((a, b) => {
      // 优先级：积分激活 > 综合评分 > 流动性
      if (a.pointsEligible && !b.pointsEligible) return -1;
      if (!a.pointsEligible && b.pointsEligible) return 1;

      if (Math.abs(b.overallScore - a.overallScore) > 0.01) {
        return b.overallScore - a.overallScore;
      }

      return b.liquidity1Pct.totalUsd - a.liquidity1Pct.totalUsd;
    });

    console.log(`\n✅ 分析完成！共 ${analyses.length} 个市场\n`);

    return analyses;
  }
}
