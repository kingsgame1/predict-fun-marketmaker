# Predict.fun Market Maker - 简化版

自动化做市商机器人，为 [Predict.fun](https://predict.fun/?ref=B0CE6) 市场提供流动性并赚取积分。

## ✨ 功能特点

- ✅ **自动做市商挂单** - 智能报价，提供流动性
- ✅ **风险控制系统** - 自动止损，仓位管理
- ✅ **WebSocket实时数据** - 低延迟市场数据
- ✅ **桌面客户端** - 可视化界面，易于操作
- ✅ **完全免费** - 无需激活，开箱即用
- ✅ **简单易用** - 适合新手赚取积分

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境

```bash
cp .env.example .env
# 编辑 .env 文件，填写API密钥等配置
```

**必填配置**：
- `API_KEY` - Predict.fun API密钥
- `JWT_TOKEN` - JWT令牌
- `PRIVATE_KEY` - 钱包私钥（64位十六进制，不带0x）
- `PREDICT_ACCOUNT_ADDRESS` - 账户地址（0x开头的42位地址）

### 3. 启动程序

```bash
npm start
```

程序会自动：
- 🌐 启动 Web 服务器（http://localhost:3000）
- 🌐 自动在浏览器中打开可视化界面
- 📊 显示实时控制面板

可视化界面功能：
- ▶️ 一键启动/停止做市商
- 📊 查看实时统计数据
- 📝 查看运行日志
- 🔄 刷新状态

**命令行模式**（如果不需要界面）：
```bash
npm run start:cli
```

## ⚙️ 配置说明

### 做市商配置

```env
MM_ENABLED=true                    # 启用做市商
MM_POSITION_SIZE=0.05              # 仓位比例（5%）
ORDER_SIZE=10                      # 订单大小（美元）
MAX_POSITION=100                   # 最大持仓（美元）
```

### 价差配置

```env
SPREAD=0.02                        # 基础价差（2%）
MIN_SPREAD=0.01                    # 最小价差（1%）
MAX_SPREAD=0.08                    # 最大价差（8%）
```

### 风险控制

```env
MAX_DAILY_LOSS=200                 # 每日最大亏损（美元）
```

## 💡 使用建议

### 新手推荐配置

```env
MM_ENABLED=true
ORDER_SIZE=5                       # 小单开始
MAX_POSITION=50                    # 小仓位
MAX_DAILY_LOSS=50                  # 低止损
SPREAD=0.02
SIMULATION_MODE=true               # 先模拟测试
```

### 实盘模式

确认配置正确后，设置为实盘：

```env
SIMULATION_MODE=false
```

## 📊 功能对比

| 功能 | 简化版 | 说明 |
|------|--------|------|
| 做市商挂单 | ✅ | 自动提供流动性 |
| 智能报价 | ✅ | 根据市场调整价差 |
| 风险控制 | ✅ | 止损、仓位管理 |
| WebSocket | ✅ | 实时市场数据 |
| 套利机器人 | ❌ | 不包含 |
| 高频交易 | ❌ | 不包含 |

## 🛡️ 安全提示

1. ⚠️ **永远不要将私钥提交到Git仓库**
2. 🧪 建议先使用 `SIMULATION_MODE=true` 测试
3. 💰 设置合理的止损和限额
4. 📈 定期查看交易记录
5. ⚖️ 不要使用全部资金进行交易

## 🔗 相关链接

- [Predict.fun](https://predict.fun?ref=B0CE6)
- [推荐邀请链接](https://predict.fun?ref=B0CE6)
- Twitter: [@ccjing_eth](https://twitter.com/ccjing_eth)

## 📝 更新日志

### v1.0.0 (2025-02-24)
- ✅ 初始发布
- ✅ 做市商挂单功能
- ✅ 风险控制系统
- ✅ WebSocket实时数据

## 📄 许可证

MIT License

## ⚠️ 免责声明

本软件仅供学习研究使用。使用本软件进行交易的任何风险由用户自行承担。请在充分了解风险的情况下使用。

---

**版本**: 1.0.0 (简化版)
**更新**: 2025-02-24
**平台**: [Predict.fun](https://predict.fun?ref=B0CE6)
**网络**: BSC (BNB Smart Chain)
