/**
 * Market Selector
 * 面向做市的市场推荐：优先真实可挂流动性、盘口连续性、双边对称性，
 * 对 Polymarket 额外叠加流动性激励（奖励速率、最小挂单、最大奖励价差）评估。
 */

import type { Market, Orderbook, OrderbookEntry } from './types.js';

export interface MarketScore {
  market: Market;
  score: number;
  reasons: string[];
}

export interface MarketSelectorOptions {
  polymarketRewardMinFitScore?: number;
  polymarketRewardMinDailyRate?: number;
  polymarketRewardRequireFit?: boolean;
  polymarketRewardRequireEnabled?: boolean;
  polymarketRewardCrowdingPenaltyStart?: number;
  polymarketRewardCrowdingPenaltyMax?: number;
}

interface LevelLiquidity {
  bid1: number;
  ask1: number;
  bid2: number;
  ask2: number;
  l1Usable: number;
  l2Usable: number;
  l1Total: number;
  l2Total: number;
}

interface PolymarketRewardProfile {
  enabled: boolean;
  acceptingOrders: boolean;
  minSize: number;
  maxSpread: number;
  dailyRate: number;
  hourlyRate: number;
  l1SizeFit: number;
  l2SizeFit: number;
  spreadFit: number;
  fitScore: number;
  bonus: number;
  crowdingMultiple: number;
  crowdingPenalty: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class MarketSelector {
  private minLiquidity: number;
  private minVolume24h: number;
  private maxSpread: number;
  private minOrders: number;
  private polymarketRewardMinFitScore: number;
  private polymarketRewardMinDailyRate: number;
  private polymarketRewardRequireFit: boolean;
  private polymarketRewardRequireEnabled: boolean;
  private polymarketRewardCrowdingPenaltyStart: number;
  private polymarketRewardCrowdingPenaltyMax: number;

  constructor(
    minLiquidity: number = 100,
    minVolume24h: number = 500,
    maxSpread: number = 0.15,
    minOrders: number = 3,
    options: MarketSelectorOptions = {}
  ) {
    this.minLiquidity = minLiquidity;
    this.minVolume24h = minVolume24h;
    this.maxSpread = maxSpread;
    this.minOrders = minOrders;
    this.polymarketRewardMinFitScore = options.polymarketRewardMinFitScore ?? 0.6;
    this.polymarketRewardMinDailyRate = options.polymarketRewardMinDailyRate ?? 0;
    this.polymarketRewardRequireFit = options.polymarketRewardRequireFit !== false;
    this.polymarketRewardRequireEnabled = options.polymarketRewardRequireEnabled === true;
    this.polymarketRewardCrowdingPenaltyStart = options.polymarketRewardCrowdingPenaltyStart ?? 4;
    this.polymarketRewardCrowdingPenaltyMax = options.polymarketRewardCrowdingPenaltyMax ?? 12;
  }

  selectMarkets(markets: Market[], orderbooks: Map<string, Orderbook>): MarketScore[] {
    const scoredMarkets: MarketScore[] = [];

    for (const market of markets) {
      const orderbook = orderbooks.get(market.token_id);
      if (!orderbook || !orderbook.mid_price) {
        continue;
      }

      const score = this.scoreMarket(market, orderbook);
      if (score.score > 0) {
        scoredMarkets.push(score);
      }
    }

    scoredMarkets.sort((a, b) => b.score - a.score);
    return scoredMarkets;
  }

  private scoreMarket(market: Market, orderbook: Orderbook): MarketScore {
    const reasons: string[] = [];
    const liquidity = Number(market.liquidity_24h || 0);
    const volume = Number(market.volume_24h || 0);
    const totalOrders = (orderbook.bids?.length || 0) + (orderbook.asks?.length || 0);
    const spreadPct = orderbook.spread_pct ?? 999;
    const levels = this.getLevelLiquidity(orderbook);
    const supportRatio = Math.min(this.getSupportRatio(orderbook, 'bids'), this.getSupportRatio(orderbook, 'asks'));
    const levelGap = Math.max(this.getLevelGap(orderbook, 'bids'), this.getLevelGap(orderbook, 'asks'));
    const symmetry = this.getBookSymmetry(orderbook);
    const mid = Number(orderbook.mid_price || 0);
    const rewardProfile = this.getPolymarketRewardProfile(market, orderbook);

    if (market.venue === 'polymarket' && market.polymarket_enable_order_book === false) {
      return { market, score: 0, reasons: ['Polymarket 市场未启用 orderbook'] };
    }
    if (market.polymarket_accepting_orders === false) {
      return { market, score: 0, reasons: ['Polymarket 市场当前不接受下单'] };
    }
    if (market.venue === 'polymarket') {
      if (this.polymarketRewardRequireEnabled && !rewardProfile.enabled) {
        return { market, score: 0, reasons: ['Polymarket 市场无流动性激励，不纳入当前策略'] };
      }
      if (rewardProfile.enabled && rewardProfile.dailyRate < this.polymarketRewardMinDailyRate) {
        return {
          market,
          score: 0,
          reasons: [`激励日速率不足: ${rewardProfile.dailyRate.toFixed(0)} < ${this.polymarketRewardMinDailyRate.toFixed(0)}`],
        };
      }
      if (rewardProfile.enabled && this.polymarketRewardRequireFit && rewardProfile.fitScore < this.polymarketRewardMinFitScore) {
        return {
          market,
          score: 0,
          reasons: [
            `激励适配度不足: ${(rewardProfile.fitScore * 100).toFixed(0)}% < ${(this.polymarketRewardMinFitScore * 100).toFixed(0)}%`,
          ],
        };
      }
    }
    if (liquidity < this.minLiquidity) {
      return { market, score: 0, reasons: [`流动性不足: $${liquidity.toFixed(0)} < $${this.minLiquidity}`] };
    }
    if (volume < this.minVolume24h) {
      return { market, score: 0, reasons: [`交易量不足: $${volume.toFixed(0)} < $${this.minVolume24h}`] };
    }
    if (totalOrders < this.minOrders) {
      return { market, score: 0, reasons: [`订单数不足: ${totalOrders} < ${this.minOrders}`] };
    }
    if (spreadPct > this.maxSpread * 100) {
      return { market, score: 0, reasons: [`价差过大: ${spreadPct.toFixed(2)}% > ${(this.maxSpread * 100).toFixed(2)}%`] };
    }
    if (levels.l1Usable <= 0) {
      return { market, score: 0, reasons: ['一档双边不完整，无法稳定挂单'] };
    }

    const liquidityScore = Math.log10(liquidity + 1) * 30;
    const volumeScore = Math.log10(volume + 1) * 14;
    const l1Score = Math.log10(levels.l1Usable + 1) * 14;
    const l2Score = levels.l2Usable > 0 ? Math.log10(levels.l2Usable + 1) * 12 : 0;
    const depthScore = Math.log10(levels.l1Total + levels.l2Total + 1) * 5;
    const spreadScore = Math.max(0, 14 * (1 - spreadPct / (this.maxSpread * 100)));
    const symmetryScore = symmetry * 8;
    const supportScore = Math.min(1, supportRatio) * 8;
    const centerScore = this.getCenterPriceScore(mid) * 6;
    const gapPenalty = levelGap > 0 ? Math.min(8, levelGap * 200) : 0;

    let score =
      liquidityScore +
      volumeScore +
      l1Score +
      l2Score +
      depthScore +
      spreadScore +
      symmetryScore +
      supportScore +
      centerScore -
      gapPenalty;

    const highLiquidityOverride = liquidity >= Math.max(this.minLiquidity * 20, 5000);

    if (levels.l2Usable <= 0) {
      score *= highLiquidityOverride ? 0.95 : 0.88;
      reasons.push(highLiquidityOverride ? '二档缺失，但总体流动性高，轻度降权' : '二档双边不完整，明显降权');
    } else if (levels.l2Usable < levels.l1Usable * 0.15) {
      score *= highLiquidityOverride ? 0.97 : 0.92;
      reasons.push('二档覆盖偏薄，降权');
    } else if (levels.l2Usable >= levels.l1Usable * 0.5) {
      score += 4;
      reasons.push('二档覆盖充足，加分');
    }

    if (supportRatio < 0.2) {
      score *= 0.9;
      reasons.push('二档支撑率偏弱，降权');
    }
    if (symmetry < 0.35) {
      score *= 0.92;
      reasons.push('盘口双边不对称，降权');
    }

    if (rewardProfile.enabled) {
      score += rewardProfile.bonus;
      reasons.push(`激励日速率: ${rewardProfile.dailyRate.toFixed(0)}`);
      reasons.push(`激励门槛: ${rewardProfile.minSize.toFixed(0)} 股 / ${(rewardProfile.maxSpread * 100).toFixed(2)}¢`);
      reasons.push(`激励适配度: ${(rewardProfile.fitScore * 100).toFixed(0)}%`);

      if (!rewardProfile.acceptingOrders) {
        score *= 0.8;
        reasons.push('激励市场当前不接受下单，明显降权');
      } else if (rewardProfile.fitScore >= 0.85) {
        score += 4;
        reasons.push('盘口与激励规则匹配，加分');
      } else if (rewardProfile.fitScore >= 0.6) {
        score += 2;
        reasons.push('激励较强，且一二档基本满足奖励条件');
      } else {
        score *= 0.94;
        reasons.push('有激励，但当前盘口/深度适配度一般，降权');
      }

      if (rewardProfile.spreadFit <= 0) {
        score *= 0.9;
        reasons.push('当前盘口宽于激励价差上限，降权');
      }
      if (rewardProfile.l2SizeFit < 0.6) {
        score *= 0.92;
        reasons.push('二档深度不足以稳定吃到激励，降权');
      }
      if (rewardProfile.crowdingPenalty > 0) {
        score -= rewardProfile.crowdingPenalty;
        reasons.push(
          `奖励队列过厚，降权: ${rewardProfile.crowdingMultiple.toFixed(1)}x min-size`
        );
      }
    }

    reasons.push(`24h流动性: $${liquidity.toFixed(0)}`);
    reasons.push(`24h交易量: $${volume.toFixed(0)}`);
    reasons.push(`一档可挂: $${levels.l1Usable.toFixed(2)}`);
    reasons.push(`二档可挂: $${levels.l2Usable.toFixed(2)}`);
    reasons.push(`一档双边: $${levels.l1Total.toFixed(2)}`);
    reasons.push(`二档双边: $${levels.l2Total.toFixed(2)}`);
    reasons.push(`盘口对称度: ${(symmetry * 100).toFixed(0)}%`);
    reasons.push(`二档支撑率: ${(supportRatio * 100).toFixed(0)}%`);
    reasons.push(`最大断层: ${(levelGap * 100).toFixed(2)}¢`);
    reasons.push(`订单数: ${totalOrders}`);
    reasons.push(`价差: ${spreadPct.toFixed(2)}%`);

    return { market, score, reasons };
  }

  private getPolymarketRewardProfile(market: Market, orderbook: Orderbook): PolymarketRewardProfile {
    const dailyRate = Number(market.polymarket_reward_daily_rate || 0);
    const minSize = Number(market.polymarket_reward_min_size || 0);
    const maxSpread = Number(market.polymarket_reward_max_spread || 0);
    const enabled = Boolean(market.polymarket_rewards_enabled) && dailyRate > 0 && minSize > 0 && maxSpread > 0;
    const bid1Shares = this.getLevelShares(orderbook.bids, 0, 'bids') || 0;
    const ask1Shares = this.getLevelShares(orderbook.asks, 0, 'asks') || 0;
    const bid2Shares = this.getLevelShares(orderbook.bids, 1, 'bids') || 0;
    const ask2Shares = this.getLevelShares(orderbook.asks, 1, 'asks') || 0;
    const l1MinShares = bid1Shares > 0 && ask1Shares > 0 ? Math.min(bid1Shares, ask1Shares) : 0;
    const l2MinShares = bid2Shares > 0 && ask2Shares > 0 ? Math.min(bid2Shares, ask2Shares) : 0;
    const spread = Number(orderbook.spread || 0);

    if (!enabled) {
      return {
        enabled: false,
        acceptingOrders: market.polymarket_accepting_orders !== false,
        minSize,
        maxSpread,
        dailyRate,
        hourlyRate: dailyRate > 0 ? dailyRate / 24 : 0,
        l1SizeFit: 0,
        l2SizeFit: 0,
        spreadFit: 0,
        fitScore: 0,
        bonus: 0,
        crowdingMultiple: 0,
        crowdingPenalty: 0,
      };
    }

    const l1SizeFit = clamp(l1MinShares / minSize, 0, 1.25);
    const l2SizeFit = clamp(l2MinShares / minSize, 0, 1.25);
    const spreadFit = spread > 0 ? clamp(1 - spread / maxSpread, 0, 1) : 0;
    const fitScore = clamp(0.3 * spreadFit + 0.25 * (l1SizeFit / 1.25) + 0.45 * (l2SizeFit / 1.25), 0, 1.1);
    const rewardStrength = Math.min(20, Math.log10(dailyRate + 1) * 4.5);
    const bonus = rewardStrength * (0.35 + 0.65 * fitScore);
    const crowdingMultiple = Math.max(l1MinShares, l2MinShares) / Math.max(1, minSize);
    const crowdingPenalty = clamp(
      Math.max(0, crowdingMultiple - this.polymarketRewardCrowdingPenaltyStart) * 1.6,
      0,
      this.polymarketRewardCrowdingPenaltyMax
    );

    return {
      enabled,
      acceptingOrders: market.polymarket_accepting_orders !== false,
      minSize,
      maxSpread,
      dailyRate,
      hourlyRate: dailyRate / 24,
      l1SizeFit,
      l2SizeFit,
      spreadFit,
      fitScore,
      bonus,
      crowdingMultiple,
      crowdingPenalty,
    };
  }

  evaluatePolymarketRewardFit(market: Market, orderbook: Orderbook): PolymarketRewardProfile {
    return this.getPolymarketRewardProfile(market, orderbook);
  }

  private getLevelLiquidity(orderbook: Orderbook): LevelLiquidity {
    const bid1 = this.getLevelNotional(orderbook.bids, 0, 'bids');
    const ask1 = this.getLevelNotional(orderbook.asks, 0, 'asks');
    const bid2 = this.getLevelNotional(orderbook.bids, 1, 'bids');
    const ask2 = this.getLevelNotional(orderbook.asks, 1, 'asks');

    return {
      bid1,
      ask1,
      bid2,
      ask2,
      l1Usable: bid1 > 0 && ask1 > 0 ? Math.min(bid1, ask1) : 0,
      l2Usable: bid2 > 0 && ask2 > 0 ? Math.min(bid2, ask2) : 0,
      l1Total: bid1 + ask1,
      l2Total: bid2 + ask2,
    };
  }

  private getLevelNotional(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length <= index) {
      return 0;
    }

    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });

    const level = sorted[index];
    if (!level) {
      return 0;
    }

    const price = Number(level.price || 0);
    const shares = Number(level.shares || 0);
    if (!Number.isFinite(price) || !Number.isFinite(shares) || price <= 0 || shares <= 0) {
      return 0;
    }

    return price * shares;
  }

  private getLevelGap(orderbook: Orderbook, side: 'bids' | 'asks'): number {
    const l1 = this.getLevelPrice(orderbook[side], 0, side);
    const l2 = this.getLevelPrice(orderbook[side], 1, side);
    if (l1 === null || l2 === null) {
      return Number.POSITIVE_INFINITY;
    }
    return side === 'bids' ? l1 - l2 : l2 - l1;
  }

  private getLevelPrice(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number | null {
    if (!Array.isArray(levels) || levels.length <= index) {
      return null;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const level = sorted[index];
    if (!level) {
      return null;
    }
    const price = Number(level.price || 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  private getSupportRatio(orderbook: Orderbook, side: 'bids' | 'asks'): number {
    const l1 = this.getLevelShares(orderbook[side], 0, side);
    const l2 = this.getLevelShares(orderbook[side], 1, side);
    if (l1 === null || l2 === null || l1 <= 0 || l2 <= 0) {
      return 0;
    }
    return l2 / l1;
  }

  private getLevelShares(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number | null {
    if (!Array.isArray(levels) || levels.length <= index) {
      return null;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const level = sorted[index];
    if (!level) {
      return null;
    }
    const shares = Number(level.shares || 0);
    return Number.isFinite(shares) && shares > 0 ? shares : null;
  }

  private getBookSymmetry(orderbook: Orderbook): number {
    const bid = this.getLevelNotional(orderbook.bids, 0, 'bids');
    const ask = this.getLevelNotional(orderbook.asks, 0, 'asks');
    if (bid <= 0 || ask <= 0) {
      return 0;
    }
    const minSide = Math.min(bid, ask);
    const maxSide = Math.max(bid, ask);
    return maxSide > 0 ? minSide / maxSide : 0;
  }

  private getCenterPriceScore(mid: number): number {
    if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) {
      return 0;
    }
    const distance = Math.abs(mid - 0.5);
    return Math.max(0, 1 - distance / 0.45);
  }

  getTopMarkets(scoredMarkets: MarketScore[], count: number = 10): Market[] {
    return scoredMarkets.slice(0, count).map((s) => s.market);
  }

  printAnalysis(scoredMarkets: MarketScore[]): void {
    console.log('\n📊 市场分析（按真实可挂流动性、盘口质量与激励匹配度排序）:');
    console.log('─'.repeat(80));

    for (let i = 0; i < Math.min(10, scoredMarkets.length); i++) {
      const { market, score, reasons } = scoredMarkets[i];
      console.log(`\n#${i + 1} [总分: ${score.toFixed(1)}] ${(market.question || '').substring(0, 50)}...`);
      console.log(`   Token: ${market.token_id}`);
      for (const reason of reasons) {
        console.log(`   - ${reason}`);
      }
    }

    console.log('\n' + '─'.repeat(80));
  }
}
