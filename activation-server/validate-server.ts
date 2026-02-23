/**
 * 🔐 激活码验证服务器
 * Node.js + Express + SQLite
 *
 * 部署说明：
 * 1. 安装依赖: npm install express sqlite3 cors body-parser helmet rate-limiter-flexible
 * 2. 配置环境变量（见 .env.example）
 * 3. 启动服务器: node validate-server.js
 * 4. 使用 PM2 守护进程: pm2 start validate-server.js --name activation-server
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// 配置
const config = {
  port: process.env.ACTIVATION_PORT || 3000,
  dbPath: process.env.DB_PATH || './activations.db',
  rsaPrivateKeyPath: process.env.RSA_PRIVATE_KEY_PATH || './keys/private.pem',
  rsaPublicKeyPath: process.env.RSA_PUBLIC_KEY_PATH || './keys/public.pem',
  adminApiKey: process.env.ADMIN_API_KEY || 'change-me-in-production',
  maxRequestsPerMinute: process.env.MAX_REQUESTS_PER_MINUTE || 60,
  maxActivationsPerKey: process.env.MAX_ACTIVATIONS_PER_KEY || 3,
};

// Express应用
const app = express();

// 中间件
app.use(helmet()); // 安全头
app.use(cors()); // CORS
app.use(bodyParser.json());

// 速率限制
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: config.maxRequestsPerMinute,
  message: { valid: false, message: '请求过于频繁，请稍后再试' },
});

app.use('/api/', limiter);

/**
 * 数据库初始化
 */
async function initializeDatabase() {
  const db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database,
  });

  // 创建表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS activations (
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

    CREATE INDEX IF NOT EXISTS idx_license_key ON activations(license_key);
    CREATE INDEX IF NOT EXISTS idx_user_id ON activations(user_id);
    CREATE INDEX IF NOT EXISTS idx_email ON activations(email);

    CREATE TABLE IF NOT EXISTS validation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT NOT NULL,
      user_id TEXT,
      hardware_fingerprint TEXT,
      ip_address TEXT,
      result TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_validation_timestamp ON validation_logs(timestamp);
  `);

  return db;
}

/**
 * 验证签名
 */
function verifySignature(data: any, signature: string, publicKey: string): boolean {
  try {
    const dataString = JSON.stringify(data);
    const verify = crypto.verify(
      'sha256',
      Buffer.from(dataString),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      },
      Buffer.from(signature, 'base64')
    );
    return verify;
  } catch (error) {
    return false;
  }
}

/**
 * API: 验证激活码
 */
app.post('/api/validate-license', async (req, res) => {
  try {
    const { licenseKey, userId, hardwareFingerprint, timestamp } = req.body;

    // 基本参数验证
    if (!licenseKey || !userId) {
      return res.status(400).json({
        valid: false,
        message: '缺少必要参数',
      });
    }

    // 时间戳验证（防重放攻击）
    const now = Date.now();
    if (timestamp && Math.abs(now - timestamp) > 5 * 60 * 1000) {
      return res.status(400).json({
        valid: false,
        message: '时间戳无效',
      });
    }

    // 读取公钥
    const publicKey = fs.readFileSync(config.rsaPublicKeyPath, 'utf-8');

    // 解析激活码
    const parsed = parseLicenseKey(licenseKey);
    if (!parsed || !parsed.data || !parsed.signature) {
      return res.status(400).json({
        valid: false,
        message: '激活码格式无效',
      });
    }

    // 验证签名
    if (!verifySignature(parsed.data, parsed.signature, publicKey)) {
      return res.status(400).json({
        valid: false,
        message: '激活码签名验证失败',
      });
    }

    // 查询数据库
    const db = req.app.get('db');
    const activation = await db.get(
      'SELECT * FROM activations WHERE license_key = ?',
      [licenseKey]
    );

    if (!activation) {
      return res.status(404).json({
        valid: false,
        message: '激活码不存在',
      });
    }

    // 检查用户匹配
    if (activation.user_id !== userId) {
      return res.status(403).json({
        valid: false,
        message: '用户ID不匹配',
      });
    }

    // 检查过期
    if (activation.expire_date < now) {
      return res.status(400).json({
        valid: false,
        message: '激活码已过期',
      });
    }

    // 硬件指纹检查（如果已经绑定）
    if (activation.hardware_fingerprint && activation.hardware_fingerprint !== hardwareFingerprint) {
      return res.status(403).json({
        valid: false,
        message: '硬件指纹不匹配',
      });
    }

    // 首次激活：绑定硬件指纹
    if (!activation.hardware_fingerprint && hardwareFingerprint) {
      await db.run(
        'UPDATE activations SET hardware_fingerprint = ?, activation_count = activation_count + 1 WHERE license_key = ?',
        [hardwareFingerprint, licenseKey]
      );
    }

    // 更新最后验证时间
    await db.run(
      'UPDATE activations SET last_validated = ? WHERE license_key = ?',
      [now, licenseKey]
    );

    // 记录验证日志
    await db.run(
      'INSERT INTO validation_logs (license_key, user_id, hardware_fingerprint, ip_address, result) VALUES (?, ?, ?, ?, ?)',
      [
        licenseKey,
        userId,
        hardwareFingerprint,
        req.ip,
        'success',
      ]
    );

    // 返回成功
    const remainingDays = Math.floor((activation.expire_date - now) / (24 * 60 * 60 * 1000));

    return res.json({
      valid: true,
      message: '验证成功',
      code: 'VALID',
      remainingDays,
      features: JSON.parse(activation.features || '[]'),
    });

  } catch (error) {
    console.error('验证失败:', error);
    return res.status(500).json({
      valid: false,
      message: '服务器内部错误',
    });
  }
});

/**
 * API: 激活新许可证（管理员使用）
 */
app.post('/api/admin/activate', async (req, res) => {
  try {
    const { adminApiKey, licenseKey, userId, userName, email, days, features } = req.body;

    // 管理员API密钥验证
    if (adminApiKey !== config.adminApiKey) {
      return res.status(403).json({
        valid: false,
        message: '管理员权限验证失败',
      });
    }

    // 读取私钥
    const privateKey = fs.readFileSync(config.rsaPrivateKeyPath, 'utf-8');

    // 生成激活码
    const newLicenseKey = generateLicenseKey(privateKey, userId, userName, email, days, features);

    // 保存到数据库
    const db = req.app.get('db');
    const now = Date.now();
    const expireDate = now + days * 24 * 60 * 60 * 1000;

    await db.run(
      'INSERT INTO activations (license_key, user_id, user_name, email, expire_date, features, activated_at, last_validated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        newLicenseKey,
        userId,
        userName,
        email,
        expireDate,
        JSON.stringify(features || []),
        now,
        now,
      ]
    );

    return res.json({
      success: true,
      licenseKey: newLicenseKey,
      userId,
      userName,
      email,
      expireDate,
      remainingDays: days,
    });

  } catch (error) {
    console.error('激活失败:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * API: 查询激活信息
 */
app.get('/api/admin/activations', async (req, res) => {
  try {
    const { adminApiKey } = req.query;

    if (adminApiKey !== config.adminApiKey) {
      return res.status(403).json({
        valid: false,
        message: '管理员权限验证失败',
      });
    }

    const db = req.app.get('db');
    const activations = await db.all('SELECT * FROM activations ORDER BY created_at DESC');

    return res.json({
      success: true,
      count: activations.length,
      activations: activations.map((a: any) => ({
        licenseKey: a.license_key,
        userId: a.user_id,
        userName: a.user_name,
        email: a.email,
        expireDate: a.expire_date,
        features: JSON.parse(a.features || '[]'),
        activationCount: a.activation_count,
        createdAt: a.created_at,
        lastValidated: a.last_validated,
      })),
    });

  } catch (error) {
    console.error('查询失败:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * API: 健康检查
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
  });
});

/**
 * 辅助函数：解析激活码
 */
function parseLicenseKey(licenseKey: string): { data: any; signature: string } | null {
  try {
    const clean = licenseKey.replace(/-/g, '').toLowerCase();
    let encoded = clean;
    while (encoded.length % 4 !== 0) {
      encoded += '=';
    }
    encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');

    const combined = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(combined);
  } catch (error) {
    return null;
  }
}

/**
 * 辅助函数：生成激活码
 */
function generateLicenseKey(
  privateKey: string,
  userId: string,
  userName: string,
  email: string,
  days: number,
  features: string[]
): string {
  const VERSION = '2.0.0';
  const now = Date.now();

  const data = {
    v: VERSION,
    userId,
    userName,
    email,
    fp: 'ANY',
    exp: now + days * 24 * 60 * 60 * 1000,
    features,
    ts: now,
  };

  const dataString = JSON.stringify(data);
  const sign = crypto.sign('sha256', Buffer.from(dataString), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  });

  const signature = sign.toString('base64');
  const combined = JSON.stringify({ data, signature });
  const encoded = Buffer.from(combined).toString('base64');

  const clean = encoded.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const groups: string[] = [];
  for (let i = 0; i < clean.length && groups.length < 8; i += 4) {
    groups.push(clean.substring(i, i + 4));
  }
  while (groups.length < 8) {
    groups.push('0000');
  }

  return groups.join('-').toUpperCase();
}

/**
 * 启动服务器
 */
async function startServer() {
  try {
    // 确保密钥目录存在
    const keysDir = path.dirname(config.rsaPrivateKeyPath);
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
    }

    // 生成RSA密钥对（如果不存在）
    if (!fs.existsSync(config.rsaPrivateKeyPath) || !fs.existsSync(config.rsaPublicKeyPath)) {
      console.log('🔐 生成RSA密钥对...');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
        },
      });

      fs.writeFileSync(config.rsaPrivateKeyPath, privateKey, { mode: 0o600 });
      fs.writeFileSync(config.rsaPublicKeyPath, publicKey);
      console.log('✅ RSA密钥对已生成');
    }

    // 初始化数据库
    console.log('📊 初始化数据库...');
    const db = await initializeDatabase();
    app.set('db', db);
    console.log('✅ 数据库初始化完成');

    // 启动监听
    app.listen(config.port, () => {
      console.log('');
      console.log('╔════════════════════════════════════════════════════╗');
      console.log('║  🔐 激活码验证服务器                                 ║');
      console.log('╠════════════════════════════════════════════════════╣');
      console.log(`║  状态: ✅ 运行中                                      ║`);
      console.log(`║  端口: ${config.port}                                      ║`);
      console.log(`║  数据库: ${config.dbPath}                    ║`);
      console.log(`║  密钥目录: ${keysDir}                    ║`);
      console.log('╠════════════════════════════════════════════════════╣');
      console.log('║  API端点:                                           ║');
      console.log('║  POST /api/validate-license - 验证激活码            ║');
      console.log('║  POST /api/admin/activate - 生成激活码（管理员）    ║');
      console.log('║  GET  /api/admin/activations - 查询列表（管理员）   ║');
      console.log('║  GET  /health - 健康检查                             ║');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log('');
    });

  } catch (error) {
    console.error('❌ 启动失败:', error);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('⏹️  收到SIGTERM信号，正在关闭服务器...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n⏹️  收到SIGINT信号，正在关闭服务器...');
  process.exit(0);
});

// 启动
startServer();
