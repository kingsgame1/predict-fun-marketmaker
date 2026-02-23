# 🔐 激活码系统与桌面启动器 - 完整部署指南

## 📋 目录

- [系统概述](#系统概述)
- [安全特性](#安全特性)
- [部署步骤](#部署步骤)
- [服务器部署](#服务器部署)
- [桌面启动器部署](#桌面启动器部署)
- [客户端集成](#客户端集成)
- [故障排查](#故障排查)

---

## 系统概述

本项目包含三个核心组件：

### 1. 🔒 安全激活码系统（客户端）

**文件**: `src/activation-secure.ts`

**功能**:
- RSA-2048 非对称加密签名验证
- 多重硬件指纹（CPU、MAC、磁盘序列号）
- 时间戳防重放攻击
- AES-256-GCM 加密存储
- 在线验证 + 本地缓存双重机制

**关键特性**:
- 激活码格式: `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`
- 支持离线验证（24小时缓存）
- 硬件绑定防止激活码共享
- 功能权限控制

### 2. 🌐 在线验证服务器

**文件**: `activation-server/validate-server.ts`

**功能**:
- 激活码生成和管理
- 实时验证API
- SQLite数据库存储
- 速率限制和防暴力破解
- 完整的审计日志

**API端点**:
- `POST /api/validate-license` - 验证激活码
- `POST /api/admin/activate` - 生成激活码（管理员）
- `GET /api/admin/activations` - 查询激活列表（管理员）
- `GET /health` - 健康检查

### 3. 🚀 桌面启动器

**文件**: `launcher/`

**功能**:
- 一键启动主程序
- 激活码输入和验证
- 系统环境检查
- 配置文件管理
- 项目路径设置

---

## 安全特性

### 防破解设计

| 安全措施 | 实现方式 | 防护目标 |
|---------|---------|---------|
| **非对称加密** | RSA-2048 签名验证 | 防止激活码伪造 |
| **硬件绑定** | 多重硬件指纹 | 防止激活码共享 |
| **加密存储** | AES-256-GCM | 防止本地文件篡改 |
| **时间戳验证** | 防重放攻击检查 | 防止重放攻击 |
| **在线验证** | 服务器端验证 | 防止离线破解 |
| **速率限制** | 60次/分钟 | 防止暴力破解 |
| **审计日志** | 完整的验证日志 | 追溯异常行为 |

### 安全架构

```
┌─────────────────────────────────────────────────────────────┐
│                     客户端应用                                │
├─────────────────────────────────────────────────────────────┤
│  1. 输入激活码                                               │
│  2. 本地格式验证                                             │
│  3. RSA签名验证（公钥）                                      │
│  4. 硬件指纹生成                                             │
│  5. 在线验证请求 ──────────────────────────┐                │
│  6. 绑定硬件指纹                          │                │
│  7. 加密存储（AES-256-GCM）               │                │
└───────────────────────────────────────────┼────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  验证服务器                                   │
├─────────────────────────────────────────────────────────────┤
│  1. 接收验证请求                                             │
│  2. RSA签名验证（私钥）                                      │
│  3. 数据库查询                                               │
│  4. 硬件指纹检查                                             │
│  5. 速率限制检查                                             │
│  6. 记录审计日志                                             │
│  7. 返回验证结果 ──────────────────────────┐                │
└───────────────────────────────────────────┼────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  SQLite数据库                                │
├─────────────────────────────────────────────────────────────┤
│  - activations 表: 激活码信息                                │
│  - validation_logs 表: 验证日志                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 部署步骤

### 方案选择

根据您的需求选择部署方案：

#### 方案A：离线模式（适合内部使用）
- ✅ 无需服务器
- ✅ 部署简单
- ⚠️ 安全性较低
- ⚠️ 无法远程管理

#### 方案B：在线模式（推荐）
- ✅ 安全性高
- ✅ 远程管理
- ✅ 实时验证
- ⚠️ 需要服务器

---

## 服务器部署

### 前置要求

- Node.js 18+
- NPM
- 公网服务器（可选，用于在线验证）

### 步骤1：安装依赖

```bash
cd activation-server
npm install
```

### 步骤2：配置环境变量

```bash
cp .env.example .env
vim .env
```

**重要配置**:

```env
# 服务器端口
ACTIVATION_PORT=3000

# 数据库路径
DB_PATH=./activations.db

# RSA密钥路径（首次运行会自动生成）
RSA_PRIVATE_KEY_PATH=./keys/private.pem
RSA_PUBLIC_KEY_PATH=./keys/public.pem

# ⚠️ 管理员API密钥（必须修改）
ADMIN_API_KEY=your-super-secret-admin-api-key-change-me

# 速率限制
MAX_REQUESTS_PER_MINUTE=60

# 最大设备绑定数
MAX_ACTIVATIONS_PER_KEY=3
```

### 步骤3：生成管理员密钥

```bash
# 生成随机密钥
openssl rand -base64 32
```

将生成的密钥复制到 `.env` 的 `ADMIN_API_KEY`。

### 步骤4：启动服务器

#### 开发模式

```bash
npm run dev
```

#### 生产模式（PM2）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
npm run pm2:start

# 查看状态
npm run pm2:status

# 查看日志
npm run pm2:logs
```

### 步骤5：配置反向代理（可选）

使用 Nginx 反向代理：

```nginx
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 桌面启动器部署

### 方案A：使用打包好的启动器

#### 1. 安装依赖

```bash
cd launcher
npm install
```

#### 2. 配置项目路径

编辑 `main.js`，修改默认项目路径：

```javascript
function getProjectPath() {
  // 默认路径
  return '/path/to/your/predict-fun-market-maker';
}
```

#### 3. 打包启动器

**macOS**:
```bash
npm run build:mac
```
生成: `dist/Predict.fun Console.dmg`

**Windows**:
```bash
npm run build:win
```
生成: `dist/Predict.fun Console Setup.exe`

**Linux**:
```bash
npm run build:linux
```
生成: `dist/Predict.fun Console.AppImage`

#### 4. 分发和安装

- 将生成的安装包分发给用户
- 用户安装后可直接运行

### 方案B：从源码运行

```bash
cd launcher
npm install
npm start
```

---

## 客户端集成

### 步骤1：替换激活系统

在 `src/` 目录下，旧版 `activation.ts` 替换为新版 `activation-secure.ts`。

### 步骤2：更新导入

将所有使用旧激活系统的地方更新为新系统：

```typescript
// 旧版
import { ActivationManager } from './activation.js';

// 新版
import { SecureActivationManager } from './activation-secure.js';
```

### 步骤3：更新激活验证

```typescript
// 旧版
const validation = ActivationManager.checkActivation();

// 新版
const validation = SecureActivationManager.checkSecureActivation();
```

### 步骤4：启用在线验证（可选）

在 `src/activation-secure.ts` 的 `validateOnlineSecure` 方法中：

1. 取消注释在线验证代码
2. 修改服务器URL
3. 删除临时返回语句

```typescript
private static async validateOnlineSecure(
  licenseKey: string,
  userId: string
): Promise<SecureValidationResult> {
  try {
    const response = await fetch('https://your-server.com/api/validate-license', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        licenseKey,
        userId,
        hardwareFingerprint: this.generateHardwareFingerprint(),
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        valid: false,
        message: '无法连接到激活服务器',
        code: 'ONLINE_FAILED',
      };
    }

    const result = await response.json();
    return result;
  } catch (error) {
    // 离线降级策略
    const savedInfo = this.loadActivationInfo();
    if (savedInfo && savedInfo.activated) {
      const lastValidationAge = Date.now() - savedInfo.lastValidated;
      if (lastValidationAge < 24 * 60 * 60 * 1000) {
        return {
          valid: true,
          message: '离线模式（使用缓存的验证）',
          code: 'VALID',
        };
      }
    }

    return {
      valid: false,
      message: '无法连接到激活服务器，且离线缓存已过期',
      code: 'ONLINE_FAILED',
    };
  }
}
```

### 步骤5：生成测试激活码（开发用）

```typescript
import { generateTestSecureLicense } from './activation-secure.js';

const { licenseKey, privateKey } = generateTestSecureLicense(
  'test_user',
  'Test User',
  'test@example.com',
  30  // 30天
);

console.log('激活码:', licenseKey);
```

---

## 使用指南

### 管理员：生成激活码

#### 方法1：使用服务器API

```bash
curl -X POST https://your-server.com/api/admin/activate \
  -H "Content-Type: application/json" \
  -d '{
    "adminApiKey": "your-admin-api-key",
    "userId": "user123",
    "userName": "John Doe",
    "email": "john@example.com",
    "days": 365,
    "features": ["arbitrage", "auto_trading"]
  }'
```

#### 方法2：使用客户端代码

```typescript
import { SecureActivationManager } from './activation-secure.js';
import * as fs from 'fs';

// 读取私钥（从服务器）
const privateKey = fs.readFileSync('./keys/private.pem', 'utf-8');

// 生成激活码
const licenseKey = SecureActivationManager.generateSecureLicense(
  privateKey,
  'user123',
  'John Doe',
  'john@example.com',
  365,  // 天数
  ['arbitrage', 'auto_trading']  // 功能
);

console.log('激活码:', licenseKey);
```

### 用户：激活应用

#### 方法1：使用桌面启动器

1. 双击运行桌面启动器
2. 在激活界面输入激活码
3. 填写用户信息
4. 点击"激活"
5. 激活成功后进入主界面

#### 方法2：使用命令行

```bash
# 进入项目目录
cd predict-fun-market-maker

# 创建激活脚本
cat > activate.js << 'EOF'
import { SecureActivationManager } from './src/activation-secure.js';

const licenseKey = process.argv[2];
const userId = process.argv[3];
const userName = process.argv[4];
const email = process.argv[5];

SecureActivationManager.activateSecureLicense(
  licenseKey,
  userId,
  userName,
  email
).then(result => {
  console.log(result.message);
  process.exit(result.valid ? 0 : 1);
});
EOF

# 运行激活
node activate.js \
  XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX \
  user123 \
  "John Doe" \
  john@example.com
```

---

## 故障排查

### 问题1：服务器无法启动

**症状**: `Error: listen EADDRINUSE: address already in use`

**解决**:
```bash
# 检查端口占用
lsof -i :3000

# 杀死占用进程
kill -9 <PID>

# 或更换端口
export ACTIVATION_PORT=3001
npm start
```

### 问题2：激活码验证失败

**症状**: `激活码签名验证失败`

**原因**:
- 公钥不匹配
- 激活码被修改
- 版本不匹配

**解决**:
1. 确认服务器公钥与客户端使用的公钥一致
2. 重新生成激活码
3. 检查版本号是否匹配（`VERSION = '2.0.0'`）

### 问题3：硬件指纹不匹配

**症状**: `硬件指纹不匹配 - 激活码已绑定到其他设备`

**原因**:
- 硬件变更（MAC地址、CPU等）
- 虚拟机克隆
- 激活码共享

**解决**:
管理员手动重置硬件绑定：

```bash
sqlite3 activations.db

sqlite> UPDATE activations
   SET hardware_fingerprint = NULL, activation_count = 0
 WHERE license_key = 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX';
```

### 问题4：无法连接到激活服务器

**症状**: `无法连接到激活服务器`

**解决**:

1. **检查网络连接**
   ```bash
   curl https://your-server.com/health
   ```

2. **检查服务器状态**
   ```bash
   pm2 status
   pm2 logs activation-server
   ```

3. **检查防火墙**
   ```bash
   # Ubuntu
   sudo ufw status
   sudo ufw allow 3000/tcp

   # CentOS
   sudo firewall-cmd --list-all
   sudo firewall-cmd --add-port=3000/tcp --permanent
   sudo firewall-cmd --reload
   ```

4. **启用离线模式**
   - 如果网络不可用，系统会自动使用24小时缓存
   - 确保至少24小时内在线验证一次

### 问题5：桌面启动器无法找到项目

**症状**: `项目路径不正确`

**解决**:

1. 使用"更改项目路径"按钮选择正确的项目文件夹
2. 或编辑 `launcher/main.js`，修改默认路径

---

## 最佳实践

### 1. 密钥管理

- ✅ 定期轮换RSA密钥对（每年）
- ✅ 使用强密码作为ADMIN_API_KEY
- ✅ 不要将私钥提交到版本控制
- ✅ 使用环境变量存储敏感信息

### 2. 服务器监控

- ✅ 设置日志监控
- ✅ 配置告警（磁盘空间、CPU、内存）
- ✅ 定期备份数据库
- ✅ 监控异常验证请求

### 3. 激活码管理

- ✅ 记录激活码发放情况
- ✅ 设置合理的过期时间
- ✅ 限制设备绑定数量（建议3台）
- ✅ 提供激活码转移流程

### 4. 用户体验

- ✅ 提供清晰的错误提示
- ✅ 支持离线使用（24小时缓存）
- ✅ 提供便捷的激活流程
- ✅ 支持硬件变更申请

---

## 附录

### A. 数据库架构

```sql
-- 激活表
CREATE TABLE activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  email TEXT NOT NULL,
  hardware_fingerprint TEXT,
  expire_date INTEGER NOT NULL,
  features TEXT,
  activated_at INTEGER,
  last_validated INTEGER,
  activation_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- 验证日志表
CREATE TABLE validation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  user_id TEXT,
  hardware_fingerprint TEXT,
  ip_address TEXT,
  result TEXT,
  timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);
```

### B. 激活码格式

```
格式: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX

示例: A1B2-C3D4-E5F6-G7H8-I9J0-K1L2-M3N4-O5P6

组成:
- Base64编码的JSON数据
- RSA-2048签名
- 时间戳
- 用户信息
- 过期时间
- 功能列表
```

### C. 错误代码

| 代码 | 说明 | 处理建议 |
|-----|------|---------|
| `VALID` | 激活码有效 | 正常使用 |
| `INVALID_FORMAT` | 格式无效 | 检查激活码输入 |
| `EXPIRED` | 已过期 | 续费或购买新激活码 |
| `HARDWARE_MISMATCH` | 硬件不匹配 | 联系管理员重置 |
| `SIGNATURE_INVALID` | 签名无效 | 激活码可能是伪造的 |
| `ONLINE_FAILED` | 在线验证失败 | 检查网络连接 |
| `NOT_ACTIVATED` | 未激活 | 请先激活 |

---

## 支持与反馈

如有问题或建议，请联系：

- 📧 Email: support@predict.fun
- 💬 Telegram: @PredictFunSupport
- 📚 文档: https://docs.predict.fun

---

**版本**: 1.0.0
**更新**: 2026-02-22
**作者**: Predict.fun Team
