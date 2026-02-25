# 🎯 统一做市商策略 - 动态偏移功能

## 核心创新

### 1. 异步对冲逻辑
- **成交一点 → 立即对冲一点**（不撤单）
- 保留剩余挂单继续赚积分
- 即时补齐：立刻市价买入对面

### 2. 双轨并行操作
- **轨道 A（买入端）**：持续挂 Buy 单赚积分
- **轨道 B（卖出端）**：持续挂 Sell 单赚积分
- **结果**：同时在两端赚取积分

### 3. 恒定价值
- YES + NO = 1（恒定价值）
- 持有 1:1 时风险为零

### 4. 🆕 动态偏移（第二档挂单）
- 根据市场第一档价格动态计算偏移
- 始终挂在第二档，避免被立即成交
- 例如：第一档 99.1 → 我们挂 99.0（偏移 -1%）

### 5. 🆕 第一档监控（自动撤单重挂）
- 实时监控订单是否成为第一档
- 如果成为第一档，立即撤单并重新挂第二档
- 始终保持最优位置

---

## 配置参数

### 基础配置

```bash
# 启用统一做市商策略
UNIFIED_MARKET_MAKER_ENABLED=true

# 对冲偏差容忍度（0.05 = 5%）
UNIFIED_MARKET_MAKER_TOLERANCE=0.05

# 最小/最大对冲数量
UNIFIED_MARKET_MAKER_MIN_SIZE=10
UNIFIED_MARKET_MAKER_MAX_SIZE=500
```

### 🆕 动态偏移配置

```bash
# 启用动态偏移模式（第二档挂单）
UNIFIED_MARKET_MAKER_DYNAMIC_OFFSET_MODE=true

# Buy 单偏移量（基点，100 = 1%）
UNIFIED_MARKET_MAKER_BUY_OFFSET_BPS=100

# Sell 单偏移量（基点，100 = 1%）
UNIFIED_MARKET_MAKER_SELL_OFFSET_BPS=100

# 监控是否成为第一档（自动撤单重挂）
UNIFIED_MARKET_MAKER_MONITOR_TIER_ONE=true
```

---

## 工作流程示例

### 场景 1: 空仓启动

```
市场状态: YES 价格 $0.60, NO 价格 $0.40
第一档: YES Buy $0.600, YES Sell $0.605

我们的挂单（动态偏移 -100bps）:
  ✅ YES Buy: $0.594（低于第一档 100bps）
  ✅ NO Buy: $0.391（低于第一档 100bps）

结果: 挂在第二档，等待成交
```

### 场景 2: YES Buy 被成交 10 股

```
事件: YES Buy 单被成交 10 股
持仓: 10 YES + 0 NO

🔄 异步对冲:
  ✅ 不撤单：保留剩余 YES Buy 单
  ✅ 即时补齐：市价买入 10 NO
  ✅ 结果：持有 10 YES + 10 NO（1:1 对冲）

🚀 双轨并行激活:
  ✅ 买入端：继续挂 Buy 单
  ✅ 卖出端：可以挂 Sell 单了
```

### 场景 3: 第一档监控

```
市场变化: 第一档变成 $0.593
我们的订单: YES Buy $0.594

⚠️  检测到: 我们的订单成为第一档！

🔄 自动处理:
  1. 立即撤单
  2. 重新挂单: YES Buy @ $0.588（低于新第一档 100bps）
  3. 继续监控...

✅ 始终保持第二档位置
```

---

## 测试

运行测试脚本：

```bash
npx tsx test-unified-strategy.ts
```

测试覆盖：
- ✅ 空仓状态（启动双轨并行）
- ✅ 异步对冲（YES Buy 被成交）
- ✅ 双轨并行操作（同时赚积分）
- ✅ 颗粒度对冲（NO Sell 被成交）
- ✅ 第一档监控（自动撤单重挂）

---

## 启用完整功能

在 `.env` 中设置：

```bash
# 启用统一做市商策略
UNIFIED_MARKET_MAKER_ENABLED=true

# 启用动态偏移
UNIFIED_MARKET_MAKER_DYNAMIC_OFFSET_MODE=true
UNIFIED_MARKET_MAKER_BUY_OFFSET_BPS=100
UNIFIED_MARKET_MAKER_SELL_OFFSET_BPS=100

# 启用第一档监控
UNIFIED_MARKET_MAKER_MONITOR_TIER_ONE=true
```

然后运行：

```bash
npm start
```

---

## 文件结构

```
src/strategies/
├── unified-market-maker-strategy.ts  # 统一策略核心逻辑
└── index.ts                          # 策略导出

src/
├── market-maker.ts                   # 做市商执行器
├── types.ts                          # 类型定义
└── config.ts                         # 配置读取

test-unified-strategy.ts              # 测试脚本
```

---

## 优势总结

| 特性 | 传统策略 | 统一策略 |
|------|----------|----------|
| 对冲方式 | 撤单重挂 | 异步对冲（不撤单） |
| 积分赚取 | 单轨（买入或卖出） | 双轨并行（同时） |
| 挂单位置 | 固定价差 | 动态偏移（第二档） |
| 风险控制 | 部分对冲 | 1:1 完美对冲 |
| 市场适应 | 静态 | 动态监控 + 自动调整 |

---

## 技术细节

### 动态偏移算法

```typescript
// 根据第一档价格动态计算偏移
buyOffset = config.buyOffsetBps / 10000;  // 100 bps = 1%
yesBid = bestBid * (1 - buyOffset);       // 低于第一档买价
yesAsk = bestAsk * (1 + sellOffset);      // 高于第一档卖价
```

### 第一档监控逻辑

```typescript
// 检查是否成为第一档
if (lastPrices.yesBid >= bestBid * 0.999) {
  // 成为第一档！
  // 1. 撤单
  // 2. 重新计算价格
  // 3. 挂单
}
```

---

## 注意事项

1. **偏移量设置**：建议 50-150 bps（0.5% - 1.5%）
   - 太小：频繁成为第一档
   - 太大：远离市场，成交机会少

2. **监控频率**：最多每 2 秒检查一次
   - 避免过度消耗 API 额度
   - 及时响应市场变化

3. **滑点控制**：对冲时允许 250-300 bps 滑点
   - 确保对冲能够成交
   - 平衡速度和成本

---

## 常见问题

**Q: 为什么不直接挂在第一档？**

A: 挂在第一档会被立即成交，失去赚积分的机会。第二档挂单可以：
- 避免频繁成交
- 持续赚取挂单积分
- 选择性成交（更有利的价格）

**Q: 动态偏移和固定价差有什么区别？**

A:
- **固定价差**：根据中间价固定偏移（如 1.5%）
- **动态偏移**：根据第一档价格偏移（始终在第二档）

**Q: 第一档监控会消耗很多 API 额度吗？**

A: 不会。监控逻辑：
- 最多每 2 秒检查一次
- 只在挂单后检查
- 只检测成为第一档的情况

---

## 总结

统一做市商策略整合了所有优点：
- ✅ 异步对冲（不撤单）
- ✅ 双轨并行（两端积分）
- ✅ 动态偏移（第二档挂单）
- ✅ 第一档监控（自动调整）

这是**最优的积分策略**！🚀
