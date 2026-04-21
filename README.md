# PredictFun Market Maker

自动挂单赚积分的做市商工具，支持 [Predict.fun](https://predict.fun?ref=B0CE6) 和 [Polymarket](https://polymarket.com)。

---

## 这个工具做什么？

**自动帮你在预测市场挂单赚 Maker Rebate 积分，不用盯盘。**

- 自动筛选高流动性、深度充足的安全市场
- 动态档位挂单（保守第4档 / 激进第3档），远离BBO基本不会被吃
- 盘口变化时自动撤单重挂，实时风控保护
- 7层防护机制 + 被吃自动冷却 + 黑名单
- 桌面App全流程操作，不需要写代码

---

## 快速开始

### 第1步：下载安装

去 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases/latest) 下载对应你系统的安装包：

| 系统 | 下载文件 | 安装方式 |
|------|----------|----------|
| Mac (M芯片) | `...arm64.dmg` | 双击打开，拖到 Applications |
| Windows | `...Setup.exe` | 双击安装，按提示走 |
| Linux (通用) | `...AppImage` | `chmod +x && ./` 运行 |
| Linux (Debian) | `...deb` | `sudo dpkg -i *.deb && sudo apt-get install -f` |

> **安全提示**：因为没有付费代码签名证书，首次打开会被系统拦截。
> - **Mac**：右键点 app → 打开，或终端执行 `xattr -cr /Applications/PredictFun\ Market\ Maker\ Lite.app`
> - **Windows**：点"更多信息" → "仍要运行"
> - **Linux AppImage**：确保装了 `libfuse2`：`sudo apt install libfuse2`

### 第2步：选择平台和模式

1. 打开App后，点击 **"套用 Predict 模板"** 或 **"套用 Polymarket 模板"**
2. 选择交易模式：
   - **🛡️ 保守模式**（推荐新手）— 动态第4档挂单，极低被吃概率
   - **⚡ 激进模式** — 动态第3档挂单，积分更多但偶尔可能被吃
3. 点击 **"应用当前模式参数到 .env"**

### 第3步：填写配置

点击模板后，编辑区会自动填好默认参数。你只需要改 **必填项**：

**Predict.fun 必填（3项）：**

```
API_KEY=你的 Predict API Key
PRIVATE_KEY=你的钱包私钥（不带0x）
PREDICT_ACCOUNT_ADDRESS=你的账户地址（0x开头）
```

**Polymarket 必填（2-3项）：**

```
POLYMARKET_PRIVATE_KEY=你的 Polymarket 私钥
POLYMARKET_FUNDER_ADDRESS=你的 Funder 地址
```

> Polymarket API 凭证建议用App里的 **"检查 Polymarket 预检"** 按钮自动派生，不用手动填。
> 实盘需要的是 **用户 CLOB API 凭证（L2）**，不是 Builder / Relayer key。

点击 **"保存配置"**。

### 第4步：获取认证（仅 Predict 需要）

1. 确保第3步的3项已填写并保存
2. 点击 **"🔑 获取 JWT Token"**
3. 等几秒，日志显示成功即可

### 第5步：验证账户

- **Predict**：点击 **"检查 Predict 余额"** 确认余额和授权状态
- **Polymarket**：点击 **"检查 Polymarket 预检"** 确认 API 凭证、USDC 余额、合约授权等全部通过

### 第6步：选择市场

1. 选择场馆（Predict / Polymarket）
2. 点击 **"自动推荐市场"**
3. 查看推荐结果（每个市场会显示盘口、奖励效率、风险记忆）
4. 点击 **"一键应用推荐"** 或手动勾选后点 **"应用手动勾选"**

### 第7步：启动做市

点击 **"启动做市"**，开始自动挂单赚积分！

需要停止时点 **"停止做市"**，会自动撤销所有挂单后安全退出。

---

## 策略详解

### 核心原理：动态档位挂单

不是在BBO旁边挂单（容易吃单），而是挂在订单簿的第N档价格：

```
订单簿示例（保守模式，挂第4档）：

  卖方          价格         买方
  ─────────────────────────────
  200股        51.5c     ← 第1档 ask（BBO）
  500股        51.0c     ← 第2档 ask
  800股        50.5c     ← 第3档 ask
  ★ 我们挂这里  50.0c     ← 第4档 ask（退让1.5c）
                          ─── 中间价 ───
  ★ 我们挂这里  49.0c     ← 第4档 bid（退让1.5c）
  1000股       48.5c     ← 第3档 bid
  600股        48.0c     ← 第2档 bid
  300股        47.5c     ← 第1档 bid（BBO）
```

**前面3层（保守）或2层（激进）订单帮你挡着**，只要这些单没被吃完，你就不会被动成交。而你的单仍然在订单簿上，持续赚 Maker 积分。

### 两种模式对比

| | 🛡️ 保守模式 | ⚡ 激进模式 |
|---|---|---|
| 挂单位置 | 第4档 | 第3档 |
| 退让距离 | +1.5c | +1.5c |
| 前方保护 | 3层订单簿 | 2层订单簿 |
| 绝对最低距离 | 3.5c | 3.0c |
| 前方最低深度 | 6000股/侧 | 4000股/侧 |
| 被吃后冷却 | 6小时 | 4小时 |
| 黑名单 | 2次被吃 → 封7天 | 2次被吃 → 封48小时 |
| 深度均衡检查 | 开启 | 关闭 |
| 适合 | 新手、稳赚积分 | 想要更多积分 |

### 7层防护机制

你的挂单在下单前要经过层层验证，任何一层不通过都不会下单：

1. **市场筛选（screenMarket）** — 7项检查确保市场安全：
   - 必须有活跃积分规则
   - 盘口价差不能太大（保守 ≤ 15% / 激进 ≤ 20% 的 max_spread）
   - 每侧缓冲要够（保守 ≥ 3.5c / 激进 ≥ 2.5c）
   - 前方深度要足（保守 ≥ 6000股 / 激进 ≥ 4000股）
   - 订单簿档位数要够（保守需4档 / 激进需3档，否则跳过）
   - 保守模式还检查买卖深度均衡（25%-75%）
   - 波动率不能太高（保守 < 0.5% / 激进 < 0.8%）

2. **档位定价（calculatePrices）** — 动态取第N档价格 + 智能填补
3. **硬距离验证（validatePriceDistance）** — 绝对不穿越BBO
4. **下单前最终验证（v22 BBO快照）** — tierPriced只查BBO不越界，毫秒级快照防止缓存过期
5. **下单后即时验证** — 200ms内检查单子是否合规，不合规立即撤
6. **被吃模式检测** — 连续被吃自动冷却 + 进黑名单
7. **持仓亏损保护** — 超限自动停机

---

## 配置详解

### 必填参数

| 参数 | 平台 | 说明 |
|------|------|------|
| `API_KEY` | Predict | 你的 Predict.fun API Key |
| `PRIVATE_KEY` | Predict | 钱包私钥（不带0x） |
| `PREDICT_ACCOUNT_ADDRESS` | Predict | 账户地址（0x开头） |
| `POLYMARKET_PRIVATE_KEY` | Polymarket | Polymarket 私钥 |
| `POLYMARKET_FUNDER_ADDRESS` | Polymarket | Funder 地址 |

### 核心参数（一般不用改）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `ORDER_SIZE` | 25 | 每笔挂单金额（美元），建议 ≥ 20 |
| `MAX_POSITION` | 100 | 单市场最大持仓（美元） |
| `MAX_DAILY_LOSS` | 200 | 每日最大亏损保护（美元） |
| `MAX_MARKETS` | 5 | 同时做市的市场数 |
| `MM_TRADING_MODE` | conservative | 交易模式：`conservative` 或 `aggressive` |

### Polymarket 风控参数（高级）

App已内置最佳默认值，一般不用改：

```env
POLYMARKET_REWARD_REQUIRE_ENABLED=true     # 只做有奖励的市场
POLYMARKET_REWARD_MIN_EFFICIENCY=0.0015    # 最低奖励效率
POLYMARKET_POST_ONLY_MIN_HIT_RATE=0.55     # 最低挂单命中率
POLYMARKET_POSITION_LOSS_LIMIT_ABS=25      # 单市场持仓亏损上限（美元）
```

---

## 命令行使用（高级用户）

```bash
# 1. 安装依赖
cd lite-release/predict-fun-market-maker-lite
npm install

# 2. 套用模板
npm run template:predict    # 或 template:polymarket

# 3. 编辑 .env 填写必填项（同上）

# 4. 获取JWT（仅Predict）
npm run auth:jwt

# 5. 授权合约（仅Predict首次）
npm run setup:approvals

# 6. 扫描推荐市场
npm run market:recommend -- --venue predict --top 10

# 7. 推荐并自动应用
npm run market:apply -- --venue predict --top 10

# 8. 启动做市
npm run start:mm
```

---

## 常见问题

**Q: 启动后看不到配置？**
A: Windows 看 `%APPDATA%\PredictFunMarketMakerLite\.env`，Mac 看 `~/.predict-fun-market-maker-lite/.env`

**Q: JWT 报错 "Authorization header invalid"？**
A: 你填了占位文本不是真JWT。点 "获取 JWT Token" 按钮自动获取。

**Q: 推荐市场为空？**
A: 当前模式下没有满足全部筛选条件的市场。可以尝试切换激进模式，或等市场流动性恢复。

**Q: 被吃单了怎么办？**
A: 检查日志中的 "POST_ONLY" 标记。系统会自动冷却该市场（保守6小时/激进4小时）。频繁被吃说明该市场深度不足，已自动拉黑。

**Q: 如何选择保守还是激进？**
A: 新手强烈建议保守模式。激进模式积分更多但偶尔会被吃。可以从保守开始，跑几天没有问题再考虑切换。

**Q: Polymarket 提示凭证不对？**
A: 实盘需要的是 **用户 CLOB API 凭证（L2）**，不是 Builder / Relayer key。用App里 "检查 Polymarket 预检" 自动检测，或参考 [Polymarket API 认证文档](https://docs.polymarket.com/cn/api-reference/authentication)。

---

## 文件位置

| 系统 | 配置目录 | 配置文件 |
|------|----------|----------|
| Mac | `~/.predict-fun-market-maker-lite/` | `.env` |
| Windows | `%APPDATA%\PredictFunMarketMakerLite\` | `.env` |
| Linux | `~/.config/predict-fun-market-maker-lite/` | `.env` |

---

## 推荐链接

- [Predict.fun](https://predict.fun?ref=B0CE6) - 预测市场平台
- [Polymarket](https://polymarket.com) - 预测市场平台
- [Polymarket API 认证文档](https://docs.polymarket.com/cn/api-reference/authentication)

---

## 免责声明

本工具仅供学习和研究用途。使用本工具进行交易的所有风险由用户自行承担。请先小额测试，确认理解所有参数后再加大资金。
