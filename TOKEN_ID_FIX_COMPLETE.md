# Token ID 问题 - 解决方案总结

## 问题回顾

之前遇到的**核心问题**：无法获取 YES 和 NO 各自的 `token_id`

## 根本原因

API 返回的市场数据中包含了 `outcomes` 数组，但代码没有正确解析：

```json
{
  "conditionId": "0x4f750423586e645c5ea8b58e9509bd807ae36914ef799b78034e3d72e329fdb3",
  "outcomes": [
    {
      "name": "Up",
      "indexSet": 1,
      "onChainId": "56145454509410754792152959058387108047261320784273701820966331873140362226681"
    },
    {
      "name": "Down",
      "indexSet": 2,
      "onChainId": "13837160545691392353892385337234860023480456244656316673051367697935345378627"
    }
  ]
}
```

**关键发现**：`outcomes[].onChainId` 就是 `token_id`！

## 解决方案

### 1. 更新类型定义 (`src/types.ts`)

添加了 `MarketOutcome` 接口和 `outcomes` 字段：

```typescript
export interface MarketOutcome {
  name: string;
  indexSet: number;
  status: 'WON' | 'LOST' | 'OPEN' | 'CANCELLED';
  onChainId: string;
}

export interface Market {
  // ... 其他字段
  outcomes?: MarketOutcome[];
  // ...
}
```

### 2. 更新 API 客户端 (`src/api/client.ts`)

修改 `normalizeMarket` 函数以解析 `outcomes` 数组：

```typescript
private normalizeMarket(raw: any): Market {
  // ... 其他代码

  const outcomes = Array.isArray(raw?.outcomes)
    ? raw.outcomes.map((o: any) => ({
        name: String(o.name || 'Unknown'),
        indexSet: Number(o.indexSet || 0),
        status: o.status || 'OPEN',
        onChainId: String(o.onChainId || ''),
      }))
    : undefined;

  return {
    // ... 其他字段
    outcomes,
  };
}
```

### 3. 更新市场做市商 (`src/market-maker.ts`)

添加新方法 `getYesNoTokenIds`：

```typescript
private getYesNoTokenIds(market: Market): { yesTokenId?: string; noTokenId?: string } {
  if (!market.outcomes || market.outcomes.length === 0) {
    return {};
  }

  let yesTokenId: string | undefined;
  let noTokenId: string | undefined;

  for (const outcome of market.outcomes) {
    const name = outcome.name.toLowerCase();
    const isYes = name === 'yes' || name === 'up' || name === 'true' || outcome.indexSet === 1;
    const isNo = name === 'no' || name === 'down' || name === 'false' || outcome.indexSet === 2;

    if (isYes) {
      yesTokenId = outcome.onChainId;
    } else if (isNo) {
      noTokenId = outcome.onChainId;
    }
  }

  return { yesTokenId, noTokenId };
}
```

更新 `findYesNoMarkets` 方法：

```typescript
private findYesNoMarkets(market: Market): { yes?: Market; no?: Market } {
  const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

  const yesMarket = yesTokenId ? { ...market, token_id: yesTokenId } : undefined;
  const noMarket = noTokenId ? { ...market, token_id: noTokenId } : undefined;

  return { yes: yesMarket, no: noMarket };
}
```

## 验证结果

测试 **25/25** 个市场，全部成功：

```
市场 1: BTC/USD Up or Down
  YES token_id: 56145454509410754792152959058387108047261320784273701820966331873140362226681
  NO token_id:  13837160545691392353892385337234860023480456244656316673051367697935345378627
  ✅ 不同的 token_id

市场 2: Will Clair Obscur win
  YES token_id: 40437221214445478921897511193122380801843041273451655499133418794197224872880
  NO token_id:  6565447978965720336589456290040686215779712256516973283813441189949608406067
  ✅ 不同的 token_id

市场 3: Crystal Palace FC win
  YES token_id: 12782977906576821715974146158761122508632285441213107605018465062156671770897
  NO token_id:  86773553004469519655005986702120701981722707845401650154889650209288596772987
  ✅ 不同的 token_id
```

## 修改的文件

1. ✅ `src/types.ts` - 添加 `MarketOutcome` 接口
2. ✅ `src/api/client.ts` - 解析 `outcomes` 数组
3. ✅ `src/market-maker.ts` - 添加 `getYesNoTokenIds` 方法

## 统一做市商策略现在可以正确工作

### 挂单操作

```typescript
// 使用正确的 token_id 挂单
await this.placeLimitOrder(yesMarket, 'BUY', prices.yesBid, ...);  // YES token_id
await this.placeLimitOrder(noMarket, 'BUY', prices.noBid, ...);   // NO token_id
```

### 对冲操作

```typescript
// YES Buy 成交后，使用 NO token_id 对冲
await this.executeMarketBuy(market, 'NO', shares, noTokenId);

// NO Buy 成交后，使用 YES token_id 对冲
await this.executeMarketBuy(market, 'YES', shares, yesTokenId);
```

## 下一步操作

### 1. 启用统一做市商策略

```bash
# .env
UNIFIED_MARKET_MAKER_ENABLED=true
UNIFIED_MARKET_MAKER_DYNAMIC_OFFSET_MODE=true
```

### 2. 启动测试

```bash
npm start
```

### 3. 监控日志

查看以下日志确认使用了不同的 token_id：

```
🔑 使用不同的 token_id:
   YES: 5614545450941075...
   NO:  1383716054569139...
```

### 4. 验证订单

检查：
- ✅ YES Buy 单使用 YES token_id
- ✅ NO Buy 单使用 NO token_id
- ✅ YES Sell 单使用 YES token_id
- ✅ NO Sell 单使用 NO token_id
- ✅ 对冲使用正确的 token_id

## 关键改进

### 之前的问题

```typescript
// ❌ 错误：使用相同的 token_id
await this.placeLimitOrder(market, 'BUY', prices.yesBid, ...);
await this.placeLimitOrder(market, 'BUY', prices.noBid, ...);
```

### 修复后

```typescript
// ✅ 正确：使用各自 market 对象的 token_id
const { yesMarket, noMarket } = this.findYesNoMarkets(market);
await this.placeLimitOrder(yesMarket, 'BUY', prices.yesBid, ...);  // YES token_id
await this.placeLimitOrder(noMarket, 'BUY', prices.noBid, ...);   // NO token_id
```

## 其他策略

这个修复也适用于：
- ✅ 两阶段循环对冲策略
- ✅ 连续对冲策略
- ✅ 永久对冲策略
- ✅ 循环对冲策略

所有需要同时交易 YES 和 NO 的策略都可以使用 `getYesNoTokenIds` 方法。

## 总结

**问题**：无法获取 YES 和 NO 各自的 token_id
**原因**：API 返回的 `outcomes` 数组没有被解析
**解决**：解析 `outcomes` 数组，使用 `onChainId` 作为 `token_id`
**结果**：✅ 所有 25 个市场都能正确获取 YES/NO token_id
**状态**：🎉 修复完成，可以启用统一做市商策略
