/**
 * 动态 AS 模型 - Dynamic Avellaneda-Stoikov Model
 *
 * 实现 Avellaneda-Stoikov 动态价差模型
 * 考虑库存、波动率、订单流、竞争等因素
 *
 * 核心功能:
 * - 计算最优价差 (百分比)
 * - 计算最优买卖价
 * - 实时校准模型参数
 *
 * 文档: docs/IMPLEMENTATION_ROADMAP.md Section 1.5
 *
 * 参考文献:
 * Avellaneda, M., & Stoikov, S. (2008). High-frequency trading in a limit order book.
 * Quantitative Finance, 8(3), 217-224.
 */

/**
 * 市场状态接口
 */
export interface MarketState {
  // 中间价
  midPrice: number;

  // 标准化库存 [-1, 1] (负数=空头, 正数=多头)
  inventory: number;

  // 年化波动率 (例如: 0.25 = 25%)
  volatility: number;

  // 订单流强度 (每分钟订单数)
  orderFlow: number;

  // 订单簿深度 (USD)
  depth: number;

  // 订单流方向 (可选)
  flowDirection?: 'bullish' | 'bearish' | 'balanced';
}

/**
 * AS 模型参数
 */
export interface ASModelParameters {
  // 风险厌恶系数 (γ) - 越大越厌恶风险
  gamma: number;

  // 订单到达速率 (λ) - 每秒订单数
  lambda: number;

  // 等级参数 (κ) - 控制价格弹性
  kappa: number;

  // 库存影响权重 (α) - 库存对价差的影响
  alpha: number;

  // 波动率影响权重 (β) - 波动率对价差的影响
  beta: number;

  // 订单流影响权重 (δ) - 订单流对价差的影响
  delta: number;

  // 竞争影响权重 (θ) - 竞争对价差的影响
  theta: number;
}

/**
 * 最优报价结果
 */
export interface OptimalQuotes {
  // 最优买价
  bidPrice: number;

  // 最优卖价
  askPrice: number;

  // 最优价差 (百分比)
  optimalSpread: number;

  // 买价调整 (库存偏差)
  bidAdjustment: number;

  // 卖价调整 (库存偏差)
  askAdjustment: number;

  // 建议订单大小 (USD)
  suggestedSize: number;
}

/**
 * 市场数据接口 (用于校准)
 */
export interface MarketData {
  timestamp: number;
  midPrice: number;
  inventory: number;
  realizedSpread: number;
  filledOrders: number;
}

/**
 * 默认模型参数
 */
const DEFAULT_PARAMETERS: ASModelParameters = {
  gamma: 0.1,     // 风险厌恶: 0.1 (轻度厌恶)
  lambda: 1.0,    // 订单速率: 1.0 订单/秒
  kappa: 1.5,     // 价格弹性: 1.5
  alpha: 0.5,     // 库存影响: 0.5
  beta: 0.3,      // 波动率影响: 0.3
  delta: 0.2,     // 订单流影响: 0.2
  theta: 0.1      // 竞争影响: 0.1
};

export class DynamicASModel {
  private params: ASModelParameters;

  // 市场数据历史 (用于校准)
  private marketHistory: MarketData[] = [];

  // 最大历史长度
  private readonly MAX_HISTORY_SIZE = 10000;

  // 基础价差 (百分比)
  private baseSpread: number = 0.015; // 默认 1.5%

  // 最小价差 (百分比)
  private minSpread: number = 0.005; // 默认 0.5%

  // 最大价差 (百分比)
  private maxSpread: number = 0.10; // 默认 10%

  constructor(params?: Partial<ASModelParameters>) {
    this.params = {
      ...DEFAULT_PARAMETERS,
      ...params
    };
  }

  /**
   * 计算最优价差 (百分比)
   *
   * Avellaneda-Stoikov 基础公式:
   * s = γ * σ² / (2 * κ * λ)
   *
   * 增强版公式 (考虑多因素):
   * s = s_base * (1 + α*|q| + β*σ + δ*λ_flow + θ*competition)
   *
   * 其中:
   * - s_base: 基础价差 (AS公式)
   * - q: 标准化库存 [-1, 1]
   * - σ: 波动率
   * - λ_flow: 订单流强度
   * - competition: 竞争程度
   *
   * @param state 市场状态
   * @returns 最优价差 (百分比)
   */
  calculateOptimalSpread(state: MarketState): number {
    const { inventory, volatility, orderFlow, depth } = state;
    const { gamma, lambda, kappa, alpha, beta, delta } = this.params;

    // 1. 计算基础价差 (AS 核心公式)
    // s = γ * σ² / (2 * κ * λ)
    const baseAsSpread = (gamma * volatility * volatility) / (2 * kappa * lambda);

    // 2. 库存调整项
    const inventoryAdjustment = alpha * Math.abs(inventory);

    // 3. 波动率调整项
    const volatilityAdjustment = beta * volatility;

    // 4. 订单流调整项
    // 订单流越高, 价差可以越小 (流动性好)
    const normalizedFlow = Math.min(1.0, orderFlow / 100); // 假设100单/分钟为高流动性
    const flowAdjustment = -delta * normalizedFlow; // 负号: 高流动性降低价差

    // 5. 竞争调整项 (基于订单簿深度)
    const normalizedDepth = Math.min(1.0, depth / 10000); // 假设$10k为高深度
    const competitionAdjustment = -this.params.theta * normalizedDepth;

    // 6. 计算总调整因子
    const totalAdjustment = 1.0 + inventoryAdjustment + volatilityAdjustment + flowAdjustment + competitionAdjustment;

    // 7. 计算最终价差
    let spread = baseAsSpread * totalAdjustment;

    // 8. 加上基础价差
    spread += this.baseSpread;

    // 9. 限制在合理范围内
    spread = Math.max(this.minSpread, Math.min(this.maxSpread, spread));

    return spread;
  }

  /**
   * 计算最优买卖价
   *
   * 买价公式:
   * bid = mid_price * (1 - s/2) - inventory_skew
   *
   * 卖价公式:
   * ask = mid_price * (1 + s/2) - inventory_skew
   *
   * 其中 inventory_skew = α * q * mid_price
   *
   * @param midPrice 中间价
   * @param state 市场状态
   * @param baseSpread 基础价差 (可选, 不提供则自动计算)
   * @returns 最优报价
   */
  calculateOptimalQuotes(
    midPrice: number,
    state: MarketState,
    baseSpread?: number
  ): OptimalQuotes {
    // 1. 计算最优价差
    const spread = baseSpread ?? this.calculateOptimalSpread(state);

    // 2. 计算库存偏斜
    // inventory_skew = α * q * mid_price
    const inventorySkew = this.params.alpha * state.inventory * midPrice;

    // 3. 计算买卖价调整
    // 买价调整 (库存为正时降低买价, 库存为负时提高买价)
    const bidAdjustment = -inventorySkew;

    // 卖价调整 (库存为正时提高卖价, 库存为负时降低卖价)
    const askAdjustment = -inventorySkew;

    // 4. 计算最优买卖价
    // bid = mid * (1 - s/2) + adjustment
    // ask = mid * (1 + s/2) + adjustment
    const halfSpread = spread / 2;
    const bidPrice = midPrice * (1 - halfSpread) + bidAdjustment;
    const askPrice = midPrice * (1 + halfSpread) + askAdjustment;

    // 5. 计算建议订单大小
    // 库存越高, 订单大小越小 (风险管理)
    const inventoryFactor = 1.0 - Math.abs(state.inventory) * 0.5; // 最大减少50%
    const suggestedSize = 25 * inventoryFactor; // 默认$25, 根据库存调整

    return {
      bidPrice: Math.max(0.01, bidPrice), // 确保价格 > $0.01
      askPrice: Math.max(0.01, askPrice),
      optimalSpread: spread,
      bidAdjustment,
      askAdjustment,
      suggestedSize: Math.max(5, suggestedSize) // 最小$5
    };
  }

  /**
   * 实时校准模型参数
   *
   * 使用历史市场数据优化参数
   *
   * @param marketData 历史市场数据
   */
  async calibrate(marketData: MarketData[]): Promise<void> {
    if (marketData.length < 10) {
      console.warn('Insufficient data for calibration');
      return;
    }

    // 添加到历史记录
    this.marketHistory = this.marketHistory.concat(marketData);

    // 限制历史长度
    if (this.marketHistory.length > this.MAX_HISTORY_SIZE) {
      this.marketHistory = this.marketHistory.slice(-this.MAX_HISTORY_SIZE);
    }

    // 简化的校准方法: 基于成交率和实现价差调整 gamma 和 lambda
    // 更复杂的校准可以使用最大似然估计或贝叶斯优化

    // 1. 计算平均成交率
    const avgFillRate = marketData.reduce((sum, d) => sum + d.filledOrders, 0) / marketData.length;

    // 2. 计算平均实现价差
    const avgRealizedSpread = marketData.reduce((sum, d) => sum + d.realizedSpread, 0) / marketData.length;

    // 3. 调整 lambda (订单到达速率)
    // 如果成交率高, 说明订单过于激进, 降低 lambda
    if (avgFillRate > 0.5) {
      this.params.lambda *= 0.9; // 降低10%
    } else if (avgFillRate < 0.2) {
      this.params.lambda *= 1.1; // 提高10%
    }

    // 4. 调整 gamma (风险厌恶)
    // 如果实现价差小于目标, 说明风险太高, 提高gamma
    if (avgRealizedSpread < this.baseSpread * 0.8) {
      this.params.gamma *= 1.1; // 提高10%
    } else if (avgRealizedSpread > this.baseSpread * 1.2) {
      this.params.gamma *= 0.9; // 降低10%
    }

    // 限制参数范围
    this.params.gamma = Math.max(0.01, Math.min(1.0, this.params.gamma));
    this.params.lambda = Math.max(0.1, Math.min(10.0, this.params.lambda));

    console.log(`Model calibrated: γ=${this.params.gamma.toFixed(4)}, λ=${this.params.lambda.toFixed(4)}`);
  }

  /**
   * 获取当前参数
   */
  getParameters(): ASModelParameters {
    return { ...this.params };
  }

  /**
   * 设置参数
   * @param params 新参数
   */
  setParameters(params: Partial<ASModelParameters>): void {
    if (params.gamma !== undefined) {
      this.params.gamma = Math.max(0.01, Math.min(1.0, params.gamma));
    }
    if (params.lambda !== undefined) {
      this.params.lambda = Math.max(0.1, Math.min(10.0, params.lambda));
    }
    if (params.kappa !== undefined) {
      this.params.kappa = Math.max(0.5, Math.min(5.0, params.kappa));
    }
    if (params.alpha !== undefined) {
      this.params.alpha = Math.max(0.0, Math.min(2.0, params.alpha));
    }
    if (params.beta !== undefined) {
      this.params.beta = Math.max(0.0, Math.min(1.0, params.beta));
    }
    if (params.delta !== undefined) {
      this.params.delta = Math.max(0.0, Math.min(1.0, params.delta));
    }
    if (params.theta !== undefined) {
      this.params.theta = Math.max(0.0, Math.min(1.0, params.theta));
    }
  }

  /**
   * 设置基础价差
   * @param spread 基础价差 (百分比)
   */
  setBaseSpread(spread: number): void {
    this.baseSpread = Math.max(0.001, Math.min(0.05, spread));
  }

  /**
   * 设置价差范围
   * @param min 最小价差
   * @param max 最大价差
   */
  setSpreadRange(min: number, max: number): void {
    this.minSpread = Math.max(0.001, min);
    this.maxSpread = Math.max(min, max);
  }

  /**
   * 重置模型
   */
  reset(): void {
    this.params = { ...DEFAULT_PARAMETERS };
    this.marketHistory = [];
  }

  /**
   * 获取历史数据
   */
  getHistory(): MarketData[] {
    return [...this.marketHistory];
  }

  /**
   * 清理历史数据
   * @param minutesToKeep 保留多少分钟的数据
   */
  cleanup(minutesToKeep: number = 1440): void {
    const cutoffTime = Date.now() - minutesToKeep * 60 * 1000;
    this.marketHistory = this.marketHistory.filter(data => data.timestamp >= cutoffTime);
  }

  /**
   * 计算理论最优价差 (简化版, 不考虑库存和订单流)
   * @param volatility 波动率
   * @returns 基础价差
   */
  calculateBaseSpread(volatility: number): number {
    const { gamma, lambda, kappa } = this.params;
    return (gamma * volatility * volatility) / (2 * kappa * lambda);
  }

  /**
   * 评估当前报价质量
   * @param midPrice 中间价
   * @param bidPrice 当前买价
   * @param askPrice 当前卖价
   * @param state 市场状态
   * @returns 质量分数 (0-100)
   */
  evaluateQuoteQuality(
    midPrice: number,
    bidPrice: number,
    askPrice: number,
    state: MarketState
  ): number {
    // 计算最优报价
    const optimal = this.calculateOptimalQuotes(midPrice, state);

    // 计算当前价差
    const currentSpread = (askPrice - bidPrice) / midPrice;

    // 计算偏差
    const spreadDeviation = Math.abs(currentSpread - optimal.optimalSpread);
    const bidDeviation = Math.abs(bidPrice - optimal.bidPrice);
    const askDeviation = Math.abs(askPrice - optimal.askPrice);

    // 计算分数 (偏差越小分数越高)
    const spreadScore = Math.max(0, 100 - spreadDeviation * 1000);
    const bidScore = Math.max(0, 100 - bidDeviation / midPrice * 10000);
    const askScore = Math.max(0, 100 - askDeviation / midPrice * 10000);

    return (spreadScore + bidScore + askScore) / 3;
  }

  /**
   * 获取模型统计信息
   */
  getStats(): {
    parameters: ASModelParameters;
    historySize: number;
    baseSpread: number;
    spreadRange: { min: number; max: number };
  } {
    return {
      parameters: this.getParameters(),
      historySize: this.marketHistory.length,
      baseSpread: this.baseSpread,
      spreadRange: {
        min: this.minSpread,
        max: this.maxSpread
      }
    };
  }
}
