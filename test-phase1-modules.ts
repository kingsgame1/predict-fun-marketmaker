/**
 * Phase 1 模块测试脚本
 *
 * 验证5个核心模块的基本功能
 */

import {
  VolatilityEstimator,
  OrderFlowEstimator,
  InventoryClassifier,
  InventoryState,
  MeanReversionPredictor
} from './src/analysis/types.js';

import {
  DynamicASModel
} from './src/pricing/types.js';

console.log('🧪 开始测试 Phase 1 模块...\n');

// ===== 测试 1: 波动率估算器 =====
console.log('📊 测试 1: 波动率估算器');
try {
  const volEstimator = new VolatilityEstimator();

  // 模拟价格更新
  const prices = [0.50, 0.51, 0.49, 0.52, 0.48, 0.50, 0.53, 0.47, 0.51, 0.50];
  for (const price of prices) {
    volEstimator.updatePrice(price);
  }

  const volatility = volEstimator.getVolatility();
  console.log(`✅ 当前波动率: ${(volatility * 100).toFixed(2)}%`);
  console.log(`✅ 历史波动率 (10分钟): ${(volEstimator.getHistoricalVolatility(10) * 100).toFixed(2)}%`);
  console.log(`✅ 波动率趋势: ${volEstimator.getVolatilityTrend(30)}`);
  console.log('');
} catch (error) {
  console.error('❌ 波动率估算器测试失败:', error);
  console.log('');
}

// ===== 测试 2: 订单流估算器 =====
console.log('📈 测试 2: 订单流估算器');
try {
  const flowEstimator = new OrderFlowEstimator();

  // 模拟订单事件
  for (let i = 0; i < 20; i++) {
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const amount = 20 + Math.random() * 30;
    flowEstimator.recordOrder(side, amount, 0.50);
  }

  const metrics = flowEstimator.getMetrics(1);
  console.log(`✅ 每分钟订单数: ${metrics.ordersPerMinute.toFixed(2)}`);
  console.log(`✅ 每分钟金额: $${metrics.volumePerMinute.toFixed(2)}`);
  console.log(`✅ 买方比例: ${(metrics.buyRatio * 100).toFixed(1)}%`);
  console.log(`✅ 订单流方向: ${metrics.direction}`);
  console.log(`✅ 是否激增: ${flowEstimator.detectSurge()}`);
  console.log('');
} catch (error) {
  console.error('❌ 订单流估算器测试失败:', error);
  console.log('');
}

// ===== 测试 3: 库存分类器 =====
console.log('🎯 测试 3: 库存分类器');
try {
  const classifier = new InventoryClassifier({
    safeThreshold: 0.3,
    warningThreshold: 0.5,
    dangerThreshold: 0.7
  });

  // 测试不同库存状态
  const testCases = [
    { netShares: 10, maxPosition: 100, expected: InventoryState.SAFE },
    { netShares: 40, maxPosition: 100, expected: InventoryState.WARNING },
    { netShares: 60, maxPosition: 100, expected: InventoryState.DANGER },
    { netShares: 80, maxPosition: 100, expected: InventoryState.CRITICAL }
  ];

  for (const testCase of testCases) {
    const state = classifier.classify('0xtoken', testCase.netShares, testCase.maxPosition);
    const info = classifier.getInventoryInfo('0xtoken', testCase.netShares, testCase.maxPosition);
    const strategy = classifier.getStrategy(state, testCase.netShares, testCase.maxPosition);

    console.log(`✅ 库存 ${testCase.netShares}/${testCase.maxPosition}: ${state}`);
    console.log(`   - 描述: ${classifier.getStateDescription(state)}`);
    console.log(`   - 允许挂单: ${strategy.allowOrders}`);
    console.log(`   - 价差倍数: ${strategy.spreadMultiplier}x`);
    console.log(`   - 订单大小倍数: ${strategy.sizeMultiplier}x`);
  }
  console.log('');
} catch (error) {
  console.error('❌ 库存分类器测试失败:', error);
  console.log('');
}

// ===== 测试 4: 均值回归预测器 =====
console.log('🔮 测试 4: 均值回归预测器');
try {
  const predictor = new MeanReversionPredictor();

  // 模拟库存历史
  const tokenId = '0xtoken';
  const maxPosition = 100;

  for (let i = 0; i < 10; i++) {
    predictor.recordInventory(tokenId, 50 + Math.random() * 10, maxPosition);
  }

  const prediction = predictor.predictTimeToTarget(50, maxPosition, 0.1);
  console.log(`✅ 当前库存: 50/${maxPosition} (50%)`);
  console.log(`✅ 目标: 回归到10%以内`);
  console.log(`✅ 预计时间: ${prediction.estimatedMinutes.toFixed(1)} 分钟`);
  console.log(`✅ 置信度: ${(prediction.confidence * 100).toFixed(1)}%`);

  // 测试校准
  predictor.calibrateModel(tokenId);
  console.log(`✅ 模型参数已校准`);
  console.log('');
} catch (error) {
  console.error('❌ 均值回归预测器测试失败:', error);
  console.log('');
}

// ===== 测试 5: 动态 AS 模型 =====
console.log('💰 测试 5: 动态 AS 模型');
try {
  const asModel = new DynamicASModel({
    gamma: 0.1,
    lambda: 1.0,
    kappa: 1.5,
    alpha: 0.5,
    beta: 0.3
  });

  // 测试不同市场状态
  const testStates = [
    {
      name: '低波动 + 中性库存',
      state: {
        midPrice: 0.50,
        inventory: 0.0,
        volatility: 0.15,
        orderFlow: 20,
        depth: 5000
      }
    },
    {
      name: '高波动 + 多头库存',
      state: {
        midPrice: 0.50,
        inventory: 0.6,
        volatility: 0.40,
        orderFlow: 50,
        depth: 8000
      }
    },
    {
      name: '极端库存 + 低流动性',
      state: {
        midPrice: 0.50,
        inventory: 0.8,
        volatility: 0.25,
        orderFlow: 5,
        depth: 1000
      }
    }
  ];

  for (const test of testStates) {
    const spread = asModel.calculateOptimalSpread(test.state);
    const quotes = asModel.calculateOptimalQuotes(test.state.midPrice, test.state);

    console.log(`✅ 场景: ${test.name}`);
    console.log(`   - 最优价差: ${(spread * 100).toFixed(2)}%`);
    console.log(`   - 买价: $${quotes.bidPrice.toFixed(4)}`);
    console.log(`   - 卖价: $${quotes.askPrice.toFixed(4)}`);
    console.log(`   - 建议订单大小: $${quotes.suggestedSize.toFixed(2)}`);
  }

  console.log(`\n✅ 模型参数:`);
  const params = asModel.getParameters();
  console.log(`   - γ (风险厌恶): ${params.gamma}`);
  console.log(`   - λ (订单速率): ${params.lambda}`);
  console.log(`   - κ (价格弹性): ${params.kappa}`);
  console.log(`   - α (库存影响): ${params.alpha}`);
  console.log(`   - β (波动率影响): ${params.beta}`);
  console.log('');
} catch (error) {
  console.error('❌ 动态 AS 模型测试失败:', error);
  console.log('');
}

// ===== 综合测试 =====
console.log('🔄 综合测试: 模拟完整做市流程');
try {
  const volEstimator = new VolatilityEstimator();
  const flowEstimator = new OrderFlowEstimator();
  const classifier = new InventoryClassifier();
  const predictor = new MeanReversionPredictor();
  const asModel = new DynamicASModel();

  const tokenId = '0xtest123';
  const maxPosition = 200;
  let currentInventory = 0;

  // 模拟10个时间步
  for (let step = 1; step <= 10; step++) {
    // 1. 价格更新
    const price = 0.50 + (Math.random() - 0.5) * 0.05;
    volEstimator.updatePrice(price);

    // 2. 订单流
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const amount = 25;
    flowEstimator.recordOrder(side, amount, price);

    // 3. 库存变化
    if (side === 'BUY') {
      currentInventory += Math.floor(amount / price);
    } else {
      currentInventory -= Math.floor(amount / price);
    }
    predictor.recordInventory(tokenId, currentInventory, maxPosition);

    // 4. 计算状态
    const state = {
      midPrice: price,
      inventory: currentInventory / maxPosition,
      volatility: volEstimator.getVolatility(),
      orderFlow: flowEstimator.getFlowIntensity(1),
      depth: 5000
    };

    // 5. 分类库存
    const invState = classifier.classify(tokenId, currentInventory, maxPosition);
    const strategy = classifier.getStrategy(invState, currentInventory, maxPosition);

    // 6. 计算报价
    const quotes = asModel.calculateOptimalQuotes(price, state);

    console.log(`Step ${step}:`);
    console.log(`  价格: $${price.toFixed(4)}`);
    console.log(`  库存: ${currentInventory} (${invState})`);
    console.log(`  波动率: ${(state.volatility * 100).toFixed(2)}%`);
    console.log(`  订单流: ${state.orderFlow.toFixed(1)} 单/分钟`);
    console.log(`  买价: $${quotes.bidPrice.toFixed(4)} | 卖价: $${quotes.askPrice.toFixed(4)}`);
    console.log(`  允许挂单: ${strategy.allowOrders} | 价差倍数: ${strategy.spreadMultiplier}x`);
    console.log('');
  }

  console.log('✅ 综合测试完成!');
} catch (error) {
  console.error('❌ 综合测试失败:', error);
}

console.log('\n🎉 所有测试完成!');
