# PredictFun Market Maker Lite

自动化做市商桌面应用，支持 [Predict.fun](https://predict.fun?ref=B0CE6) 和 [Probable](https://probable.markets/?ref=PNRBS9VL) 双平台，提供流动性并赚取积分。

## ✨ 功能特点

- 🖥️ **桌面客户端** - 可视化界面，易于操作
- 🔀 **双平台支持** - Predict 和 Probable 一键切换
- 📊 **自动做市挂单** - 智能报价，提供流动性
- ⚖️ **YES/NO 对冲策略** - 自动风险对冲
- 🔍 **智能市场推荐** - 自动扫描推荐最佳市场
- 📡 **WebSocket 实时数据** - 低延迟市场数据
- 🛡️ **风险控制系统** - 自动止损，仓位管理
- 🔒 **本地私钥存储** - 安全可靠，不上传服务器

## 📥 下载安装

前往 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases) 下载最新版本：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `PredictFun-Market-Maker-Lite-{version}-arm64.dmg` |
| Windows | `PredictFun-Market-Maker-Lite-{version}-x64.exe` |

### macOS 安装后

如果提示"无法验证开发者"，运行：
```bash
xattr -cr "/Applications/PredictFun Market Maker Lite.app"
```

## 🚀 快速开始

### 第一步：选择平台并套用模板

1. 打开应用
2. 点击 **"套用 Predict 模板"** 或 **"套用 Probable 模板"**
3. 这会创建配置文件到 `~/.predict-fun-market-maker-lite/.env`

### 第二步：填写必填配置

点击 **"编辑配置"** 按钮，填写以下信息：

#### Predict 平台
```env
API_KEY=你的Predict_API_KEY        # 必填
PRIVATE_KEY=你的钱包私钥             # 必填（不带0x）
JWT_TOKEN=你的JWT令牌               # 实盘交易时必填
PREDICT_ACCOUNT_ADDRESS=你的账户地址  # 推荐填写
```

#### Probable 平台
```env
PROBABLE_PRIVATE_KEY=你的私钥       # 必填
PRIVATE_KEY=你的私钥（可留空）       # 兼容字段
```

### 第三步：选择市场

两种方式：

**方式一：自动推荐**
1. 点击 **"扫描推荐市场"**
2. 系统自动扫描并评分市场
3. 点击 **"应用推荐"** 自动选择最佳市场

**方式二：手动输入**
1. 在市场 Token ID 输入框中填写
2. 多个用逗号分隔
3. 点击 **"设置"** 保存

### 第四步：启动做市

1. 确认配置正确
2. 点击 **"启动做市"** 按钮
3. 观察日志输出

## ⚙️ 配置说明

### 核心配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `MM_VENUE` | 平台选择 | `predict` / `probable` |
| `ENABLE_TRADING` | 启用实盘交易 | `false` |
| `AUTO_CONFIRM` | 自动确认交易 | `false` |
| `MARKET_TOKEN_IDS` | 市场 Token ID 列表 | 空（自动推荐） |

### 做市策略配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `MM_POSITION_SIZE` | 仓位比例 | `0.05` |
| `ORDER_SIZE` | 订单大小（美元） | `10` |
| `MAX_POSITION` | 最大持仓（美元） | `100` |
| `SPREAD` | 基础价差 | `0.02` |
| `MIN_SPREAD` | 最小价差 | `0.01` |
| `MAX_SPREAD` | 最大价差 | `0.08` |

### YES/NO 对冲策略

当 `UNIFIED_MARKET_MAKER_ENABLED=true` 时，系统会自动进行 YES/NO 对冲：
- 买入 YES 时，自动买入 NO 进行风险对冲
- 降低单边风险

## 🔗 注册链接

使用以下链接注册支持开发者：

| 平台 | 链接 |
|------|------|
| Predict.fun | [https://predict.fun?ref=B0CE6](https://predict.fun?ref=B0CE6) |
| Probable | [https://probable.markets/?ref=PNRBS9VL](https://probable.markets/?ref=PNRBS9VL) |

## 🛡️ 安全提示

1. 🔒 **私钥仅存储在本地** - 不会上传到任何服务器
2. ⚠️ **永远不要将私钥提交到 Git 仓库**
3. 🧪 建议先用默认配置观察，确认无误后再启用交易
4. 💰 设置合理的止损和限额
5. ⚖️ 不要使用全部资金进行交易

## 📁 文件位置

| 文件 | 路径 |
|------|------|
| 配置文件 | `~/.predict-fun-market-maker-lite/.env` |
| 配置备份 | `~/.predict-fun-market-maker-lite/.env.bak.{时间戳}` |

## 📝 更新日志

### v1.6.5
- ✅ 支持 Predict 和 Probable 双平台
- ✅ 桌面客户端可视化界面
- ✅ 智能市场推荐系统
- ✅ YES/NO 自动对冲策略
- ✅ 本地私钥安全存储

## 📄 许可证

MIT License

## ⚠️ 免责声明

本软件仅供学习研究使用。使用本软件进行交易的任何风险由用户自行承担。请在充分了解风险的情况下使用。

---

**开发者**: [@ccjing_eth](https://x.com/ccjing_eth)

**注册链接**:
- [Predict.fun](https://predict.fun?ref=B0CE6)
- [Probable](https://probable.markets/?ref=PNRBS9VL)
