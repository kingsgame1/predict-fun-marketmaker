# 统一做市商策略 CRITICAL 问题修复

## 问题概述

代码审查发现了 5 个 CRITICAL 级别的 bug，这些 bug 会导致策略无法正常工作。

## 修复计划

### 1. Position Tracking 聚合 (CRITICAL #1)

**问题**: 使用单个 token_id 查询 position，但 YES 和 NO 有不同的 token_id

**修复**: 在 executeUnifiedStrategy 开始时聚合 YES 和 NO 的 position

### 2. 获取两个订单簿 (CRITICAL #2)

**问题**: 只获取了一个 token_id 的订单簿，YES 和 NO 都用同一个

**修复**: 分别获取 YES 和 NO 的订单簿

### 3. 修复 undefined variable (CRITICAL #3)

**问题**: bestBid 未定义

**修复**: 从 orderbook 获取 bestBid

### 4. lastPlacedPrices 使用两个 key (CRITICAL #4)

**问题**: 只用 YES token_id 作为 key，NO 市场监控失效

**修复**: 同时存储到 YES 和 NO 的 key

### 5. 修复 executeMarketBuy/executeMarketSell (CRITICAL #5)

**问题**: 创建的 market 对象不正确

**修复**: 从 outcomes 数组构建正确的 market 对象

## 修复代码

### 修复 1 + 2: executeUnifiedStrategy - 聚合 position + 获取两个订单簿

```typescript
private async executeUnifiedStrategy(
  market: Market,
  orderbook: Orderbook,
  position: Position,
  analysis: any
): Promise<void> {
  // 修复：获取 YES/NO token_ids
  const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

  if (!yesTokenId || !noTokenId) {
    console.warn(`⚠️  无法获取 YES/NO token_id，跳过统一策略`);
    return;
  }

  console.log(`🔑 使用不同的 token_id:`);
  console.log(`   YES: ${yesTokenId.slice(0, 16)}...`);
  console.log(`   NO:  ${noTokenId.slice(0, 16)}...`);

  // 修复 1: 聚合 YES 和 NO 的 position
  const yesPosition = this.positions.get(yesTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0 };
  const noPosition = this.positions.get(noTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0 };

  const unifiedPosition: Position = {
    token_id: market.token_id,
    question: market.question || '',
    yes_amount: yesPosition.yes_amount + noPosition.yes_amount,
    no_amount: yesPosition.no_amount + noPosition.no_amount,
    total_value: yesPosition.total_value + noPosition.total_value,
    avg_entry_price: 0,
    current_price: 0,
    pnl: (yesPosition.pnl || 0) + (noPosition.pnl || 0),
  };

  // 修复 2: 分别获取 YES 和 NO 的订单簿
  const yesOrderbook = yesTokenId ? await this.api.getOrderbook(yesTokenId) : orderbook;
  const noOrderbook = noTokenId ? await this.api.getOrderbook(noTokenId) : orderbook;

  const yesPrice = yesOrderbook.best_bid || 0;
  const noPrice = noOrderbook.best_bid || (1 - yesPrice);

  const prices = this.unifiedMarketMakerStrategy.suggestOrderPrices(
    yesPrice,
    noPrice,
    yesOrderbook,
    noOrderbook
  );

  // ... 其余代码保持不变，但使用 unifiedPosition
}
```

### 修复 3 + 4: monitorTierOneStatus - 修复 bestBid + 使用两个 key

```typescript
private async executeUnifiedStrategy(...): Promise<void> {
  // ... 挂单代码 ...

  // 修复 4: 存储到两个 key
  const priceData = {
    yesBid: prices.yesBid,
    yesAsk: prices.yesAsk,
    noBid: prices.noBid,
    noAsk: prices.noAsk,
    timestamp: Date.now(),
  };

  this.lastPlacedPrices.set(yesTokenId, priceData);
  this.lastPlacedPrices.set(noTokenId, priceData);
}

// monitorTierOneStatus 保持不变，因为现在会同时为 YES 和 NO token_id 调用
```

### 修复 5: executeMarketBuy/executeMarketSell - 正确构建 market 对象

```typescript
private async executeMarketBuy(
  market: Market,
  token: 'YES' | 'NO',
  shares: number,
  targetTokenId?: string
): Promise<void> {
  if (!targetTokenId || targetTokenId === market.token_id) {
    // 无需转换
    targetTokenId = market.token_id;
  }

  // 修复 5: 从 outcomes 数组构建正确的 market 对象
  let actualMarket = market;
  if (targetTokenId && targetTokenId !== market.token_id) {
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    // 确定这是哪个 outcome
    const isYes = targetTokenId === yesTokenId;

    // 构建新的 market 对象
    actualMarket = {
      ...market,
      token_id: targetTokenId,
      outcome: isYes ? 'YES' : 'NO',
    };
  }

  // 使用 actualMarket 获取订单簿和执行
  const orderbook = await this.api.getOrderbook(actualMarket.token_id);
  // ... 其余代码
}
```

## 需要修改的方法

1. `executeUnifiedStrategy` - 添加 position 聚合 + 获取两个订单簿
2. `executeUnifiedStrategy` - 修复 lastPlacedPrices 存储两个 key
3. `monitorTierOneStatus` - 保持不变（现在会正确工作）
4. `executeMarketBuy` - 修复 market 对象构建
5. `executeMarketSell` - 修复 market 对象构建
6. `handleUnifiedOrderFill` - 使用聚合 position

## 注意事项

- position 聚合是关键：YES token 持仓存储在 YES token_id 下，NO token 持仓存储在 NO token_id 下
- 需要同时查询两个 position 并合并
- 订单簿也应该分别获取
- lastPlacedPrices 需要同时存储到两个 key
