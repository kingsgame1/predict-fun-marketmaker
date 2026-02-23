# 🚀 快速开始指南 - 优化版本

## 5分钟快速启动

### 步骤1：选择配置模板（30秒）

```bash
cd predict-fun-market-maker

# 新手用户推荐：
cp config/templates/.conservative-template.env .env

# 或经验用户：
cp config/templates/.aggressive-template.env .env
```

### 步骤2：配置API密钥（1分钟）

```bash
vim .env
```

**必须配置的参数**：

```env
# ============ 必填项 ============
# Predict/Probable API
API_BASE_URL=https://api.predict.fun  # 或 https://api.probable.markets
API_KEY=your_api_key_here
JWT_TOKEN=your_jwt_token_here

# 钱包配置
PRIVATE_KEY=your_private_key_here
PREDICT_ACCOUNT_ADDRESS=your_account_address

# RPC节点（BNB Chain）
RPC_URL=https://bsc-dataseed.binance.org

# ============ 建议调整 ============
# 根据你的资金调整
MAX_POSITION_SIZE=0.05          # 单次最大5%仓位
MAX_TOTAL_POSITION=0.15         # 总最大15%仓位

# 根据你的风险偏好调整
MIN_PROFIT_PERCENT=2.0          # 最低2%利润
MIN_LIQUIDITY_USD=5000          # 最低$5000流动性

# ============ 先模拟测试 ============
SIMULATION_MODE=true            # ⚠️ 先用模拟模式测试
```

### 步骤3：模拟测试（2分钟）

```bash
# 启动模拟交易
npm start

# 观察日志输出：
# ✅ 机会质量评分: 85/100
# ✅ 建议仓位: 10%
# ✅ 执行套利成功: +$12.50
```

**预期看到**：
- 机会质量评分（0-100分）
- 执行建议（执行/跳过）
- 模拟盈利结果

### 步骤4：查看统计报告（1分钟）

```bash
# 生成执行统计报告
node --import tsx -e "
import { generateStatsReport } from './src/execution-stats.js';
console.log(generateStatsReport());
"

# 导出CSV（可选）
node --import tsx -e "
import { getGlobalTracker } from './src/execution-stats.js';
getGlobalTracker().exportCSV('./data/stats.csv');
"
```

### 步骤5：切换到实盘（30秒）

⚠️ **确认模拟测试结果满意后再切换**

```bash
vim .env
```

修改：
```env
SIMULATION_MODE=false  # 改为 false
```

```bash
# 启动实盘交易
npm start
```

---

## 📊 理解机会质量评分

### 评分系统

```
质量评分 (0-100)
├── 利润潜力 (30%)     ← 利润率 + 绝对利润
├── 风险水平 (25%)     ← 市场年龄 + 流动性 + 价格平衡
├── 流动性 (20%)       ← 买一/卖一量 + 订单簿深度
├── 价格质量 (15%)     ← 买卖价差 + 价格合理性
└── 时机评分 (10%)     ← 历史表现 + 成功率
```

### 质量等级

| 分数 | 等级 | 含义 | 仓位 | 建议 |
|------|------|------|------|------|
| 90+ | 🌟 优秀 | Excellent | 20% | ✅ 立即执行 |
| 75+ | ✅ 良好 | Good | 15% | ✅ 可以执行 |
| 60+ | ⚠️ 一般 | Fair | 10% | ⚠️ 谨慎执行 |
| 40+ | ❌ 较差 | Poor | 0% | ❌ 不建议 |
| <40 | ⏭️ 跳过 | Skip | 0% | ❌ 跳过 |

### 示例输出

```
✅ 机会质量评分: 82/100
   ├── 利润潜力: 28/30 (93%)
   ├── 风险水平: 18/25 (72%)
   ├── 流动性: 16/20 (80%)
   ├── 价格质量: 12/15 (80%)
   └── 时机评分: 8/10 (80%)

✅ 建议: 立即执行
✅ 建议仓位: 15%
✅ 理由: 良好机会，可以执行

⚠️ 警告: 市场存在时间较短 (15分钟)
```

---

## 🎯 配置参数说明

### 保守配置（推荐新手）

```env
# 最低要求（严格）
MIN_PROFIT_PERCENT=2.0           # 至少2%利润
MIN_LIQUIDITY_USD=5000           # 至少$5000流动性
MIN_ORDER_BOOK_DEPTH=2000        # 至少$2000订单簿深度
MIN_QUALITY_SCORE=70             # 最低70分

# 风险控制（保守）
MAX_POSITION_SIZE=0.05           # 单次5%仓位
MAX_TOTAL_POSITION=0.15          # 总15%仓位
MAX_SLIPPAGE_PERCENT=0.5         # 最大0.5%滑点

# 市场过滤（安全）
SKIP_NEW_MARKETS=true            # 跳过新市场
SKIP_LOW_VOLUME_MARKETS=true     # 跳过低交易量
MIN_VOLUME_USD=10000             # 最低$10k交易量
MIN_AGE_HOURS=1                  # 至少1小时

# 安全限制
DAILY_MAX_EXECUTIONS=20           # 每日最多20次
DAILY_MAX_LOSS_USD=50             # 每日最大亏损$50
```

**预期结果**：
- 成功率：90%+
- 每日执行：5-15次
- 平均利润：2-3%
- 最大回撤：<5%

### 激进配置（经验用户）

```env
# 最低要求（宽松）
MIN_PROFIT_PERCENT=0.5           # 至少0.5%利润
MIN_LIQUIDITY_USD=1000           # 至少$1000流动性
MIN_ORDER_BOOK_DEPTH=500         # 至少$500订单簿深度
MIN_QUALITY_SCORE=40             # 最低40分

# 风险控制（激进）
MAX_POSITION_SIZE=0.2            # 单次20%仓位
MAX_TOTAL_POSITION=0.6           # 总60%仓位
MAX_SLIPPAGE_PERCENT=2.0         # 最大2%滑点

# 市场过滤（参与所有）
SKIP_NEW_MARKETS=false           # 不跳过新市场
SKIP_LOW_VOLUME_MARKETS=false    # 不过滤低交易量
MIN_VOLUME_USD=1000              # 最低$1k交易量
MIN_AGE_HOURS=0.1                # 至少6分钟

# 策略启用
HIGH_FREQ_ENABLED=true           # 启用高频
SUPER_HF_ENABLED=true            # 启用超级高频
ENABLE_ALL_STRATEGIES=true       # 所有7大策略
```

**预期结果**：
- 成功率：70-85%
- 每日执行：30-100次
- 平均利润：1-2%
- 最大回撤：10-20%

---

## 📈 查看和分析结果

### 实时日志

```bash
# 启动后实时查看日志
npm start

# 重要日志标记：
✅ 机会质量评分: 85/100         # 机会评估
✅ 执行套利成功: +$15.30         # 执行成功
❌ 跳过低质量机会: 评分不足     # 跳过低质量
⚠️ 警告: 流动性不足             # 风险警告
```

### 统计报告

```bash
# 生成详细报告
node --import tsx scripts/generate-report.ts

# 报告内容：
# - 总体统计（执行次数、成功率）
# - 财务统计（盈利、亏损、净利）
# - 执行统计（执行时间、滑点）
# - 资金效率（使用率、效率比率）
# - 绩效指标（夏普比率、最大回撤）
# - 按策略统计（各策略表现）
# - 按市场统计（各市场表现）
```

### 导出分析

```bash
# 导出CSV用于Excel分析
node --import tsx scripts/export-csv.ts

# 在Excel中打开：
open data/stats.csv

# 可以进行：
# - 数据透视分析
# - 图表可视化
# - 自定义计算
```

---

## 🔧 常见问题排查

### 问题1：没有找到任何机会

**可能原因**：
1. `MIN_PROFIT_PERCENT` 设置太高
2. `MIN_LIQUIDITY_USD` 设置太高
3. `MIN_QUALITY_SCORE` 设置太高

**解决方案**：
```env
# 逐步降低要求
MIN_PROFIT_PERCENT=1.0           # 从2.0降到1.0
MIN_LIQUIDITY_USD=2000           # 从5000降到2000
MIN_QUALITY_SCORE=60             # 从70降到60
```

### 问题2：机会很多但执行很少

**可能原因**：
1. 机会质量评分低，被过滤
2. 风险警告过多

**解决方案**：
```env
# 降低质量要求
MIN_QUALITY_SCORE=50             # 降低到50

# 查看具体警告
# 在日志中搜索 "警告:" 了解原因
```

### 问题3：滑点过大

**可能原因**：
1. 流动性不足
2. 订单簿深度不够
3. 仓位过大

**解决方案**：
```env
# 提高流动性要求
MIN_LIQUIDITY_USD=10000          # 提高到$10k

# 降低最大滑点
MAX_SLIPPAGE_PERCENT=0.3         # 从0.5降到0.3

# 减小仓位
MAX_POSITION_SIZE=0.03           # 从0.05降到0.03
```

### 问题4：成功率低

**可能原因**：
1. 配置太激进
2. 市场选择不当

**解决方案**：
```env
# 切换到保守配置
cp config/templates/.conservative-template.env .env

# 或手动调整：
SKIP_NEW_MARKETS=true            # 跳过新市场
SKIP_VOLATILE_MARKETS=true       # 跳过高波动市场
MIN_AGE_HOURS=2                  # 至少2小时
```

---

## 🎓 学习路径

### 第1天：熟悉系统

1. ✅ 阅读 `docs/IMMEDIATE_OPTIMIZATIONS.md`
2. ✅ 使用保守配置启动模拟模式
3. ✅ 观察日志和机会评分
4. ✅ 查看统计报告

### 第2-3天：模拟测试

1. ✅ 尝试不同配置参数
2. ✅ 观察对结果的影响
3. ✅ 导出CSV进行分析
4. ✅ 理解各项指标含义

### 第4-7天：小资金实盘

1. ✅ 切换到实盘模式
2. ✅ 设置小仓位（1-3%）
3. ✅ 密切监控执行
4. ✅ 记录和分析结果

### 第2周：逐步增加

1. ✅ 根据第一周结果调整参数
2. ✅ 逐步增加到目标仓位
3. ✅ 启用更多策略（如高频）
4. ✅ 持续优化配置

### 第3-4周：优化提升

1. ✅ 分析成功/失败案例
2. ✅ 调整质量评分权重
3. ✅ 尝试激进配置（小资金）
4. ✅ 找到最适合自己的配置

---

## 📞 获取帮助

### 文档

- **完整优化指南**: `docs/IMMEDIATE_OPTIMIZATIONS.md`
- **确定性尾盘套利**: `docs/DETERMINISTIC_SWEEP_GUIDE.md`
- **时机判断指南**: `docs/SWEEP_TIMING_GUIDE.md`
- **第二档策略**: `docs/PROBABLE_SECOND_LAYER_STRATEGY.md`

### 日志调试

```bash
# 启用调试日志
vim .env
LOG_LEVEL=debug

# 查看详细日志
npm start 2>&1 | tee debug.log
```

### 性能分析

```bash
# 查看执行统计
cat data/execution-stats.json | jq .

# 生成图表（如果有可视化工具）
node --import tsx scripts/generate-charts.ts
```

---

## ✅ 检查清单

在启动实盘交易前，确保：

- [ ] 已完成至少1天模拟测试
- [ ] 理解机会质量评分系统
- [ ] 配置适合的风险参数
- [ ] 设置了合理的止损限制
- [ ] 准备好足够的储备金
- [ ] 了解如何查看统计报告
- [ ] 知道如何紧急停止（Ctrl+C）
- [ ] 已阅读并理解所有警告

---

**版本**: 1.0.0
**更新**: 2026-02-22
**作者**: Predict.fun Team

祝你交易顺利！🚀
