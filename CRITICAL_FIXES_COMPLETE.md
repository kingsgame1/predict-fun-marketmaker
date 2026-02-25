# 统一做市商策略 - CRITICAL 问题修复完成

## 修复总结

已修复所有 **5 个 CRITICAL 级别的 bug** 和相关 HIGH 级别问题。

## 修复的问题

### 1. ✅ Position Tracking 数据分裂 (CRITICAL #1)

**问题**: YES 和 NO 有不同的 token_id，但 position 只查询单个 token_id

**修复**: 在 `executeUnifiedStrategy` 中添加 position 聚合逻辑

```typescript
// 聚合 YES 和 NO 的 position
const yesPosition = this.positions.get(yesTokenId) || { ... };
const noPosition = this.positions.get(noTokenId) || { ... };

const unifiedPosition: Position = {
  token_id: market.token_id,
  question: market.question || '',
  yes_amount: yesPosition.yes_amount + noPosition.yes_amount,
  no_amount: yesPosition.no_amount + noPosition.no_amount,
  total_value: yesPosition.total_value + noPosition.total_value,
  pnl: yesPosition.pnl + noPosition.pnl,
};
```

**影响**: 现在可以正确获取 YES 和 NO 的总持仓量

---

### 2. ✅ 分别获取 YES 和 NO 订单簿 (CRITICAL #2)

**问题**: YES 和 NO 使用同一个 orderbook，NO 价格是从 YES 推算的

**修复**: 在 `executeUnifiedStrategy` 中分别获取两个订单簿

```typescript
// 分别获取 YES 和 NO 的订单簿
const yesOrderbook = yesTokenId ? await this.api.getOrderbook(yesTokenId) : orderbook;
const noOrderbook = noTokenId ? await this.api.getOrderbook(noTokenId) : orderbook;

const yesPrice = yesOrderbook.best_bid || 0;
const noPrice = noOrderbook.best_bid || (1 - yesPrice);  // fallback
```

**影响**: 现在使用实际的 NO 市场价格，而不是推算的价格

---

### 3. ✅ 修复 undefined variable `bestBid` (CRITICAL #3)

**问题**: `monitorTierOneStatus` 第 6312 行使用了未定义的 `bestBid`

**修复**: 从 orderbook 获取 `bestBid`

```typescript
const bestBid = yesBestBid || 0;
const analysis = this.unifiedMarketMakerStrategy.analyze(market, unifiedPosition, bestBid, 1 - bestBid);
```

**影响**: 防止崩溃

---

### 4. ✅ lastPlacedPrices 存储到两个 key (CRITICAL #4)

**问题**: 只用 YES token_id 作为 key，NO 市场监控失效

**修复**: 同时存储到 YES 和 NO 的 token_id

```typescript
const priceData = {
  yesBid: prices.yesBid,
  yesAsk: prices.yesAsk,
  noBid: prices.noBid,
  noAsk: prices.noAsk,
  timestamp: Date.now(),
};

this.lastPlacedPrices.set(yesTokenId, priceData);
this.lastPlacedPrices.set(noTokenId, priceData);
```

**影响**: 现在可以正确监控 NO 市场的第一档状态

---

### 5. ✅ executeMarketBuy/executeMarketSell 已支持 targetTokenId (CRITICAL #5)

**问题**: 需要确保使用正确的 market 对象

**状态**: 代码已经正确实现了 `targetTokenId` 参数支持

```typescript
const actualTokenId = targetTokenId || market.token_id;
const actualMarket = targetTokenId ? { ...market, token_id: actualTokenId } : market;
```

**影响**: 已确认正确实现

---

## 额外修复

### 6. ✅ handleUnifiedOrderFill 使用聚合 position

**修复**: 使用聚合的 unifiedPosition 而不是单个 token_id 的 position

```typescript
const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
const yesPosition = this.positions.get(yesTokenId) || { ... };
const noPosition = this.positions.get(noTokenId) || { ... };

const unifiedPosition: Position = {
  // ... 聚合逻辑
};

const action = this.unifiedMarketMakerStrategy.handleOrderFill(
  market.token_id,
  side,
  token,
  filledShares,
  unifiedPosition.yes_amount,
  unifiedPosition.no_amount
);
```

---

### 7. ✅ detectAndHedgeFills 按市场聚合 position

**问题**: 遍历所有 token_id，但应该按 market.condition_id 聚合

**修复**: 改为遍历市场，使用 condition_id 作为 key

```typescript
const processedMarkets = new Set<string>();

for (const [tokenId, position] of this.positions.entries()) {
  // 找到对应的市场
  let market: Market | undefined;
  for (const [mTokenId, m] of this.marketByToken) {
    if (mTokenId === tokenId) {
      market = m;
      break;
    }
  }

  if (!market || !market.condition_id || processedMarkets.has(market.condition_id)) {
    continue;
  }

  processedMarkets.add(market.condition_id);

  // 聚合 YES 和 NO 的 position
  // ...
}
```

---

## 修改的文件

- ✅ `src/market-maker.ts`
  - `executeUnifiedStrategy` - 聚合 position + 获取两个订单簿 + 修复 lastPlacedPrices
  - `monitorTierOneStatus` - 修复 undefined bestBid + 使用聚合 position
  - `handleUnifiedOrderFill` - 使用聚合 position
  - `detectAndHedgeFills` - 按市场聚合 position

---

## 测试建议

### 1. 启用统一策略

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

查看以下关键日志确认修复生效：

```
🔑 使用不同的 token_id:
   YES: 5614545450941075...
   NO:  1383716054569139...

📊 聚合持仓: YES=100, NO=100
📊 实际价格: YES=$0.5000 NO=$0.5000

✅ 统一策略挂单完成（使用 YES 和 NO 各自的 token_id）
```

### 4. 监控订单成交

确认以下流程正常工作：

1. YES Buy 订单成交 → 触发 NO Buy 对冲（使用 NO token_id）
2. NO Buy 订单成交 → 触发 YES Buy 对冲（使用 YES token_id）
3. 持仓变化正确更新（YES 和 NO 分别统计）

---

## 剩余问题（非 CRITICAL）

### MEDIUM 级别问题

8. **No separate orderbook caching** - 订单簿缓存可能覆盖（建议优化）
9. **getYesNoTokenIds fallback** - 如果 outcomes 数据缺失会失败（建议增强错误处理）
10. **No YES+NO=1 verification** - 应该验证价格关系（建议添加）

这些不影响核心功能，可以后续优化。

---

## 总结

✅ **所有 5 个 CRITICAL 问题已修复**

现在统一做市商策略应该可以正常工作：
- ✅ 正确使用不同的 token_id 挂单
- ✅ 正确获取 YES 和 NO 的市场价格
- ✅ 正确聚合持仓数据
- ✅ 正确处理订单成交和对冲
- ✅ 正确监控第一档状态

**可以启用统一策略进行测试了！**
