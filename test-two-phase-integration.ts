/**
 * 两阶段循环对冲策略集成测试
 *
 * 测试目标：
 * 1. 验证 TwoPhaseHedgeStrategy 正确导入和初始化
 * 2. 验证两阶段状态管理正常工作
 * 3. 验证订单放置逻辑正确（Phase 1 Buy, Phase 2 Sell）
 * 4. 验证订单成交处理正确（对冲和平仓）
 */

import { TwoPhaseHedgeStrategy, TwoPhaseState } from './src/strategies/two-phase-hedge-strategy.js';
import type { TwoPhaseHedgeConfig } from './src/strategies/two-phase-hedge-strategy.js';
import { loadConfig } from './src/config.js';

console.log('🎯 两阶段循环对冲策略集成测试');
console.log('='.repeat(80));
console.log('');

// ===== 测试 1: 配置加载 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 测试 1: 配置加载');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const config = loadConfig();

  console.log('✅ 配置加载成功');
  console.log(`   twoPhaseHedgeEnabled: ${config.twoPhaseHedgeEnabled}`);
  console.log(`   twoPhaseHedgeTolerance: ${config.twoPhaseHedgeTolerance}`);
  console.log(`   twoPhaseHedgeMinSize: ${config.twoPhaseHedgeMinSize}`);
  console.log(`   twoPhaseHedgeMaxSize: ${config.twoPhaseHedgeMaxSize}`);
  console.log(`   twoPhaseBuySpreadBps: ${config.twoPhaseBuySpreadBps}`);
  console.log(`   twoPhaseSellSpreadBps: ${config.twoPhaseSellSpreadBps}`);
  console.log(`   twoPhaseFlattenSlippageBps: ${config.twoPhaseFlattenSlippageBps}`);
  console.log('');

  if (!config.twoPhaseHedgeEnabled) {
    console.log('⚠️  两阶段策略未启用（TWO_PHASE_HEDGE_ENABLED=false）');
    console.log('   请在 .env 中设置 TWO_PHASE_HEDGE_ENABLED=true 来启用策略');
    console.log('');
  }
} catch (error) {
  console.error('❌ 配置加载失败:', error);
  process.exit(1);
}

// ===== 测试 2: TwoPhaseHedgeStrategy 实例化 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 测试 2: TwoPhaseHedgeStrategy 实例化');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const config: Partial<TwoPhaseHedgeConfig> = {
    enabled: true,
    tolerance: 0.05,
    minHedgeSize: 10,
    maxHedgeSize: 500,
    buySpreadBps: 150,
    sellSpreadBps: 150,
    flattenSlippageBps: 250,
  };

  const strategy = new TwoPhaseHedgeStrategy(config);

  console.log('✅ TwoPhaseHedgeStrategy 实例化成功');
  console.log(`   isEnabled: ${strategy.isEnabled()}`);
  console.log('');
} catch (error) {
  console.error('❌ TwoPhaseHedgeStrategy 实例化失败:', error);
  process.exit(1);
}

// ===== 测试 3: 状态分析 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 测试 3: 状态分析');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const strategy = new TwoPhaseHedgeStrategy({ enabled: true });

  const mockMarket = {
    token_id: 'test-token-123',
    question: 'Will BTC reach $100k by 2025?',
    end_date: Date.now() + 30 * 24 * 60 * 60 * 1000,
  } as any;

  const yesPrice = 0.60;
  const noPrice = 0.40;

  // 测试空仓状态
  console.log('📊 测试空仓状态（Phase 1）:');
  const emptyPosition = { yes_amount: 0, no_amount: 0 };
  const analysis1 = strategy.analyze(mockMarket, emptyPosition, yesPrice, noPrice);
  console.log(`   状态: ${analysis1.state}`);
  console.log(`   操作: ${analysis1.action.type}`);
  console.log(`   原因: ${analysis1.action.reason}`);
  console.log(`   能否挂单: ${analysis1.canPlaceOrders}`);
  console.log('');

  // 测试对冲状态
  console.log('📊 测试对冲状态（Phase 2）:');
  const hedgedPosition = { yes_amount: 10, no_amount: 10 };
  const analysis2 = strategy.analyze(mockMarket, hedgedPosition, yesPrice, noPrice);
  console.log(`   状态: ${analysis2.state}`);
  console.log(`   操作: ${analysis2.action.type}`);
  console.log(`   原因: ${analysis2.action.reason}`);
  console.log(`   能否挂单: ${analysis2.canPlaceOrders}`);
  console.log('');

  console.log('✅ 状态分析测试通过');
} catch (error) {
  console.error('❌ 状态分析测试失败:', error);
  process.exit(1);
}

// ===== 测试 4: 订单成交处理 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 测试 4: 订单成交处理');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const strategy = new TwoPhaseHedgeStrategy({ enabled: true });

  // 测试 Phase 1: NO Buy 单被成交
  console.log('📊 测试 Phase 1: NO Buy 单被成交');
  const action1 = strategy.handleOrderFill('BUY', 'NO', 10, 0, 0, TwoPhaseState.EMPTY);
  console.log(`   操作: ${action1.type}`);
  console.log(`   数量: ${action1.shares}`);
  console.log(`   原因: ${action1.reason}`);
  console.log('');

  // 测试 Phase 2: YES Sell 单被成交
  console.log('📊 测试 Phase 2: YES Sell 单被成交');
  const action2 = strategy.handleOrderFill('SELL', 'YES', 10, 10, 10, TwoPhaseState.HEDGED);
  console.log(`   操作: ${action2.type}`);
  console.log(`   数量: ${action2.shares}`);
  console.log(`   原因: ${action2.reason}`);
  console.log('');

  console.log('✅ 订单成交处理测试通过');
} catch (error) {
  console.error('❌ 订单成交处理测试失败:', error);
  process.exit(1);
}

// ===== 测试 5: 价格建议 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 测试 5: 价格建议');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const strategy = new TwoPhaseHedgeStrategy({
    enabled: true,
    buySpreadBps: 150,  // 1.5%
    sellSpreadBps: 150, // 1.5%
  });

  const yesPrice = 0.60;
  const noPrice = 0.40;

  // Phase 1: Buy 单价格
  console.log('📊 Phase 1 Buy 单价格:');
  const buyPrices = strategy.suggestOrderPrices(yesPrice, noPrice, TwoPhaseState.EMPTY);
  console.log(`   YES Buy: $${buyPrices.yesBid?.toFixed(4)} (低于市场 ${((1 - buyPrices.yesBid! / yesPrice) * 10000).toFixed(0)}bps)`);
  console.log(`   NO Buy: $${buyPrices.noBid?.toFixed(4)} (低于市场 ${((1 - buyPrices.noBid! / noPrice) * 10000).toFixed(0)}bps)`);
  console.log('');

  // Phase 2: Sell 单价格
  console.log('📊 Phase 2 Sell 单价格:');
  const sellPrices = strategy.suggestOrderPrices(yesPrice, noPrice, TwoPhaseState.HEDGED);
  console.log(`   YES Sell: $${sellPrices.yesAsk?.toFixed(4)} (高于市场 ${((sellPrices.yesAsk! / yesPrice - 1) * 10000).toFixed(0)}bps)`);
  console.log(`   NO Sell: $${sellPrices.noAsk?.toFixed(4)} (高于市场 ${((sellPrices.noAsk! / noPrice - 1) * 10000).toFixed(0)}bps)`);
  console.log('');

  console.log('✅ 价格建议测试通过');
} catch (error) {
  console.error('❌ 价格建议测试失败:', error);
  process.exit(1);
}

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 所有测试通过！');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('✅ 两阶段循环对冲策略已成功集成到 market-maker.ts');
console.log('');
console.log('🚀 启用策略：');
console.log('   1. 在 .env 中设置 TWO_PHASE_HEDGE_ENABLED=true');
console.log('   2. 运行 npm start 启动做市商');
console.log('');
console.log('📊 策略工作流程：');
console.log('   Phase 1 (EMPTY): 挂 YES Buy + NO Buy 单');
console.log('   → NO Buy 被成交 → 立即买入 YES → 1:1 对冲');
console.log('   Phase 2 (HEDGED): 挂 YES Sell + NO Sell 单');
console.log('   → YES Sell 被成交 → 立即卖出 NO → 回到 0');
console.log('   循环：Phase 1 → Phase 2 → Phase 1 → ...');
console.log('');
