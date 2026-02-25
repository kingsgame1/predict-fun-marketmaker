/**
 * 深入探索 /v1/markets endpoint 的数据结构
 */

import { loadConfig } from './src/config.js';

async function deepExploreMarkets(): Promise<void> {
  console.log('🔍 深入探索 /v1/markets 数据结构\n');

  const config = loadConfig();
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['x-api-key'] = config.apiKey;
  }

  if (config.jwtToken) {
    headers['Authorization'] = `Bearer ${config.jwtToken}`;
  }

  try {
    // 获取市场列表
    const response = await fetch(baseUrl + '/v1/markets?limit=5', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      console.log(`❌ 请求失败: ${response.status}`);
      return;
    }

    const result = await response.json();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 API 响应结构');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('顶层字段:');
    console.log(`  ${Object.keys(result).join('\n  ')}`);
    console.log('');

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      const market = result.data[0];

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 第一个市场的完整数据');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log(JSON.stringify(market, null, 2));
      console.log('');

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 字段分析');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const allFields = Object.keys(market);
      console.log(`总字段数: ${allFields.length}\n`);

      // 分析可能相关的字段
      const relevantFields = allFields.filter(f =>
        f.toLowerCase().includes('token') ||
        f.toLowerCase().includes('outcome') ||
        f.toLowerCase().includes('yes') ||
        f.toLowerCase().includes('no') ||
        f.toLowerCase().includes('condition') ||
        f.toLowerCase().includes('position')
      );

      if (relevantFields.length > 0) {
        console.log('可能相关的字段:');
        for (const field of relevantFields) {
          const value = JSON.stringify(market[field]);
          console.log(`  ${field}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
        }
        console.log('');
      } else {
        console.log('⚠️  没有找到明显的 token/outcome 相关字段');
        console.log('');
      }

      // 检查嵌套对象
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 嵌套对象分析');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      for (const [key, value] of Object.entries(market)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          console.log(`${key}:`);
          console.log(`  字段: ${Object.keys(value).join(', ')}`);

          // 检查是否有 token 相关的嵌套字段
          const nestedTokenFields = Object.keys(value).filter(k =>
            k.toLowerCase().includes('token') ||
            k.toLowerCase().includes('outcome') ||
            k.toLowerCase().includes('yes') ||
            k.toLowerCase().includes('no')
          );

          if (nestedTokenFields.length > 0) {
            console.log(`  ✅ 包含 token/outcome 字段: ${nestedTokenFields.join(', ')}`);
            for (const nf of nestedTokenFields) {
              console.log(`     ${nf}: ${JSON.stringify((value as any)[nf])}`);
            }
          }
          console.log('');
        }
      }

      // 检查数组字段
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 数组字段分析');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      for (const [key, value] of Object.entries(market)) {
        if (Array.isArray(value)) {
          console.log(`${key}: 数组，长度 ${value.length}`);
          if (value.length > 0) {
            console.log(`  元素类型: ${typeof value[0]}`);
            console.log(`  第一个元素: ${JSON.stringify(value[0]).substring(0, 150)}...`);
          }
          console.log('');
        }
      }

      // 分析多个市场，查找模式
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 按 condition_id 分组分析');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const byConditionId = new Map<string, any[]>();
      for (const m of result.data) {
        const conditionId = m.condition_id || m.event_id || 'unknown';
        if (!byConditionId.has(conditionId)) {
          byConditionId.set(conditionId, []);
        }
        byConditionId.get(conditionId)!.push(m);
      }

      console.log(`找到 ${byConditionId.size} 个唯一的 condition_id\n`);

      // 检查是否有多个市场共享同一个 condition_id
      let multiMarketCount = 0;
      for (const [conditionId, markets] of byConditionId) {
        if (markets.length > 1) {
          multiMarketCount++;
          console.log(`✅ condition_id: ${conditionId.substring(0, 20)}...`);
          console.log(`   市场数量: ${markets.length}`);

          for (const m of markets) {
            console.log(`     - token_id: ${m.token_id}`);
            console.log(`       outcome: ${m.outcome || 'N/A'}`);
            console.log(`       question: ${m.question?.substring(0, 40)}...`);
          }
          console.log('');
        }
      }

      if (multiMarketCount === 0) {
        console.log('⚠️  没有找到多个市场共享同一个 condition_id');
        console.log('   这证实了：每个 condition_id 在 API 中只返回一个市场对象');
        console.log('');

        // 尝试通过其他方式分组
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 尝试通过问题分组');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const byQuestion = new Map<string, any[]>();
        for (const m of result.data) {
          // 标准化问题文本
          const question = m.question?.toLowerCase()
            .replace(/\b(yes|no|true|false)\b/g, '')
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'unknown';

          if (!byQuestion.has(question)) {
            byQuestion.set(question, []);
          }
          byQuestion.get(question)!.push(m);
        }

        console.log(`找到 ${byQuestion.size} 个唯一的问题\n`);

        for (const [question, markets] of byQuestion) {
          if (markets.length > 1) {
            console.log(`✅ 问题: ${question.substring(0, 50)}...`);
            console.log(`   市场数量: ${markets.length}`);

            for (const m of markets) {
              console.log(`     - token_id: ${m.token_id}`);
              console.log(`       outcome: ${m.outcome || 'N/A'}`);
            }
            console.log('');
          }
        }
      }

    } else {
      console.log('⚠️  没有市场数据');
    }

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

deepExploreMarkets().catch(console.error);
