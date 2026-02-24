# 📊 做市商市场选择机制详解

## 🤖 自动化程度

**是的，做市商脚本 100% 自动选择市场！**

你**不需要手动指定**市场，脚本会自动：
1. 扫描所有可用市场
2. 根据多维度标准评分
3. 选择最合适的市场进行做市

---

## 🎯 市场选择标准（5大维度）

### 1️⃣ **流动性积分激活** (权重最高，+50分) ⭐⭐⭐

**这是最重要的因素！**

```javascript
if (market.liquidity_activation?.active) {
  score += 50;  // 直接加50分！
}
```

**为什么重要**：
- ✅ 有积分奖励 = 额外收益
- ✅ 活跃的流动性活动 = 更多交易机会
- ✅ Predict 官方推荐 = 更安全

**实际含义**：
- 如果市场有 `liquidity_activation` 标记
- 会显示：`✨ Active Liquidity Points!`
- 立即获得 50 分加成（几乎保证被选中）

---

### 2️⃣ **24小时流动性** (0-40分)

**评分标准**：
```javascript
liquidityScore = Math.min(40, (liquidity / minLiquidity) * 20)
```

**过滤条件**：
- ❌ 如果 `liquidity < $1000` → **直接拒绝**
- ✅ 如果 `liquidity >= $1000` → 开始评分

**实际例子**：
| 流动性 | 得分 | 说明 |
|--------|------|------|
| $500 | 0分 | ❌ 不满足最低要求 |
| $1,000 | 20分 | ✅ 最低要求 |
| $2,000 | 30分 | ✅ 良好 |
| $5,000+ | 40分 | ✅ 优秀（满分） |

---

### 3️⃣ **24小时交易量** (0-30分)

**评分标准**：
```javascript
volumeScore = Math.min(30, (volume / minVolume24h) * 15)
```

**过滤条件**：
- ❌ 如果 `volume_24h < $5000` → **直接拒绝**
- ✅ 如果 `volume_24h >= $5000` → 开始评分

**实际例子**：
| 交易量 | 得分 | 说明 |
|--------|------|------|
| $3,000 | 0分 | ❌ 不满足最低要求 |
| $5,000 | 15分 | ✅ 最低要求 |
| $10,000 | 22分 | ✅ 良好 |
| $20,000+ | 30分 | ✅ 优秀（满分） |

---

### 4️⃣ **订单簿价差** (0-20分)

**评分标准**：
```javascript
spreadScore = Math.max(0, 20 - (spread_pct / (maxSpread * 100)) * 20)
```

**过滤条件**：
- ❌ 如果 `spread_pct > 10%` → **直接拒绝**
- ✅ 如果 `spread_pct <= 10%` → 开始评分

**实际例子**：
| 价差 | 得分 | 说明 |
|------|------|------|
| 12% | 0分 | ❌ 价差太大 |
| 10% | 0分 | ⚠️ 边缘（拒绝） |
| 5% | 10分 | ✅ 一般 |
| 2% | 16分 | ✅ 良好 |
| 1% | 20分 | ✅ 优秀（满分） |

**重要提示**：
- 更小的价差 = 更高的得分
- 但也要考虑积分规则（≤6¢）

---

### 5️⃣ **订单簿深度** (0-10分)

**评分标准**：
```javascript
orderScore = Math.min(10, (totalOrders / minOrders) * 5)
```

**过滤条件**：
- ❌ 如果 `total_orders < 5` → **直接拒绝**
- ✅ 如果 `total_orders >= 5` → 开始评分

**实际例子**：
| 订单数 | 得分 | 说明 |
|--------|------|------|
| 3 | 0分 | ❌ 订单太少 |
| 5 | 5分 | ✅ 最低要求 |
| 10 | 7分 | ✅ 良好 |
| 20+ | 10分 | ✅ 优秀（满分） |

**订单数定义**：
```javascript
totalOrders = bids.length + asks.length
```

---

## 📊 **评分系统总览**

```
总分范围：0 - 150分

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
评分组成：
  ✨ 流动性积分激活：    +50分（一次性加成）
  💰 24h流动性：         0-40分
  📈 24h交易量：         0-30分
  📉 订单簿价差：        0-20分
  📊 订单簿深度：        0-10分
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 市场等级划分

| 总分 | 等级 | 说明 | 选中概率 |
|------|------|------|----------|
| 90-150 | ⭐⭐⭐⭐⭐ | 优秀 | 100% |
| 70-89 | ⭐⭐⭐⭐ | 良好 | 90% |
| 50-69 | ⭐⭐⭐ | 一般 | 70% |
| 30-49 | ⭐⭐ | 较差 | 40% |
| 0-29 | ⭐ | 差 | 10% |

---

## 🎲 **市场选择流程**

### Step 1: 扫描所有市场

```javascript
// 从 API 获取所有活跃市场
const allMarkets = await api.getMarkets();

// Predict.fun: 通常有 50-200 个市场
// Probable: 通常有 30-100 个市场
```

### Step 2: 获取订单簿数据

```javascript
// 前50个市场获取订单簿
for (const market of allMarkets.slice(0, 50)) {
  const orderbook = await api.getOrderbook(market.token_id);
  // 获取：best_bid, best_ask, spread_pct, bids, asks
}
```

### Step 3: 应用过滤规则

```javascript
// 过滤掉不符合最低要求的市场：
❌ liquidity < $1000
❌ volume_24h < $5000
❌ spread_pct > 10%
❌ total_orders < 5
❌ 缺少订单簿数据
```

### Step 4: 评分并排序

```javascript
// 对每个市场评分（0-150分）
const scoredMarkets = markets.map(m => ({
  market: m,
  score: calculateScore(m),  // 0-150分
  reasons: ['原因1', '原因2', ...]
}));

// 按分数降序排序
scoredMarkets.sort((a, b) => b.score - a.score);
```

### Step 5: 选择 Top N

```javascript
// Predict.fun: Top 10
const topCount = 10;

// Probable: Top 5-20（根据可用数量）
const topCount = Math.max(5, Math.min(20, scoredMarkets.length));

this.selectedMarkets = getTopMarkets(scoredMarkets, topCount);
```

---

## ⚙️ **可配置的过滤参数**

虽然市场是**自动选择**的，但你可以调整过滤标准：

### 在 .env 中配置

```bash
# ===== 市场过滤参数 =====

# 最大市场数量（最终会选择多少个）
MAX_MARKETS=5                    # 建议：3-10个

# 最低流动性要求
MIN_LIQUIDITY=1000              # 默认：$1000
                                # 提高→选择更优质市场
                                # 降低→选择更多市场

# 最低24小时交易量
MIN_VOLUME_24H=5000             # 默认：$5000
                                # 提高→选择更活跃市场
                                # 降低→选择更多市场

# 最大价差（百分比）
MAX_SPREAD=0.055                # 默认：5.5%（积分限制）
                                # 降低→选择更紧价差市场

# 手动指定市场ID（可选，不推荐）
# MARKET_TOKEN_IDS=token1,token2,token3
```

### 参数影响示例

#### 保守配置（质量优先）

```bash
MIN_LIQUIDITY=2000              # 提高流动性要求
MIN_VOLUME_24H=10000            # 提高交易量要求
MAX_SPREAD=0.04                 # 降低价差容忍
MAX_MARKETS=3                   # 只选前3个
```

**结果**：
- ✅ 选择的市场质量更高
- ✅ 流动性更好，成交更容易
- ❌ 可选市场更少
- ❌ 可能错过一些机会

#### 激进配置（数量优先）

```bash
MIN_LIQUIDITY=500               # 降低流动性要求
MIN_VOLUME_24H=2000             # 降低交易量要求
MAX_SPREAD=0.08                 # 提高价差容忍
MAX_MARKETS=10                  # 选择前10个
```

**结果**：
- ✅ 可选市场更多
- ✅ 机会更多
- ❌ 市场质量可能较低
- ❌ 流动性可能不足

---

## 📝 **实际运行示例**

### 启动时的输出

```
🔍 Scanning markets...

Found 127 active tokens

📊 Market Analysis:
──────────────────────────────────────────────────────────────────────────────

#1 [Score: 95.3] Will Trump win the 2024 presidential election?
   Token ID: 0x1234...
   - ✨ Active Liquidity Points!
   -    Max Spread: ±6¢
   -    Min Shares: 100
   - Liquidity: $8500.00
   - Volume: $15000.00
   - Spread: 1.80%
   - Orders: 24

#2 [Score: 78.5] Will Bitcoin reach $100k by end of 2024?
   Token ID: 0x5678...
   - ✨ Active Liquidity Points!
   - Liquidity: $5200.00
   - Volume: $9800.00
   - Spread: 2.50%
   - Orders: 18

#3 [Score: 42.1] Will it rain tomorrow?
   Token ID: 0xabcd...
   - Liquidity: $1800.00
   - Volume: $4500.00
   - Spread: 4.20%
   - Orders: 8

──────────────────────────────────────────────────────────────────────────────

✅ Selected top 10 markets for market making
```

---

## 🔍 **积分优化对市场选择的影响**

### 启用积分优化时

```bash
MM_POINTS_MIN_ONLY=true          # 只做积分市场
MM_POINTS_PRIORITIZE=true        # 优先积分市场
```

**影响**：
1. **额外过滤**：只选择有 `liquidity_activation` 的市场
2. **评分加成**：有积分的市场 +50 分
3. **订单调整**：自动确保订单满足 min_shares 和 max_spread

**结果**：
- ✅ 几乎所有选择的市场都有积分奖励
- ✅ 订单自动满足积分要求
- ❌ 可选市场数量减少

---

## 🎯 **最佳实践建议**

### 1. **使用默认参数（推荐新手）**

```bash
# 让系统自动选择
MIN_LIQUIDITY=1000              # 默认值
MIN_VOLUME_24H=5000             # 默认值
MAX_SPREAD=0.055                # 积分限制
MAX_MARKETS=5                   # 保守数量
```

### 2. **手动指定市场（高级用户）**

如果你想要做市特定市场：

```bash
# 在 .env 中指定
MARKET_TOKEN_IDS=0x1234...,0x5678...,0xabcd...
```

**注意**：手动指定时，系统**不会**自动过滤！你需要自己确保：
- ✅ 流动性充足
- ✅ 价差合理
- ✅ 订单簿深度足够

### 3. **定期检查选中的市场**

启动后，查看日志中的市场分析输出：
- 检查分数是否合理
- 检查是否有积分激活
- 检查流动性和交易量

### 4. **模拟测试**

```bash
SIMULATION_MODE=true             # 先模拟测试
```

运行一段时间，检查：
- 哪些市场被选中
- 订单是否满足积分要求
- 是否有足够的成交

---

## ❓ **常见问题**

### Q1: 我可以手动选择市场吗？

**A**: 可以，但不推荐。使用 `MARKET_TOKEN_IDS` 配置。

### Q2: 市场会动态变化吗？

**A**: **不会**。市场在启动时选择一次，之后不会自动重新选择。需要重启才能改变。

### Q3: 如果选中的市场都失败了怎么办？

**A**: 做市商会继续尝试其他市场，或者等待满足条件。

### Q4: 如何查看当前选择的市场？

**A**:
1. 查看启动时的市场分析输出
2. 查看 Desktop App 的"做市指标"面板
3. 查看日志中的 `Selected markets` 信息

### Q5: 为什么我的市场没有选中？

**A**: 可能原因：
- ❌ 流动性不足 (<$1000)
- ❌ 交易量不足 (<$5000)
- ❌ 价差太大 (>10%)
- ❌ 订单簿深度不足 (<5订单)
- ❌ 没有订单簿数据

---

## 📚 **总结**

### ✅ 优点

1. **完全自动化** - 无需手动选择
2. **多维度评估** - 流动性、交易量、价差、深度
3. **积分优化** - 优先选择有积分的市场
4. **智能排序** - 按评分从高到低选择

### ⚠️ 注意事项

1. **启动时选择** - 不会动态更新
2. **过滤严格** - 可能错过一些机会
3. **需要测试** - 建议先用模拟模式验证

### 🎯 推荐配置

```bash
# 新手推荐
MAX_MARKETS=5
MIN_LIQUIDITY=1000
MIN_VOLUME_24H=5000
MAX_SPREAD=0.055
MM_POINTS_PRIORITIZE=true
MM_POINTS_MIN_ONLY=true
```

---

**文档版本**: v1.1.0
**更新日期**: 2026-02-25
**适用平台**: Predict.fun & Probable
