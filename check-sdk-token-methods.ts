/**
 * 检查 SDK 中与 token_id 相关的方法
 */

import { OrderBuilder } from '@predictdotfun/sdk';
import { loadConfig } from './src/config.js';

async function checkSdkTokenMethods(): Promise<void> {
  console.log('🔍 检查 SDK 中的 token 相关方法\n');

  const config = loadConfig();

  try {
    // 不传入 signer，只创建一个无 signer 的实例
    const orderBuilder = OrderBuilder.make(config.chainId);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 OrderBuilder 的所有方法');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(orderBuilder))
      .filter(name => typeof (orderBuilder as any)[name] === 'function');

    console.log(`找到 ${methods.length} 个方法:\n`);

    for (const method of methods) {
      console.log(`  - ${method}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 可能相关的方法');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const relevantMethods = methods.filter(m =>
      m.toLowerCase().includes('token') ||
      m.toLowerCase().includes('position') ||
      m.toLowerCase().includes('split') ||
      m.toLowerCase().includes('merge') ||
      m.toLowerCase().includes('condition')
    );

    if (relevantMethods.length > 0) {
      console.log('找到可能相关的方法:\n');
      for (const method of relevantMethods) {
        console.log(`  ✅ ${method}`);
      }
    } else {
      console.log('⚠️  没有找到明显相关的方法');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 检查 validateTokenIds 方法');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('⚠️  当前 OrderBuilder 实例没有 signer');
    console.log('   validateTokenIds 需要 signer 和链上访问');
    console.log('   这意味着 token_id 的验证需要在链上进行');

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 检查 splitPositions 方法');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('splitPositions 参数:');
    console.log('  - conditionId: string');
    console.log('  - amount: bigint');
    console.log('  - isNegRisk: boolean');
    console.log('  - isYieldBearing: boolean');
    console.log('');
    console.log('⚠️  splitPositions 使用 conditionId，不是 token_id');
    console.log('   这说明在链上操作时，conditionId 是主要标识符');
    console.log('   token_id 可能是由链上合约自动生成或管理的');

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

checkSdkTokenMethods().catch(console.error);
