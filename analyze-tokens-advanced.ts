/**
 * 高级 Token ID 分析
 *
 * 尝试不同的计算方式来找出 Predict.fun 的 token_id 规律
 */

async function analyzeTokenIdRelationship() {
  // 从实际数据中提取的示例
  const examples = [
    {
      question: 'BTC/USD Up or Down on Dec 05?',
      condition_id: '0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3',
      token_id: '13837160545691392353892385337234860023480456244656316673051367697935345378627',
    },
    {
      question: 'Clair Obscur: Game of the Year',
      condition_id: '0x22edfc16ce1267e1c6040df17a18d1599448c2ab62c136d11a665941978a6c16',
      token_id: '40437221214445478921897511193122380801843041273451655499133418794197224872880',
    },
  ];

  console.log('🔍 分析 Token ID 计算方式\n');

  for (const ex of examples) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`市场: ${ex.question.substring(0, 50)}...`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const conditionIdBigInt = BigInt(ex.condition_id);
    const tokenIdBigInt = BigInt(ex.token_id);

    console.log(`condition_id (hex): ${ex.condition_id}`);
    console.log(`condition_id (dec): ${conditionIdBigInt.toString()}`);
    console.log(`token_id (hex):     0x${tokenIdBigInt.toString(16)}`);
    console.log(`token_id (dec):     ${tokenIdBigInt.toString()}\n`);

    // 尝试不同的计算方式
    console.log('尝试不同的计算方式:\n');

    // 方式 1: token_id = (conditionId << 1) | outcome
    console.log('1. 标准 CTF 方式 (conditionId << 1 | outcome):');
    const expectedYes = (conditionIdBigInt << 1n) | 1n;
    const expectedNo = (conditionIdBigInt << 1n) | 0n;
    console.log(`   期望 YES: ${expectedYes.toString()}`);
    console.log(`   期望 NO:  ${expectedNo.toString()}`);
    console.log(`   实际:     ${tokenIdBigInt.toString()}`);
    const match1 = tokenIdBigInt === expectedYes ? 'YES' : tokenIdBigInt === expectedNo ? 'NO' : '否';
    console.log(`   匹配:     ${match1}\n`);

    // 方式 2: token_id = conditionId | (outcome << 255)
    console.log('2. NegRisk 方式:');
    const negRiskYes = conditionIdBigInt | (1n << 255n);
    const negRiskNo = conditionIdBigInt | (0n << 255n);
    console.log(`   期望 YES: ${negRiskYes.toString()}`);
    console.log(`   期望 NO:  ${negRiskNo.toString()}`);
    const match2 = tokenIdBigInt === negRiskYes ? 'YES' : tokenIdBigInt === negRiskNo ? 'NO' : '否';
    console.log(`   匹配:     ${match2}\n`);

    // 方式 3: token_id 就是 conditionId
    console.log('3. token_id = conditionId:');
    console.log(`   匹配: ${tokenIdBigInt === conditionIdBigInt ? '是' : '否'}\n`);

    // 方式 4: 检查最后几位
    console.log('4. 检查二进制最后几位:');
    const tokenIdBin = tokenIdBigInt.toString(2);
    const conditionIdBin = conditionIdBigInt.toString(2);
    console.log(`   token_id:     ...${tokenIdBin.slice(-8)}`);
    console.log(`   condition_id: ...${conditionIdBin.slice(-8)}`);

    // 检查是否相差某一位
    const xor = tokenIdBigInt ^ conditionIdBigInt;
    console.log(`   XOR 结果:     ${xor.toString()}`);
    console.log(`   XOR (hex):    0x${xor.toString(16)}`);
    console.log(`   XOR (bin):    ${xor.toString(2).slice(-16)}`);
    console.log('');

    // 方式 5: 可能使用 slot
    console.log('5. 检查是否使用了 outcomeSlot:');
    // 在 NegRisk 中，token_id = conditionId | (outcome << 255)
    for (let slot = 0; slot < 256; slot += 1) {
      const testTokenId = conditionIdBigInt | (BigInt(slot) << 255n);
      if (testTokenId === tokenIdBigInt) {
        console.log(`   ✅ 匹配! slot = ${slot}`);
        console.log(`   这意味着 outcome = ${slot % 2 === 0 ? 'NO' : 'YES'}\n`);
        break;
      }
    }

    // 方式 6: 检查是否是其他简单的位操作
    console.log('6. 其他位操作尝试:');

    // token_id 可能是 conditionId 的某个简单变换
    const diff = tokenIdBigInt - conditionIdBigInt;
    console.log(`   差值: ${diff.toString()}`);
    console.log(`   差值 (hex): 0x${diff.toString(16)}`);

    // 检查是否是取反或补码
    const max256 = 2n ** 256n;
    const complement = max256 - conditionIdBigInt;
    console.log(`   补码: ${complement.toString()}`);

    console.log('\n');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 结论');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('基于以上分析，可能的情况：');
  console.log('');
  console.log('1. Predict.fun 使用了非标准的 token_id 计算方式');
  console.log('2. token_id 可能不是通过 condition_id 计算的');
  console.log('3. token_id 可能是从链上数据或其他方式生成的');
  console.log('');
  console.log('需要进一步的信息：');
  console.log('- 查看智能合约代码 (CTF, NegRiskAdapter)');
  console.log('- 获取实际的 YES 和 NO 订单，对比它们的 token_id');
  console.log('- 检查订单创建时的 payload 结构');
  console.log('');
}

analyzeTokenIdRelationship().catch(console.error);
