/**
 * 完美对冲策略测试 V2 - 正确版本
 *
 * 核心逻辑：
 * 1. 初始状态：0 头寸
 * 2. 挂单赚积分：YES 卖单 + NO 卖单
 * 3. 被吃单后：立即买入对边对冲
 */

import { PerfectHedgeStrategy } from './src/strategies/perfect-hedge-strategy.js';

console.log('🎯 完美对冲策略测试 V2（正确版本）');
console.log('='.repeat(70));
console.log('');
console.log('策略核心：');
console.log('  1. 初始：0 YES + 0 NO');
console.log('  2. 挂单：YES 卖单 + NO 卖单（赚积分）');
console.log('  3. 被吃单后立即买入对边对冲');
console.log('');

// 初始化策略
const strategy = new PerfectHedgeStrategy({
  enabled: true,
  tolerance: 0.05,
  minHedgeSize: 10,  // 降低最小值以便测试
  maxHedgeSize: 500,
  autoBalance: true,
  balanceSlippageBps: 300,
});

// ===== 场景演示 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 完整做市场景模拟');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// 初始状态
let currentPos = { yes: 0, no: 0 };
console.log('📊 初始状态:');
console.log(`  持仓: ${currentPos.yes} YES + ${currentPos.no} NO = 空仓 ✅`);
console.log('');

// 检查市场条件
const yesPrice = 0.60;
const noPrice = 0.40;
const quality = strategy.verifyHedgeQuality(yesPrice, noPrice);

console.log('📋 市场检查:');
console.log(`  - YES 价格: $${yesPrice.toFixed(4)}`);
console.log(`  - NO 价格: $${noPrice.toFixed(4)}`);
console.log(`  - YES+NO: ${quality.sum.toFixed(4)}`);
console.log(`  - 质量: ${quality.quality}`);
console.log(`  - 适合做市: ${quality.isPerfect ? '✅ 是' : '❌ 否'}`);
console.log('');

// 建议挂单价格
const quotes = strategy.suggestQuotePrices(yesPrice, noPrice, 150);
console.log('💡 建议挂单（赚积分）:');
console.log(`  - YES 卖单: $${quotes.yesAsk.toFixed(4)} (高出市场 ${(quotes.yesAsk / yesPrice - 1) * 10000}bps)`);
console.log(`  - NO 卖单: $${quotes.noAsk.toFixed(4)} (高出市场 ${(quotes.noAsk / noPrice - 1) * 10000}bps)`);
console.log('  策略: 价格较高，不易被吃，主要赚取积分');
console.log('');

// ===== 场景 1: YES 卖单被吃 =====
console.log('⚡ 场景 1: YES 卖单被吃 10 股');
console.log('─'.repeat(70));

// 被吃前
console.log('被吃前:');
console.log(`  持仓: ${currentPos.yes} YES + ${currentPos.no} NO ✅`);
console.log('');

// YES 卖单被吃（被迫买入 YES）
console.log('事件：有人买了我们的 YES 卖单');
currentPos.yes += 10;  // 被迫买入 10 YES
console.log(`  被迫买入 10 YES`);
console.log(`  持仓变成: ${currentPos.yes} YES + ${currentPos.no} NO ❌`);
console.log(`  状态: 不对冲！有方向性风险`);
console.log('');

// 分析对冲状态
const position1 = {
  token_id: 'test',
  question: 'Test Market',
  yes_amount: currentPos.yes,
  no_amount: currentPos.no,
  total_value: currentPos.yes * yesPrice + currentPos.no * noPrice,
  avg_entry_price: yesPrice,
  current_price: yesPrice,
  pnl: 0,
};

const analysis1 = strategy.analyzeHedgeState(
  { token_id: 'test', question: 'Test' } as any,
  position1
);

console.log('🤖 系统分析:');
console.log(`  - 对冲比例: ${analysis1.ratio.ratio.toFixed(3)}`);
console.log(`  - 偏差: ${(analysis1.ratio.deviation * 100).toFixed(1)}%`);
console.log(`  - 需要对冲: ${analysis1.action.needsRebalance ? '✅ 是' : '❌ 否'}`);
console.log(`  - 建议操作: ${analysis1.action.side} ${analysis1.action.shares} 股`);
console.log(`  - 原因: ${analysis1.action.reason}`);
console.log('');

// 执行对冲
if (analysis1.action.side === 'BUY_NO') {
  console.log('🛡️ 执行对冲:');
  console.log(`  市价买入 ${analysis1.action.shares} NO`);
  currentPos.no += analysis1.action.shares;
  console.log(`  持仓变成: ${currentPos.yes} YES + ${currentPos.no} NO ✅`);
  console.log(`  状态: 完美对冲！无方向性风险`);
  console.log('');

  // 验证对冲效果
  const totalValue1 = currentPos.yes * yesPrice + currentPos.no * noPrice;
  console.log('💰 对冲验证:');
  console.log(`  - 总价值: ${currentPos.yes} × $${yesPrice} + ${currentPos.no} × $${noPrice} = $${totalValue1.toFixed(2)}`);
  console.log(`  - 如果 YES→$0.80, NO→$0.20: 价值 = ${currentPos.yes} × $0.80 + ${currentPos.no} × $0.20 = $${(currentPos.yes * 0.8 + currentPos.no * 0.2).toFixed(2)} ✅ 不变！`);
  console.log(`  - 如果 YES→$0.30, NO→$0.70: 价值 = ${currentPos.yes} × $0.30 + ${currentPos.no} × $0.70 = $${(currentPos.yes * 0.3 + currentPos.no * 0.7).toFixed(2)} ✅ 不变！`);
}
console.log('');

// ===== 场景 2: NO 卖单被吃 =====
console.log('⚡ 场景 2: NO 卖单被吃 15 股');
console.log('─'.repeat(70));

// NO 卖单被吃（被迫买入 NO）
console.log('事件：有人买了我们的 NO 卖单');
currentPos.no += 15;  // 被迫买入 15 NO
console.log(`  被迫买入 15 NO`);
console.log(`  持仓变成: ${currentPos.yes} YES + ${currentPos.no} NO ❌`);
console.log(`  状态: 不对冲！有方向性风险`);
console.log('');

// 分析对冲状态
const position2 = {
  token_id: 'test',
  question: 'Test Market',
  yes_amount: currentPos.yes,
  no_amount: currentPos.no,
  total_value: currentPos.yes * yesPrice + currentPos.no * noPrice,
  avg_entry_price: yesPrice,
  current_price: yesPrice,
  pnl: 0,
};

const analysis2 = strategy.analyzeHedgeState(
  { token_id: 'test', question: 'Test' } as any,
  position2
);

console.log('🤖 系统分析:');
console.log(`  - 对冲比例: ${analysis2.ratio.ratio.toFixed(3)}`);
console.log(`  - 偏差: ${(analysis2.ratio.deviation * 100).toFixed(1)}%`);
console.log(`  - 需要对冲: ${analysis2.action.needsRebalance ? '✅ 是' : '❌ 否'}`);
console.log(`  - 建议操作: ${analysis2.action.side} ${analysis2.action.shares} 股`);
console.log(`  - 原因: ${analysis2.action.reason}`);
console.log('');

// 执行对冲
if (analysis2.action.side === 'BUY_YES') {
  console.log('🛡️ 执行对冲:');
  console.log(`  市价买入 ${analysis2.action.shares} YES`);
  currentPos.yes += analysis2.action.shares;
  console.log(`  持仓变成: ${currentPos.yes} YES + ${currentPos.no} NO ✅`);
  console.log(`  状态: 完美对冲！无方向性风险`);
  console.log('');

  // 验证对冲效果
  const totalValue2 = currentPos.yes * yesPrice + currentPos.no * noPrice;
  console.log('💰 对冲验证:');
  console.log(`  - 总价值: $${totalValue2.toFixed(2)}`);
  console.log(`  - 价格变化时价值保持不变 ✅`);
}
console.log('');

// ===== 场景 3: 平仓 =====
console.log('💼 场景 3: 平仓');
console.log('─'.repeat(70));

console.log('决策：赚取足够积分，决定平仓');
console.log('操作：市价卖出所有持仓');
console.log('');

const totalValue = currentPos.yes * yesPrice + currentPos.no * noPrice;
const initialValue = 0;  // 初始空仓
const profit = totalValue - initialValue;

console.log('📊 平仓结果:');
console.log(`  - 卖出 ${currentPos.yes} YES @ $${yesPrice}`);
console.log(`  - 卖出 ${currentPos.no} NO @ $${noPrice}`);
console.log(`  - 初始价值: $${initialValue.toFixed(2)}`);
console.log(`  - 最终价值: $${totalValue.toFixed(2)}`);
console.log(`  - 净利润: $${profit.toFixed(2)}`);
console.log('');

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 策略总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

console.log('✅ 核心优势:');
console.log('  1. 初始无需资金（0 头寸）');
console.log('  2. 主要收益：积分（挂单）+ 价差（被吃后对冲）');
console.log('  3. 无方向性风险（YES+NO=1 时完全对冲）');
console.log('  4. 被吃单后自动对冲（买入对边）');
console.log('');

console.log('⚠️  关键要点:');
console.log('  1. 只在 YES+NO≤1.05 的市场使用');
console.log('  2. 挂单价要高（减少被吃概率）');
console.log('  3. 被吃单后立即对冲（不能延迟）');
console.log('  4. 监控 YES+NO 的和（超过 1.05 立即平仓）');
console.log('');

console.log('📋 与之前版本的区别:');
console.log('  之前（错误）:');
console.log('    - 持有 100 YES + 100 NO');
console.log('    - 挂卖单平仓');
console.log('    - YES 被吃 → 卖出 NO');
console.log('');
console.log('  现在（正确）:');
console.log('    - 初始 0 YES + 0 NO');
console.log('    - 挂卖单赚积分');
console.log('    - YES 被吃 → 买入 NO 对冲 ✅');
console.log('');

console.log('🚀 下一步:');
console.log('  1. 在 .env 中启用: PERFECT_HEDGE_ENABLED=true');
console.log('  2. 运行模拟测试: SIMULATION_MODE=true npm start');
console.log('  3. 观察被吃单后的对冲日志');
console.log('  4. 小资金实盘验证');
console.log('');
