/**
 * 缓存相关类型定义
 */

// 缓存项
export interface ICacheItem<T = any> {
  data: T;
  timestamp: number;
  ttl: number; // 毫秒
  lastAccess: number; // 用于 LRU：单调递增的访问序号（不是时间戳，避免同毫秒并列）
}

// 缓存统计信息
export interface ICacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  memoryUsage: number; // 字节
}

// 缓存配置
export interface ICacheConfig {
  maxSize: number; // 最大缓存项数
  defaultTtl: number; // 默认 TTL (毫秒)
  enableStats: boolean; // 是否启用统计
}
