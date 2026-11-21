/**
 * Jest 测试设置文件
 *
 * 注意：本文件对**所有**测试文件生效（setupFilesAfterEach）。
 * 因此这里只做「尽力而为」的环境准备，缺凭证时**告警而不抛错**，
 * 免得纯离线的单元测试被一个连不上的禅道直接拖死。
 */

import * as path from 'path';
import { config as loadEnvConfig } from 'dotenv';
import { ZenTaoClient } from '../src/client';
import { LRUCache } from '../src/utils/cache';
import { Logger, LogLevel } from '../src/utils/logger';

// 加载环境变量：优先项目根 .env，兜底当前工作目录
loadEnvConfig({
  path: [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ],
});

// 全局测试变量
global.testConfig = {
  baseUrl: process.env.ZENTAO_BASE_URL || 'http://localhost',
  token: process.env.ZENTAO_TOKEN || '',
  account: process.env.ZENTAO_ACCOUNT || '',
  password: process.env.ZENTAO_PASSWORD || '',
  timeout: parseInt(process.env.ZENTAO_TIMEOUT || '30000'),
  retry: parseInt(process.env.ZENTAO_RETRY || '3'),
  retryDelay: parseInt(process.env.ZENTAO_RETRY_DELAY || '1000')
};

// 全局变量
declare global {
  var testConfig: {
    baseUrl: string;
    token: string;
    account: string;
    password: string;
    timeout: number;
    retry: number;
    retryDelay: number;
  };
  var testClient: ZenTaoClient;
  var testCache: LRUCache<string, any>;
  var testLogger: Logger;
  /** 禅道是否真的连得上。集成测试可用它做前置判断。 */
  var testZendaoReachable: boolean;
}

beforeAll(async () => {
  console.log('\n=== 初始化测试环境 ===');

  // 创建测试客户端
  global.testLogger = new Logger(LogLevel.ERROR); // 测试时只显示错误
  global.testClient = new ZenTaoClient(global.testConfig, global.testLogger);
  global.testCache = new LRUCache<string, any>({
    maxSize: 100,
    defaultTtl: 5 * 60 * 1000,
    enableStats: true
  });

  // 探测连通性：失败只告警，不中断（离线单元测试照样要能跑）
  global.testZendaoReachable = await checkZenTaoService();

  console.log('✅ 测试环境初始化完成\n');
}, 60000);

afterEach(async () => {
  // 清理缓存
  global.testCache.clear();
});

afterAll(async () => {
  console.log('\n=== 清理测试环境 ===');
  const stats = global.testCache.getStats();
  console.log('缓存统计:', stats);
  console.log('✅ 测试环境清理完成\n');
});

/**
 * 探测禅道是否可访问。
 * 这里刻意判断 verifyConnection 的返回值——原实现只 catch 异常，
 * 而 verifyConnection 内部把错误吞成了 false，结果连不上也会打印「连接成功」。
 */
async function checkZenTaoService(): Promise<boolean> {
  const hasCredential =
    Boolean(global.testConfig.token) ||
    Boolean(global.testConfig.account && global.testConfig.password);

  if (!hasCredential) {
    console.warn(
      '⚠️  未配置禅道凭证（ZENTAO_TOKEN 或 ZENTAO_ACCOUNT+ZENTAO_PASSWORD）。\n' +
        '    依赖真实禅道的用例会失败；纯单元测试不受影响。'
    );
    return false;
  }

  try {
    const ok = await global.testClient.verifyConnection();
    if (ok) {
      console.log(`✅ 禅道可访问: ${global.testConfig.baseUrl}`);
      return true;
    }
    console.warn(
      `⚠️  连不上禅道 (${global.testConfig.baseUrl})，检查 .env 与网络。\n` +
        '    依赖真实禅道的用例会失败；纯单元测试不受影响。'
    );
    return false;
  } catch (error: any) {
    console.warn(`⚠️  探测禅道时出错: ${error?.message || error}`);
    return false;
  }
}

// 延迟函数
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 辅助函数：生成唯一测试名称
export function generateTestName(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * 辅助函数：判断是否配置了禅道凭证。
 * （旧版这里是 validateTokenFormat，校验的是已废弃的 `账号:zentaosid` 格式。）
 */
export function hasZendaoCredentials(): boolean {
  return (
    Boolean(process.env.ZENTAO_TOKEN) ||
    Boolean(process.env.ZENTAO_ACCOUNT && process.env.ZENTAO_PASSWORD)
  );
}

// 辅助函数：检查对象是否具有必需属性
export function hasRequiredProperties(obj: any, properties: string[]): boolean {
  return properties.every(prop => Object.prototype.hasOwnProperty.call(obj, prop));
}
