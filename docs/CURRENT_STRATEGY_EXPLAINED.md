# 📊 当前做市商策略完整说明

**日期**: 2026-02-25
**文件**: `src/market-maker.ts`
**策略类型**: 传统第二档挂单做市商 + Phase 1 增强模块

---

## 🎯 核心策略概述

### 基础模式：第二档挂单做市商

**核心思想**：
- 在中间价两侧挂买单和卖单
- 挂在第二档（不是最优价格），避免立即成交
- 赚取价差收益（bid-ask spread）
- 赚取 Predict.fun 积分奖励

---

## 📋 当前实现的策略组件

### 1. 价格计算（calculatePrices）

**输入**：
- 订单簿数据（best_bid, best_ask）
- 市场微观结构（深度、波动率、买卖压力）
- 库存状态（yes_amount, no_amount）

**输出**：
```
QuotePrices {
  bidPrice: number    // 买单价
  askPrice: number    // 卖单价
  spread: number      // 价差
  inventoryBias: number  // 库存偏斜
  // ... 其他指标
}
```

**计算逻辑**：
```
1. 基础价差 = SPREAD (配置)
2. 波动率调整（EWMA）
3. 深度调整
4. 买卖压力调整
5. 库存偏斜调整（Phase 1 增强）
6. 动态 AS 模型（Phase 1 增强）
```

---

### 2. 订单方向控制（suppressBuy/suppressSell）

**当前实现**（Phase 1 增强版）：

```typescript
// 库存状态分类
if (库存偏斜 > 70%) {
  状态: CRITICAL
  操作:
    - suppressBuy = true    // 不挂买单
    - suppressSell = false  // 挂卖单
    - 或者：双边都不挂
}

if (库存偏斜 < -70%) {
  状态: CRITICAL
  操作:
    - suppressBuy = false   // 挂买单
    - suppressSell = true   // 不挂卖单
}

if (-70% <= 库存偏斜 <= 70%) {
  状态: SAFE/WARNING/DANGER
  操作: 双边挂单
}
```

**关键代码**（market-maker.ts:4808-4844）：
```typescript
// Phase 1: 使用 InventoryClassifier 的单边挂单策略
if (this.config.mmEnhancedSpreadEnabled !== false) {
  const inventoryState = this.inventoryClassifier.classify(...);
  const strategy = this.inventoryClassifier.getStrategy(...);

  if (strategy.singleSide === 'BUY') {
    suppressSell = true;  // 只允许买单
  } else if (strategy.singleSide === 'SELL') {
    suppressBuy = true;   // 只允许卖单
  }

  if (!strategy.allowOrders) {
    suppressBuy = true;
    suppressSell = true;  // 暂停挂单
  }
}
```

---

### 3. 订单放置逻辑

**流程**：
```
1. 调用 calculatePrices() 计算价格
2. 检查 suppressBuy/suppressSell 状态
3. 计算订单大小
4. 应用第二档偏移（touchBuffer）
5. 挂买单或卖单（或双边）
```

**第二档挂单策略**：
```
理论价格 = AS 模型计算的最优价格

最终挂单价 = 理论价格 × (1 ± touchBuffer)
  - 买单价 = bidPrice × (1 - touchBuffer)
  - 卖单价 = askPrice × (1 + touchBuffer)

目的：保持在第二档，不穿透市场第一档
```

---

## 🔧 Phase 1 增强模块

### 已集成的 5 个模块

1. **VolatilityEstimator**（波动率估算器）
   - EWMA 算法
   - 实时波动率计算
   - 用于调整价差

2. **OrderFlowEstimator**（订单流估算器）
   - 订单流强度检测
   - 激增检测
   - 买卖方向判断

3. **InventoryClassifier**（库存分类器）
   - 4 级分类：SAFE / WARNING / DANGER / CRITICAL
   - 单边挂单策略
   - 自动风险管理

4. **MeanReversionPredictor**（均值回归预测器）
   - OU 过程模型
   - 预测回归时间
   - 置信度计算

5. **DynamicASModel**（动态 AS 模型）
   - Avellaneda-Stoikov 模型
   - 最优价差计算
   - 考虑库存、波动率、订单流

---

## 📊 当前策略特点

### ✅ 优点

1. **成熟的第二档挂单**
   - 不穿透市场第一档
   - 降低成交概率
   - 赚取价差和积分

2. **智能库存管理**
   - 4 级分类系统
   - 单边挂单机制
   - CRITICAL 状态自动暂停

3. **动态价差调整**
   - 考虑波动率
   - 考虑订单流
   - 考虑库存偏斜

4. **风险控制**
   - Safe Mode（安全模式）
   - Layer Panic（恐慌层）
   - Layer Retreat（撤退层）
   - 紧急恢复机制

### ❌ 局限

1. **没有建立对冲库存**
   - 只挂单赚取价差和积分
   - 被吃单后积累单边头寸
   - 依赖价格回归（但在预测市场中不可靠）

2. **没有主动对冲机制**
   - 有 HEDGE_ON_FILL 配置但未启用
   - 即使启用，也只是平仓，不是建立对冲

3. **没有两阶段循环**
   - 目前只有单一阶段：挂 Sell 单
   - 没有第一阶段（挂 Buy 单建立对冲）
   - 没有第二阶段（持有对冲赚取积分）

---

## 🆕 与新策略的对比

### 当前系统 vs 两阶段循环对冲（V5）

| 维度 | 当前系统 | 两阶段循环对冲（V5） |
|------|---------|---------------------|
| 阶段 | 单一阶段 | 两阶段（买入端 + 卖出端）|
| 初始挂单 | Sell 单 | Buy 单（第一阶段） |
| 被吃单后 | 积累库存 | 立即对冲（1:1） |
| 持有对冲时 | 继续挂 Sell 单 | 挂 Sell 单（第二阶段）|
| 再次被吃 | 继续积累库存 | 立即平仓（回到 0） |
| 循环 | 无 | 自动循环（第一阶段→第二阶段→...）|
| 风险 | 累积单边头寸 | 永远对冲，风险隔离 |
| 收益 | 价差 + 积分 | 积分为主（70-90%）|

---

## 🔧 配置参数（当前系统）

### 基础做市参数
```bash
SPREAD=0.015                      # 基础价差 1.5%
MIN_SPREAD=0.008                  # 最小价差 0.8%
MAX_SPREAD=0.055                   # 最大价差 5.5%
ORDER_SIZE=25                      # 订单大小 $25
MAX_POSITION=100                   # 最大持仓 $100
```

### Phase 1 增强模块
```bash
MM_ENHANCED_SPREAD_ENABLED=true    # 启用增强价差
MM_AS_MODEL_WEIGHT=0.5             # AS 模型权重 50%
MM_INVENTORY_SAFE_THRESHOLD=0.3   # 安全阈值 30%
MM_INVENTORY_WARNING_THRESHOLD=0.5 # 警告阈值 50%
MM_INVENTORY_DANGER_THRESHOLD=0.7  # 危险阈值 70%
```

### 对冲功能（已实现但未启用）
```bash
HEDGE_ON_FILL=false                # 成交后对冲（默认关闭）
HEDGE_MODE=FLATTEN                # 对冲模式
HEDGE_TRIGGER_SHARES=30           # 对冲触发阈值
HEDGE_MAX_SLIPPAGE_BPS=250         # 对冲滑点 2.5%
```

---

## 💡 关键发现

### 当前系统的核心逻辑

```
1. 计算价格（calculatePrices）
2. 检查库存状态
3. 决定挂单方向：
   - 持有多头 YES → suppressBuy = false, suppressSell = true
   - 持有空头 NO → suppressBuy = true, suppressSell = false
   - 库存中性 → 双边挂单
4. 应用第二档偏移
5. 挂单
```

### 缺失的关键部分

```
❌ 没有第一阶段（挂 Buy 单建立对冲）
❌ 没有第二阶段（持有对冲时的特殊处理）
❌ 没有自动循环机制
❌ 对冲功能未启用
```

---

## 🎯 总结

### 当前系统 = 传统第二档做市商 + Phase 1 增强模块

**核心**：
- 挂第二档 Sell 单（赚取价差 + 积分）
- 库存偏斜时单边挂单
- 动态价差调整

**局限**：
- 没有建立对冲库存机制
- 被吃单后积累单边头寸
- 依赖价格回归（预测市场中不可靠）

---

## 🚀 建议升级路径

### 选项 1：启用对冲功能（短期）
```bash
HEDGE_ON_FILL=true
HEDGE_MODE=FLATTEN
```

### 选项 2：集成两阶段循环对冲（中期）
- 集成 `two-phase-hedge-strategy.ts`
- 添加第一阶段：挂 Buy 单建立对冲
- 添加第二阶段：持有对冲时挂 Sell 单赚取积分
- 实现自动循环

### 选项 3：完全重做（长期）
- 基于 V5 策略重新设计
- 实现完整的两阶段循环
- 最优收益和风险控制

---

**需要我详细说明如何将两阶段循环对冲集成到当前系统吗？**
