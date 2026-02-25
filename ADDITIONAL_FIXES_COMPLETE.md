# 统一做市商策略 - 额外 CRITICAL 问题修复完成

## 修复总结

继之前的 5 个 CRITICAL 问题修复后，又发现并修复了 **3 个额外的 CRITICAL 问题** 和 **3 个支持性问题**。

## 额外修复的问题

### CRITICAL #6: placeMMOrders 使用错误的 position 查询

**位置**: `src/market-maker.ts:4192-4201`

**问题**: 在 `placeMMOrders` 方法中，直接使用 `market.token_id` 查询 position，但 position 是按 YES/NO 的各自 token_id 存储的。

```typescript
// ❌ 错误代码
const position = this.positions.get(market.token_id) || { ... };
```

**修复**: 使用 `getAggregatedPosition` 方法聚合 YES 和 NO 的 position。

```typescript
// ✅ 修复后
const position = this.getAggregatedPosition(market);
```

---

### CRITICAL #7: handleTwoPhaseOrderFill 未聚合 position 且未传递 targetTokenId

**位置**: `src/market-maker.ts:5972-6037`

**问题 1**: 使用 `market.token_id` 查询 position，没有聚合 YES/NO。

```typescript
// ❌ 错误代码
const position = this.positions.get(market.token_id) || { yes_amount: 0, no_amount: 0 };
```

**问题 2**: 调用 `executeMarketBuy/executeMarketSell` 时没有传递 `targetTokenId` 参数。

```typescript
// ❌ 错误代码
await this.executeMarketBuy(market, 'YES', action.shares);  // 缺少第4个参数
await this.executeMarketBuy(market, 'NO', action.shares);   // 缺少第4个参数
await this.executeMarketSell(market, 'YES', action.shares); // 缺少第4个参数
await this.executeMarketSell(market, 'NO', action.shares);  // 缺少第4个参数
```

**修复**: 使用聚合的 position 并传递正确的 `targetTokenId`。

```typescript
// ✅ 修复后
const position = this.getAggregatedPosition(market);

const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

await this.executeMarketBuy(market, 'YES', action.shares, yesTokenId);
await this.executeMarketBuy(market, 'NO', action.shares, noTokenId);
await this.executeMarketSell(market, 'YES', action.shares, yesTokenId);
await this.executeMarketSell(market, 'NO', action.shares, noTokenId);
```

---

### CRITICAL #8: monitorTierOneStatus 使用错误的 key 查询价格

**位置**: `src/market-maker.ts:6310-6311`

**问题**: 使用 `market.token_id` 查询 `lastPlacedPrices`，但价格是用 `yesTokenId` 和 `noTokenId` 存储的。

```typescript
// ❌ 错误代码
const tokenId = market.token_id;
const lastPrices = this.lastPlacedPrices.get(tokenId);  // 查询失败！
```

**修复**: 使用 `yesTokenId` 查询价格。

```typescript
// ✅ 修复后
const { yesTokenId } = this.getYesNoTokenIds(market);
if (!yesTokenId) {
  return false;
}

const lastPrices = this.lastPlacedPrices.get(yesTokenId);  // 正确查询
```

---

## 支持性修复

### SUPPORT #1: 添加 getAggregatedPosition 辅助方法

**位置**: `src/market-maker.ts:6114-6154`

**目的**: 减少 position 聚合逻辑的代码重复。

```typescript
private getAggregatedPosition(market: Market): Position {
  const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

  if (!yesTokenId || !noTokenId) {
    // Fallback: 使用 market.token_id
    return this.positions.get(market.token_id) || { ... };
  }

  // 聚合 YES 和 NO token 的持仓
  const yesPosition = this.positions.get(yesTokenId) || { ... };
  const noPosition = this.positions.get(noTokenId) || { ... };

  return {
    token_id: market.token_id,
    question: market.question || '',
    yes_amount: yesPosition.yes_amount + noPosition.yes_amount,
    no_amount: yesPosition.no_amount + noPosition.no_amount,
    total_value: yesPosition.total_value + noPosition.total_value,
    avg_entry_price: 0,
    current_price: 0,
    pnl: (yesPosition.pnl || 0) + (noPosition.pnl || 0),
  };
}
```

---

### SUPPORT #2: 添加 marketByToken 映射

**位置**: `src/market-maker.ts:110` 和 `4194-4201`

**目的**: 支持从 token_id 反向查找市场对象（用于 `detectAndHedgeFills`）。

**添加字段**:
```typescript
private marketByToken: Map<string, Market> = new Map();
```

**更新映射**:
```typescript
async placeMMOrders(market: Market, orderbook: Orderbook): Promise<void> {
  // ...

  // 更新 marketByToken 映射（支持 YES/NO 的不同 token_id）
  const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
  this.marketByToken.set(market.token_id, market);
  if (yesTokenId) {
    this.marketByToken.set(yesTokenId, { ...market, token_id: yesTokenId });
  }
  if (noTokenId) {
    this.marketByToken.set(noTokenId, { ...market, token_id: noTokenId });
  }

  // ...
}
```

---

### SUPPORT #3: 修复 lastNetShares 类型声明

**位置**: `src/market-maker.ts:106`

**问题**: `lastNetShares` 同时存储数字和对象，但类型声明为 `Map<string, number>`。

**修复**: 更新类型为联合类型。

```typescript
// ❌ 之前
private lastNetShares: Map<string, number> = new Map();

// ✅ 修复后
private lastNetShares: Map<string, number | { net: number; yesAmount: number; noAmount: number }> = new Map();
```

**同时修复相关使用处的类型安全**:
```typescript
// 统一策略代码路径
const prevData = this.lastNetShares.get(market.condition_id);
const prevYes = (typeof prevData === 'object' && prevData?.yesAmount) ?? 0;
const prevNo = (typeof prevData === 'object' && prevData?.noAmount) ?? 0;

// 原有策略代码路径
const prevValue = this.lastNetShares.get(tokenId);
const prev = (typeof prevValue === 'number' ? prevValue : 0) ?? 0;
```

---

## 修改的文件

- ✅ `src/market-maker.ts`
  - **新增方法**: `getAggregatedPosition` - 聚合 position 的辅助方法
  - **新增字段**: `marketByToken` - token_id 到 market 的映射
  - **修改字段**: `lastNetShares` - 更新类型声明
  - **修复方法**: `placeMMOrders` - 使用聚合 position + 更新 marketByToken
  - **修复方法**: `handleTwoPhaseOrderFill` - 使用聚合 position + 传递 targetTokenId
  - **修复方法**: `monitorTierOneStatus` - 使用 yesTokenId 查询价格
  - **修复方法**: `detectAndHedgeFills` - 使用 marketByToken 查找市场对象
  - **类型安全**: 修复 lastNetShares 相关的类型安全问题

---

## 累计修复统计

### CRITICAL 级别（全部修复 ✅）

1. ✅ Position Tracking 数据分裂
2. ✅ 分别获取 YES 和 NO 订单簿
3. ✅ 修复 undefined variable `bestBid`
4. ✅ lastPlacedPrices 存储到两个 key
5. ✅ executeMarketBuy/executeMarketSell 已支持 targetTokenId
6. ✅ **placeMMOrders 使用错误的 position 查询** (新增)
7. ✅ **handleTwoPhaseOrderFill 未聚合 position 且未传递 targetTokenId** (新增)
8. ✅ **monitorTierOneStatus 使用错误的 key 查询价格** (新增)

### 支持性修复

1. ✅ 添加 getAggregatedPosition 辅助方法
2. ✅ 添加 marketByToken 映射
3. ✅ 修复 lastNetShares 类型声明

---

## 测试建议

### 1. 启用统一做市商策略

```bash
# .env
UNIFIED_MARKET_MAKER_ENABLED=true
UNIFIED_MARKET_MAKER_DYNAMIC_OFFSET_MODE=true
UNIFIED_MARKET_MAKER_MONITOR_TIER_ONE=true
```

### 2. 启动测试

```bash
npm start
```

### 3. 验证日志

查看以下关键日志确认所有修复生效：

```
🔑 使用不同的 token_id:
   YES: 5614545450941075...
   NO:  1383716054569139...

📊 聚合持仓: YES=100, NO=100
📊 实际价格: YES=$0.5000 NO=$0.5000

✅ 统一策略挂单完成（使用 YES 和 NO 各自的 token_id）
```

### 4. 验证两阶段策略

如果启用了两阶段策略，确认：
- ✅ YES/NO Buy 订单成交时正确对冲
- ✅ 使用正确的 token_id 进行对冲操作
- ✅ 持仓数据正确聚合

---

## 总结

✅ **所有 8 个 CRITICAL 问题已修复**
✅ **3 个支持性问题已修复**

现在统一做市商策略和两阶段策略应该可以完全正常工作：
- ✅ 正确使用不同的 token_id 挂单
- ✅ 正确获取 YES 和 NO 的市场价格
- ✅ 正确聚合持仓数据（在所有相关位置）
- ✅ 正确处理订单成交和对冲
- ✅ 正确监控第一档状态
- ✅ 两阶段策略使用正确的 token_id 对冲

**可以启用统一策略和两阶段策略进行测试了！**
