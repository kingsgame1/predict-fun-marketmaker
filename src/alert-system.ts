/**
 * 🚨 告警通知系统
 *
 * 实时监控系统状态，发送告警到多个渠道
 *
 * 支持的告警渠道：
 * - 桌面通知
 * - Telegram
 * - 邮件
 * - Webhook
 * - 控制台日志
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { spawn } from 'child_process';
import https from 'https';

/**
 * 告警级别
 */
export enum AlertLevel {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

/**
 * 告警类型
 */
export enum AlertType {
  SYSTEM_START = 'system_start',
  SYSTEM_STOP = 'system_stop',
  EXECUTION_SUCCESS = 'execution_success',
  EXECUTION_FAILURE = 'execution_failure',
  LARGE_PROFIT = 'large_profit',
  LARGE_LOSS = 'large_loss',
  HIGH_SLIPPAGE = 'high_slippage',
  LIQUIDITY_LOW = 'liquidity_low',
  API_ERROR = 'api_error',
  NETWORK_ERROR = 'network_error',
  BALANCE_LOW = 'balance_low',
  DAILY_LIMIT_REACHED = 'daily_limit_reached',
  POSITION_LIMIT_REACHED = 'position_limit_reached',
  CONFIGURATION_ERROR = 'configuration_error',
  OPPORTUNITY_FOUND = 'opportunity_found',
  HEARTBEAT = 'heartbeat'
}

/**
 * 告警消息
 */
export interface AlertMessage {
  level: AlertLevel;
  type: AlertType;
  title: string;
  message: string;
  data?: any;
  timestamp: number;
}

/**
 * 告警配置
 */
export interface AlertConfig {
  // 总开关
  enabled: boolean;

  // 渠道配置
  desktop: boolean;
  telegram: boolean;
  email: boolean;
  webhook: boolean;
  console: boolean;

  // Telegram配置
  telegramBotToken?: string;
  telegramChatId?: string;

  // 邮件配置
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailFrom?: string;
  emailTo?: string;

  // Webhook配置
  webhookUrl?: string;

  // 过滤配置
  minLevel: AlertLevel;
  enableTypes: AlertType[];
  disableTypes: AlertType[];

  // 频率限制（避免刷屏）
  rateLimitSeconds: number;
  maxAlertsPerHour: number;

  // 告警阈值
  thresholds: {
    largeProfitUsd: number;
    largeLossUsd: number;
    highSlippagePercent: number;
    lowLiquidityUsd: number;
    lowBalanceUsd: number;
  };
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AlertConfig = {
  enabled: true,
  desktop: true,
  telegram: false,
  email: false,
  webhook: false,
  console: true,
  minLevel: AlertLevel.INFO,
  enableTypes: [
    AlertType.SYSTEM_START,
    AlertType.SYSTEM_STOP,
    AlertType.EXECUTION_FAILURE,
    AlertType.LARGE_PROFIT,
    AlertType.LARGE_LOSS,
    AlertType.HIGH_SLIPPAGE,
    AlertType.API_ERROR,
    AlertType.DAILY_LIMIT_REACHED
  ],
  disableTypes: [],
  rateLimitSeconds: 60,
  maxAlertsPerHour: 30,
  thresholds: {
    largeProfitUsd: 50,
    largeLossUsd: 20,
    highSlippagePercent: 1.0,
    lowLiquidityUsd: 500,
    lowBalanceUsd: 100
  }
};

/**
 * 告警系统
 */
export class AlertSystem {
  private config: AlertConfig;
  private alertHistory: Map<string, number> = new Map();
  private hourlyCount = 0;
  private hourlyResetTime: number;

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hourlyResetTime = Date.now() + 3600000; // 1小时后重置
  }

  /**
   * 发送告警
   */
  async sendAlert(alert: AlertMessage): Promise<void> {
    // 检查是否启用
    if (!this.config.enabled) {
      return;
    }

    // 检查级别
    if (!this.shouldSendLevel(alert.level)) {
      return;
    }

    // 检查类型
    if (!this.shouldSendType(alert.type)) {
      return;
    }

    // 检查频率限制
    if (this.isRateLimited(alert)) {
      return;
    }

    // 检查每小时限制
    if (this.isHourlyLimitReached()) {
      return;
    }

    // 发送到各个渠道
    const promises = [];

    if (this.config.desktop) {
      promises.push(this.sendDesktopNotification(alert));
    }

    if (this.config.telegram) {
      promises.push(this.sendTelegramAlert(alert));
    }

    if (this.config.email) {
      promises.push(this.sendEmailAlert(alert));
    }

    if (this.config.webhook) {
      promises.push(this.sendWebhookAlert(alert));
    }

    if (this.config.console) {
      this.sendConsoleAlert(alert);
    }

    await Promise.allSettled(promises);

    // 记录
    this.recordAlert(alert);
  }

  /**
   * 便捷方法：信息告警
   */
  async info(type: AlertType, title: string, message: string, data?: any): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.INFO,
      type,
      title,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 便捷方法：警告告警
   */
  async warning(type: AlertType, title: string, message: string, data?: any): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.WARNING,
      type,
      title,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 便捷方法：错误告警
   */
  async error(type: AlertType, title: string, message: string, data?: any): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.ERROR,
      type,
      title,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 便捷方法：严重告警
   */
  async critical(type: AlertType, title: string, message: string, data?: any): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.CRITICAL,
      type,
      title,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 检查是否应该发送该级别
   */
  private shouldSendLevel(level: AlertLevel): boolean {
    const levels = [AlertLevel.INFO, AlertLevel.WARNING, AlertLevel.ERROR, AlertLevel.CRITICAL];
    const minIndex = levels.indexOf(this.config.minLevel);
    const currentIndex = levels.indexOf(level);
    return currentIndex >= minIndex;
  }

  /**
   * 检查是否应该发送该类型
   */
  private shouldSendType(type: AlertType): boolean {
    if (this.config.disableTypes.includes(type)) {
      return false;
    }
    if (this.config.enableTypes.length > 0) {
      return this.config.enableTypes.includes(type);
    }
    return true;
  }

  /**
   * 检查是否被频率限制
   */
  private isRateLimited(alert: AlertMessage): boolean {
    const key = `${alert.type}:${alert.level}`;
    const lastSent = this.alertHistory.get(key);

    if (lastSent) {
      const elapsed = (Date.now() - lastSent) / 1000;
      if (elapsed < this.config.rateLimitSeconds) {
        return true;
      }
    }

    return false;
  }

  /**
   * 检查是否达到每小时限制
   */
  private isHourlyLimitReached(): boolean {
    // 重置计数器
    if (Date.now() > this.hourlyResetTime) {
      this.hourlyCount = 0;
      this.hourlyResetTime = Date.now() + 3600000;
    }

    return this.hourlyCount >= this.config.maxAlertsPerHour;
  }

  /**
   * 记录告警
   */
  private recordAlert(alert: AlertMessage): void {
    const key = `${alert.type}:${alert.level}`;
    this.alertHistory.set(key, Date.now());
    this.hourlyCount++;
  }

  /**
   * 发送桌面通知
   */
  private async sendDesktopNotification(alert: AlertMessage): Promise<void> {
    try {
      const command = process.platform === 'darwin' ? 'osascript' :
                     process.platform === 'win32' ? 'powershell' :
                     'notify-send';

      let args: string[];

      if (process.platform === 'darwin') {
        args = ['-e', `display notification "${alert.message}" with title "${alert.title}"`];
      } else if (process.platform === 'win32') {
        args = ['-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${alert.message}', '${alert.title}')`];
      } else {
        args = [alert.title, alert.message];
      }

      spawn(command, args, { stdio: 'ignore' });
    } catch (error) {
      console.error('发送桌面通知失败:', error);
    }
  }

  /**
   * 发送Telegram告警
   */
  private async sendTelegramAlert(alert: AlertMessage): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return;
    }

    try {
      const emoji = this.getEmoji(alert.level);
      const text = `${emoji} *${alert.title}*\n\n${alert.message}`;

      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      const data = JSON.stringify({
        chat_id: this.config.telegramChatId,
        text: text,
        parse_mode: 'Markdown'
      });

      await this.makeRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length.toString()
        }
      }, data);
    } catch (error) {
      console.error('发送Telegram告警失败:', error);
    }
  }

  /**
   * 发送邮件告警
   */
  private async sendEmailAlert(alert: AlertMessage): Promise<void> {
    // 邮件发送需要nodemailer或类似库
    // 这里简化实现，仅记录
    console.log(`[邮件告警] ${alert.title}: ${alert.message}`);
  }

  /**
   * 发送Webhook告警
   */
  private async sendWebhookAlert(alert: AlertMessage): Promise<void> {
    if (!this.config.webhookUrl) {
      return;
    }

    try {
      const data = JSON.stringify({
        level: alert.level,
        type: alert.type,
        title: alert.title,
        message: alert.message,
        data: alert.data,
        timestamp: alert.timestamp
      });

      await this.makeRequest(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length.toString()
        }
      }, data);
    } catch (error) {
      console.error('发送Webhook告警失败:', error);
    }
  }

  /**
   * 发送控制台告警
   */
  private sendConsoleAlert(alert: AlertMessage): void {
    const emoji = this.getEmoji(alert.level);
    const level = alert.level.toUpperCase().padEnd(8);
    const time = new Date(alert.timestamp).toLocaleTimeString('zh-CN');

    console.log(`${emoji} [${level}] ${time} ${alert.title}`);
    console.log(`   ${alert.message}`);

    if (alert.data) {
      console.log(`   数据:`, JSON.stringify(alert.data, null, 2));
    }
  }

  /**
   * 获取表情符号
   */
  private getEmoji(level: AlertLevel): string {
    switch (level) {
      case AlertLevel.INFO: return 'ℹ️';
      case AlertLevel.WARNING: return '⚠️';
      case AlertLevel.ERROR: return '❌';
      case AlertLevel.CRITICAL: return '🔴';
    }
  }

  /**
   * 发起HTTPS请求
   */
  private makeRequest(url: string, options: any, data?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);

      if (data) {
        req.write(data);
      }

      req.end();
    });
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * 获取配置
   */
  getConfig(): AlertConfig {
    return { ...this.config };
  }

  /**
   * 获取统计信息
   */
  getStats(): { totalAlerts: number; alertsThisHour: number; hourlyResetTime: Date } {
    return {
      totalAlerts: this.alertHistory.size,
      alertsThisHour: this.hourlyCount,
      hourlyResetTime: new Date(this.hourlyResetTime)
    };
  }
}

/**
 * 全局告警系统实例
 */
let globalAlertSystem: AlertSystem | null = null;

/**
 * 获取全局告警系统
 */
export function getGlobalAlertSystem(): AlertSystem {
  if (!globalAlertSystem) {
    globalAlertSystem = new AlertSystem();
  }
  return globalAlertSystem;
}

/**
 * 便捷函数：发送信息
 */
export async function alertInfo(type: AlertType, title: string, message: string, data?: any): Promise<void> {
  await getGlobalAlertSystem().info(type, title, message, data);
}

/**
 * 便捷函数：发送警告
 */
export async function alertWarning(type: AlertType, title: string, message: string, data?: any): Promise<void> {
  await getGlobalAlertSystem().warning(type, title, message, data);
}

/**
 * 便捷函数：发送错误
 */
export async function alertError(type: AlertType, title: string, message: string, data?: any): Promise<void> {
  await getGlobalAlertSystem().error(type, title, message, data);
}

/**
 * 便捷函数：发送严重错误
 */
export async function alertCritical(type: AlertType, title: string, message: string, data?: any): Promise<void> {
  await getGlobalAlertSystem().critical(type, title, message, data);
}
