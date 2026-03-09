/**
 * 🔧 市场数据获取工具
 *
 * 补全 certainty-judge.ts 中的 TODO: getMarketData
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { PredictAPI } from '../api/client.js';

/**
 * 市场详细信息
 */
export interface MarketDetails {
  marketId: string;
  marketTitle: string;
  settlementTime: number;
  outcomes: any[];
  volume: number;
  liquidity: number;
  createdAt: number;
  status: 'active' | 'closed' | 'settled';
}

/**
 * 市场数据获取器
 */
export class MarketDataFetcher {
  private api: PredictAPI;
  private cache: Map<string, { data: MarketDetails; expiry: number }> = new Map();

  constructor(api: PredictAPI) {
    this.api = api;
  }

  /**
   * 获取市场详情
   */
  async getMarketData(marketId: string): Promise<MarketDetails> {
    // 检查缓存
    const cached = this.cache.get(marketId);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    try {
      const market = await this.api.getMarket(marketId);

      const statusRaw = String((market as any).tradingStatus || (market as any).status || 'OPEN').toUpperCase();
      const status: MarketDetails['status'] =
        statusRaw === 'SETTLED'
          ? 'settled'
          : statusRaw === 'CLOSED'
          ? 'closed'
          : 'active';

      const details: MarketDetails = {
        marketId: String(market.event_id || market.condition_id || market.token_id || marketId),
        marketTitle: market.question || 'Unknown Market',
        settlementTime: market.end_date ? new Date(market.end_date).getTime() : Date.now() + 86400000,
        outcomes: Array.isArray(market.outcomes) ? market.outcomes : [],
        volume: Number(market.volume_24h || 0),
        liquidity: Number(market.liquidity_24h || 0),
        createdAt: market.end_date ? new Date(market.end_date).getTime() : Date.now(),
        status,
      };

      // 缓存5分钟
      this.cache.set(marketId, {
        data: details,
        expiry: Date.now() + 300000
      });

      return details;

    } catch (error) {
      console.error(`获取市场数据失败: ${marketId}`, error instanceof Error ? error.message : error);

      // 返回默认值
      return {
        marketId,
        marketTitle: 'Unknown Market',
        settlementTime: Date.now() + 86400000,
        outcomes: [],
        volume: 0,
        liquidity: 0,
        createdAt: Date.now(),
        status: 'active'
      };
    }
  }

  /**
   * 批量获取市场数据
   */
  async getBatchMarketData(marketIds: string[]): Promise<Map<string, MarketDetails>> {
    const results = new Map<string, MarketDetails>();

    const promises = marketIds.map(async (marketId) => {
      const data = await this.getMarketData(marketId);
      results.set(marketId, data);
    });

    await Promise.allSettled(promises);

    return results;
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
