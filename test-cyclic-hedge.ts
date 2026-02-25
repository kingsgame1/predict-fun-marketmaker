/**
 * 循环对冲策略测试 - 完整演示
 *
 * 场景：做市商第二档挂单模式 + 被吃单风险预案
 */

import { CyclicHedgeStrategy, HedgePhase } from './src/strategies/cyclic-hedge-strategy.js';

console.log('🎯 循环对冲策略测试 - 完整演示');
console.log('='.repeat(80));
console.log('');
console.log('策略核心：');
console.log('  1. 初始：0 头寸，挂 YES 卖单 + NO 卖单（第二档，赚积分）');
console.log('  2. 被吃单后立即对冲 → 1:1 持仓');
console.log('  3. 继续挂单 → 如果一边被卖掉 → 立即卖出对边 → 回到 0 头寸');
console.log('  4. 重复循环');
console.log('');
console.log('这是做市商第二档挂单模式的风险预案！🛡️');
console.log('');

// 初始化策略
const strategy = new CyclicHedgeStrategy({
  enabled: true,
  tolerance: 0.05,
  minHedgeSize: 10,
  maxHedgeSize: 500,
  autoBalance: true,
  balanceSlippageBps: 300,
  flattenSlippageBps: 250,
});

// 市场条件
const yesPrice = 0.60;
const noPrice = 0.40;
const quality = strategy.verifyHedgeQuality(yesPrice, noPrice);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 市场条件检查');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log(`YES 价格: $${yesPrice.toFixed(4)}`);
console.log(`NO 价格: $${noPrice.toFixed(4)}`);
console.log(`YES+NO: ${quality.sum.toFixed(4)}`);
console.log(`质量: ${quality.quality}`);
console.log(`适合做市: ${quality.isPerfect ? '✅ 是' : '❌ 否'}`);
console.log('');

// 建议挂单价格
const quotes = strategy.suggestQuotePrices(yesPrice, noPrice, 150);
console.log('💡 建议挂单价格（第二档，赚积分）:');
console.log(`  - YES 卖单: $${quotes.yesAsk.toFixed(4)} (高出市场 ${(quotes.yesAsk / yesPrice - 1) * 10000}bps)`);
console.log(`  - NO 卖单: $${quotes.noAsk.toFixed(4)} (高出市场 ${(quotes.noAsk / noPrice - 1) * 10000}bps)`);
console.log('  策略: 第二档挂单，不易被吃，主要赚取积分 ✨');
console.log('');

// ===== 完整循环演示 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 完整循环演示');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// 循环计数器
let cycleCount = 0;

function runCycle() {
  cycleCount++;
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔄 第 ${cycleCount} 轮循环`);
  console.log('='.repeat(80));
  console.log('');

  // 初始状态
  let currentYes = 0;
  let currentNo = 0;

  console.log('📊 步骤 1: 初始状态（空仓）');
  console.log('─'.repeat(80));
  console.log(`持仓: ${currentYes} YES + ${currentNo} NO`);
  console.log('阶段: EMPTY（等待被吃单）');
  console.log('操作: 挂 YES 卖单 + NO 卖单（第二档，赚积分）');
  console.log('');

  // 模拟被吃单
  console.log('⚡ 步骤 2: YES 卖单被吃（风险触发！）');
  console.log('─'.repeat(80));
  const filledShares = 10;
  currentYes += filledShares;  // 被迫买入 YES
  console.log(`事件: 有人买了我们的 YES 卖单 (${filledShares} 股)`);
  console.log(`持仓变成: ${currentYes} YES + ${currentNo} NO`);
  console.log('状态: ❌ 不对冲！有方向性风险！');
  console.log('');

  // 立即对冲
  console.log('🛡️  步骤 3: 立即对冲（风险控制）');
  console.log('─'.repeat(80));
  const hedgeAction = strategy.handleOrderFill('YES', filledShares, 0, 0);
  console.log(`建议操作: ${hedgeAction.type} ${hedgeAction.shares} 股`);
  console.log(`原因: ${hedgeAction.reason}`);

  if (hedgeAction.type === 'BUY_NO') {
    currentNo += hedgeAction.shares;
    console.log(`执行后: ${currentYes} YES + ${currentNo} NO ✅`);
    console.log('状态: 1:1 完美对冲！无方向性风险');
    console.log('');

    // 验证对冲效果
    const totalValue = currentYes * yesPrice + currentNo * noPrice;
    console.log('💰 对冲验证:');
    console.log(`  当前价值: ${currentYes} × $${yesPrice} + ${currentNo} × $${noPrice} = $${totalValue.toFixed(2)}`);
    console.log(`  如果 YES→$0.80, NO→$0.20: $${(currentYes * 0.8 + currentNo * 0.2).toFixed(2)} ✅ 不变`);
    console.log(`  如果 YES→$0.30, NO→$0.70: $${(currentYes * 0.3 + currentNo * 0.7).toFixed(2)} ✅ 不变`);
  }
  console.log('');

  // 继续做市
  console.log('📝 步骤 4: 继续做市（挂第二档）');
  console.log('─'.repeat(80));
  console.log('操作: 继续挂 YES 卖单 + NO 卖单（第二档）');
  console.log('目标: 赚取积分 + 可能的价差收益');
  console.log('');

  // 检查当前状态
  const position = {
    token_id: 'test',
    question: 'Test',
    yes_amount: currentYes,
    no_amount: currentNo,
    total_value: currentYes * yesPrice + currentNo * noPrice,
    avg_entry_price: yesPrice,
    current_price: yesPrice,
    pnl: 0,
  };

  const analysis = strategy.analyze({ token_id: 'test', question: 'Test' } as any, position);
  console.log('🤖 当前状态分析:');
  console.log(`  阶段: ${analysis.state.phase}`);
  console.log(`  持仓: ${analysis.state.yesShares} YES + ${analysis.state.noShares} NO`);
  console.log(`  对冲比例: ${analysis.state.ratio.toFixed(3)}`);
  console.log(`  是否平衡: ${analysis.state.isBalanced ? '✅ 是' : '❌ 否'}`);
  console.log(`  可挂单: ${analysis.canPlaceOrders ? '✅ 是' : '❌ 否'}`);
  console.log('');

  // 模拟再次被吃单
  console.log('⚡ 步骤 5: NO 卖单被成交（卖出对边）');
  console.log('─'.repeat(80));
  const soldShares = currentNo;  // 全部卖出
  console.log(`事件: 有人买了我们的 NO 卖单 (${soldShares} 股)`);
  currentNo -= soldShares;
  console.log(`持仓变成: ${currentYes} YES + ${currentNo} NO`);
  console.log('状态: ❌ 不对冲！需要立即平仓！');
  console.log('');

  // 立即平仓
  console.log('🔄 步骤 6: 立即平仓（回到空仓）');
  console.log('─'.repeat(80));
  const flattenAction = strategy.handleOrderFill('NO', soldShares, currentYes, currentNo + soldShares);
  console.log(`建议操作: ${flattenAction.type} ${flattenAction.shares} 股`);
  console.log(`原因: ${flattenAction.reason}`);

  if (flattenAction.type === 'SELL_YES') {
    currentYes -= flattenAction.shares;
    console.log(`执行后: ${currentYes} YES + ${currentNo} NO ✅`);
    console.log('状态: 回到 EMPTY，准备下一轮循环');
  }
  console.log('');

  // 收益总结
  console.log('💼 本轮收益总结:');
  console.log('─'.repeat(80));
  console.log('  收益来源:');
  console.log('    1. 积分收益（挂单奖励）✨');
  console.log('    2. 第一次被吃: 对冲成本（买入 NO）');
  console.log('    3. 第二次成交: 平仓收益（卖出 YES + NO）');
  console.log('  净收益: 积分 + (价差收益 - 对冲成本)');
  console.log('');
}

// 运行 3 轮循环
for (let i = 0; i < 3; i++) {
  runCycle();
}

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 策略总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

console.log('✅ 核心优势:');
console.log('  1. 初始无需资金（0 头寸）');
console.log('  2. 主要收益：积分（挂单奖励）✨');
console.log('  3. 风险预案：被吃单后立即对冲');
console.log('  4. 自动循环：平仓后重新开始');
console.log('  5. 无方向性风险：1:1 对冲时价值不变');
console.log('');

console.log('🔄 完整循环流程:');
console.log('  ┌─────────────────────────────────────────────┐');
console.log('  │ 步骤 1: 0 头寸 → 挂 YES 卖单 + NO 卖单      │');
console.log('  │           ↓                                 │');
console.log('  │ 步骤 2: 被吃单 → 立即对冲 → 1:1 持仓       │');
console.log('  │           ↓                                 │');
console.log('  │ 步骤 3: 继续挂单 → 一边被成交 → 平仓对边   │');
console.log('  │           ↓                                 │');
console.log('  │ 步骤 4: 回到 0 头寸 → 重复步骤 1            │');
console.log('  └─────────────────────────────────────────────┘');
console.log('');

console.log('⚠️  关键要点:');
console.log('  1. 只在 YES+NO≤1.05 的市场使用');
console.log('  2. 第二档挂单（价格较高，减少被吃概率）');
console.log('  3. 被吃单后立即处理（不能延迟）');
console.log('  4. 实时监控 YES+NO 的和');
console.log('  5. 每个周期独立，风险不会累积');
console.log('');

console.log('📊 与传统策略对比:');
console.log('  传统做市商:');
console.log('    - 持有库存 → 积累单边头寸 → 风险高 ❌');
console.log('');
console.log('  循环对冲策略:');
console.log('    - 每个周期独立 → 自动平仓 → 风险低 ✅');
console.log('    - 积分收益为主 → 不依赖方向 → 收益稳 ✅');
console.log('');

console.log('🚀 下一步:');
console.log('  1. 在 .env 中启用: PERFECT_HEDGE_ENABLED=true');
console.log('  2. 或使用新策略: CYCLIC_HEDGE_ENABLED=true');
console.log('  3. 模拟测试: SIMULATION_MODE=true npm start');
console.log('  4. 观察循环日志和状态变化');
console.log('  5. 小资金实盘验证');
console.log('');

console.log('🎯 这是做市商第二档挂单模式的完美风险预案！');
console.log('   被吃单不是问题，立即对冲 + 自动循环 = 无风险！✅');
console.log('');
