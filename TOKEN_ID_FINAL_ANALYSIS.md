# Token ID 分析总结与解决方案

## 关键发现

### 1. Token ID 不能通过 condition_id 计算得出

通过分析实际数据发现：
- ❌ 标准 CTF 方式：`token_id ≠ (conditionId << 1) | outcome`
- ❌ NegRisk 方式：`token_id ≠ conditionId | (outcome << 255)`
- ❌ 简单位操作：没有明显的位操作关系

### 2. Token ID 是独立生成的

token_id 可能是：
- 从链上数据直接读取
- 通过预言机或其他方式生成
- 包含了更多元数据（如 collection ID, slot 等）

### 3. Market 对象可能只代表一个 outcome

基于以下观察：
- 市场 API 返回的数据中有 `token_id` 字段
- 没有 `yesTokenId` 或 `noTokenId` 字段
- 这说明一个 Market 对象可能只代表 YES **或** NO

---

## 推测的解决方案

### 方案 A: Market 对象包含 outcome 信息

**假设**：一个 Market 对象代表整个市场，但需要通过某种方式获取 YES/NO 的 token_id。

**实现**：
```typescript
// 检查 Market 对象中是否有隐藏的 token_ids 字段
interface Market {
  token_id: string;
  outcome?: string;  // 'YES' or 'NO'
  token_ids?: {
    YES?: string;
    NO?: string;
  }
}

// 或者在 condition_id 中编码
// 需要查询 API 获取完整的 token 信息
```

### 方案 B: 使用不同的 API endpoint

**假设**：需要通过不同的 endpoint 获取 YES 和 NO 的市场。

**可能的 endpoint**：
- `/v1/markets/{conditionId}/yes` - 获取 YES 市场
- `/v1/markets/{conditionId}/no` - 获取 NO 市场
- `/v1/markets/{conditionId}` - 返回包含两个 outcomes 的数据

### 方案 C: Token ID 中包含 outcome 信息

**假设**：token_id 本身已经编码了 outcome 信息，可以通过某种方式提取。

**需要验证**：
- 检查同一市场的 YES 和 NO 订单的 token_id
- 对比它们的二进制表示
- 找出规律

---

## 需要的信息

要解决这个问题，我需要确认以下信息：

### 1. 获取市场数据时的完整响应

请运行以下代码并分享输出：

```typescript
import { PredictAPI } from './src/api/client.js';
import { loadConfig } from './src/config.js';

async function checkMarketStructure() {
  const config = loadConfig();
  const api = new PredictAPI(
    config.apiBaseUrl,
    config.apiKey,
    config.jwtToken
  );

  const markets = await api.getMarkets();

  if (markets.length > 0) {
    const market = markets[0];
    console.log('完整的市场数据:');
    console.log(JSON.stringify(market, null, 2));
  }
}

checkMarketStructure().catch(console.error);
```

### 2. 获取订单数据

如果你有活跃的账户，请分享：
- YES 订单的 `token_id`
- NO 订单的 `token_id`
- 它们的 `condition_id`

这样我们可以对比找出规律。

### 3. 检查订单簿数据

```typescript
const orderbook = await api.getOrderbook(market.token_id);
console.log('订单簿数据:');
console.log(JSON.stringify(orderbook, null, 2));
```

---

## 临时解决方案

在确认正确的 token_id 获取方式之前：

### 选项 1: 禁用统一策略

```bash
# 在 .env 中设置
UNIFIED_MARKET_MAKER_ENABLED=false
```

### 选项 2: 只交易一个 outcome

修改 `executeUnifiedStrategy`，只挂单一个 outcome：

```typescript
// 只交易 YES
if (market.outcome === 'YES' || market.outcome === undefined) {
  await this.placeLimitOrder(market, 'BUY', prices.yesBid, ...);
  await this.placeLimitOrder(market, 'SELL', prices.yesAsk, ...);
}
```

### 选项 3: 使用两阶段策略（如果它在工作）

检查两阶段策略是否在正常工作，如果是，参考它的实现方式。

---

## 下一步行动

### 立即需要做的

1. **获取完整的市场数据结构**
   - 运行上面的代码
   - 查看是否有隐藏的 token_ids 字段

2. **对比 YES/NO 订单的 token_id**
   - 从持仓或订单中获取
   - 找出它们的规律

3. **检查现有代码是否在正常工作**
   - 如果两阶段策略在工作，参考它的实现
   - 查看它是如何处理 YES/NO token 的

---

## 待确认的问题

- ❓ Market 对象是代表一个 outcome 还是整个市场？
- ❓ 如何获取对应另一个 outcome 的 token_id？
- ❓ 现有代码是否真的在创建 YES 和 NO 订单？
- ❓ API 中是否有专门的字段来区分 YES/NO token？

---

**状态**: ⏳ 等待更多信息
**优先级**: 🔴 高优先级（阻止统一策略使用）
**建议**: 暂时不要使用统一策略，直到确认 token_id 获取方式
