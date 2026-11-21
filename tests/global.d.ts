/**
 * Jest 全局类型声明
 */

import { ZenTaoClient } from '../src/client';
import { LRUCache } from '../src/utils/cache';
import { Logger } from '../src/utils/logger';

declare global {
  var testConfig: {
    baseUrl: string;
    token: string;
    timeout: number;
    retry: number;
    retryDelay: number;
  };
  var testClient: ZenTaoClient;
  var testCache: LRUCache<string, any>;
  var testLogger: Logger;
}

export {};
