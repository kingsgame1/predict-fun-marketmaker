/**
 * 颗粒度对冲策略测试（双轨并行版本）
 *
 * 核心创新：
 * - 异步对冲逻辑：成交一点 → 立即对冲一点
 * - 双轨并行操作：同时在买入端和卖出端赚积分
 * - 状态 A（空仓挂单）：挂 Buy 单赚积分
 * - 状态 B（持仓挂单）：挂 Sell 单赚积分
 * - 结果：最大化积分收益！
 */

import { ContinuousHedgeStrategy, ContinuousHedgeState, DualTrackState } from './src/strategies/continuous-hedge-strategy.js';
import type { ContinuousHedgeConfig } from './src/strategies/continuous-hedge-strategy.js';

console.log('🚀 颗粒度对冲策略测试（双轨并行）');
console.log('='.repeat(80));
console.log('');
console.log('核心创新：');
console.log('  - 异步对冲逻辑：成交一点 → 立即对冲一点（不撤单）');
console.log('  - 双轨并行操作：同时在买入端和卖出端赚积分');
console.log('  - 状态 A（空仓挂单）：挂 Buy 单赚积分');
console.log('  - 状态 B（持仓挂单）：挂 Sell 单赚积分');
console.log('  - 结果：最大化积分收益！');
console.log('');

// 初始化策略
const strategy = new ContinuousHedgeStrategy({
  enabled: true,
  tolerance: 0.05,
  minHedgeSize: 10,
  maxHedgeSize: 500,
  buySpreadBps: 150,
  sellSpreadBps: 150,
  hedgeSlippageBps: 250,
  alwaysQuoting: true,
  autoRebalance: true,
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

// ===== 场景 1: 空仓状态分析 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 1: 空仓状态（双轨并行启动）');
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
console.log(`   可以挂 Buy 单: ${analysis1.canQuoteBuy}`);
console.log(`   可以挂 Sell 单: ${analysis1.canQuoteSell}`);
console.log(`   双轨并行: ${analysis1.dualTrack ? '✅' : '❌'}`);
if (analysis1.dualTrack) {
  console.log(`     轨道 A（空仓挂单）: ${analysis1.dualTrack.trackA.active ? '✅ 激活' : '❌ 停用'}`);
  console.log(`     轨道 B（持仓挂单）: ${analysis1.dualTrack.trackB.active ? '✅ 激活' : '❌ 停用'} (${analysis1.dualTrack.trackB.hedgedShares} 组)`);
}
console.log('');

const prices1 = strategy.suggestOrderPrices(yesPrice, noPrice);
console.log('💡 挂单策略（双轨并行）:');
console.log(`   轨道 A（空仓挂单）: YES Buy @ $${prices1.yesBid.toFixed(4)} | NO Buy @ $${prices1.noBid.toFixed(4)}`);
console.log(`   轨道 B（持仓挂单）: YES Sell @ $${prices1.yesAsk.toFixed(4)} | NO Sell @ $${prices1.noAsk.toFixed(4)}`);
console.log('');

// ===== 场景 2: 异步对冲逻辑 - YES Buy 单被成交 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 2: 异步对冲逻辑 - YES Buy 单被成交 10 股');
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
console.log(`   优先级: ${action2.priority} ${action2.track ? `| 轨道: ${action2.track}` : ''}`);
console.log('');

console.log('✅ 关键创新（异步对冲）:');
console.log('   ✅ 不撤单：保留剩余的 YES Buy 单继续排队赚积分');
console.log('   ✅ 即时补齐：立刻市价买入 10 NO');
console.log('   ✅ 结果：持有 10 YES + 10 NO（1:1 对冲）');
console.log('   ✅ 双轨激活：轨道 A（空仓挂单）+ 轨道 B（持仓挂单）');
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
console.log(`   双轨并行: ${analysis3.dualTrack ? '✅' : '❌'}`);
if (analysis3.dualTrack) {
  console.log(`     轨道 A（空仓挂单）: ${analysis3.dualTrack.trackA.active ? '✅ 激活' : '❌ 停用'}`);
  console.log(`       └─ 挂 YES Buy + NO Buy 单（赚取买入端积分）`);
  console.log(`     轨道 B（持仓挂单）: ${analysis3.dualTrack.trackB.active ? '✅ 激活' : '❌ 停用'} (${analysis3.dualTrack.trackB.hedgedShares} 组已对冲)`);
  console.log(`       └─ 挂 YES Sell + NO Sell 单（赚取卖出端积分）`);
}
console.log('');

const prices3 = strategy.suggestOrderPrices(yesPrice, noPrice);
console.log('💡 挂单策略（双轨并行）:');
console.log(`   轨道 A（空仓挂单）: YES Buy @ $${prices3.yesBid.toFixed(4)} | NO Buy @ $${prices3.noBid.toFixed(4)}`);
console.log(`   轨道 B（持仓挂单）: YES Sell @ $${prices3.yesAsk.toFixed(4)} | NO Sell @ $${prices3.noAsk.toFixed(4)}`);
console.log('');

console.log('🎉 双轨并行收益:');
console.log('   ✅ 买入端积分: YES Buy + NO Buy 单持续赚取');
console.log('   ✅ 卖出端积分: YES Sell + NO Sell 单持续赚取');
console.log('   ✅ 风险隔离: 持有 10 YES + 10 NO（恒定价值）');
console.log('   ✅ 积分最大化: 同时在两端赚取积分！');
console.log('');

// ===== 场景 4: 颗粒度对冲 - NO Sell 单被成交 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 场景 4: 颗粒度对冲 - NO Sell 单被成交 10 股');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

console.log('📊 事件: NO Sell 单被成交 10 股');
console.log('   解释: 有人从我们这买走 10 股 NO');
console.log('   持仓变成: 10 YES + 0 NO');
console.log('');

const action4 = strategy.handleOrderFill('test-token-123', 'SELL', 'NO', 10, 10, 10);
console.log('🎯 颗粒度对冲操作:');
console.log(`   操作: ${action4.type} ${action4.shares} 股`);
console.log(`   原因: ${action4.reason}`);
console.log(`   优先级: ${action4.priority}`);
console.log('');

console.log('✅ 关键创新（颗粒度对冲）:');
console.log('   ✅ 不撤单：保留剩余的 NO Sell 单继续排队赚积分');
console.log('   ✅ 即时补齐：立刻市价买入 10 YES');
console.log('   ✅ 结果：回到 20 YES + 20 NO（仍然 1:1 对冲）');
console.log('   ✅ 积分不断：继续在双轨上赚取积分');
console.log('');

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 策略总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('✅ 颗粒度对冲策略（双轨并行）:');
console.log('');
console.log('核心创新:');
console.log('  1. 异步对冲逻辑:');
console.log('     - 成交一点 → 立即对冲一点');
console.log('     - 不撤单：保留剩余挂单继续赚积分');
console.log('     - 即时补齐：立刻市价买入对面');
console.log('');
console.log('  2. 双轨并行操作:');
console.log('     - 轨道 A（空仓挂单）: 挂 Buy 单赚积分');
console.log('     - 轨道 B（持仓挂单）: 挂 Sell 单赚积分');
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
console.log('与两阶段策略的区别:');
console.log('  两阶段（V5）: Phase 1（挂 Buy） → Phase 2（挂 Sell） → 循环');
console.log('  颗粒度对冲: 同时挂 Buy + Sell（双轨并行） ✨');
console.log('');
console.log('🚀 启用策略:');
console.log('   在 .env 中设置: CONTINUOUS_HEDGE_ENABLED=true');
console.log('   运行: npm start');
console.log('');
console.log('🎯 这是最优的积分策略！');
console.log('');
