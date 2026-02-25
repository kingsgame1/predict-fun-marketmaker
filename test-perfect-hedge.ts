/**
 * 完美对冲策略测试脚本
 *
 * 演示如何在 YES+NO≤1 的市场中进行完全对冲的做市
 */

import { PerfectHedgeStrategy } from './src/strategies/perfect-hedge-strategy.js';

console.log('🎯 完美对冲策略测试');
console.log('='.repeat(70));
console.log('');

// 初始化策略
const strategy = new PerfectHedgeStrategy({
  enabled: true,
  tolerance: 0.05,        // 5% 容忍度
  minHedgeSize: 50,       // 最小 50 股
  maxHedgeSize: 500,      // 最大 500 股
  autoBalance: true,      // 自动平衡
  balanceSlippageBps: 300, // 3% 滑点
});

console.log('📋 策略配置:');
console.log(`  - 启用: ${strategy.isEnabled() ? '✅' : '❌'}`);
console.log(`  - 偏差容忍度: ${(strategy.getConfig().tolerance * 100).toFixed(1)}%`);
console.log(`  - 最小对冲规模: ${strategy.getConfig().minHedgeSize} 股`);
console.log(`  - 最大对冲规模: ${strategy.getConfig().maxHedgeSize} 股`);
console.log(`  - 自动平衡: ${strategy.getConfig().autoBalance ? '✅' : '❌'}`);
console.log('');

// ===== 测试 1: 检查市场是否适合完美对冲 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 测试 1: 检查市场是否适合完美对冲');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const testMarkets = [
  { name: '市场 A (完美)', yesPrice: 0.60, noPrice: 0.40 },
  { name: '市场 B (良好)', yesPrice: 0.55, noPrice: 0.44 },
  { name: '市场 C (不适合)', yesPrice: 0.70, noPrice: 0.50 },
  { name: '市场 D (极好)', yesPrice: 0.50, noPrice: 0.50 },
];

for (const market of testMarkets) {
  const quality = strategy.verifyHedgeQuality(market.yesPrice, market.noPrice);
  const isSuitable = strategy.isMarketSuitable(
    { token_id: 'test', question: market.name } as any,
    market.yesPrice,
    market.noPrice
  );

  console.log(`${market.name}:`);
  console.log(`  - YES价格: $${market.yesPrice.toFixed(4)}`);
  console.log(`  - NO价格: $${market.noPrice.toFixed(4)}`);
  console.log(`  - YES+NO: ${quality.sum.toFixed(4)}`);
  console.log(`  - 偏差: ${(quality.deviation * 100).toFixed(2)}%`);
  console.log(`  - 质量: ${quality.quality}`);
  console.log(`  - 适合完美对冲: ${isSuitable ? '✅ 是' : '❌ 否'}`);
  console.log('');
}

// ===== 测试 2: 对冲比例分析 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 测试 2: 对冲比例分析');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const testPositions = [
  { name: '完美对冲', yes: 100, no: 100 },
  { name: '轻微偏差', yes: 103, no: 100 },
  { name: '严重偏差', yes: 120, no: 100 },
  { name: '只有多头', yes: 100, no: 0 },
  { name: '只有空头', yes: 0, no: 100 },
  { name: '持仓太小', yes: 10, no: 10 },
];

for (const pos of testPositions) {
  const position = {
    token_id: 'test',
    question: pos.name,
    yes_amount: pos.yes,
    no_amount: pos.no,
    total_value: (pos.yes + pos.no) * 0.5,
    avg_entry_price: 0.5,
    current_price: 0.5,
    pnl: 0,
  };

  const analysis = strategy.analyzeHedgeState(
    { token_id: 'test', question: pos.name } as any,
    position
  );

  console.log(`${pos.name} (YES=${pos.yes}, NO=${pos.no}):`);
  console.log(`  - 对冲比例: ${analysis.ratio.ratio.toFixed(3)}`);
  console.log(`  - 偏差: ${(analysis.ratio.deviation * 100).toFixed(1)}%`);
  console.log(`  - 是否平衡: ${analysis.ratio.isBalanced ? '✅ 是' : '❌ 否'}`);
  console.log(`  - 需要平衡: ${analysis.action.needsRebalance ? '✅ 是' : '❌ 否'}`);
  console.log(`  - 建议操作: ${analysis.action.side}`);
  console.log(`  - 操作数量: ${analysis.action.shares} 股`);
  console.log(`  - 原因: ${analysis.action.reason}`);
  console.log(`  - 可挂单: ${analysis.canPlaceOrders ? '✅ 是' : '❌ 否'}`);
  console.log('');
}

// ===== 测试 3: 挂单价格建议 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('💰 测试 3: 挂单价格建议');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const yesPrice = 0.60;
const noPrice = 0.40;
const spreadBps = 150; // 1.5%

const quotes = strategy.suggestQuotePrices(yesPrice, noPrice, spreadBps);

console.log('市场条件:');
console.log(`  - YES 市场价: $${yesPrice.toFixed(4)}`);
console.log(`  - NO 市场价: $${noPrice.toFixed(4)}`);
console.log(`  - YES+NO: ${(yesPrice + noPrice).toFixed(4)} ✅ 完美对冲`);
console.log('');

console.log('建议挂单:');
console.log(`  - YES 卖单价: $${quotes.yesAsk.toFixed(4)} (高出 ${(quotes.yesAsk / yesPrice - 1) * 10000}bps)`);
console.log(`  - NO 卖单价: $${quotes.noAsk.toFixed(4)} (高出 ${(quotes.noAsk / noPrice - 1) * 10000}bps)`);
console.log(`  - 价差: ${quotes.spreadBps}bps (${quotes.spreadBps / 100}%)`);
console.log('');

console.log('做市逻辑:');
console.log('  1. 同时挂 YES 和 NO 的卖单（价格稍高）');
console.log('  2. 如果 YES 卖单被吃 → 卖出 NO 平仓 → 保持 1:1 对冲');
console.log('  3. 如果 NO 卖单被吃 → 卖出 YES 平仓 → 保持 1:1 对冲');
console.log('  4. 利润来源: bid-ask spread（无方向性风险）');
console.log('');

// ===== 测试 4: 模拟做市场景 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎮 测试 4: 模拟做市场景');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// 初始状态：完美对冲
let currentPos = { yes: 100, no: 100 };
console.log('📊 初始状态:');
console.log(`  持仓: ${currentPos.yes} YES + ${currentPos.no} NO = 完美对冲 ✅`);
console.log('');

// 场景 1: YES 卖单被吃 10 股
console.log('⚡ 场景 1: YES 卖单被吃 10 股');
currentPos.yes -= 10;  // 卖出 YES
console.log(`  卖出 10 YES → 持仓: ${currentPos.yes} YES + ${currentPos.no} NO`);
console.log(`  状态: ❌ 不平衡！YES 比 NO 少 10 股`);

const analysis1 = strategy.analyzeHedgeState(
  { token_id: 'test', question: 'Test' } as any,
  {
    token_id: 'test',
    question: 'Test',
    yes_amount: currentPos.yes,
    no_amount: currentPos.no,
    total_value: (currentPos.yes + currentPos.no) * 0.5,
    avg_entry_price: 0.5,
    current_price: 0.5,
    pnl: 0,
  }
);

console.log(`  建议操作: ${analysis1.action.side} ${analysis1.action.shares} 股`);
console.log(`  操作: ${analysis1.action.reason}`);
if (analysis1.action.side === 'SELL_NO') {
  currentPos.no -= analysis1.action.shares;
  console.log(`  执行后: ${currentPos.yes} YES + ${currentPos.no} NO ✅ 恢复平衡`);
}
console.log('');

// 场景 2: NO 卖单被吃 15 股
console.log('⚡ 场景 2: NO 卖单被吃 15 股');
currentPos.no -= 15;  // 卖出 NO
console.log(`  卖出 15 NO → 持仓: ${currentPos.yes} YES + ${currentPos.no} NO`);
console.log(`  状态: ❌ 不平衡！NO 比 YES 少 15 股`);

const analysis2 = strategy.analyzeHedgeState(
  { token_id: 'test', question: 'Test' } as any,
  {
    token_id: 'test',
    question: 'Test',
    yes_amount: currentPos.yes,
    no_amount: currentPos.no,
    total_value: (currentPos.yes + currentPos.no) * 0.5,
    avg_entry_price: 0.5,
    current_price: 0.5,
    pnl: 0,
  }
);

console.log(`  建议操作: ${analysis2.action.side} ${analysis2.action.shares} 股`);
console.log(`  操作: ${analysis2.action.reason}`);
if (analysis2.action.side === 'SELL_YES') {
  currentPos.yes -= analysis2.action.shares;
  console.log(`  执行后: ${currentPos.yes} YES + ${currentPos.no} NO ✅ 恢复平衡`);
}
console.log('');

// ===== 总结 =====
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🎉 测试完成！');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('✅ 完美对冲策略的核心优势:');
console.log('  1. 无方向性风险（YES+NO=1 时完全对冲）');
console.log('  2. 利润稳定（赚取 bid-ask spread）');
console.log('  3. 自动平衡（偏差超过容忍度时自动恢复）');
console.log('  4. 风险可控（可设置最大对冲规模）');
console.log('');
console.log('📋 使用建议:');
console.log('  1. 只在 YES+NO≤1.05 的市场使用此策略');
console.log('  2. 保持足够的流动性（深度好才能快速成交）');
console.log('  3. 监控 YES+NO 的和，超过 1.05 时停止做市');
console.log('  4. 设置合理的容忍度（推荐 3-5%）');
console.log('');
