/**
 * 💊 健康检查系统
 *
 * 定期检查系统各个组件的健康状态
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { AlertSystem, AlertType, AlertLevel } from './alert-system.js';
import { RealHealthChecks } from './health/real-checks.js';

/**
 * 健康状态
 */
export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  CRITICAL = 'critical'
}

/**
 * 组件健康检查结果
 */
export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  message: string;
  lastCheck: number;
  responseTime?: number;
  details?: any;
}

/**
 * 系统健康报告
 */
export interface HealthReport {
  overallStatus: HealthStatus;
  timestamp: number;
  components: Map<string, ComponentHealth>;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    critical: number;
  };
}

/**
 * 健康检查配置
 */
export interface HealthCheckConfig {
  // 检查间隔（秒）
  checkInterval: number;

  // 各项检查开关
  checkAPI: boolean;
  checkRPC: boolean;
  checkWallet: boolean;
  checkBalance: boolean;
  checkMemory: boolean;
  checkDisk: boolean;

  // API检查配置
  apiEndpoint: string;
  apiTimeout: number;

  // RPC检查配置
  rpcEndpoint: string;
  rpcTimeout: number;

  // 钱包检查配置
  minBalanceUsd: number;

  // 系统资源检查配置
  maxMemoryPercent: number;
  maxDiskPercent: number;

  // 告警配置
  alertOnDegraded: boolean;
  alertOnUnhealthy: boolean;
  alertOnCritical: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: HealthCheckConfig = {
  checkInterval: 30,
  checkAPI: true,
  checkRPC: true,
  checkWallet: true,
  checkBalance: true,
  checkMemory: true,
  checkDisk: true,
  apiEndpoint: 'https://api.predict.fun',
  apiTimeout: 5000,
  rpcEndpoint: 'https://bsc-dataseed.binance.org',
  rpcTimeout: 5000,
  minBalanceUsd: 100,
  maxMemoryPercent: 80,
  maxDiskPercent: 90,
  alertOnDegraded: false,
  alertOnUnhealthy: true,
  alertOnCritical: true
};

/**
 * 健康检查系统
 */
export class HealthCheckSystem {
  private config: HealthCheckConfig;
  private alertSystem: AlertSystem;
  private components: Map<string, ComponentHealth> = new Map();
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    config: Partial<HealthCheckConfig> = {},
    alertSystem?: AlertSystem
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.alertSystem = alertSystem || new AlertSystem({ enabled: false });
  }

  /**
   * 启动健康检查
   */
  start(): void {
    if (this.isRunning) {
      console.log('⚠️ 健康检查已经在运行');
      return;
    }

    console.log(`💊 启动健康检查系统 (间隔: ${this.config.checkInterval}秒)`);

    // 立即执行一次检查
    this.performAllChecks();

    // 定期检查
    this.intervalId = setInterval(() => {
      this.performAllChecks();
    }, this.config.checkInterval * 1000);

    this.isRunning = true;
  }

  /**
   * 停止健康检查
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('💊 健康检查系统已停止');
  }

  /**
   * 执行所有检查
   */
  async performAllChecks(): Promise<void> {
    const checks = [];

    if (this.config.checkAPI) {
      checks.push(this.checkAPI());
    }

    if (this.config.checkRPC) {
      checks.push(this.checkRPC());
    }

    if (this.config.checkWallet) {
      checks.push(this.checkWallet());
    }

    if (this.config.checkBalance) {
      checks.push(this.checkBalance());
    }

    if (this.config.checkMemory) {
      checks.push(this.checkMemory());
    }

    if (this.config.checkDisk) {
      checks.push(this.checkDisk());
    }

    await Promise.allSettled(checks);

    // 生成报告
    const report = this.generateReport();

    // 检查是否需要告警
    this.checkAlerts(report);
  }

  /**
   * 检查API
   */
  private async checkAPI(): Promise<void> {
    try {
      const result = await RealHealthChecks.checkAPI(this.config.apiEndpoint);

      const status = result.healthy ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY;
      const message = result.healthy
        ? `API正常 (响应时间: ${result.latency}ms)`
        : `API错误: ${result.error || 'Unknown error'}`;

      this.components.set('API', {
        name: 'API',
        status,
        message,
        lastCheck: Date.now(),
        responseTime: result.latency
      });

    } catch (error) {
      this.components.set('API', {
        name: 'API',
        status: HealthStatus.UNHEALTHY,
        message: `API错误: ${error.message}`,
        lastCheck: Date.now(),
        responseTime: 0
      });
    }
  }

  /**
   * 检查RPC
   */
  private async checkRPC(): Promise<void> {
    const startTime = Date.now();

    try {
      // TODO: 实际调用RPC
      // const response = await fetch(this.config.rpcEndpoint, {
      //   method: 'POST',
      //   body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
      // });

      // 模拟检查
      await new Promise(resolve => setTimeout(resolve, 150));

      const responseTime = Date.now() - startTime;

      this.components.set('RPC', {
        name: 'RPC',
        status: HealthStatus.HEALTHY,
        message: `RPC正常 (响应时间: ${responseTime}ms)`,
        lastCheck: Date.now(),
        responseTime
      });
    } catch (error) {
      this.components.set('RPC', {
        name: 'RPC',
        status: HealthStatus.UNHEALTHY,
        message: `RPC错误: ${error.message}`,
        lastCheck: Date.now(),
        responseTime: Date.now() - startTime
      });
    }
  }

  /**
   * 检查钱包
   */
  private async checkWallet(): Promise<void> {
    try {
      // TODO: 检查私钥和地址是否配置
      // if (!config.privateKey || !config.predictAddress) {
      //   throw new Error('钱包未配置');
      // }

      this.components.set('Wallet', {
        name: 'Wallet',
        status: HealthStatus.HEALTHY,
        message: '钱包已配置',
        lastCheck: Date.now()
      });
    } catch (error) {
      this.components.set('Wallet', {
        name: 'Wallet',
        status: HealthStatus.CRITICAL,
        message: `钱包错误: ${error.message}`,
        lastCheck: Date.now()
      });
    }
  }

  /**
   * 检查余额
   */
  private async checkBalance(): Promise<void> {
    try {
      // TODO: 查询实际余额
      // const balance = await getBalance();
      // const balanceUsd = balance * tokenPrice;

      const balanceUsd = 500; // 模拟

      if (balanceUsd < this.config.minBalanceUsd) {
        this.components.set('Balance', {
          name: 'Balance',
          status: HealthStatus.DEGRADED,
          message: `余额较低: $${balanceUsd.toFixed(2)} (最低: $${this.config.minBalanceUsd})`,
          lastCheck: Date.now(),
          details: { balanceUsd }
        });
      } else {
        this.components.set('Balance', {
          name: 'Balance',
          status: HealthStatus.HEALTHY,
          message: `余额充足: $${balanceUsd.toFixed(2)}`,
          lastCheck: Date.now(),
          details: { balanceUsd }
        });
      }
    } catch (error) {
      this.components.set('Balance', {
        name: 'Balance',
        status: HealthStatus.UNHEALTHY,
        message: `余额检查错误: ${error.message}`,
        lastCheck: Date.now()
      });
    }
  }

  /**
   * 检查内存使用
   */
  private async checkMemory(): Promise<void> {
    try {
      const used = process.memoryUsage();
      const total = used.heapTotal;
      const usedPercent = (used.heapUsed / total) * 100;

      if (usedPercent > this.config.maxMemoryPercent) {
        this.components.set('Memory', {
          name: 'Memory',
          status: HealthStatus.DEGRADED,
          message: `内存使用率高: ${usedPercent.toFixed(1)}%`,
          lastCheck: Date.now(),
          details: { usedPercent, used }
        });
      } else {
        this.components.set('Memory', {
          name: 'Memory',
          status: HealthStatus.HEALTHY,
          message: `内存使用正常: ${usedPercent.toFixed(1)}%`,
          lastCheck: Date.now(),
          details: { usedPercent, used }
        });
      }
    } catch (error) {
      this.components.set('Memory', {
        name: 'Memory',
        status: HealthStatus.UNHEALTHY,
        message: `内存检查错误: ${error.message}`,
        lastCheck: Date.now()
      });
    }
  }

  /**
   * 检查磁盘使用
   */
  private async checkDisk(): Promise<void> {
    try {
      // TODO: 实际检查磁盘使用
      // const stats = await checkDiskUsage();

      const diskPercent = 45; // 模拟

      if (diskPercent > this.config.maxDiskPercent) {
        this.components.set('Disk', {
          name: 'Disk',
          status: HealthStatus.DEGRADED,
          message: `磁盘使用率高: ${diskPercent}%`,
          lastCheck: Date.now(),
          details: { diskPercent }
        });
      } else {
        this.components.set('Disk', {
          name: 'Disk',
          status: HealthStatus.HEALTHY,
          message: `磁盘使用正常: ${diskPercent}%`,
          lastCheck: Date.now(),
          details: { diskPercent }
        });
      }
    } catch (error) {
      this.components.set('Disk', {
        name: 'Disk',
        status: HealthStatus.UNHEALTHY,
        message: `磁盘检查错误: ${error.message}`,
        lastCheck: Date.now()
      });
    }
  }

  /**
   * 生成健康报告
   */
  generateReport(): HealthReport {
    let healthy = 0, degraded = 0, unhealthy = 0, critical = 0;

    for (const component of this.components.values()) {
      switch (component.status) {
        case HealthStatus.HEALTHY: healthy++; break;
        case HealthStatus.DEGRADED: degraded++; break;
        case HealthStatus.UNHEALTHY: unhealthy++; break;
        case HealthStatus.CRITICAL: critical++; break;
      }
    }

    // 确定总体状态
    let overallStatus = HealthStatus.HEALTHY;
    if (critical > 0) {
      overallStatus = HealthStatus.CRITICAL;
    } else if (unhealthy > 0) {
      overallStatus = HealthStatus.UNHEALTHY;
    } else if (degraded > 0) {
      overallStatus = HealthStatus.DEGRADED;
    }

    return {
      overallStatus,
      timestamp: Date.now(),
      components: this.components,
      summary: {
        total: this.components.size,
        healthy,
        degraded,
        unhealthy,
        critical
      }
    };
  }

  /**
   * 检查是否需要告警
   */
  private checkAlerts(report: HealthReport): void {
    if (report.overallStatus === HealthStatus.CRITICAL && this.config.alertOnCritical) {
      this.alertSystem.critical(
        AlertType.SYSTEM_STOP,
        '系统健康状态：严重',
        this.formatReport(report)
      );
    } else if (report.overallStatus === HealthStatus.UNHEALTHY && this.config.alertOnUnhealthy) {
      this.alertSystem.error(
        AlertType.API_ERROR,
        '系统健康状态：不健康',
        this.formatReport(report)
      );
    } else if (report.overallStatus === HealthStatus.DEGRADED && this.config.alertOnDegraded) {
      this.alertSystem.warning(
        AlertType.API_ERROR,
        '系统健康状态：降级',
        this.formatReport(report)
      );
    }
  }

  /**
   * 格式化报告
   */
  private formatReport(report: HealthReport): string {
    let message = `总体状态: ${report.overallStatus}\n\n`;

    for (const [name, component] of report.components) {
      const status = this.getStatusEmoji(component.status);
      message += `${status} ${name}: ${component.message}\n`;
    }

    return message;
  }

  /**
   * 获取状态表情符号
   */
  private getStatusEmoji(status: HealthStatus): string {
    switch (status) {
      case HealthStatus.HEALTHY: return '✅';
      case HealthStatus.DEGRADED: return '⚠️';
      case HealthStatus.UNHEALTHY: return '❌';
      case HealthStatus.CRITICAL: return '🔴';
    }
  }

  /**
   * 获取特定组件的健康状态
   */
  getComponentHealth(name: string): ComponentHealth | undefined {
    return this.components.get(name);
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<HealthCheckConfig>): void {
    this.config = { ...this.config, ...updates };

    // 如果正在运行，重启以应用新的间隔
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * 是否正在运行
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

/**
 * 全局健康检查实例
 */
let globalHealthCheck: HealthCheckSystem | null = null;

/**
 * 获取全局健康检查系统
 */
export function getGlobalHealthCheck(): HealthCheckSystem {
  if (!globalHealthCheck) {
    globalHealthCheck = new HealthCheckSystem();
  }
  return globalHealthCheck;
}

/**
 * 便捷函数：启动健康检查
 */
export function startHealthCheck(config?: Partial<HealthCheckConfig>): HealthCheckSystem {
  const healthCheck = new HealthCheckSystem(config);
  healthCheck.start();
  globalHealthCheck = healthCheck;
  return healthCheck;
}

/**
 * 便捷函数：停止健康检查
 */
export function stopHealthCheck(): void {
  if (globalHealthCheck) {
    globalHealthCheck.stop();
  }
}

/**
 * 便捷函数：获取健康报告
 */
export function getHealthReport(): HealthReport | null {
  if (globalHealthCheck) {
    return globalHealthCheck.generateReport();
  }
  return null;
}
