/**
 * 库存分类器 - Inventory Classifier
 *
 * 将库存状态分类为 4 个等级, 提供每个等级对应的策略建议
 *
 * 核心功能:
 * - 将库存状态分类为 SAFE/WARNING/DANGER/CRITICAL
 * - 根据库存状态提供策略配置
 * - 支持多市场综合分类
 *
 * 文档: docs/IMPLEMENTATION_ROADMAP.md Section 1.3
 */

/**
 * 库存状态枚举
 */
export enum InventoryState {
  SAFE = 'SAFE',           // 安全: 库存偏斜 < 30%
  WARNING = 'WARNING',     // 警告: 库存偏斜 30-50%
  DANGER = 'DANGER',       // 危险: 库存偏斜 50-70%
  CRITICAL = 'CRITICAL'    // 严重: 库存偏斜 > 70%
}

/**
 * 策略配置接口
 */
export interface StrategyConfig {
  // 价差倍数 (1.0 = 正常价差, 1.5 = 扩大50%)
  spreadMultiplier: number;

  // 订单大小倍数 (1.0 = 正常大小, 0.5 = 减少50%)
  sizeMultiplier: number;

  // 单边挂单 (只允许买或只允许卖)
  singleSide?: 'BUY' | 'SELL';

  // 是否允许挂单
  allowOrders: boolean;

  // 是否强制平仓
  forceFlatten: boolean;

  // 不对称价差调整 (买卖单使用不同价差)
  asymSpread?: {
    buySpreadMultiplier: number;   // 买单价差倍数
    sellSpreadMultiplier: number;  // 卖单价差倍数
  };
}

/**
 * 库存信息接口
 */
export interface InventoryInfo {
  tokenId: string;
  netShares: number;           // 净持仓 (YES数量 - NO数量)
  maxPosition: number;         // 最大持仓限制
  inventoryBias: number;       // 标准化库存偏斜 [-1, 1]
  state: InventoryState;       // 库存状态
}

/**
 * 分类器配置接口
 */
export interface ClassifierConfig {
  // 各状态的阈值 (库存偏斜百分比)
  safeThreshold?: number;      // 默认 0.3 (30%)
  warningThreshold?: number;   // 默认 0.5 (50%)
  dangerThreshold?: number;    // 默认 0.7 (70%)

  // 是否启用不对称价差
  enableAsymSpread?: boolean;

  // 默认策略配置 (可覆盖)
  defaultStrategies?: {
    SAFE?: Partial<StrategyConfig>;
    WARNING?: Partial<StrategyConfig>;
    DANGER?: Partial<StrategyConfig>;
    CRITICAL?: Partial<StrategyConfig>;
  };
}

export class InventoryClassifier {
  private config: Required<ClassifierConfig>;

  // 各状态的默认策略配置
  private readonly DEFAULT_STRATEGIES: Record<InventoryState, StrategyConfig> = {
    SAFE: {
      spreadMultiplier: 1.0,
      sizeMultiplier: 1.0,
      allowOrders: true,
      forceFlatten: false,
      asymSpread: {
        buySpreadMultiplier: 1.0,
        sellSpreadMultiplier: 1.0
      }
    },

    WARNING: {
      spreadMultiplier: 1.2,
      sizeMultiplier: 0.8,
      allowOrders: true,
      forceFlatten: false,
      asymSpread: {
        buySpreadMultiplier: 1.1,
        sellSpreadMultiplier: 1.1
      }
    },

    DANGER: {
      spreadMultiplier: 1.5,
      sizeMultiplier: 0.5,
      allowOrders: true,
      forceFlatten: false,
      asymSpread: {
        buySpreadMultiplier: 1.3,
        sellSpreadMultiplier: 1.3
      }
    },

    CRITICAL: {
      spreadMultiplier: 2.0,
      sizeMultiplier: 0.2,
      allowOrders: false,
      forceFlatten: true,
      asymSpread: {
        buySpreadMultiplier: 2.0,
        sellSpreadMultiplier: 2.0
      }
    }
  };

  constructor(config: ClassifierConfig = {}) {
    this.config = {
      safeThreshold: config.safeThreshold ?? 0.3,
      warningThreshold: config.warningThreshold ?? 0.5,
      dangerThreshold: config.dangerThreshold ?? 0.7,
      enableAsymSpread: config.enableAsymSpread ?? true,
      defaultStrategies: {
        SAFE: config.defaultStrategies?.SAFE ?? {},
        WARNING: config.defaultStrategies?.WARNING ?? {},
        DANGER: config.defaultStrategies?.DANGER ?? {},
        CRITICAL: config.defaultStrategies?.CRITICAL ?? {}
      }
    };
  }

  /**
   * 分类单个市场的库存状态
   * @param tokenId 市场ID
   * @param netShares 净持仓 (YES - NO)
   * @param maxPosition 最大持仓限制
   * @returns 库存状态
   */
  classify(tokenId: string, netShares: number, maxPosition: number): InventoryState {
    const inventoryBias = Math.abs(netShares) / maxPosition;

    if (inventoryBias < this.config.safeThreshold) {
      return InventoryState.SAFE;
    } else if (inventoryBias < this.config.warningThreshold) {
      return InventoryState.WARNING;
    } else if (inventoryBias < this.config.dangerThreshold) {
      return InventoryState.DANGER;
    } else {
      return InventoryState.CRITICAL;
    }
  }

  /**
   * 获取完整的库存信息
   * @param tokenId 市场ID
   * @param netShares 净持仓
   * @param maxPosition 最大持仓限制
   * @returns 库存信息
   */
  getInventoryInfo(tokenId: string, netShares: number, maxPosition: number): InventoryInfo {
    const inventoryBias = this.calculateInventoryBias(netShares, maxPosition);
    const state = this.classify(tokenId, netShares, maxPosition);

    return {
      tokenId,
      netShares,
      maxPosition,
      inventoryBias,
      state
    };
  }

  /**
   * 计算标准化库存偏斜
   * @param netShares 净持仓
   * @param maxPosition 最大持仓
   * @returns 库存偏斜 [-1, 1]
   */
  private calculateInventoryBias(netShares: number, maxPosition: number): number {
    const normalized = netShares / maxPosition;
    return Math.max(-1, Math.min(1, normalized));
  }

  /**
   * 获取状态对应的策略配置
   * @param state 库存状态
   * @param netShares 净持仓 (用于判断单边挂单方向)
   * @param maxPosition 最大持仓
   * @returns 策略配置
   */
  getStrategy(state: InventoryState, netShares: number = 0, maxPosition: number = 1): StrategyConfig {
    // 获取默认策略
    const defaultStrategy = this.DEFAULT_STRATEGIES[state];

    // 合并用户自定义配置
    const userConfig = this.config.defaultStrategies[state] || {};
    const strategy: StrategyConfig = {
      ...defaultStrategy,
      ...userConfig,
      asymSpread: {
        ...defaultStrategy.asymSpread,
        ...(userConfig.asymSpread || {})
      }
    };

    // 根据库存方向设置单边挂单
    if (netShares !== 0) {
      const inventoryBias = this.calculateInventoryBias(netShares, maxPosition);

      // 如果库存偏斜超过50%, 启用单边挂单
      if (Math.abs(inventoryBias) > 0.5) {
        if (inventoryBias > 0) {
          // 多头过多: 只允许卖单 (平仓)
          strategy.singleSide = 'SELL';
        } else {
          // 空头过多: 只允许买单 (平仓)
          strategy.singleSide = 'BUY';
        }
      } else {
        strategy.singleSide = undefined;
      }
    }

    // 如果禁用不对称价差, 清除相关配置
    if (!this.config.enableAsymSpread) {
      strategy.asymSpread = undefined;
    }

    return strategy;
  }

  /**
   * 综合多个市场的库存状态
   * @param inventories 多个市场的库存信息列表
   * @returns 全局库存状态
   */
  classifyGlobal(inventories: InventoryInfo[]): InventoryState {
    if (inventories.length === 0) {
      return InventoryState.SAFE;
    }

    // 计算平均库存偏斜
    const avgBias = inventories.reduce((sum, info) => sum + Math.abs(info.inventoryBias), 0) / inventories.length;

    // 检查是否有任何市场处于CRITICAL状态
    const hasCritical = inventories.some(info => info.state === InventoryState.CRITICAL);
    if (hasCritical) {
      return InventoryState.CRITICAL;
    }

    // 检查是否有多个市场处于DANGER状态
    const dangerCount = inventories.filter(info => info.state === InventoryState.DANGER).length;
    if (dangerCount >= 2 || avgBias > this.config.dangerThreshold) {
      return InventoryState.DANGER;
    }

    // 检查是否有多个市场处于WARNING状态
    const warningCount = inventories.filter(info => info.state === InventoryState.WARNING).length;
    if (warningCount >= 3 || avgBias > this.config.warningThreshold) {
      return InventoryState.WARNING;
    }

    // 检查平均偏斜
    if (avgBias > this.config.safeThreshold) {
      return InventoryState.WARNING;
    }

    return InventoryState.SAFE;
  }

  /**
   * 更新分类器配置
   * @param config 新配置
   */
  updateConfig(config: Partial<ClassifierConfig>): void {
    if (config.safeThreshold !== undefined) {
      this.config.safeThreshold = config.safeThreshold;
    }
    if (config.warningThreshold !== undefined) {
      this.config.warningThreshold = config.warningThreshold;
    }
    if (config.dangerThreshold !== undefined) {
      this.config.dangerThreshold = config.dangerThreshold;
    }
    if (config.enableAsymSpread !== undefined) {
      this.config.enableAsymSpread = config.enableAsymSpread;
    }
    if (config.defaultStrategies) {
      Object.assign(this.config.defaultStrategies, config.defaultStrategies);
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): Required<ClassifierConfig> {
    return { ...this.config };
  }

  /**
   * 判断是否应该触发警报
   * @param state 库存状态
   * @returns 是否应该警报
   */
  shouldAlert(state: InventoryState): boolean {
    return state === InventoryState.DANGER || state === InventoryState.CRITICAL;
  }

  /**
   * 判断是否应该暂停挂单
   * @param state 库存状态
   * @returns 是否应该暂停
   */
  shouldPauseOrders(state: InventoryState): boolean {
    return state === InventoryState.CRITICAL;
  }

  /**
   * 判断是否应该强制平仓
   * @param state 库存状态
   * @returns 是否应该平仓
   */
  shouldForceFlatten(state: InventoryState): boolean {
    return state === InventoryState.CRITICAL;
  }

  /**
   * 获取状态的可读描述
   * @param state 库存状态
   * @returns 描述文本
   */
  getStateDescription(state: InventoryState): string {
    switch (state) {
      case InventoryState.SAFE:
        return '安全 - 库存平衡, 正常做市';
      case InventoryState.WARNING:
        return '警告 - 库存轻微偏斜, 谨慎挂单';
      case InventoryState.DANGER:
        return '危险 - 库存严重偏斜, 减少挂单';
      case InventoryState.CRITICAL:
        return '严重 - 库存极度偏斜, 暂停挂单并平仓';
      default:
        return '未知状态';
    }
  }
}
