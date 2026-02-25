# 🚀 Avellaneda-Stoikov + 算法增强实施路线图

## 📊 总体时间规划

- **Phase 1**: 基础增强（1-2周）✅ 可独立使用
- **Phase 2**: 高级功能（2-4周）⭐ 推荐实施
- **Phase 3**: 优化完善（4-8周）🎯 最终目标

---

## 🎯 Phase 1: 基础增强模块（1-2周）✅

### 目标
在现有系统基础上添加核心算法模块，**不影响现有功能**，可以独立使用。

### 新增模块（5个）

#### 1.1 波动率估算器 ⭐⭐⭐⭐⭐
**文件**: `src/analysis/volatility-estimator.ts`

**功能**:
- 实时计算市场波动率 σ
- 使用 EWMA（指数加权移动平均）
- 提供历史波动率查询

**接口**:
```typescript
class VolatilityEstimator {
  // 更新价格历史
  updatePrice(price: number): void

  // 获取当前波动率（年化）
  getVolatility(): number

  // 获取指定时间范围的波动率
  getHistoricalVolatility(minutes: number): number
}
```

---

#### 1.2 订单流估算器 ⭐⭐⭐⭐⭐
**文件**: `src/analysis/order-flow-estimator.ts`

**功能**:
- 统计订单到达速率（λ）
- 检测订单流激增
- 识别订单流模式

**接口**:
```typescript
class OrderFlowEstimator {
  // 记录订单事件
  recordOrder(timestamp: number, side: string): void

  // 获取订单流强度（每分钟订单数）
  getFlowIntensity(): number

  // 检测订单流激增
  detectSurge(threshold: number): boolean
}
```

---

#### 1.3 库存分类器 ⭐⭐⭐⭐⭐
**文件**: `src/analysis/inventory-classifier.ts`

**功能**:
- 将库存状态分类为 4 个等级
- 提供每个等级对应的策略建议
- 支持多市场综合分类

**接口**:
```typescript
enum InventoryState {
  SAFE = 'SAFE',
  WARNING = 'WARNING',
  DANGER = 'DANGER',
  CRITICAL = 'CRITICAL'
}

class InventoryClassifier {
  // 分类单个市场的库存状态
  classify(tokenId: string): InventoryState

  // 获取状态对应的策略配置
  getStrategy(state: InventoryState): StrategyConfig

  // 综合多个市场的库存状态
  classifyGlobal(): InventoryState
}

interface StrategyConfig {
  spreadMultiplier: number;    // 价差倍数
  sizeMultiplier: number;      // 订单大小倍数
  singleSide?: 'BUY' | 'SELL';  // 单边挂单
  allowOrders: boolean;         // 是否允许挂单
  forceFlatten: boolean;       // 是否强制平仓
}
```

---

#### 1.4 均值回归预测器 ⭐⭐⭐⭐
**文件**: `src/analysis/mean-reversion-predictor.ts`

**功能**:
- 使用 Ornstein-Uhlenbeck 过程模型
- 预测库存回归中性所需时间
- 检测异常情况（超时未回归）

**接口**:
```typescript
class MeanReversionPredictor {
  // 预测回归到指定比例所需时间（分钟）
  predictTimeToTarget(
    currentInventory: number,
    targetRatio: number  // 0.1 = 10%
  ): number;

  // 检测是否应该触发警报（超时未回归）
  shouldAlert(tokenId: string): boolean;

  // 更新模型参数
  calibrateModel(historicalData: InventoryHistory[]): void;
}
```

---

#### 1.5 动态 AS 模型 ⭐⭐⭐⭐⭐
**文件**: `src/pricing/dynamic-as-model.ts`

**功能**:
- 实现 Avellaneda-Stoikov 动态价差模型
- 考虑库存、波动率、订单流、竞争
- 输出最优价差建议

**接口**:
```typescript
interface MarketState {
  midPrice: number;
  inventory: number;      // 标准化库存 [-1, 1]
  volatility: number;     // 年化波动率
  orderFlow: number;      // 每分钟订单数
  depth: number;          // 订单簿深度
}

class DynamicASModel {
  // 计算最优价差（百分比）
  calculateOptimalSpread(state: MarketState): number;

  // 计算最优买卖价
  calculateOptimalQuotes(
    midPrice: number,
    state: MarketState
  ): { bidPrice: number; askPrice: number };

  // 实时校准模型参数
  async calibrate(marketData: MarketData[]): Promise<void>;
}
```

---

## 🎯 Phase 2: 高级功能模块（2-4周）⭐

### 新增模块（4个）

#### 2.1 多目标优化器 ⭐⭐⭐⭐
**文件**: `src/optimization/multi-objective-optimizer.ts`

**功能**:
- 同时优化利润、风险、积分三个目标
- 使用帕累托前沿理论
- 动态权重分配

**接口**:
```typescript
interface Objectives {
  profit: number;    // 预期利润
  risk: number;     // 库存风险
  points: number;    // 积分分数
}

class MultiObjectiveOptimizer {
  // 优化报价策略
  optimizeStrategy(
    state: MarketState,
    currentConfig: Config
  ): OptimizedConfig;

  // 计算帕累托前沿分数
  calculateParetoScore(objectives: Objectives): number;
}
```

---

#### 2.2 自适应阈值管理器 ⭐⭐⭐⭐
**文件**: `src/risk/adaptive-threshold.ts`

**功能**:
- 根据市场条件动态调整阈值
- 波动率自适应
- 风险预算动态分配

**接口**:
```typescript
class AdaptiveThresholdManager {
  // 根据波动率调整阈值
  adjustForVolatility(config: Config, volatility: number): Config;

  // 根据订单流调整阈值
  adjustForOrderFlow(config: Config, flowIntensity: number): Config;

  // 获取当前有效阈值
  getEffectiveThresholds(): EffectiveThresholds;
}
```

---

#### 2.3 VaR 风险模型 ⭐⭐⭐⭐
**文件**: `src/risk/var-model.ts`

**功能**:
- 计算 VaR（Value at Risk）
- 计算 CVaR（Conditional VaR）
- 压力测试

**接口**:
```typescript
class VaRModel {
  // 计算 95% 置信度的 VaR
  calculateVaR(
    positions: Position[],
    confidence: number = 0.95
  ): number;

  // 计算条件风险价值（CVaR）
  calculateCVaR(
    positions: Position[],
    confidence: number = 0.95
  ): number;

  // Monte Carlo 模拟
  runMonteCarlo(
    positions: Position[],
    scenarios: number = 10000
  ): MonteCarloResult;
}
```

---

#### 2.4 智能订单管理器 ⭐⭐⭐⭐⭐
**文件**: `src/ordering/smart-order-manager.ts`

**功能**:
- 单边挂单逻辑
- 智能撤单
- 紧急平仓

**接口**:
```typescript
class SmartOrderManager {
  // 决定是否可以挂单（考虑库存状态）
  canQuote(
    state: InventoryState,
    side: 'BUY' | 'SELL'
  ): boolean;

  // 紧急平仓（市价单）
  async emergencyFlatten(tokenId: string): Promise<boolean>;

  // 智能撤单
  async smartCancelOrders(
    reason: 'RISK_HIGH' | 'SIGNAL_CHANGE' | 'MANUAL'
  ): Promise<void>;
}
```

---

## 🎯 Phase 3: 优化完善（4-8周）🎯

### 新增功能（4个）

#### 3.1 回测引擎 ⭐⭐⭐⭐⭐
**文件**: `src/backtesting/backtest-engine.ts`

**功能**:
- 历史数据回测
- 策略A/B测试
- 性能指标计算

---

#### 3.2 机器学习模块（可选）⭐⭐⭐
**文件**: `src/ml/price-predictor.ts`

**功能**:
- LSTM价格预测
- 成交概率预测
- 强化学习优化

---

#### 3.3 配置优化器 ⭐⭐⭐⭐
**文件**: `src/optimization/config-optimizer.ts`

**功能**:
- 自动参数调优
- 网格搜索优化
- 遗传算法优化

---

#### 3.4 实时监控面板 ⭐⭐⭐⭐⭐
**文件**: `desktop-app/renderer/advanced-monitor.html`

**功能**:
- 实时显示新指标
- 图表可视化
- 风险仪表盘

---

## 📁 文件结构

```
src/
├── analysis/              # 新增：分析模块
│   ├── volatility-estimator.ts
│   ├── order-flow-estimator.ts
│   ├── inventory-classifier.ts
│   ├── mean-reversion-predictor.ts
│   └── types.ts
├── pricing/              # 新增：定价模块
│   ├── dynamic-as-model.ts
│   └── types.ts
├── optimization/         # 新增：优化模块
│   ├── multi-objective-optimizer.ts
│   └── types.ts
├── risk/                 # 新增：风险模块
│   ├── var-model.ts
│   └── types.ts
├── ordering/             # 新增：订单管理模块
│   ├── smart-order-manager.ts
│   └── types.ts
└── market-maker.ts       # 现有：主文件（需要集成）
```

---

## 🔄 集成方式

### 现有代码修改

```typescript
// market-maker.ts 中集成新模块

import { VolatilityEstimator } from './analysis/volatility-estimator.js';
import { OrderFlowEstimator } from './analysis/order-flow-estimator.js';
import { InventoryClassifier, InventoryState } from './analysis/inventory-classifier.js';
import { MeanReversionPredictor } from './analysis/mean-reversion-predictor.js';
import { DynamicASModel } from './pricing/dynamic-as-model.js';

export class MarketMaker {
  private volatilityEstimator: VolatilityEstimator;
  private orderFlowEstimator: OrderFlowEstimator;
  private inventoryClassifier: InventoryClassifier;
  private reversionPredictor: MeanReversionPredictor;
  private asModel: DynamicASModel;

  constructor(api: any, config: any, orderManagerFactory: any) {
    // ... 现有代码 ...

    // 新增模块初始化
    this.volatilityEstimator = new VolatilityEstimator();
    this.orderFlowEstimator = new OrderFlowEstimator();
    this.inventoryClassifier = new InventoryClassifier(config);
    this.reversionPredictor = new MeanReversionPredictor();
    this.asModel = new DynamicASModel(config);
  }

  // 在报价逻辑中集成新模型
  async calculateQuotes(market: Market, orderbook: Orderbook) {
    // 1. 获取实时数据
    const volatility = this.volatilityEstimator.getVolatility();
    const orderFlow = this.orderFlowEstimator.getFlowIntensity();
    const inventory = this.calculateInventoryBias(market.token_id);

    // 2. 分类库存状态
    const state = this.inventoryClassifier.classify(market.token_id);

    // 3. 使用动态 AS 模型计算价差
    const marketState = {
      midPrice: orderbook.mid_price,
      inventory: inventory / this.getEffectiveMaxPosition(),
      volatility,
      orderFlow,
      depth: this.getDepth(orderbook)
    };

    const optimalSpread = this.asModel.calculateOptimalSpread(marketState);

    // 4. 根据库存状态调整策略
    const strategy = this.inventoryClassifier.getStrategy(state);

    // 5. 应用策略
    return this.applyStrategy(market, optimalSpread, strategy);
  }
}
```

---

## 🧪 测试方案

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
```bash
# 测试完整流程
npm run test:integration

# 回测
npm run backtest --strategy current --days 30
npm run backtest --strategy enhanced --days 30
```

### 模拟测试
```bash
# 在模拟模式下测试所有新功能
SIMULATION_MODE=true npm start
```

---

## 📈 性能指标

### 成功标准（Phase 1）

- ✅ 新模块不影响现有功能
- ✅ 波动率估算误差 < 20%
- ✅ 库存分类准确率 > 85%
- ✅ 预测回归时间误差 < 50%
- ✅ 动态价差计算稳定

### 成功标准（Phase 2）

- ✅ 多目标优化帕累托提升 > 15%
- ✅ VaR 预测准确率 > 80%
- ✅ 自适应阈值响应时间 < 1秒
- ✅ 紧急平仓成功率 > 95%

### 成功标准（Phase 3）

- ✅ 回测夏普比率 > 2.0
- ✅ 模拟测试利润提升 > 20%
- ✅ 实盘测试稳定运行 1 个月

---

## 📅 第1周任务

### Day 1-2: 项目设置
- [ ] 创建新模块目录结构
- [ ] 添加类型定义
- [ ] 编写基础类框架

### Day 3-4: 核心算法
- [ ] 波动率估算器
- [ ] 订单流估算器
- [ ] 单元测试

### Day 5-7: 集成测试
- [ ] 库存分类器
- [ ] 回归预测器
- [ ] 动态 AS 模型
- [ ] 集成测试

---

## ✅ Phase 1 实施完成 (2026-02-25)

### 已创建的文件

1. ✅ `src/analysis/volatility-estimator.ts` - 波动率估算器 (EWMA)
2. ✅ `src/analysis/order-flow-estimator.ts` - 订单流估算器
3. ✅ `src/analysis/inventory-classifier.ts` - 库存分类器 (4状态)
4. ✅ `src/analysis/mean-reversion-predictor.ts` - 均值回归预测器 (OU过程)
5. ✅ `src/pricing/dynamic-as-model.ts` - 动态AS模型 (Avellaneda-Stoikov)
6. ✅ `src/analysis/types.ts` - 分析模块类型导出
7. ✅ `src/pricing/types.ts` - 定价模块类型导出
8. ✅ `test-phase1-modules.ts` - 完整测试脚本
9. ✅ `docs/INTEGRATION_GUIDE.md` - 详细集成指南

### 测试结果

```
🧪 开始测试 Phase 1 模块...

✅ 波动率估算器 - 通过
   - EWMA 算法正常工作
   - 波动率趋势检测正常
   - 历史波动率查询正常

✅ 订单流估算器 - 通过
   - 订单流强度计算正常
   - 买方/卖方比例计算正常
   - 激增检测正常

✅ 库存分类器 - 通过
   - 4状态分类准确 (SAFE/WARNING/DANGER/CRITICAL)
   - 策略配置合理
   - 不对称价差正常

✅ 均值回归预测器 - 通过
   - OU 过程模型正常
   - 回归时间预测正常
   - 模型校准正常

✅ 动态 AS 模型 - 通过
   - AS 核心公式正确
   - 多因素调整正常
   - 最优报价计算准确

🎉 所有测试完成!
```

### 下一步

按照 `docs/INTEGRATION_GUIDE.md` 中的步骤，将模块集成到 `market-maker.ts` 中。
