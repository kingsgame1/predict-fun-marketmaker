/**
 * 交互式市场选择器
 *
 * 功能：
 * - 显示市场推荐表格
 * - 市场详情查看
 * - 订单参数配置
 * - 市场选择和保存
 */

import * as readline from 'node:readline';
import { promisify } from 'node:util';

import type { Market, Orderbook } from '../types.js';
import type { PredictAPI } from '../api/client.js';
import { MarketAnalyzer, type MarketAnalysis, type LiquidityInfo } from '../mm/market-analyzer.js';

const question = promisify(readline.createInterface({
  input: process.stdin,
  output: process.stdout,
}).question);

/**
 * 选择器配置
 */
export interface SelectionConfig {
  topN: number;              // 显示前 N 个市场
  minScore: number;          // 最低评分要求
  minLiquidity: number;      // 最低流动性（USD）
  pointsOnly: boolean;       // 只显示积分激活市场
}

/**
 * 订单配置
 */
export interface OrderConfiguration {
  marketId: string;
  marketQuestion: string;
  capitalUsd: number;        // 投入资金（USD）
  orderSizeUsd: number;      // 订单大小（USD）
  orderSizeShares: number;   // 每单股数
  spread: number;            // 价差
  spreadCents: number;       // 价差（美分）
  maxPosition: number;       // 最大持仓
  minShares: number;         // 最小股数
}

/**
 * 全局配置
 */
export interface GlobalOrderConfig {
  totalCapitalUsd: number;   // 总投入资金
  maxMarkets: number;        // 最大市场数量
  defaultOrderSize: number;  // 默认单笔订单大小
}

/**
 * 选择结果
 */
export interface MarketSelectionResult {
  selectedMarkets: Market[];
  orderConfigs: Map<string, OrderConfiguration>;
  globalConfig: GlobalOrderConfig;
}

/**
 * 交互式市场选择器类
 */
export class InteractiveMarketSelector {
  private api: PredictAPI;
  private analyzer: MarketAnalyzer;
  private rl: readline.Interface;

  constructor(api: PredictAPI) {
    this.api = api;
    this.analyzer = new MarketAnalyzer(api);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * 显示分隔线
   */
  private separator(char: string = '━', length: number = 73): void {
    console.log(char.repeat(length));
  }

  /**
   * 显示市场推荐表格
   */
  displayMarketTable(analyses: MarketAnalysis[], showRank: boolean = true): void {
    this.separator();

    // 标题
    const title = showRank ? '📊 市场推荐列表（按评分排序）' : '📊 市场列表';
    console.log(`${title}`);
    this.separator();

    // 表头
    const header = showRank
      ? '排名│ 评分 │ 积分 │ Spread │ 1%流动性 │  24h交易量 │ 问题'
      : '序号 │ 评分 │ 积分 │ Spread │ 1%流动性 │  24h交易量 │ 问题';
    console.log(header);
    this.separator('─');

    // 表格内容
    analyses.forEach((analysis, index) => {
      const rank = showRank ? (index + 1).toString().padStart(3) : index.toString().padStart(3);
      const score = analysis.overallScore.toFixed(0).padStart(3);
      const points = analysis.pointsEligible ? '  ✅  ' : '  ❌  ';
      const spread = (analysis.spreadPct * 100).toFixed(1) + '%';
      const liquidity = '$' + analysis.liquidity1Pct.totalUsd.toFixed(0).padStart(6);
      const volume = analysis.volume24h
        ? '$' + (analysis.volume24h >= 1000 ? (analysis.volume24h / 1000).toFixed(1) + 'K' : analysis.volume24h.toFixed(0))
        : '  N/A  ';
      const question = analysis.market.question.substring(0, 30);

      console.log(
        ` ${rank} │ ${score} │${points}│ ${spread.padStart(6)} │${liquidity}  │ ${volume.padStart(8)} │ ${question}...`
      );
    });

    this.separator();
  }

  /**
   * 显示市场详情
   */
  displayMarketDetail(analysis: MarketAnalysis): void {
    this.separator();
    console.log(`📈 市场详情：${analysis.market.question}`);
    this.separator();

    // 评分信息
    console.log('\n📊 评分信息:');
    const stars = '⭐'.repeat(Math.round(analysis.overallScore / 20)) || '☆';
    console.log(`   • 综合评分: ${analysis.overallScore.toFixed(0)}/100 ${stars}`);
    if (analysis.pointsScore !== undefined) {
      console.log(`   • 积分评分: ${analysis.pointsScore.toFixed(0)}/100 ${analysis.pointsEligible ? '✅' : '❌'}`);
    }
    console.log(`   • 排名优先级: ${analysis.priority.toFixed(0)}`);

    // 价差信息
    console.log('\n💰 价差信息:');
    console.log(`   • 当前价差: ${(analysis.spreadPct * 100).toFixed(2)}% ($${analysis.spread.toFixed(3)})`);
    console.log(`   • 中间价: $${analysis.midPrice.toFixed(3)}`);
    console.log(`   • 买价: $${(analysis.orderbook.best_bid ?? 0).toFixed(3)}`);
    console.log(`   • 卖价: $${(analysis.orderbook.best_ask ?? 0).toFixed(3)}`);

    // 1% 流动性
    console.log('\n💵 1% 流动性:');
    const liq = analysis.liquidity1Pct;
    console.log(`   • 1% 买盘流动性: ${liq.bidShares.toFixed(0)} shares ($${liq.bidUsd.toFixed(2)})`);
    console.log(`   • 1% 卖盘流动性: ${liq.askShares.toFixed(0)} shares ($${liq.askUsd.toFixed(2)})`);
    console.log(`   • 1% 总流动性: ${liq.totalShares.toFixed(0)} shares ($${liq.totalUsd.toFixed(2)})`);

    // 订单簿深度
    console.log('\n📚 订单簿深度 (Top 3):');
    const depth = analysis.depthTop3;
    console.log(`   • Top 3 买盘: ${depth.bidShares.toFixed(0)} shares ($${depth.bidUsd.toFixed(2)})`);
    console.log(`   • Top 3 卖盘: ${depth.askShares.toFixed(0)} shares ($${depth.askUsd.toFixed(2)})`);
    console.log(`   • 总深度: ${depth.totalShares.toFixed(0)} shares ($${depth.totalUsd.toFixed(2)})`);

    // 积分规则
    console.log('\n✅ 积分激活规则:');
    const rules = analysis.market.liquidity_activation;
    if (rules && rules.active) {
      console.log(`   • 最小订单: ${rules.min_shares ?? 'N/A'} shares`);
      console.log(
        `   • 最大价差: ${rules.max_spread_cents ? `$${rules.max_spread_cents}¢` : rules.max_spread ? `${(rules.max_spread * 100).toFixed(1)}%` : 'N/A'}`
      );
      console.log(`   • 状态: ${analysis.pointsReason}`);
    } else {
      console.log('   • 状态: 无积分规则');
    }

    // 推荐配置
    console.log('\n💡 推荐配置:');
    const rec = analysis.recommended;
    rec.reasons.forEach(reason => {
      console.log(`   • ${reason}`);
    });
    console.log(`   • 建议价差: ${(rec.spread * 100).toFixed(2)}%`);
    console.log(`   • 建议订单大小: $${rec.orderSize}`);
    console.log(`   • 建议最大持仓: $${rec.maxPosition}`);
    console.log(`   • 建议最小股数: ${rec.minShares} shares`);

    // 交易量
    if (analysis.volume24h || analysis.liquidity24h) {
      console.log('\n📈 交易数据:');
      if (analysis.volume24h) {
        console.log(`   • 24h 交易量: $${analysis.volume24h.toLocaleString()}`);
      }
      if (analysis.liquidity24h) {
        console.log(`   • 24h 流动性: $${analysis.liquidity24h.toLocaleString()}`);
      }
    }

    this.separator();
  }

  /**
   * 显示订单配置
   */
  private displayOrderConfig(config: OrderConfiguration): void {
    console.log('\n✅ 配置确认:');
    console.log(`   • 投入资金: $${config.capitalUsd}`);
    console.log(`   • 订单大小: $${config.orderSizeUsd}`);
    console.log(`   • 单笔股数: ${config.orderSizeShares} shares`);
    console.log(`   • 价差: ${(config.spread * 100).toFixed(2)}% ($${config.spread.toFixed(3)})`);
    console.log(`   • 最大持仓: $${config.maxPosition}`);
    console.log(`   • 最小股数: ${config.minShares} shares`);

    // 预计订单数
    const estimatedOrders = Math.floor(config.capitalUsd / config.orderSizeUsd);
    console.log(`   • 预计订单数: ${estimatedOrders} 单`);
  }

  /**
   * 配置订单参数
   */
  async configureOrderParameters(analysis: MarketAnalysis): Promise<OrderConfiguration> {
    const rec = analysis.recommended;
    const midPrice = analysis.midPrice;

    // 默认值
    let capitalUsd = 500;
    let orderSizeUsd = rec.orderSize;
    let spread = rec.spread;
    let maxPosition = rec.maxPosition;
    let minShares = rec.minShares;

    console.log('\n🎯 配置订单参数:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 投入资金
    const capitalInput = await this.ask(
      `投入资金 (USD) [当前: $${capitalUsd}]: `,
      capitalUsd.toString()
    );
    capitalUsd = parseFloat(capitalInput) || capitalUsd;

    // 订单大小
    const orderSizeInput = await this.ask(
      `订单大小 (USD) [当前: $${orderSizeUsd}, 推荐: $${rec.orderSize}]: `,
      orderSizeUsd.toString()
    );
    orderSizeUsd = parseFloat(orderSizeInput) || orderSizeUsd;

    // 计算股数
    const estimatedShares = Math.ceil(orderSizeUsd / midPrice);

    // 价差
    const spreadInput = await this.ask(
      `价差设置 (%) [当前: ${(spread * 100).toFixed(2)}%, 推荐: ${(rec.spread * 100).toFixed(2)}%]: `,
      (spread * 100).toFixed(2)
    );
    spread = (parseFloat(spreadInput) || spread) / 100;

    // 最大持仓
    const maxPosInput = await this.ask(
      `最大持仓 (USD) [当前: $${maxPosition}, 推荐: $${rec.maxPosition}]: `,
      maxPosition.toString()
    );
    maxPosition = parseFloat(maxPosInput) || maxPosition;

    // 最小股数
    const minSharesInput = await this.ask(
      `最小股数 [当前: ${minShares}, 推荐: ${rec.minShares}]: `,
      minShares.toString()
    );
    minShares = parseInt(minSharesInput) || minShares;

    const config: OrderConfiguration = {
      marketId: analysis.market.token_id,
      marketQuestion: analysis.market.question,
      capitalUsd,
      orderSizeUsd,
      orderSizeShares: estimatedShares,
      spread,
      spreadCents: spread * 100,
      maxPosition,
      minShares,
    };

    this.displayOrderConfig(config);

    // 确认
    const confirm = await this.ask('\n确认并添加到选择列表? (Y/n): ', 'Y');
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes' && confirm !== '') {
      console.log('❌ 已取消');
      throw new Error('用户取消');
    }

    return config;
  }

  /**
   * 辅助方法：提问
   */
  private ask(query: string, defaultVal: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(query, (answer) => {
        resolve(answer.trim() || defaultVal);
      });
    });
  }

  /**
   * 显示市场推荐并允许用户选择
   */
  async showMarketRecommendations(
    markets: Market[],
    config: SelectionConfig
  ): Promise<MarketSelectionResult> {
    console.log('\n🔍 正在分析市场...\n');

    // 分析市场
    let analyses = await this.analyzer.analyzeMarkets(markets);

    // 应用过滤条件
    analyses = analyses.filter(a => {
      // 最低评分
      if (config.minScore > 0 && a.overallScore < config.minScore) return false;

      // 最低流动性
      if (config.minLiquidity > 0 && a.liquidity1Pct.totalUsd < config.minLiquidity) return false;

      // 只显示积分激活市场
      if (config.pointsOnly && !a.pointsEligible) return false;

      return true;
    });

    // 只显示前 N 个
    analyses = analyses.slice(0, config.topN);

    if (analyses.length === 0) {
      console.log('⚠️  没有符合条件的市场');
      this.rl.close();
      return {
        selectedMarkets: [],
        orderConfigs: new Map(),
        globalConfig: {
          totalCapitalUsd: 0,
          maxMarkets: 0,
          defaultOrderSize: 25,
        },
      };
    }

    // 显示表格
    this.displayMarketTable(analyses, false);

    // 提示信息
    console.log('\n💡 提示：');
    console.log('   • 输入序号查看详情（如：1）');
    console.log('   • 输入多个序号选择市场（如：1,3,5）');
    console.log("   • 输入 'all' 选择全部，'q' 退出");
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 用户选择
    const selectedMarkets: Market[] = [];
    const orderConfigs = new Map<string, OrderConfiguration>();
    let totalCapital = 0;

    while (true) {
      const input = await this.ask('选择市场 ➜ ', '');

      if (input.toLowerCase() === 'q') {
        break;
      }

      if (input.toLowerCase() === 'all') {
        // 选择全部
        for (const analysis of analyses) {
          selectedMarkets.push(analysis.market);
          const config = await this.configureOrderParameters(analysis);
          orderConfigs.set(analysis.market.token_id, config);
          totalCapital += config.capitalUsd;
          console.log(`\n✅ 市场已添加！当前已选择 ${selectedMarkets.length} 个市场\n`);
          this.separator();
        }
        break;
      }

      // 解析输入
      const indices = input.split(',').map(s => parseInt(s.trim()));

      if (indices.some(isNaN)) {
        console.log('❌ 无效输入，请输入数字序号\n');
        continue;
      }

      // 查看详情或批量选择
      if (indices.length === 1) {
        const index = indices[0] - 1;
        if (index >= 0 && index < analyses.length) {
          // 显示详情
          this.displayMarketDetail(analyses[index]);

          const action = await this.ask('\n是否要选择这个市场? (Y/n): ', 'Y');
          if (action.toLowerCase() === 'y' || action.toLowerCase() === 'yes' || action === '') {
            selectedMarkets.push(analyses[index].market);
            const config = await this.configureOrderParameters(analyses[index]);
            orderConfigs.set(analyses[index].market.token_id, config);
            totalCapital += config.capitalUsd;
            console.log(`\n✅ 市场已添加！当前已选择 ${selectedMarkets.length} 个市场`);
            this.separator();
          } else {
            console.log('❌ 已取消');
            this.separator();
          }
        } else {
          console.log('❌ 序号超出范围\n');
        }
      } else {
        // 批量选择
        for (const idx of indices) {
          const index = idx - 1;
          if (index >= 0 && index < analyses.length) {
            selectedMarkets.push(analyses[index].market);
            // 使用默认配置
            const rec = analyses[index].recommended;
            const config: OrderConfiguration = {
              marketId: analyses[index].market.token_id,
              marketQuestion: analyses[index].market.question,
              capitalUsd: 500,
              orderSizeUsd: rec.orderSize,
              orderSizeShares: Math.ceil(rec.orderSize / analyses[index].midPrice),
              spread: rec.spread,
              spreadCents: rec.spreadCents,
              maxPosition: rec.maxPosition,
              minShares: rec.minShares,
            };
            orderConfigs.set(analyses[index].market.token_id, config);
            totalCapital += config.capitalUsd;
          }
        }
        console.log(`\n✅ 已批量选择 ${indices.length} 个市场！`);
        break;
      }

      if (selectedMarkets.length > 0) {
        const continueSelect = await this.ask('\n继续选择其他市场? (按 Enter 继续，输入 q 完成选择): ', '');
        if (continueSelect.toLowerCase() === 'q') {
          break;
        }
      }
    }

    this.rl.close();

    console.log('\n✅ 市场选择完成！');
    console.log(`   已选择 ${selectedMarkets.length} 个市场`);
    console.log(`   总投入资金: $${totalCapital}`);

    return {
      selectedMarkets,
      orderConfigs,
      globalConfig: {
        totalCapitalUsd: totalCapital,
        maxMarkets: selectedMarkets.length,
        defaultOrderSize: 25,
      },
    };
  }

  /**
   * 保存配置到文件
   */
  async saveConfiguration(result: MarketSelectionResult): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const configPath = path.join(process.cwd(), '.env.market_selection');

    const lines: string[] = [
      '# 市场选择配置',
      '# 生成时间: ' + new Date().toISOString(),
      '',
      `SELECTED_MARKETS=${result.selectedMarkets.map(m => m.token_id).join(',')}`,
      `TOTAL_CAPITAL_USD=${result.globalConfig.totalCapitalUsd}`,
      `MAX_MARKETS=${result.globalConfig.maxMarkets}`,
      `DEFAULT_ORDER_SIZE=${result.globalConfig.defaultOrderSize}`,
      '',
      '# 各市场配置',
    ];

    for (const [tokenId, config] of result.orderConfigs) {
      lines.push(``);
      lines.push(`# ${config.marketQuestion}`);
      lines.push(`MARKET_${tokenId}_CAPITAL=${config.capitalUsd}`);
      lines.push(`MARKET_${tokenId}_ORDER_SIZE=${config.orderSizeUsd}`);
      lines.push(`MARKET_${tokenId}_SHARES=${config.orderSizeShares}`);
      lines.push(`MARKET_${tokenId}_SPREAD=${config.spread}`);
      lines.push(`MARKET_${tokenId}_MAX_POSITION=${config.maxPosition}`);
      lines.push(`MARKET_${tokenId}_MIN_SHARES=${config.minShares}`);
    }

    fs.writeFileSync(configPath, lines.join('\n'));
    console.log(`   配置已保存到 ${configPath}`);
  }
}
