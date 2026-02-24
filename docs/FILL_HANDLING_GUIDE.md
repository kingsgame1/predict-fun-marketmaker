# 🔄 做市商成交处理机制详解

## 📌 核心问题：当挂单被吃掉后会发生什么？

做市商的核心角色是**提供流动性**：
- 我们挂出买单（BUY）和卖单（SELL）
- 当市场价格变化时，其他交易者会吃掉我们的订单
- 这会产生**持仓（Position）**，也就是**风险暴露**

---

## 🎯 **成交后的3种处理策略**

### 策略 1: 平仓对冲（Flatten）- 默认模式 ⭐

**原理**：立即在对手方下单，平衡持仓

**示例**：
```
1. 我们的卖单 @ $0.52 被吃掉
   → 我们卖出100股 YES，获得 $52
   → 现在持有：-100股 YES（净空头）

2. 立即执行平仓操作
   → 买入100股 YES @ 当前市价
   → 持仓归零：0股 YES（中性）

3. 结果：
   ✅ 赚取买卖价差（$52 - 买入成本）
   ✅ 无风险暴露
   ❌ 可能亏损手续费
```

**配置**：
```bash
HEDGE_MODE=FLATTEN              # 默认模式
HEDGE_ON_FILL=false            # 默认关闭（简化版）
```

---

### 策略 2: 跨平台对冲（Cross-Platform）- 高级模式

**原理**：在其他平台（Polymarket、Opinion）对冲同一事件

**示例**：
```
1. Predict.fun 卖单 @ $0.52 被吃掉
   → 持有：-100股 YES

2. 在 Polymarket 买入同一事件
   → Polymarket 买入100股 YES @ $0.50
   → 跨平台对冲成功

3. 结果：
   ✅ 锁定价差利润（$0.02 × 100 = $2）
   ✅ 无方向性风险
   ⚠️ 需要多个平台账户
```

**配置**：
```bash
HEDGE_MODE=CROSS                # 跨平台模式
CROSS_PLATFORM_ENABLED=true     # 启用跨平台
CROSS_HEDGE_SIMILARITY_WEIGHT=0.7  # 相似度权重
CROSS_HEDGE_MIN_SIMILARITY=0.78  # 最低相似度要求
```

**注意**：此功能在**简化版中不可用**（需要完整版）

---

### 策略 3: 库存调整（Inventory Skew）- 最常用 ⭐⭐⭐

**原理**：调整后续订单价格，吸引对手方交易自动平衡

**示例**：
```
1. 我们的卖单被吃掉
   → 持有：-100股 YES（空头）
   → inventoryBias < 0（偏空）

2. 系统自动调整报价：
   → 买价提高（吸引别人卖给我们，增加多头）
   → 卖价提高（ discourage 别人买，减少空头）

3. 未来一段时间：
   → 更多买单成交 → 回补空头
   → 自动回到中性持仓
```

**配置**：
```bash
MM_INVENTORY_SPREAD_WEIGHT=0.2  # 库存对价差的影响权重
MM_SIZE_INVENTORY_WEIGHT=0.4     # 库存对订单大小的影响
MM_ASYM_SPREAD_INVENTORY_WEIGHT=0.4  # 不对称价差-库存权重
```

---

## 🔍 **详细处理流程**

### Step 1: 检测成交

**方法 A: WebSocket 实时通知**（推荐）
```javascript
// WebSocket 收到成交通知
ws.on('fill', (fill) => {
  console.log(`📨 Order filled: ${fill.side} ${fill.shares} shares @ ${fill.price}`);
  // 立即处理
});
```

**方法 B: 轮询持仓同步**
```javascript
// 定期调用 API（每3-5秒）
setInterval(async () => {
  const positions = await api.getPositions(address);
  // 检查持仓变化
  if (positionChanged) {
    // 处理成交
  }
}, 3000);
```

---

### Step 2: 计算库存偏斜（Inventory Bias）

**核心公式**：
```javascript
netShares = yes_amount - no_amount
inventoryBias = netShares / maxPosition
```

**实际含义**：
| inventoryBias | 状态 | 说明 | 应对策略 |
|----------------|------|------|----------|
| -1.0 | 极度空头 | 持有最大空头 | ⬆️ 提高买价，降低卖价 |
| -0.5 | 中度空头 | 持有50%空头 | ⬆️ 适度提高买价 |
| 0.0 | 中性 | 无持仓 | ↔️ 正常报价 |
| +0.5 | 中度多头 | 持有50%多头 | ⬇️ 适度降低买价 |
| +1.0 | 极度多头 | 持有最大多头 | ⬇️ 降低买价，提高卖价 |

**代码实现**：
```javascript
private calculateInventoryBias(tokenId: string): number {
  const position = this.positions.get(tokenId);
  if (!position) return 0;

  const netShares = position.yes_amount - position.no_amount;
  const maxPosition = this.getEffectiveMaxPosition();
  const normalized = netShares / maxPosition;

  return clamp(normalized, -1, 1);
}
```

---

### Step 3: 调整报价（Quote Adjustment）

**价格调整公式**：
```javascript
// 买价调整（吸引对手方）
buyPriceAdjustment = -inventoryBias × inventorySpreadWeight

// 卖价调整
sellPriceAdjustment = inventoryBias × inventorySpreadWeight

// 最终报价
adjustedBidPrice = baseMidPrice × (1 - spread/2) + buyPriceAdjustment
adjustedAskPrice = baseMidPrice × (1 + spread/2) + sellPriceAdjustment
```

**实际例子**：
```
基础情况：
- midPrice = $0.50
- spread = 2%
- 基础买价 = $0.49
- 基础卖价 = $0.51

成交后（空头）：
- inventoryBias = -0.4 (持有40%空头)
- inventorySpreadWeight = 0.2

调整后：
- 买价调整 = -(-0.4) × 0.2 = +0.008
- 卖价调整 = -0.4 × 0.2 = -0.008

- 新买价 = $0.49 + $0.008 = $0.498
- 新卖价 = $0.51 - $0.008 = $0.502

结果：
✅ 买价提高 → 更容易成交买单 → 回补空头
✅ 卖价降低 → 更难成交卖单 → 避免增加空头
```

---

### Step 4: 订单大小调整（Size Adjustment）

**原理**：持仓过多时，减少订单大小

**代码**：
```javascript
// 库存对订单大小的影响
sizeFactor = 1 - inventoryBias × sizeInventoryWeight

// 买单大小
buySize = baseOrderSize × sizeFactor

// 卖单大小
sellSize = baseOrderSize × (2 - sizeFactor)
```

**实际例子**：
```
基础情况：
- baseOrderSize = $20
- sizeInventoryWeight = 0.4

成交后（多头，inventoryBias = +0.5）：
- sizeFactor = 1 - 0.5 × 0.4 = 0.8

- 买单大小 = $20 × 0.8 = $16（减少买单）
- 卖单大小 = $20 × (2 - 0.8) = $24（增加卖单）

结果：
✅ 减少买单 → 避免继续增加多头
✅ 增加卖单 → 吸引别人买，减少多头
```

---

### Step 5: 不平衡调整（Imbalance Adjustment）

**原理**：考虑订单簿不平衡，调整报价

**订单簿不平衡定义**：
```javascript
imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)

// bidDepth: 买单总深度
// askDepth: 卖单总深度

// imbalance ∈ [-1, 1]
// -1: 只有卖单（极度供过于求）
//  0: 完全平衡
// +1: 只有买单（极度供不应求）
```

**影响**：
```javascript
// 订单簿不平衡影响
buyPriceAdjustment -= imbalance × imbalanceSpreadWeight
sellPriceAdjustment += imbalance × imbalanceSpreadWeight
```

**实际例子**：
```
订单簿状态：
- bidDepth = 1000股
- askDepth = 500股
- imbalance = (1000 - 500) / (1000 + 500) = +0.33（供不应求）

调整：
- 买价提高 × 0.33 → 避免买入高价
- 卖价提高 × 0.33 → 利用高价卖出
```

---

## ⚙️ **配置参数详解**

### 库存管理参数

```bash
# ===== 库存风险控制 =====

# 库存对价差的影响权重（0-1）
# 0 = 库存不影响价差
# 1 = 库存完全决定价差
MM_INVENTORY_SPREAD_WEIGHT=0.2       # 推荐：0.2-0.4

# 库存对订单大小的影响权重（0-1）
MM_SIZE_INVENTORY_WEIGHT=0.4          # 推荐：0.3-0.5

# 订单簿不平衡对价差的影响权重（0-1）
MM_IMBALANCE_SPREAD_WEIGHT=0.2       # 推荐：0.2-0.3

# 不对称价差-库存权重（买卖单不同）
MM_ASYM_SPREAD_INVENTORY_WEIGHT=0.4   # 推荐：0.3-0.5

# 库存偏斜最小/最大因子
MM_ASYM_SPREAD_MIN_FACTOR=0.6        # 最小调整系数
MM_ASYM_SPREAD_MAX_FACTOR=1.8        # 最大调整系数
```

### 对冲参数

```bash
# ===== 对冲配置 =====

# 对冲模式
HEDGE_MODE=FLATTEN                   # FLATTEN（平仓）或 CROSS（跨平台）

# 成交后对冲
HEDGE_ON_FILL=false                  # 是否立即对冲（简化版默认关闭）

# 最小对冲间隔（毫秒）
MIN_ORDER_INTERVAL_MS=3000           # 对冲冷却时间
```

### 风险限制

```bash
# ===== 风险控制 =====

# 最大持仓（美元）
MAX_POSITION=100                    # 单个市场最大持仓

# 每日最大亏损
MAX_DAILY_LOSS=200                  # 触发后停止交易

# 做市仓位比例
MM_POSITION_SIZE=0.05               # 账户权益的5%
```

---

## 📊 **实际运行示例**

### 场景 1: 买单被吃掉（获得多头）

```
初始状态：
- 挂单：买 $0.49 / 卖 $0.51
- 持仓：0股（中性）

⚡ 成交事件：
- 我们的买单 @ $0.49 被吃掉
- 数量：100股
- 成交额：$49

持仓状态：
- yes_amount = 100
- no_amount = 0
- netShares = 100
- maxPosition = 200股（$100）
- inventoryBias = +0.5（50%多头）

系统自动调整：
1. 计算库存偏斜 → +0.5（多头）
2. 调整报价：
   - 买价降低（避免继续买入）
   - 卖价降低（吸引别人买，减少多头）
3. 调整订单大小：
   - 买单减小
   - 卖单增大

新挂单：
- 买价：$0.488（↓ 降低）
- 卖价：$0.508（↓ 降低）
- 买单大小：$16（↓ 减少）
- 卖单大小：$24（↑ 增加）

预期结果：
- 更可能卖出 → 平掉多头
- 更少买入 → 不增加多头
- 逐渐回归中性持仓
```

---

### 场景 2: 卖单被吃掉（获得空头）

```
初始状态：
- 挂单：买 $0.49 / 卖 $0.51
- 持仓：0股（中性）

⚡ 成交事件：
- 我们的卖单 @ $0.51 被吃掉
- 数量：100股
- 成交额：$51

持仓状态：
- yes_amount = 0
- no_amount = 100
- netShares = -100
- inventoryBias = -0.5（50%空头）

系统自动调整：
1. 计算库存偏斜 → -0.5（空头）
2. 调整报价：
   - 买价提高（吸引别人卖，增加多头）
   - 卖价提高（避免继续卖出）
3. 调整订单大小：
   - 买单增大
   - 卖单减小

新挂单：
- 买价：$0.492（↑ 提高）
- 卖价：$0.512（↑ 提高）
- 买单大小：$24（↑ 增大）
- 卖单大小：$16（↓ 减少）

预期结果：
- 更可能买入 → 平掉空头
- 更少卖出 → 不增加空头
- 逐渐回归中性持仓
```

---

### 场景 3: 极端持仓（达到上限）

```
持仓状态：
- netShares = 200股
- maxPosition = 200股
- inventoryBias = +1.0（100%多头，已达上限）

系统响应：
1. 暂停该市场新挂单
2. 或只允许卖单（不允许买单）
3. 等待价格回归或成交平仓

日志输出：
⚠️  Maximum position reached for token 0x1234...
⚠️  Pausing new orders, allowing only sell-side quotes
```

---

## 🛡️ **风险控制机制**

### 1. 每日亏损限制

```bash
MAX_DAILY_LOSS=200                 # $200亏损后停止
```

**触发后**：
```
❌ Daily loss limit reached: $215.45
🛑 Halting trading...
⏸️  Auto-resume in 24 hours
```

---

### 2. 最大持仓限制

```javascript
if (remainingRiskBudget <= 0) {
  // 停止挂新单
  return { shares: 0, usdt: 0 };
}
```

**实际效果**：
- 持仓达到 MAX_POSITION 时
- 新订单大小 = 0
- 等待成交减少持仓

---

### 3. 安全模式（Safe Mode）

**触发条件**：
- 价格剧烈波动
- 深度急剧变化
- 高频成交

**响应**：
```javascript
if (safeModeActive) {
  spread = spread × 1.5           // 扩大价差
  orderSize = orderSize × 0.7      // 减少订单大小
}
```

---

## 💡 **最佳实践建议**

### 1. 合理设置库存权重

```bash
# 保守策略（风险控制优先）
MM_INVENTORY_SPREAD_WEIGHT=0.3     # 较强影响
MM_SIZE_INVENTORY_WEIGHT=0.5        # 较强影响
MM_IMBALANCE_SPREAD_WEIGHT=0.25     # 适度影响

# 激进策略（获利优先）
MM_INVENTORY_SPREAD_WEIGHT=0.15     # 较弱影响
MM_SIZE_INVENTORY_WEIGHT=0.3        # 较弱影响
MM_IMBALANCE_SPREAD_WEIGHT=0.2      # 较弱影响
```

---

### 2. 监控持仓状态

**关键指标**：
```
📊 做市指标：
- 活跃市场：5
- 订单总数：10
- 符合积分规则：8/10 (80%)
- 积分效率：75%
- 总盈亏：+$12.50
- 成交次数：23

📈 当前持仓：
- 市场1 (0x1234): +50股 YES（多头）
- 市场2 (0x5678): -30股 YES（空头）
- 市场3 (0xabcd): 0股（中性）

库存偏斜：+0.12（轻微多头）
```

---

### 3. 设置合理的止损

```bash
# 每日止损
MAX_DAILY_LOSS=200

# 单笔止损（可选）
MAX_SINGLE_ORDER_LOSS=20          # 单笔最大亏损$20

# 持仓时间限制
MAX_POSITION_TIME_MS=300000       # 5分钟后强制平仓
```

---

### 4. 使用模拟模式测试

```bash
SIMULATION_MODE=true               # 强烈建议先测试
```

**测试步骤**：
1. 启动模拟模式
2. 观察成交处理逻辑
3. 检查持仓变化
4. 验证报价调整
5. 确认风险控制有效
6. 切换到实盘模式

---

## ❓ **常见问题**

### Q1: 成交后立即对冲好还是延迟对冲好？

**A**:
- **立即对冲**：无风险，但可能错过价格波动
- **延迟对冲**（库存调整）：可能获得更好价格，但有风险暴露

**推荐**：使用库存调整（默认），除非风险承受能力很低

---

### Q2: 持仓会无限增大吗？

**A**: 不会。有几个限制：
1. **MAX_POSITION** - 硬性上限
2. **库存调整** - 自动回归中性
3. **风险控制** - 达到上限停止挂单

---

### Q3: 如果价格剧烈波动怎么办？

**A**: 系统会触发**安全模式**：
- 扩大价差（减少成交）
- 减少订单大小
- 或暂停挂单

---

### Q4: 如何查看当前持仓？

**A**: 3种方法：
1. **Desktop App** - "做市指标"面板
2. **日志输出** - 定期显示持仓状态
3. **API查询** - 调用 `getPositions()`

---

### Q5: 成交后多久会重新平衡？

**A**:
- **立即调整报价**（下一个报价周期）
- **通常 3-5 秒**（MIN_ORDER_INTERVAL_MS）
- **逐渐回归**（不是立即归零）

---

## 📚 **总结**

### 核心机制

```
成交发生
   ↓
计算库存偏斜 (inventoryBias)
   ↓
调整报价（价格和大小）
   ↓
吸引对手方交易
   ↓
自动回归中性持仓
```

### 关键参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `MM_INVENTORY_SPREAD_WEIGHT` | 0.2-0.4 | 库存对价差的影响 |
| `MM_SIZE_INVENTORY_WEIGHT` | 0.3-0.5 | 库存对订单大小的影响 |
| `MAX_POSITION` | 账户的5-10% | 单市场最大持仓 |
| `MAX_DAILY_LOSS` | 可承受亏损 | 每日止损线 |

### 优点

✅ **自动化** - 无需手动干预
✅ **风险可控** - 多重安全机制
✅ **自适应** - 动态调整报价
✅ **回归中性** - 长期风险较低

### 注意事项

⚠️ **不是对冲基金** - 不追求完全无风险
⚠️ **短期波动** - 持仓会暂时偏离中性
⚠️ **极端情况** - 黑天鹅事件可能亏损
⚠️ **参数调优** - 需要根据市场调整

---

**文档版本**: v1.1.0
**更新日期**: 2026-02-25
**适用平台**: Predict.fun & Probable
