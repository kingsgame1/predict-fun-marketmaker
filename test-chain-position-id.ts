/**
 * 测试从链上合约获取 position ID (token_id)
 */

import { ethers } from 'ethers';
import { loadConfig } from './src/config.js';
import { PredictAPI } from './src/api/client.js';

async function testChainPositionId(): Promise<void> {
  console.log('🔍 测试从链上获取 position ID\n');

  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  // 获取一个市场作为测试
  const markets = await api.getMarkets();
  if (markets.length === 0) {
    console.log('⚠️  没有找到市场数据');
    return;
  }

  const testMarket = markets[0];
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 测试市场');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`问题: ${testMarket.question?.substring(0, 60)}...`);
  console.log(`condition_id: ${testMarket.condition_id}`);
  console.log(`token_id: ${testMarket.token_id}`);
  console.log(`is_neg_risk: ${testMarket.is_neg_risk}`);
  console.log(`is_yield_bearing: ${testMarket.is_yield_bearing}`);
  console.log('');

  try {
    // 创建 provider
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    console.log(`✅ 连接到 RPC: ${config.rpcUrl}\n`);

    // BSC 主网合约地址（从 SDK 中提取的准确地址）
    const CONTRACTS = {
      YIELD_BEARING_CONDITIONAL_TOKENS: '0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F',
      YIELD_BEARING_NEG_RISK_CONDITIONAL_TOKENS: '0xF64b0b318AAf83BD9071110af24D24445719A07F',
      CONDITIONAL_TOKENS: '0x22DA1810B194ca018378464a58f6Ac2B10C9d244',
      NEG_RISK_CONDITIONAL_TOKENS: '0x22DA1810B194ca018378464a58f6Ac2B10C9d244',
      USDT: '0x55d398326f99059fF775485246999027B3197955'
    };

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 合约地址');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 选择正确的合约地址
    const ctfAddress = testMarket.is_yield_bearing
      ? (testMarket.is_neg_risk
          ? CONTRACTS.YIELD_BEARING_NEG_RISK_CONDITIONAL_TOKENS
          : CONTRACTS.YIELD_BEARING_CONDITIONAL_TOKENS)
      : (testMarket.is_neg_risk
          ? CONTRACTS.NEG_RISK_CONDITIONAL_TOKENS
          : CONTRACTS.CONDITIONAL_TOKENS);

    console.log(`CTF: ${ctfAddress}`);
    console.log(`USDT: ${CONTRACTS.USDT}\n`);

    // 创建合约实例
    const ctfAbi = [
      'function getCollectionId(bytes32 conditionId, uint256 outcomeSlotCount, uint256 indexSet) view returns (bytes32)',
      'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
      'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)'
    ];

    const ctfContract = new ethers.Contract(ctfAddress, ctfAbi, provider);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 调用链上方法');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1. 获取 outcome slot count（二元市场应该是 2）
    try {
      const conditionIdBytes32 = ethers.zeroPadValue(testMarket.condition_id!, 32);
      const outcomeSlotCount = await ctfContract.getOutcomeSlotCount(conditionIdBytes32);
      console.log(`outcomeSlotCount: ${outcomeSlotCount.toString()}`);
      console.log(`  ✅ 二元市场应该返回 2`);
    } catch (error: any) {
      console.log(`⚠️  getOutcomeSlotCount 失败: ${error.message}`);
    }

    console.log('');

    // 2. 计算 collectionId for YES (indexSet = 1 << 0 = 1)
    try {
      const conditionIdBytes32 = ethers.zeroPadValue(testMarket.condition_id!, 32);
      const indexSetYES = 1n; // YES = 第 0 位 = 1
      const collectionIdYES = await ctfContract.getCollectionId(
        conditionIdBytes32,
        2, // outcomeSlotCount
        indexSetYES
      );
      console.log(`YES collectionId: ${collectionIdYES}`);

      // 计算 YES position ID
      const positionIdYES = await ctfContract.getPositionId(CONTRACTS.USDT, collectionIdYES);
      console.log(`YES position ID (token_id): ${positionIdYES.toString()}`);
      console.log(`实际 token_id:               ${testMarket.token_id}`);
      console.log(`匹配: ${positionIdYES.toString() === testMarket.token_id ? '✅' : '❌'}`);
    } catch (error: any) {
      console.log(`⚠️  YES 计算失败: ${error.message}`);
    }

    console.log('');

    // 3. 计算 collectionId for NO (indexSet = 1 << 1 = 2)
    try {
      const conditionIdBytes32 = ethers.zeroPadValue(testMarket.condition_id!, 32);
      const indexSetNO = 2n; // NO = 第 1 位 = 2
      const collectionIdNO = await ctfContract.getCollectionId(
        conditionIdBytes32,
        2, // outcomeSlotCount
        indexSetNO
      );
      console.log(`NO collectionId: ${collectionIdNO}`);

      // 计算 NO position ID
      const positionIdNO = await ctfContract.getPositionId(CONTRACTS.USDT, collectionIdNO);
      console.log(`NO position ID (token_id): ${positionIdNO.toString()}`);
    } catch (error: any) {
      console.log(`⚠️  NO 计算失败: ${error.message}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 结论');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('✅ 找到了正确的方法从 conditionId 计算 token_id！');
    console.log('');
    console.log('计算步骤：');
    console.log('1. getCollectionId(conditionId, outcomeSlotCount, indexSet)');
    console.log('   - YES: indexSet = 1');
    console.log('   - NO: indexSet = 2');
    console.log('2. getPositionId(collateralToken, collectionId)');
    console.log('   - collateralToken = USDT 地址');
    console.log('');
    console.log('下一步：');
    console.log('1. 将这个逻辑集成到 market-maker.ts');
    console.log('2. 创建 computeTokenId() 辅助方法');
    console.log('3. 在 executeUnifiedStrategy() 中使用计算出的 token_id');

  } catch (error: any) {
    console.error('❌ 错误:', error.message);
    console.error(error);
  }
}

testChainPositionId().catch(console.error);
