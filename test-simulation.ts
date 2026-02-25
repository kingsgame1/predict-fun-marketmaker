/**
 * 模拟模式测试脚本
 *
 * 测试 Phase 1 增强模块在模拟环境下的表现
 */

import { VolatilityEstimator } from './src/analysis/volatility-estimator.js';
import { OrderFlowEstimator } from './src/analysis/order-flow-estimator.js';
import { InventoryClassifier, InventoryState } from './src/analysis/inventory-classifier.js';
import { MeanReversionPredictor } from './src/analysis/mean-reversion-predictor.js';
import { DynamicASModel } from './src/pricing/dynamic-as-model.js';

console.log('🧪 Phase 1 模拟模式测试');
console.log('='.repeat(60));
console.log('');

// ===== 模拟场景 =====
console.log('📊 场景: 模拟做市商运行 10 个时间步');
console.log('');

// 初始化模块
const volEstimator = new VolatilityEstimator();
const flowEstimator = new OrderFlowEstimator();
const inventoryClassifier = new InventoryClassifier();
const reversionPredictor = new MeanReversionPredictor();
const asModel = new DynamicASModel();

// 模拟参数
const tokenId = '0xtest123';
const maxPosition = 200; // 最大持仓 $200
let currentInventory = 0; // 当前库存
let currentPrice = 0.50;

console.log('初始状态:');
console.log(`  - 当前价格: $${currentPrice.toFixed(4)}`);
console.log(`  - 当前库存: ${currentInventory} (中性)`);
console.log(`  - 最大持仓: $${maxPosition}`);
console.log('');

// 模拟 10 个时间步
for (let step = 1; step <= 10; step++) {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`⏰ 时间步 ${step}`);
  console.log('');

  // 1. 模拟价格变化 (随机游走)
  const priceChange = (Math.random() - 0.5) * 0.02; // ±1% 变化
  currentPrice = Math.max(0.01, Math.min(0.99, currentPrice + priceChange));

  // 更新波动率估算器
  volEstimator.updatePrice(currentPrice);
  const volatility = volEstimator.getVolatility();
  const volatilityTrend = volEstimator.getVolatilityTrend(30);

  // 2. 模拟订单流 (随机订单)
  const side = Math.random() > 0.45 ? 'BUY' : 'SELL'; // 稍微偏向买单
  const amount = 20 + Math.random() * 30; // $20-$50
  flowEstimator.recordOrder(side, amount, currentPrice);

  // 模拟库存变化
  if (side === 'BUY') {
    currentInventory += Math.floor(amount / currentPrice);
  } else {
    currentInventory -= Math.floor(amount / currentPrice);
  }

  const flowMetrics = flowEstimator.getMetrics(1);
  const orderFlow = flowEstimator.getFlowIntensity(1);

  // 3. 更新库存预测器
  reversionPredictor.recordInventory(tokenId, currentInventory, maxPosition);

  // 4. 分类库存状态
  const inventoryState = inventoryClassifier.classify(tokenId, currentInventory, maxPosition);
  const inventoryBias = currentInventory / maxPosition;
  const strategy = inventoryClassifier.getStrategy(inventoryState, currentInventory, maxPosition);

  // 5. 使用 AS 模型计算最优价差
  const marketState = {
    midPrice: currentPrice,
    inventory: inventoryBias,
    volatility: volatility,
    orderFlow: orderFlow,
    depth: 5000
  };

  const optimalSpread = asModel.calculateOptimalSpread(marketState);
  const optimalQuotes = asModel.calculateOptimalQuotes(currentPrice, marketState);

  // 6. 输出当前状态
  console.log('📈 价格与波动率:');
  console.log(`  - 当前价格: $${currentPrice.toFixed(4)}`);
  console.log(`  - 价格变化: ${(priceChange * 100).toFixed(2)}%`);
  console.log(`  - 波动率: ${(volatility * 100).toFixed(2)}%`);
  console.log(`  - 波动率趋势: ${volatilityTrend}`);
  console.log('');

  console.log('📊 订单流:');
  console.log(`  - 最近订单: ${side} $${amount.toFixed(2)}`);
  console.log(`  - 每分钟订单: ${flowMetrics.ordersPerMinute.toFixed(1)} 单`);
  console.log(`  - 买方比例: ${(flowMetrics.buyRatio * 100).toFixed(1)}%`);
  console.log(`  - 流动性方向: ${flowMetrics.direction}`);
  console.log(`  - 是否激增: ${flowEstimator.detectSurge() ? '✅ 是' : '❌ 否'}`);
  console.log('');

  console.log('🎯 库存状态:');
  console.log(`  - 当前库存: ${currentInventory.toFixed(0)} 股`);
  console.log(`  - 库存偏斜: ${(inventoryBias * 100).toFixed(1)}%`);
  console.log(`  - 库存等级: ${inventoryState}`);
  console.log(`  - 描述: ${inventoryClassifier.getStateDescription(inventoryState)}`);
  console.log(`  - 策略:`,
    `价差×${strategy.spreadMultiplier}, `,
    `订单×${strategy.sizeMultiplier}, `,
    `允许挂单:${strategy.allowOrders ? '✅' : '❌'}`);
  if (strategy.singleSide) {
    console.log(`  - 单边挂单: ${strategy.singleSide} (只允许${strategy.singleSide}单)`);
  }
  console.log('');

  console.log('💰 AS 模型最优报价:');
  console.log(`  - 最优价差: ${(optimalSpread * 100).toFixed(2)}%`);
  console.log(`  - 理论买价: $${optimalQuotes.bidPrice.toFixed(4)}`);
  console.log(`  - 理论卖价: $${optimalQuotes.askPrice.toFixed(4)}`);
  console.log(`  - 建议订单大小: $${optimalQuotes.suggestedSize.toFixed(2)}`);
  console.log('');

  // 7. 均值回归预测
  if (Math.abs(inventoryBias) > 0.1) {
    const prediction = reversionPredictor.predictTimeToTarget(
      currentInventory,
      maxPosition,
      0.1  // 回归到10%以内
    );

    console.log('🔮 均值回归预测:');
    console.log(`  - 当前偏斜: ${(inventoryBias * 100).toFixed(1)}%`);
    console.log(`  - 目标偏斜: 10%`);
    console.log(`  - 预计时间: ${prediction.estimatedMinutes.toFixed(1)} 分钟`);
    console.log(`  - 置信度: ${(prediction.confidence * 100).toFixed(1)}%`);
    console.log('');

    const shouldAlert = reversionPredictor.shouldAlert(tokenId, currentInventory, maxPosition, 0.1, 30);
    if (shouldAlert) {
      console.log(`  ⚠️  警报: 库存超过30分钟未回归！`);
    }
    console.log('');
  }

  // 8. 模拟第二档挂单
  const touchBufferBps = 10; // 0.1% 偏移
  const buffer = touchBufferBps / 10000;
  const bestBid = currentPrice * (1 - 0.005); // 假设市场第一档买价
  const bestAsk = currentPrice * (1 + 0.005); // 假设市场第一档卖价

  const finalBid = optimalQuotes.bidPrice * (1 - buffer);
  const finalAsk = optimalQuotes.askPrice * (1 + buffer);

  console.log('📍 最终挂单价格 (第二档):');
  console.log(`  - 市场第一档: bid=$${bestBid.toFixed(4)}, ask=$${bestAsk.toFixed(4)}`);
  console.log(`  - AS理论价格: bid=$${optimalQuotes.bidPrice.toFixed(4)}, ask=$${optimalQuotes.askPrice.toFixed(4)}`);
  console.log(`  - 最终挂单价: bid=$${finalBid.toFixed(4)}, ask=$${finalAsk.toFixed(4)}`);
  console.log(`  - 与中间价差: bid=${((currentPrice - finalBid) / currentPrice * 100).toFixed(2)}%, ask=${((finalAsk - currentPrice) / currentPrice * 100).toFixed(2)}%`);
  console.log('');

  // 等待一下，方便观察
  await new Promise(resolve => setTimeout(resolve, 100));
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 模拟测试完成！');
console.log('');
console.log('📊 总结:');
console.log(`  - 总时间步: 10`);
console.log(`  - 最终价格: $${currentPrice.toFixed(4)}`);
console.log(`  - 最终库存: ${currentInventory.toFixed(0)} 股`);
console.log(`  - 最终波动率: ${(volEstimator.getVolatility() * 100).toFixed(2)}%`);
console.log(`  - 总订单数: ${flowEstimator.getHistorySize()}`);
console.log('');
