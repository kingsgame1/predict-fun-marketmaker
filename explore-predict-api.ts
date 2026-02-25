/**
 * 探索 Predict.fun API endpoints
 */

import { loadConfig } from './src/config.js';

async function explorePredictApi(): Promise<void> {
  console.log('🔍 探索 Predict.fun API endpoints\n');

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

  // 要测试的 endpoints
  const endpoints = [
    // 基础 endpoints
    { path: '/v1/markets', method: 'GET', desc: '获取所有市场' },
    { path: '/v1/conditions', method: 'GET', desc: '获取所有条件' },
    { path: '/v1/outcomes', method: 'GET', desc: '获取所有 outcomes' },

    // 可能的 condition 相关 endpoints
    { path: '/v1/conditions/0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3', method: 'GET', desc: '获取特定条件（使用实际 condition_id）' },

    // 可能的 outcome endpoints
    { path: '/v1/markets/0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3/outcomes', method: 'GET', desc: '获取条件的 outcomes' },
    { path: '/v1/conditions/0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3/tokens', method: 'GET', desc: '获取条件的 tokens' },

    // Token 相关
    { path: '/v1/tokens', method: 'GET', desc: '获取所有 tokens' },
    { path: '/v1/tokens/YES', method: 'GET', desc: '获取 YES tokens' },
    { path: '/v1/tokens/NO', method: 'GET', desc: '获取 NO tokens' },

    // 可能的市场详情 endpoint
    { path: '/v1/markets/by-condition/0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3', method: 'GET', desc: '通过 condition_id 获取市场' },

    // Legacy endpoints
    { path: '/markets', method: 'GET', desc: '获取所有市场（legacy）' },
    { path: '/conditions', method: 'GET', desc: '获取所有条件（legacy）' },
  ];

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 测试 API endpoints');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const workingEndpoints: string[] = [];
  const notFoundEndpoints: string[] = [];
  const errorEndpoints: Array<{ endpoint: string; error: string }> = [];

  for (const endpoint of endpoints) {
    const url = baseUrl + endpoint.path;
    try {
      console.log(`测试: ${endpoint.method} ${endpoint.path}`);
      console.log(`  描述: ${endpoint.desc}`);

      const response = await fetch(url, {
        method: endpoint.method,
        headers,
      });

      console.log(`  状态: ${response.status}`);

      if (response.ok) {
        const contentType = response.headers.get('content-type');
        console.log(`  Content-Type: ${contentType}`);

        if (contentType?.includes('application/json')) {
          const data = await response.json();

          // 显示数据结构
          if (Array.isArray(data)) {
            console.log(`  返回: 数组，长度 ${data.length}`);
            if (data.length > 0) {
              console.log(`  示例字段: ${Object.keys(data[0]).join(', ')}`);
            }
          } else if (data && typeof data === 'object') {
            console.log(`  返回: 对象`);
            console.log(`  字段: ${Object.keys(data).join(', ')}`);

            // 检查是否有 token 相关字段
            const hasTokens = Object.keys(data).some(k =>
              k.toLowerCase().includes('token') ||
              k.toLowerCase().includes('outcome') ||
              k.toLowerCase().includes('yes') ||
              k.toLowerCase().includes('no')
            );
            if (hasTokens) {
              console.log(`  ✅ 发现 token/outcome 相关字段！`);

              // 显示相关字段
              for (const key of Object.keys(data)) {
                if (key.toLowerCase().includes('token') ||
                    key.toLowerCase().includes('outcome') ||
                    key.toLowerCase().includes('yes') ||
                    key.toLowerCase().includes('no')) {
                  const value = JSON.stringify(data[key]);
                  console.log(`     ${key}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
                }
              }
            }
          }

          workingEndpoints.push(endpoint.path);
        }

        console.log(`  ✅ 成功\n`);
      } else if (response.status === 404) {
        console.log(`  ❌ 404 Not Found\n`);
        notFoundEndpoints.push(endpoint.path);
      } else {
        const text = await response.text();
        console.log(`  ⚠️  错误: ${text.substring(0, 100)}\n`);
        errorEndpoints.push({ endpoint: endpoint.path, error: text.substring(0, 100) });
      }
    } catch (error: any) {
      console.log(`  ❌ 网络错误: ${error.message}\n`);
      errorEndpoints.push({ endpoint: endpoint.path, error: error.message });
    }

    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 总结');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`✅ 成功的 endpoints (${workingEndpoints.length}):`);
  for (const endpoint of workingEndpoints) {
    console.log(`  - ${endpoint}`);
  }

  console.log(`\n❌ 404 Not Found (${notFoundEndpoints.length}):`);
  for (const endpoint of notFoundEndpoints) {
    console.log(`  - ${endpoint}`);
  }

  if (errorEndpoints.length > 0) {
    console.log(`\n⚠️  其他错误 (${errorEndpoints.length}):`);
    for (const { endpoint, error } of errorEndpoints) {
      console.log(`  - ${endpoint}: ${error}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 下一步建议');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (workingEndpoints.length > 0) {
    console.log('✅ 找到了可用的 endpoints！');
    console.log('   建议进一步探索这些 endpoints 的数据结构');
    console.log('   看看是否可以获取 YES/NO 的 token_id');
  } else {
    console.log('⚠️  没有找到新的可用 endpoints');
    console.log('   可能需要：');
    console.log('   1. 查看 Predict.fun 官方文档');
    console.log('   2. 联系 Predict.fun 开发者支持');
    console.log('   3. 或者使用其他方法（如链上合约）');
  }
}

explorePredictApi().catch(console.error);
