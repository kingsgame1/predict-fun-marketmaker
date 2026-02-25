# Token ID 问题 - 最终调查报告

## 执行摘要

经过深入调查，发现了关于 Predict.fun token_id 的**核心问题**：

**无法确定如何获取 YES 和 NO 各自的 token_id**

## 调查结果汇总

### 1. API 市场数据结构

```
✅ 发现：API 返回每个 condition_id 只有 1 个市场对象
❌ 问题：没有 outcome 字段来区分 YES/NO
❌ 问题：只有一个 token_id，无法确定它代表 YES 还是 NO
```

**示例数据**：
```json
{
  "token_id": "13837160545691392353892385337234860023480456244656316673051367697935345378627",
  "condition_id": "0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3",
  "outcome": undefined,
  "question": "BTC/USD Up or Down on Dec 05?",
  "is_neg_risk": false,
  "is_yield_bearing": true
}
```

### 2. CTF 标准公式验证

```
测试公式：token_id = (conditionId << 1n) | (outcome === 'YES' ? 1n : 0n)

测试 5 个市场：
匹配成功: 0 个
匹配率: 0.0%

❌ 结论：CTF 标准公式不适用于 Predict.fun
```

### 3. 链上合约调查

```
尝试方法：
✅ getOutcomeSlotCount(conditionId) → 成功返回 2
❌ getCollectionId(conditionId, 2, indexSet) → require(false)
❌ getPositionId(collateralToken, collectionId) → 无法测试

问题：getCollectionId 调用失败
可能原因：
  1. Condition 没有被 prepared
  2. 参数不正确
  3. 需要不同的调用方式
```

### 4. 订单簿 API 调查

```
尝试获取订单簿：
所有市场返回 404

GET /v1/markets/{token_id}/orderbook → 404 Not Found

❌ 结论：无法通过订单簿 API 获取 token 信息
```

### 5. SDK 方法调查

```
SDK 提供的方法：
- validateTokenIds(tokenIds, isNegRisk, isYieldBearing)
- splitPositions(conditionId, amount, ...)
- mergePositions(conditionId, amount, ...)

观察：
- SDK 方法使用 conditionId，不是 token_id
- 这说明链上操作主要使用 conditionId
- token_id 可能由 CTF 合约内部计算

❌ 问题：SDK 没有提供从 conditionId 获取 token_id 的公共方法
```

### 6. 现有代码分析

```
发现：
- 现有代码（两阶段策略、统一策略）都使用同一个 market.token_id
- 代码尝试挂 YES 和 NO 的订单，但使用相同的 token_id
- 这在技术上是错误的

示例代码：
await this.placeLimitOrder(market, 'BUY', prices.yesBid, ...);  // 相同 token_id
await this.placeLimitOrder(market, 'BUY', prices.noBid, ...);   // 相同 token_id

❌ 结论：现有代码可能存在同样的问题
```

## 核心问题

### 问题陈述

Predict.fun 的市场数据结构中：

1. **每个 condition_id 只返回 1 个市场对象**
2. **没有 outcome 字段**区分 YES/NO
3. **只有一个 token_id**，无法确定它代表 YES 还是 NO
4. **CTF 标准公式不适用**
5. **链上合约调用失败**
6. **订单簿 API 返回 404**

### 影响范围

- ❌ **统一做市商策略**：无法同时挂 YES 和 NO 的订单
- ❌ **两阶段策略**：可能也存在同样的问题
- ❌ **颗粒度对冲**：无法正确对冲

## 可能的解释

### 1. API 设计问题

Predict.fun 的 API 可能：
- 只返回一个代表性市场（可能是 YES 或 NO）
- 需要使用不同的 endpoint 获取完整数据
- 或者 token_id 本身已经包含了 outcome 信息（但不是标准 CTF 方式）

### 2. Token ID 编码方式

Predict.fun 可能使用了非标准的 token_id 编码：
- 不是 `(conditionId << 1) | outcomeBit`
- 可能包含 collection ID、slot 等更多元数据
- 需要查看 Predict.fun 的具体实现

### 3. 链上合约状态

- Condition 可能需要先被 prepared
- Collection 可能需要先被创建
- 或者使用了不同的 CTF 合约版本

## 下一步行动建议

### 选项 A：查看 Predict.fun 源代码/文档 ⭐ 推荐

```bash
# 查找 Predict.fun 的文档
https://docs.predict.fun
https://github.com/predict-dot-fun

# 查找 API 文档
GET /v1/markets/{conditionId}  # 可能返回完整数据
GET /v1/conditions/{conditionId}/outcomes  # 可能有专门的 endpoint
```

### 选项 B：联系 Predict.fun 支持

- 询问如何获取 YES/NO 的 token_id
- 查看示例代码
- 或者查看开发者文档

### 选项 C：分析现有工作代码

- 检查是否有其他项目成功实现了这个功能
- 查看 Predict.fun 的官方 SDK 示例
- 或者查看开源的 trading bot

### 选项 D：深入链上合约分析

```solidity
// 1. 检查 condition 状态
function getCondition(conditionId) view returns (prepared, outcomeSlotCount)

// 2. 检查所有 position IDs
// 可能需要遍历所有可能的 indexSet 组合

// 3. 或者监听事件
event PositionSplit(...)
event PositionsMerge(...)
```

### 选项 E：使用替代方案 ⚠️ 临时

```typescript
// 方案 1：只交易一个 outcome
if (market.token_id) {
  await this.placeLimitOrder(market, 'BUY', price, shares);
}

// 方案 2：使用两阶段策略（如果它在工作）
// 需要验证它是否真的在同时交易 YES 和 NO

// 方案 3：使用跨平台套利（如果有其他平台）
```

## 临时解决方案

在找到正确方法之前：

### 1. 禁用统一策略

```bash
# .env
UNIFIED_MARKET_MAKER_ENABLED=false
```

### 2. 只使用单 outcome 交易

修改代码，只对一个 outcome 挂单：

```typescript
// 挂 YES Buy 单（如果价格 < 0.5）
if (yesPrice < 0.5) {
  await this.placeLimitOrder(market, 'BUY', yesPrice, shares);
}

// 挂 NO Buy 单（如果价格 > 0.5）
if (noPrice > 0.5) {
  await this.placeLimitOrder(market, 'BUY', noPrice, shares);
}
```

### 3. 验证两阶段策略

检查两阶段策略是否真的在工作：
- 它是否真的在同时挂 YES 和 NO 的订单？
- 还是在使用某种方式获取两个 token_id？

## 文件位置

- 验证脚本:
  - `verify-token-id-calculation.ts`
  - `check-market-structure.ts`
  - `test-chain-position-id.ts`
  - `check-orderbook-tokens.ts`
  - `check-sdk-token-methods.ts`

- 分析文档:
  - `TOKEN_ID_INVESTIGATION_COMPLETE.md`
  - `TOKEN_ID_FINAL_ANALYSIS.md`
  - `CRITICAL_TOKEN_ID_ISSUE.md`
  - `API_RESEARCH_OUTCOME.md`

- 不完整的修复:
  - `src/market-maker.ts` (findYesNoMarkets, inferOutcome)
  - `src/utils/pairs.ts`

## 状态

🔴 **阻塞** - 需要更多信息才能继续

**建议**：
1. ⭐ 查看 Predict.fun 官方文档或联系支持
2. 或者分析其他成功实现这个功能的项目
3. 在找到正确方法之前，禁用统一策略

## 关键问题清单

- ❓ Predict.fun API 中是否有专门的 endpoint 来获取 YES/NO 的完整信息？
- ❓ token_id 中是否包含了 outcome 信息？如果有，如何提取？
- ❓ 是否需要使用不同的 API endpoint 或参数？
- ❓ 现有的两阶段策略是否真的在同时交易 YES 和 NO？
- ❓ Predict.fun 是否有官方文档说明 token_id 的结构？

## 时间线

1. ✅ 2025-02-22: 发现问题
2. ✅ 2025-02-22: 验证 CTF 公式（失败）
3. ✅ 2025-02-22: 调查链上合约（失败）
4. ✅ 2025-02-22: 检查订单簿 API（失败）
5. ✅ 2025-02-22: SDK 方法调查（部分成功）
6. ⏸️ 2025-02-22: 等待更多信息或文档
