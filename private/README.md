# 🔐 激活码系统安全管理指南

## ⚠️ 重要安全警告

**private/** 目录包含敏感的管理员工具和密钥信息，**绝对不能**上传到公开仓库！

## 📁 目录结构

```
private/
├── admin-tools/          # 管理员工具（不公开）
│   ├── key-generator.ts  # 激活码生成器
│   └── user-manager.ts   # 用户管理工具
├── records/              # 激活码记录（不公开）
│   └── *.json           # 用户激活记录
└── database/            # 用户数据库（不公开）
    └── users.json       # 用户信息数据库
```

## 🔒 安全机制

### 1. 激活码生成原理

```typescript
// 激活码 = SHA256(用户数据 + 机器ID + 密钥)
const encrypted = sha256(userId + userName + machineId + expireDate + SECRET_KEY);
const licenseKey = formatAsXXXX(encrypted); // XXXX-XXXX-XXXX-XXXX-XXXX
```

**关键点**:
- SECRET_KEY 存储在管理员工具中，不公开
- machineId 绑定到用户硬件（MAC + OS + CPU）
- 激活码不可逆，无法从激活码反推出密钥

### 2. 防破解措施

| 措施 | 说明 | 安全性 |
|------|------|--------|
| **机器绑定** | 激活码绑定到硬件ID | ⭐⭐⭐⭐⭐ 无法在其他机器使用 |
| **时间限制** | 激活码有固定有效期 | ⭐⭐⭐⭐ 过期自动失效 |
| **单向哈希** | SHA-256 不可逆加密 | ⭐⭐⭐⭐⭐ 无法破解密钥 |
| **功能限制** | 只授权特定功能 | ⭐⭐⭐ 无法越权使用 |
| **本地验证** | 无需联网验证 | ⭐⭐⭐ 离线可用 |
| **混淆代码** | 编译后难以逆向 | ⭐⭐⭐⭐ 增加破解难度 |

### 3. 可能的攻击方式及防护

#### ❌ 攻击1：修改系统时间绕过过期
**防护**:
- 记录激活时间戳
- 检测系统时间倒流
- 在线验证（可选）

#### ❌ 攻击2：虚拟机克隆
**防护**:
- MAC地址绑定
- 硬盘序列号（可选增强）
- CPU ID（可选增强）

#### ❌ 攻击3：逆向工程破解验证逻辑
**防护**:
- TypeScript 编译后代码混淆
- 使用 JavaScript Obfuscator
- 关键逻辑加密（可选）

#### ❌ 攻击4：共享激活码
**防护**:
- 机器绑定防止多台机器使用
- 在线心跳检测（可选）
- 限制激活次数（可选）

## 🛠️ 管理员工具使用

### 生成单个激活码

```bash
node private/admin-tools/key-generator.ts <用户ID> <天数> [用户名]

# 示例
node private/admin-tools/key-generator.ts user123 365 "John Doe"
node private/admin-tools/key-generator.ts test_user 30
```

### 批量生成激活码

```bash
# 创建用户列表
cat > users.json <<EOF
[
  {"userId": "user1", "userName": "Alice", "days": 365},
  {"userId": "user2", "userName": "Bob", "days": 30},
  {"userId": "user3", "userName": "Charlie", "days": 365}
]
EOF

# 批量生成
node private/admin-tools/batch-generator.ts users.json
```

### 查看用户数据库

```bash
node private/admin-tools/user-manager.ts list
node private/admin-tools/user-manager.ts show <userId>
```

### 验证激活码

```bash
node private/admin-tools/key-generator.ts --validate <激活码>
```

## 📊 用户管理

### 数据库结构

```json
{
  "users": [
    {
      "userId": "user123",
      "userName": "John Doe",
      "email": "john@example.com",
      "licenseKey": "A7E5-2F9C-725E-1899-9F93-D64C-0AC4-DBF7",
      "activatedAt": "2026-02-22T16:20:00.000Z",
      "expireAt": "2027-02-22T16:20:00.000Z",
      "days": 365,
      "machineId": "31402d58b5ea7e95",
      "status": "active"
    }
  ]
}
```

### 状态管理

- `active` - 激活且未过期
- `expired` - 已过期
- `revoked` - 已撤销
- `pending` - 未激活

## 🔄 激活流程

```
管理员 → 生成激活码 → 安全发送给用户
         ↓
用户 → 输入激活码 → 本地验证 → 激活成功
         ↓
套利模块 → 检查激活状态 → 允许/拒绝访问
```

## 💡 最佳实践

### 对于管理员

1. **密钥管理**
   - ✅ 定期更换 SECRET_KEY
   - ✅ 使用强随机密钥（至少32字符）
   - ✅ 不要将密钥硬编码在代码中
   - ✅ 使用环境变量或密钥管理服务

2. **用户管理**
   - ✅ 记录所有激活码的分配
   - ✅ 定期审查使用情况
   - ✅ 设置合理的有效期
   - ✅ 提供续费机制

3. **安全审计**
   - ✅ 监控异常激活行为
   - ✅ 记录所有激活尝试
   - ✅ 定期检查泄露的激活码
   - ✅ 建立撤销机制

### 对于用户

1. **激活码保护**
   - ✅ 不要分享激活码
   - ✅ 不要存储在云端
   - ✅ 定期备份激活文件
   - ✅ 注意有效期

2. **机器绑定**
   - ✅ 激活后不要频繁更换硬件
   - ✅ 重装系统前备份激活文件
   - ✅ 联系管理员重新激活（如果需要）

## 🚨 安全事件响应

### 激活码泄露

**步骤**:
1. 立即修改 SECRET_KEY（影响未来生成的激活码）
2. 撤销泄露的激活码
3. 为受影响用户重新生成激活码
4. 调查泄露原因
5. 加强安全措施

### 批量破解尝试

**步骤**:
1. 监控异常激活模式
2. 限制激活频率
3. 添加验证码（可选）
4. 实施IP黑名单（在线验证）

## 🔧 增强安全措施（可选）

### 1. 在线验证服务器

```typescript
// 服务器端验证
app.post('/api/validate', async (req, res) => {
  const { licenseKey, machineId } = req.body;

  // 检查数据库
  const user = await db.users.findOne({ licenseKey });

  if (!user || user.machineId !== machineId) {
    return res.json({ valid: false });
  }

  if (user.expireAt < Date.now()) {
    return res.json({ valid: false, message: '已过期' });
  }

  if (user.status === 'revoked') {
    return res.json({ valid: false, message: '已撤销' });
  }

  res.json({ valid: true, info: user });
});
```

### 2. 硬件指纹增强

```typescript
// 更复杂的机器ID
function getEnhancedMachineId(): string {
  const mac = getMacAddress();
  const cpu = getCpuId();
  const disk = getDiskSerialId();
  const bios = getBiosId();

  return sha256(mac + cpu + disk + bios);
}
```

### 3. 代码混淆

```bash
# 使用 javascript-obfuscator
npm install --save-dev javascript-obfuscator

# 混淆编译后的代码
javascript-obfuscator dist/activation.js --output dist/activation.obf.js
```

### 4. 加密密钥存储

```typescript
// 使用环境变量
import { config } from 'dotenv';

config();
const SECRET_KEY = process.env.ACTIVATION_SECRET_KEY;

// 或使用密钥管理服务
import AWS from 'aws-sdk';
const secrets = new AWS.SecretsManager();
const secret = await secrets.getSecretValue({ SecretId: 'activation-key' }).promise();
```

## 📞 技术支持

如有安全相关问题，请：
1. 不要在公开渠道讨论
2. 通过私密渠道联系
3. 提供详细的安全事件描述

---

**版本**: 1.0.0
**更新时间**: 2026-02-22
**作者**: Claude Sonnet 4.5

⚠️ **警告**: 此文档包含敏感信息，请勿分享给未授权人员！
