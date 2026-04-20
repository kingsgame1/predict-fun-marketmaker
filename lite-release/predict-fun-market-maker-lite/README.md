# PredictFun Market Maker Lite v2.2.1

自动挂单赚积分的做市商工具，支持 [Predict.fun](https://predict.fun?ref=B0CE6) 和 [Polymarket](https://polymarket.com)。

---

## 这个工具做什么？

简单说：**自动帮你在预测市场挂单赚积分（Maker Rebate），不用盯盘。**

- 自动选择高流动性的市场
- 在安全的价位挂买单和卖单（二档优先）
- 盘口变化时自动撤单重挂
- 赚取做市积分奖励

---

## 快速开始（桌面App，推荐新手）

### 第1步：下载安装

去 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases/latest) 下载对应你系统的安装包：

| 系统 | 下载文件 | 说明 |
|------|----------|------|
| Mac (M芯片) | `PredictFun Market Maker Lite-2.2.1-arm64.dmg` | 双击安装，拖到Applications |
| Windows | `PredictFun Market Maker Lite Setup 2.2.1.exe` | 双击安装，按提示走 |
| Linux (x64) | `predict-fun-market-maker-lite-app_2.2.1_amd64.deb` | `sudo dpkg -i *.deb && sudo apt-get install -f` |
| Linux (arm64) | `predict-fun-market-maker-lite-app_2.2.1_arm64.deb` | 同上 |
| Linux (AppImage) | `PredictFun Market Maker Lite-2.2.1.AppImage` | `chmod +x && ./` 即可运行 |

### 第2步：选择平台

打开App后，顶部选择你要做市的平台：
- **Predict** = Predict.fun
- **Polymarket** = Polymarket

然后点击 **"套用xxx模板"** 按钮。

### 第3步：填写配置

点击模板后，编辑区会自动填好默认参数。你只需要改 **必填项**：

**Predict.fun 必填（3项）：**

```
API_KEY=你的API Key
PRIVATE_KEY=你的钱包私钥（不带0x）
PREDICT_ACCOUNT_ADDRESS=你的账户地址（0x开头）
```

**Polymarket 必填（2-3项）：**

```
POLYMARKET_PRIVATE_KEY=你的Polymarket私钥
POLYMARKET_FUNDER_ADDRESS=你的Funder地址
```

> Polymarket API Key 建议用App里的 **"检查Polymarket预检"** 按钮自动派生，不用手动填。

点击 **"保存配置"**。

### 第4步：获取JWT（仅Predict需要）

1. 确保第3步的3项已填写并保存
2. 点击 **"获取JWT Token"**
3. 等几秒，日志显示成功即可

### 第5步：选择市场

1. 点击 **"自动推荐市场"**
2. 等推荐结果出来（会显示每个市场的价差、深度、可挂容量）
3. 点击 **"一键应用推荐"** 或手动勾选后点 **"应用手动勾选"**

### 第6步：启动做市

点击 **"启动做市"**，开始自动挂单赚积分！

需要停止时点 **"停止做市"**，会自动撤销所有挂单。

---

## 配置详解

### 核心参数（一般不用改）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `ORDER_SIZE` | 25 | 每笔挂单金额（美元），建议 >= 20 |
| `MAX_POSITION` | 100 | 最大持仓（美元） |
| `MAX_DAILY_LOSS` | 200 | 每日最大亏损保护（美元） |
| `SPREAD` | 0.015 | 基础价差 1.5% |
| `MAX_MARKETS` | 5 | 同时做市的市场数 |

### Polymarket 风控参数

App已内置最佳默认值，一般不用改。高级用户可以微调：

```env
POLYMARKET_REWARD_REQUIRE_ENABLED=true     # 只做有奖励的市场
POLYMARKET_REWARD_MIN_EFFICIENCY=0.0015    # 最低奖励效率
POLYMARKET_POST_ONLY_MIN_HIT_RATE=0.55     # 最低挂单命中率（低于此暂停）
POLYMARKET_POSITION_LOSS_LIMIT_ABS=25      # 单市场持仓亏损上限（美元）
```

---

## 策略说明

### 核心原则：安全挂单赚积分

1. **二档优先**：不贴着一档（买一/卖一）挂单，而是挂在更安全的二档位置，大幅降低被吃概率
2. **保守/激进双模式**：
   - 保守模式（默认）：价格必须远离BBO足够距离才挂单
   - 激进模式：可以更接近BBO，但仍然检查不穿越
3. **7层防护机制**：
   - 硬距离验证（绝对不穿越BBO）
   - 盘口变化实时监控
   - 异常波动自动撤单
   - 下单后即时验证
   - 库存风险自动调整
   - 成交模式检测（被吃太多次自动暂停）
   - 持仓亏损保护

4. **优雅停机**：停止做市时先撤完所有挂单再退出

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
A: Windows看 `%APPDATA%\PredictFunMarketMakerLite\.env`，Mac看 `~/.predict-fun-market-maker-lite/.env`

**Q: JWT报错 "Authorization header invalid"？**
A: 你填了占位文本不是真JWT。点"获取JWT Token"按钮自动获取。

**Q: Linux AppImage打不开？**
A: `chmod +x *.AppImage`，然后确认装了 `libfuse2`：`sudo apt install libfuse2`

**Q: Ubuntu装deb后启动不了？**
A: `sudo apt-get install -f` 补齐依赖

**Q: 被吃单了怎么办？**
A: 检查日志中的"POST_ONLY"标记。默认保守模式会尽量远离BBO。如果频繁被吃，可以减小 `ORDER_SIZE` 或只选深度更好的市场。

**Q: Windows弹出安全警告？**
A: 因为没有付费代码签名证书，点"更多信息"→"仍要运行"即可。

**Q: Mac提示"无法打开，因为无法验证开发者"？**
A: 右键点dmg→打开，或终端执行 `xattr -cr /Applications/PredictFun\ Market\ Maker\ Lite.app`

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
- [Polymarket API认证文档](https://docs.polymarket.com/cn/api-reference/authentication)

---

## 免责声明

本工具仅供学习和研究用途。使用本工具进行交易的所有风险由用户自行承担。请先小额测试，确认理解所有参数后再加大资金。
