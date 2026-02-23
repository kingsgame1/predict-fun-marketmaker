/**
 * 🔍 配置验证系统
 *
 * 启动时验证所有配置参数，防止错误配置导致运行时错误
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { Config } from './types.js';

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * 验证错误
 */
export interface ValidationError {
  category: string;
  field: string;
  message: string;
  severity: 'critical' | 'high' | 'medium';
}

/**
 * 验证警告
 */
export interface ValidationWarning {
  category: string;
  field: string;
  message: string;
  recommendation: string;
}

/**
 * 配置验证器
 */
export class ConfigValidator {
  /**
   * 验证配置
   */
  validate(config: Partial<Config>): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // 1. API配置验证
    this.validateAPIConfig(config, errors, warnings);

    // 2. 钱包配置验证
    this.validateWalletConfig(config, errors, warnings);

    // 3. 市场做市配置验证
    this.validateMarketMakerConfig(config, errors, warnings);

    // 4. 风险控制配置验证
    this.validateRiskConfig(config, errors, warnings);

    // 5. 套利配置验证
    this.validateArbitrageConfig(config, errors, warnings);

    // 6. 高频配置验证
    this.validateHighFrequencyConfig(config, errors, warnings);

    // 7. 网络配置验证
    this.validateNetworkConfig(config, errors, warnings);

    // 8. 日志配置验证
    this.validateLoggingConfig(config, errors, warnings);

    const criticalErrors = errors.filter(e => e.severity === 'critical');
    const valid = criticalErrors.length === 0;

    return { valid, errors, warnings };
  }

  /**
   * 验证API配置
   */
  private validateAPIConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // API Base URL
    if (!config.apiUrl) {
      errors.push({
        category: 'API',
        field: 'apiUrl',
        message: 'API URL未配置',
        severity: 'critical'
      });
    } else if (!this.isValidUrl(config.apiUrl)) {
      errors.push({
        category: 'API',
        field: 'apiUrl',
        message: `API URL格式无效: ${config.apiUrl}`,
        severity: 'critical'
      });
    }

    // API Key
    if (!config.apiKey) {
      errors.push({
        category: 'API',
        field: 'apiKey',
        message: 'API Key未配置',
        severity: 'critical'
      });
    } else if (config.apiKey.length < 10) {
      errors.push({
        category: 'API',
        field: 'apiKey',
        message: 'API Key长度似乎不正确（通常>30字符）',
        severity: 'high'
      });
    }

    // JWT Token
    if (!config.jwtToken) {
      warnings.push({
        category: 'API',
        field: 'jwtToken',
        message: 'JWT Token未配置，可能无法执行交易',
        recommendation: '配置JWT_TOKEN环境变量'
      });
    }

    // RPC URL
    if (!config.rpcUrl) {
      errors.push({
        category: 'API',
        field: 'rpcUrl',
        message: 'RPC URL未配置',
        severity: 'critical'
      });
    } else if (!config.rpcUrl.startsWith('http')) {
      errors.push({
        category: 'API',
        field: 'rpcUrl',
        message: `RPC URL格式无效: ${config.rpcUrl}`,
        severity: 'critical'
      });
    }
  }

  /**
   * 验证钱包配置
   */
  private validateWalletConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // Private Key
    if (!config.privateKey) {
      errors.push({
        category: 'Wallet',
        field: 'privateKey',
        message: '私钥未配置',
        severity: 'critical'
      });
    } else if (config.privateKey.length !== 64 && !config.privateKey.startsWith('0x')) {
      warnings.push({
        category: 'Wallet',
        field: 'privateKey',
        message: '私钥格式可能不正确',
        recommendation: '私钥应该是64位十六进制字符串'
      });
    }

    // 账户地址
    if (!config.predictAddress) {
      warnings.push({
        category: 'Wallet',
        field: 'predictAddress',
        message: 'Predict账户地址未配置',
        recommendation: '配置PREDICT_ACCOUNT_ADDRESS环境变量'
      });
    } else if (!config.predictAddress.startsWith('0x') || config.predictAddress.length !== 42) {
      errors.push({
        category: 'Wallet',
        field: 'predictAddress',
        message: '账户地址格式无效（应为0x开头的42字符）',
        severity: 'high'
      });
    }
  }

  /**
   * 验证市场做市配置
   */
  private validateMarketMakerConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 订单大小
    if (config.orderSize !== undefined) {
      if (config.orderSize <= 0) {
        errors.push({
          category: 'MarketMaker',
          field: 'orderSize',
          message: '订单大小必须大于0',
          severity: 'critical'
        });
      } else if (config.orderSize < 1) {
        warnings.push({
          category: 'MarketMaker',
          field: 'orderSize',
          message: '订单大小很小，可能无法成交',
          recommendation: '建议订单大小至少$1'
        });
      }
    }

    // 最大持仓
    if (config.maxPosition !== undefined) {
      if (config.maxPosition <= 0) {
        errors.push({
          category: 'MarketMaker',
          field: 'maxPosition',
          message: '最大持仓必须大于0',
          severity: 'critical'
        });
      } else if (config.maxPosition < 10) {
        warnings.push({
          category: 'MarketMaker',
          field: 'maxPosition',
          message: '最大持仓很小，可能限制盈利',
          recommendation: '建议最大持仓至少$10'
        });
      }
    }

    // 价差检查
    if (config.spread !== undefined) {
      if (config.spread < 0 || config.spread > 1) {
        errors.push({
          category: 'MarketMaker',
          field: 'spread',
          message: '价差必须在0-1之间（0%-100%）',
          severity: 'critical'
        });
      } else if (config.spread < 0.005) {
        warnings.push({
          category: 'MarketMaker',
          field: 'spread',
          message: '价差很小（<0.5%），可能导致频繁成交',
          recommendation: '建议价差至少0.5%'
        });
      } else if (config.spread > 0.1) {
        warnings.push({
          category: 'MarketMaker',
          field: 'spread',
          message: '价差很大（>10%），可能很少成交',
          recommendation: '建议价差在1-5%之间'
        });
      }
    }

    // 反填充机制
    if (config.antiFillBps !== undefined) {
      if (config.antiFillBps < 0 || config.antiFillBps > 100) {
        errors.push({
          category: 'MarketMaker',
          field: 'antiFillBps',
          message: '反填充BPS必须在0-100之间',
          severity: 'high'
        });
      }
    }
  }

  /**
   * 验证风险控制配置
   */
  private validateRiskConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 每日最大亏损
    if (config.maxDailyLoss !== undefined) {
      if (config.maxDailyLoss < 0) {
        errors.push({
          category: 'Risk',
          field: 'maxDailyLoss',
          message: '每日最大亏损不能为负数',
          severity: 'critical'
        });
      } else if (config.maxDailyLoss > 1000) {
        warnings.push({
          category: 'Risk',
          field: 'maxDailyLoss',
          message: '每日最大亏损设置很大（>$1000）',
          recommendation: '考虑降低到更安全的水平，如$200'
        });
      }
    }

    // 最大每日亏损百分比
    if (config.maxDailyLossPercent !== undefined) {
      if (config.maxDailyLossPercent < 0 || config.maxDailyLossPercent > 1) {
        errors.push({
          category: 'Risk',
          field: 'maxDailyLossPercent',
          message: '每日最大亏损百分比必须在0-100%之间',
          severity: 'critical'
        });
      } else if (config.maxDailyLossPercent > 0.5) {
        warnings.push({
          category: 'Risk',
          field: 'maxDailyLossPercent',
          message: '每日最大亏损百分比很高（>50%）',
          recommendation: '建议控制在20-30%以内'
        });
      }
    }

    // 仓位限制
    if (config.maxPositionPercent !== undefined) {
      if (config.maxPositionPercent < 0 || config.maxPositionPercent > 1) {
        errors.push({
          category: 'Risk',
          field: 'maxPositionPercent',
          message: '最大仓位百分比必须在0-100%之间',
          severity: 'critical'
        });
      } else if (config.maxPositionPercent > 0.3) {
        warnings.push({
          category: 'Risk',
          field: 'maxPositionPercent',
          message: '最大仓位百分比很高（>30%）',
          recommendation: '建议控制在10-20%以内'
        });
      }
    }
  }

  /**
   * 验证套利配置
   */
  private validateArbitrageConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 最小利润百分比
    if (config.minProfitPercent !== undefined) {
      if (config.minProfitPercent < 0) {
        errors.push({
          category: 'Arbitrage',
          field: 'minProfitPercent',
          message: '最小利润百分比不能为负数',
          severity: 'critical'
        });
      } else if (config.minProfitPercent > 10) {
        warnings.push({
          category: 'Arbitrage',
          field: 'minProfitPercent',
          message: '最小利润百分比很高（>10%），可能很难找到机会',
          recommendation: '建议设置在1-3%之间'
        });
      }
    }

    // 最小流动性
    if (config.minLiquidityUsd !== undefined) {
      if (config.minLiquidityUsd < 0) {
        errors.push({
          category: 'Arbitrage',
          field: 'minLiquidityUsd',
          message: '最小流动性不能为负数',
          severity: 'critical'
        });
      } else if (config.minLiquidityUsd > 10000) {
        warnings.push({
          category: 'Arbitrage',
          field: 'minLiquidityUsd',
          message: '最小流动性要求很高（>$10k），会过滤很多机会',
          recommendation: '考虑降低到$1000-$5000'
        });
      }
    }

    // 最大滑点
    if (config.maxSlippagePercent !== undefined) {
      if (config.maxSlippagePercent < 0 || config.maxSlippagePercent > 100) {
        errors.push({
          category: 'Arbitrage',
          field: 'maxSlippagePercent',
          message: '最大滑点百分比必须在0-100%之间',
          severity: 'critical'
        });
      } else if (config.maxSlippagePercent > 5) {
        warnings.push({
          category: 'Arbitrage',
          field: 'maxSlippagePercent',
          message: '最大滑点很高（>5%），可能导致大额亏损',
          recommendation: '建议控制在1-2%以内'
        });
      }
    }
  }

  /**
   * 验证高频配置
   */
  private validateHighFrequencyConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 高频扫描间隔
    if (config.hfScanIntervalMs !== undefined) {
      if (config.hfScanIntervalMs < 100) {
        errors.push({
          category: 'HighFrequency',
          field: 'hfScanIntervalMs',
          message: '扫描间隔太短（<100ms），可能被API限流',
          severity: 'high'
        });
      } else if (config.hfScanIntervalMs < 500) {
        warnings.push({
          category: 'HighFrequency',
          field: 'hfScanIntervalMs',
          message: '扫描间隔很短，可能触发API限流',
          recommendation: '建议至少500ms'
        });
      }
    }

    // 高频最大仓位
    if (config.hfMaxPositionCount !== undefined) {
      if (config.hfMaxPositionCount < 1) {
        errors.push({
          category: 'HighFrequency',
          field: 'hfMaxPositionCount',
          message: '最大持仓数量必须至少为1',
          severity: 'critical'
        });
      } else if (config.hfMaxPositionCount > 20) {
        warnings.push({
          category: 'HighFrequency',
          field: 'hfMaxPositionCount',
          message: '最大持仓数量很大（>20），风险很高',
          recommendation: '建议控制在10个以内'
        });
      }
    }
  }

  /**
   * 验证网络配置
   */
  private validateNetworkConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 网络超时
    if (config.networkTimeoutMs !== undefined) {
      if (config.networkTimeoutMs < 1000) {
        warnings.push({
          category: 'Network',
          field: 'networkTimeoutMs',
          message: '网络超时时间很短（<1s），可能频繁超时',
          recommendation: '建议至少5秒'
        });
      } else if (config.networkTimeoutMs > 60000) {
        warnings.push({
          category: 'Network',
          field: 'networkTimeoutMs',
          message: '网络超时时间很长（>60s），可能导致响应缓慢',
          recommendation: '建议10-30秒'
        });
      }
    }

    // 最大重试次数
    if (config.maxNetworkRetries !== undefined) {
      if (config.maxNetworkRetries < 0) {
        errors.push({
          category: 'Network',
          field: 'maxNetworkRetries',
          message: '最大重试次数不能为负数',
          severity: 'critical'
        });
      } else if (config.maxNetworkRetries > 10) {
        warnings.push({
          category: 'Network',
          field: 'maxNetworkRetries',
          message: '最大重试次数很多（>10），可能延迟太久',
          recommendation: '建议3-5次'
        });
      }
    }

    // API限流
    if (config.apiRateLimit !== undefined) {
      if (config.apiRateLimit < 1) {
        errors.push({
          category: 'Network',
          field: 'apiRateLimit',
          message: 'API限流必须至少为1次/秒',
          severity: 'critical'
        });
      } else if (config.apiRateLimit > 100) {
        warnings.push({
          category: 'Network',
          field: 'apiRateLimit',
          message: 'API限流很高（>100次/秒），可能被封禁',
          recommendation: '建议10-50次/秒'
        });
      }
    }
  }

  /**
   * 验证日志配置
   */
  private validateLoggingConfig(
    config: Partial<Config>,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    // 日志级别
    if (config.logLevel) {
      const validLevels = ['debug', 'info', 'warn', 'error', 'silent'];
      if (!validLevels.includes(config.logLevel)) {
        errors.push({
          category: 'Logging',
          field: 'logLevel',
          message: `日志级别无效: ${config.logLevel}，必须是: ${validLevels.join(', ')}`,
          severity: 'critical'
        });
      }
    }

    // 保存执行统计
    if (config.saveExecutionStats !== undefined) {
      if (config.saveExecutionStats && !config.dataDir) {
        warnings.push({
          category: 'Logging',
          field: 'saveExecutionStats',
          message: '启用了执行统计保存，但未设置数据目录',
          recommendation: '配置DATA_DIR环境变量'
        });
      }
    }
  }

  /**
   * 检查URL是否有效
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 生成验证报告
   */
  generateReport(result: ValidationResult): string {
    let report = '\n';
    report += '='.repeat(80) + '\n';
    report += '🔍 配置验证报告\n';
    report += '='.repeat(80) + '\n\n';

    // 总体状态
    if (result.valid) {
      report += '✅ 配置验证通过\n\n';
    } else {
      report += '❌ 配置验证失败 - 发现严重错误\n\n';
    }

    // 错误
    if (result.errors.length > 0) {
      report += '❌ 错误\n';
      report += '-'.repeat(80) + '\n';

      const critical = result.errors.filter(e => e.severity === 'critical');
      const high = result.errors.filter(e => e.severity === 'high');
      const medium = result.errors.filter(e => e.severity === 'medium');

      if (critical.length > 0) {
        report += `\n🔴 严重错误 (${critical.length})\n`;
        for (const error of critical) {
          report += `  [${error.category}] ${error.field}\n`;
          report += `    ${error.message}\n`;
        }
      }

      if (high.length > 0) {
        report += `\n⚠️ 高级错误 (${high.length})\n`;
        for (const error of high) {
          report += `  [${error.category}] ${error.field}\n`;
          report += `    ${error.message}\n`;
        }
      }

      if (medium.length > 0) {
        report += `\n⚡ 中级错误 (${medium.length})\n`;
        for (const error of medium) {
          report += `  [${error.category}] ${error.field}\n`;
          report += `    ${error.message}\n`;
        }
      }

      report += '\n';
    }

    // 警告
    if (result.warnings.length > 0) {
      report += '⚠️ 警告\n';
      report += '-'.repeat(80) + '\n';

      const grouped = new Map<string, ValidationWarning[]>();
      for (const warning of result.warnings) {
        if (!grouped.has(warning.category)) {
          grouped.set(warning.category, []);
        }
        grouped.get(warning.category)!.push(warning);
      }

      for (const [category, warnings] of grouped) {
        report += `\n[${category}] (${warnings.length})\n`;
        for (const warning of warnings) {
          report += `  ${warning.field}: ${warning.message}\n`;
          report += `    💡 建议: ${warning.recommendation}\n`;
        }
      }

      report += '\n';
    }

    if (result.valid && result.warnings.length === 0) {
      report += '✨ 配置完美，没有任何问题！\n';
    } else if (result.valid) {
      report += '✅ 配置可以运行，但建议查看上述警告以优化性能\n';
    } else {
      report += '❌ 请修复上述严重错误后再运行\n';
    }

    report += '='.repeat(80) + '\n';

    return report;
  }
}

/**
 * 全局验证器实例
 */
let globalValidator: ConfigValidator | null = null;

/**
 * 获取全局验证器
 */
export function getGlobalValidator(): ConfigValidator {
  if (!globalValidator) {
    globalValidator = new ConfigValidator();
  }
  return globalValidator;
}

/**
 * 便捷函数：验证配置
 */
export function validateConfig(config: Partial<Config>): ValidationResult {
  return getGlobalValidator().validate(config);
}

/**
 * 便捷函数：验证并生成报告
 */
export function validateConfigAndReport(config: Partial<Config>): { valid: boolean; report: string } {
  const validator = getGlobalValidator();
  const result = validator.validate(config);
  const report = validator.generateReport(result);
  return { valid: result.valid, report };
}
