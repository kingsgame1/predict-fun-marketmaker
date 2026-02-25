/**
 * 测试 outcomes 数组解析
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function testOutcomesParsing(): Promise<void> {
  console.log('🔍 测试 outcomes 数组解析\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  try {
    const markets = await api.getMarkets();

    if (markets.length === 0) {
      console.log('⚠️  没有找到市场数据');
      return;
    }

    console.log(`找到 ${markets.length} 个市场\n`);

    // 检查前 3 个市场
    let count = 0;
    for (const market of markets) {
      if (count >= 3) break;

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`市场 ${count + 1}: ${market.question?.substring(0, 50)}...`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(`condition_id: ${market.condition_id}`);
      console.log(`market.token_id: ${market.token_id}`);
      console.log(`is_neg_risk: ${market.is_neg_risk}`);
      console.log(`is_yield_bearing: ${market.is_yield_bearing}`);
      console.log('');

      if (market.outcomes && market.outcomes.length > 0) {
        console.log(`✅ 找到 ${market.outcomes.length} 个 outcomes:\n`);

        for (const outcome of market.outcomes) {
          console.log(`  ${outcome.name}:`);
          console.log(`    indexSet: ${outcome.indexSet}`);
          console.log(`    onChainId (token_id): ${outcome.onChainId}`);
          console.log(`    status: ${outcome.status}`);
          console.log('');
        }

        // 验证 token_id
        const yesOutcome = market.outcomes.find(o =>
          o.name.toLowerCase() === 'yes' ||
          o.name.toLowerCase() === 'up' ||
          o.indexSet === 1
        );
        const noOutcome = market.outcomes.find(o =>
          o.name.toLowerCase() === 'no' ||
          o.name.toLowerCase() === 'down' ||
          o.indexSet === 2
        );

        if (yesOutcome) {
          console.log(`✅ YES/Up token_id: ${yesOutcome.onChainId}`);
        }
        if (noOutcome) {
          console.log(`✅ NO/Down token_id: ${noOutcome.onChainId}`);
        }

        console.log('');

        // 验证是否不同
        if (yesOutcome && noOutcome) {
          if (yesOutcome.onChainId !== noOutcome.onChainId) {
            console.log(`✅ 确认：YES 和 NO 有不同的 token_id！`);
          } else {
            console.log(`⚠️  警告：YES 和 NO 使用相同的 token_id`);
          }
        }

      } else {
        console.log(`⚠️  没有找到 outcomes 数组`);
      }

      console.log('');
      count++;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 总结');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const marketsWithOutcomes = markets.filter(m => m.outcomes && m.outcomes.length > 0).length;
    console.log(`有 outcomes 数据的市场: ${marketsWithOutcomes}/${markets.length}`);

    if (marketsWithOutcomes > 0) {
      console.log('\n✅ 修复成功！API 现在可以返回 YES/NO 的 token_id');
      console.log('');
      console.log('下一步：');
      console.log('1. 更新 market-maker.ts 使用 market.outcomes 获取 token_id');
      console.log('2. 测试统一做市商策略');
      console.log('3. 验证是否正确使用不同的 token_id 挂单');
    } else {
      console.log('\n⚠️  仍然没有 outcomes 数据');
      console.log('   可能需要进一步调查');
    }

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

testOutcomesParsing().catch(console.error);
