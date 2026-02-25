# 修复 YES/NO Token ID 问题的方案

## 问题

当前代码使用同一个 `market.token_id` 挂 YES 和 NO 订单，这是错误的。

## 解决方案

### 方案 A: 从 condition_id 计算（推荐）

```typescript
// 在 market-maker.ts 中添加辅助方法
private computeTokenId(conditionId: string, outcome: 'YES' | 'NO'): string {
  try {
    const conditionIdBigInt = BigInt(conditionId);
    // CTF 标准：YES = 1, NO = 0
    const outcomeBit = outcome === 'YES' ? 1 : 0;
    const tokenIdBigInt = (conditionIdBigInt << 1n) | BigInt(outcomeBit);
    return tokenIdBigInt.toString();
  } catch (error) {
    console.error('Error computing token ID:', error);
    return '';
  }
}

// 修改 executeUnifiedStrategy
private async executeUnifiedStrategy(
  market: Market,
  orderbook: Orderbook,
  position: Position,
  analysis: any
): Promise<void> {
  // ... 现有代码 ...

  // 计算对应的 token_id
  const yesTokenId = market.token_id; // 当前市场的 token_id
  const noTokenId = this.computeTokenId(market.condition_id || '', 'NO');

  if (!noTokenId) {
    console.error('Cannot compute NO token_id from condition_id');
    return;
  }

  // 分别挂 YES 订单
  if (analysis.shouldPlaceBuyOrders && buyOrderSize > 0) {
    if (prices.yesBid > 0) {
      await this.placeLimitOrderWithToken(market, 'BUY', 'YES', yesTokenId, prices.yesBid, buyOrderSize, 0.02);
    }
    if (prices.noBid > 0) {
      await this.placeLimitOrderWithToken(market, 'BUY', 'NO', noTokenId, prices.noBid, buyOrderSize, 0.02);
    }
  }

  // 分别挂 NO 订单
  if (analysis.shouldPlaceSellOrders && sellOrderSize > 0) {
    if (prices.yesAsk > 0 && position.yes_amount > 0) {
      await this.placeLimitOrderWithToken(market, 'SELL', 'YES', yesTokenId, prices.yesAsk, sellOrderSize, 0.02);
    }
    if (prices.noAsk > 0 && position.no_amount > 0) {
      await this.placeLimitOrderWithToken(market, 'SELL', 'NO', noTokenId, prices.noAsk, sellOrderSize, 0.02);
    }
  }
}

// 添加新方法
private async placeLimitOrderWithToken(
  market: Market,
  side: 'BUY' | 'SELL',
  outcome: 'YES' | 'NO',
  tokenId: string,
  price: number,
  shares: number,
  currentSpread?: number
): Promise<void> {
  console.log(`📝 挂 ${outcome} ${side} 单: ${shares} @ $${price} (token_id: ${tokenId.slice(0, 8)}...)`);

  // 临时创建一个修改了 token_id 的 market 对象
  const marketForOrder = { ...market, token_id: tokenId };

  // 调用原来的 placeLimitOrder
  await this.placeLimitOrder(marketForOrder, side, price, shares, currentSpread);
}
```

### 方案 B: 从 token_id 推导（如果 condition_id 不可用）

```typescript
private flipTokenId(tokenId: string): string {
  const tokenIdBigInt = BigInt(tokenId);
  // 翻转最后一位（outcome bit）
  return (tokenIdBigInt ^ 1n).toString();
}

private async executeUnifiedStrategy(...) {
  // ... 现有代码 ...

  const currentTokenId = market.token_id;
  const oppositeTokenId = this.flipTokenId(currentTokenId);

  // 判断当前是 YES 还是 NO
  const currentOutcome = market.outcome || 'YES';

  if (currentOutcome === 'YES') {
    // 当前是 YES，需要计算 NO
    await this.placeLimitOrderWithToken(market, 'BUY', 'YES', currentTokenId, prices.yesBid, ...);
    await this.placeLimitOrderWithToken(market, 'BUY', 'NO', oppositeTokenId, prices.noBid, ...);
  } else {
    // 当前是 NO，需要计算 YES
    await this.placeLimitOrderWithToken(market, 'BUY', 'YES', oppositeTokenId, prices.yesBid, ...);
    await this.placeLimitOrderWithToken(market, 'BUY', 'NO', currentTokenId, prices.noBid, ...);
  }
}
```

---

## 需要验证的假设

1. **Predict.fun 的 token_id 计算方式**
   - 查看 token_id 和 condition_id 的关系
   - 确认 outcome bit 的位置

2. **Market 对象的含义**
   - 一个 Market 对象是代表一个 outcome，还是整个市场？
   - 如果是一个 outcome，那另一个 outcome 的数据在哪里？

3. **现有代码是否可用**
   - 检查现有订单和持仓的 token_id
   - 确认当前代码是否真的在工作

---

## 建议

在修复之前，**暂时不要使用统一策略**，或者：
1. 只使用单 outcome 的交易（只做 YES 或只做 NO）
2. 等待确认 token_id 计算方式后再修复
3. 检查现有代码是否也有这个问题
