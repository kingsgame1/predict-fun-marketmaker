# 🚨 严重问题发现：YES/NO Token ID 问题

## 问题描述

用户指出："有时候 NO 的价格比 YES 高"

这说明 YES 和 NO 有**独立的 token_id**，不能通过价格区分！

---

## 核心发现

### Market 对象的 token_id 已经包含 outcome

```typescript
// Market 接口
export interface Market {
  token_id: string;      // 已经是 YES 或 NO 的 token_id
  outcome?: string;      // 'YES' 或 'NO'，指定这是哪个 outcome
  condition_id?: string; // 条件 ID
  ...
}
```

### 当前的错误实现

```typescript
// ❌ 错误！两个订单使用同一个 token_id
await this.placeLimitOrder(market, 'BUY', prices.yesBid, buyOrderSize, 0.02);
await this.placeLimitOrder(market, 'BUY', prices.noBid, buyOrderSize, 0.02);
```

**问题**：
- 如果 `market.token_id` 是 YES 的 token ID
- 那么 NO 的订单会错误地使用 YES 的 token_id
- 导致订单创建失败或被识别为错误的 outcome

---

## CTF Token ID 结构

在 Conditional Token Framework (CTF) 中：

### Token ID 计算公式

```
YES token ID = (conditionId << 1) | 1
NO token ID  = (conditionId << 1) | 0
```

或者反过来（取决于平台实现）：

```
YES token ID = (conditionId << 1) | 0
NO token ID  = (conditionId << 1) | 1
```

### 示例

```
conditionId = "0x1234..."

YES token_id = "0x2468..." (conditionId << 1 | 1)
NO token_id  = "0x2469..." (conditionId << 1 | 0)
```

---

## 需要的修复方案

### 方案 1: 从 condition_id 计算 token_id（推荐）

```typescript
// 计算对应的 token_id
function computeTokenId(conditionId: string, outcome: 'YES' | 'NO'): string {
  const conditionIdBigInt = BigInt(conditionId);
  const outcomeBit = outcome === 'YES' ? 1 : 0;
  const tokenIdBigInt = (conditionIdBigInt << 1n) | BigInt(outcomeBit);
  return tokenIdBigInt.toString();
}

// 使用
const yesTokenId = computeTokenId(market.condition_id, 'YES');
const noTokenId = computeTokenId(market.condition_id, 'NO');

// 分别挂单
await this.placeLimitOrderWithToken(market, 'BUY', 'YES', yesTokenId, prices.yesBid, ...);
await this.placeLimitOrderWithToken(market, 'BUY', 'NO', noTokenId, prices.noBid, ...);
```

### 方案 2: 从现有 token_id 推导

```typescript
// 从当前 token_id 推导另一个
function flipTokenId(tokenId: string): string {
  const tokenIdBigInt = BigInt(tokenId);
  const outcomeBit = tokenIdBigInt & 1n;
  const oppositeOutcomeBit = outcomeBit === 1n ? 0n : 1n;
  return (tokenIdBigInt ^ 1n).toString();
}

// 使用
const currentTokenId = market.token_id;
const oppositeTokenId = flipTokenId(currentTokenId);

// 判断哪个是 YES 哪个是 NO
if (market.outcome === 'YES') {
  // 当前是 YES，需要计算 NO 的 token_id
  await this.placeLimitOrderWithToken(market, 'BUY', 'YES', currentTokenId, prices.yesBid, ...);
  await this.placeLimitOrderWithToken(market, 'BUY', 'NO', oppositeTokenId, prices.noBid, ...);
} else {
  // 当前是 NO，需要计算 YES 的 token_id
  await this.placeLimitOrderWithToken(market, 'BUY', 'YES', oppositeTokenId, prices.yesBid, ...);
  await this.placeLimitOrderWithToken(market, 'BUY', 'NO', currentTokenId, prices.noBid, ...);
}
```

---

## 需要验证的问题

### 1. Token ID 计算方式

**问题**：Predict.fun 使用哪种计算方式？

```
选项 A: YES = (conditionId << 1) | 1, NO = (conditionId << 1) | 0
选项 B: YES = (conditionId << 1) | 0, NO = (conditionId << 1) | 1
选项 C: 其他计算方式
```

**如何验证**：
- 检查现有订单的 token_id
- 比较 token_id 和 condition_id 的关系
- 查看持仓数据中 YES/NO 的 token_id

### 2. Market.outcome 的含义

**问题**：`market.outcome` 是什么意思？

**可能性**：
- A: Market 对象只代表一个 outcome（YES 或 NO）
- B: Market 对象代表整个市场，outcome 只是默认值
- C: outcome 表示其他含义

**需要确认**：获取市场数据时，YES 和 NO 是同一个对象还是两个对象？

### 3. 订单簿数据结构

**问题**：订单簿是包含 YES 和 NO 的订单，还是分开的？

**需要检查**：
- `getOrderbook(tokenId)` 返回的数据
- 是否需要分别获取 YES 和 NO 的订单簿

---

## 临时解决方案

### 在修复前，可以使用的策略

```typescript
// 策略 1: 只挂单一个 outcome（YES 或 NO）
if (market.outcome === 'YES') {
  // 只挂 YES 订单
  await this.placeLimitOrder(market, 'BUY', prices.yesBid, ...);
} else {
  // 只挂 NO 订单
  await this.placeLimitOrder(market, 'BUY', prices.noBid, ...);
}

// 策略 2: 通过 condition_id 获取两个市场
const yesMarket = await this.api.getMarket(yesTokenId);
const noMarket = await this.api.getMarket(noTokenId);
```

---

## 现有代码是否也有这个问题？

### 检查两阶段策略

```typescript
// executeTwoPhaseBuySide 中的代码
if (prices.yesBid > 0) {
  await this.placeLimitOrder(market, 'BUY', prices.yesBid, orderSize, 0.02);
}
if (prices.noBid > 0) {
  await this.placeLimitOrder(market, 'BUY', prices.noBid, orderSize, 0.02);
}
```

**结论**：现有代码可能也有同样的问题！

但需要确认：
- 这个代码是否被实际使用？
- 是否有其他的逻辑处理 token_id？

---

## 下一步行动

### 立即需要做的

1. ✅ **确认 Token ID 计算方式**
   - 查看现有订单和持仓数据
   - 比较 token_id 和 condition_id

2. ✅ **修复统一策略**
   - 实现正确的 token_id 获取逻辑
   - 添加 `placeLimitOrderWithToken` 方法

3. ✅ **测试修复**
   - 确认 YES 和 NO 订单使用正确的 token_id
   - 验证订单被正确创建和识别

4. ⚠️ **检查现有代码**
   - 确认两阶段策略是否也有这个问题
   - 如果有，需要一并修复

---

## 总结

**问题严重程度**：🔴 严重

**影响范围**：
- 统一做市商策略
- 可能还包括两阶段策略

**修复优先级**：🚨 最高优先级

**风险评估**：
- 如果不修复，订单可能创建失败
- 或者订单被错误识别为错误的 outcome
- 导致无法正确对冲，产生风险敞口

---

**发现时间**: 2025-02-22
**发现人员**: 用户
**状态**: ⚠️ 待修复
