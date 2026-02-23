#!/usr/bin/env node
/**
 * 🔐 激活码生成器（管理员工具）
 *
 * ⚠️  警告：此文件包含敏感的激活码生成逻辑
 * 请勿将此文件上传到公开仓库
 *
 * 使用方法：
 *   node private/admin-tools/key-generator.ts <用户ID> <天数> [用户名]
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface ActivationData {
  userId: string;
  userName: string;
  machineId: string;
  expireDate: number;
  features: string[];
  timestamp: number;
}

/**
 * 激活码生成器（仅管理员使用）
 */
class AdminActivationManager {
  private static readonly SECRET_KEY = 'PREDICT_FUN_ARBITRAGE_2025_SECRET'; // ⚠️ 生产环境请更换为更复杂的密钥

  /**
   * 生成机器ID（必须与用户端一致）
   */
  private static generateMachineId(): string {
    const networkInterfaces = os.networkInterfaces();

    let mac = 'unknown';
    for (const name of Object.keys(networkInterfaces)) {
      const nets = networkInterfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        if (net.mac && mac === 'unknown') {
          mac = net.mac;
          break;
        }
      }
      if (mac !== 'unknown') break;
    }

    const machineInfo = `${os.platform()}-${os.arch()}-${mac}`;
    return crypto.createHash('sha256').update(machineInfo).digest('hex').substring(0, 16);
  }

  /**
   * 生成激活码
   */
  static generateLicenseKey(userId: string, userName: string, days: number = 365): string {
    const machineId = this.generateMachineId();
    const expireDate = Date.now() + days * 24 * 60 * 60 * 1000;

    const data: ActivationData = {
      userId,
      userName,
      machineId,
      expireDate,
      features: ['arbitrage', 'auto_trading'],
      timestamp: Date.now(),
    };

    // 加密数据
    const jsonString = JSON.stringify(data);
    const encrypted = crypto.createHash('sha256')
      .update(jsonString + this.SECRET_KEY)
      .digest('hex');

    // 生成激活码格式: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
    const licenseKey = [
      encrypted.substring(0, 4),
      encrypted.substring(4, 8),
      encrypted.substring(8, 12),
      encrypted.substring(12, 16),
      encrypted.substring(16, 20),
      encrypted.substring(20, 24),
      encrypted.substring(24, 28),
      encrypted.substring(28, 32),
    ].join('-').toUpperCase();

    return licenseKey;
  }

  /**
   * 批量生成激活码
   */
  static generateBatchLicenses(users: Array<{ userId: string; userName: string; days: number }>): Map<string, string> {
    const licenses = new Map();

    for (const user of users) {
      const licenseKey = this.generateLicenseKey(user.userId, user.userName, user.days);
      licenses.set(user.userId, licenseKey);
    }

    return licenses;
  }

  /**
   * 生成用户数据库（CSV格式）
   */
  static exportToCSV(licenses: Map<string, string>): string {
    let csv = 'UserId,UserName,LicenseKey,GeneratedDate\n';

    for (const [userId, licenseKey] of licenses.entries()) {
      csv += `${userId},User,${licenseKey},${new Date().toISOString()}\n`;
    }

    return csv;
  }
}

// CLI 接口
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('\n🔐 激活码生成器（管理员工具）');
    console.log('='.repeat(60));
    console.log('\n使用方法:');
    console.log('  node key-generator.ts <用户ID> <天数> [用户名]');
    console.log('\n示例:');
    console.log('  node key-generator.ts user123 365 "John Doe"');
    console.log('  node key-generator.ts test_user 30');
    console.log('\n⚠️  警告：请妥善保管生成的激活码，不要泄露！');
    process.exit(1);
  }

  const userId = args[0];
  const days = parseInt(args[1]);
  const userName = args[2] || 'User';

  if (isNaN(days) || days <= 0) {
    console.error('❌ 错误：天数必须是正整数');
    process.exit(1);
  }

  console.log('\n🔐 激活码生成器（管理员工具）');
  console.log('='.repeat(60));
  console.log(`\n用户ID: ${userId}`);
  console.log(`用户名: ${userName}`);
  console.log(`有效期: ${days} 天`);
  console.log(`到期日期: ${new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleDateString()}`);

  const licenseKey = AdminActivationManager.generateLicenseKey(userId, userName, days);

  console.log('\n✅ 激活码:');
  console.log('─'.repeat(60));
  console.log(licenseKey);
  console.log('─'.repeat(60));

  console.log('\n⚠️  重要提示:');
  console.log('   1. 请将此激活码安全地发送给用户');
  console.log('   2. 记录用户ID与激活码的对应关系');
  console.log('   3. 不要在公开渠道分享激活码');
  console.log('   4. 定期审查使用情况\n');

  // 保存到文件（可选）
  const record = {
    userId,
    userName,
    licenseKey,
    days,
    generatedAt: new Date().toISOString(),
    expireAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  };

  const recordsDir = './private/records';
  if (!fs.existsSync(recordsDir)) {
    fs.mkdirSync(recordsDir, { recursive: true });
  }

  const recordFile = `${recordsDir}/${userId}_${Date.now()}.json`;
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));

  console.log(`📁 记录已保存到: ${recordFile}\n`);
}

main();
