#!/usr/bin/env node
/**
 * 超级高频套利机器人启动脚本
 *
 * 使用方法：
 *   npm run start:super-hf
 *   node --import tsx scripts/start-super-hf.ts
 */

import { SuperHighFrequencyBot } from '../src/super-hf-arb-bot.js';
import { config } from 'dotenv';

// 加载环境变量
config();

async function main() {
  console.log('🚀 超级高频套利机器人 v2.0');
  console.log('═══════════════════════════════════════');
  console.log('');

  // 检查激活码
  const activationCode = process.env.ARBITRAGE_ACTIVATION_CODE;
  if (!activationCode) {
    console.error('❌ 错误：未找到激活码');
    console.error('');
    console.error('请设置环境变量 ARBITRAGE_ACTIVATION_CODE');
    console.error('或者运行激活脚本：npm run activate <激活码>');
    console.error('');
    console.error('获取激活码：联系管理员');
    process.exit(1);
  }

  // 创建机器人实例
  const bot = new SuperHighFrequencyBot(activationCode);

  // 设置事件监听
  bot.on('signal', (signal) => {
    console.log(`🎯 发现套利机会：${signal.strategy}`);
    console.log(`   市场：${signal.marketId || 'N/A'}`);
    console.log(`   预期收益：${signal.expectedProfit || 'N/A'}`);
    console.log(`   买入：${signal.side === 'BUY' ? 'YES' : 'NO'} @ ${signal.price}`);
    console.log('');
  });

  bot.on('trade', (trade) => {
    console.log(`✅ 执行交易：${trade.strategy}`);
    console.log(`   市场：${trade.marketId}`);
    console.log(`   数量：${trade.shares} 股`);
    console.log(`   价格：${trade.price}`);
    console.log('');
  });

  bot.on('error', (error) => {
    console.error(`❌ 错误：${error.message}`);
    console.error('');
  });

  bot.on('info', (message) => {
    console.log(`ℹ️  ${message}`);
  });

  // 启动机器人
  try {
    await bot.start();
    console.log('✅ 机器人已启动');
    console.log('');
    console.log('按 Ctrl+C 停止机器人');
    console.log('');

    // 保持运行
    process.on('SIGINT', async () => {
      console.log('');
      console.log('🛑 正在停止机器人...');
      await bot.stop();
      console.log('✅ 机器人已停止');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ 启动失败：', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ 未捕获的错误：', error);
  process.exit(1);
});
