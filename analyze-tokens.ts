/**
 * Token ID 分析工具
 *
 * 用于确认 Predict.fun 的 token_id 计算方式
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function analyzeTokens() {
  console.log('🔍 开始分析 Token ID 结构...\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  // 1. 获取市场列表
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 1: 获取市场列表');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const markets = await api.getMarkets();
  console.log(`找到 ${markets.length} 个市场\n`);

  // 2. 分析前 3 个市场的 token_id 结构
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 2: 分析 Token ID 结构');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (let i = 0; i < Math.min(3, markets.length); i++) {
    const market = markets[i];
    console.log(`市场 ${i + 1}: ${market.question?.substring(0, 60)}...`);
    console.log(`  token_id:      ${market.token_id}`);
    console.log(`  condition_id:  ${market.condition_id || 'N/A'}`);
    console.log(`  outcome:       ${market.outcome || 'N/A'}`);
    console.log(`  event_id:      ${market.event_id || 'N/A'}`);

    // 分析 token_id 和 condition_id 的关系
    if (market.condition_id && market.token_id) {
      try {
        const conditionIdBigInt = BigInt(market.condition_id);
        const tokenIdBigInt = BigInt(market.token_id);

        // 尝试计算关系
        // 方案 1: token_id = (conditionId << 1) | outcome
        const expectedYesTokenId = (conditionIdBigInt << 1n) | 1n;
        const expectedNoTokenId = (conditionIdBigInt << 1n) | 0n;

        if (tokenIdBigInt === expectedYesTokenId) {
          console.log(`  ✅ Token ID 匹配: YES token (conditionId << 1 | 1)`);
        } else if (tokenIdBigInt === expectedNoTokenId) {
          console.log(`  ✅ Token ID 匹配: NO token (conditionId << 1 | 0)`);
        } else {
          console.log(`  ❌ Token ID 不匹配任何标准计算方式`);
          console.log(`     期望 YES: ${expectedYesTokenId.toString()}`);
          console.log(`     期望 NO:  ${expectedNoTokenId.toString()}`);
          console.log(`     实际:     ${tokenIdBigInt.toString()}`);
        }
      } catch (error) {
        console.log(`  ⚠️  无法解析 token_id: ${error}`);
      }
    }

    console.log('');
  }

  // 3. 获取订单数据
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 3: 获取订单数据');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const makerAddress = config.predictAccountAddress || config.privateKey ?
    `0x${config.privateKey?.substring(0, 40)}` : '';

  if (!makerAddress || makerAddress === '0x0000000000000000000000000000000000001') {
    console.log('⚠️  没有配置钱包地址，跳过订单分析');
    console.log('   请在 .env 中设置 PREDICT_ACCOUNT_ADDRESS');
  } else {
    try {
      const orders = await api.getOrders(makerAddress);
      console.log(`找到 ${orders.length} 个订单\n`);

      // 分析前 5 个订单
      for (let i = 0; i < Math.min(5, orders.length); i++) {
        const order = orders[i];
        console.log(`订单 ${i + 1}:`);
        console.log(`  token_id:  ${order.token_id}`);
        console.log(`  side:      ${order.side}`);
        console.log(`  price:     ${order.price}`);
        console.log(`  shares:    ${order.shares}`);
        console.log(`  status:    ${order.status}`);
        console.log('');
      }
    } catch (error) {
      console.log(`⚠️  无法获取订单: ${error}`);
    }
  }

  // 4. 获取持仓数据
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 步骤 4: 获取持仓数据');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const positions = await api.getPositions(makerAddress);
    console.log(`找到 ${positions.length} 个持仓\n`);

    // 统计 YES 和 NO 的数量
    const yesPositions = positions.filter(p =>
      p.outcome === 'YES' || p.side === 'BUY_YES'
    );
    const noPositions = positions.filter(p =>
      p.outcome === 'NO' || p.side === 'BUY_NO'
    );

    console.log(`YES 持仓: ${yesPositions.length} 个`);
    console.log(`NO 持仓:  ${noPositions.length} 个\n`);

    // 显示前 3 个持仓
    for (let i = 0; i < Math.min(3, positions.length); i++) {
      const pos = positions[i];
      console.log(`持仓 ${i + 1}:`);
      console.log(`  token_id:  ${pos.token_id || pos.market?.token_id || 'N/A'}`);
      console.log(`  outcome:   ${pos.outcome || pos.side || 'N/A'}`);
      console.log(`  amount:    ${pos.amount || pos.shares || pos.size || 0}`);
      console.log('');
    }

    // 5. 分析同一市场的 YES 和 NO token_id
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 步骤 5: 对比同一市场的 YES/NO Token ID');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 按 condition_id 分组
    const byCondition = new Map<string, any[]>();
    for (const pos of positions) {
      const conditionId = pos.market?.condition_id || pos.condition_id || 'unknown';
      if (!byCondition.has(conditionId)) {
        byCondition.set(conditionId, []);
      }
      byCondition.get(conditionId)!.push(pos);
    }

    // 找到同时有 YES 和 NO 持仓的市场
    for (const [conditionId, posList] of byCondition) {
      const yesPos = posList.find(p => p.outcome === 'YES' || p.side === 'BUY_YES');
      const noPos = posList.find(p => p.outcome === 'NO' || p.side === 'BUY_NO');

      if (yesPos && noPos) {
        const yesTokenId = yesPos.token_id || yesPos.market?.token_id;
        const noTokenId = noPos.token_id || noPos.market?.token_id;

        console.log(`Condition ID: ${conditionId.substring(0, 20)}...`);
        console.log(`  YES token_id: ${yesTokenId}`);
        console.log(`  NO token_id:  ${noTokenId}`);

        // 分析关系
        try {
          const yesTokenIdBigInt = BigInt(yesTokenId);
          const noTokenIdBigInt = BigInt(noTokenId);

          const diff = yesTokenIdBigInt ^ noTokenIdBigInt;
          console.log(`  XOR 结果:    ${diff.toString()} (应该等于 1)`);

          if (diff === 1n) {
            console.log(`  ✅ 确认: YES 和 NO token_id 只相差最后一位！`);
          } else {
            console.log(`  ⚠️  差异不是 1，可能使用了不同的计算方式`);
          }
        } catch (error) {
          console.log(`  ⚠️  无法解析: ${error}`);
        }

        console.log('');
        break; // 只分析第一个找到的市场
      }
    }

  } catch (error) {
    console.log(`⚠️  无法获取持仓: ${error}`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 分析完成');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// 运行分析
analyzeTokens().catch(console.error);
