# Predict.fun Market Maker Lite

Lite edition with unified market-making strategy for [Predict.fun](https://predict.fun?ref=B0CE6) and [Probable](https://probable.markets/?ref=PNRBS9VL).

## Features

- **Unified Market-Making Strategy** (统一做市策略)
- Market recommendation + auto selection
- Order configuration templates for Predict / Probable
- Electron desktop app support (macOS, Windows, Linux)

---

## Unified Strategy (统一做市策略)

### 核心功能

| 功能 | 说明 |
|------|------|
| **二档追踪** | 实时监控订单簿，保持挂单在第二档 (1-6 cents from best bid/ask) |
| **异步对冲** | 被吃单后立即对冲，不取消剩余挂单 |
| **双轨并行** | 同时在买/卖两侧赚取积分 |
| **流动性评估** | 选择 YES/NO 双边流动性充足的市场 |

### 二档追踪 (Second Tier Tracking)

```
订单簿示例:
┌─────────────────────────────────────┐
│ ASK (卖单)                          │
│   $0.55  ← 第一档 (最佳卖价)         │
│   $0.56  ← 第二档 (我们的挂单) ✅    │
│   $0.57                             │
│ ─────────────────────────────────── │
│   $0.44  ← 第一档 (最佳买价)         │
│   $0.43  ← 第二档 (我们的挂单) ✅    │
│   $0.42                             │
│ BID (买单)                          │
└─────────────────────────────────────┘

价差要求: 1-6 cents (Predict.fun 积分规则)
```

**工作原理:**
1. 监控第一档价格变化
2. 自动计算第二档价格
3. 价格偏移 > 1 cent 时重新挂单
4. 减少被吃单的情况

### 异步对冲 (Async Hedging)

```
场景: 第二档 YES 买单被成交 q 数量

┌─────────────────────────────────────────────────┐
│ Step 1: 成交检测                                 │
│   YES 买单成交 50 股 @ $0.44                      │
├─────────────────────────────────────────────────┤
│ Step 2: 不撤单                                   │
│   ✅ 保留剩余挂单继续排队                         │
│   ✅ 继续赚取积分                                │
├─────────────────────────────────────────────────┤
│ Step 3: 立即对冲                                 │
│   🚀 市价买入 NO 50 股 (urgency: HIGH)           │
│   💰 锁定 1:1 对冲库存                           │
├─────────────────────────────────────────────────┤
│ Step 4: 状态更新                                 │
│   hedgedShares += 50                             │
│   unhedgedShares = 0                             │
└─────────────────────────────────────────────────┘
```

**关键特点:**
- 被吃单后 **立即** 触发对冲 (不等待累积)
- 对冲 urgency 始终为 **HIGH**
- 自动查找 YES/NO 配对 token

### 双轨并行 (Dual Track Mode)

```
Track A (买侧): 挂 YES 买单 → 赚买侧积分
Track B (卖侧): 挂 YES 卖单 → 赚卖侧积分

状态追踪:
├── pendingBuyShares:  待成交买单数量
├── pendingSellShares: 待成交卖单数量
├── hedgedShares:      已对冲库存
├── buyPointsEarned:   买侧积分
└── sellPointsEarned:  卖侧积分
```

---

## Configuration

### 统一策略配置项

```env
# 启用统一策略
UNIFIED_STRATEGY_ENABLED=true

# 仓位平衡容忍度 (0.05 = 5%)
UNIFIED_STRATEGY_TOLERANCE=0.05

# 订单大小范围
UNIFIED_STRATEGY_MIN_SIZE=10
UNIFIED_STRATEGY_MAX_SIZE=500

# 价格偏移 (基点, 100bps = 1%)
UNIFIED_STRATEGY_BUY_OFFSET_BPS=100
UNIFIED_STRATEGY_SELL_OFFSET_BPS=100

# 对冲设置
UNIFIED_STRATEGY_HEDGE_SLIPPAGE_BPS=250
UNIFIED_STRATEGY_MAX_UNHEDGED_SHARES=100

# 模式开关
UNIFIED_STRATEGY_ASYNC_HEDGING=true
UNIFIED_STRATEGY_DUAL_TRACK_MODE=true
UNIFIED_STRATEGY_DYNAMIC_OFFSET_MODE=true
```

### 配置说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `UNIFIED_STRATEGY_ENABLED` | false | 启用统一做市策略 |
| `UNIFIED_STRATEGY_TOLERANCE` | 0.05 | 仓位平衡容忍度 |
| `UNIFIED_STRATEGY_MIN_SIZE` | 10 | 最小订单大小 (股) |
| `UNIFIED_STRATEGY_MAX_SIZE` | 500 | 最大订单大小 (股) |
| `UNIFIED_STRATEGY_BUY_OFFSET_BPS` | 100 | 买单价偏移 (100bps = 1%) |
| `UNIFIED_STRATEGY_SELL_OFFSET_BPS` | 100 | 卖单价偏移 (100bps = 1%) |
| `UNIFIED_STRATEGY_HEDGE_SLIPPAGE_BPS` | 250 | 对冲滑点容忍 (250bps = 2.5%) |
| `UNIFIED_STRATEGY_MAX_UNHEDGED_SHARES` | 100 | 最大未对冲股数 |
| `UNIFIED_STRATEGY_ASYNC_HEDGING` | true | 启用异步对冲 |
| `UNIFIED_STRATEGY_DUAL_TRACK_MODE` | true | 启用双轨并行 |
| `UNIFIED_STRATEGY_DYNAMIC_OFFSET_MODE` | true | 启用动态偏移 |

---

## Quick Start

### 1. 安装依赖

```bash
npm install
cp .env.example .env
```

### 2. 应用交易场馆模板

```bash
npm run template:predict    # Predict.fun 模板
# 或
npm run template:probable   # Probable 模板
```

### 3. 推荐市场并应用

```bash
npm run market:recommend    # 查看推荐市场
npm run market:apply        # 一键应用到配置
```

### 4. 启动做市商

```bash
npm run start:mm            # 命令行模式
```

### 5. 桌面端应用

```bash
npm run app:install         # 安装桌面端依赖
npm run app:dev             # 开发模式运行
```

---

## Desktop App

### 支持平台

| 平台 | 架构 | 文件格式 |
|------|------|----------|
| macOS | arm64 (M1/M2/M3) | `.dmg`, `.zip` |
| Windows | x64 | `.exe`, `Setup.exe` |
| Linux | arm64 | `.AppImage` |

### 构建命令

```bash
cd desktop-app-lite
npm run build        # 构建所有平台
npm run build:mac    # 仅 macOS
npm run build:win    # 仅 Windows
npm run build:linux  # 仅 Linux
```

---

## Output Examples

### 策略启动

```
✅ Unified Strategy initialized (二档追踪 + 异步对冲 + 双轨并行)
```

### 二档挂单

```
📈 [UnifiedStrategy] Track A (Buy): 100 shares @ $0.4400
📉 [UnifiedStrategy] Track B (Sell): 100 shares @ $0.5600
📊 Reprice check: delta=0.5 cents (threshold: 1.0)
```

### 异步对冲触发

```
⚡ [AsyncHedge] 买 YES 成交 50 股 @ $0.4400，立即对冲买 NO 50 股
🚀 [UnifiedStrategy] 异步对冲触发: 50 NO @ $0.5850
🔗 [findPairedToken] 找到配对: 0x12345678... -> 0x87654321... (NO)
✅ [UnifiedStrategy] 对冲成交: 50 NO
```

### 状态摘要

```
╔══════════════════════════════════════════════════╗
║ 📊 Dual Track State
╠══════════════════════════════════════════════════╣
║ Track A: Buy 100 @ $0.4400
║ Track B: Sell 100 @ $0.5600
║ Hedged: 50 pairs
║ Unhedged: 0 shares
║ Points: Buy=44.00 Sell=56.00
╚══════════════════════════════════════════════════╝
```

---

## Important Notes

- **首次使用**: 保持 `ENABLE_TRADING=false` 进行安全测试
- **Predict 实盘**: 需要设置 `JWT_TOKEN` 并运行 `npm run setup:approvals`
- **Probable**: 设置 `PROBABLE_PRIVATE_KEY`，保持 `MM_REQUIRE_JWT=false`
- **积分规则**: 最大价差 ±6 cents，最小股数 100

---

## Risk Warning

- 市场波动可能导致意外成交
- 异步对冲存在滑点风险
- 请根据自身风险承受能力配置参数
- 建议先用小仓位测试

---

## Referral Links

- Predict: https://predict.fun?ref=B0CE6
- Probable: https://probable.markets/?ref=PNRBS9VL

---

## Changelog

### v1.6.5
- 新增: 统一做市策略 (Unified Strategy)
- 新增: 二档追踪 (Second Tier Tracking)
- 新增: 异步对冲 (Async Hedging) - 被吃单后立即对冲
- 新增: 双轨并行 (Dual Track Mode)
- 新增: 流动性评估 (Liquidity Assessment)
- 优化: YES/NO 配对 token 查找缓存
