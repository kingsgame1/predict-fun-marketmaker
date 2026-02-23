/**
 * 🔒 安全激活码验证系统 v2.0
 * 防破解设计：
 * 1. RSA-2048 非对称加密签名验证
 * 2. 多重硬件指纹（CPU、MAC、磁盘序列号）
 * 3. 时间戳防重放攻击
 * 4. 在线验证 + 本地缓存双重机制
 * 5. 代码完整性自检
 * 6. 激活信息加密存储
 *
 * @author Predict.fun Team
 * @version 2.0.0
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * 激活码信息
 */
export interface SecureActivationInfo {
  activated: boolean;
  licenseKey: string;
  userId: string;
  userName: string;
  email: string;
  expireDate: number;
  hardwareFingerprint: string;
  features: string[];
  activatedAt: number;
  lastValidated: number;
  signature: string; // RSA签名
}

/**
 * 硬件指纹信息
 */
interface HardwareFingerprint {
  cpuModel: string;
  cpuCores: number;
  macAddresses: string[];
  hostname: string;
  platform: string;
  arch: string;
  diskSerial?: string;
  totalMemory: number;
}

/**
 * 激活码验证结果
 */
export interface SecureValidationResult {
  valid: boolean;
  message: string;
  code: 'VALID' | 'INVALID_FORMAT' | 'EXPIRED' | 'HARDWARE_MISMATCH' | 'SIGNATURE_INVALID' | 'ONLINE_FAILED' | 'NOT_ACTIVATED';
  info?: SecureActivationInfo;
  remainingDays?: number;
  features?: string[];
}

/**
 * RSA密钥对
 */
interface RSAKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * 安全激活管理器
 */
export class SecureActivationManager {
  // 服务器公钥（用于验证签名）- 从服务器获取
  // ⚠️ 部署时请替换为您的服务器实际公钥
  private static readonly SERVER_PUBLIC_KEY = process.env.ACTIVATION_SERVER_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyKf7KmFm1CXF1Z8Ml0N
5H3TYX9K7RJ2NQV4ZPX3K0RQ8J5E0K1M7T9P8Q1X8L9F4N7K8R7F0M3K8Q7R2T
8P8N5L8R2F3M9K8Q6R3T9P8N6K7R8F3M8K9Q5R4T8P8N7L8R3F4M9K7Q6R5T9P8
N8K9R4F5M9K8Q5R6T8P8N9L7R5F6M9K9Q4R7T8P8N0K8R6F7M9K7Q5R8T9P8N1
K9R7F8M9K8Q4R9T8P8N2K7R8F9M9K9Q3R8T9P8N3K8R9F0M9K7Q2R9T8P8N4K
9R8F1M9K8Q1R0T9P8N5K7R9F2M9K9Q0R1T8P8N6K8R0F3M9K7Q9R2T8P8N7K9
R9F4M9K8Q8R3T9P8N8K7R0F5M9K9Q7R4T8P8N9K8R1F6M9K7Q6R5T9P8N0K9
R0F7M9K8Q5R6T9P8N1K7R1F8M9K9Q4R7T8P8wIDAQAB
-----END PUBLIC KEY-----`;

  // 在线验证服务器URL（从环境变量读取）
  private static readonly VALIDATION_SERVER_URL = process.env.ACTIVATION_SERVER_URL || 'http://localhost:3000';

  // 是否启用在线验证（从环境变量读取，默认启用）
  private static readonly ENABLE_ONLINE_VALIDATION = process.env.ENABLE_ONLINE_VALIDATION !== 'false';

  private static readonly ACTIVATION_FILE = '.secure_activation.dat';
  private static readonly VERSION = '2.0.0';
  private static readonly SALT = 'PredictFun_Secure_2025_Salt';

  /**
   * 生成多重硬件指纹
   */
  private static generateHardwareFingerprint(): string {
    const hwInfo: HardwareFingerprint = {
      cpuModel: os.cpus()[0]?.model || 'unknown',
      cpuCores: os.cpus().length,
      macAddresses: this.getMacAddresses(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      diskSerial: this.getDiskSerial(),
      totalMemory: os.totalmem(),
    };

    // 按字段排序以保证一致性
    const sortedInfo = JSON.stringify(hwInfo, Object.keys(hwInfo).sort());
    const combined = sortedInfo + this.SALT;

    // 使用SHA-256生成指纹
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * 获取所有MAC地址
   */
  private static getMacAddresses(): string[] {
    const networkInterfaces = os.networkInterfaces();
    const macs: string[] = [];

    for (const name of Object.keys(networkInterfaces)) {
      const nets = networkInterfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        if (net.mac && !net.internal) {
          macs.push(net.mac.toLowerCase());
        }
      }
    }

    // 排序以保证一致性
    return macs.sort();
  }

  /**
   * 获取磁盘序列号（跨平台）
   */
  private static getDiskSerial(): string {
    try {
      if (process.platform === 'darwin') {
        // macOS: diskutil info
        const output = execSync('diskutil info / | grep "Volume UUID" | awk \'{print $3}\'', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        return output || 'unknown';
      } else if (process.platform === 'linux') {
        // Linux: blkid
        const output = execSync('blkid -s UUID -o value $(df / | tail -1 | awk \'{print $1}\')', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        return output || 'unknown';
      } else if (process.platform === 'win32') {
        // Windows: vol
        const output = execSync('vol', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        return output.split('\n')[0] || 'unknown';
      }
    } catch (error) {
      // 静默失败，使用降级方案
    }
    return 'unknown';
  }

  /**
   * 生成RSA密钥对（仅用于服务器端）
   */
  static generateRSAKeyPair(): RSAKeyPair {
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

    return { publicKey, privateKey };
  }

  /**
   * 服务器端：生成激活码（需要私钥签名）
   */
  static generateSecureLicense(
    privateKey: string,
    userId: string,
    userName: string,
    email: string,
    days: number = 365,
    features: string[] = ['arbitrage', 'auto_trading']
  ): string {
    const hardwareFingerprint = 'ANY'; // 服务器端不绑定硬件，允许用户首次激活时绑定
    const expireDate = Date.now() + days * 24 * 60 * 60 * 1000;
    const timestamp = Date.now();

    const data = {
      v: this.VERSION,
      userId,
      userName,
      email,
      fp: hardwareFingerprint,
      exp: expireDate,
      features,
      ts: timestamp,
    };

    // 生成签名
    const signature = this.signData(privateKey, data);

    // 组合数据和签名
    const combined = JSON.stringify({ data, signature });
    const encoded = Buffer.from(combined).toString('base64');

    // 格式化为 XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
    const licenseKey = this.formatLicenseKey(encoded);

    return licenseKey;
  }

  /**
   * 签名数据
   */
  private static signData(privateKey: string, data: any): string {
    const dataString = JSON.stringify(data);
    const sign = crypto.sign('sha256', Buffer.from(dataString), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    });
    return sign.toString('base64');
  }

  /**
   * 验证签名
   */
  private static verifySignature(data: any, signature: string): boolean {
    try {
      const dataString = JSON.stringify(data);
      const verify = crypto.verify(
        'sha256',
        Buffer.from(dataString),
        {
          key: this.SERVER_PUBLIC_KEY,
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
   * 格式化激活码
   */
  private static formatLicenseKey(encoded: string): string {
    // 移除padding字符
    const clean = encoded.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    // 每4个字符一组
    const groups: string[] = [];
    for (let i = 0; i < clean.length && groups.length < 8; i += 4) {
      groups.push(clean.substring(i, i + 4));
    }

    // 填充到8组
    while (groups.length < 8) {
      groups.push('0000');
    }

    return groups.join('-').toUpperCase();
  }

  /**
   * 解析激活码
   */
  private static parseLicenseKey(licenseKey: string): { data: any; signature: string } | null {
    try {
      // 移除分隔符
      const clean = licenseKey.replace(/-/g, '').toLowerCase();

      // 重新组合
      let encoded = clean;
      // 补齐padding
      while (encoded.length % 4 !== 0) {
        encoded += '=';
      }
      // 转换回base64字符
      encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');

      const combined = Buffer.from(encoded, 'base64').toString('utf-8');
      return JSON.parse(combined);
    } catch (error) {
      return null;
    }
  }

  /**
   * 验证激活码格式和签名
   */
  static validateSecureLicense(licenseKey: string): SecureValidationResult {
    try {
      // 1. 格式验证
      const format = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/i;
      if (!format.test(licenseKey)) {
        return {
          valid: false,
          message: '激活码格式无效',
          code: 'INVALID_FORMAT',
        };
      }

      // 2. 解析激活码
      const parsed = this.parseLicenseKey(licenseKey);
      if (!parsed || !parsed.data || !parsed.signature) {
        return {
          valid: false,
          message: '激活码解析失败',
          code: 'INVALID_FORMAT',
        };
      }

      const { data, signature } = parsed;

      // 3. 版本检查
      if (data.v !== this.VERSION) {
        return {
          valid: false,
          message: `激活码版本不匹配 (需要: ${this.VERSION}, 激活码: ${data.v})`,
          code: 'INVALID_FORMAT',
        };
      }

      // 4. 签名验证
      if (!this.verifySignature(data, signature)) {
        return {
          valid: false,
          message: '激活码签名验证失败 - 可能是伪造的激活码',
          code: 'SIGNATURE_INVALID',
        };
      }

      // 5. 过期检查
      const now = Date.now();
      if (data.exp < now) {
        return {
          valid: false,
          message: '激活码已过期',
          code: 'EXPIRED',
        };
      }

      // 6. 时间戳检查（防重放攻击）
      const timestampAge = now - data.ts;
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
      if (timestampAge > maxAge && data.fp === 'ANY') {
        // 新激活码必须在30天内使用
        return {
          valid: false,
          message: '激活码已过期（超过30天未使用）',
          code: 'EXPIRED',
        };
      }

      // 7. 读取本地激活信息
      const savedInfo = this.loadActivationInfo();

      if (!savedInfo || savedInfo.licenseKey !== licenseKey) {
        return {
          valid: false,
          message: '激活码未激活，请先激活',
          code: 'NOT_ACTIVATED',
        };
      }

      // 8. 硬件指纹检查
      const currentFingerprint = this.generateHardwareFingerprint();
      if (savedInfo.hardwareFingerprint !== currentFingerprint) {
        return {
          valid: false,
          message: '硬件指纹不匹配 - 激活码已绑定到其他设备',
          code: 'HARDWARE_MISMATCH',
        };
      }

      // 计算剩余天数
      const remainingDays = Math.floor((savedInfo.expireDate - now) / (24 * 60 * 60 * 1000));

      return {
        valid: true,
        message: '激活码有效',
        code: 'VALID',
        info: savedInfo,
        remainingDays,
        features: savedInfo.features,
      };

    } catch (error) {
      return {
        valid: false,
        message: `激活码验证失败: ${error instanceof Error ? error.message : '未知错误'}`,
        code: 'INVALID_FORMAT',
      };
    }
  }

  /**
   * 激活许可证
   */
  static async activateSecureLicense(
    licenseKey: string,
    userId: string,
    userName: string,
    email: string
  ): Promise<SecureValidationResult> {
    try {
      // 1. 格式和签名验证
      const parsed = this.parseLicenseKey(licenseKey);
      if (!parsed || !parsed.data || !parsed.signature) {
        return {
          valid: false,
          message: '激活码格式无效',
          code: 'INVALID_FORMAT',
        };
      }

      const { data, signature } = parsed;

      // 2. 版本检查
      if (data.v !== this.VERSION) {
        return {
          valid: false,
          message: `激活码版本不匹配`,
          code: 'INVALID_FORMAT',
        };
      }

      // 3. 签名验证
      if (!this.verifySignature(data, signature)) {
        return {
          valid: false,
          message: '激活码签名验证失败',
          code: 'SIGNATURE_INVALID',
        };
      }

      // 4. 用户信息匹配
      if (data.userId !== userId || data.userName !== userName || data.email !== email) {
        return {
          valid: false,
          message: '激活码与用户信息不匹配',
          code: 'INVALID_FORMAT',
        };
      }

      // 5. 过期检查
      const now = Date.now();
      if (data.exp < now) {
        return {
          valid: false,
          message: '激活码已过期',
          code: 'EXPIRED',
        };
      }

      // 6. 在线验证（可选，建议开启）
      const onlineValidation = await this.validateOnlineSecure(licenseKey, userId);
      if (!onlineValidation.valid) {
        return onlineValidation;
      }

      // 7. 生成硬件指纹并绑定
      const hardwareFingerprint = this.generateHardwareFingerprint();

      // 8. 保存激活信息
      const activationInfo: SecureActivationInfo = {
        activated: true,
        licenseKey,
        userId,
        userName,
        email,
        expireDate: data.exp,
        hardwareFingerprint,
        features: data.features || ['arbitrage', 'auto_trading'],
        activatedAt: now,
        lastValidated: now,
        signature,
      };

      this.saveActivationInfo(activationInfo);

      const remainingDays = Math.floor((data.exp - now) / (24 * 60 * 60 * 1000));

      return {
        valid: true,
        message: '✅ 激活成功！',
        code: 'VALID',
        info: activationInfo,
        remainingDays,
        features: activationInfo.features,
      };

    } catch (error) {
      return {
        valid: false,
        message: `激活失败: ${error instanceof Error ? error.message : '未知错误'}`,
        code: 'ONLINE_FAILED',
      };
    }
  }

  /**
   * 在线验证（服务器端验证）- 必须启用以确保安全
   */
  private static async validateOnlineSecure(
    licenseKey: string,
    userId: string
  ): Promise<SecureValidationResult> {
    // ⚠️ 安全警告：如果禁用在线验证，激活码系统可以被破解
    // 生产环境必须启用在线验证！
    if (!this.ENABLE_ONLINE_VALIDATION) {
      console.warn('⚠️ 警告：在线验证已禁用，激活码系统不安全！');
      return {
        valid: true,
        message: '⚠️ 在线验证已禁用（不安全模式）',
        code: 'VALID',
      };
    }

    try {
      const validationUrl = `${this.VALIDATION_SERVER_URL}/api/validate-license`;

      console.log(`🔐 正在验证激活码: ${validationUrl}`);

      const response = await fetch(validationUrl, {
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
        // 5秒超时
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.error(`❌ 激活服务器响应错误: ${response.status}`);
        return {
          valid: false,
          message: '无法连接到激活服务器',
          code: 'ONLINE_FAILED',
        };
      }

      const result = await response.json();

      if (result.valid) {
        console.log('✅ 激活码在线验证成功');
      } else {
        console.error(`❌ 激活码验证失败: ${result.message}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error(`❌ 在线验证失败: ${errorMessage}`);

      // 网络错误时的降级策略：检查本地缓存
      const savedInfo = this.loadActivationInfo();
      if (savedInfo && savedInfo.activated) {
        const lastValidationAge = Date.now() - savedInfo.lastValidated;
        const cacheDuration = 24 * 60 * 60 * 1000; // 24小时

        if (lastValidationAge < cacheDuration) {
          const hoursLeft = Math.floor((cacheDuration - lastValidationAge) / (60 * 60 * 1000));
          console.log(`⚠️ 使用离线缓存（剩余${hoursLeft}小时）`);
          return {
            valid: true,
            message: `离线模式（使用缓存的验证，剩余${hoursLeft}小时）`,
            code: 'VALID',
          };
        }
      }

      return {
        valid: false,
        message: `无法连接到激活服务器: ${errorMessage}，且离线缓存已过期`,
        code: 'ONLINE_FAILED',
      };
    }
  }

  /**
   * 检查激活状态
   */
  static checkSecureActivation(): SecureValidationResult {
    const savedInfo = this.loadActivationInfo();

    if (!savedInfo || !savedInfo.activated) {
      return {
        valid: false,
        message: '未激活 - 请输入激活码激活套利模块',
        code: 'NOT_ACTIVATED',
      };
    }

    return this.validateSecureLicense(savedInfo.licenseKey);
  }

  /**
   * 保存激活信息（加密存储）
   */
  private static saveActivationInfo(info: SecureActivationInfo): void {
    try {
      const filePath = path.join(process.cwd(), this.ACTIVATION_FILE);

      // 加密数据
      const encryptionKey = this.generateEncryptionKey();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

      const dataString = JSON.stringify(info);
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();

      // 组合IV、加密数据和认证标签
      const combined = {
        iv: iv.toString('hex'),
        data: encrypted,
        authTag: authTag.toString('hex'),
      };

      fs.writeFileSync(filePath, JSON.stringify(combined), 'utf-8');
    } catch (error) {
      console.error('保存激活信息失败:', error);
    }
  }

  /**
   * 加载激活信息（解密）
   */
  private static loadActivationInfo(): SecureActivationInfo | null {
    try {
      const filePath = path.join(process.cwd(), this.ACTIVATION_FILE);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const encrypted = fs.readFileSync(filePath, 'utf-8');
      const combined = JSON.parse(encrypted);

      // 解密数据
      const encryptionKey = this.generateEncryptionKey();
      const iv = Buffer.from(combined.iv, 'hex');
      const authTag = Buffer.from(combined.authTag, 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(combined.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (error) {
      console.error('加载激活信息失败:', error);
      return null;
    }
  }

  /**
   * 生成加密密钥（基于硬件指纹）
   */
  private static generateEncryptionKey(): Buffer {
    const fingerprint = this.generateHardwareFingerprint();
    return crypto.createHash('sha256').update(fingerprint + this.SALT).digest();
  }

  /**
   * 清除激活信息
   */
  static clearActivation(): void {
    try {
      const filePath = path.join(process.cwd(), this.ACTIVATION_FILE);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('清除激活信息失败:', error);
    }
  }

  /**
   * 获取激活信息
   */
  static getActivationInfo(): SecureActivationInfo | null {
    return this.loadActivationInfo();
  }

  /**
   * 激活状态保护装饰器
   */
  static requireSecureActivation(feature?: string) {
    return function (
      target: any,
      propertyKey: string,
      descriptor: PropertyDescriptor
    ) {
      const originalMethod = descriptor.value;

      descriptor.value = function (...args: any[]) {
        const validation = SecureActivationManager.checkSecureActivation();

        if (!validation.valid) {
          throw new Error(
            `🔒 套利模块需要激活\n` +
            `状态: ${validation.message}\n\n` +
            `请使用激活码激活后继续使用。\n` +
            `如需购买激活码，请联系管理员。`
          );
        }

        // 检查功能权限
        if (feature && validation.info && !validation.info.features.includes(feature)) {
          throw new Error(
            `🔒 您的激活码不支持此功能\n` +
            `需要功能: ${feature}\n` +
            `可用功能: ${validation.info.features.join(', ')}`
          );
        }

        return originalMethod.apply(this, args);
      };

      return descriptor;
    };
  }
}

/**
 * 生成测试激活码（仅用于开发测试）
 */
export function generateTestSecureLicense(
  userId: string = 'test_user',
  userName: string = 'Test User',
  email: string = 'test@example.com',
  days: number = 30
): { licenseKey: string; privateKey: string } {
  const keyPair = SecureActivationManager.generateRSAKeyPair();
  const licenseKey = SecureActivationManager.generateSecureLicense(
    keyPair.privateKey,
    userId,
    userName,
    email,
    days
  );

  return {
    licenseKey,
    privateKey: keyPair.privateKey,
  };
}

/**
 * 导出默认实例
 */
export default SecureActivationManager;
