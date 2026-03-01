# PredictFun Market Maker Lite

简化版做市应用，集成统一做市策略，支持 [Predict.fun](https://predict.fun?ref=B0CE6) 和 [Probable](https://probable.markets/?ref=PNRBS9VL)。

---

## 功能概览

- 桌面端一键套用配置模板
- 自动扫描并推荐高流动性市场
- 一键应用推荐市场或手动勾选市场
- 统一做市策略（偏二档挂单、优先积分、降低被动成交）
- 支持命令行模式运行

---

## 桌面端完整使用流程

### 1. 下载并安装

从 [GitHub Releases](https://github.com/ccjingeth/predict-fun-marketmaker/releases/latest) 下载对应平台安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `PredictFun.Market.Maker.Lite-1.1.0-arm64.dmg` |
| Windows | `PredictFun.Market.Maker.Lite.Setup.1.1.0.exe` |
| Linux x64 | `PredictFun.Market.Maker.Lite-1.1.0.AppImage` |
| Linux arm64 | `PredictFun.Market.Maker.Lite-1.1.0-arm64.AppImage` |

Linux 额外说明：

```bash
chmod +x PredictFun.Market.Maker.Lite-1.1.0.AppImage
./PredictFun.Market.Maker.Lite-1.1.0.AppImage
```

如果 AppImage 无法启动，先检查系统是否安装 `libfuse2`。

### 2. 套用模板

打开应用后：

1. 先选择场馆：`Predict` 或 `Probable`
2. 点击 `套用 Predict 模板` 或 `套用 Probable 模板`
3. 点击 `重新读取`，确认模板已写入编辑区

### 3. 填写配置

只填写模板里标注“需自行获取”的字段，其他默认值保持不动。

Predict 必填：

```env
API_KEY=你的API密钥
PRIVATE_KEY=你的钱包私钥
```

Probable 必填：

```env
PROBABLE_PRIVATE_KEY=你的Probable私钥
```

重要：

- `JWT_TOKEN` 不要手动填占位符去实盘扫描
- 如果还没获取到真实 JWT，建议先把 `JWT_TOKEN=` 留空
- 最新版本已经会忽略无效/占位 JWT，避免市场扫描时报 `Authorization` 头错误

### 4. 获取 JWT Token（仅 Predict 实盘需要）

仅 `Predict + 实盘下单` 需要 JWT。

操作顺序：

1. 先填写好 `API_KEY` 和 `PRIVATE_KEY`
2. 点击 `保存配置`
3. 点击 `获取 JWT Token`
4. 等待日志显示成功，并自动写回当前用户配置文件

如果失败：

- Windows 旧包会出现 `spawn EINVAL`，请重新下载最新 release
- Linux 旧包会出现 `tsx: not found`，请重新下载最新 release

### 5. 扫描并应用市场

1. 点击 `自动推荐市场`
2. 等待推荐表出现结果
3. 查看推荐表中的：
   - `价差`
   - `买一量 / 卖一量`
   - `买二量 / 卖二量`
   - `L1可挂$ / L2可挂$`
   - `状态`
4. 点击 `一键应用推荐`，或手动勾选后点击 `应用手动勾选`

说明：

- 推荐优先考虑真实盘口深度和二档可挂容量
- 停止做市时会自动撤销挂单

### 6. 启动与停止做市

启动：

1. 确认配置已保存
2. 确认市场已应用
3. 点击 `启动做市`

停止：

1. 点击 `停止做市`
2. 程序会先优雅停机
3. 自动撤销当前挂单
4. 超时后才会强制结束

### 7. 查看日志与排错

常见报错及含义：

- `JWT_TOKEN 格式无效或仍是占位符`
  - 说明你填了占位文本，不是真实 JWT
- `Invalid character in header content ["Authorization"]`
  - 旧版本常见；新版本已修复。通常是占位 JWT 被当成真实 header
- `tsx: not found`
  - 旧 Linux 包常见；新版本已修复
- `spawn EINVAL`
  - 旧 Windows 包常见；新版本已修复

---

## 命令行完整使用流程

在当前目录运行：

```bash
npm install
```

### 1. 套用模板

```bash
npm run template:predict
# 或
npm run template:probable
```

这会生成或更新当前目录的 `.env`。

### 2. 编辑 `.env`

按场馆填写必要字段：

Predict：

```env
API_KEY=你的API密钥
PRIVATE_KEY=你的钱包私钥
JWT_TOKEN=
```

Probable：

```env
PROBABLE_PRIVATE_KEY=你的Probable私钥
```

### 3. 获取 JWT（仅 Predict 实盘）

```bash
npm run auth:jwt
```

成功后会自动把真实 `JWT_TOKEN` 写入 `.env`。

### 4. 授权合约（仅 Predict 实盘首次）

```bash
npm run setup:approvals
```

### 5. 扫描推荐市场

只推荐，不写入：

```bash
npm run market:recommend -- --venue predict --top 10 --scan 80 --env .env
```

推荐并自动写入 `MARKET_TOKEN_IDS`：

```bash
npm run market:apply -- --venue predict --top 10 --scan 80 --env .env
```

Probable 仅把 `--venue predict` 改成 `--venue probable`。

### 6. 启动做市

```bash
npm run start:mm
```

### 7. 本地调试（可选）

```bash
npm run dev
```

---

## 默认策略说明

默认已经启用：

```env
ENABLE_TRADING=true
AUTO_CONFIRM=true
UNIFIED_STRATEGY_ENABLED=true
```

统一做市策略核心：

| 功能 | 说明 |
|------|------|
| 二档优先 | 优先挂在更安全的位置，避免贴一档被吃 |
| 盘口筛选 | 优先选择流动性更好、二档容量更足的市场 |
| 风险控制 | 异常波动或高成交风险时自动撤单/收缩 |
| 优雅停止 | 停止做市时自动撤销挂单 |

---

## 建议

- 实盘前先用小仓位验证
- Predict 实盘必须先完成 `setup:approvals`
- 如果从旧版本升级，请重新下载最新 release 安装包

---

## 推荐链接

- [Predict.fun](https://predict.fun?ref=B0CE6)
- [Probable](https://probable.markets/?ref=PNRBS9VL)
