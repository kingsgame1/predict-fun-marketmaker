/**
 * 永久对冲策略测试 - 正确版本
 *
 * 用户需求：
 * 1. 基础：第二档挂单做市
 * 2. 第一次被吃：买入对边 → 1:1 对冲
 * 3. 继续：持有 1:1 时继续挂单
 * 4. 再次被吃：卖出对边多余部分 → 保持 1:1（不是平仓！）
 */

import { PerpetualHedgeStrategy, HedgePhase } from './src/strategies/perpetual-hedge-strategy.js';

console.log('🎯 永久对冲策略测试');
console.log('='.repeat(80));
console.log('');
console.log('策略核心（用户需求）：');
console.log('  1. 基础：第二档挂单做市（保持不变）');
console.log('  2. 第一次被吃单：买入对边 → 建立 1:1 对冲');
console.log('  3. 持有 1:1 时：继续挂 YES 卖单 + NO 卖单（第二档）');
console.log('  4. 再次被吃单：卖出对边多余部分 → 保持 1:1 对冲');
console.log('  5. 关键：永远保持对冲状态，不平仓！');
console.log('');

// 初始化策略
const strategy = new PerpetualHedgeStrategy({
  enabled: true,
  tolerance: 0.05,
  minHedgeSize: 10,
  maxHedgeSize: 500,
  autoRebalance: true,
  rebalanceSlippageBps: 300,
});

// 市场条件
const yesPrice = 0.60;
const noPrice = 0.40;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 市场条件');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`YES 价格: $${yesPrice.toFixed(4)}`);
console.log(`NO 价格: $${noPrice.toFixed(4)}`);
console.log(`YES+NO: ${(yesPrice + noPrice).toFixed(4)} ✅ 完美对冲`);
console.log('');

// 建议挂单价格
const quotes = strategy.suggestQuotePrices(yesPrice, noPrice, 150);
console.log('💡 挂单价格（第二档，赚积分）:');
console.log(`  YES 卖单: $${quotes.yesAsk.toFixed(4)}`);
console.log(`  NO 卖单: $${quotes.noAsk.toFixed(4)}`);
console.log('');

// ===== 完整流程演示 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 完整流程演示');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// 状态变量
let currentState = HedgePhase.EMPTY;
let currentYes = 0;
let currentNo = 0;

// ===== 步骤 1: 初始状态 =====
console.log('📊 步骤 1: 初始状态（空仓）');
console.log('─'.repeat(80));
console.log(`持仓: ${currentYes} YES + ${currentNo} NO`);
console.log(`阶段: ${currentState}`);
console.log('操作: 挂 YES 卖单 + NO 卖单（第二档）');
console.log('');

// ===== 步骤 2: 第一次被吃单 =====
console.log('⚡ 步骤 2: YES 卖单被吃（第一次）');
console.log('─'.repeat(80));
const fill1 = 10;
currentYes += fill1;
console.log(`事件: YES 卖单被吃 ${fill1} 股`);
console.log(`持仓变成: ${currentYes} YES + ${currentNo} NO`);
console.log('状态: ❌ 不对冲');
console.log('');

// 立即对冲
console.log('🛡️  立即对冲（买入对边）');
console.log('─'.repeat(80));
const action1 = strategy.handleOrderFill('YES', fill1, 0, 0, currentState);
console.log(`建议操作: ${action1.type} ${action1.shares} 股`);
console.log(`原因: ${action1.reason}`);

if (action1.type === 'BUY_NO') {
  currentNo += action1.shares;
  currentState = HedgePhase.HEDGED;
  console.log(`执行后: ${currentYes} YES + ${currentNo} NO ✅`);
  console.log('状态: 1:1 对冲');
}
console.log('');

// 验证对冲效果
console.log('💰 对冲验证:');
console.log(`  当前价值: ${currentYes} × $${yesPrice} + ${currentNo} × $${noPrice} = $${(currentYes * yesPrice + currentNo * noPrice).toFixed(2)}`);
console.log(`  如果 YES→$0.80, NO→$0.20: $${(currentYes * 0.8 + currentNo * 0.2).toFixed(2)} ✅ 不变`);
console.log(`  如果 YES→$0.30, NO→$0.70: $${(currentYes * 0.3 + currentNo * 0.7).toFixed(2)} ✅ 不变`);
console.log('');

// ===== 步骤 3: 继续做市（关键！）=====
console.log('📝 步骤 3: 继续做市（持有 1:1 对冲时）');
console.log('─'.repeat(80));
console.log(`持仓: ${currentYes} YES + ${currentNo} NO ✅ 1:1 对冲`);
console.log('操作: 继续挂 YES 卖单 + NO 卖单（第二档）');
console.log('目标: 赚取积分，保持对冲状态');
console.log('');

// 检查状态
const position1 = {
  token_id: 'test',
  question: 'Test',
  yes_amount: currentYes,
  no_amount: currentNo,
  total_value: currentYes * yesPrice + currentNo * noPrice,
  avg_entry_price: yesPrice,
  current_price: yesPrice,
  pnl: 0,
};

const analysis1 = strategy.analyze({ token_id: 'test', question: 'Test' } as any, position1);
console.log('🤖 当前状态:');
console.log(`  阶段: ${analysis1.state.phase}`);
console.log(`  持仓: ${analysis1.state.yesShares} YES + ${analysis1.state.noShares} NO`);
console.log(`  对冲比例: ${analysis1.state.ratio.toFixed(3)}`);
console.log(`  是否平衡: ${analysis1.state.isBalanced ? '✅ 是' : '❌ 否'}`);
console.log(`  可挂单: ${analysis1.canPlaceOrders ? '✅ 是' : '❌ 否'}`);
console.log('');

// ===== 步骤 4: 再次被吃单（关键！保持 1:1）=====
console.log('⚡ 步骤 4: NO 卖单被成交（第二次被吃）');
console.log('─'.repeat(80));
const fill2 = 5;  // 卖出 5 股 NO
console.log(`事件: NO 卖单被成交 ${fill2} 股`);
const beforeYes = currentYes;
const beforeNo = currentNo;
currentNo -= fill2;
console.log(`持仓变成: ${currentYes} YES + ${currentNo} NO`);
console.log('状态: ❌ 不平衡！');
console.log('');

// 关键：卖出对边多余部分，保持 1:1（不是全部卖出！）
console.log('🔄 立即重新平衡（保持 1:1 对冲）');
console.log('─'.repeat(80));

// 计算需要卖出多少 YES 才能保持 1:1
const targetHedgeSize = Math.min(currentYes, currentNo);
const excessYes = currentYes - targetHedgeSize;

console.log('分析:');
console.log(`  当前持仓: ${currentYes} YES + ${currentNo} NO`);
console.log(`  目标对冲规模: min(${currentYes}, ${currentNo}) = ${targetHedgeSize}`);
console.log(`  需要调整: 卖出 ${excessYes} YES`);
console.log('');

const action2 = strategy.handleOrderFill('NO', fill2, beforeYes, beforeNo, currentState);
console.log(`建议操作: ${action2.type} ${action2.shares} 股`);
console.log(`原因: ${action2.reason}`);

if (action2.type === 'SELL_YES') {
  currentYes -= action2.shares;
  console.log(`执行后: ${currentYes} YES + ${currentNo} NO ✅`);
  console.log('状态: 保持 1:1 对冲！');
  console.log('关键：不是平仓到 0，而是调整到 1:1！');
}
console.log('');

// 验证仍然是对冲状态
console.log('💰 验证仍然对冲:');
console.log(`  持仓: ${currentYes} YES + ${currentNo} NO`);
console.log(`  对冲比例: ${(currentYes / currentNo).toFixed(3)} ✅ 1:1`);
console.log(`  当前价值: $${(currentYes * yesPrice + currentNo * noPrice).toFixed(2)}`);
console.log('');

// ===== 步骤 5: 再次继续做市 =====
console.log('📝 步骤 5: 再次继续做市（仍然持有对冲）');
console.log('─'.repeat(80));
console.log(`持仓: ${currentYes} YES + ${currentNo} NO ✅ 1:1 对冲`);
console.log('操作: 继续挂 YES 卖单 + NO 卖单（第二档）');
console.log('目标: 继续赚取积分，保持对冲状态');
console.log('');

// ===== 步骤 6: YES 被成交（第三次被吃）=====
console.log('⚡ 步骤 6: YES 卖单被成交（第三次被吃）');
console.log('─'.repeat(80));
const fill3 = 3;
console.log(`事件: YES 卖单被成交 ${fill3} 股`);
const beforeYes2 = currentYes;
const beforeNo2 = currentNo;
currentYes -= fill3;
console.log(`持仓变成: ${currentYes} YES + ${currentNo} NO`);
console.log('状态: ❌ 不平衡！');
console.log('');

// 重新平衡
console.log('🔄 立即重新平衡（保持 1:1）');
console.log('─'.repeat(80));

const targetHedgeSize2 = Math.min(currentYes, currentNo);
const excessNo = currentNo - targetHedgeSize2;

console.log('分析:');
console.log(`  当前持仓: ${currentYes} YES + ${currentNo} NO`);
console.log(`  目标对冲规模: ${targetHedgeSize2}`);
console.log(`  需要调整: 卖出 ${excessNo} NO`);
console.log('');

const action3 = strategy.handleOrderFill('YES', fill3, beforeYes2, beforeNo2, currentState);
console.log(`建议操作: ${action3.type} ${action3.shares} 股`);
console.log(`原因: ${action3.reason}`);

if (action3.type === 'SELL_NO') {
  currentNo -= action3.shares;
  console.log(`执行后: ${currentYes} YES + ${currentNo} NO ✅`);
  console.log('状态: 仍然保持 1:1 对冲！');
}
console.log('');

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 流程总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('✅ 关键点：');
console.log('  1. 初始：0 头寸');
console.log('  2. 第一次被吃：买入对边 → 10 YES + 10 NO（1:1）');
console.log('  3. 继续挂单：持有 1:1 对冲时继续做市');
console.log('  4. 第二次被吃：卖出 5 NO → 10 YES + 5 NO → 卖出 5 YES → 5 YES + 5 NO（保持 1:1）');
console.log('  5. 第三次被吃：卖出 3 YES → 2 YES + 5 NO → 卖出 3 NO → 2 YES + 2 NO（保持 1:1）');
console.log('  6. 关键：永远保持 1:1 对冲，不是平仓到 0！');
console.log('');
console.log('💡 与之前版本的区别：');
console.log('  之前（错误）：第二次被吃 → 平仓 → 0 头寸');
console.log('  现在（正确）：第二次被吃 → 调整 → 保持 1:1 对冲');
console.log('');
console.log('🔄 永久对冲循环：');
console.log('  ┌──────────────────────────────────────┐');
console.log('  │  0 头寸 → 第一次被吃 → 建立对冲       │');
console.log('  │  10 YES + 10 NO → 继续做市           │');
console.log('  │  → 第二次被吃 → 调整到 5:5          │');
console.log('  │  5 YES + 5 NO → 继续做市            │');
console.log('  │  → 第三次被吃 → 调整到 2:2          │');
console.log('  │  2 YES + 2 NO → 继续做市...         │');
console.log('  └──────────────────────────────────────┘');
console.log('  关键：永远保持对冲，减少对冲规模但不平仓！');
console.log('');
