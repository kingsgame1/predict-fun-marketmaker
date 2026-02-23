# 🎯 扫尾盘套利 - 完整判断指南

## 核心问题

1. **什么时候**进行扫尾盘买入？
2. **如何**判断确定性？

---

## 一、时机判断：什么时候扫尾盘？

### 1.1 时间窗口定义

```
┌─────────────────────────────────────────────────────┐
│                    市场生命周期                          │
├─────────────────────────────────────────────────────┤
│                                                            │
│  📅 早期阶段          │  📈 中期阶段        │  🏁 尾盘阶段    │
│  (结算前7-30天)    │  (结算前1-7天)     │  (结算前24h)    │
│                                                            │
│  ❌ 不适合扫尾盘    │  ⚠️ 观察期         │  ✅ 最佳时机     │
│                                                            │
└─────────────────────────────────────────────────────┘
```

### 1.2 尾盘阶段特征

**时间范围：结算前 24小时内**

| 距离结算 | 确定性 | 流动性 | 最佳策略 |
|----------|--------|--------|----------|
| 24-12小时 | 70-80% | 充足 | 开始观察 |
| 12-6小时 | 80-90% | 较好 | 准备入场 |
| 6-1小时 | 90-95% | 减少 | ⚡ 最佳时机 |
| 1小时内 | 95-99% | 极少 | 🔥 临界点 |

### 1.3 最佳入场时机

**黄金时间窗口：结算前 1-6 小时**

```yaml
✅ 满足条件：
  - 时间：结算前 1-6 小时
  - 确定性：≥ 95%
  - 价格：获胜者 YES 0.90-0.98
  - 流动性：≥ $1000
  - 验证数据：已确认

⚠️ 警告信号：
  - 时间：< 1小时（来不及）
  - 流动性：< $500（无法成交）
  - 价格差异常（可能数据错误）
```

### 1.4 实时监控指标

```javascript
// 时机判断逻辑
function isOptimalTiming(market) {
  const hoursToSettlement = (market.settlementTime - Date.now()) / (1000 * 60 * 60);

  // ✅ 进入尾盘窗口（结算前24小时内）
  if (hoursToSettlement > 24) {
    return { ready: false, reason: '尚未进入尾盘窗口' };
  }

  // ✅ 最佳时机（结算前1-6小时）
  if (hoursToSettlement >= 1 && hoursToSettlement <= 6) {
    return { ready: true, urgency: 'high' };
  }

  // ⚠️ 太晚了（< 1小时）
  if (hoursToSettlement < 1) {
    return { ready: false, reason: '时间不足，无法执行' };
  }

  return { ready: true, urgency: 'medium' };
}
```

---

## 二、确定性判断：如何验证结果？

### 2.1 确定性维度

```
                    综合确定性
                        │
        ┌───────────────┼───────────────┐
        │               │               │
    价格信号         时机因素         验证数据
    (30%权重)       (20%权重)       (50%权重)
```

### 2.2 价格信号分析

#### A. 价格离散度

**原理**：如果有一个选项价格远高于其他，说明市场已经有确定性

```javascript
// 价格离散度计算
const prices = [0.95, 0.08, 0.06, 0.04, 0.03, 0.02]; // 6部电影YES价格
const variance = calculateVariance(prices);

// 高离散度 = 高确定性
if (variance > 0.3) {
  certainty += 0.3; // +30% 确定性
}
```

**判断标准**：

| 价格离散度 | 确定性 | 说明 |
|----------|--------|------|
| < 0.1 | 低 | 市场分歧大，无明确倾向 |
| 0.1-0.2 | 中 | 市场有倾向但不明显 |
| 0.2-0.3 | 高 | 市场有明显偏好 |
| > 0.3 | 很高 | 市场基本确定 |

#### B. 市场效率

**原理**：价格是否合理，是否在有效范围内

```javascript
// 市场效率检查
const yesPrices = [0.95, 0.08, 0.06, 0.04, 0.03, 0.02];
const inRange = yesPrices.filter(p => p >= 0.01 && p <= 0.99);
const efficiency = inRange.length / yesPrices.length;

if (efficiency > 0.8) {
  certainty += 0.1; // +10% 确定性
}
```

#### C. 流动性深度

**原理**：订单簿深度充足说明价格可靠

```javascript
// 流动性评估
const liquidityScore = assessLiquidity(orderBook);

if (liquidityScore > 0.7) {
  certainty += 0.1; // +10% 确定性
}
```

### 2.3 时机因素分析

#### A. 距离结算时间

```yaml
距离结算 > 7天：
  确定性: 30-50%
  建议: 观察期，不做操作

距离结算 1-7天：
  确定性: 50-70%
  建议: 小仓位测试

距离结算 6-1小时：
  确定性: 80-95%
  建议: ⚡ 最佳时机

距离结算 < 1小时：
  确定性: 95-99%
  建议: 🔥 临界点，但需谨慎
```

#### B. 紧迫度等级

| 距离结算 | 紧迫度 | 行动建议 |
|----------|--------|----------|
| 12-24小时 | 低 | 开始准备 |
| 6-12小时 | 中 | 密切监控 |
| 1-6小时 | 高 | 准备入场 |
| < 1小时 | 极高 | 最后机会 |

### 2.4 验证数据判断

这是**最重要**的部分（占50%权重）

#### A. 数据源类型

**票房冠军市场**：
```javascript
// 数据源1: 票房实时数据
const boxOfficeData = {
  api: '猫眼/淘票票/艺恩',
  lastUpdate: Date.now(),
  reliability: 0.9, // 90% 可靠
  ranking: [
    { name: '飞驰人生3', boxOffice: 1500000000 },
    { name: '热辣滚烫', boxOffice: 800000000 }
  ]
};

// 数据源2: 社交媒体热度
const socialData = {
  platform: '微博/豆瓣',
  mentions: {
    '飞驰人生3': 150000,
    '热辣滚烫': 30000
  }
};
```

**选举市场**：
```javascript
// 数据源1: 官方计票数据
const electionData = {
  official: true,
  reliability: 0.95, // 95% 可靠
  results: [
    { name: '候选人A', votes: 1500000 },
    { name: '候选人B', votes: 800000 }
  ]
};

// 数据源2: 出口民调
const pollData = {
  reliability: 0.85,
  samples: 10000,
  results: { '候选人A': 0.65 }
};
```

#### B. 数据可靠性评分

| 数据源 | 可靠性 | 权重 | 说明 |
|--------|--------|------|------|
| 官方计票 | 95% | 高 | 最可靠 |
| 票房实时数据 | 90% | 高 | 很可靠 |
| 出口民调 | 85% | 中-高 | 较可靠 |
| 社交媒体 | 60% | 低-中 | 参考性 |
| 专家预测 | 50% | 低 | 不确定 |

#### C. 数据新鲜度

```javascript
// 数据新鲜度检查
const dataAge = (Date.now() - verification.lastUpdate) / (1000 * 60 * 60);

if (dataAge < 1) {
  certainty += 0.1; // +10% 数据很新
} else if (dataAge < 6) {
  certainty += 0.05; // +5% 数据可接受
} else if (dataAge > 6) {
  certainty -= 0.2; // -20% 数据过时
}
```

### 2.5 综合确定性计算

```javascript
// 综合确定性评分算法
function calculateCertaintyLevel(priceSignals, timing, verification) {
  let certainty = 0.5; // 基础50%

  // 1. 价格信号 (30%权重)
  if (priceSignals.priceVariance > 0.3) {
    certainty += 0.3; // 价格离散度高
  }
  if (priceSignals.marketEfficiency > 0.7) {
    certainty += 0.1; // 市场效率高
  }

  // 2. 时机因素 (20%权重)
  if (timing.isSweepZone) {
    certainty += 0.2; // 进入尾盘
    if (timing.hoursToSettlement <= 6) {
      certainty += 0.1; // 结算前6小时
    }
  }

  // 3. 验证数据 (50%权重)
  if (verification.hasExternalData) {
    certainty += verification.reliability * 0.5;
  }

  return Math.min(0.99, certainty); // 最高99%
}
```

---

## 三、实战示例

### 示例：2026春节票房冠军

#### 步骤1：时机判断

```javascript
const settlementTime = new Date('2026-02-15 00:00:00').getTime();
const now = new Date().getTime();
const hoursToSettlement = (settlementTime - now) / (1000 * 60 * 60);

// 假设现在是 2月14日 20:00
// hoursToSettlement = 4 小时 ✅ 在最佳窗口内
```

#### 步骤2：价格信号分析

```javascript
const yesPrices = {
  '飞驰人生3': 0.95,
  '热辣滚烫': 0.08,
  '第二十条': 0.06,
  '熊出没': 0.04,
  '红毯先生': 0.03,
  '其他电影': 0.02
};

// 价格离散度
const variance = calculateVariance(Object.values(yesPrices));
// variance ≈ 0.35 > 0.3 ✅ 高确定性

// 市场效率
const efficiency = 1.0; // 所有价格都在有效范围
// efficiency = 1.0 ✅
```

#### 步骤3：获取验证数据

```javascript
// 从票房API获取实时数据
const boxOfficeData = await fetchBoxOfficeAPI();

const currentRanking = [
  { name: '飞驰人生3', boxOffice: 1500000000 },
  { name: '热辣滚烫', boxOffice: 800000000 },
  { name: '第二十条', boxOffice: 600000000 }
];

// 飞驰人生3遥遥领先！
// verification.reliability = 0.9 ✅
```

#### 步骤4：综合判断

```javascript
const certainty = calculateCertaintyLevel(
  priceSignals,
  timing,
  verification
);

// certainty = 0.5(基础) + 0.3(价格) + 0.2(时机) + 0.45(验证) = 0.945
// certainty = 94.5% ✅ 超过95%阈值

// 判断结果
const shouldTrade = certainty >= 0.95; // 接近阈值
const strategy = certainty >= 0.95 ? 'both' : 'hedge_arb';
```

---

## 四、自动化监控系统

### 4.1 实时监控流程

```javascript
// 每分钟扫描一次市场
setInterval(async () => {
  const markets = await getAllMarkets();

  for (const market of markets) {
    // 1. 过滤多结果市场
    if (market.outcomes.length < 3) continue;

    // 2. 评估确定性
    const assessment = await assessCertainty(market);

    // 3. 判断是否应该行动
    if (assessment.recommendation.shouldTrade) {
      console.log(`🎯 发现机会: ${market.marketTitle}`);
      console.log(`   确定性: ${(assessment.confidence * 100).toFixed(1)}%`);
      console.log(`   策略: ${assessment.recommendation.strategy}`);

      // 4. 发送通知
      sendNotification({
        title: '确定性尾盘套利机会',
        body: `市场: ${market.marketTitle}\n确定性: ${(assessment.confidence * 100).toFixed(1)}%`,
        urgency: assessment.timing.urgency
      });

      // 5. 如果是自动模式，执行套利
      if (config.autoExecute) {
        await executeSweepArbitrage(market);
      }
    }
  }
}, 60000); // 每分钟
```

### 4.2 配置监控参数

```yaml
# 监控配置
monitoring:
  scan_interval_ms: 60000      # 每分钟扫描一次
  sweep_window_hours: 24      # 结算前24小时开始监控
  min_certainty: 0.95         # 最低确定性95%
  min_liquidity: 1000         # 最低流动性$1000
  auto_execute: false         # 自动执行（建议先手动）

# 通知配置
notifications:
  enabled: true
  channels:
    - desktop                  # 桌面通知
    - email                    # 邮件通知
    - telegram                 # Telegram机器人

# 数据源配置
data_sources:
  box_office_api:
    enabled: true
    provider: 'maoyan'        # 猫眼/淘票票
    update_interval: 3600    # 每小时更新

  election_api:
    enabled: true
    provider: 'official'      # 官方数据
    update_interval: 1800    # 每30分钟更新
```

---

## 五、判断流程图

```
                    开始监控
                        │
                        ▼
              ┌───────────────────┐
              │ 扫描所有多结果市场 │
              │   (≥3个结果)      │
              └───────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  分析价格信号      │
              │  - 价格离散度     │
              │  - 市场效率       │
              │  - 流动性深度     │
              └───────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  检查时机因素      │
              │  - 距离结算时间   │
              │  - 是否进入尾盘    │
              └───────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  获取验证数据      │
              │  - 票房数据        │
              │  - 选举数据        │
              │  - 官方统计        │
              └───────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  综合计算确定性    │
              │  = 价格(30%)       │
              │    + 时机(20%)     │
              │    + 验证(50%)     │
              └───────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  确定性 ≥ 95%?    │
              └───────────────────┘
                   │/      │
                 No       Yes
                  │        │
                  ▼        ▼
            继续监控   执行套利
```

---

## 六、快速决策表

| 时机 | 价格离散度 | 验证数据 | 建议 |
|------|-----------|---------|------|
| >24h | - | - | ❌ 观察期 |
| 6-24h | >0.2 | 有 | ⚠️ 准备期 |
| 1-6h | >0.3 | 有 | ✅ 最佳时机 |
| 1-6h | >0.3 | 无 | ⚠️ 谨慎 |
| <1h | - | - | ❌ 时间不足 |

---

## 七、实用建议

### 7.1 最佳实践

1. **提前准备**
   - 结算前6-12小时开始监控
   - 准备好验证数据源API
   - 设置好通知系统

2. **多重验证**
   - 至少2个独立数据源
   - 交叉验证结果
   - 定期更新数据

3. **风险控制**
   - 不要在确定性<90%时入场
   - 设置止损（虽然概率很低）
   - 控制单次仓位（建议<30%）

4. **时机把握**
   - 最佳窗口：结算前1-6小时
   - 避开最后1小时（流动性风险）
   - 关注市场突发新闻

### 7.2 禁忌情况

❌ **不要在以下情况下交易：**
- 确定性 < 90%
- 距离结算 < 1小时
- 流动性 < $500
- 没有验证数据
- 市场有突发新闻

---

## 总结

**什么时候扫尾盘？**
→ 结算前 1-6 小时

**如何判断确定性？**
→ 价格信号(30%) + 时机因素(20%) + 验证数据(50%)

**关键指标：**
- 价格离散度 > 0.3
- 验证数据可靠性 > 90%
- 数据新鲜度 < 6小时
- 流动性 > $1000

---

**版本**: 1.0.0
**更新**: 2026-02-23
**基于**: 实战经验和市场数据分析
