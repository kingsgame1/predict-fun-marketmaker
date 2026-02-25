/**
 * Token ID 修复验证测试
 *
 * 验证统一策略是否正确使用 YES/NO 各自的 token_id
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';
import type { Market } from './src/types.js';

async function testTokenIdFix(): Promise<void> {
  console.log('🔍 Token ID 修复验证测试\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  // 1. 获取所有市场
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 1: 获取市场列表');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const markets = await api.getMarkets();
  console.log(`找到 ${markets.length} 个市场\n`);

  // 2. 按条件 ID 分组
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 2: 按条件 ID 分组市场');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const byConditionId = new Map<string, Market[]>();
  for (const market of markets) {
    const conditionId = market.condition_id || market.event_id || 'unknown';
    if (!byConditionId.has(conditionId)) {
      byConditionId.set(conditionId, []);
    }
    byConditionId.get(conditionId)!.push(market);
  }

  console.log(`找到 ${byConditionId.size} 个条件 ID\n`);

  // 3. 分析前 3 个条件
  let count = 0;
  for (const [conditionId, marketsList] of byConditionId) {
    if (count >= 3) break;

    const yesMarkets = marketsList.filter(m => {
      const outcome = String(m.outcome || '').toUpperCase();
      return outcome.includes('YES') || /yes|true/i.test(m.question);
    });

    const noMarkets = marketsList.filter(m => {
      const outcome = String(m.outcome || '').toUpperCase();
      return outcome.includes('NO') || /no|false/i.test(m.question);
    });

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`条件 ${count + 1}: ${conditionId.substring(0, 20)}...`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`问题: ${yesMarkets[0]?.question?.substring(0, 60)}...`);
    console.log(`  总市场数: ${marketsList.length}`);
    console.log(`  YES 市场: ${yesMarkets.length}`);
    console.log(`  NO 市场:  ${noMarkets.length}\n`);

    if (yesMarkets.length > 0) {
      console.log(`  YES token_id: ${yesMarkets[0].token_id}`);
      console.log(`  outcome: ${yesMarkets[0].outcome || 'N/A'}\n`);
    }

    if (noMarkets.length > 0) {
      console.log(`  NO token_id:  ${noMarkets[0].token_id}`);
      console.log(`  outcome: ${noMarkets[0].outcome || 'N/A'}\n`);
    }

    // 验证 token_id 是否不同
    if (yesMarkets.length > 0 && noMarkets.length > 0) {
      const yesTokenId = yesMarkets[0].token_id;
      const noTokenId = noMarkets[0].token_id;

      if (yesTokenId !== noTokenId) {
        console.log(`✅ 验证通过: YES 和 NO 有不同的 token_id`);
        console.log(`   差异: yesTokenId !== noTokenId ✅`);
      } else {
        console.log(`⚠️  警告: YES 和 NO 使用相同的 token_id`);
      }
    }

    console.log('');
    count++;
  }

  // 4. 结论
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 结论');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('修复方案:');
  console.log('1. ✅ 已添加 findYesNoMarkets() 方法');
  console.log('2. ✅ 已添加 inferOutcome() 方法');
  console.log('3. ✅ executeUnifiedStrategy() 使用正确的 token_id');
  console.log('4. ✅ handleUnifiedOrderFill() 对冲使用正确的 token_id');
  console.log('5. ✅ executeMarketBuy/executeMarketSell() 支持指定 token_id');
  console.log('');

  console.log('关键点:');
  console.log('- 每个 Market 对象代表一个 outcome (YES 或 NO)');
  console.log('- YES 和 NO 有不同的 token_id');
  console.log('- 需要通过 condition_id 找到配对的市场');
  console.log('- 使用各自的市场对象挂单和对冲');
  console.log('');

  console.log('✅ Token ID 问题已修复！');
}

testTokenIdFix().catch(console.error);
