# 🔧 Phase 1 模块集成指南

## 📌 概述

本指南说明如何将 Phase 1 的5个核心模块集成到现有的 `market-maker.ts` 中。

## ✅ 已创建的模块

1. ✅ `src/analysis/volatility-estimator.ts` - 波动率估算器
2. ✅ `src/analysis/order-flow-estimator.ts` - 订单流估算器
3. ✅ `src/analysis/inventory-classifier.ts` - 库存分类器
4. ✅ `src/analysis/mean-reversion-predictor.ts` - 均值回归预测器
5. ✅ `src/pricing/dynamic-as-model.ts` - 动态AS模型

---

## 🔗 集成步骤

### Step 1: 在 market-maker.ts 中导入新模块

在文件顶部添加导入:

```typescript
// 导入新模块
import {
  VolatilityEstimator,
  OrderFlowEstimator,
  InventoryClassifier,
  InventoryState,
  MeanReversionPredictor
} from './analysis/types.js';

import {
  DynamicASModel
} from './pricing/types.js';
```

---

### Step 2: 在 MarketMaker 类中添加新字段

在构造函数之前添加字段声明:

```typescript
export class MarketMaker {
  // ... 现有字段 ...

  // ===== 新增字段 =====
  private volatilityEstimator: VolatilityEstimator;
  private orderFlowEstimator: OrderFlowEstimator;
  private inventoryClassifier: InventoryClassifier;
  private reversionPredictor: MeanReversionPredictor;
  private asModel: DynamicASModel;

  // 为每个市场维护独立的估算器
  private perMarketVolatility: Map<string, VolatilityEstimator> = new Map();
  private perMarketOrderFlow: Map<string, OrderFlowEstimator> = new Map();
  private perMarketReversion: Map<string, MeanReversionPredictor> = new Map();

  // ... 其他字段 ...
}
```

---

### Step 3: 在构造函数中初始化新模块

```typescript
constructor(api: MakerApi, config: Config, orderManagerFactory?: () => Promise<MakerOrderManager>) {
  this.api = api;
  this.config = config;
  this.orderManagerFactory = orderManagerFactory;

  // ===== 初始化新模块 =====
  this.volatilityEstimator = new VolatilityEstimator();
  this.orderFlowEstimator = new OrderFlowEstimator();
  this.inventoryClassifier = new InventoryClassifier({
    safeThreshold: 0.3,      // 30% 以下安全
    warningThreshold: 0.5,   // 30-50% 警告
    dangerThreshold: 0.7,    // 50-70% 危险
    enableAsymSpread: true   // 启用不对称价差
  });
  this.reversionPredictor = new MeanReversionPredictor();
  this.asModel = new DynamicASModel({
    gamma: 0.1,    // 风险厌恶系数
    lambda: 1.0,   // 订单到达速率
    kappa: 1.5,    // 价格弹性
    alpha: 0.5,    // 库存影响
    beta: 0.3,     // 波动率影响
    delta: 0.2     // 订单流影响
  });

  // ... 现有初始化代码 ...
}
```

---

### Step 4: 在价格更新时记录数据

找到 `updateState` 或类似的方法, 在更新价格时记录数据:

```typescript
async updateState(makerAddress: string): Promise<void> {
  // ... 现有代码 ...

  // 为每个活跃市场更新波动率估算器
  for (const [tokenId, market] of this.activeMarkets) {
    // 获取最新价格
    const currentPrice = orderbook?.mid_price;
    if (currentPrice) {
      // 更新波动率
      const estimator = this.getOrCreateVolatilityEstimator(tokenId);
      estimator.updatePrice(currentPrice);
    }

    // 更新库存预测器
    const position = this.positions.get(tokenId);
    if (position) {
      const netShares = position.yes_amount - position.no_amount;
      const maxPos = this.getEffectiveMaxPosition();
      const predictor = this.getOrCreateReversionPredictor(tokenId);
      predictor.recordInventory(tokenId, netShares, maxPos);
    }
  }
}

// 辅助方法: 获取或创建波动率估算器
private getOrCreateVolatilityEstimator(tokenId: string): VolatilityEstimator {
  if (!this.perMarketVolatility.has(tokenId)) {
    this.perMarketVolatility.set(tokenId, new VolatilityEstimator());
  }
  return this.perMarketVolatility.get(tokenId)!;
}

// 辅助方法: 获取或创建订单流估算器
private getOrCreateOrderFlowEstimator(tokenId: string): OrderFlowEstimator {
  if (!this.perMarketOrderFlow.has(tokenId)) {
    this.perMarketOrderFlow.set(tokenId, new OrderFlowEstimator());
  }
  return this.perMarketOrderFlow.get(tokenId)!;
}

// 辅助方法: 获取或创建回归预测器
private getOrCreateReversionPredictor(tokenId: string): MeanReversionPredictor {
  if (!this.perMarketReversion.has(tokenId)) {
    this.perMarketReversion.set(tokenId, new MeanReversionPredictor());
  }
  return this.perMarketReversion.get(tokenId)!;
}
```

---

### Step 5: 在订单成交时记录订单流

找到处理成交的方法 (通常是 `handleFill` 或类似):

```typescript
private async handleFill(fill: Fill, tokenId: string): Promise<void> {
  // ... 现有代码 ...

  // 记录订单流
  const flowEstimator = this.getOrCreateOrderFlowEstimator(tokenId);
  flowEstimator.recordOrder(
    fill.side,      // 'BUY' or 'SELL'
    fill.usd_amount,
    fill.price,
    fill.timestamp
  );

  // ... 现有代码 ...
}
```

---

### Step 6: 修改报价计算逻辑

找到 `calculateQuotePrices` 或类似的方法, 集成新模型:

```typescript
private calculateQuotePrices(
  market: Market,
  orderbook: Orderbook,
  position?: Position
): QuotePrices {
  // ===== 1. 获取实时数据 =====

  // 当前波动率
  const volatilityEstimator = this.getOrCreateVolatilityEstimator(market.token_id);
  const volatility = volatilityEstimator.getVolatility();

  // 订单流强度
  const flowEstimator = this.getOrCreateOrderFlowEstimator(market.token_id);
  const orderFlow = flowEstimator.getFlowIntensity(1); // 每分钟订单数
  const flowMetrics = flowEstimator.getMetrics(1);

  // 库存偏斜
  const netShares = position ? (position.yes_amount - position.no_amount) : 0;
  const maxPosition = this.getEffectiveMaxPosition();
  const inventoryBias = netShares / maxPosition;

  // 订单簿深度
  const depth = this.calculateDepth(orderbook);

  // ===== 2. 分类库存状态 =====

  const inventoryState = this.inventoryClassifier.classify(
    market.token_id,
    netShares,
    maxPosition
  );

  // 获取状态对应的策略
  const strategy = this.inventoryClassifier.getStrategy(
    inventoryState,
    netShares,
    maxPosition
  );

  // ===== 3. 使用动态 AS 模型计算最优价差 =====

  const marketState = {
    midPrice: orderbook.mid_price,
    inventory: inventoryBias,
    volatility: volatility,
    orderFlow: orderFlow,
    depth: depth,
    flowDirection: flowMetrics.direction
  };

  // 计算最优价差
  const optimalSpread = this.asModel.calculateOptimalSpread(marketState);

  // 应用库存策略的价差倍数
  const adjustedSpread = optimalSpread * strategy.spreadMultiplier;

  // ===== 4. 计算最优买卖价 =====

  const optimalQuotes = this.asModel.calculateOptimalQuotes(
    orderbook.mid_price,
    marketState,
    adjustedSpread
  );

  // ===== 5. 应用库存策略 (单边挂单等) =====

  let bidPrice = optimalQuotes.bidPrice;
  let askPrice = optimalQuotes.askPrice;

  // 单边挂单逻辑
  if (strategy.singleSide === 'BUY') {
    // 只允许买单, 卖单设为极高
    askPrice = Number.MAX_SAFE_INTEGER;
  } else if (strategy.singleSide === 'SELL') {
    // 只允许卖单, 买单设为0
    bidPrice = 0;
  }

  // 不对称价差调整
  if (strategy.asymSpread) {
    const halfSpread = adjustedSpread / 2;
    const buyHalf = halfSpread * strategy.asymSpread.buySpreadMultiplier;
    const sellHalf = halfSpread * strategy.asymSpread.sellSpreadMultiplier;

    bidPrice = orderbook.mid_price * (1 - buyHalf) + optimalQuotes.bidAdjustment;
    askPrice = orderbook.mid_price * (1 + sellHalf) + optimalQuotes.askAdjustment;
  }

  // ===== 6. 返回报价 =====

  return {
    bidPrice: Math.max(0.01, bidPrice),
    askPrice: Math.max(0.01, askPrice),
    midPrice: orderbook.mid_price,
    spread: adjustedSpread,
    pressure: 0, // 可以从订单流计算
    inventoryBias,
    depth,
    volatility,
    profile: this.getMarketProfile(volatility)
  };
}
```

---

### Step 7: 修改订单大小计算

找到计算订单大小的方法, 应用库存策略:

```typescript
private calculateOrderSize(
  market: Market,
  side: 'BUY' | 'SELL',
  inventoryState: InventoryState
): OrderSizeResult {
  const baseSize = this.config.orderSize || 25;
  const strategy = this.inventoryClassifier.getStrategy(inventoryState);

  // 应用库存策略的订单大小倍数
  const adjustedSize = baseSize * strategy.sizeMultiplier;

  // 获取当前价格
  const midPrice = this.lastPrices.get(market.token_id) || 0.5;

  // 计算股数
  const shares = Math.floor(adjustedSize / midPrice);

  return {
    shares,
    usdt: adjustedSize
  };
}
```

---

### Step 8: 添加风险控制逻辑

在主循环中添加库存状态检查:

```typescript
async runMarketMaker(makerAddress: string): Promise<void> {
  for (const [tokenId, market] of this.activeMarkets) {
    // 获取当前持仓
    const position = this.positions.get(tokenId);

    if (position) {
      const netShares = position.yes_amount - position.no_amount;
      const maxPos = this.getEffectiveMaxPosition();

      // 分类库存状态
      const state = this.inventoryClassifier.classify(tokenId, netShares, maxPos);

      // 检查是否需要暂停
      if (this.inventoryClassifier.shouldPauseOrders(state)) {
        console.warn(`⚠️  Pausing orders for ${tokenId}: ${state}`);
        this.pauseUntil.set(tokenId, Date.now() + 5 * 60 * 1000); // 暂停5分钟
        continue;
      }

      // 检查是否需要强制平仓
      if (this.inventoryClassifier.shouldForceFlatten(state)) {
        console.error(`🚨 Critical inventory for ${tokenId}: forcing flatten`);
        await this.forceFlattenPosition(tokenId);
        continue;
      }

      // 检查是否应该警报
      if (this.inventoryClassifier.shouldAlert(state)) {
        const info = this.inventoryClassifier.getInventoryInfo(tokenId, netShares, maxPos);
        console.warn(`⚠️  Inventory alert for ${tokenId}:`, info);
      }

      // 检查回归预测
      const predictor = this.getOrCreateReversionPredictor(tokenId);
      if (predictor.shouldAlert(tokenId, netShares, maxPos, 0.1, 30)) {
        console.warn(`⚠️  Inventory not reverting for ${tokenId} after 30 minutes`);
        // 可以触发主动平仓
      }
    }

    // ... 继续正常做市逻辑 ...
  }
}

// 强制平仓方法
private async forceFlattenPosition(tokenId: string): Promise<void> {
  const position = this.positions.get(tokenId);
  if (!position) return;

  const netShares = position.yes_amount - position.no_amount;
  const midPrice = this.lastPrices.get(tokenId) || 0.5;

  if (netShares > 0) {
    // 持有多头, 需要卖出
    await this.placeMarketOrder(tokenId, 'SELL', Math.abs(netShares), midPrice);
  } else if (netShares < 0) {
    // 持有空头, 需要买入
    await this.placeMarketOrder(tokenId, 'BUY', Math.abs(netShares), midPrice);
  }
}
```

---

### Step 9: 添加 Web Server 监控端点

在 `web-server.ts` 中添加新指标:

```typescript
// 在 /api/metrics 端点中添加
app.get('/api/advanced-metrics', (req, res) => {
  const metrics = {};

  for (const [tokenId, estimator] of marketMaker.perMarketVolatility) {
    metrics[tokenId] = {
      volatility: estimator.getVolatility(),
      volatilityTrend: estimator.getVolatilityTrend(30),
      maxVolatility1h: estimator.getMaxVolatility(60),
      minVolatility1h: estimator.getMinVolatility(60),
      isSpike: estimator.isVolatilitySpike(2.0, 60)
    };
  }

  res.json(metrics);
});

app.get('/api/inventory-status', (req, res) => {
  const statuses = [];

  for (const [tokenId, position] of marketMaker.positions) {
    const netShares = position.yes_amount - position.no_amount;
    const maxPos = marketMaker.getEffectiveMaxPosition();
    const info = marketMaker.inventoryClassifier.getInventoryInfo(tokenId, netShares, maxPos);

    statuses.push({
      tokenId,
      state: info.state,
      description: marketMaker.inventoryClassifier.getStateDescription(info.state),
      netShares,
      inventoryBias: info.inventoryBias,
      strategy: marketMaker.inventoryClassifier.getStrategy(info.state, netShares, maxPos)
    });
  }

  res.json(statuses);
});
```

---

### Step 10: Desktop App 集成 (可选)

在 Desktop App 中添加新的监控面板:

```html
<!-- 在 index_simple.html 中添加 -->
<div class="panel" id="advanced-metrics">
  <h3>📊 高级指标</h3>

  <div class="metric-group">
    <h4>波动率监控</h4>
    <div id="volatility-display"></div>
  </div>

  <div class="metric-group">
    <h4>库存状态</h4>
    <div id="inventory-display"></div>
  </div>

  <div class="metric-group">
    <h4>订单流</h4>
    <div id="orderflow-display"></div>
  </div>

  <div class="metric-group">
    <h4>AS 模型参数</h4>
    <div id="as-model-display"></div>
  </div>
</div>
```

```javascript
// 在 renderer.js 中添加
async function updateAdvancedMetrics() {
  const response = await fetch('/api/advanced-metrics');
  const metrics = await response.json();

  // 更新 UI
  // ...
}
```

---

## 🧪 测试清单

### 单元测试

```bash
# 测试各个模块
npm test -- volatility-estimator
npm test -- order-flow-estimator
npm test -- inventory-classifier
npm test -- mean-reversion-predictor
npm test -- dynamic-as-model
```

### 集成测试

1. ✅ 启动系统, 检查是否正常初始化
2. ✅ 观察日志, 确认模块正常工作
3. ✅ 检查 Web Server API 端点
4. ✅ 查看 Desktop App 新面板

### 模拟测试

```bash
SIMULATION_MODE=true npm start
```

运行一段时间, 观察:
- 波动率是否正常更新
- 订单流是否正确记录
- 库存状态是否正确分类
- AS 模型是否正常计算

---

## 📈 性能监控

### 关键指标

1. **波动率估算准确性**
   - 目标: 误差 < 20%
   - 检查: 对比预测波动率与实际波动率

2. **库存分类准确率**
   - 目标: > 85%
   - 检查: 分类是否合理

3. **预测回归时间误差**
   - 目标: < 50%
   - 检查: 预测时间与实际回归时间对比

4. **动态价差稳定性**
   - 目标: 价差不会剧烈跳动
   - 检查: 价差变化曲线

---

## 🎯 下一步

Phase 1 完成后, 继续 Phase 2:

- [ ] 多目标优化器
- [ ] 自适应阈值管理器
- [ ] VaR 风险模型
- [ ] 智能订单管理器

---

**文档版本**: v1.0.0
**创建日期**: 2026-02-25
**适用版本**: Phase 1 基础增强模块
