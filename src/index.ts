/**
 * ZenTao MCP 服务器主入口
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// import { z } from 'zod';
import { loadConfig } from './config';
import { ZenTaoClient } from './client';
import { ZenTaoConfig } from './types';
import { LRUCache } from './utils/cache';
import { Logger, LogLevel } from './utils/logger';
import { registerAllTools } from './tools';

/**
 * 读取 LOG_LEVEL 环境变量（DEBUG / INFO / WARN / ERROR），非法值回退到 INFO。
 * config.ts 在模块加载时已经跑过 dotenv，所以这里能读到 .env 里的值。
 */
function resolveLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').trim().toUpperCase();
  const levels: Record<string, LogLevel> = {
    DEBUG: LogLevel.DEBUG,
    INFO: LogLevel.INFO,
    WARN: LogLevel.WARN,
    ERROR: LogLevel.ERROR,
  };
  return levels[raw] || LogLevel.INFO;
}

/**
 * 把 config.credentialSource 翻成一句能在日志里看懂的说明。
 * 排障时最常问的就是「它到底用了谁的凭证」，所以启动就把它打出来（**不打印凭证本身**）。
 */
function describeCredentialSource(config: ZenTaoConfig): string {
  switch (config.credentialSource) {
    case 'env-token':
      return '环境变量 / .env 的 ZENTAO_TOKEN';
    case 'env-account':
      return `环境变量 / .env 的 ${config.account} + 密码`;
    case 'profile':
      return `官方 zentao-cli 的本地登录（profile: ${config.credentialProfileKey}）`;
    default:
      return '未知';
  }
}

async function main() {
  // 初始化日志
  const logger = new Logger(resolveLogLevel());

  logger.info('启动 ZenTao MCP 服务器...');

  try {
    // 加载配置
    const config = loadConfig();
    logger.info(`配置加载完成: ${config.baseUrl}（REST API ${config.apiVersion}）`);
    logger.info(`凭证来源: ${describeCredentialSource(config)}`);

    // 复用的 profile Token 有寿命（禅道 REST Token，本实例 4 小时），而 store 不存密码、
    // 没法自动续期。**提前**提醒一句，免得用户撞上难懂的 401「Not allowed」。
    // 只是提醒，不拦截 —— 推算可能不准，最终以服务端返回为准。
    if (config.credentialSource === 'profile' && config.credentialExpiresAt) {
      const expiresAt = Date.parse(config.credentialExpiresAt);
      if (!Number.isNaN(expiresAt) && Date.now() > expiresAt) {
        logger.warn(
          `复用的官方 CLI Token 推算已过期（${config.credentialExpiresAt}）：` +
            '禅道 REST Token 有有效期，过期后无法自动续期。' +
            '若随后出现 401，请重新执行 `zentao login`，或在 .env 里配置 ZENTAO_ACCOUNT + ZENTAO_PASSWORD'
        );
      }
    }

    // 创建禅道客户端
    const client = new ZenTaoClient(config, logger);
    logger.info('禅道 API 客户端已创建');

    // 验证连接
    const isConnected = await client.verifyConnection();
    if (!isConnected) {
      logger.error('无法连接到禅道服务器，请检查配置');
      process.exit(1);
    }
    logger.info('连接验证成功');

    // 获取版本信息（禅道并非所有版本都暴露版本接口，拿不到就安静跳过）
    const version = await client.getVersion();
    if (version && version !== '未知') {
      logger.info(`禅道版本: ${version}`);
    } else {
      logger.debug('未取到禅道版本号（该实例未暴露版本接口，不影响使用）');
    }

    // 创建缓存
    const cache = new LRUCache<string, any>({
      maxSize: 1000,
      defaultTtl: 5 * 60 * 1000, // 5 分钟
      enableStats: true,
    });
    logger.info('LRU 缓存已初始化');

    // 创建 MCP 服务器
    const server = new McpServer(
      {
        name: 'zendao-mcp-server',
        version: '1.0.0',
      }
    );

    // 注册所有工具
    registerAllTools(server, client, cache, logger);

    // 使用标准输入输出传输
    const transport = new StdioServerTransport();

    // 连接服务器
    await server.connect(transport);
    logger.info('MCP 服务器已启动，等待连接...');
  } catch (error: any) {
    logger.error('服务器启动失败', error);
    process.exit(1);
  }
}

// 启动服务器
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
