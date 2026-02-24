# 🔍 做市商配置参数全面分析报告

**版本**: v1.1.0
**日期**: 2026-02-25
**分析师**: Claude Code

---

## 📊 执行摘要

### ⚠️ **发现的问题**

| 严重性 | 问题 | 影响 | 优先级 |
|--------|------|------|--------|
| 🔴 **CRITICAL** | ORDER_SIZE 太小，无法满足 min_shares=100 要求 | **无法获得积分** | P0 |
| 🟡 **HIGH** | 缺少积分优化配置 | 积分效率低 | P1 |
| 🟡 **HIGH** | 缺少价格范围过滤 | 可能选择不合适市场 | P1 |
| 🟢 **MEDIUM** | 风险参数需要调整 | 可能过度风险或保守 | P2 |

---

## 🔴 **CRITICAL 问题 #1: ORDER_SIZE 配置错误**

### 问题分析

**当前配置** (.env.example):
```bash
ORDER_SIZE=10  # 10美元
```

**计算逻辑** (src/market-maker.ts):
```javascript
let shares = Math.floor(targetOrderValue / price);
```

**实际效果**:
- 如果合约价格 = $0.50
- shares = Math.floor(10 / 0.50) = **20股**

**积分规则要求** (docs/BEGINNER_GUIDE_CN.md):
- Predict.fun: **min_shares = 100股**
- Probable: **min_shares = 100股**

**❌ 问题**: 20股 < 100股，**无法获得积分！**

### 🎯 **解决方案**

#### 方案 A: 固定股数模式（推荐新手）

```bash
# 配置订单大小为股数（而非美元）
ORDER_SIZE=110  # 至少110股，确保 >100

# 或更保守
ORDER_SIZE=150  # 150股，更安全
```

**优点**: 简单直接，确保满足积分要求
**缺点**: 不同价格合约的美元价值差异大

#### 方案 B: 动态计算模式（推荐高级用户）

```bash
# 设置较小的美元订单，但启用积分优化
ORDER_SIZE=15
MM_POINTS_MIN_SHARES=100        # 最小100股
MM_POINTS_MAX_SPREAD_CENTS=6    # 最大价差6美分
MM_POINTS_OPTIMIZATION=true     # 启用积分优化
MM_POINTS_V2_OPTIMIZER=true     # 启用V2优化器
```

**优点**: 积分优化器会自动调整订单大小
**缺点**: 需要理解优化器工作原理

#### 方案 C: 价格自适应模式（推荐）

```bash
# 设置基础订单大小 + 积分约束
ORDER_SIZE=20                   # 基础大小
MM_POINTS_MIN_ONLY=true         # 只做满足min_shares的市场
MM_POINTS_MIN_MULTIPLIER=1.5    # 1.5倍安全边际
```

**优点**: 自动过滤不合适市场，确保积分
**缺点**: 可能选择的市场较少

---

## 🟡 **HIGH 问题 #2: 缺少积分优化配置**

### 问题分析

**当前配置** (.env.example):
```bash
# ❌ 缺少以下关键配置
# MM_POINTS_MIN_SHARES=
# MM_POINTS_MAX_SPREAD_CENTS=
# MM_POINTS_OPTIMIZATION=
```

**默认值** (src/config.ts):
```javascript
mmPointsMinShares: 0                    // ❌ 未启用
mmPointsMaxSpreadCents: 0               // ❌ 未启用
mmPointsOptimization: true              // ✅ 默认启用
mmPointsV2Optimizer: true               // ✅ 默认启用
mmPointsPrioritize: true                // ✅ 默认启用
```

**问题**: 虽然优化器默认启用，但**没有设置约束条件**，优化器不知道目标值！

### 🎯 **解决方案**

```bash
# ===== Predict.fun 积分优化配置 =====
# 最小订单股数（积分要求）
MM_POINTS_MIN_SHARES=100

# 最大价差（积分要求，美分）
MM_POINTS_MAX_SPREAD_CENTS=6

# 启用积分优化
MM_POINTS_OPTIMIZATION=true      # 启用积分优化器
MM_POINTS_V2_OPTIMIZER=true      # 启用V2优化器（更先进）
MM_POINTS_PRIORITIZE=true        # 优先积分市场

# 只做满足积分要求的市场
MM_POINTS_MIN_ONLY=true          # 推荐开启

# 安全边际（1.0 = 100股，1.5 = 150股）
MM_POINTS_MIN_MULTIPLIER=1.5     # 推荐1.5倍

# 假设市场活跃（积分计算）
MM_POINTS_ASSUME_ACTIVE=false    # 让系统自动检测
```

---

## 🟡 **HIGH 问题 #3: 缺少价格范围过滤**

### 问题分析

**当前状态**: 没有最小/最大价格配置

**潜在问题**:
- **过低价格** (< $0.10):
  - 同样ORDER_SIZE，shares会很多
  - 可能过度持仓

- **过高价格** (> $0.90):
  - 同样ORDER_SIZE，shares会很少
  - 可能不满足min_shares=100

### 🎯 **解决方案**

```bash
# 添加价格范围过滤（需要代码支持）
# TODO: 在 market-selector.ts 中添加价格过滤
MIN_PRICE=0.10    # 最低价格10¢
MAX_PRICE=0.85    # 最高价格85¢
```

**临时解决方案**（现在可用）:
```bash
# 通过市场选择器控制
MIN_LIQUIDITY=1000    # 提高流动性要求
MIN_VOLUME_24H=5000   # 提高交易量要求
MAX_SPREAD=0.06       # 严格控制价差
```

---

## 🟢 **MEDIUM 问题 #4: 风险参数评估**

### 当前风险评估

| 参数 | 当前值 | 评估 | 建议 |
|------|--------|------|------|
| `ORDER_SIZE` | 10 | 🔴 太小 | 改为 20-30（美元） |
| `MAX_POSITION` | 100 | 🟢 合理 | 保持 |
| `MAX_DAILY_LOSS` | 200 | 🟢 合理 | 保持 |
| `SPREAD` | 0.02 (2%) | 🟢 合理 | 可以降至 0.015 |
| `MIN_SPREAD` | 0.01 (1%) | 🟢 合理 | 保持 |
| `MAX_SPREAD` | 0.08 (8%) | 🟡 太大 | 改为 0.06 |
| `MIN_ORDER_INTERVAL_MS` | 3000 | 🟢 合理 | 保持 |
| `MAX_ORDERS_PER_MARKET` | 2 | 🟢 合理 | 保持 |

### 🎯 **风险参数优化建议**

```bash
# ===== 订单大小 =====
ORDER_SIZE=25                   # 提高到25美元
                                # 对 $0.50 价格 = 50股
                                # 对 $0.20 价格 = 125股 ✅

# ===== 价差范围 =====
SPREAD=0.015                    # 1.5% 基础价差（降低）
MIN_SPREAD=0.008               # 0.8% 最小价差
MAX_SPREAD=0.055               # 5.5% 最大价差（降低至6¢以下）

# ===== 风险控制 =====
MAX_POSITION=100                # 保持
MAX_DAILY_LOSS=200             # 保持
MAX_SINGLE_ORDER=50            # 单笔最大50美元

# ===== 市场选择 =====
MAX_MARKETS=5                   # 最多5个市场（保守）
MIN_LIQUIDITY=500              # 最低流动性$500
MIN_VOLUME_24H=2000            # 最低交易量$2000
```

---

## ✅ **推荐的完整配置**

### 新手配置（保守）

```bash
# ========== 平台选择 ==========
MM_VENUE=predict

# ========== 基础参数 ==========
ORDER_SIZE=25                   # 25美元/单
MAX_POSITION=100                # 最大持仓$100
MAX_DAILY_LOSS=100             # 每日最大亏损$100

# ========== 价差配置 ==========
SPREAD=0.015                    # 1.5% 基础价差
MIN_SPREAD=0.008               # 0.8% 最小
MAX_SPREAD=0.055               # 5.5% 最大（<6¢）

# ========== 积分优化 ==========
MM_POINTS_MIN_SHARES=100        # 最小100股
MM_POINTS_MAX_SPREAD_CENTS=6    # 最大6美分
MM_POINTS_OPTIMIZATION=true     # 启用优化
MM_POINTS_V2_OPTIMIZER=true     # V2优化器
MM_POINTS_PRIORITIZE=true       # 优先积分
MM_POINTS_MIN_ONLY=true         # 只做积分市场
MM_POINTS_MIN_MULTIPLIER=1.5    # 1.5倍安全边际

# ========== 市场过滤 ==========
MAX_MARKETS=3                   # 最多3个市场
MIN_LIQUIDITY=1000             # 最低流动性$1000
MIN_VOLUME_24H=5000            # 最低交易量$5000

# ========== 风险控制 ==========
MAX_SINGLE_ORDER=50            # 单笔最大$50
SIMULATION_MODE=true            # 先模拟测试！
```

### 高级配置（激进）

```bash
# ========== 平台选择 ==========
MM_VENUE=predict

# ========== 基础参数 ==========
ORDER_SIZE=40                   # 40美元/单
MAX_POSITION=200                # 最大持仓$200
MAX_DAILY_LOSS=300             # 每日最大亏损$300

# ========== 价差配置 ==========
SPREAD=0.012                    # 1.2% 基础价差
MIN_SPREAD=0.006               # 0.6% 最小
MAX_SPREAD=0.055               # 5.5% 最大

# ========== 积分优化 ==========
MM_POINTS_MIN_SHARES=100
MM_POINTS_MAX_SPREAD_CENTS=6
MM_POINTS_OPTIMIZATION=true
MM_POINTS_V2_OPTIMIZER=true
MM_POINTS_PRIORITIZE=true
MM_POINTS_MIN_ONLY=false        # 不限制，可做其他市场
MM_POINTS_MIN_MULTIPLIER=1.2    # 1.2倍安全边际

# ========== 市场过滤 ==========
MAX_MARKETS=8                   # 最多8个市场
MIN_LIQUIDITY=500              # 最低流动性$500
MIN_VOLUME_24H=2000            # 最低交易量$2000

# ========== 高级功能 ==========
PREDICT_WS_ENABLED=true         # WebSocket实时数据
MM_AUTO_TUNE_ENABLED=true       # 自动调优
MM_QUOTE_SECOND_LAYER=true      # 第二档挂单策略
MM_TOUCH_BUFFER_FIXED_CENTS=0.01  # 1¢缓冲

# ========== 风险控制 ==========
MAX_SINGLE_ORDER=80            # 单笔最大$80
SIMULATION_MODE=false           # 实盘模式
```

### Probable 平台配置

```bash
# ========== 平台选择 ==========
MM_VENUE=probable

# ========== Probable 特定配置 ==========
PROBABLE_MAX_MARKETS=30
PROBABLE_FEE_BPS=0

# ========== 基础参数 ==========
ORDER_SIZE=30                   # Probable可以稍大
MAX_POSITION=150
MAX_DAILY_LOSS=200

# ========== 价差配置 ==========
SPREAD=0.01                     # 1% 价差（Probable可更小）
MIN_SPREAD=0.005
MAX_SPREAD=0.04

# ========== 积分优化 ==========
MM_POINTS_MIN_SHARES=100        # Probable也有积分系统
MM_POINTS_MAX_SPREAD_CENTS=10   # Probable价差限制更宽松
MM_POINTS_OPTIMIZATION=true
MM_POINTS_PRIORITIZE=true
```

---

## 🔧 **代码改进建议**

### 1. 添加价格范围过滤

**文件**: `src/market-selector.ts`

```typescript
// 在 scoreMarket() 函数中添加
const minPrice = 0.10;  // $0.10
const maxPrice = 0.85;  // $0.85

if (orderbook.mid_price < minPrice || orderbook.mid_price > maxPrice) {
  return { market, score: 0, reasons: ['Price out of range'] };
}
```

### 2. 添加 ORDER_SIZE 单位选择

**文件**: `src/config.ts`

```typescript
// 新增配置选项
orderSizeUnit: process.env.ORDER_SIZE_UNIT || 'usd',  // 'usd' or 'shares'
orderSizeShares: parseFloat(process.env.ORDER_SIZE_SHARES || '0'),
```

### 3. 改进订单大小计算

**文件**: `src/market-maker.ts`

```typescript
// 在 calculateOrderSize() 中添加
let shares: number;
if (this.config.orderSizeUnit === 'shares') {
  // 直接使用股数
  shares = this.config.orderSizeShares;
} else {
  // 使用美元计算（当前逻辑）
  shares = Math.floor(targetOrderValue / price);
}

// 确保满足积分要求
if (this.config.mmPointsMinShares > 0) {
  const minShares = this.config.mmPointsMinShares;
  const multiplier = this.config.mmPointsMinMultiplier || 1;
  shares = Math.max(shares, Math.ceil(minShares * multiplier));
}
```

---

## 📋 **检查清单**

在启动做市商前，请确认：

- [ ] ✅ ORDER_SIZE 足够大（建议 ≥25美元）
- [ ] ✅ 配置 MM_POINTS_MIN_SHARES=100
- [ ] ✅ 配置 MM_POINTS_MAX_SPREAD_CENTS=6
- [ ] ✅ MAX_SPREAD ≤ 0.055（5.5%）
- [ ] ✅ 启用 MM_POINTS_OPTIMIZATION=true
- [ ] ✅ 启用 MM_POINTS_V2_OPTIMIZER=true
- [ ] ✅ 先用 SIMULATION_MODE=true 测试
- [ ] ✅ 检查钱包余额充足
- [ ] ✅ 设置合理的止损（MAX_DAILY_LOSS）
- [ ] ✅ 阅读并理解积分规则

---

## 📚 **参考资料**

1. **积分规则**:
   - Predict.fun: min_shares=100, max_spread=6¢
   - Probable: min_shares=100, max_spread=10¢

2. **市场数据**:
   - Predict.fun 平均价格: $0.30-$0.70
   - Probable 平均价格: $0.01-$0.99
   - 建议价格范围: $0.10-$0.85

3. **手续费**:
   - Predict.fun: 0.2% (2 bps)
   - Probable: 0% (无手续费)

4. **订单精度**:
   - 价格精度: 6位小数（0.000001）
   - 数量精度: 整数股数

---

## ⚠️ **重要警告**

1. **永远不要**使用无法承受损失的资金
2. **永远不要**将私钥提交到 Git
3. **始终先**在模拟模式下测试
4. **定期检查**日志和交易记录
5. **设置合理**的止损限额
6. **分散投资**，不要全部资金做市

---

**报告生成时间**: 2026-02-25 03:15:00 UTC
**下次审查时间**: 建议每周检查一次配置
**联系方式**: GitHub Issues
