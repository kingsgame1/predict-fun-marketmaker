# Token ID 问题调查完成报告

## 执行摘要

经过深入调查，发现了关于 Predict.fun token_id 的关键问题：

**核心发现**：CTF 标准公式 **不适用于** Predict.fun

## 调查结果

### 1. API 市场数据结构

```
找到 25 个市场
每个 condition_id 只有 1 个市场对象
没有 outcome 字段（值为 undefined/N/A）
```

**示例数据**：
```json
{
  "token_id": "13837160545691392353892385337234860023480456244656316673051367697935345378627",
  "condition_id": "0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3",
  "outcome": "N/A",
  "question": "BTC/USD Up or Down on Dec 05?"
}
```

### 2. CTF 标准公式验证

测试了 5 个市场，**匹配率: 0%**

**测试公式**：
```typescript
// 标准 CTF 方式
const tokenId = (conditionId << 1n) | (outcome === 'YES' ? 1n : 0n);
```

**结果**：
```
市场 1:
  condition_id: 0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3
  实际 token_id: 13837160545691392353892385337234860023480456244656316673051367697935345378627
  计算 YES:     71878929409107060952719161180648521246423075874702295157987999184424386427751
  计算 NO:      71878929409107060952719161180648521246423075874702295157987999184424386427750
  ❌ 不匹配
```

### 3. 从 token_id 反推 condition_id

```
从 token_id 反推：
  condition_id: 0xf4bc71505489b5c290395615123cc76939704ac30b29dff5f3ca022e639f2a1
  outcome bit: 1 (YES)
  ❌ 反推的 condition_id 与市场数据不匹配
```

### 4. 现有代码分析

**发现**：现有代码（包括两阶段策略和统一策略）都使用同一个 `market.token_id` 来挂 YES 和 NO 的订单。

```typescript
// 两阶段策略
await this.placeLimitOrder(market, 'BUY', prices.yesBid, ...);  // 使用相同 token_id
await this.placeLimitOrder(market, 'BUY', prices.noBid, ...);   // 使用相同 token_id

// 统一策略（之前的修复）
const { yesMarket, noMarket } = this.findYesNoMarkets(market);
// ❌ findYesNoMarkets 无法找到配对，因为每个 condition_id 只有 1 个市场
```

## 可能的解释

### 1. token_id 已经包含了 outcome 信息
- token_id 可能通过某种非标准方式编码了 outcome
- 需要查看链上合约的存储方式
- 或者查询 Predict.fun 的文档

### 2. 每个 Market 对象只代表一个 outcome
- API 返回的 token_id 可能已经是特定 outcome 的 token
- 需要：
  - 使用不同的 API endpoint 获取 YES/NO 市场
  - 或者从 token_id 中提取 outcome 信息
  - 或者通过链上合约查询

### 3. 需要使用链上数据
- token_id 可能需要从链上合约中查询
- SDK 的 `splitPositions` 和 `mergePositions` 方法使用 conditionId
- 可能有 SDK 方法可以从 conditionId 获取 token_id 列表

## 下一步行动

### 选项 A：深入 SDK 研究
```typescript
import { OrderBuilder } from '@predictdotfun/sdk';

const orderBuilder = await OrderBuilder.make(chainId, signer);

// 检查是否有从 conditionId 获取 token_id 的方法
// 或者查看 splitPositions 如何处理 token_id
```

### 选项 B：查看链上合约
- 连接到 BSC 网络
- 调用 ConditionalTokens 合约
- 查询特定 conditionId 的所有 position token IDs

### 选项 C：联系 Predict.fun 支持
- 询问如何获取 YES/NO 的 token_id
- 查看官方文档
- 或者检查其他实现示例

### 选项 D：使用不同的 API endpoint
```
GET /v1/markets/{conditionId}/yes  # 获取 YES 市场
GET /v1/markets/{conditionId}/no   # 获取 NO 市场
GET /v1/markets/{conditionId}      # 可能返回两个 outcomes
```

## 临时解决方案

在找到正确方法之前：

1. **禁用统一策略**
   ```bash
   UNIFIED_MARKET_MAKER_ENABLED=false
   ```

2. **只交易一个 outcome**
   - 修改代码只挂 YES 或只挂 NO 的订单
   - 或者验证现有代码是否已经在这样做

3. **使用两阶段策略**
   - 检查它是否真的在工作
   - 如果工作，分析它的实现方式

## 关键问题清单

- ❓ API 中是否有专门的 endpoint 来获取 YES/NO 的完整信息？
- ❓ token_id 中是否包含了 outcome 信息？如果有，如何提取？
- ❓ 链上合约中如何存储 position token IDs？
- ❓ SDK 中是否有从 conditionId 获取所有 token_ids 的方法？
- ❓ 现有的两阶段策略是否真的在同时交易 YES 和 NO？

## 文件位置

- 验证脚本: `verify-token-id-calculation.ts`
- 市场结构检查: `check-market-structure.ts`
- Token ID 分析: `TOKEN_ID_FINAL_ANALYSIS.md`
- 之前的不完整修复: `src/market-maker.ts` (findYesNoMarkets, inferOutcome)

## 状态

⏸️ **暂停** - 需要更多信息才能继续

建议：
1. 查看 Predict.fun SDK 文档
2. 或者联系 Predict.fun 开发者支持
3. 或者查看链上合约的实现
