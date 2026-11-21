/**
 * LRU 缓存实现
 */

import { ICacheItem, ICacheStats, ICacheConfig } from '../types';

export class LRUCache<K, V> {
  private cache = new Map<K, ICacheItem<V>>();
  private config: ICacheConfig;

  // 统计信息
  private stats = {
    hits: 0,
    misses: 0
  };

  /**
   * 单调递增的访问序号 —— LRU 的先后顺序只看它，不看时钟。
   *
   * 为什么不用 `Date.now()`（2026-09-20 修）：毫秒分辨率下，同一毫秒内做的
   * 「插入 k1/k2/k3 → 读 k1 → 插入 k4」会得到完全并列的 `lastAccess`，
   * 于是 `findOldestKey()` 淘汰的是**先插入的 k1**（刚被读过、本该留下的那个），
   * LRU 退化成了 FIFO。序号单调递增，任何执行速度下顺序都正确。
   */
  private accessSeq = 0;

  constructor(config: Partial<ICacheConfig> = {}) {
    this.config = {
      maxSize: 1000,
      defaultTtl: 5 * 60 * 1000, // 5 分钟
      enableStats: true,
      ...config,
    };
  }

  /**
   * 获取缓存值
   */
  get(key: K): V | null {
    const item = this.cache.get(key);

    if (!item) {
      if (this.config.enableStats) {
        this.stats.misses++;
      }
      return null;
    }

    // 检查 TTL
    const now = Date.now();
    if (now - item.timestamp > item.ttl) {
      this.cache.delete(key);
      if (this.config.enableStats) {
        this.stats.misses++;
      }
      return null;
    }

    // 更新访问顺序（用单调序号，不用时钟 —— 理由见 accessSeq 的注释）
    item.lastAccess = ++this.accessSeq;
    if (this.config.enableStats) {
      this.stats.hits++;
    }
    return item.data;
  }

  /**
   * 设置缓存值
   */
  set(key: K, value: V, ttl?: number): void {
    // 如果达到最大容量，删除最久未使用的项
    if (this.cache.size >= this.config.maxSize) {
      const oldestKey = this.findOldestKey();
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    const now = Date.now();
    const item: ICacheItem<V> = {
      data: value,
      timestamp: now,
      ttl: ttl ?? this.config.defaultTtl,
      lastAccess: ++this.accessSeq,
    };

    this.cache.set(key, item);
  }

  /**
   * 删除缓存项
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 清理过期缓存项
   */
  cleanup(): number {
    const now = Date.now();
    const keysToDelete: K[] = [];

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    return keysToDelete.length;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): ICacheStats {
    const size = this.cache.size;
    const maxSize = this.config.maxSize;
    const total = this.stats.hits + this.stats.misses;

    // 估算内存使用量（简化）
    let memoryUsage = 0;
    for (const item of this.cache.values()) {
      memoryUsage += JSON.stringify(item).length;
    }

    return {
      size,
      maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      memoryUsage,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
  }

  /**
   * 获取当前缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 查找最久未使用的键
   */
  private findOldestKey(): K | undefined {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, item] of this.cache.entries()) {
      if (item.lastAccess < oldestTime) {
        oldestTime = item.lastAccess;
        oldestKey = key;
      }
    }

    return oldestKey;
  }
}
