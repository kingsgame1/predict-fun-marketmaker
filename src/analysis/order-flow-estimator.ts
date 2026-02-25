/**
 * 订单流估算器 - Order Flow Estimator
 *
 * 统计订单到达速率 (λ), 检测订单流激增, 识别订单流模式
 *
 * 核心功能:
 * - 实时记录订单事件
 * - 计算订单流强度 (每分钟订单数)
 * - 检测订单流激增
 * - 识别订单流模式 (买方/卖方主导)
 *
 * 文档: docs/IMPLEMENTATION_ROADMAP.md Section 1.2
 */

export interface OrderEvent {
  timestamp: number;
  side: 'BUY' | 'SELL';
  amount: number;
  price?: number;
}

export interface OrderFlowMetrics {
  // 每分钟订单数
  ordersPerMinute: number;

  // 每分钟订单金额 (USD)
  volumePerMinute: number;

  // 买卖比例 (买方订单数 / 总订单数)
  buyRatio: number;

  // 买卖金额比例 (买方金额 / 总金额)
  buyVolumeRatio: number;

  // 订单流方向: 'bullish' (买方主导) | 'bearish' (卖方主导) | 'balanced' (平衡)
  direction: 'bullish' | 'bearish' | 'balanced';
}

export class OrderFlowEstimator {
  // 订单历史记录
  private orderHistory: OrderEvent[] = [];

  // 最大历史长度 (保留最近1小时的订单)
  private readonly MAX_HISTORY_SIZE = 10000;

  // 激增检测阈值 (超过历史平均的多少倍算激增)
  private surgeThreshold: number = 2.0;

  // 激增检测最小时间窗口 (秒)
  private readonly surgeWindowSeconds: number = 60;

  // 买方主导阈值 (买方占比超过此值认为买方主导)
  private readonly buyDominanceThreshold = 0.6;

  // 卖方主导阈值 (卖方占比超过此值认为卖方主导)
  private readonly sellDominanceThreshold = 0.4;

  /**
   * 记录订单事件
   * @param side 订单方向 ('BUY' | 'SELL')
   * @param amount 订单金额 (USD)
   * @param price 订单价格 (可选)
   * @param timestamp 时间戳 (毫秒), 默认为当前时间
   */
  recordOrder(
    side: 'BUY' | 'SELL',
    amount: number,
    price?: number,
    timestamp?: number
  ): void {
    const now = timestamp || Date.now();

    this.orderHistory.push({
      timestamp: now,
      side,
      amount,
      price
    });

    // 限制历史长度
    if (this.orderHistory.length > this.MAX_HISTORY_SIZE) {
      this.orderHistory.shift();
    }
  }

  /**
   * 获取订单流强度 (每分钟订单数)
   * @param minutes 时间范围 (分钟), 默认1分钟
   * @returns 每分钟订单数
   */
  getFlowIntensity(minutes: number = 1): number {
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const recentOrders = this.orderHistory.filter(order => order.timestamp >= cutoffTime);

    // 按分钟换算
    return recentOrders.length / minutes;
  }

  /**
   * 获取订单流金额 (每分钟USD)
   * @param minutes 时间范围 (分钟), 默认1分钟
   * @returns 每分钟订单金额
   */
  getFlowVolume(minutes: number = 1): number {
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const recentOrders = this.orderHistory.filter(order => order.timestamp >= cutoffTime);

    const totalVolume = recentOrders.reduce((sum, order) => sum + order.amount, 0);
    return totalVolume / minutes;
  }

  /**
   * 获取完整的订单流指标
   * @param minutes 时间范围 (分钟), 默认1分钟
   * @returns 订单流指标
   */
  getMetrics(minutes: number = 1): OrderFlowMetrics {
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const recentOrders = this.orderHistory.filter(order => order.timestamp >= cutoffTime);

    if (recentOrders.length === 0) {
      return {
        ordersPerMinute: 0,
        volumePerMinute: 0,
        buyRatio: 0.5,
        buyVolumeRatio: 0.5,
        direction: 'balanced'
      };
    }

    // 统计买单
    const buyOrders = recentOrders.filter(order => order.side === 'BUY');
    const buyOrderCount = buyOrders.length;
    const buyVolume = buyOrders.reduce((sum, order) => sum + order.amount, 0);

    // 统计卖单
    const sellOrders = recentOrders.filter(order => order.side === 'SELL');
    const sellVolume = sellOrders.reduce((sum, order) => sum + order.amount, 0);

    // 计算比例
    const totalOrders = recentOrders.length;
    const totalVolume = buyVolume + sellVolume;

    const buyRatio = totalOrders > 0 ? buyOrderCount / totalOrders : 0.5;
    const buyVolumeRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

    // 判断方向
    let direction: 'bullish' | 'bearish' | 'balanced';
    if (buyRatio >= this.buyDominanceThreshold && buyVolumeRatio >= this.buyDominanceThreshold) {
      direction = 'bullish';
    } else if (buyRatio <= this.sellDominanceThreshold && buyVolumeRatio <= this.sellDominanceThreshold) {
      direction = 'bearish';
    } else {
      direction = 'balanced';
    }

    return {
      ordersPerMinute: recentOrders.length / minutes,
      volumePerMinute: totalVolume / minutes,
      buyRatio,
      buyVolumeRatio,
      direction
    };
  }

  /**
   * 检测订单流激增
   * @param threshold 自定义阈值倍数 (可选)
   * @param minutes 比较时间范围 (分钟), 默认5分钟
   * @returns 是否激增
   */
  detectSurge(threshold?: number, minutes: number = 5): boolean {
    const customThreshold = threshold ?? this.surgeThreshold;

    // 当前1分钟的订单流
    const currentFlow = this.getFlowIntensity(1);

    // 历史平均订单流 (过去N分钟)
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const historicalOrders = this.orderHistory.filter(order => order.timestamp >= cutoffTime);

    if (historicalOrders.length === 0) {
      return false;
    }

    // 计算历史平均 (排除最近1分钟)
    const recentMinuteCutoff = Date.now() - 60 * 1000;
    const baselineOrders = historicalOrders.filter(order => order.timestamp < recentMinuteCutoff);
    const baselineMinutes = (minutes - 1) || 1; // 避免除以0
    const baselineFlow = baselineOrders.length / baselineMinutes;

    // 判断是否激增
    if (baselineFlow === 0) {
      return currentFlow > 5; // 如果历史平均为0, 超过5单算激增
    }

    return currentFlow > baselineFlow * customThreshold;
  }

  /**
   * 检测订单流骤降
   * @param threshold 阈值倍数 (默认0.5, 即低于历史平均50%)
   * @param minutes 比较时间范围 (分钟), 默认5分钟
   * @returns 是否骤降
   */
  detectDrop(threshold: number = 0.5, minutes: number = 5): boolean {
    // 当前1分钟的订单流
    const currentFlow = this.getFlowIntensity(1);

    // 历史平均订单流
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const historicalOrders = this.orderHistory.filter(order => order.timestamp >= cutoffTime);

    if (historicalOrders.length === 0) {
      return false;
    }

    const recentMinuteCutoff = Date.now() - 60 * 1000;
    const baselineOrders = historicalOrders.filter(order => order.timestamp < recentMinuteCutoff);
    const baselineMinutes = (minutes - 1) || 1;
    const baselineFlow = baselineOrders.length / baselineMinutes;

    if (baselineFlow === 0) {
      return false;
    }

    return currentFlow < baselineFlow * threshold;
  }

  /**
   * 设置激增检测阈值
   * @param threshold 新的阈值倍数
   */
  setSurgeThreshold(threshold: number): void {
    if (threshold <= 1.0) {
      throw new Error('Surge threshold must be greater than 1.0');
    }
    this.surgeThreshold = threshold;
  }

  /**
   * 获取订单流趋势 (增加/减少/稳定)
   * @param minutes 比较时间范围 (分钟)
   * @returns 'increasing' | 'decreasing' | 'stable'
   */
  getFlowTrend(minutes: number = 10): 'increasing' | 'decreasing' | 'stable' {
    // 将时间分为两半比较
    const halfMinutes = Math.floor(minutes / 2);
    if (halfMinutes < 1) return 'stable';

    const recentFlow = this.getFlowIntensity(halfMinutes);
    const olderCutoffStart = Date.now() - minutes * 60 * 1000;
    const olderCutoffEnd = Date.now() - halfMinutes * 60 * 1000;

    const olderOrders = this.orderHistory.filter(
      order => order.timestamp >= olderCutoffStart && order.timestamp < olderCutoffEnd
    );
    const olderFlow = olderOrders.length / halfMinutes;

    // 比较差异
    const diff = recentFlow - olderFlow;
    const threshold = Math.max(olderFlow * 0.3, 2); // 至少2单的差异

    if (diff > threshold) return 'increasing';
    if (diff < -threshold) return 'decreasing';
    return 'stable';
  }

  /**
   * 清理过期的订单历史
   * @param minutesToKeep 保留多少分钟的订单 (默认60分钟)
   */
  cleanup(minutesToKeep: number = 60): void {
    const cutoffTime = Date.now() - minutesToKeep * 60 * 1000;
    this.orderHistory = this.orderHistory.filter(order => order.timestamp >= cutoffTime);
  }

  /**
   * 重置估算器
   */
  reset(): void {
    this.orderHistory = [];
  }

  /**
   * 获取历史长度
   */
  getHistorySize(): number {
    return this.orderHistory.length;
  }

  /**
   * 获取订单历史
   */
  getOrderHistory(): OrderEvent[] {
    return [...this.orderHistory];
  }

  /**
   * 获取最近N个订单
   * @param count 订单数量
   */
  getRecentOrders(count: number): OrderEvent[] {
    return this.orderHistory.slice(-count);
  }
}
