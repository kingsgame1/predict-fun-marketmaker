/**
 * 💾 订单簿缓存系统
 *
 * 缓存订单簿数据，减少API调用，提升性能
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import { OrderBook } from './types.js';

/**
 * 缓存项
 */
interface CacheItem {
  orderBook: OrderBook;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

/**
 * 缓存统计
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
  avgAge: number;
  memoryEstimate: number;
}

/**
 * 缓存配置
 */
export interface CacheConfig {
  // 缓存过期时间（毫秒）
  ttl: number;

  // 最大缓存数量
  maxSize: number;

  // 启用缓存
  enabled: boolean;

  // 预加载配置
  preloadEnabled: boolean;
  preloadInterval: number;

  // 清理配置
  cleanupInterval: number;
  aggressiveCleanup: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: CacheConfig = {
  ttl: 2000,              // 2秒过期
  maxSize: 100,           // 最多缓存100个订单簿
  enabled: true,
  preloadEnabled: false,
  preloadInterval: 1000,  // 1秒预加载
  cleanupInterval: 30000, // 30秒清理
  aggressiveCleanup: false
};

/**
 * 订单簿缓存系统
 */
export class OrderBookCache {
  private cache: Map<string, CacheItem> = new Map();
  private config: CacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private stats = { hits: 0, misses: 0 };

  // 回调函数
  private onCacheMiss?: (marketId: string, tokenId: string) => Promise<OrderBook>;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 启动清理定时器
    this.startCleanup();
  }

  /**
   * 设置缓存未命中回调
   */
  setCacheMissHandler(handler: (marketId: string, tokenId: string) => Promise<OrderBook>): void {
    this.onCacheMiss = handler;
  }

  /**
   * 获取订单簿
   */
  async get(marketId: string, tokenId: string): Promise<OrderBook | null> {
    if (!this.config.enabled) {
      return this.onCacheMiss ? await this.onCacheMiss(marketId, tokenId) : null;
    }

    const key = this.makeKey(marketId, tokenId);
    const item = this.cache.get(key);

    // 检查缓存是否存在且未过期
    if (item) {
      const age = Date.now() - item.timestamp;

      if (age < this.config.ttl) {
        // 缓存命中
        this.stats.hits++;
        item.accessCount++;
        item.lastAccess = Date.now();

        return item.orderBook;
      } else {
        // 缓存过期，删除
        this.cache.delete(key);
      }
    }

    // 缓存未命中
    this.stats.misses++;

    if (this.onCacheMiss) {
      const orderBook = await this.onCacheMiss(marketId, tokenId);

      if (orderBook) {
        this.set(marketId, tokenId, orderBook);
      }

      return orderBook;
    }

    return null;
  }

  /**
   * 设置订单簿
   */
  set(marketId: string, tokenId: string, orderBook: OrderBook): void {
    if (!this.config.enabled) {
      return;
    }

    // 检查缓存大小
    if (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    const key = this.makeKey(marketId, tokenId);

    this.cache.set(key, {
      orderBook,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccess: Date.now()
    });
  }

  /**
   * 批量获取
   */
  async getBatch(marketId: string, tokenIds: string[]): Promise<Map<string, OrderBook>> {
    const results = new Map<string, OrderBook>();

    const promises = tokenIds.map(async (tokenId) => {
      const orderBook = await this.get(marketId, tokenId);
      if (orderBook) {
        results.set(tokenId, orderBook);
      }
    });

    await Promise.all(promises);

    return results;
  }

  /**
   * 批量设置
   */
  setBatch(marketId: string, orderBooks: Map<string, OrderBook>): void {
    for (const [tokenId, orderBook] of orderBooks) {
      this.set(marketId, tokenId, orderBook);
    }
  }

  /**
   * 删除缓存
   */
  delete(marketId: string, tokenId: string): void {
    const key = this.makeKey(marketId, tokenId);
    this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * 清理过期缓存
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, item] of this.cache) {
      const age = now - item.timestamp;

      // 删除过期的缓存
      if (age > this.config.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    // 激进清理模式：如果缓存仍然太大，删除最老的
    if (this.config.aggressiveCleanup && this.cache.size > this.config.maxSize * 0.8) {
      const toRemove = this.cache.size - Math.floor(this.config.maxSize * 0.5);

      // 按时间戳排序，删除最老的
      const items = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      for (let i = 0; i < toRemove && i < items.length; i++) {
        this.cache.delete(items[i][0]);
        removed++;
      }
    }

    return removed;
  }

  /**
   * LRU驱逐
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, item] of this.cache) {
      if (item.lastAccess < oldestTime) {
        oldestTime = item.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 预加载订单簿
   */
  async preload(marketId: string, tokenIds: string[]): Promise<void> {
    if (!this.config.preloadEnabled || !this.onCacheMiss) {
      return;
    }

    const promises = tokenIds
      .filter(tokenId => !this.cache.has(this.makeKey(marketId, tokenId)))
      .map(async (tokenId) => {
        try {
          const orderBook = await this.onCacheMiss!(marketId, tokenId);
          if (orderBook) {
            this.set(marketId, tokenId, orderBook);
          }
        } catch (error) {
          console.warn(`预加载失败 ${marketId}/${tokenId}:`, error.message);
        }
      });

    await Promise.allSettled(promises);
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    // 计算平均年龄
    let totalAge = 0;
    let count = 0;
    const now = Date.now();

    for (const item of this.cache.values()) {
      totalAge += (now - item.timestamp);
      count++;
    }

    const avgAge = count > 0 ? totalAge / count : 0;

    // 估算内存使用
    const memoryEstimate = this.estimateMemory();

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      hitRate,
      avgAge,
      memoryEstimate
    };
  }

  /**
   * 估算内存使用（字节）
   */
  private estimateMemory(): number {
    let size = 0;

    for (const [key, item] of this.cache) {
      // 键大小
      size += key.length * 2; // UTF-16

      // 订单簿数据估算
      const bids = item.orderBook.bids?.length || 0;
      const asks = item.orderBook.asks?.length || 0;

      size += (bids + asks) * 100; // 每个订单大约100字节
      size += 200; // 元数据
    }

    return size;
  }

  /**
   * 生成缓存报告
   */
  generateReport(): string {
    const stats = this.getStats();

    let report = '\n';
    report += '='.repeat(80) + '\n';
    report += '💾 订单簿缓存报告\n';
    report += '='.repeat(80) + '\n\n';

    report += `缓存大小: ${stats.size}/${this.config.maxSize}\n`;
    report += `命中率: ${(stats.hitRate * 100).toFixed(1)}% (${stats.hits}/${stats.hits + stats.misses})\n`;
    report += `平均年龄: ${(stats.avgAge / 1000).toFixed(1)}秒\n`;
    report += `内存使用: ${(stats.memoryEstimate / 1024).toFixed(1)} KB\n`;
    report += `TTL: ${this.config.ttl / 1000}秒\n`;
    report += `状态: ${this.config.enabled ? '✅ 启用' : '❌ 禁用'}\n`;

    report += '\n';

    if (stats.hitRate < 0.5) {
      report += '⚠️ 命中率较低，考虑增加TTL或启用预加载\n';
    } else if (stats.hitRate > 0.9) {
      report += '✅ 命中率很高，缓存工作良好\n';
    }

    if (stats.size > this.config.maxSize * 0.9) {
      report += '⚠️ 缓存接近上限，考虑增加maxSize\n';
    }

    report += '='.repeat(80) + '\n';

    return report;
  }

  /**
   * 生成缓存键
   */
  private makeKey(marketId: string, tokenId: string): string {
    return `${marketId}:${tokenId}`;
  }

  /**
   * 启动清理定时器
   */
  private startCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        console.log(`💾 清理了 ${removed} 个过期缓存项`);
      }
    }, this.config.cleanupInterval);
  }

  /**
   * 停止清理定时器
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 销毁缓存
   */
  destroy(): void {
    this.stopCleanup();
    this.clear();
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...updates };

    // 如果TTL改变，清理过期缓存
    if (updates.ttl !== undefined) {
      this.cleanup();
    }
  }

  /**
   * 获取配置
   */
  getConfig(): CacheConfig {
    return { ...this.config };
  }

  /**
   * 导出缓存（用于调试）
   */
  export(): Array<{ key: string; item: CacheItem }> {
    return Array.from(this.cache.entries()).map(([key, item]) => ({ key, item }));
  }
}

/**
 * 全局缓存实例
 */
let globalCache: OrderBookCache | null = null;

/**
 * 获取全局缓存
 */
export function getGlobalCache(): OrderBookCache {
  if (!globalCache) {
    globalCache = new OrderBookCache();
  }
  return globalCache;
}

/**
 * 便捷函数：获取订单簿
 */
export async function getCachedOrderBook(marketId: string, tokenId: string): Promise<OrderBook | null> {
  return getGlobalCache().get(marketId, tokenId);
}

/**
 * 便捷函数：设置订单簿
 */
export function setCachedOrderBook(marketId: string, tokenId: string, orderBook: OrderBook): void {
  getGlobalCache().set(marketId, tokenId, orderBook);
}

/**
 * 便捷函数：获取缓存报告
 */
export function getCacheReport(): string {
  return getGlobalCache().generateReport();
}
