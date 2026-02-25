/**
 * 检查 Predict.fun API 市场数据结构
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function checkMarketStructure(): Promise<void> {
  console.log('🔍 检查 Predict.fun API 市场数据结构\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  try {
    // 1. 获取市场列表
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 获取市场列表');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const markets = await api.getMarkets();
    console.log(`找到 ${markets.length} 个市场\n`);

    if (markets.length === 0) {
      console.log('⚠️  没有找到市场数据');
      return;
    }

    // 2. 查看第一个市场的完整结构
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 第一个市场的完整结构');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const firstMarket = markets[0];
    console.log(JSON.stringify(firstMarket, null, 2));
    console.log('');

    // 3. 分析关键字段
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 关键字段分析');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`token_id: ${firstMarket.token_id}`);
    console.log(`condition_id: ${firstMarket.condition_id}`);
    console.log(`event_id: ${firstMarket.event_id}`);
    console.log(`outcome: ${firstMarket.outcome || 'N/A'}`);
    console.log(`question: ${firstMarket.question?.substring(0, 80)}...`);
    console.log('');

    // 4. 按 condition_id 分组
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 按 condition_id 分组');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const byConditionId = new Map<string, any[]>();
    for (const market of markets) {
      const conditionId = market.condition_id || market.event_id || 'unknown';
      if (!byConditionId.has(conditionId)) {
        byConditionId.set(conditionId, []);
      }
      byConditionId.get(conditionId)!.push(market);
    }

    console.log(`找到 ${byConditionId.size} 个唯一的 condition_id\n`);

    // 5. 检查前3个 condition_id 的市场
    let count = 0;
    for (const [conditionId, marketsList] of byConditionId) {
      if (count >= 3) break;

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`条件 ${count + 1}: ${conditionId}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(`市场数量: ${marketsList.length}`);
      console.log(`问题: ${marketsList[0]?.question?.substring(0, 60)}...`);
      console.log('');

      for (const m of marketsList) {
        console.log(`  token_id: ${m.token_id}`);
        console.log(`  outcome: ${m.outcome || 'N/A'}`);
        console.log(`  question: ${m.question?.substring(0, 50)}...`);
        console.log('');
      }

      count++;
    }

    // 6. 检查是否有多个市场共享同一个 condition_id
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 多市场 condition_id 统计');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let multiMarketCount = 0;
    for (const [conditionId, marketsList] of byConditionId) {
      if (marketsList.length > 1) {
        multiMarketCount++;
        console.log(`condition_id: ${conditionId.substring(0, 20)}...`);
        console.log(`  市场数量: ${marketsList.length}`);

        for (const m of marketsList) {
          const outcome = m.outcome || 'N/A';
          console.log(`    - token_id: ${m.token_id.slice(0, 16)}... outcome: ${outcome}`);
        }
        console.log('');
      }
    }

    if (multiMarketCount === 0) {
      console.log('⚠️  没有找到共享同一个 condition_id 的多个市场');
      console.log('这可能意味着:');
      console.log('  1. 每个 Market 对象已经代表整个市场（包含 YES 和 NO）');
      console.log('  2. YES 和 NO 的 token_id 可以从同一个 Market 对象中获取');
      console.log('  3. 需要检查 Market 对象是否有 yesTokenId/noTokenId 字段\n');
    } else {
      console.log(`✅ 找到 ${multiMarketCount} 个有多个市场的 condition_id\n`);
    }

    // 7. 检查可能的 token_id 字段
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 检查 Market 对象的所有字段');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const allKeys = new Set<string>();
    for (const market of markets) {
      for (const key of Object.keys(market)) {
        allKeys.add(key);
      }
    }

    console.log(`Market 对象包含的所有字段 (${allKeys.size} 个):`);
    const sortedKeys = Array.from(allKeys).sort();
    for (const key of sortedKeys) {
      console.log(`  - ${key}`);
    }
    console.log('');

    // 8. 结论
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 结论');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (multiMarketCount > 0) {
      console.log('✅ 发现多个市场共享同一个 condition_id');
      console.log('   这证实了每个 Market 对象代表一个 outcome (YES 或 NO)');
      console.log('   可以通过 condition_id 找到配对的 YES/NO 市场\n');
    } else {
      console.log('⚠️  没有发现多个市场共享同一个 condition_id');
      console.log('   可能的情况:');
      console.log('   1. API 返回的市场数据结构不同');
      console.log('   2. 需要使用不同的 endpoint 获取 YES/NO 市场');
      console.log('   3. token_id 本身可能包含了 outcome 信息\n');
    }

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
    if (error.response) {
      console.error('响应数据:', error.response.data);
    }
  }
}

checkMarketStructure().catch(console.error);
