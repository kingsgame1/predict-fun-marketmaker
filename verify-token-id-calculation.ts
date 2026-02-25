/**
 * 验证 Token ID 计算方式
 *
 * 检查 CTF 标准：token_id = (conditionId << 1) | outcomeBit
 * 其中 outcomeBit: YES = 1, NO = 0
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

function computeTokenId(conditionId: string, outcome: 'YES' | 'NO'): string {
  try {
    // 移除 0x 前缀
    const cleanConditionId = conditionId.startsWith('0x')
      ? conditionId.slice(2)
      : conditionId;

    const conditionIdBigInt = BigInt('0x' + cleanConditionId);

    // CTF 标准：YES = 1, NO = 0
    const outcomeBit = outcome === 'YES' ? 1n : 0n;
    const tokenIdBigInt = (conditionIdBigInt << 1n) | outcomeBit;

    return tokenIdBigInt.toString();
  } catch (error) {
    console.error('计算 token_id 失败:', error);
    return '';
  }
}

async function verifyTokenIdCalculation(): Promise<void> {
  console.log('🔍 验证 Token ID 计算方式\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  try {
    // 获取市场列表
    const markets = await api.getMarkets();

    if (markets.length === 0) {
      console.log('⚠️  没有找到市场数据');
      return;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 验证前 5 个市场的 token_id 计算');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let matchCount = 0;
    let totalChecked = 0;

    for (let i = 0; i < Math.min(5, markets.length); i++) {
      const market = markets[i];

      if (!market.condition_id || !market.token_id) {
        continue;
      }

      totalChecked++;

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`市场 ${i + 1}: ${market.question?.substring(0, 50)}...`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(`condition_id: ${market.condition_id}`);
      console.log(`实际 token_id: ${market.token_id}\n`);

      // 尝试计算 YES 和 NO 的 token_id
      const computedYesTokenId = computeTokenId(market.condition_id, 'YES');
      const computedNoTokenId = computeTokenId(market.condition_id, 'NO');

      console.log(`计算的 YES token_id: ${computedYesTokenId}`);
      console.log(`计算的 NO token_id:  ${computedNoTokenId}\n`);

      // 检查是否匹配
      const yesMatch = computedYesTokenId === market.token_id;
      const noMatch = computedNoTokenId === market.token_id;

      if (yesMatch) {
        console.log(`✅ 匹配！当前市场的 token_id 对应 YES outcome`);
        matchCount++;
      } else if (noMatch) {
        console.log(`✅ 匹配！当前市场的 token_id 对应 NO outcome`);
        matchCount++;
      } else {
        console.log(`⚠️  不匹配！token_id 可能不是通过标准 CTF 方式计算的`);
        console.log(`   需要检查其他计算方式或从链上获取`);
      }

      console.log('');

      // 尝试从 token_id 反推 condition_id
      try {
        const tokenIdBigInt = BigInt(market.token_id);
        const inferredConditionId = (tokenIdBigInt >> 1n).toString(16);
        const inferredOutcomeBit = tokenIdBigInt & 1n;

        console.log(`从 token_id 反推：`);
        console.log(`  condition_id: 0x${inferredConditionId}`);
        console.log(`  outcome bit: ${inferredOutcomeBit} (${inferredOutcomeBit === 1n ? 'YES' : 'NO'})`);

        const inferredConditionIdMatch =
          '0x' + inferredConditionId === market.condition_id.toLowerCase() ||
          inferredConditionId === market.condition_id.toLowerCase().replace('0x', '');

        if (inferredConditionIdMatch) {
          console.log(`  ✅ 反推的 condition_id 与市场数据匹配！`);
        } else {
          console.log(`  ⚠️  反推的 condition_id 不匹配`);
          console.log(`     市场: ${market.condition_id}`);
          console.log(`     反推: 0x${inferredConditionId}`);
        }

        console.log('');
      } catch (error) {
        console.log(`⚠️  无法从 token_id 反推: ${error}\n`);
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 总结');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`检查了 ${totalChecked} 个市场`);
    console.log(`匹配成功: ${matchCount} 个`);
    console.log(`匹配率: ${totalChecked > 0 ? ((matchCount / totalChecked) * 100).toFixed(1) : 0}%\n`);

    if (matchCount === totalChecked) {
      console.log('✅ 结论：token_id 可以通过 CTF 标准公式计算！');
      console.log('   token_id = (conditionId << 1) | outcomeBit');
      console.log('   其中 outcomeBit: YES = 1, NO = 0\n');

      console.log('实现方案：');
      console.log('1. 添加 computeTokenId() 方法到 market-maker.ts');
      console.log('2. 在 executeUnifiedStrategy() 中计算 YES/NO 的 token_id');
      console.log('3. 使用计算出的 token_id 进行交易\n');
    } else {
      console.log('⚠️  CTF 标准公式可能不适用于 Predict.fun');
      console.log('   需要进一步调查：');
      console.log('   1. 检查链上合约的 token_id 存储方式');
      console.log('   2. 查询 SDK 中的 token_id 生成逻辑');
      console.log('   3. 或者从 API 的其他 endpoint 获取完整的 token 信息\n');
    }

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

verifyTokenIdCalculation().catch(console.error);
