#!/usr/bin/env tsx
/**
 * 市场推荐工具
 *
 * 用途：独立运行的市场推荐和选择工具
 *
 * 使用方式：
 *   npm run market:recommend
 *   或
 *   tsx scripts/market-recommender.ts
 */

import { PredictAPI } from '../src/api/client.js';
import { loadConfig } from '../src/config.js';
import { InteractiveMarketSelector } from '../src/cli/interactive-market-selector.js';

const config = loadConfig();

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 Predict.fun 市场推荐工具');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 初始化 API
  const api = new PredictAPI(config.apiBaseUrl, config.apiKey, config.jwtToken);

  // 获取市场列表
  console.log('⏳ 正在获取市场列表...\n');
  const markets = await api.getMarkets();
  console.log(`📊 找到 ${markets.length} 个市场\n`);

  // 过滤活跃市场
  const activeMarkets = markets.filter(
    m =>
      !m.end_date || new Date(m.end_date) > new Date() // 未结束
  );
  console.log(`📈 其中 ${activeMarkets.length} 个活跃市场\n`);

  // 创建选择器
  const selector = new InteractiveMarketSelector(api);

  // 显示市场推荐
  const result = await selector.showMarketRecommendations(activeMarkets, {
    topN: 20, // 显示前 20 个
    minScore: 0, // 不限制最低评分
    minLiquidity: 0, // 不限制最低流动性
    pointsOnly: false, // 显示所有市场（不只是积分激活的）
  });

  if (result.selectedMarkets.length === 0) {
    console.log('\n❌ 没有选择任何市场');
    process.exit(0);
  }

  // 保存配置
  console.log('\n💾 正在保存配置...');
  await selector.saveConfiguration(result);

  // 显示总结
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 市场选择完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📊 选择总结:`);
  console.log(`   • 市场数量: ${result.selectedMarkets.length}`);
  console.log(`   • 总投入资金: $${result.globalConfig.totalCapitalUsd}`);
  console.log(`   • 平均每市场: $${(result.globalConfig.totalCapitalUsd / result.selectedMarkets.length).toFixed(2)}`);

  console.log('\n📝 已选择的市场:');
  result.selectedMarkets.forEach((market, index) => {
    const config = result.orderConfigs.get(market.token_id);
    console.log(
      `   ${index + 1}. ${market.question.substring(0, 50)}...`
    );
    if (config) {
      console.log(`      投入: $${config.capitalUsd}, 订单: $${config.orderSizeUsd}, 价差: ${(config.spread * 100).toFixed(2)}%`);
    }
  });

  console.log('\n💡 下一步：');
  console.log('   1. 查看配置文件: .env.market_selection');
  console.log('   2. 启动做市商: npm start');
  console.log('   3. 或重新运行: npm run market:recommend');
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(error => {
  console.error('❌ 错误:', error);
  process.exit(1);
});
