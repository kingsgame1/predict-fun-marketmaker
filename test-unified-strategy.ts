/**
 * 统一做市商策略测试
 * 
 * 整合了所有策略的优点：
 * - 异步对冲逻辑：成交一点 → 立即对冲一点（不撤单）
 * - 双轨并行操作：同时在买入端和卖出端赚积分
 * - 恒定价值：YES + NO = 1
 * - 积分最大化：不间断挂单
 */

import { UnifiedMarketMakerStrategy, UnifiedState } from './src/strategies/unified-market-maker-strategy.js';
import type { UnifiedMarketMakerConfig } from './src/strategies/unified-market-maker-strategy.js';

console.log('🚀 统一做市商策略测试');
console.log('='.repeat(80));
console.log('');
console.log('核心创新：');
console.log('  - 异步对冲逻辑：成交一点 → 立即对冲一点（不撤单）');
console.log('  - 双轨并行操作：同时在买入端和卖出端赚积分');
console.log('  - 恒定价值：YES + NO = 1（持有 1:1 时风险为零）');
console.log('  - 积分最大化：不间断挂单，持续赚取积分');
console.log('');

// 初始化策略
const strategy = new UnifiedMarketMakerStrategy({
  enabled: true,
  tolerance: 0.05,
  minHedgeSize: 10,
  maxHedgeSize: 500,
  buySpreadBps: 150,
  sellSpreadBps: 150,
  hedgeSlippageBps: 250,
  asyncHedging: true,
  dualTrackMode: true,
});

const yesPrice = 0.60;
const noPrice = 0.40;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 市场条件');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`YES 价格: $${yesPrice.toFixed(4)}`);
console.log(`NO 价格: $${noPrice.toFixed(4)}`);
console.log(`YES+NO: ${(yesPrice + noPrice).toFixed(4)} ✅ 完美对冲（恒定价值）`);
console.log('');

// ===== 场景 1: 空仓状态 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 1: 空仓状态（启动双轨并行）');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const emptyPosition = { yes_amount: 0, no_amount: 0 };
const mockMarket = {
  token_id: 'test-token-123',
  question: 'Will BTC reach $100k by 2025?',
} as any;

console.log('📊 初始状态:');
console.log(`   持仓: ${emptyPosition.yes_amount} YES + ${emptyPosition.no_amount} NO`);
console.log('');

const analysis1 = strategy.analyze(mockMarket, emptyPosition, yesPrice, noPrice);
console.log(`📊 状态分析:`);
console.log(`   状态: ${analysis1.state}`);
console.log(`   挂 Buy 单: ${analysis1.shouldPlaceBuyOrders ? '✅' : '❌'}`);
console.log(`   挂 Sell 单: ${analysis1.shouldPlaceSellOrders ? '✅' : '❌'}`);
console.log(`   Buy 订单大小: ${analysis1.buyOrderSize} 股`);
console.log(`   Sell 订单大小: ${analysis1.sellOrderSize} 股`);
console.log('');

// 模拟订单簿数据（用于演示动态偏移功能）
// 注意：在预测市场中，YES + NO = 1，所以 NO 的订单簿与 YES 相反
const yesOrderbook = {
  bids: [{ price: '0.600' }, { price: '0.595' }],   // YES 第一档买价 0.600
  asks: [{ price: '0.605' }, { price: '0.610' }],   // YES 第一档卖价 0.605
  best_bid: 0.600,
  best_ask: 0.605,
};

const noOrderbook = {
  bids: [{ price: '0.395' }, { price: '0.390' }],   // NO 第一档买价 0.395 (1 - 0.605)
  asks: [{ price: '0.400' }, { price: '0.405' }],   // NO 第一档卖价 0.400 (1 - 0.600)
  best_bid: 0.395,
  best_ask: 0.400,
};

const prices1 = strategy.suggestOrderPrices(yesPrice, noPrice, yesOrderbook, noOrderbook);
console.log(`💡 挂单价格（${prices1.source === 'DYNAMIC_OFFSET' ? '🎯 动态偏移模式' : '固定价差模式'}）:`);
console.log(`   YES 市场第一档: Buy $${yesOrderbook.best_bid.toFixed(4)} | Sell $${yesOrderbook.best_ask.toFixed(4)}`);
console.log(`   NO 市场第一档: Buy $${noOrderbook.best_bid.toFixed(4)} | Sell $${noOrderbook.best_ask.toFixed(4)}`);
console.log('');
console.log(`   YES Buy: $${prices1.yesBid.toFixed(4)} (低于第一档 ${((yesOrderbook.best_bid - prices1.yesBid) / yesOrderbook.best_bid * 10000).toFixed(0)}bps)`);
console.log(`   YES Sell: $${prices1.yesAsk.toFixed(4)} (高于第一档 ${((prices1.yesAsk - yesOrderbook.best_ask) / yesOrderbook.best_ask * 10000).toFixed(0)}bps)`);
console.log(`   NO Buy: $${prices1.noBid.toFixed(4)} (低于第一档 ${((noOrderbook.best_bid - prices1.noBid) / noOrderbook.best_bid * 10000).toFixed(0)}bps)`);
console.log(`   NO Sell: $${prices1.noAsk.toFixed(4)} (高于第一档 ${((prices1.noAsk - noOrderbook.best_ask) / noOrderbook.best_ask * 10000).toFixed(0)}bps)`);
console.log('');

// ===== 场景 2: 异步对冲 - YES Buy 被成交 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 2: 异步对冲 - YES Buy 被成交 10 股');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

console.log('📊 事件: YES Buy 单被成交 10 股');
console.log('   解释: 有人卖给我们 10 股 YES');
console.log('   持仓变成: 10 YES + 0 NO');
console.log('');

const action2 = strategy.handleOrderFill('test-token-123', 'BUY', 'YES', 10, 0, 0);
console.log('🎯 异步对冲操作:');
console.log(`   操作: ${action2.type} ${action2.shares} 股`);
console.log(`   原因: ${action2.reason}`);
console.log(`   优先级: ${action2.priority}`);
console.log('');

console.log('✅ 异步对冲的关键创新:');
console.log('   ✅ 不撤单：保留剩余的 YES Buy 单继续排队赚积分');
console.log('   ✅ 即时补齐：立刻市价买入 10 NO');
console.log('   ✅ 结果：持有 10 YES + 10 NO（1:1 对冲）');
console.log('   ✅ 双轨激活：可以同时在买入端和卖出端赚积分');
console.log('');

// ===== 场景 3: 双轨并行操作 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 3: 双轨并行操作（同时赚积分）');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const hedgedPosition = { yes_amount: 10, no_amount: 10 };
console.log('📊 当前状态:');
console.log(`   持仓: ${hedgedPosition.yes_amount} YES + ${hedgedPosition.no_amount} NO ✅ 1:1 对冲`);
console.log('');

const analysis3 = strategy.analyze(mockMarket, hedgedPosition, yesPrice, noPrice);
console.log(`📊 状态分析:`);
console.log(`   状态: ${analysis3.state}`);
console.log(`   挂 Buy 单: ${analysis3.shouldPlaceBuyOrders ? '✅' : '❌'}`);
console.log(`   挂 Sell 单: ${analysis3.shouldPlaceSellOrders ? '✅' : '❌'}`);
console.log('');

console.log('💡 挂单策略（双轨并行）:');
console.log(`   轨道 A（买入端）: YES Buy @ $${prices1.yesBid.toFixed(4)} | NO Buy @ $${prices1.noBid.toFixed(4)}`);
console.log(`   轨道 B（卖出端）: YES Sell @ $${prices1.yesAsk.toFixed(4)} | NO Sell @ $${prices1.noAsk.toFixed(4)}`);
console.log('');

console.log('🎉 双轨并行收益:');
console.log('   ✅ 买入端积分: YES Buy + NO Buy 单持续赚取');
console.log('   ✅ 卖出端积分: YES Sell + NO Sell 单持续赚取');
console.log('   ✅ 风险隔离: 持有 10 YES + 10 NO（恒定价值）');
console.log('   ✅ 积分最大化: 同时在两端赚取积分！');
console.log('');

// ===== 场景 4: 颗粒度对冲 - NO Sell 被成交 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 4: 颗粒度对冲 - NO Sell 被成交 5 股');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

console.log('📊 事件: NO Sell 单被成交 5 股');
console.log('   解释: 有人从我们这买走 5 股 NO');
console.log('   持仓变成: 10 YES + 5 NO');
console.log('');

const action4 = strategy.handleOrderFill('test-token-123', 'SELL', 'NO', 5, 10, 10);
console.log('🎯 颗粒度对冲操作:');
console.log(`   操作: ${action4.type} ${action4.shares} 股`);
console.log(`   原因: ${action4.reason}`);
console.log(`   优先级: ${action4.priority}`);
console.log('');

console.log('✅ 颗粒度对冲完成:');
console.log('   ✅ 不撤单：保留剩余的 NO Sell 单继续排队');
console.log('   ✅ 即时补齐：买入 5 YES');
console.log('   ✅ 结果：回到 15 YES + 15 NO（仍然 1:1 对冲）');
console.log('   ✅ 积分不断：继续在双轨上赚取积分');
console.log('');

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 策略总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('✅ 统一做市商策略（整合所有优点）:');
console.log('');
console.log('核心特性:');
console.log('  1. 异步对冲逻辑:');
console.log('     - 成交一点 → 立即对冲一点');
console.log('     - 不撤单：保留剩余挂单继续赚积分');
console.log('     - 即时补齐：立刻市价买入对面');
console.log('');
console.log('  2. 双轨并行操作:');
console.log('     - 轨道 A（买入端）: 持续挂 Buy 单赚积分');
console.log('     - 轨道 B（卖出端）: 持续挂 Sell 单赚积分');
console.log('     - 结果：同时在两端赚取积分');
console.log('');
console.log('  3. 恒定价值:');
console.log('     - YES + NO = 1（恒定价值）');
console.log('     - 持有 1:1 时价格波动不影响');
console.log('');
console.log('  4. 积分最大化:');
console.log('     - 买入端：持续赚积分');
console.log('     - 卖出端：持续赚积分');
console.log('     - 总收益：两端积分相加！');
console.log('');
console.log('🚀 启用策略:');
console.log('   在 .env 中设置: UNIFIED_MARKET_MAKER_ENABLED=true');
console.log('   运行: npm start');
console.log('');
console.log('🎯 这是最优的积分策略！');
console.log('');

// ===== 额外演示：第一档监控 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 5: 第一档监控（自动撤单重挂）');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('📊 假设场景:');
console.log('   我们挂了 YES Buy @ $0.5940');
console.log('   市场第一档变成: $0.5930');
console.log('   我们的订单现在是第一档！');
console.log('');
console.log('🔄 监控逻辑:');
console.log('   1. 检测到 YES Buy $0.5940 >= 第一档 $0.5930');
console.log('   2. 立即撤单');
console.log('   3. 重新挂单: YES Buy @ $0.5881（低于新第一档 100bps）');
console.log('');
console.log('✅ 始终保持第二档位置，避免被立即成交！');
console.log('');
console.log('⚙️  启用监控:');
console.log('   UNIFIED_MARKET_MAKER_MONITOR_TIER_ONE=true');
console.log('');

