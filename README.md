# PredictFun Market Maker Lite

简化版做市应用，集成统一做市策略，支持 [Predict.fun](https://predict.fun?ref=B0CE6) 和 [Probable](https://probable.markets/?ref=PNRBS9VL)。

---

## 快速开始 (桌面端应用)

### 第一步：下载并安装

从 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (M1/M2/M3) | `.dmg` 或 `.zip` |
| Windows | `Setup.exe` (安装版) 或 `.exe` (便携版) |
| Linux | `.AppImage` |

### 第二步：套用模板

1. 打开应用
2. 点击 **"套用 Predict 模板"** 或 **"套用 Probable 模板"**

### 第三步：填写配置

**Predict.fun 需要填写：**
```
API_KEY=你的API密钥
PRIVATE_KEY=你的钱包私钥
```

**Probable 需要填写：**
```
PROBABLE_PRIVATE_KEY=你的Probable私钥
```

### 第四步：获取 JWT Token (仅 Predict 实盘)

1. 填写完 `API_KEY` 和 `PRIVATE_KEY` 后
2. 点击 **"🔑 获取 JWT Token"** 按钮
3. 等待自动获取并写入配置

### 第五步：选择市场

1. 选择场馆 (Predict / Probable)
2. 点击 **"自动推荐市场"** 扫描优质市场
3. 点击 **"一键应用推荐"** 自动选择市场

### 第六步：启动做市

点击 **"启动做市"** 开始运行

---

## 默认配置

以下配置默认已启用，无需手动修改：

```env
# 交易开关（默认启用）
ENABLE_TRADING=true
AUTO_CONFIRM=true

# 统一策略（默认启用）
UNIFIED_STRATEGY_ENABLED=true
```

---

## 统一做市策略

| 功能 | 说明 |
|------|------|
| **二档追踪** | 保持挂单在第二档 (1-6 cents from best) |
| **异步对冲** | 被吃单后立即对冲 (HIGH urgency) |
| **双轨并行** | 同时买/卖两侧挂单赚积分 |
| **流动性评估** | 选择 YES/NO 流动性充足的市场 |

---

## 命令行模式

```bash
# 安装依赖
npm install

# 套用模板
npm run template:predict    # Predict 模板
npm run template:probable   # Probable 模板

# 获取 JWT Token
npm run auth:jwt

# 推荐市场
npm run market:recommend
npm run market:apply

# 启动做市
npm run start:mm
```

---

## 注意事项

- **Predict 实盘**: 需要先运行 `npm run setup:approvals` 授权合约
- **积分规则**: 最大价差 ±6 cents，最小股数 100
- **风险提示**: 市场波动可能导致意外成交，建议先用小仓位测试

---

## 推荐链接

- [Predict.fun](https://predict.fun?ref=B0CE6)
- [Probable](https://probable.markets/?ref=PNRBS9VL)
