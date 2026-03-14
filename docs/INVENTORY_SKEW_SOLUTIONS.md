# ⚠️ 库存持续偏移处理指南

## 📌 问题：库存持续偏移无法回归中性

### 典型场景

```
初始状态：
- 库存：0股（中性）
- 报价：买 $0.49 / 卖 $0.51

⚠️ 连续成交：
T+0: 卖单成交 → 持有 -100股（空头）
T+1: 继续卖出 → 持有 -200股（更空头）
T+2: 仍然卖出 → 持有 -300股（极度空头）
T+3: 继续成交 → 持有 -400股（接近上限）
T+4: 继续成交 → 持有 -500股（达到MAX_POSITION！）

❌ 系统响应：
- 新订单大小 = 0（无法挂单）
- 无法继续调整报价
- 资金占用，风险暴露
```

---

## 🔍 **原因分析**

### 为什么会持续偏移？

### 1. **单边行情**（最常见）

**牛市场景**：
```
价格持续上涨 $0.45 → $0.46 → $0.47 → $0.48
- 我们的卖单不断被吃掉
- 持有越来越多空头
- 买价跟不上价格上涨
- 无法回补空头
```

**熊市场景**：
```
价格持续下跌 $0.55 → $0.54 → $0.53 → $0.52
- 我们的买单不断被吃掉
- 持有越来越多多头
- 卖价跟不上价格下跌
- 无法平掉多头
```

---

### 2. **极端市场事件**

**突发事件**：
- 重大新闻发布
- 数据公布（就业、CPI等）
- 社交媒体热议
- 巨鲸大额交易

**影响**：
- 价格剧烈波动
- 单边成交激增
- 库存迅速失衡

---

### 3. **流动性不足**

**市场特征**：
- 订单簿深度浅
- 只有我们的单子在提供流动性
- 缺少对手方交易

**结果**：
- 我们的单子成交，但缺少反向成交
- 库存单向累积

---

### 4. **参数设置不当**

**问题配置**：
```bash
# 价差太小
SPREAD=0.005  # 0.5% 太小

# 库存影响太弱
MM_INVENTORY_SPREAD_WEIGHT=0.05  # 几乎不影响报价

# 订单太大
ORDER_SIZE=100  # 太大
```

**结果**：
- 报价太有吸引力
- 无法平衡库存
- 持续单边成交

---

## 🛡️ **解决方案（7层防护）**

### 🔴 **Level 1: 最大持仓硬限制** ⭐⭐⭐

**原理**：达到上限后**完全停止挂单**

```bash
# 配置
MAX_POSITION=100  # 单市场最大$100持仓
```

**效果**：
```
持仓达到 $100 时：
❌ 新订单大小 = 0
❌ 停止增加风险
✅ 等待价格回归或成交平衡
```

**优点**：
- ✅ 硬性保护，不会超限
- ✅ 简单可靠

**缺点**：
- ❌ 被动等待
- ❌ 可能错过利润机会

---

### 🟡 **Level 2: 库存偏斜增强模式** ⭐⭐⭐⭐

**原理**：提高库存对报价的影响

**配置**：
```bash
# 提高库存影响权重
MM_INVENTORY_SPREAD_WEIGHT=0.4      # 默认0.2 → 0.4
MM_SIZE_INVENTORY_WEIGHT=0.6         # 默认0.4 → 0.6
MM_ASYM_SPREAD_INVENTORY_WEIGHT=0.6  # 默认0.4 → 0.6

# 启用强制定向调整
MM_ASYM_SPREAD_MIN_FACTOR=0.8        # 最小调整系数
MM_ASYM_SPREAD_MAX_FACTOR=2.5        # 最大调整系数
```

**效果**：
```
库存偏斜-50%（空头）时：
- 买价提高更多
- 卖价提高更多
- 买单更大
- 卖单更小
→ 更强地吸引买入，快速回补
```

**优点**：
- ✅ 主动平衡
- ✅ 加速回归中性
- ✅ 可调节强度

**缺点**：
- ❌ 可能牺牲一些利润
- ❌ 在极端行情仍可能失效

---

### 🟢 **Level 3: 单边挂单模式** ⭐⭐⭐

**原理**：只挂有助于回归的订单

**代码逻辑**：
```javascript
// 当库存极度偏斜时
if (inventoryBias < -0.5) {
  // 只挂买单，不挂卖单
  askPrice = null;  // 取消卖单
  bidSize *= 2;     // 买单加倍
} else if (inventoryBias > 0.5) {
  // 只挂卖单，不挂买单
  bidPrice = null;  // 取消买单
  askSize *= 2;     // 卖单加倍
}
```

**配置**：
```bash
# 启用单边模式阈值
MM_SINGLE_SIDE_THRESHOLD=0.5  # 偏斜50%时启用
```

**效果**：
```
空头-50%时：
- ❌ 不挂卖单（避免继续增加空头）
- ✅ 只挂买单（积极回补空头）
- ✅ 买单加倍（加快回补）
```

---

### 🔵 **Level 4: 强制平仓机制** ⭐⭐⭐⭐

**原理**：使用市价单强制平仓

**触发条件**：
```bash
# 选项 A: 时间限制
MM_POSITION_MAX_TIME_MS=300000  # 5分钟

# 选项 B: 阈值触发
MM_FORCE_FLATTEN_THRESHOLD=0.7  # 偏斜70%时强制平仓
```

**实现**：
```javascript
// 检查持仓时间
if (positionAge > MAX_TIME_MS) {
  await closePosition(tokenId);
  console.log('⚠️ Position age exceeded, force closing...');
}

// 或检查库存阈值
if (inventoryBias > FLATTEN_THRESHOLD) {
  await flattenPosition(tokenId);
  console.log('⚠️ Inventory skew too high, force flattening...');
}
```

**优点**：
- ✅ 主动控制风险
- ✅ 防止长期偏斜
- ✅ 可以设置时间或阈值

**缺点**：
- ❌ 可能亏损（市价单滑点）
- ❌ 手续费成本
- ❌ 需要权衡触发条件

---

### 🟠 **Level 5: 安全模式触发** ⭐⭐⭐

**原理**：检测到异常情况时进入保守模式

**触发条件**：
```bash
# 启用自动安全模式
MM_SAFE_MODE_ENABLED=true

# 触发阈值
MM_SAFE_MODE_VOLATILITY_THRESHOLD=0.15  # 波动率>15%
MM_SAFE_MODE_DEPTH_SPEED_THRESHOLD=0.5    # 深度变化速度>50%
MM_SAFE_MODE_INVENTORY_THRESHOLD=0.6     # 库存偏斜>60%
```

**效果**：
```
安全模式下：
- 价差扩大 1.5x → 减少成交
- 订单大小 × 0.7 → 降低风险
- 只挂一边 → 单向回补
- 或暂停挂单 → 等待稳定
```

**配置**：
```bash
# 安全模式调整
MM_SAFE_MODE_SPREAD_MULT=1.5        # 价差扩大1.5倍
MM_SAFE_MODE_SPREAD_ADD=0.01       # 额外加1%价差
MM_SAFE_MODE_DEPTH_USAGE_MULT=0.5   # 深度使用减半
```

---

### 🟣 **Level 6: 紧急停止/交易暂停** ⭐⭐⭐

**原理**：极端情况下完全停止交易

**触发条件**：
```bash
# 每日止损
MAX_DAILY_LOSS=200  # 亏损$200后停止

# 或紧急开关
# 可以在代码中设置紧急停止
```

**实现**：
```javascript
if (sessionPnL < -MAX_DAILY_LOSS) {
  tradingHalted = true;
  tradingHaltAt = Date.now();
  console.log('🛑 Daily loss limit reached, halting trading...');

  // 24小时后自动恢复
  setTimeout(() => {
    tradingHalted = false;
    sessionPnL = 0;
  }, 24 * 60 * 60 * 1000);
}
```

**手动停止**：
```bash
# Desktop App 或命令行
- 点击 "停止做市商" 按钮
- 或 Ctrl+C 终止进程
```

---

### 🟤 **Level 7: 手动干预选项** ⭐⭐

**方法 1: Desktop App 手动操作**

```
1. 打开 Desktop App
2. 查看 "做市指标" 面板
3. 找到持仓偏斜的市场
4. 点击 "刷新状态" 查看最新持仓
5. 必要时点击 "停止做市商"
6. 或调整配置参数
```

**方法 2: 手动市价平仓**

```javascript
// 在代码中调用
await marketMaker.closePosition('0x1234...');
```

**方法 3: 调整参数后重启**

```bash
# 1. 停止做市商
# 2. 修改 .env 配置
MAX_POSITION=50              # 降低最大持仓
MM_INVENTORY_SPREAD_WEIGHT=0.5  # 增强库存影响
SPREAD=0.03                  # 扩大价差

# 3. 重新启动
npm start
```

---

## 📊 **库存监控指标**

### 关键指标

**1. 库存偏斜度**
```javascript
inventoryBias = (yes_amount - no_amount) / maxPosition

// 正常范围：-0.3 ~ +0.3
// 警告范围：-0.5 ~ +0.5
// 危险范围：<-0.7 或 >+0.7
```

**2. 持仓时间**
```javascript
positionAge = currentTime - position.openTime

// 正常：< 10分钟
// 警告：10-30分钟
// 危险：> 30分钟
```

**3. 库存价值**
```javascript
inventoryValue = |yes_amount| × price + |no_amount| × price

// 正常：< 50% MAX_POSITION
// 警告：50-80% MAX_POSITION
// 危险：> 80% MAX_POSITION
```

**4. 库存变化速度**
```javascript
inventoryChangeRate = delta(position) / deltaTime

// 正常：< 10股/分钟
// 警告：10-30股/分钟
// 危险：> 30股/分钟
```

---

## 🎯 **推荐配置（防御性）**

### 配置 A: 保守型（强烈推荐新手）

```bash
# ===== 持仓限制 =====
MAX_POSITION=50                   # 降低最大持仓
MAX_POSITION_TIME_MS=180000      # 3分钟后强制平仓

# ===== 库存管理 =====
MM_INVENTORY_SPREAD_WEIGHT=0.5   # 强库存影响
MM_SIZE_INVENTORY_WEIGHT=0.6      # 强订单调整
MM_ASYM_SPREAD_MAX_FACTOR=2.0    # 限制最大调整

# ===== 单边模式 =====
MM_SINGLE_SIDE_THRESHOLD=0.4     # 40%偏斜时单边
MM_SINGLE_SIDE_SIZE_MULT=2.0     # 单边时订单加倍

# ===== 安全模式 =====
MM_SAFE_MODE_ENABLED=true
MM_SAFE_MODE_INVENTORY_THRESHOLD=0.5  # 50%偏斜触发
MM_SAFE_MODE_SPREAD_MULT=1.5
MM_SAFE_MODE_DEPTH_USAGE_MULT=0.5

# ===== 风险控制 =====
MAX_DAILY_LOSS=100               # 降低每日止损
SIMULATION_MODE=true             # ⚠️ 先测试！
```

---

### 配置 B: 平衡型（推荐）

```bash
# ===== 持仓限制 =====
MAX_POSITION=100                  # 标准持仓
MAX_POSITION_TIME_MS=600000      # 10分钟

# ===== 库存管理 =====
MM_INVENTORY_SPREAD_WEIGHT=0.3   # 中等影响
MM_SIZE_INVENTORY_WEIGHT=0.5
MM_ASYM_SPREAD_MAX_FACTOR=2.2

# ===== 单边模式 =====
MM_SINGLE_SIDE_THRESHOLD=0.6     # 60%偏斜时单边

# ===== 安全模式 =====
MM_SAFE_MODE_ENABLED=true
MM_SAFE_MODE_INVENTORY_THRESHOLD=0.6

# ===== 风险控制 =====
MAX_DAILY_LOSS=200
```

---

### 配置 C: 激进型（高级用户）

```bash
# ===== 持仓限制 =====
MAX_POSITION=200                  # 较高持仓
# MAX_POSITION_TIME_MS=未设置    # 不强制平仓

# ===== 库存管理 =====
MM_INVENTORY_SPREAD_WEIGHT=0.2   # 较弱影响
MM_SIZE_INVENTORY_WEIGHT=0.3

# ===== 强制平仓 =====
MM_FORCE_FLATTEN_ENABLED=true
MM_FORCE_FLATTEN_THRESHOLD=0.7    # 70%偏斜时
MM_FORCE_FLATTEN_SLIPPAGE=250     # 2.5%滑点

# ===== 风险控制 =====
MAX_DAILY_LOSS=300
```

---

## 🔧 **代码改进建议**

### 改进 1: 添加持仓时间跟踪

**文件**: `src/types.ts`

```typescript
export interface Position {
  token_id: string;
  question: string;
  yes_amount: number;
  no_amount: number;
  total_value: number;
  avg_entry_price: number;
  current_price: number;
  pnl: number;
  open_time: number;        // ✅ 新增：开仓时间
  last_fill_time: number;    // ✅ 新增：最后成交时间
}
```

---

### 改进 2: 添加强制平仓逻辑

**文件**: `src/market-maker.ts`

```typescript
// 在主循环中添加
private checkAndForceFlatten(): void {
  const maxPositionTimeMs = this.config.mmPositionMaxTimeMs || 0;
  const flattenThreshold = this.config.mmForceFlattenThreshold || 0.8;

  for (const [tokenId, position] of this.positions) {
    // 检查持仓时间
    if (maxPositionTimeMs > 0 && position.open_time) {
      const age = Date.now() - position.open_time;
      if (age > maxPositionTimeMs) {
        console.warn(`⚠️ Position ${tokenId} age ${(age/1000/60).toFixed(0)}min exceeds limit, force closing...`);
        this.closePosition(tokenId);
        continue;
      }
    }

    // 检查库存偏斜
    const netShares = position.yes_amount - position.no_amount;
    const maxPosition = this.getEffectiveMaxPosition();
    const skew = Math.abs(netShares) / maxPosition;

    if (skew > flattenThreshold) {
      console.warn(`⚠️ Inventory skew ${skew.toFixed(2)} exceeds threshold, force flattening ${tokenId}...`);
      this.flattenPosition(tokenId, netShares);
    }
  }
}
```

---

### 改进 3: 添加单边挂单模式

```typescript
// 在报价逻辑中添加
private canQuoteSide(
  tokenId: string,
  side: 'BUY' | 'SELL',
  inventoryBias: number
): boolean {
  const singleSideThreshold = this.config.mmSingleSideThreshold || 0.6;

  if (side === 'BUY' && inventoryBias > singleSideThreshold) {
    // 多头太多，不挂买单
    return false;
  }

  if (side === 'SELL' && inventoryBias < -singleSideThreshold) {
    // 空头太多，不挂卖单
    return false;
  }

  return true;
}
```

---

## 📋 **监控和诊断**

### 实时监控脚本

**文件**: `scripts/monitor-inventory.js`

```javascript
// 定期检查库存状态
setInterval(() => {
  for (const [tokenId, position] of positions) {
    const net = position.yes_amount - position.no_amount;
    const maxPos = getMaxPosition();
    const skew = Math.abs(net) / maxPos;
    const age = (Date.now() - position.open_time) / 1000 / 60; // 分钟

    console.log(`[${tokenId}] Skew: ${skew.toFixed(2)} Age: ${age.toFixed(1)}min`);

    // 警告
    if (skew > 0.7) {
      console.warn(`⚠️ ${tokenId}: HIGH SKEW ${skew.toFixed(2)}`);
    }

    if (age > 10) {
      console.warn(`⚠️ ${tokenId}: OLD POSITION ${age.toFixed(1)}min`);
    }

    // 建议行动
    if (skew > 0.8 || age > 15) {
      console.error(`🚨 ${tokenId}: FORCE FLATTEN RECOMMENDED`);
      // 可以自动调用 closePosition(tokenId)
    }
  }
}, 30000); // 每30秒检查
```

---

### Desktop App 告警

在 `renderer.js` 中添加库存警告：

```javascript
function checkInventoryAlerts() {
  const metrics = getMarketMetrics();

  for (const market of metrics) {
    const skew = Math.abs(market.inventorySkew);

    if (skew > 0.7) {
      showAlert(
        `⚠️ ${market.question}: 库存偏斜 ${skew.toFixed(1)}%`,
        'warning'
      );
    }

    if (skew > 0.85) {
      showAlert(
        `🚨 ${market.question}: 极度偏斜 ${skew.toFixed(1)}%，建议强制平仓！`,
        'error'
      );
    }
  }
}

setInterval(checkInventoryAlerts, 10000); // 每10秒检查
```

---

## 🎯 **应急处理流程**

### 发现库存持续偏移时的步骤

```
1. 评估严重性
   ↓
2. 查看当前指标
   ↓
3. 选择处理方案
   ↓
4. 执行操作
   ↓
5. 监控效果
```

---

### Step 1: 评估严重性

**轻微偏斜**（30-50%）:
- ✅ 继续运行
- ✅ 监控变化

**中度偏斜**（50-70%）:
- ⚠️ 考虑调整参数
- ⚠️ 准备干预

**严重偏斜**（>70%）:
- 🚨 立即干预
- 🚨 考虑强制平仓

---

### Step 2: 查看当前指标

```bash
# Desktop App 查看：
1. 打开 "做市指标" 面板
2. 查看 "当前持仓" 部分
3. 记录：
   - 各市场持仓数量
   - 库存偏斜度
   - 持仓时间（如果有）
   - 未实现盈亏
```

---

### Step 3: 选择处理方案

| 严重程度 | 方案 | 操作 |
|----------|------|------|
| 轻度（<50%） | A. 继续监控 | 无需操作 |
| 中度（50-70%） | B. 调整参数 | 停止→修改配置→重启 |
| 重度（>70%） | C. 强制平仓 | 停止→市价平仓→重启 |
| 极端（>90%） | D. 紧急停止 | 立即停止所有交易 |

---

### Step 4: 执行操作

**方案 A: 继续监控**
```bash
# 无需操作，系统会自动调整
# 定期检查日志即可
```

**方案 B: 调整参数**
```bash
# 1. 停止做市商
# 点击 Desktop App "停止" 按钮

# 2. 修改 .env
MAX_POSITION=50                    # 降低持仓上限
MM_INVENTORY_SPREAD_WEIGHT=0.6    # 增强库存影响
SPREAD=0.03                        # 扩大价差

# 3. 重新启动
npm start
```

**方案 C: 强制平仓**
```bash
# 选项 1: 在 Desktop App 中
# - 查看问题市场
# - 点击 "刷新状态"
# - 点击 "停止" 按钮停止该市场
# - 系统会尝试市价平仓

# 选项 2: 代码调用（开发者）
# 在控制台调用
await marketMaker.closePosition('0x1234...');

# 选项 3: 手动交易（交易所）
# 直接在交易所网站市价平仓
```

**方案 D: 紧急停止**
```bash
# 立即停止所有交易
# Ctrl+C 或点击 "停止做市商"
```

---

### Step 5: 监控效果

```
操作后持续监控：
1. 库存是否开始回归
2. 持仓价值是否下降
3. 是否出现新的成交
4. 盈亏情况如何

如果10-15分钟后：
- ✅ 库存改善 → 恢复正常运行
- ❌ 继续偏斜 → 考虑再次干预
- ❌ 亏损增加 → 停止交易，分析原因
```

---

## 💡 **预防措施**

### 1. 合理设置参数

```bash
# 不要设置太极端的参数
SPREAD=0.02                        # 不要太小（≥1%）
ORDER_SIZE=25                       # 不要太大（$20-50）
MAX_POSITION=100                    # 不要超过账户的10%
```

### 2. 选择合适的市场

```bash
# 启用积分市场过滤
MM_POINTS_MIN_ONLY=true            # 只做流动性好的市场
MM_POINTS_PRIORITIZE=true          # 优先有积分的市场
MIN_LIQUIDITY=2000                 # 提高流动性要求
```

### 3. 定期检查

```bash
# 每天检查一次
- 查看 Desktop App "做市指标"
- 检查持仓情况
- 检查盈亏
- 检查日志中的警告
```

### 4. 设置止损

```bash
# 每日止损
MAX_DAILY_LOSS=200                 # 自动停止

# 持仓止损（可选，需代码支持）
MAX_POSITION_LOSS_PCT=20          # 持仓亏损20%时强制平仓
```

---

## ❓ **常见问题**

### Q1: 库存偏移是正常的吗？

**A**: ✅ **是的，完全正常！**
- 做市商天然会有库存波动
- 关键是会**自动回归**
- 只要不超过上限就无需担心

### Q2: 多久会回归中性？

**A**: 取决于市场情况：
- **正常市场**：5-15分钟
- **单边市场**：30分钟-2小时
- **极端市场**：可能数小时或需要强制平仓

### Q3: 什么时候应该手动干预？

**A**: 出现以下情况时：
- 库存偏斜 > 70%
- 持仓时间 > 30分钟
- 持续亏损增加
- 出现异常大额成交

### Q4: 强制平仓会亏损吗？

**A**: **可能**，但：
- 小亏损 vs 大风险
- 市价单有滑点（2-3%）
- 长期持仓风险更大
- 两害相权取其轻

### Q5: 可以关闭市场管理器吗？

**A**: 可以，但**不推荐**：
- 可以设置 `MAX_MARKETS=1` 只做一个市场
- 或手动指定 `MARKET_TOKEN_IDS`
- 多市场可以分散风险

---

## 📚 **总结**

### 核心原则

1. **预防优先** - 合理配置避免偏斜
2. **监控及时** - 定期检查库存状态
3. **分级响应** - 轻度监控，中度调整，重度平仓
4. **风险第一** - 宁可少赚，不要爆仓

### 推荐策略

```
正常情况：
✅ 系统自动调整（无需干预）
✅ 库存会在5-15分钟内回归

偏斜持续：
⚠️ 检查指标（偏斜度、时间、盈亏）
⚠️ 考虑调整参数或停止
⚠️ 必要时强制平仓

极端情况：
🚨 立即停止
🚨 评估是否继续
🚨 调整策略或退出
```

### 记住

- ✅ 库存波动是做市商的**常态**
- ✅ 有7层防护机制保护你
- ✅ 大部分情况下系统会自动处理
- ⚠️ 设置合理的止损和上限
- ⚠️ 定期检查和监控
- 🚨 极端情况下果断止损

---

**文档版本**: v1.1.0
**更新日期**: 2026-02-25
