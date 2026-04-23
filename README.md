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

## 快速开始（桌面App）

### 第1步：下载安装

去 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases/latest) 下载对应你系统的安装包：

| 系统 | 下载文件 | 安装方式 |
|------|----------|----------|
| Mac (M芯片) | `PredictFun.Market.Maker-x.x.x-arm64.dmg` | 双击打开，拖到 Applications |
| Mac (Intel) | `PredictFun.Market.Maker-x.x.x-x64.dmg` | 双击打开，拖到 Applications |
| Windows | `PredictFun.Market.Maker-x.x.x-x64.exe` | 双击即可运行（便携版） |
| Linux (Debian/Ubuntu) | `PredictFun.Market.Maker-x.x.x-amd64.deb` | `sudo dpkg -i *.deb && sudo apt-get install -f` |
| Linux (通用) | `PredictFun.Market.Maker-x.x.x-x86_64.AppImage` | `chmod +x *.AppImage && ./*.AppImage` |
| Linux (ARM) | `PredictFun.Market.Maker-x.x.x-arm64.AppImage` | `chmod +x *.AppImage && ./*.AppImage` |

> **安全提示**：因为没有付费代码签名证书，首次打开会被系统拦截。
> - **Mac**：系统偏好设置 → 安全与隐私 → 通用 → 点击"仍然允许"，或终端执行 `xattr -cr /Applications/PredictFun\ Market\ Maker.app`
> - **Windows**：点"更多信息" → "仍要运行"
> - **Linux AppImage**：确保装了 `libfuse2`：`sudo apt install libfuse2`

### 第2步：启动App

打开App后，会看到一个终端风格的控制台界面。首先检查顶部"系统状态"卡片，确保：
- Node.js ✅
- npm ✅
- 项目文件 ✅
- 配置文件 ✅

如果配置文件显示❌，点击"打开配置目录"按钮，在弹出的目录中编辑 `.env` 文件（见第3步）。

### 第3步：填写配置

在App右侧的**参数配置**面板中，填写以下必填项：

**通用配置：**

```
ORDER_SIZE=100              # 每笔挂单金额（美元），建议 ≥ 100
MAX_POSITION=100            # 单市场最大持仓（美元）
ENABLE_TRADING=true         # 是否开启真实交易（false=模拟测试）
```

**Predict.fun 必填（3项）：**

在认证面板的 Predict.fun 区域填写：

```
API_KEY=your_predict_api_key_here
PRIVATE_KEY=your_private_key_here        # 不带 0x 前缀
PREDICT_ACCOUNT_ADDRESS=0x...            # 你的钱包地址（0x开头）
```

- `API_KEY`：从 [Predict.fun](https://predict.fun) 获取
- `PRIVATE_KEY`：你的钱包私钥
- `PREDICT_ACCOUNT_ADDRESS`：对应的公开地址

**Polymarket 必填（2-3项）：**

在认证面板的 Polymarket 区域填写：

```
POLYMARKET_PRIVATE_KEY=your_polymarket_private_key
POLYMARKET_FUNDER_ADDRESS=your_funder_address
```

- `POLYMARKET_PRIVATE_KEY`：Polymarket 钱包私钥
- `POLYMARKET_FUNDER_ADDRESS`：你的 Funder 地址

> 点击认证面板中的"检查 Polymarket 预检"按钮，可以自动检测API凭证、USDC余额和合约授权状态。

填完后点击"保存配置"，会自动刷新系统状态。

### 第4步：选择模式

1. 在"交易模式"区域选择：
   - **保守模式**（推荐新手）— 动态第4档挂单，极低被吃概率
   - **激进模式** — 动态第3档挂单，积分更多但偶尔可能被吃

2. 在"被吃对冲模式"区域选择：
   - **FLATTEN**（平仓）— 被吃后同时买回YES和NO，恢复中性持仓
   - **BUY_OPPOSITE**（买反对边）— 被吃后只买反对边，保留方向性观点

3. 点击"应用当前模式参数到 .env"

### 第5步：获取JWT（仅Predict需要）

1. 确保已填写 API_KEY、PRIVATE_KEY 和 PREDICT_ACCOUNT_ADDRESS
2. 在Predict.fun认证面板点击 **"获取 JWT"**
3. 等待几秒，日志显示成功即可

### 第6步：选择市场

1. 在"市场推荐"区域，点击"刷新市场"
2. 切换 Predict/Polymarket Tab查看推荐
3. 推荐列表显示每个市场的盘口、奖励效率、风险提示
4. 点击市场卡片前的复选框进行手动选择，或直接点击"确认应用"使用默认推荐

### 第7步：启动做市

点击顶部的 **"▶ 启动做市商"**，开始自动挂单赚积分！

- 启动后按钮变红，显示"■ 停止做市商"
- 右下角开始实时输出日志
- 左下角显示当前运行的市场数量

需要停止时点击 **"停止做市商"**，会自动撤销所有挂单后安全退出。

### 紧急撤单

如果遇到紧急情况需要立即停止所有挂单，点击红色的 **"紧急撤单"** 按钮，系统会立即撤销当前所有市场的所有挂单。

---

## 策略详解

### 核心原理：动态档位挂单

不是在BBO旁边挂单（容易被吃单），而是挂在订单簿的第N档价格：

```
订单簿示例（保守模式，挂第4档）：

  卖方          价格         买方
  ─────────────────────────
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

1. **市场筛选（screenMarket）** — 确保市场有积分规则且盘口价差合理
2. **档位定价（calculatePrices）** — 动态取第N档价格 + 智能填补
3. **硬距离验证（validatePriceDistance）** — 绝对不穿越BBO
4. **下单前最终验证** — 毫秒级BBO快照防止缓存过期
5. **下单后即时验证** — 200ms内检查单子是否合规
6. **被吃模式检测** — 连续被吃自动冷却 + 进黑名单
7. **持仓亏损保护** — 超限自动停机

---

## 配置详解

### 必填参数

| 参数 | 平台 | 说明 |
|------|------|------|
| `API_KEY` | Predict | 你的 Predict.fun API Key |
| `PRIVATE_KEY` | Predict | 钱包私钥（不带 0x 前缀） |
| `PREDICT_ACCOUNT_ADDRESS` | Predict | 账户地址（0x开头） |
| `POLYMARKET_PRIVATE_KEY` | Polymarket | Polymarket 私钥 |
| `POLYMARKET_FUNDER_ADDRESS` | Polymarket | Funder 地址 |

### 核心参数（App内可调）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `ORDER_SIZE` | 100 | 每笔挂单金额（美元），建议 ≥ 100 |
| `MAX_POSITION` | 100 | 单市场最大持仓（美元） |
| `MAX_DAILY_LOSS` | 200 | 每日最大亏损保护（美元） |
| `MM_TRADING_MODE` | conservative | 交易模式：conservative 或 aggressive |
| `ENABLE_TRADING` | true | 是否开启真实交易（false = 模拟测试） |
| `SIMULATION_MODE` | false | 是否仅模拟挂单（不真正下单） |

### 高级参数（一般不用改）

App已内置最佳默认值，一般无需调整。如需微调，可在App的参数配置面板或直接编辑 `.env` 文件。

---

## 命令行使用（高级用户）

如果你想从源码运行，而不是使用桌面App：

```bash
# 1. 克隆仓库
git clone https://github.com/ccjingeth/predict-fun-marketmaker.git
cd predict-fun-marketmaker

# 2. 安装依赖
npm install

# 3. 编辑 .env 填写必填项
cp .env.example .env  # 如果有示例文件
# 编辑 .env 填写 API_KEY, PRIVATE_KEY, PREDICT_ACCOUNT_ADDRESS 等

# 4. 获取JWT（仅Predict需要）
npx tsx src/auth-jwt.ts

# 5. 启动做市（带日志输出）
npm run start:cli
```

### 常用脚本

```bash
# 获取 JWT Token
npx tsx src/auth-jwt.ts

# 授权合约（仅Predict首次）
npx tsx src/setup-approvals.ts

# 推荐市场
npx tsx scripts/market-recommender.ts --venue predict --top 10
```

---

## 常见问题

**问: 启动后看不到市场列表？**

A: 检查以下几点：
1. API_KEY 是否已填写并保存
2. 点击"刷新市场"时网络是否正常
3. 检查日志是否有错误信息

**问: JWT 报错 "Authorization header invalid"？**

A: 你填了占位文本而不是真JWT。点击"获取 JWT"按钮自动获取，或运行 `npx tsx src/auth-jwt.ts`。

**问: 推荐市场为空？**

A: 当前模式下没有满足筛选条件的市场。可以尝试：
1. 切换到激进模式
2. 等待市场流动性恢复
3. 检查网络连接

**问: 被吃单了怎么办？**

A: 检查日志中的 "POST_ONLY" 或 "FILLED" 标记。系统会自动冷却该市场（保守6小时/激进4小时）。频繁被吃说明该市场深度不足，已自动拉黑。

**问: 如何选择保守还是激进？**

A: 新手强烈建议从保守模式开始。激进模式积分更多但偶尔会被吃。可以先用保守模式跑几天，没有问题再考虑切换。

**问: Polymarket 提示凭证不对？**

A: 实盘需要的是 **用户 CLOB API 凭证（L2）**，不是 Builder / Relayer key。用App里的"检查 Polymarket 预检"自动检测，或参考 [Polymarket API 认证文档](https://docs.polymarket.com/cn/api-reference/authentication)。

**问: 如何检查配置文件在哪里？**

A: 点击App底部的"打开配置目录"按钮即可。不同系统的默认位置：
- **Mac**: `~/Library/Application Support/PredictFun Market Maker/.env`
- **Windows**: `%APPDATA%\PredictFun Market Maker\.env`
- **Linux**: `~/.config/PredictFun Market Maker/.env`

---

## 文件位置

| 系统 | 配置目录 | 配置文件 |
|------|----------|----------|
| Mac | `~/Library/Application Support/PredictFun Market Maker/` | `.env` |
| Windows | `%APPDATA%\PredictFun Market Maker\` | `.env` |
| Linux | `~/.config/PredictFun Market Maker/` | `.env` |

---

## 推荐链接

- [Predict.fun](https://predict.fun?ref=B0CE6) - 预测市场平台
- [Polymarket](https://polymarket.com) - 预测市场平台
- [Polymarket API 认证文档](https://docs.polymarket.com/cn/api-reference/authentication)

---

## 免责声明

本工具仅供学习和研究用途。使用本工具进行交易的所有风险由用户自行承担。请先小额测试，确认理解所有参数后再加大资金。
