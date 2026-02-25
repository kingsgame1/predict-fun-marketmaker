/**
 * 检查订单簿数据中是否有多个 token_id
 */

import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function checkOrderbookTokens(): Promise<void> {
  console.log('🔍 检查订单簿中的 token 信息\n');

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

    // 检查前 3 个市场的订单簿
    let count = 0;
    for (const market of markets) {
      if (count >= 3) break;

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`市场 ${count + 1}: ${market.question?.substring(0, 50)}...`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(`condition_id: ${market.condition_id}`);
      console.log(`token_id: ${market.token_id}`);
      console.log(`is_neg_risk: ${market.is_neg_risk}`);
      console.log(`is_yield_bearing: ${market.is_yield_bearing}`);
      console.log('');

      try {
        const orderbook = await api.getOrderbook(market.token_id);

        console.log(`订单簿数据:`);
        console.log(`  best_bid: ${orderbook.best_bid || 'N/A'}`);
        console.log(`  best_ask: ${orderbook.best_ask || 'N/A'}`);
        console.log(`  bids 数量: ${orderbook.bids?.length || 0}`);
        console.log(`  asks 数量: ${orderbook.asks?.length || 0}`);
        console.log('');

        // 检查订单条目中是否有不同的 token_id
        const uniqueTokenIds = new Set<string>();

        if (orderbook.bids && orderbook.bids.length > 0) {
          for (const bid of orderbook.bids.slice(0, 5)) {
            // 检查 bid 对象的所有字段
            console.log(`  Bid 示例:`, JSON.stringify(bid).substring(0, 200));
            if (bid.token_id) uniqueTokenIds.add(bid.token_id);
            if (bid.orderbook_id) console.log(`    orderbook_id: ${bid.orderbook_id}`);
            break; // 只显示第一个
          }
        }

        if (orderbook.asks && orderbook.asks.length > 0) {
          for (const ask of orderbook.asks.slice(0, 5)) {
            // 检查 ask 对象的所有字段
            console.log(`  Ask 示例:`, JSON.stringify(ask).substring(0, 200));
            if (ask.token_id) uniqueTokenIds.add(ask.token_id);
            if (ask.orderbook_id) console.log(`    orderbook_id: ${ask.orderbook_id}`);
            break; // 只显示第一个
          }
        }

        if (uniqueTokenIds.size > 1) {
          console.log(`\n  ✅ 发现有 ${uniqueTokenIds.size} 个不同的 token_id:`);
          for (const tokenId of uniqueTokenIds) {
            console.log(`     - ${tokenId}`);
          }
        } else if (uniqueTokenIds.size === 1) {
          console.log(`\n  ⚠️  只有 1 个 token_id: ${Array.from(uniqueTokenIds)[0]}`);
        } else {
          console.log(`\n  ⚠️  订单条目中没有 token_id 字段`);
        }

        console.log('');

      } catch (error: any) {
        console.log(`⚠️  获取订单簿失败: ${error.message}\n`);
      }

      count++;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 结论');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('检查结果：');
    console.log('1. ✅ 订单簿可以成功获取');
    console.log('2. ⚠️  需要查看订单条目中是否有不同的 token_id');
    console.log('3. 📝 如果没有，说明每个订单簿只对应一个 outcome 的 token');
    console.log('');
    console.log('下一步：');
    console.log('- 如果每个 token_id 对应一个 outcome');
    console.log('- 需要找到另一个 token_id（可能是通过不同的 API endpoint）');
    console.log('- 或者通过链上合约计算');

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

checkOrderbookTokens().catch(console.error);
