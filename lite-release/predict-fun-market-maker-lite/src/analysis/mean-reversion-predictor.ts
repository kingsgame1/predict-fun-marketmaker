/**
 * 均值回归预测器 - Mean Reversion Predictor
 *
 * 使用 Ornstein-Uhlenbeck 过程模型预测库存回归中性所需时间
 *
 * 核心功能:
 * - 预测回归到指定比例所需时间 (分钟)
 * - 检测异常情况 (超时未回归)
 * - 校准模型参数
 *
 * 文档: docs/IMPLEMENTATION_ROADMAP.md Section 1.4
 */

/**
 * 库存历史记录
 */
export interface InventoryHistory {
  timestamp: number;
  netShares: number;
  maxPosition: number;
  inventoryBias: number;  // 标准化 [-1, 1]
}

/**
 * OU 模型参数
 */
export interface OUModelParameters {
  // theta: 均值回归强度 (越大回归越快)
  theta: number;

  // mu: 长期均值 (库存的长期目标, 通常是0)
  mu: number;

  // sigma: 波动率 (库存的随机波动程度)
  sigma: number;
}

/**
 * 回归预测结果
 */
export interface ReversionPrediction {
  // 预计回归时间 (分钟)
  estimatedMinutes: number;

  // 预计回归时间戳
  estimatedTimestamp: number;

  // 置信度 (0-1)
  confidence: number;

  // 是否超时 (超过预期回归时间仍未回归)
  isOverdue: boolean;

  // 当前库存偏斜
  currentBias: number;

  // 目标库存偏斜
  targetBias: number;
}

export class MeanReversionPredictor {
  // OU 模型参数
  private params: OUModelParameters;

  // 库存历史记录
  private inventoryHistory: Map<string, InventoryHistory[]> = new Map();

  // 最大历史长度
  private readonly MAX_HISTORY_SIZE = 1000;

  // 默认回归时间阈值 (分钟) - 超过此时间认为异常
  private readonly DEFAULT_REVERSION_THRESHOLD_MINUTES = 30;

  // 最小置信度阈值
  private readonly MIN_CONFIDENCE = 0.5;

  constructor() {
    // 初始化 OU 模型参数 (经验值)
    this.params = {
      theta: 0.1,   // 回归强度: 0.1 (较慢的回归)
      mu: 0.0,      // 长期均值: 0 (中性库存)
      sigma: 0.2    // 波动率: 0.2
    };
  }

  /**
   * 预测回归到指定比例所需时间 (分钟)
   *
   * 使用 Ornstein-Uhlenbeck 过程的期望公式:
   * E[X(t)] = μ + (X(0) - μ) * exp(-θ * t)
   *
   * 反解得到时间 t:
   * t = -ln((E[X(t)] - μ) / (X(0) - μ)) / θ
   *
   * @param currentInventory 当前库存 (净持仓)
   * @param maxPosition 最大持仓限制
   * @param targetRatio 目标比例 (0.1 = 10%, 0.05 = 5%)
   * @returns 预测结果
   */
  predictTimeToTarget(
    currentInventory: number,
    maxPosition: number,
    targetRatio: number = 0.1
  ): ReversionPrediction {
    const currentBias = currentInventory / maxPosition;
    const targetBias = Math.max(-1, Math.min(1, targetRatio));

    // 如果已经在目标范围内, 立即回归
    if (Math.abs(currentBias) <= Math.abs(targetBias)) {
      return {
        estimatedMinutes: 0,
        estimatedTimestamp: Date.now(),
        confidence: 1.0,
        isOverdue: false,
        currentBias,
        targetBias
      };
    }

    // 使用 OU 过程公式计算回归时间
    // E[X(t)] = μ + (X(0) - μ) * exp(-θ * t)
    // 我们想要 E[X(t)] = targetBias
    // targetBias = μ + (currentBias - μ) * exp(-θ * t)
    // exp(-θ * t) = (targetBias - μ) / (currentBias - μ)
    // -θ * t = ln((targetBias - μ) / (currentBias - μ))
    // t = -ln((targetBias - μ) / (currentBias - μ)) / θ

    const { theta, mu } = this.params;

    // 计算回归时间 (分钟)
    const ratio = (targetBias - mu) / (currentBias - mu);

    // 避免除零或负数
    if (ratio <= 0 || ratio >= 1) {
      return {
        estimatedMinutes: Infinity,
        estimatedTimestamp: Infinity,
        confidence: 0,
        isOverdue: false,
        currentBias,
        targetBias
      };
    }

    const t_fractional = -Math.log(ratio) / theta;

    // 转换为分钟 (假设时间单位是小时)
    const estimatedMinutes = t_fractional * 60;

    // 计算置信度 (基于历史数据准确性)
    const confidence = this.calculateConfidence(currentBias, targetBias);

    return {
      estimatedMinutes,
      estimatedTimestamp: Date.now() + estimatedMinutes * 60 * 1000,
      confidence,
      isOverdue: false,
      currentBias,
      targetBias
    };
  }

  /**
   * 检测是否应该触发警报 (超时未回归)
   * @param tokenId 市场ID
   * @param currentInventory 当前库存
   * @param maxPosition 最大持仓
   * @param targetRatio 目标比例
   * @param thresholdMinutes 超时阈值 (分钟)
   * @returns 是否应该警报
   */
  shouldAlert(
    tokenId: string,
    currentInventory: number,
    maxPosition: number,
    targetRatio: number = 0.1,
    thresholdMinutes?: number
  ): boolean {
    const threshold = thresholdMinutes ?? this.DEFAULT_REVERSION_THRESHOLD_MINUTES;

    // 获取历史记录
    const history = this.inventoryHistory.get(tokenId) || [];

    if (history.length === 0) {
      return false;
    }

    // 找到最后一次偏离目标范围的时间点
    const now = Date.now();
    let lastDeviationTime = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const point = history[i];
      const bias = Math.abs(point.inventoryBias);

      if (bias > targetRatio) {
        lastDeviationTime = point.timestamp;
        break;
      }
    }

    // 如果没有偏离记录, 不需要警报
    if (lastDeviationTime === 0) {
      return false;
    }

    // 计算偏离持续时间 (分钟)
    const deviationMinutes = (now - lastDeviationTime) / (60 * 1000);

    // 如果超过阈值, 触发警报
    return deviationMinutes > threshold;
  }

  /**
   * 记录库存状态
   * @param tokenId 市场ID
   * @param netShares 净持仓
   * @param maxPosition 最大持仓
   */
  recordInventory(tokenId: string, netShares: number, maxPosition: number): void {
    const inventoryBias = netShares / maxPosition;

    const history = this.inventoryHistory.get(tokenId) || [];
    history.push({
      timestamp: Date.now(),
      netShares,
      maxPosition,
      inventoryBias
    });

    // 限制历史长度
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.shift();
    }

    this.inventoryHistory.set(tokenId, history);
  }

  /**
   * 校准模型参数 (使用历史数据)
   * @param tokenId 市场ID (可选, 不提供则使用所有数据)
   */
  calibrateModel(tokenId?: string): void {
    // 收集所有相关历史数据
    let allHistory: InventoryHistory[] = [];

    if (tokenId) {
      allHistory = this.inventoryHistory.get(tokenId) || [];
    } else {
      for (const history of this.inventoryHistory.values()) {
        allHistory = allHistory.concat(history);
      }
    }

    if (allHistory.length < 10) {
      console.warn('Insufficient data for calibration');
      return;
    }

    // 使用最大似然估计 (MLE) 估计 OU 参数
    // θ = -ln(γ) / Δt
    // μ = (ξ̄ - η * x̄) / (1 - η)
    // σ² = 2 * θ * σₑ² / (1 - η²)

    const n = allHistory.length;
    const dt = 1; // 假设时间间隔为1个单位

    let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;

    for (let i = 1; i < n; i++) {
      const x = allHistory[i - 1].inventoryBias;
      const y = allHistory[i].inventoryBias;

      sumX += x;
      sumY += y;
      sumX2 += x * x;
      sumY2 += y * y;
      sumXY += x * y;
    }

    const n_minus_1 = n - 1;

    // 计算回归系数
    const numerator = n_minus_1 * sumXY - sumX * sumY;
    const denominator = n_minus_1 * sumX2 - sumX * sumX;

    if (denominator === 0) {
      console.warn('Cannot calibrate: denominator is zero');
      return;
    }

    const gamma = numerator / denominator;

    // 计算 theta
    const theta = -Math.log(gamma) / dt;

    // 计算 mu
    const xMean = sumX / n_minus_1;
    const yMean = sumY / n_minus_1;
    const mu = (yMean - gamma * xMean) / (1 - gamma);

    // 计算 sigma (残差标准差)
    let residualSumSquares = 0;
    for (let i = 1; i < n; i++) {
      const x = allHistory[i - 1].inventoryBias;
      const y = allHistory[i].inventoryBias;
      const predicted = mu + gamma * (x - mu);
      residualSumSquares += (y - predicted) ** 2;
    }

    const residualVariance = residualSumSquares / (n_minus_1 - 2);
    const sigma = Math.sqrt((2 * theta * residualVariance) / (1 - gamma * gamma));

    // 更新参数
    this.params = {
      theta: Math.max(0.01, Math.min(1.0, theta)),  // 限制范围 [0.01, 1.0]
      mu,
      sigma: Math.max(0.01, Math.min(1.0, sigma))  // 限制范围 [0.01, 1.0]
    };

    console.log(`Model calibrated: θ=${theta.toFixed(4)}, μ=${mu.toFixed(4)}, σ=${sigma.toFixed(4)}`);
  }

  /**
   * 计算置信度 (基于历史预测准确性)
   * @param currentBias 当前库存偏斜
   * @param targetBias 目标偏斜
   * @returns 置信度 (0-1)
   */
  private calculateConfidence(currentBias: number, targetBias: number): number {
    // 简单启发式: 置信度与当前偏离程度成反比
    const deviation = Math.abs(currentBias - targetBias);

    // 偏离越大, 预测越不确定
    let confidence = 1.0 - deviation * 0.5;
    confidence = Math.max(this.MIN_CONFIDENCE, Math.min(1.0, confidence));

    return confidence;
  }

  /**
   * 获取当前模型参数
   */
  getParameters(): OUModelParameters {
    return { ...this.params };
  }

  /**
   * 设置模型参数
   * @param params 新参数
   */
  setParameters(params: Partial<OUModelParameters>): void {
    if (params.theta !== undefined) {
      this.params.theta = Math.max(0.001, Math.min(1.0, params.theta));
    }
    if (params.mu !== undefined) {
      this.params.mu = Math.max(-1, Math.min(1, params.mu));
    }
    if (params.sigma !== undefined) {
      this.params.sigma = Math.max(0.001, Math.min(1.0, params.sigma));
    }
  }

  /**
   * 清理历史数据
   * @param tokenId 市场ID (不提供则清理所有)
   * @param minutesToKeep 保留多少分钟的数据
   */
  cleanup(tokenId?: string, minutesToKeep: number = 1440): void {
    const cutoffTime = Date.now() - minutesToKeep * 60 * 1000;

    if (tokenId) {
      const history = this.inventoryHistory.get(tokenId);
      if (history) {
        const filtered = history.filter(point => point.timestamp >= cutoffTime);
        this.inventoryHistory.set(tokenId, filtered);
      }
    } else {
      for (const [key, history] of this.inventoryHistory.entries()) {
        const filtered = history.filter(point => point.timestamp >= cutoffTime);
        this.inventoryHistory.set(key, filtered);
      }
    }
  }

  /**
   * 重置预测器
   */
  reset(): void {
    this.inventoryHistory.clear();
    this.params = {
      theta: 0.1,
      mu: 0.0,
      sigma: 0.2
    };
  }

  /**
   * 获取库存历史
   * @param tokenId 市场ID
   */
  getInventoryHistory(tokenId: string): InventoryHistory[] {
    return this.inventoryHistory.get(tokenId) || [];
  }

  /**
   * 判断库存是否正在回归
   * @param tokenId 市场ID
   * @param windowMinutes 比较窗口 (分钟)
   * @returns 是否正在回归
   */
  isReverting(tokenId: string, windowMinutes: number = 10): boolean {
    const history = this.inventoryHistory.get(tokenId);
    if (!history || history.length < 2) {
      return false;
    }

    const cutoffTime = Date.now() - windowMinutes * 60 * 1000;
    const recentHistory = history.filter(point => point.timestamp >= cutoffTime);

    if (recentHistory.length < 2) {
      return false;
    }

    // 比较最近两个点的库存偏斜
    const latest = recentHistory[recentHistory.length - 1];
    const previous = recentHistory[recentHistory.length - 2];

    return Math.abs(latest.inventoryBias) < Math.abs(previous.inventoryBias);
  }
}
