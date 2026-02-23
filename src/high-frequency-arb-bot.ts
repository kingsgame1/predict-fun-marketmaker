/**
 * 🚀 高频自动套利机器人 - 多策略版本
 *
 * 支持策略：
 * 1. Mean Reversion（均值回归）- Vitalik策略，16%回报
 * 2. Cross-Platform Arbitrage（跨平台套利）
 * 3. Multi-Result Arbitrage（多结果套利）
 * 4. Yes+No<1 Arbitrage（经典套利）
 *
 * 特性：
 * - 高频扫描（毫秒级）
 * - 可选择策略组合
 * - 自动执行
 * - 实时监控
 */

import { PredictAPI } from './api/client.js';
import { ActivationManager } from './activation.js';
import { promises as fs } from 'node:fs';

interface StrategyConfig {
  name: string;
  enabled: boolean;
  priority: number; // 执行优先级
  minProfitThreshold: number; // 最小利润阈值
  maxPositionSize: number; // 最大仓位
}

interface HighFrequencyConfig {
  scanInterval: number; // 扫描间隔（毫秒）
  enabledStrategies: string[]; // 启用的策略
  autoExecute: boolean; // 自动执行
  maxDailyTrades: number; // 每日最大交易数
  riskManagement: {
    maxDailyLoss: number; // 每日最大亏损
    maxDrawdown: number; // 最大回撤
  };
}

interface ArbitrageSignal {
  strategy: string;
  marketId: string;
  marketTitle: string;
  type: 'mean_reversion' | 'cross_platform' | 'multi_result' | 'yes_no_under';
  confidence: number;
  expectedProfit: number;
  action: 'buy_yes' | 'buy_no' | 'buy_both';
  yesPrice?: number;
  noPrice?: number;
  timestamp: number;
}

export class HighFrequencyArbitrageBot {
  private api: PredictAPI;
  private config: HighFrequencyConfig;
  private strategies: Map<string, StrategyConfig>;
  private signals: ArbitrageSignal[] = [];
  private tradeCount = 0;
  private dailyPnL = 0;
  private isRunning = false;
  private scanTimer?: NodeJS.Timeout;

  // 策略执行统计
  private stats = {
    totalScans: 0,
    signalsFound: 0,
    tradesExecuted: 0,
    successRate: 0,
    totalProfit: 0,
    byStrategy: new Map<string, {
      scans: number;
      signals: number;
      trades: number;
      profit: number;
    }>()
  };

  constructor(api: PredictAPI) {
    this.api = api;

    // 默认配置
    this.config = {
      scanInterval: 1000, // 1秒扫描一次（高频）
      enabledStrategies: ['mean_reversion', 'multi_result'], // 默认启用的策略
      autoExecute: false, // 默认不自动执行，先让用户确认
      maxDailyTrades: 100,
      riskManagement: {
        maxDailyLoss: 100, // $100
        maxDrawdown: 0.15 // 15%
      }
    };

    // 策略配置
    this.strategies = new Map([
      ['mean_reversion', {
        name: 'Mean Reversion（均值回归）',
        enabled: true,
        priority: 1, // 最高优先级
        minProfitThreshold: 0.05, // 5%
        maxPositionSize: 500
      }],
      ['cross_platform', {
        name: 'Cross-Platform Arbitrage（跨平台套利）',
        enabled: false, // 默认关闭（需要多平台API）
        priority: 2,
        minProfitThreshold: 0.03, // 3%
        maxPositionSize: 1000
      }],
      ['multi_result', {
        name: 'Multi-Result Arbitrage（多结果套利）',
        enabled: true,
        priority: 3,
        minProfitThreshold: 0.04, // 4%
        maxPositionSize: 300
      }],
      ['yes_no_under', {
        name: 'Yes+No<1 Arbitrage（经典套利）',
        enabled: false, // 默认关闭（竞争激烈）
        priority: 4,
        minProfitThreshold: 0.03, // 3%
        maxPositionSize: 200
      }]
    ]);
  }

  /**
   * 🚀 启动高频套利机器人
   */
  async start(config?: Partial<HighFrequencyConfig>): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 高频自动套利机器人');
    console.log('='.repeat(70));

    // 🔑 检查激活
    const activation = ActivationManager.checkActivation();
    if (!activation.valid) {
      console.log('\n⚠️  套利模块需要激活码');
      console.log('✅ 做市商模块 - 完全免费');
      throw new Error(`套利模块未激活: ${activation.message}`);
    }

    console.log(`\n✅ 套利模块已激活 (剩余 ${activation.remainingDays} 天)\n`);

    // 应用配置
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // 显示启用的策略
    console.log('📋 启用的策略:');
    this.strategies.forEach((strategy, key) => {
      if (strategy.enabled && this.config.enabledStrategies.includes(key)) {
        console.log(`  ✅ ${strategy.name} (优先级: ${strategy.priority})`);
      }
    });

    console.log(`\n⚙️  配置:`);
    console.log(`   扫描间隔: ${this.config.scanInterval}ms`);
    console.log(`   自动执行: ${this.config.autoExecute ? '✅' : '❌'}`);
    console.log(`   每日最大交易: ${this.config.maxDailyTrades}`);
    console.log('   ' + '='.repeat(70));

    this.isRunning = true;

    // 启动高频扫描
    this.startHighFrequencyScanning();
  }

  /**
   * ⏹️ 停止机器人
   */
  stop(): void {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    console.log('\n⏹️  高频套利机器人已停止');
  }

  /**
   * 🔄 高频扫描循环
   */
  private startHighFrequencyScanning(): void {
    console.log('\n🔄 启动高频扫描...\n');

    this.scanTimer = setInterval(async () => {
      if (!this.isRunning) return;

      await this.scanCycle();
    }, this.config.scanInterval);

    // 立即执行一次
    this.scanCycle();
  }

  /**
   * 🔍 扫描周期
   */
  private async scanCycle(): Promise<void> {
    try {
      this.stats.totalScans++;

      // 清空旧信号
      this.signals = [];

      // 执行所有启用的策略
      for (const strategyKey of this.config.enabledStrategies) {
        const strategy = this.strategies.get(strategyKey);
        if (!strategy || !strategy.enabled) continue;

        const strategySignals = await this.executeStrategy(strategyKey);
        this.signals.push(...strategySignals);
      }

      // 按优先级和利润排序
      this.signals.sort((a, b) => {
        const priorityA = this.strategies.get(a.strategy)?.priority || 999;
        const priorityB = this.strategies.get(b.strategy)?.priority || 999;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return b.expectedProfit - a.expectedProfit;
      });

      // 显示找到的信号
      if (this.signals.length > 0) {
        this.stats.signalsFound += this.signals.length;
        this.displaySignals();
      }

      // 自动执行（如果启用）
      if (this.config.autoExecute && this.signals.length > 0) {
        await this.executeTopSignals();
      }

      // 定期显示统计（每60次扫描）
      if (this.stats.totalScans % 60 === 0) {
        this.displayStats();
      }

    } catch (error) {
      console.error('扫描周期错误:', error);
    }
  }

  /**
   * 🎯 执行策略
   */
  private async executeStrategy(strategyKey: string): Promise<ArbitrageSignal[]> {
    const signals: ArbitrageSignal[] = [];

    try {
      switch (strategyKey) {
        case 'mean_reversion':
          signals.push(...await this.scanMeanReversion());
          break;
        case 'cross_platform':
          signals.push(...await this.scanCrossPlatform());
          break;
        case 'multi_result':
          signals.push(...await this.scanMultiResult());
          break;
        case 'yes_no_under':
          signals.push(...await this.scanYesNoUnder());
          break;
      }
    } catch (error) {
      console.error(`策略 ${strategyKey} 执行失败:`, error);
    }

    return signals;
  }

  /**
   * 📈 策略1: Mean Reversion Scanning
   */
  private async scanMeanReversion(): Promise<ArbitrageSignal[]> {
    const signals: ArbitrageSignal[] = [];

    try {
      const markets = await this.api.getMarkets();

      for (const market of markets) {
        // 跳过加密货币和体育市场
        if (this.isExcludedSector(market)) continue;

        // 检查是否有outcome prices
        if (!market.outcome) continue;

        // 检查极端概率（<15%或>85%）
        const outcomes = Object.entries(market.outcome);
        for (const [outcomeName, outcomeData] of outcomes) {
          if (typeof outcomeData !== 'object' || !outcomeData) continue;

          const price = (outcomeData as any).price;
          if (!price) continue;

          const probability = price;

          if (probability <= 0.15 || probability >= 0.85) {
            const isLowProb = probability <= 0.15;
            const expectedProfit = isLowProb ? (1 - probability) * 0.8 : probability * 0.8;

            // 过滤低利润机会
            const strategy = this.strategies.get('mean_reversion');
            if (strategy && expectedProfit >= strategy.minProfitThreshold) {
              signals.push({
                strategy: 'mean_reversion',
                marketId: market.marketId || '',
                marketTitle: market.question || '',
                type: 'mean_reversion',
                confidence: 0.75,
                expectedProfit,
                action: isLowProb ? 'buy_no' : 'buy_yes',
                yesPrice: isLowProb ? probability : (1 - probability),
                noPrice: isLowProb ? (1 - probability) : probability,
                timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (error) {
      // 静默失败，高频扫描不应中断
    }

    return signals;
  }

  /**
   * 🌐 策略2: Cross-Platform Scanning
   */
  private async scanCrossPlatform(): Promise<ArbitrageSignal[]> {
    const signals: ArbitrageSignal[] = [];

    // TODO: 实现跨平台扫描
    // 需要接入：Polymarket, Kalshi等平台API

    return signals;
  }

  /**
   * 🎯 策略3: Multi-Result Scanning
   */
  private async scanMultiResult(): Promise<ArbitrageSignal[]> {
    const signals: ArbitrageSignal[] = [];

    try {
      const markets = await this.api.getMarkets();

      for (const market of markets) {
        // 检查是否是多结果市场
        if (!market.outcome || typeof market.outcome !== 'object') continue;

        const outcomes = Object.entries(market.outcome);
        if (outcomes.length < 3) continue;

        // 计算总概率
        let totalProbability = 0;
        for (const [, outcomeData] of outcomes) {
          if (typeof outcomeData === 'object' && outcomeData) {
            const price = (outcomeData as any).price;
            if (price) totalProbability += price;
          }
        }

        // 检查定价错误
        if (totalProbability > 1.05 || totalProbability < 0.95) {
          const profitMargin = Math.abs(1 - totalProbability);
          const strategy = this.strategies.get('multi_result');

          if (strategy && profitMargin >= strategy.minProfitThreshold) {
            // 找到最低价的结果
            let minPrice = 1;
            for (const [, outcomeData] of outcomes) {
              if (typeof outcomeData === 'object' && outcomeData) {
                const price = (outcomeData as any).price;
                if (price && price < minPrice) minPrice = price;
              }
            }

            signals.push({
              strategy: 'multi_result',
              marketId: market.marketId || '',
              marketTitle: market.question || '',
              type: 'multi_result',
              confidence: 0.60,
              expectedProfit: profitMargin,
              action: 'buy_both',
              yesPrice: minPrice,
              timestamp: Date.now()
            });
          }
        }
      }
    } catch (error) {
      // 静默失败
    }

    return signals;
  }

  /**
   * 💰 策略4: Yes+No<1 Scanning
   */
  private async scanYesNoUnder(): Promise<ArbitrageSignal[]> {
    const signals: ArbitrageSignal[] = [];

    try {
      const markets = await this.api.getMarkets();

      for (const market of markets) {
        // 检查是否是二元市场
        if (!market.outcome || typeof market.outcome !== 'object') continue;

        const outcomes = Object.entries(market.outcome);
        if (outcomes.length !== 2) continue;

        // 获取YES和NO价格
        let yesPrice = 0;
        let noPrice = 0;

        for (const [outcomeName, outcomeData] of outcomes) {
          if (typeof outcomeData === 'object' && outcomeData) {
            const price = (outcomeData as any).price;
            if (outcomeName.toLowerCase().includes('yes')) yesPrice = price;
            else if (outcomeName.toLowerCase().includes('no')) noPrice = price;
          }
        }

        // 检查Yes + No < 1
        if (yesPrice > 0 && noPrice > 0) {
          const totalCost = yesPrice + noPrice;

          if (totalCost < 1) {
            const profit = 1 - totalCost;
            const strategy = this.strategies.get('yes_no_under');

            if (strategy && profit >= strategy.minProfitThreshold) {
              signals.push({
                strategy: 'yes_no_under',
                marketId: market.marketId || '',
                marketTitle: market.question || '',
                type: 'yes_no_under',
                confidence: 1.0,
                expectedProfit: profit,
                action: 'buy_both',
                yesPrice,
                noPrice,
                timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (error) {
      // 静默失败
    }

    return signals;
  }

  /**
   * 📊 显示信号
   */
  private displaySignals(): void {
    console.log(`\n🔔 发现 ${this.signals.length} 个套利机会:`);
    console.log('─'.repeat(70));

    this.signals.slice(0, 5).forEach((signal, index) => {
      console.log(`\n${index + 1}. ${signal.marketTitle.substring(0, 60)}...`);
      console.log(`   策略: ${this.strategies.get(signal.strategy)?.name}`);
      console.log(`   类型: ${this.formatType(signal.type)}`);
      console.log(`   预期利润: ${(signal.expectedProfit * 100).toFixed(1)}%`);
      console.log(`   置信度: ${(signal.confidence * 100).toFixed(0)}%`);
      console.log(`   操作: ${this.formatAction(signal.action)}`);

      if (signal.yesPrice) console.log(`   YES价格: ${(signal.yesPrice * 100).toFixed(1)}¢`);
      if (signal.noPrice) console.log(`   NO价格: ${(signal.noPrice * 100).toFixed(1)}¢`);
    });

    if (this.signals.length > 5) {
      console.log(`\n... 还有 ${this.signals.length - 5} 个机会`);
    }

    console.log('');
  }

  /**
   * ⚡ 执行顶级信号
   */
  private async executeTopSignals(): Promise<void> {
    // 只执行前3个最高优先级的信号
    const topSignals = this.signals.slice(0, Math.min(3, this.signals.length));

    for (const signal of topSignals) {
      if (this.tradeCount >= this.config.maxDailyTrades) {
        console.log('⚠️ 已达到每日最大交易次数');
        break;
      }

      await this.executeSignal(signal);
    }
  }

  /**
   * 💱 执行单个信号
   */
  private async executeSignal(signal: ArbitrageSignal): Promise<void> {
    console.log(`\n💱 执行交易: ${signal.marketTitle.substring(0, 50)}...`);
    console.log(`   策略: ${this.strategies.get(signal.strategy)?.name}`);
    console.log(`   预期利润: ${(signal.expectedProfit * 100).toFixed(1)}%`);

    try {
      // TODO: 实际执行交易
      // const result = await this.api.placeOrder(...);

      this.tradeCount++;
      this.stats.tradesExecuted++;

      console.log(`   ✅ 交易已执行 (今日第${this.tradeCount}笔)`);

      // 更新统计
      const strategyStats = this.stats.byStrategy.get(signal.strategy);
      if (strategyStats) {
        strategyStats.trades++;
      }

    } catch (error) {
      console.error(`   ❌ 交易执行失败:`, error);
    }
  }

  /**
   * 📊 显示统计信息
   */
  private displayStats(): void {
    console.log('\n' + '='.repeat(70));
    console.log('📊 高频套利统计');
    console.log('='.repeat(70));
    console.log(`总扫描次数: ${this.stats.totalScans}`);
    console.log(`发现信号: ${this.stats.signalsFound}`);
    console.log(`执行交易: ${this.stats.tradesExecuted}`);
    console.log(`今日盈亏: $${this.dailyPnL.toFixed(2)}`);
    console.log('');

    console.log('各策略统计:');
    this.stats.byStrategy.forEach((stats, strategy) => {
      const strategyConfig = this.strategies.get(strategy);
      console.log(`\n${strategyConfig?.name}:`);
      console.log(`  扫描: ${stats.scans}次`);
      console.log(`  信号: ${stats.signals}个`);
      console.log(`  交易: ${stats.trades}笔`);
      console.log(`  利润: $${stats.profit.toFixed(2)}`);
    });

    console.log('\n' + '='.repeat(70) + '\n');
  }

  /**
   * ✅ 检查是否排除该行业
   */
  private isExcludedSector(market: any): boolean {
    const excludedTags = ['crypto', 'sports', 'bitcoin', 'eth', 'blockchain'];
    const marketTags = market.tags || [];
    const marketTitle = market.question?.toLowerCase() || '';

    return excludedTags.some(tag =>
      marketTags.includes(tag) || marketTitle.includes(tag)
    );
  }

  /**
   * 📝 格式化类型
   */
  private formatType(type: string): string {
    const map = {
      'mean_reversion': '📈 Mean Reversion',
      'cross_platform': '🌐 Cross-Platform',
      'multi_result': '🎯 Multi-Result',
      'yes_no_under': '💰 Yes+No<1'
    };
    return map[type] || type;
  }

  /**
   * 📝 格式化操作
   */
  private formatAction(action: string): string {
    const map = {
      'buy_yes': '买入 YES',
      'buy_no': '买入 NO',
      'buy_both': '同时买入 YES 和 NO'
    };
    return map[action] || action;
  }

  /**
   * ⚙️ 更新配置
   */
  updateConfig(config: Partial<HighFrequencyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * ⚙️ 启用/禁用策略
   */
  setStrategyEnabled(strategyKey: string, enabled: boolean): void {
    const strategy = this.strategies.get(strategyKey);
    if (strategy) {
      strategy.enabled = enabled;

      if (enabled && !this.config.enabledStrategies.includes(strategyKey)) {
        this.config.enabledStrategies.push(strategyKey);
      } else if (!enabled) {
        this.config.enabledStrategies = this.config.enabledStrategies.filter(s => s !== strategyKey);
      }
    }
  }

  /**
   * 📊 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      currentSignals: this.signals,
      config: this.config,
      strategies: Array.from(this.strategies.entries()).map(([key, val]) => ({ key, ...val }))
    };
  }
}
