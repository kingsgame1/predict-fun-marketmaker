/**
 * 💼 实际交易执行引擎
 *
 * 负责执行实际的交易操作，从模拟走向实盘
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { PredictAPI } from '../api/client.js';
import { OrderBook } from '../types.js';
import { recordExecution } from '../execution-stats.js';
import { getAPIClient, OrderStatus } from '../api/api-client-adapter.js';

/**
 * 订单状态
 */
export enum OrderStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  PARTIAL_FILLED = 'partial_filled',
  FILLED = 'filled',
  CANCELLED = 'cancelled',
  FAILED = 'failed'
}

/**
 * 订单类型
 */
export enum OrderType {
  LIMIT = 'limit',
  MARKET = 'market'
}

/**
 * 订单方向
 */
export enum OrderSide {
  BUY = 'buy',
  SELL = 'sell'
}

/**
 * 订单结果
 */
export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  filled: boolean;
  filledAmount: number;
  filledPrice: number;
  unfilledAmount: number;
  fee: number;
  timestamp: number;
  txHash?: string;
  error?: string;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  success: boolean;
  orders: OrderResult[];
  totalFilled: number;
  totalCost: number;
  avgPrice: number;
  totalFee: number;
  executionTime: number;
  slippagePercent: number;
  error?: string;
}

/**
 * 执行请求
 */
export interface ExecutionRequest {
  marketId: string;
  tokenId: string;
  side: OrderSide;
  orderType: OrderType;
  amount: number;          // 目标数量
  price?: number;          // 限价（限价单必需）
  maxSlippage?: number;    // 最大滑点（市价单）
  minFillPercent?: number; // 最小成交百分比
  timeout?: number;        // 超时时间（毫秒）
}

/**
 * 交易执行引擎
 */
export class TradingExecutionEngine {
  private api: PredictAPI;
  private pendingOrders: Map<string, OrderResult> = new Map();
  private executionHistory: OrderResult[] = [];

  constructor(api: PredictAPI) {
    this.api = api;
  }

  /**
   * 执行单个订单
   */
  async executeOrder(request: ExecutionRequest): Promise<OrderResult> {
    const startTime = Date.now();
    const orderId = this.generateOrderId();

    console.log(`💼 执行订单: ${request.side} ${request.amount} @ ${request.price || 'market'}`);

    const result: OrderResult = {
      orderId,
      status: OrderStatus.PENDING,
      filled: false,
      filledAmount: 0,
      filledPrice: 0,
      unfilledAmount: request.amount,
      fee: 0,
      timestamp: startTime
    };

    try {
      if (request.orderType === OrderType.MARKET) {
        // 市价单
        const marketResult = await this.executeMarketOrder(request);
        Object.assign(result, marketResult);
      } else {
        // 限价单
        const limitResult = await this.executeLimitOrder(request);
        Object.assign(result, limitResult);
      }

      // 更新状态
      result.filled = result.filledAmount > 0;
      result.status = result.filled ? OrderStatus.FILLED : OrderStatus.FAILED;

      console.log(`✅ 订单完成: 成交${result.filledAmount} @ ${result.filledPrice}`);

    } catch (error) {
      result.status = OrderStatus.FAILED;
      result.error = error.message;
      console.error(`❌ 订单失败: ${error.message}`);
    }

    // 记录历史
    this.executionHistory.push(result);
    this.pendingOrders.delete(orderId);

    // 返回结果
    return result;
  }

  /**
   * 执行市价单
   */
  private async executeMarketOrder(request: ExecutionRequest): Promise<Partial<OrderResult>> {
    // 获取当前订单簿
    const orderBook = await this.api.fetchOrderBook(request.marketId, request.tokenId);

    if (!orderBook) {
      throw new Error('无法获取订单簿');
    }

    let totalFilled = 0;
    let totalCost = 0;
    let totalPrice = 0;
    let totalFee = 0;

    const side = request.side;
    const remainingAmount = request.amount;

    if (side === OrderSide.BUY) {
      // 买入：从卖单簿开始向上吃
      const asks = orderBook.asks || [];

      for (const ask of asks) {
        if (totalFilled >= remainingAmount) break;

        const fillAmount = Math.min(ask.amount, remainingAmount - totalFilled);
        const cost = fillAmount * ask.price;

        // 检查滑点
        if (request.maxSlippage) {
          const expectedPrice = asks[0].price;
          const slippage = (ask.price - expectedPrice) / expectedPrice;
          if (slippage > request.maxSlippage) {
            throw new Error(`滑点过大: ${(slippage * 100).toFixed(2)}%`);
          }
        }

        // 执行买入
        const orderResult = await this.placeOrder({
          marketId: request.marketId,
          tokenId: request.tokenId,
          side: OrderSide.BUY,
          orderType: OrderType.LIMIT,
          amount: fillAmount,
          price: ask.price
        });

        if (orderResult.filled) {
          totalFilled += orderResult.filledAmount;
          totalCost += cost;
          totalPrice += orderResult.filledPrice * orderResult.filledAmount;
          totalFee += orderResult.fee;
        }
      }

    } else {
      // 卖出：向买单簿向下卖
      const bids = orderBook.bids || [];

      for (const bid of bids) {
        if (totalFilled >= remainingAmount) break;

        const fillAmount = Math.min(bid.amount, remainingAmount - totalFilled);
        const revenue = fillAmount * bid.price;

        // 检查滑点
        if (request.maxSlippage) {
          const expectedPrice = bids[0].price;
          const slippage = (expectedPrice - bid.price) / expectedPrice;
          if (slippage > request.maxSlippage) {
            throw new Error(`滑点过大: ${(slippage * 100).toFixed(2)}%`);
          }
        }

        // 执行卖出
        const orderResult = await this.placeOrder({
          marketId: request.marketId,
          tokenId: request.tokenId,
          side: OrderSide.SELL,
          orderType: OrderType.LIMIT,
          amount: fillAmount,
          price: bid.price
        });

        if (orderResult.filled) {
          totalFilled += orderResult.filledAmount;
          totalCost += revenue;
          totalPrice += orderResult.filledPrice * orderResult.filledAmount;
          totalFee += orderResult.fee;
        }
      }
    }

    const avgPrice = totalFilled > 0 ? totalPrice / totalFilled : 0;

    return {
      filledAmount: totalFilled,
      filledPrice: avgPrice,
      unfilledAmount: remainingAmount - totalFilled,
      fee: totalFee
    };
  }

  /**
   * 执行限价单
   */
  private async executeLimitOrder(request: ExecutionRequest): Promise<Partial<OrderResult>> {
    if (!request.price) {
      throw new Error('限价单必须指定价格');
    }

    // 直接下单
    const result = await this.placeOrder(request);

    return {
      filledAmount: result.filledAmount,
      filledPrice: result.filledPrice,
      unfilledAmount: result.unfilledAmount,
      fee: result.fee
    };
  }

  /**
   * 下单到交易所
   */
  private async placeOrder(request: ExecutionRequest): Promise<OrderResult> {
    const orderId = this.generateOrderId();

    console.log(`📝 下单: ${request.side} ${request.amount} @ ${request.price}`);

    try {
      // 调用API下单
      // 注意：这里是模拟实现，实际需要根据Predict/Probable的API调整
      const txHash = await this.api.createOrder({
        marketId: request.marketId,
        tokenId: request.tokenId,
        side: request.side,
        amount: request.amount,
        price: request.price || 0
      });

      // 等待订单确认
      const confirmed = await this.waitForOrderFill(orderId, request.timeout || 30000);

      if (confirmed) {
        // 订单成交
        return {
          orderId,
          status: OrderStatus.FILLED,
          filled: true,
          filledAmount: request.amount,
          filledPrice: request.price || 0,
          unfilledAmount: 0,
          fee: this.calculateFee(request.amount, request.price || 0),
          timestamp: Date.now(),
          txHash
        };
      } else {
        // 订单超时未成交
        return {
          orderId,
          status: OrderStatus.CANCELLED,
          filled: false,
          filledAmount: 0,
          filledPrice: 0,
          unfilledAmount: request.amount,
          fee: 0,
          timestamp: Date.now(),
          error: '订单超时未成交'
        };
      }

    } catch (error) {
      return {
        orderId,
        status: OrderStatus.FAILED,
        filled: false,
        filledAmount: 0,
        filledPrice: 0,
        unfilledAmount: request.amount,
        fee: 0,
        timestamp: Date.now(),
        error: error.message
      };
    }
  }

  /**
   * 等待订单成交
   */
  private async waitForOrderFill(orderId: string, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // 检查订单状态
      const status = await this.checkOrderStatus(orderId);

      if (status === OrderStatus.FILLED) {
        return true;
      }

      if (status === OrderStatus.CANCELLED || status === OrderStatus.FAILED) {
        return false;
      }

      // 等待一段时间再检查
      await this.sleep(500);
    }

    return false;
  }

  /**
   * 检查订单状态
   */
  private async checkOrderStatus(orderId: string): Promise<OrderStatus> {
    try {
      const apiClient = getAPIClient();
      const orderInfo = await apiClient.fetchOrderStatus(orderId);

      if (orderInfo) {
        return orderInfo.status;
      }

      // 降级到本地状态
      const order = this.pendingOrders.get(orderId);
      return order?.status || OrderStatus.PENDING;

    } catch (error) {
      console.warn(`查询订单状态失败: ${orderId}，使用本地状态`);
      const order = this.pendingOrders.get(orderId);
      return order?.status || OrderStatus.PENDING;
    }
  }

  /**
   * 计算手续费
   */
  private calculateFee(amount: number, price: number): number {
    const value = amount * price;
    const feeRate = 0.001; // 0.1%手续费（假设）
    return value * feeRate;
  }

  /**
   * 生成订单ID
   */
  private generateOrderId(): string {
    return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取待处理订单
   */
  getPendingOrders(): OrderResult[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * 获取执行历史
   */
  getExecutionHistory(): OrderResult[] {
    return [...this.executionHistory];
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      // 调用API取消订单
      const apiClient = getAPIClient();
      const success = await apiClient.cancelOrder(orderId);

      // 更新本地状态
      if (success) {
        const order = this.pendingOrders.get(orderId);
        if (order) {
          order.status = OrderStatus.CANCELLED;
          this.pendingOrders.delete(orderId);
        }
        return true;
      }

      return false;
    } catch (error) {
      console.error(`取消订单失败: ${orderId}`, error.message);
      return false;
    }
  }

  /**
   * 取消所有待处理订单
   */
  async cancelAllOrders(): Promise<number> {
    let cancelled = 0;

    for (const orderId of this.pendingOrders.keys()) {
      const success = await this.cancelOrder(orderId);
      if (success) cancelled++;
    }

    return cancelled;
  }
}

/**
 * 便捷函数：创建执行引擎
 */
export function createExecutionEngine(api: PredictAPI): TradingExecutionEngine {
  return new TradingExecutionEngine(api);
}

/**
 * 便捷函数：执行套利订单
 */
export async function executeArbitrageOrders(
  engine: TradingExecutionEngine,
  orders: ExecutionRequest[]
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const results: OrderResult[] = [];

  // 并发执行所有订单
  const promises = orders.map(order => engine.executeOrder(order));
  const orderResults = await Promise.allSettled(promises);

  // 处理结果
  for (const result of orderResults) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    }
  }

  // 计算总体统计
  const totalFilled = results.reduce((sum, r) => sum + r.filledAmount, 0);
  const totalCost = results.reduce((sum, r) => sum + (r.filledAmount * r.filledPrice), 0);
  const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
  const totalFee = results.reduce((sum, r) => sum + r.fee, 0);

  const executionTime = Date.now() - startTime;

  // 计算滑点（基于第一个订单的预期价格）
  let slippagePercent = 0;
  if (results.length > 0 && results[0].status === 'filled') {
    const firstOrder = results[0];
    // 使用订单价格作为预期价格
    const expectedPrice = firstOrder.price || firstOrder.filledPrice;
    if (expectedPrice > 0 && avgPrice > 0) {
      slippagePercent = Math.abs((avgPrice - expectedPrice) / expectedPrice) * 100;
      if (firstOrder.side === 'sell') {
        // 卖单滑点计算相反
        slippagePercent = Math.abs((expectedPrice - avgPrice) / expectedPrice) * 100;
      }
    }
  }

  const success = results.every(r => r.filled);

  return {
    success,
    orders: results,
    totalFilled,
    totalCost,
    avgPrice,
    totalFee,
    executionTime,
    slippagePercent,
    error: success ? undefined : '部分订单未能成交'
  };
}
