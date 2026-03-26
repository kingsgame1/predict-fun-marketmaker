/**
 * 波动率估算器 - Volatility Estimator
 *
 * 使用 EWMA (指数加权移动平均) 实时计算市场波动率
 *
 * 核心功能:
 * - 实时更新波动率估计
 * - 支持历史波动率查询
 * - 使用对数收益率计算
 *
 * 文档: docs/IMPLEMENTATION_ROADMAP.md Section 1.1
 */

interface PricePoint {
  price: number;
  timestamp: number;
}

interface VolatilityHistory {
  timestamp: number;
  volatility: number;
}

export class VolatilityEstimator {
  // 价格历史记录 (最多保存1000个数据点)
  private priceHistory: PricePoint[] = [];

  // 波动率历史记录
  private volatilityHistory: VolatilityHistory[] = [];

  // EWMA 衰减因子 (RiskMetrics 推荐值: 0.94)
  private lambda: number = 0.94;

  // 当前波动率 (年化, 初始值2%)
  private currentVolatility: number = 0.02;

  // 价格历史最大长度
  private readonly MAX_HISTORY_SIZE = 1000;

  // 波动率历史最大长度 (保留最近24小时的数据, 每5分钟一个点 = 288个点)
  private readonly MAX_VOLATILITY_HISTORY = 288;

  // 最小价格点数 (用于计算波动率)
  private readonly MIN_PRICES_FOR_CALCULATION = 10;

  /**
   * 更新价格历史并重新计算波动率
   * @param price 最新价格
   * @param timestamp 时间戳 (毫秒), 默认为当前时间
   */
  updatePrice(price: number, timestamp?: number): void {
    const now = timestamp || Date.now();

    // 添加新价格点
    this.priceHistory.push({ price, timestamp: now });

    // 限制历史长度
    if (this.priceHistory.length > this.MAX_HISTORY_SIZE) {
      this.priceHistory.shift();
    }

    // 重新计算波动率
    if (this.priceHistory.length >= this.MIN_PRICES_FOR_CALCULATION) {
      this.recalculateVolatility();
    }
  }

  /**
   * 使用 EWMA 方法重新计算波动率
   *
   * EWMA 公式:
   * σ²(t) = λ × σ²(t-1) + (1 - λ) × r²(t)
   *
   * 其中:
   * - σ²: 方差 (波动率的平方)
   * - λ: 衰减因子 (0.94)
   * - r: 对数收益率
   */
  private recalculateVolatility(): void {
    if (this.priceHistory.length < 2) return;

    // 计算对数收益率
    const returns: number[] = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const r = Math.log(this.priceHistory[i].price / this.priceHistory[i - 1].price);
      returns.push(r);
    }

    // 使用 EWMA 更新波动率
    let variance = this.currentVolatility * this.currentVolatility;

    for (const r of returns) {
      variance = this.lambda * variance + (1 - this.lambda) * r * r;
    }

    // 更新当前波动率
    this.currentVolatility = Math.sqrt(variance);

    // 记录波动率历史
    this.volatilityHistory.push({
      timestamp: Date.now(),
      volatility: this.currentVolatility
    });

    // 限制波动率历史长度
    if (this.volatilityHistory.length > this.MAX_VOLATILITY_HISTORY) {
      this.volatilityHistory.shift();
    }
  }

  /**
   * 获取当前波动率 (年化)
   * @returns 年化波动率 (例如: 0.25 = 25%)
   */
  getVolatility(): number {
    return this.currentVolatility;
  }

  /**
   * 获取指定时间范围的波动率
   * @param minutes 时间范围 (分钟)
   * @returns 该时间段的平均波动率
   */
  getHistoricalVolatility(minutes: number): number {
    const cutoffTime = Date.now() - minutes * 60 * 1000;

    // 过滤出指定时间范围内的波动率记录
    const relevantHistory = this.volatilityHistory.filter(
      point => point.timestamp >= cutoffTime
    );

    if (relevantHistory.length === 0) {
      return this.currentVolatility;
    }

    // 计算平均波动率
    const sum = relevantHistory.reduce((acc, point) => acc + point.volatility, 0);
    return sum / relevantHistory.length;
  }

  /**
   * 获取指定时间范围内的最高波动率
   * @param minutes 时间范围 (分钟)
   * @returns 该时间段的最高波动率
   */
  getMaxVolatility(minutes: number): number {
    const cutoffTime = Date.now() - minutes * 60 * 1000;

    const relevantHistory = this.volatilityHistory.filter(
      point => point.timestamp >= cutoffTime
    );

    if (relevantHistory.length === 0) {
      return this.currentVolatility;
    }

    return Math.max(...relevantHistory.map(point => point.volatility));
  }

  /**
   * 获取指定时间范围内的最低波动率
   * @param minutes 时间范围 (分钟)
   * @returns 该时间段的最低波动率
   */
  getMinVolatility(minutes: number): number {
    const cutoffTime = Date.now() - minutes * 60 * 1000;

    const relevantHistory = this.volatilityHistory.filter(
      point => point.timestamp >= cutoffTime
    );

    if (relevantHistory.length === 0) {
      return this.currentVolatility;
    }

    return Math.min(...relevantHistory.map(point => point.volatility));
  }

  /**
   * 检测波动率是否异常飙升
   * @param threshold 阈值倍数 (例如: 2.0 表示超过历史平均2倍)
   * @param minutes 比较时间范围 (分钟)
   * @returns 是否异常
   */
  isVolatilitySpike(threshold: number = 2.0, minutes: number = 60): boolean {
    const historicalVol = this.getHistoricalVolatility(minutes);
    return this.currentVolatility > historicalVol * threshold;
  }

  /**
   * 重置估算器状态
   */
  reset(): void {
    this.priceHistory = [];
    this.volatilityHistory = [];
    this.currentVolatility = 0.02;
  }

  /**
   * 设置 EWMA 衰减因子
   * @param lambda 新的衰减因子 (0-1)
   *
   * 说明:
   * - λ 接近 1: 波动率变化更平滑, 对历史数据权重更高
   * - λ 接近 0: 波动率反应更敏感, 对最新数据权重更高
   * - RiskMetrics 推荐: 0.94
   */
  setLambda(lambda: number): void {
    if (lambda <= 0 || lambda >= 1) {
      throw new Error('Lambda must be between 0 and 1');
    }
    this.lambda = lambda;
  }

  /**
   * 获取价格历史长度
   */
  getHistorySize(): number {
    return this.priceHistory.length;
  }

  /**
   * 获取波动率历史
   */
  getVolatilityHistory(): VolatilityHistory[] {
    return [...this.volatilityHistory];
  }

  /**
   * 计算波动率趋势 (上升/下降/稳定)
   * @param minutes 比较时间范围 (分钟)
   * @returns 'rising' | 'falling' | 'stable'
   */
  getVolatilityTrend(minutes: number = 30): 'rising' | 'falling' | 'stable' {
    const cutoffTime = Date.now() - minutes * 60 * 1000;
    const relevantHistory = this.volatilityHistory.filter(
      point => point.timestamp >= cutoffTime
    );

    if (relevantHistory.length < 2) {
      return 'stable';
    }

    // 简单线性回归判断趋势
    const n = relevantHistory.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += relevantHistory[i].volatility;
      sumXY += i * relevantHistory[i].volatility;
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avgVol = sumY / n;

    // 如果斜率超过平均值的10%, 认为有明显趋势
    const threshold = avgVol * 0.1;

    if (slope > threshold) return 'rising';
    if (slope < -threshold) return 'falling';
    return 'stable';
  }
}
