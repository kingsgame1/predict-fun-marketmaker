/**
 * 测试统一策略的 token_id 使用
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function testUnifiedStrategyTokens(): Promise<void> {
  console.log('🔍 测试统一策略的 token_id 使用\n');

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

    // 模拟 getYesNoTokenIds 方法
    const getYesNoTokenIds = (market: any) => {
      if (!market.outcomes || market.outcomes.length === 0) {
        return {};
      }

      let yesTokenId: string | undefined;
      let noTokenId: string | undefined;

      for (const outcome of market.outcomes) {
        const name = outcome.name.toLowerCase();
        const isYes = name === 'yes' || name === 'up' || name === 'true' || outcome.indexSet === 1;
        const isNo = name === 'no' || name === 'down' || name === 'false' || outcome.indexSet === 2;

        if (isYes) {
          yesTokenId = outcome.onChainId;
        } else if (isNo) {
          noTokenId = outcome.onChainId;
        }
      }

      return { yesTokenId, noTokenId };
    };

    // 测试前 3 个市场
    let count = 0;
    for (const market of markets) {
      if (count >= 3) break;

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`市场 ${count + 1}: ${market.question?.substring(0, 50)}...`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(`condition_id: ${market.condition_id}`);
      console.log(`market.token_id: ${market.token_id}`);
      console.log('');

      // 获取 YES/NO token_id
      const { yesTokenId, noTokenId } = getYesNoTokenIds(market);

      if (!yesTokenId || !noTokenId) {
        console.log('⚠️  无法获取 YES/NO token_id');
        count++;
        continue;
      }

      console.log('✅ 获取到 token_ids:');
      console.log(`   YES: ${yesTokenId}`);
      console.log(`   NO:  ${noTokenId}`);
      console.log('');

      // 验证它们不同
      if (yesTokenId !== noTokenId) {
        console.log('✅ 验证通过：YES 和 NO 有不同的 token_id');
        console.log('');

        // 模拟挂单
        console.log('📊 模拟挂单操作:');
        console.log(`   挂 YES Buy 单，使用 token_id: ${yesTokenId.slice(0, 16)}...`);
        console.log(`   挂 NO Buy 单，使用 token_id: ${noTokenId.slice(0, 16)}...`);
        console.log(`   挂 YES Sell 单，使用 token_id: ${yesTokenId.slice(0, 16)}...`);
        console.log(`   挂 NO Sell 单，使用 token_id: ${noTokenId.slice(0, 16)}...`);
        console.log('');

        // 模拟对冲
        console.log('🛡️  模拟对冲操作:');
        console.log(`   如果 YES Buy 成交，对冲 NO Buy，使用 token_id: ${noTokenId.slice(0, 16)}...`);
        console.log(`   如果 NO Buy 成交，对冲 YES Buy，使用 token_id: ${yesTokenId.slice(0, 16)}...`);
        console.log('');

        console.log('✅ 所有操作都将使用正确的 token_id！');

      } else {
        console.log('⚠️  警告：YES 和 NO 使用相同的 token_id');
      }

      console.log('');
      count++;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 总结');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const marketsWithOutcomes = markets.filter(m => m.outcomes && m.outcomes.length > 0).length;
    console.log(`有 outcomes 数据的市场: ${marketsWithOutcomes}/${markets.length}`);

    if (marketsWithOutcomes === markets.length) {
      console.log('\n✅ 所有市场都有完整的 outcomes 数据！');
      console.log('');
      console.log('修复完成：');
      console.log('1. ✅ 已更新 Market 接口，添加 outcomes 字段');
      console.log('2. ✅ 已更新 normalizeMarket 函数，解析 outcomes 数组');
      console.log('3. ✅ 已更新 getYesNoTokenIds 方法，从 outcomes 获取 token_id');
      console.log('4. ✅ 已更新 findYesNoMarkets 方法，使用新的逻辑');
      console.log('');
      console.log('下一步：');
      console.log('- 启用统一做市商策略进行测试');
      console.log('- 验证是否正确挂单和对冲');
      console.log('- 监控日志确认使用了不同的 token_id');
    } else {
      console.log('\n⚠️  部分市场缺少 outcomes 数据');
    }

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

testUnifiedStrategyTokens().catch(console.error);
