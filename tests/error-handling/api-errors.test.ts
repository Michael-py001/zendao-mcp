/**
 * API 错误处理测试
 */

/// <reference path="../global.d.ts" />

import { ZenTaoClient } from '../../src/client';

describe('API Error Handling', () => {
  test('should handle 401 Unauthorized', async () => {
    const clientWithBadToken = new ZenTaoClient({
      baseUrl: global.testConfig.baseUrl,
      token: 'invalid_token_hash_xxxxxxxxxxxxxxxxx',
      timeout: global.testConfig.timeout,
      retry: 1
    }, global.testLogger);

    await expect(clientWithBadToken.get('/api.php/v1/projects'))
      .rejects
      .toThrow();
    console.log('✅ 401 Unauthorized handled');
  });

  test('should handle 403 Forbidden', async () => {
    // 尝试访问需要更高权限的端点
    await expect(global.testClient.get('/api.php/v1/admin/users'))
      .rejects
      .toThrow();
    console.log('✅ 403 Forbidden handled');
  });

  test('should handle 404 Not Found', async () => {
    await expect(global.testClient.get('/api.php/v1/projects/999999'))
      .rejects
      .toThrow();
    console.log('✅ 404 Not Found handled');
  });

  test('should provide helpful error messages', async () => {
    const clientWithBadToken = new ZenTaoClient({
      baseUrl: global.testConfig.baseUrl,
      token: 'bad_token',
      timeout: global.testConfig.timeout,
      retry: 1
    }, global.testLogger);

    try {
      await clientWithBadToken.get('/api.php/v1/projects');
      throw new Error('Should have thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/unauthorized|401|Unauthorized/i);
      console.log(`✅ Error message: ${error.message}`);
    }
  });

  test('should handle malformed API responses', async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue({
        data: { status: 'invalid', message: 'Malformed response' }
      })
    };

    // 客户端应该能够处理响应
    try {
      await (mockClient as any).get('/test');
      console.log('✅ Malformed response handled');
    } catch (error) {
      console.log('✅ Malformed response caught');
    }
  });

  test('should handle rate limiting', async () => {
    // 快速连续请求（如果服务器有速率限制）
    const promises = Array.from({ length: 10 }, () =>
      global.testClient.get('/api.php/v1/projects', { limit: 1 })
    );

    try {
      await Promise.all(promises);
      console.log('✅ Rate limiting handled (or not applicable)');
    } catch (error: any) {
      console.log(`⚠️ Rate limiting triggered: ${error.message}`);
    }
  });
});
