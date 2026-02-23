/**
 * 📊 执行统计追踪系统
 *
 * 实时追踪套利执行的各项指标，用于性能分析和策略优化
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

/**
 * 单次执行记录
 */
export interface ExecutionRecord {
  timestamp: number;
  marketId: string;
  marketTitle: string;
  strategy: string;

  // 执行结果
  success: boolean;
  error?: string;

  // 财务数据
  profitUsd: number;
  profitPercent: number;
  capitalUsed: number;

  // 执行细节
  actualSlippagePercent: number;
  executionTimeMs: number;

  // 机会质量
  qualityScore: number;
  riskLevel: number;

  // 订单详情
  orders: {
    tokenId: string;
    side: 'buy' | 'sell';
    price: number;
    amount: number;
    filled: boolean;
  }[];
}

/**
 * 汇总统计
 */
export interface AggregateStats {
  // 总体统计
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;

  // 财务统计
  totalProfitUsd: number;
  totalLossUsd: number;
  netProfitUsd: number;
  avgProfitUsd: number;
  avgProfitPercent: number;
  maxProfitUsd: number;
  maxLossUsd: number;

  // 执行统计
  avgExecutionTimeMs: number;
  avgSlippagePercent: number;
  maxSlippagePercent: number;

  // 资金使用
  totalCapitalUsed: number;
  avgCapitalUsed: number;
  capitalEfficiency: number; // netProfit / totalCapital

  // 按策略统计
  byStrategy: {
    [strategy: string]: {
      totalExecutions: number;
      successRate: number;
      totalProfit: number;
      avgProfit: number;
    };
  };

  // 按市场统计
  byMarket: {
    [marketId: string]: {
      marketTitle: string;
      totalExecutions: number;
      successRate: number;
      totalProfit: number;
    };
  };

  // 时间统计
  startTime: number;
  endTime: number;
  duration: number;
}

/**
 * 绩效指标
 */
export interface PerformanceMetrics {
  // 收益指标
  totalReturn: number;           // 总回报
  sharpeRatio: number;           // 夏普比率
  sortinoRatio: number;          // 索提诺比率
  maxDrawdown: number;           // 最大回撤
  winRate: number;               // 胜率

  // 风险指标
  avgVolatility: number;         // 平均波动率
  valueAtRisk: number;           // 风险价值(VaR)
  expectedShortfall: number;     // 期望短缺(ES)

  // 效率指标
  profitFactor: number;          // 盈利因子 (总盈利/总亏损)
  expectancy: number;            // 期望值
  avgHoldingPeriod: number;      // 平均持仓时间

  // 频率指标
  executionsPerHour: number;     // 每小时执行次数
  profitPerHour: number;         // 每小时利润
}

/**
 * 执行统计追踪器
 */
export class ExecutionStatsTracker {
  private records: ExecutionRecord[] = [];
  private dataPath: string;

  constructor(dataDir: string = './data') {
    this.dataPath = path.join(dataDir, 'execution-stats.json');
    this.loadFromFile();
  }

  /**
   * 记录执行
   */
  recordExecution(record: ExecutionRecord): void {
    this.records.push(record);
    this.saveToFile();
  }

  /**
   * 获取汇总统计
   */
  getAggregateStats(): AggregateStats {
    if (this.records.length === 0) {
      return this.getEmptyStats();
    }

    const successful = this.records.filter(r => r.success);
    const failed = this.records.filter(r => !r.success);

    const totalProfit = successful.reduce((sum, r) => sum + r.profitUsd, 0);
    const totalLoss = Math.abs(failed.filter(r => r.profitUsd < 0).reduce((sum, r) => sum + r.profitUsd, 0));
    const netProfit = totalProfit - totalLoss;

    const totalCapital = this.records.reduce((sum, r) => sum + r.capitalUsed, 0);

    // 按策略分组
    const byStrategy: AggregateStats['byStrategy'] = {};
    for (const record of this.records) {
      if (!byStrategy[record.strategy]) {
        byStrategy[record.strategy] = {
          totalExecutions: 0,
          successRate: 0,
          totalProfit: 0,
          avgProfit: 0
        };
      }

      const stats = byStrategy[record.strategy];
      stats.totalExecutions++;
      stats.totalProfit += record.profitUsd;
    }

    // 计算策略统计
    for (const strategy in byStrategy) {
      const stats = byStrategy[strategy];
      const strategyRecords = this.records.filter(r => r.strategy === strategy);
      const successfulCount = strategyRecords.filter(r => r.success).length;
      stats.successRate = successfulCount / stats.totalExecutions;
      stats.avgProfit = stats.totalProfit / stats.totalExecutions;
    }

    // 按市场分组
    const byMarket: AggregateStats['byMarket'] = {};
    for (const record of this.records) {
      if (!byMarket[record.marketId]) {
        byMarket[record.marketId] = {
          marketTitle: record.marketTitle,
          totalExecutions: 0,
          successRate: 0,
          totalProfit: 0
        };
      }

      const stats = byMarket[record.marketId];
      stats.totalExecutions++;
      stats.totalProfit += record.profitUsd;
    }

    // 计算市场统计
    for (const marketId in byMarket) {
      const stats = byMarket[marketId];
      const marketRecords = this.records.filter(r => r.marketId === marketId);
      const successfulCount = marketRecords.filter(r => r.success).length;
      stats.successRate = successfulCount / stats.totalExecutions;
    }

    return {
      totalExecutions: this.records.length,
      successfulExecutions: successful.length,
      failedExecutions: failed.length,
      successRate: successful.length / this.records.length,

      totalProfitUsd: totalProfit,
      totalLossUsd: totalLoss,
      netProfitUsd: netProfit,
      avgProfitUsd: netProfit / this.records.length,
      avgProfitPercent: successful.reduce((sum, r) => sum + r.profitPercent, 0) / successful.length,
      maxProfitUsd: Math.max(...successful.map(r => r.profitUsd)),
      maxLossUsd: Math.min(...failed.map(r => r.profitUsd)),

      avgExecutionTimeMs: this.records.reduce((sum, r) => sum + r.executionTimeMs, 0) / this.records.length,
      avgSlippagePercent: this.records.reduce((sum, r) => sum + r.actualSlippagePercent, 0) / this.records.length,
      maxSlippagePercent: Math.max(...this.records.map(r => r.actualSlippagePercent)),

      totalCapitalUsed: totalCapital,
      avgCapitalUsed: totalCapital / this.records.length,
      capitalEfficiency: totalCapital > 0 ? netProfit / totalCapital : 0,

      byStrategy,
      byMarket,

      startTime: this.records[0].timestamp,
      endTime: this.records[this.records.length - 1].timestamp,
      duration: this.records[this.records.length - 1].timestamp - this.records[0].timestamp
    };
  }

  /**
   * 获取绩效指标
   */
  getPerformanceMetrics(): PerformanceMetrics | null {
    if (this.records.length < 2) {
      return null;
    }

    const stats = this.getAggregateStats();
    const profits = this.records.filter(r => r.success).map(r => r.profitUsd);

    // 计算夏普比率
    const avgProfit = stats.avgProfitUsd;
    const stdDev = this.calculateStdDev(profits);
    const sharpeRatio = stdDev > 0 ? avgProfit / stdDev : 0;

    // 计算最大回撤
    const cumulativeProfits = this.calculateCumulativeProfits();
    const maxDrawdown = this.calculateMaxDrawdown(cumulativeProfits);

    // 计算VaR (95%置信度)
    const sortedProfits = [...profits].sort((a, b) => a - b);
    const varIndex = Math.floor(sortedProfits.length * 0.05);
    const valueAtRisk = sortedProfits[varIndex];

    // 计算期望短缺
    const tailLosses = sortedProfits.slice(0, varIndex);
    const expectedShortfall = tailLosses.reduce((sum, p) => sum + p, 0) / tailLosses.length;

    // 计算盈利因子
    const profitFactor = stats.totalLossUsd > 0 ? stats.totalProfitUsd / stats.totalLossUsd : stats.totalProfitUsd;

    // 计算期望值
    const winRate = stats.successRate;
    const avgWin = profits.reduce((sum, p) => sum + p, 0) / profits.length;
    const avgLoss = Math.abs(this.records.filter(r => !r.success && r.profitUsd < 0)
      .reduce((sum, r) => sum + r.profitUsd, 0) / (this.records.length - profits.length) || 0);
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    // 计算频率指标
    const durationHours = stats.duration / (1000 * 60 * 60);
    const executionsPerHour = stats.totalExecutions / durationHours;
    const profitPerHour = stats.netProfitUsd / durationHours;

    return {
      totalReturn: stats.netProfitUsd,
      sharpeRatio,
      sortinoRatio: sharpeRatio * 1.5, // 简化计算
      maxDrawdown,
      winRate,

      avgVolatility: stdDev,
      valueAtRisk,
      expectedShortfall,

      profitFactor,
      expectancy,
      avgHoldingPeriod: stats.avgExecutionTimeMs / 1000, // 转换为秒

      executionsPerHour,
      profitPerHour
    };
  }

  /**
   * 获取最近N条记录
   */
  getRecentRecords(count: number): ExecutionRecord[] {
    return this.records.slice(-count);
  }

  /**
   * 获取指定时间范围的记录
   */
  getRecordsByTimeRange(startTime: number, endTime: number): ExecutionRecord[] {
    return this.records.filter(r => r.timestamp >= startTime && r.timestamp <= endTime);
  }

  /**
   * 获取指定策略的记录
   */
  getRecordsByStrategy(strategy: string): ExecutionRecord[] {
    return this.records.filter(r => r.strategy === strategy);
  }

  /**
   * 生成报告
   */
  generateReport(): string {
    const stats = this.getAggregateStats();
    const metrics = this.getPerformanceMetrics();

    let report = '\n';
    report += '='.repeat(80) + '\n';
    report += '📊 执行统计报告\n';
    report += '='.repeat(80) + '\n\n';

    // 总体统计
    report += '📈 总体统计\n';
    report += '-'.repeat(80) + '\n';
    report += `总执行次数: ${stats.totalExecutions}\n`;
    report += `成功次数: ${stats.successfulExecutions}\n`;
    report += `失败次数: ${stats.failedExecutions}\n`;
    report += `成功率: ${(stats.successRate * 100).toFixed(2)}%\n\n`;

    // 财务统计
    report += '💰 财务统计\n';
    report += '-'.repeat(80) + '\n';
    report += `总盈利: $${stats.totalProfitUsd.toFixed(2)}\n`;
    report += `总亏损: $${stats.totalLossUsd.toFixed(2)}\n`;
    report += `净盈利: $${stats.netProfitUsd.toFixed(2)}\n`;
    report += `平均盈利: $${stats.avgProfitUsd.toFixed(2)}\n`;
    report += `平均盈利%: ${stats.avgProfitPercent.toFixed(2)}%\n`;
    report += `最大盈利: $${stats.maxProfitUsd.toFixed(2)}\n`;
    report += `最大亏损: $${stats.maxLossUsd.toFixed(2)}\n\n`;

    // 执行统计
    report += '⚡ 执行统计\n';
    report += '-'.repeat(80) + '\n';
    report += `平均执行时间: ${stats.avgExecutionTimeMs.toFixed(0)}ms\n`;
    report += `平均滑点: ${(stats.avgSlippagePercent * 100).toFixed(3)}%\n`;
    report += `最大滑点: ${(stats.maxSlippagePercent * 100).toFixed(3)}%\n\n`;

    // 资金使用
    report += '💎 资金效率\n';
    report += '-'.repeat(80) + '\n';
    report += `总使用资金: $${stats.totalCapitalUsed.toFixed(2)}\n`;
    report += `平均使用资金: $${stats.avgCapitalUsed.toFixed(2)}\n`;
    report += `资金效率: ${(stats.capitalEfficiency * 100).toFixed(2)}%\n\n`;

    // 绩效指标
    if (metrics) {
      report += '🎯 绩效指标\n';
      report += '-'.repeat(80) + '\n';
      report += `夏普比率: ${metrics.sharpeRatio.toFixed(3)}\n`;
      report += `最大回撤: $${metrics.maxDrawdown.toFixed(2)}\n`;
      report += `盈利因子: ${metrics.profitFactor.toFixed(2)}\n`;
      report += `期望值: $${metrics.expectancy.toFixed(2)}\n`;
      report += `每小时执行: ${metrics.executionsPerHour.toFixed(2)}次\n`;
      report += `每小时利润: $${metrics.profitPerHour.toFixed(2)}\n\n`;
    }

    // 按策略统计
    report += '📋 按策略统计\n';
    report += '-'.repeat(80) + '\n';
    for (const [strategy, stat] of Object.entries(stats.byStrategy)) {
      report += `\n${strategy}:\n`;
      report += `  执行次数: ${stat.totalExecutions}\n`;
      report += `  成功率: ${(stat.successRate * 100).toFixed(2)}%\n`;
      report += `  总盈利: $${stat.totalProfit.toFixed(2)}\n`;
      report += `  平均盈利: $${stat.avgProfit.toFixed(2)}\n`;
    }
    report += '\n';

    // 时间范围
    const startDate = new Date(stats.startTime).toLocaleString('zh-CN');
    const endDate = new Date(stats.endTime).toLocaleString('zh-CN');
    const durationHours = (stats.duration / (1000 * 60 * 60)).toFixed(1);

    report += '⏰ 时间范围\n';
    report += '-'.repeat(80) + '\n';
    report += `开始时间: ${startDate}\n`;
    report += `结束时间: ${endDate}\n`;
    report += `持续时间: ${durationHours}小时\n\n`;

    report += '='.repeat(80) + '\n';

    return report;
  }

  /**
   * 导出CSV
   */
  exportCSV(outputPath: string): void {
    if (this.records.length === 0) {
      console.log('没有数据可导出');
      return;
    }

    const headers = [
      'timestamp',
      'marketId',
      'marketTitle',
      'strategy',
      'success',
      'profitUsd',
      'profitPercent',
      'capitalUsed',
      'executionTimeMs',
      'slippagePercent'
    ];

    const rows = this.records.map(r => [
      new Date(r.timestamp).toISOString(),
      r.marketId,
      r.marketTitle,
      r.strategy,
      r.success ? 'Yes' : 'No',
      r.profitUsd.toFixed(2),
      r.profitPercent.toFixed(2),
      r.capitalUsed.toFixed(2),
      r.executionTimeMs,
      r.actualSlippagePercent.toFixed(4)
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    fs.writeFileSync(outputPath, csv);
    console.log(`✅ 已导出到: ${outputPath}`);
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.records = [];
    this.saveToFile();
  }

  /**
   * 从文件加载
   */
  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = fs.readFileSync(this.dataPath, 'utf-8');
        this.records = JSON.parse(data);
        console.log(`✅ 加载了 ${this.records.length} 条执行记录`);
      }
    } catch (error) {
      console.warn('⚠️ 加载执行记录失败:', error);
      this.records = [];
    }
  }

  /**
   * 保存到文件
   */
  private saveToFile(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.dataPath, JSON.stringify(this.records, null, 2));
    } catch (error) {
      console.error('❌ 保存执行记录失败:', error);
    }
  }

  /**
   * 计算标准差
   */
  private calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;

    return Math.sqrt(variance);
  }

  /**
   * 计算累计收益
   */
  private calculateCumulativeProfits(): number[] {
    const cumulative: number[] = [];
    let sum = 0;

    for (const record of this.records) {
      sum += record.profitUsd;
      cumulative.push(sum);
    }

    return cumulative;
  }

  /**
   * 计算最大回撤
   */
  private calculateMaxDrawdown(cumulativeProfits: number[]): number {
    let maxDrawdown = 0;
    let peak = cumulativeProfits[0];

    for (const profit of cumulativeProfits) {
      if (profit > peak) {
        peak = profit;
      }

      const drawdown = peak - profit;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * 获取空统计
   */
  private getEmptyStats(): AggregateStats {
    return {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      totalProfitUsd: 0,
      totalLossUsd: 0,
      netProfitUsd: 0,
      avgProfitUsd: 0,
      avgProfitPercent: 0,
      maxProfitUsd: 0,
      maxLossUsd: 0,
      avgExecutionTimeMs: 0,
      avgSlippagePercent: 0,
      maxSlippagePercent: 0,
      totalCapitalUsed: 0,
      avgCapitalUsed: 0,
      capitalEfficiency: 0,
      byStrategy: {},
      byMarket: {},
      startTime: Date.now(),
      endTime: Date.now(),
      duration: 0
    };
  }
}

/**
 * 全局实例
 */
let globalTracker: ExecutionStatsTracker | null = null;

/**
 * 获取全局追踪器
 */
export function getGlobalTracker(): ExecutionStatsTracker {
  if (!globalTracker) {
    globalTracker = new ExecutionStatsTracker();
  }
  return globalTracker;
}

/**
 * 便捷函数：记录执行
 */
export function recordExecution(record: ExecutionRecord): void {
  getGlobalTracker().recordExecution(record);
}

/**
 * 便捷函数：生成报告
 */
export function generateStatsReport(): string {
  return getGlobalTracker().generateReport();
}
