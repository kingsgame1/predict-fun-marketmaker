/**
 * Phase 1 集成测试脚本
 *
 * 验证增强模块是否正确集成到 market-maker.ts 中
 */

import { MarketMaker } from './market-maker.js';
import type { Config } from './types.js';

console.log('🧪 开始 Phase 1 集成测试...\n');

// 创建一个模拟的配置
const mockConfig: Partial<Config> = {
  apiBaseUrl: 'https://api.predict.fun',
  privateKey: '0x' + '00'.repeat(31) + '01', // 模拟私钥
  predictAccountAddress: '0x1234567890123456789012345678901234567890',
  spread: 0.015,
  minSpread: 0.008,
  maxSpread: 0.055,
  orderSize: 25,
  maxPosition: 100,
  maxDailyLoss: 200,
  enableTrading: false,

  // Phase 1 配置
  mmEnhancedSpreadEnabled: true,
  mmASModelWeight: 0.5,
  mmASGamma: 0.1,
  mmASLambda: 1.0,
  mmASKappa: 1.5,
  mmASAlpha: 0.5,
  mmASBeta: 0.3,
  mmASDelta: 0.2,
  mmInventorySafeThreshold: 0.3,
  mmInventoryWarningThreshold: 0.5,
  mmInventoryDangerThreshold: 0.7,
};

console.log('✅ 配置创建成功');
console.log('   - mmEnhancedSpreadEnabled:', mockConfig.mmEnhancedSpreadEnabled);
console.log('   - mmASModelWeight:', mockConfig.mmASModelWeight);
console.log('');

// 测试：验证新模块是否正确导入
console.log('📦 测试 1: 验证模块导入');

try {
  // 这些导入应该在 market-maker.ts 中
  const fs = await import('node:fs');
  const marketMakerCode = fs.readFileSync('./src/market-maker.ts', 'utf-8');

  const imports = [
    'VolatilityEstimator',
    'OrderFlowEstimator',
    'InventoryClassifier',
    'InventoryState',
    'MeanReversionPredictor',
    'DynamicASModel'
  ];

  let allFound = true;
  for (const imp of imports) {
    if (marketMakerCode.includes(imp)) {
      console.log(`   ✅ 找到导入: ${imp}`);
    } else {
      console.log(`   ❌ 缺少导入: ${imp}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ 所有模块导入正确\n');
  } else {
    console.log('   ❌ 部分模块导入缺失\n');
  }
} catch (error) {
  console.log('   ❌ 模块导入检查失败:', error);
}

// 测试：验证新字段是否添加
console.log('📝 测试 2: 验证新字段添加');

try {
  const fs = await import('node:fs');
  const marketMakerCode = fs.readFileSync('./src/market-maker.ts', 'utf-8');

  const fields = [
    'perMarketVolatility',
    'perMarketOrderFlow',
    'perMarketReversion',
    'perMarketInventoryState',
    'volatilityEstimator',
    'orderFlowEstimator',
    'inventoryClassifier',
    'reversionPredictor',
    'asModel'
  ];

  let allFound = true;
  for (const field of fields) {
    if (marketMakerCode.includes(`private ${field}`)) {
      console.log(`   ✅ 找到字段: ${field}`);
    } else {
      console.log(`   ❌ 缺少字段: ${field}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ 所有字段添加正确\n');
  } else {
    console.log('   ❌ 部分字段缺失\n');
  }
} catch (error) {
  console.log('   ❌ 字段检查失败:', error);
}

// 测试：验证配置参数是否添加
console.log('⚙️  测试 3: 验证配置参数');

try {
  const fs = await import('node:fs');
  const typesCode = fs.readFileSync('./src/types.ts', 'utf-8');

  const configParams = [
    'mmEnhancedSpreadEnabled',
    'mmASModelWeight',
    'mmASGamma',
    'mmASLambda',
    'mmASKappa',
    'mmASAlpha',
    'mmASBeta',
    'mmASDelta',
    'mmInventorySafeThreshold',
    'mmInventoryWarningThreshold',
    'mmInventoryDangerThreshold'
  ];

  let allFound = true;
  for (const param of configParams) {
    if (typesCode.includes(param)) {
      console.log(`   ✅ 找到参数: ${param}`);
    } else {
      console.log(`   ❌ 缺少参数: ${param}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ 所有配置参数添加正确\n');
  } else {
    console.log('   ❌ 部分配置参数缺失\n');
  }
} catch (error) {
  console.log('   ❌ 配置参数检查失败:', error);
}

// 测试：验证辅助方法是否添加
console.log('🔧 测试 4: 验证辅助方法');

try {
  const fs = await import('node:fs');
  const marketMakerCode = fs.readFileSync('./src/market-maker.ts', 'utf-8');

  const methods = [
    'getOrCreateVolatilityEstimator',
    'getOrCreateOrderFlowEstimator',
    'getOrCreateReversionPredictor',
    'updateAdvancedMetrics',
    'recordOrderFlow',
    'getEnhancedInventoryState'
  ];

  let allFound = true;
  for (const method of methods) {
    if (marketMakerCode.includes(method)) {
      console.log(`   ✅ 找到方法: ${method}`);
    } else {
      console.log(`   ❌ 缺少方法: ${method}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ 所有辅助方法添加正确\n');
  } else {
    console.log('   ❌ 部分辅助方法缺失\n');
  }
} catch (error) {
  console.log('   ❌ 辅助方法检查失败:', error);
}

// 测试：验证 AS 模型集成
console.log('💰 测试 5: 验证 AS 模型集成');

try {
  const fs = await import('node:fs');
  const marketMakerCode = fs.readFileSync('./src/market-maker.ts', 'utf-8');

  const asModelIntegrations = [
    'asEnhancedSpread',
    'asMarketState',
    'asOptimalSpread',
    'calculateOptimalSpread',
    'this.asModel.'
  ];

  let allFound = true;
  for (const integration of asModelIntegrations) {
    if (marketMakerCode.includes(integration)) {
      console.log(`   ✅ 找到 AS 模型集成: ${integration}`);
    } else {
      console.log(`   ❌ 缺少 AS 模型集成: ${integration}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ AS 模型集成正确\n');
  } else {
    console.log('   ❌ AS 模型集成不完整\n');
  }
} catch (error) {
  console.log('   ❌ AS 模型集成检查失败:', error);
}

// 测试：验证库存分类器集成
console.log('🎯 测试 6: 验证库存分类器集成');

try {
  const fs = await import('node:fs');
  const marketMakerCode = fs.readFileSync('./src/market-maker.ts', 'utf-8');

  const classifierIntegrations = [
    'inventoryClassifier.classify',
    'inventoryClassifier.getStrategy',
    'InventoryState',
    'strategy.spreadMultiplier',
    'strategy.allowOrders'
  ];

  let allFound = true;
  for (const integration of classifierIntegrations) {
    if (marketMakerCode.includes(integration)) {
      console.log(`   ✅ 找到库存分类器集成: ${integration}`);
    } else {
      console.log(`   ❌ 缺少库存分类器集成: ${integration}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('   ✅ 库存分类器集成正确\n');
  } else {
    console.log('   ❌ 库存分类器集成不完整\n');
  }
} catch (error) {
  console.log('   ❌ 库存分类器集成检查失败:', error);
}

console.log('🎉 集成测试完成！');
console.log('\n📋 下一步：');
console.log('1. 在 .env 中添加新配置参数');
console.log('2. 启动模拟模式测试: SIMULATION_MODE=true npm start');
console.log('3. 观察日志中的增强指标输出');
console.log('4. 调整参数优化效果');
