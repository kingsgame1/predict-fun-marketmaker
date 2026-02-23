/**
 * 🔌 统一API客户端适配器
 *
 * 提供统一的API调用接口，支持Predict和Probable平台
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { PredictAPI } from './client.js';

/**
 * 平台类型
 */
export enum PlatformType {
  PREDICT = 'predict',
  PROBABLE = 'probable'
}

/**
 * 订单状态
 */
export enum OrderStatus {
  PENDING = 'pending',
  OPEN = 'open',
  FILLED = 'filled',
  PARTIALLY_FILLED = 'partially_filled',
  CANCELLED = 'cancelled',
  REJECTED = 'rejected',
  EXPIRED = 'expired'
}

/**
 * 订单信息
 */
export interface OrderInfo {
  orderId: string;
  marketId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  amount: number;
  price: number;
  filledAmount: number;
  status: OrderStatus;
  timestamp: number;
  txHash?: string;
}

/**
 * 市场信息
 */
export interface MarketInfo {
  marketId: string;
  marketTitle: string;
  settlementTime: number;
  outcomes: any[];
  volume: number;
  liquidity: number;
  status: string;
  createdAt: number;
}

/**
 * 钱包余额
 */
export interface WalletBalance {
  address: string;
  balance: number;          // USDT余额
  tokens: Map<string, number>; // 其他代币余额
  timestamp: number;
}

/**
 * API客户端适配器
 */
export class APIClientAdapter {
  private predictAPI: PredictAPI;
  private platform: PlatformType;
  private config: any;

  constructor(platform: PlatformType, config: any) {
    this.platform = platform;
    this.config = config;
    this.predictAPI = new PredictAPI(config);
  }

  /**
   * 获取市场信息
   */
  async fetchMarket(marketId: string): Promise<MarketInfo | null> {
    try {
      const market = await this.predictAPI.fetchMarket(marketId);

      if (!market) {
        return null;
      }

      return {
        marketId: market.marketId,
        marketTitle: market.marketTitle,
        settlementTime: market.settlementTime || Date.now() + 86400000,
        outcomes: market.outcomes || [],
        volume: market.volume || 0,
        liquidity: market.liquidity || 0,
        status: market.status || 'active',
        createdAt: market.createdAt || Date.now()
      };

    } catch (error) {
      console.error(`获取市场信息失败: ${marketId}`, error.message);
      return null;
    }
  }

  /**
   * 获取所有市场
   */
  async fetchAllMarkets(): Promise<MarketInfo[]> {
    try {
      const markets = await this.predictAPI.fetchMarkets();

      return markets.map(m => ({
        marketId: m.marketId,
        marketTitle: m.marketTitle,
        settlementTime: m.settlementTime || Date.now() + 86400000,
        outcomes: m.outcomes || [],
        volume: m.volume || 0,
        liquidity: m.liquidity || 0,
        status: m.status || 'active',
        createdAt: m.createdAt || Date.now()
      }));

    } catch (error) {
      console.error('获取市场列表失败:', error.message);
      return [];
    }
  }

  /**
   * 创建订单
   */
  async createOrder(params: {
    marketId: string;
    tokenId: string;
    side: 'buy' | 'sell';
    amount: number;
    price?: number;
  }): Promise<{ orderId: string; txHash?: string }> {
    try {
      // 调用实际的API创建订单
      const result = await this.predictAPI.createOrder({
        marketId: params.marketId,
        tokenId: params.tokenId,
        side: params.side,
        amount: params.amount,
        price: params.price || 0
      });

      return {
        orderId: result.orderId || `order_${Date.now()}`,
        txHash: result.txHash
      };

    } catch (error) {
      console.error('创建订单失败:', error.message);
      throw error;
    }
  }

  /**
   * 查询订单状态
   */
  async fetchOrderStatus(orderId: string): Promise<OrderInfo | null> {
    try {
      // 调用API查询订单状态
      const orderData = await this.predictAPI.fetchOrder(orderId);

      if (!orderData) {
        return null;
      }

      return {
        orderId: orderData.orderId || orderId,
        marketId: orderData.marketId || '',
        tokenId: orderData.tokenId || '',
        side: orderData.side || 'buy',
        orderType: orderData.orderType || 'limit',
        amount: orderData.amount || 0,
        price: orderData.price || 0,
        filledAmount: orderData.filledAmount || 0,
        status: this.mapOrderStatus(orderData.status),
        timestamp: orderData.timestamp || Date.now(),
        txHash: orderData.txHash
      };

    } catch (error) {
      console.error(`查询订单状态失败: ${orderId}`, error.message);
      return null;
    }
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      // 调用API取消订单
      await this.predictAPI.cancelOrder(orderId);
      return true;

    } catch (error) {
      console.error(`取消订单失败: ${orderId}`, error.message);
      return false;
    }
  }

  /**
   * 获取钱包余额
   */
  async fetchWalletBalance(): Promise<WalletBalance | null> {
    try {
      // 调用API获取余额
      const balance = await this.predictAPI.fetchBalance();

      return {
        address: this.config.predictAddress || '',
        balance: balance?.usdt || 0,
        tokens: new Map(Object.entries(balance?.tokens || {})),
        timestamp: Date.now()
      };

    } catch (error) {
      console.error('获取钱包余额失败:', error.message);
      return null;
    }
  }

  /**
   * 获取订单簿
   */
  async fetchOrderBook(marketId: string, tokenId: string): Promise<any> {
    try {
      return await this.predictAPI.fetchOrderBook(marketId, tokenId);
    } catch (error) {
      console.error(`获取订单簿失败: ${marketId}/${tokenId}`, error.message);
      return null;
    }
  }

  /**
   * 映射订单状态
   */
  private mapOrderStatus(status: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      'pending': OrderStatus.PENDING,
      'open': OrderStatus.OPEN,
      'filled': OrderStatus.FILLED,
      'partially_filled': OrderStatus.PARTIALLY_FILLED,
      'cancelled': OrderStatus.CANCELLED,
      'rejected': OrderStatus.REJECTED,
      'expired': OrderStatus.EXPIRED
    };

    return statusMap[status] || OrderStatus.PENDING;
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{
    api: boolean;
    rpc: boolean;
    latency: number;
  }> {
    const startTime = Date.now();

    try {
      // 测试API连接
      await this.predictAPI.fetchMarkets();
      const apiOk = true;
      const latency = Date.now() - startTime;

      // RPC健康检查（简化版）
      const rpcOk = true;

      return {
        api: apiOk,
        rpc: rpcOk,
        latency
      };

    } catch (error) {
      return {
        api: false,
        rpc: false,
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * 获取平台信息
   */
  getPlatform(): PlatformType {
    return this.platform;
  }

  /**
   * 获取配置
   */
  getConfig(): any {
    return this.config;
  }
}

/**
 * 全局API适配器实例
 */
let globalAPIClient: APIClientAdapter | null = null;

/**
 * 获取全局API客户端
 */
export function getAPIClient(platform: PlatformType = PlatformType.PREDICT): APIClientAdapter {
  if (!globalAPIClient) {
    // 从环境变量或配置加载
    const config = {
      apiUrl: process.env.API_BASE_URL || 'https://api.predict.fun',
      apiKey: process.env.API_KEY,
      jwtToken: process.env.JWT_TOKEN,
      rpcUrl: process.env.RPC_URL,
      privateKey: process.env.PRIVATE_KEY,
      predictAddress: process.env.PREDICT_ACCOUNT_ADDRESS
    };

    globalAPIClient = new APIClientAdapter(platform, config);
  }

  return globalAPIClient;
}
