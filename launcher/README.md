# PredictFun Market Maker v2.2.7

预测市场自动做市商桌面应用 - 挂单赚积分，稳定收益。

## 快速开始

1. 双击打开应用
2. 点击顶栏【配置参数】-> 填写你的 API Key 和私钥
3. 点击【启动做市商】

## 系统支持

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon) | `.dmg` | 双击安装，拖拽到应用文件夹 |
| macOS (Apple Silicon) | `.zip` | 解压直接运行 |
| Windows | `Setup .exe` | 双击安装向导 |
| Windows | `Portable .exe` | 无需安装，直接运行 |
| Linux | `.AppImage` | 双击运行（需要 chmod +x） |
| Linux | `.deb` | `sudo dpkg -i 安装包.deb` |

## 配置说明

点击顶栏【配置参数】面板，填写以下字段：

- **API Base URL**: `https://api.predict.fun` (Predict) 或 `https://clob.polymarket.com` (Polymarket)
- **Private Key**: 你的钱包私钥（仅本地保存）
- **RPC URL**: Polygon 节点地址
- **Spread**: 价差（默认 1.5%）
- **Order Size**: 单笔订单数量

## 功能特性

- ✅ 双平台支持：Predict.fun + Polymarket
- ✅ 两种模式：保守模式 / 激进模式
- ✅ 实时日志 + 按天轮转
- ✅ 积分收益日报
- ✅ 市场推荐自动筛选
- ✅ 一键启动 / 停止

## 数据存储

所有配置和日志均保存在本地：
- macOS: `~/Library/Application Support/PredictFun Market Maker/`
- Windows: `%APPDATA%\PredictFun Market Maker\`
- Linux: `~/.config/PredictFun Market Maker/`

## 免责声明

本软件仅供学习研究使用，使用者需自行承担交易风险。
