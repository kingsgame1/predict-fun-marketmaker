# 市场选择和推荐模块 - 使用指南

## 功能概述

智能市场选择和推荐模块可以帮助你：
- 📊 **自动分析所有市场** - 计算评分、流动性、价差等关键指标
- 💰 **查看 1% 流动性** - 了解价格变动 1% 范围内的可用流动性
- 🎯 **智能推荐配置** - 根据市场情况推荐最优的订单参数
- 📋 **交互式选择** - 可视化界面，轻松选择和配置市场

---

## 快速开始

### 1. 运行市场推荐工具

```bash
npm run market:recommend
```

### 2. 查看市场推荐

工具会显示所有市场的推荐列表：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 市场推荐列表（按评分排序）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

序号 │ 评分 │ 积分 │ Spread │ 1%流动性 │  24h交易量 │ 问题
─────┼──────┼──────┼────────┼──────────┼───────────┼────────────────────
  1  │  85  │  ✅  │  2.5%  │  $1,250   │   $12.5K  │ 特朗普会赢得2024大选吗？
  2  │  78  │  ✅  │  3.1%  │   $980    │    $8.3K  │ 比特币年底会超过10万吗？
  3  │  72  │  ❌  │  1.8%  │  $2,100   │   $15.7K  │ 以太坊会突破5K吗？
...
```

### 3. 选择市场

- **查看详情**：输入序号（如：`1`）查看市场详细信息
- **批量选择**：输入多个序号（如：`1,3,5`）批量选择市场
- **全选**：输入 `all` 选择全部市场
- **退出**：输入 `q` 完成选择

### 4. 配置订单参数

选择市场后，系统会提示配置订单参数：

```
🎯 配置订单参数:

投入资金 (USD) [当前: $500]: ➜ 1000
订单大小 (USD) [当前: $25, 推荐: $25]: ➜
价差设置 (%) [当前: 2.5%, 推荐: 2.5%]: ➜
最大持仓 (USD) [当前: $100, 推荐: $100]: ➜
最小股数 [当前: 100, 推荐: 100]: ➜

✅ 配置确认:
   • 投入资金: $1000
   • 订单大小: $25
   • 单笔股数: 49 shares
   • 价差: 2.5%
   • 最大持仓: $100
   • 预计订单数: 40 单

确认并添加到选择列表? (Y/n): ➜ Y
```

### 5. 保存配置

配置会自动保存到 `.env.market_selection` 文件：

```bash
# 市场选择配置
# 生成时间: 2025-02-22T12:34:56.789Z

SELECTED_MARKETS=token_id_1,token_id_2,token_id_3
TOTAL_CAPITAL_USD=3000
MAX_MARKETS=3
DEFAULT_ORDER_SIZE=25

# 各市场配置

# 特朗普会赢得2024大选吗？
MARKET_token_id_1_CAPITAL=1000
MARKET_token_id_1_ORDER_SIZE=25
MARKET_token_id_1_SHARES=49
MARKET_token_id_1_SPREAD=0.025
MARKET_token_id_1_MAX_POSITION=100
MARKET_token_id_1_MIN_SHARES=100
...
```

---

## 市场详情解读

### 评分信息

```
📊 评分信息:
   • 综合评分: 92/100 ⭐⭐⭐⭐⭐
   • 积分评分: 95/100 ✅
   • 排名优先级: 88
```

- **综合评分**：0-100 分，综合考虑积分价值、利润潜力、风险等因素
- **积分评分**：是否符合 Predict.fun 积分规则
- **排名优先级**：排序权重，分数越高越优先

### 价差信息

```
💰 价差信息:
   • 当前价差: 2.8% ($0.028)
   • 中间价: $0.51
   • 买价: $0.496
   • 卖价: $0.524
```

- **当前价差**：买卖价差百分比和绝对值
- **中间价**：(买价 + 卖价) / 2
- **买价/卖价**：当前最优价格

### 1% 流动性

```
💵 1% 流动性:
   • 1% 买盘流动性: 620 shares ($638)
   • 1% 卖盘流动性: 920 shares ($942)
   • 1% 总流动性: 1540 shares ($1,580)
```

**重要指标**：表示价格变动 1% 范围内的可用流动性
- **买盘流动性**：当前价向下 1% 内的所有买单
- **卖盘流动性**：当前价向上 1% 内的所有卖单
- **总流动性**：两者之和，越高越好

### 订单簿深度

```
📚 订单簿深度 (Top 3):
   • Top 3 买盘: 620 shares ($638)
   • Top 3 卖盘: 920 shares ($942)
   • 总深度: 1540 shares ($1,580)
```

显示前 3 档订单的累计流动性。

### 积分规则

```
✅ 积分激活规则:
   • 最小订单: 100 shares
   • 最大价差: $0.06 (6%)
   • 状态: ✅ 符合积分要求
```

- **最小订单**：满足积分要求的最小股数
- **最大价差**：满足积分要求的最大价差
- **状态**：当前市场是否符合积分规则

### 推荐配置

```
💡 推荐配置:
   • 价差较大，收益潜力高 ⭐⭐⭐⭐⭐
   • 高流动性，建议大额订单 ($50)
   • 最小 100 shares (积分要求)
   • 建议价差: 2.5%
   • 建议订单大小: $25
   • 建议最大持仓: $100
```

系统根据市场情况自动推荐的最优配置。

---

## 高级配置

### 修改推荐参数

编辑 `.env` 文件，修改以下配置：

```bash
# 交互式市场选择配置
INTERACTIVE_MARKET_SELECTION=false    # 启动时是否启用交互式市场选择
MARKET_RECOMMEND_TOP_N=20             # 推荐显示前 N 个市场
MARKET_RECOMMEND_MIN_SCORE=0          # 最低评分要求（0-100）
MARKET_RECOMMEND_MIN_LIQUIDITY=0      # 最低流动性要求（USD）
MARKET_RECOMMEND_POINTS_ONLY=false    # 是否只显示积分激活市场

# 默认订单配置
DEFAULT_ORDER_CAPITAL_USD=500         # 默认每个市场投入资金（USD）
DEFAULT_ORDER_SIZE_USD=25             # 黢单笔订单大小（USD）
DEFAULT_MAX_POSITION_USD=100          # 默认最大持仓（USD）
```

### 只显示积分激活市场

```bash
# 在 .env 中设置
MARKET_RECOMMEND_POINTS_ONLY=true
```

这样只会显示符合 Predict.fun 积分规则的市场。

### 设置最低流动性要求

```bash
# 只显示 1% 流动性大于 $1000 的市场
MARKET_RECOMMEND_MIN_LIQUIDITY=1000
```

---

## API 接口

### MarketAnalyzer 类

```typescript
import { MarketAnalyzer } from './src/mm/market-analyzer.js';

const analyzer = new MarketAnalyzer(api);

// 计算 1% 流动性
const liquidity = analyzer.calculateLiquidityWithinRange(orderbook, midPrice, 0.01);

// 分析单个市场
const analysis = analyzer.analyzeMarket(market, orderbook, score);

// 批量分析市场
const analyses = await analyzer.analyzeMarkets(markets, scores);
```

### InteractiveMarketSelector 类

```typescript
import { InteractiveMarketSelector } from './src/cli/interactive-market-selector.js';

const selector = new InteractiveMarketSelector(api);

// 显示市场推荐
const result = await selector.showMarketRecommendations(markets, {
  topN: 20,
  minScore: 50,
  minLiquidity: 500,
  pointsOnly: false,
});

// 保存配置
await selector.saveConfiguration(result);
```

---

## 常见问题

### Q: 如何只选择高流动性市场？

A: 设置最低流动性要求：
```bash
MARKET_RECOMMEND_MIN_LIQUIDITY=1000
```

### Q: 如何只选择积分激活市场？

A: 设置只显示积分市场：
```bash
MARKET_RECOMMEND_POINTS_ONLY=true
```

### Q: 配置保存在哪里？

A: 配置保存在 `.env.market_selection` 文件，可以手动编辑或重新运行工具生成。

### Q: 如何在启动做市商时使用选择的配置？

A: 配置文件已保存，做市商会自动读取。或者设置：
```bash
INTERACTIVE_MARKET_SELECTION=true
```
这样每次启动都会运行交互式选择。

### Q: 1% 流动性是什么意思？

A: 表示当前价格上下 1% 范围内所有可交易的订单总量。这个指标越高，说明市场流动性越好，大额交易时滑点越小。

---

## 技术细节

### 市场评分算法

市场评分综合考虑以下因素：

1. **积分价值** (40% 权重)
   - 最小订单要求
   - 最大价差限制
   - 积分激活状态

2. **利润潜力** (35% 权重)
   - 当前价差
   - 流动性充足度
   - 深度分布

3. **风险评估** (25% 权重)
   - 24h 交易量
   - 订单簿深度
   - 价格波动

### 1% 流动性计算

```typescript
// 计算价格范围
const priceRange = midPrice * 0.01; // 1%
const lowerBound = midPrice - priceRange;
const upperBound = midPrice + priceRange;

// 累计买单流动性
for (const bid of orderbook.bids) {
  if (bid.price < lowerBound) break;
  bidShares += bid.shares;
  bidUsd += bid.shares * bid.price;
}

// 累计卖单流动性
for (const ask of orderbook.asks) {
  if (ask.price > upperBound) break;
  askShares += ask.shares;
  askUsd += ask.shares * ask.price;
}
```

### 推荐配置算法

```typescript
// 订单大小基于流动性
if (liquidity >= 2000) orderSize = 50;      // 高流动性
else if (liquidity >= 1000) orderSize = 25; // 中等流动性
else if (liquidity >= 500) orderSize = 15;  // 较低流动性
else orderSize = 10;                         // 低流动性

// 价差基于积分规则
if (pointsEligible && rules.max_spread) {
  recommendedSpread = min(currentSpread * 0.8, rules.max_spread * 0.9);
}
```

---

## 示例工作流

### 完整流程示例

```bash
# 1. 运行市场推荐工具
npm run market:recommend

# 2. 查看推荐列表
# (输入序号查看详情)

# 3. 选择市场
# (输入 1 查看第一个市场详情)

# 4. 配置参数
# (根据提示配置资金、股数、价差等)

# 5. 确认选择
# (输入 Y 确认)

# 6. 继续选择或退出
# (输入 q 完成)

# 7. 启动做市商
npm start
```

---

## 更新日志

### v1.0.0 (2025-02-22)

- ✅ 初始版本发布
- ✅ 市场分析器（1% 流动性计算）
- ✅ 交互式选择器
- ✅ 独立命令行工具
- ✅ 配置保存功能

---

## 反馈和支持

如有问题或建议，请：
1. 查看代码注释和类型定义
2. 检查 `.env.example` 配置说明
3. 运行 `npm run market:recommend` 查看实时提示

**祝交易顺利！🚀**
