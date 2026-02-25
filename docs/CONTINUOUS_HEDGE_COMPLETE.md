# 🚀 颗粒度对冲策略（双轨并行）- 集成完成

**日期**: 2026-02-25  
**版本**: 双轨并行（升级版）  
**状态**: ✅ 集成完成并测试通过

---

## 📊 核心创新

### 异步对冲逻辑（Asynchronous Hedging）

当你的第二档挂单（比如 Yes）被部分成交了 $q$ 数量：

1. **不撤单**：保留剩余的 $Q - q$ 挂单继续排队，维持积分获取
2. **即时补齐**：程序立刻触发一个市价单，在另一边（No）买入等量的 $q$
3. **状态更新**：此时你拥有了 $q$ 组 1:1 的对冲库存

### 双轨并行操作（Dual Track Parallel）

这时你的账户实际上处于两个状态：

**状态 A（空仓挂单中）**：
- 剩下的 $Q - q$ 的买单继续在第二档守株待兔
- 赚取买入端的积分

**状态 B（持仓挂单中）**：
- 那已经成交并对冲好的 $q$ 组库存
- 立刻去第二档挂 Sell 单
- 开始赚取卖出端的积分

**结果**：最大化积分收益——你同时在"买入端"和"卖出端"都在赚积分！

---

## 🔄 完整工作流程

### 初始状态（空仓）

```
持仓: 0 YES + 0 NO
操作:
  ├─ 轨道 A: 挂 YES Buy + NO Buy（第二档）
  └─ 轨道 B: 不激活（无持仓）
```

### 第一步：YES Buy 单被成交 10 股

```
事件: YES Buy 单被成交 10 股
持仓变成: 10 YES + 0 NO ❌（不对冲）

异步对冲操作:
  ├─ 保留剩余的 YES Buy 单继续排队（不撤单）✅
  └─ 立刻市价买入 10 NO ✅

持仓变成: 10 YES + 10 NO ✅（1:1 对冲）

双轨激活:
  ├─ 轨道 A: 继续挂 YES Buy + NO Buy（赚取买入端积分）✅
  └─ 轨道 B: 挂 YES Sell + NO Sell（赚取卖出端积分）✅
```

### 第二步：双轨并行操作（同时赚积分）

```
轨道 A（空仓挂单）:
  ├─ YES Buy 单: 继续排队等待成交
  ├─ NO Buy 单: 继续排队等待成交
  └─ 收益: 持续赚取买入端积分 ✨

轨道 B（持仓挂单）:
  ├─ YES Sell 单: 基于已对冲的 10 YES + 10 NO
  ├─ NO Sell 单: 基于已对冲的 10 YES + 10 NO
  └─ 收益: 持续赚取卖出端积分 ✨

总收益: 买入端积分 + 卖出端积分 = 最大化积分！🎉
```

### 第三步：继续成交和颗粒度对冲

```
如果 NO Buy 单被成交 5 股:
  ├─ 保留剩余的 NO Buy 单继续排队
  └─ 立刻市价买入 5 YES

持仓变成: 15 YES + 15 NO ✅（仍然 1:1 对冲）
轨道 B 的持仓挂单数量增加到 15 组

如果 YES Sell 单被成交 5 股:
  ├─ 保留剩余的 YES Sell 单继续排队
  └─ 立刻市价买入 5 NO

持仓变成: 20 YES + 20 NO ✅（仍然 1:1 对冲）
轨道 B 的持仓挂单数量调整到 20 组

持续双轨并行操作... ♻️
```

---

## ✅ 核心优势

### 1. 异步对冲逻辑

```
传统对冲（两阶段）:
  成交 → 撤销所有订单 → 对冲 → 重新挂单
  问题: 撤单期间失去积分收益 ❌

异步对冲（颗粒度）:
  成交 → 立刻对冲（不撤单）→ 保留剩余挂单继续赚积分
  优势: 持续赚取积分 ✅
```

### 2. 双轨并行操作

```
两阶段策略（V5）:
  Phase 1: 挂 Buy 单 → 被成交 → 对冲
  Phase 2: 挂 Sell 单 → 被成交 → 平仓
  问题: 两个阶段分离，挂单时间不连续 ❌

颗粒度对冲（双轨）:
  轨道 A: 持续挂 Buy 单（赚取买入端积分）✅
  轨道 B: 持续挂 Sell 单（赚取卖出端积分）✅
  优势: 同时在两端赚取积分 🎉
```

### 3. 恒定价值

```
持有 10 YES + 10 NO 时:

YES=$0.60, NO=$0.40 → 价值 = $10
YES=$0.80, NO=$0.20 → 价值 = $10 ✅
YES=$0.30, NO=$0.70 → 价值 = $10 ✅

关键: YES + NO = 1，恒定价值！
```

### 4. 积分最大化

```
收益来源:
  - 买入端积分: YES Buy + NO Buy 单持续赚取 ✨✨
  - 卖出端积分: YES Sell + NO Sell 单持续赚取 ✨✨
  - 总收益: 买入端 + 卖出端 = 最大化积分！🚀
```

---

## 📊 策略对比

### 两阶段策略（V5） vs 颗粒度对冲（双轨）

| 维度 | 两阶段策略（V5） | 颗粒度对冲（双轨） |
|------|-----------------|-------------------|
| 阶段 | 两阶段分离 | 双轨并行 |
| 挂单方式 | Phase 1 挂 Buy / Phase 2 挂 Sell | 同时挂 Buy + Sell |
| 对冲时机 | 成交后切换阶段 | 成交后立刻对冲（不撤单）|
| 积分收益 | 单阶段（买或卖）| 双阶段（买+卖）✨ |
| 挂单连续性 | 切换时中断 | 持续挂单 ✅ |
| 最优场景 | 趋势市场 | 所有市场 🎯 |

---

## 📁 修改的文件

### 1. `src/strategies/continuous-hedge-strategy.ts`

**新文件**：颗粒度对冲策略模块

**关键功能**：
- `analyze()`: 分析状态并建议操作
- `handleOrderFill()`: 处理订单成交（异步对冲）
- `suggestOrderPrices()`: 建议挂单价格
- `DualTrackState`: 双轨状态管理

**核心代码**：
```typescript
export enum ContinuousHedgeState {
  BALANCED = 'BALANCED',
  YES_HEAVY = 'YES_HEAVY',
  NO_HEAVY = 'NO_HEAVY',
  EMPTY = 'EMPTY',
  DUAL_TRACK = 'DUAL_TRACK',   // 双轨并行状态
}

export interface DualTrackState {
  trackA: {                      // 轨道 A：空仓挂单
    active: boolean;
    pendingBuyOrders: number;
  };
  trackB: {                      // 轨道 B：持仓挂单
    active: boolean;
    hedgedShares: number;        // 已对冲的库存数量
  };
}
```

### 2. `src/market-maker.ts`

**添加的导入**：
```typescript
import {
  ContinuousHedgeStrategy,
  ContinuousHedgeState,
  DualTrackState,
  type ContinuousHedgeConfig,
  type ContinuousHedgeAction
} from './strategies/continuous-hedge-strategy.js';
```

**添加的字段**：
```typescript
private continuousHedgeStrategy: ContinuousHedgeStrategy;
```

**修改的方法**：

**placeMMOrders()** - 优先级检查：
```typescript
// 优先级 1: 颗粒度对冲策略（双轨并行）
if (this.continuousHedgeStrategy.isEnabled()) {
  await this.executeContinuousHedgeDualTrack(market, orderbook, position, analysis);
  return;
}

// 优先级 2: 两阶段循环对冲策略（V5）
if (this.twoPhaseStrategy.isEnabled()) {
  // ... 两阶段逻辑
}
```

**detectAndHedgeFills()** - 订单成交处理：
```typescript
// 优先级 1: 颗粒度对冲策略
if (this.continuousHedgeStrategy.isEnabled()) {
  await this.handleContinuousHedgeOrderFill(market, side, token, filledShares);
  return;
}
```

**新增的方法**：
- `executeContinuousHedgeDualTrack()`: 执行双轨并行挂单
- `handleContinuousHedgeOrderFill()`: 处理颗粒度对冲订单成交

### 3. `src/types.ts`

**添加的配置参数**：
```typescript
// 颗粒度对冲策略（双轨并行）配置
continuousHedgeEnabled?: boolean;
continuousHedgeTolerance?: number;
continuousHedgeMinSize?: number;
continuousHedgeMaxSize?: number;
continuousBuySpreadBps?: number;
continuousSellSpreadBps?: number;
continuousHedgeSlippageBps?: number;
```

### 4. `src/config.ts`

**添加的环境变量读取**：
```typescript
// 颗粒度对冲策略配置（双轨并行）
continuousHedgeEnabled: process.env.CONTINUOUS_HEDGE_ENABLED === 'true',
continuousHedgeTolerance: parseFloat(process.env.CONTINUOUS_HEDGE_TOLERANCE || '0.05'),
continuousHedgeMinSize: parseFloat(process.env.CONTINUOUS_HEDGE_MIN_SIZE || '10'),
continuousHedgeMaxSize: parseFloat(process.env.CONTINUOUS_HEDGE_MAX_SIZE || '500'),
continuousBuySpreadBps: parseInt(process.env.CONTINUOUS_BUY_SPREAD_BPS || '150'),
continuousSellSpreadBps: parseInt(process.env.CONTINUOUS_SELL_SPREAD_BPS || '150'),
continuousHedgeSlippageBps: parseInt(process.env.CONTINUOUS_HEDGE_SLIPPAGE_BPS || '250'),
```

### 5. `.env`

**添加的环境变量**：
```bash
# ==================== 🚀 颗粒度对冲策略配置（双轨并行 - 升级版）====================

CONTINUOUS_HEDGE_ENABLED=false        # 默认关闭，推荐启用！
CONTINUOUS_HEDGE_TOLERANCE=0.05
CONTINUOUS_HEDGE_MIN_SIZE=10
CONTINUOUS_HEDGE_MAX_SIZE=500
CONTINUOUS_BUY_SPREAD_BPS=150
CONTINUOUS_SELL_SPREAD_BPS=150
CONTINUOUS_HEDGE_SLIPPAGE_BPS=250
```

### 6. `src/strategies/index.ts`

**更新的导出**：
```typescript
// 颗粒度对冲策略（双轨并行 - 升级版）⭐⭐⭐⭐⭐
export { ContinuousHedgeStrategy, continuousHedgeStrategy, ContinuousHedgeState, DualTrackState } from './continuous-hedge-strategy.js';
```

### 7. `test-continuous-hedge.ts`

**新文件**：颗粒度对冲策略测试脚本

**测试场景**：
- 场景 1: 空仓状态（双轨并行启动）
- 场景 2: 异步对冲逻辑 - YES Buy 单被成交
- 场景 3: 双轨并行操作（同时赚积分）
- 场景 4: 颗粒度对冲 - NO Sell 单被成交

---

## 🚀 使用指南

### 步骤 1: 启用策略

在 `.env` 文件中设置：
```bash
# 启用颗粒度对冲策略（推荐！）
CONTINUOUS_HEDGE_ENABLED=true

# 模拟模式测试
SIMULATION_MODE=true
```

### 步骤 2: 调整参数（可选）

```bash
CONTINUOUS_HEDGE_TOLERANCE=0.05       # 对冲偏差容忍度
CONTINUOUS_HEDGE_MIN_SIZE=10          # 最小对冲数量
CONTINUOUS_HEDGE_MAX_SIZE=500         # 最大对冲数量
CONTINUOUS_BUY_SPREAD_BPS=150         # Buy 单价差（1.5%）
CONTINUOUS_SELL_SPREAD_BPS=150        # Sell 单价差（1.5%）
CONTINUOUS_HEDGE_SLIPPAGE_BPS=250     # 对冲滑点（2.5%）
```

### 步骤 3: 启动做市商

```bash
npm start
```

### 步骤 4: 观察日志

正常运行日志示例：

```
🔄 颗粒度对冲策略: DUAL_TRACK
   轨道 A（空仓挂单）: ✅
   轨道 B（持仓挂单）: ✅ (10 组已对冲)

💡 挂单价格（双轨并行）:
   YES Buy: $0.5910 | YES Sell: $0.6090
   NO Buy: $0.3940 | NO Sell: $0.4060

📊 轨道 A: 挂 Buy 单（赚取买入端积分）
📊 轨道 B: 挂 Sell 单（赚取卖出端积分，10 组已对冲）
✅ 双轨并行挂单完成（同时在买入端和卖出端赚取积分）

⚡ YES Buy 被成交 10 股
🎯 颗粒度对冲操作: BUY_NO 10 股
🔄 异步对冲：YES 被成交 10，立刻买入 10 NO 恢复平衡（保留剩余挂单继续赚积分）
✅ 颗粒度对冲完成: 买入 10 NO
```

---

## 🎯 策略总结

### 核心创新

1. **异步对冲逻辑**
   - 成交一点 → 立即对冲一点
   - 不撤单：保留剩余挂单继续赚积分
   - 即时补齐：立刻市价买入对面

2. **双轨并行操作**
   - 轨道 A（空仓挂单）: 挂 Buy 单赚积分
   - 轨道 B（持仓挂单）: 挂 Sell 单赚积分
   - 结果：同时在两端赚取积分

3. **恒定价值**
   - YES + NO = 1（恒定价值）
   - 持有 1:1 时价格波动不影响

4. **积分最大化**
   - 买入端：持续赚积分
   - 卖出端：持续赚积分
   - 总收益：两端积分相加！

### 与两阶段策略的区别

```
两阶段（V5）:
  Phase 1: 挂 Buy 单 → 被成交 → 对冲 → Phase 2
  Phase 2: 挂 Sell 单 → 被成交 → 平仓 → Phase 1
  问题: 两个阶段分离，挂单时间不连续

颗粒度对冲（双轨）:
  轨道 A: 持续挂 Buy 单（赚取买入端积分）
  轨道 B: 持续挂 Sell 单（赚取卖出端积分）
  优势: 同时在两端赚取积分！
```

---

## 🎉 最终结论

**颗粒度对冲策略（双轨并行）是最优的积分策略！**

### 为什么是最优？

1. ✅ **异步对冲**：不撤单，持续赚取积分
2. ✅ **双轨并行**：同时在买入端和卖出端赚积分
3. ✅ **恒定价值**：持有 1:1 时风险为零
4. ✅ **积分最大化**：两端积分相加

### 推荐配置

```bash
# 推荐启用颗粒度对冲策略
CONTINUOUS_HEDGE_ENABLED=true
CONTINUOUS_HEDGE_TOLERANCE=0.05
CONTINUOUS_HEDGE_MIN_SIZE=10
CONTINUOUS_HEDGE_MAX_SIZE=500
```

---

## 📚 相关文档

- **策略对比**: `docs/STRATEGY_COMPARISON.md`
- **两阶段策略**: `docs/TWO_PHASE_HEDGE_FINAL.md`
- **当前系统说明**: `docs/CURRENT_STRATEGY_EXPLAINED.md`
- **测试脚本**: `test-continuous-hedge.ts`

---

**🚀 这是最优的积分策略！祝交易顺利，积分满满！** ✨🎉
