# 🔐 激活码验证服务器 - 部署指南

## 📋 目录

- [功能概述](#功能概述)
- [快速开始](#快速开始)
- [生产环境部署](#生产环境部署)
- [API文档](#api文档)
- [安全最佳实践](#安全最佳实践)
- [故障排查](#故障排查)

---

## 功能概述

激活码验证服务器提供以下核心功能：

1. **激活码验证** - RSA-2048签名验证
2. **硬件绑定** - 多重硬件指纹绑定
3. **数据库存储** - SQLite持久化存储
4. **速率限制** - 防止暴力破解
5. **管理接口** - 激活码生成和管理
6. **日志记录** - 完整的审计日志

---

## 快速开始

### 1. 安装依赖

```bash
cd activation-server
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，修改 ADMIN_API_KEY
```

### 3. 启动服务器

```bash
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 4. 测试健康检查

```bash
curl http://localhost:3000/health
```

---

## 生产环境部署

### 使用 PM2 部署（推荐）

PM2 是 Node.js 进程管理器，提供守护进程、日志管理和自动重启。

#### 安装 PM2

```bash
npm install -g pm2
```

#### 启动服务

```bash
npm run pm2:start
```

#### 查看状态

```bash
npm run pm2:status
```

#### 查看日志

```bash
npm run pm2:logs
```

#### 设置开机自启

```bash
pm2 startup
pm2 save
```

### 使用 Docker 部署

#### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

#### docker-compose.yml

```yaml
version: '3.8'

services:
  activation-server:
    build: .
    ports:
      - "3000:3000"
    environment:
      - ACTIVATION_PORT=3000
      - ADMIN_API_KEY=${ADMIN_API_KEY}
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

#### 启动

```bash
docker-compose up -d
```

### 使用 Nginx 反向代理

#### 配置示例

```nginx
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## API文档

### POST /api/validate-license

验证激活码。

#### 请求

```json
{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  "userId": "user123",
  "hardwareFingerprint": "abc123...",
  "timestamp": 1234567890000
}
```

#### 响应

成功：
```json
{
  "valid": true,
  "message": "验证成功",
  "code": "VALID",
  "remainingDays": 365,
  "features": ["arbitrage", "auto_trading"]
}
```

失败：
```json
{
  "valid": false,
  "message": "激活码已过期",
  "code": "EXPIRED"
}
```

### POST /api/admin/activate

生成新激活码（需要管理员权限）。

#### 请求

```json
{
  "adminApiKey": "your-super-secret-admin-api-key",
  "userId": "user123",
  "userName": "John Doe",
  "email": "john@example.com",
  "days": 365,
  "features": ["arbitrage", "auto_trading"]
}
```

#### 响应

```json
{
  "success": true,
  "licenseKey": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  "userId": "user123",
  "userName": "John Doe",
  "email": "john@example.com",
  "expireDate": 1735689600000,
  "remainingDays": 365
}
```

### GET /api/admin/activations

查询所有激活码（需要管理员权限）。

#### 请求

```
GET /api/admin/activations?adminApiKey=your-super-secret-admin-api-key
```

#### 响应

```json
{
  "success": true,
  "count": 10,
  "activations": [
    {
      "licenseKey": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
      "userId": "user123",
      "userName": "John Doe",
      "email": "john@example.com",
      "expireDate": 1735689600000,
      "features": ["arbitrage", "auto_trading"],
      "activationCount": 2,
      "createdAt": 1704153600000,
      "lastValidated": 1704240000000
    }
  ]
}
```

---

## 安全最佳实践

### 1. 修改默认管理员密钥

⚠️ **务必修改 `.env` 中的 `ADMIN_API_KEY`**

```bash
# 生成随机密钥
openssl rand -base64 32
```

### 2. 使用 HTTPS

生产环境必须使用 HTTPS。可以使用 Let's Encrypt 免费证书。

### 3. 限制数据库访问

```bash
chmod 600 activations.db
```

### 4. 定期备份数据库

```bash
# 每天自动备份
crontab -e

# 添加以下行（每天凌晨2点备份）
0 2 * * * cp /path/to/activations.db /path/to/backups/activations_$(date +\%Y\%m\%d).db
```

### 5. 监控日志

定期检查日志，发现异常活动：

```bash
npm run pm2:logs
```

### 6. 速率限制

调整 `.env` 中的速率限制参数：

```env
MAX_REQUESTS_PER_MINUTE=60
```

### 7. 防火墙配置

只允许必要的端口：

```bash
# UFW (Ubuntu)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# iptables
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
```

---

## 故障排查

### 问题：服务器无法启动

**检查端口占用**

```bash
lsof -i :3000
```

**检查日志**

```bash
npm run pm2:logs
```

### 问题：数据库错误

**检查数据库文件权限**

```bash
ls -la activations.db
chmod 666 activations.db
```

### 问题：激活码验证失败

**检查时钟同步**

```bash
# Linux
ntpdate pool.ntp.org

# macOS
sudo sntp -sS time.apple.com
```

**检查公钥文件**

```bash
ls -la keys/
cat keys/public.pem
```

### 问题：RSA密钥生成失败

**手动生成密钥**

```bash
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
chmod 600 keys/private.pem
```

---

## 性能优化

### 1. 使用连接池

对于高并发场景，使用 PostgreSQL 替代 SQLite：

```javascript
const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  database: 'activations',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 2. 启用缓存

使用 Redis 缓存验证结果：

```javascript
const Redis = require('redis');
const redis = Redis.createClient();

// 验证前先检查缓存
const cached = await redis.get(`validation:${licenseKey}`);
if (cached) {
  return JSON.parse(cached);
}
```

### 3. 负载均衡

使用多个服务器实例：

```bash
pm2 start validate-server.js -i max
```

---

## 监控和告警

### 使用 PM2 Plus

```bash
pm2 link <secret_key> <public_key>
```

### 设置健康检查监控

```bash
# 每5分钟检查一次
*/5 * * * * curl -f http://localhost:3000/health || echo "Server down!" | mail -s "Alert" admin@example.com
```

---

## 版本更新

### 备份数据

```bash
cp activations.db activations.db.backup
```

### 更新代码

```bash
git pull
npm install
```

### 重启服务

```bash
npm run pm2:restart
```

---

## 支持

如有问题，请联系：support@predict.fun

---

**版本**: 1.0.0
**更新**: 2026-02-22
**作者**: Predict.fun Team
