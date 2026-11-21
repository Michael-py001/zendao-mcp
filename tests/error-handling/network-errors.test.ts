/**
 * 网络错误处理测试
 *
 * ⚠️ 本套件**完全离线**：不连真实禅道，只验证「传输层出错时客户端怎么反应」。
 *
 * 2026-09-20 修 —— 原先有两条按**旧契约**写的断言，长期是红的，而且属于「静默失效」：
 *
 * 1. `verifyConnection()` 是**探测**方法，内部把错误吞成 `false`、从不抛错
 *    （见 `src/client.ts`），断言 `.rejects.toThrow()` 与实现不符。
 * 2. 重试逻辑挂在 **axios 响应拦截器**上。原写法 mock 掉了 `client.get`，
 *    等于把整条 axios 链路绕过去，重试永远不会发生；而且这两条用例当时
 *    其实是被「缺凭证 → 立刻抛错」提前截断的 —— 看着是绿的，什么都没测到。
 *
 * 现在统一改成替换 axios 的 `adapter`：请求不进网络，但认证、重试、
 * 错误改写全部真实跑通。
 */

/// <reference path="../global.d.ts" />

import { ZenTaoClient } from '../../src/client';

/**
 * 把 axios 的 adapter 换成假实现。
 *
 * 这是「能真正触发重试」的最小侵入姿势：请求不上网络，但仍走 axios 的
 * 拦截器链，所以「5xx → 重试 → 成功/耗尽」是真实执行出来的。
 */
function setFakeAdapter(client: ZenTaoClient, adapter: (config: any) => Promise<any>): void {
  (client as unknown as { http: { defaults: Record<string, unknown> } }).http.defaults.adapter =
    adapter;
}

/**
 * 造一个响应并按 `validateStatus` 决定 resolve 还是 reject。
 *
 * ⚠️ 这点很容易踩（本次实测栽在上面）：axios 的 `dispatchRequest` **不**校验状态码 ——
 * 「非 2xx 就 reject」是各个 adapter 自己调 `settle()` 干的活
 * （见 `node_modules/axios/lib/core/settle.js`）。自定义 adapter 若无条件 resolve，
 * 那么连 500 都会被当成请求成功，重试用例会以「假绿」的方式通过。
 * 这里就按 settle 的规则复刻一遍。
 */
function respond(config: any, status: number, data: unknown = {}): Promise<any> {
  const response = {
    status,
    statusText: String(status),
    headers: {},
    data,
    config,
    request: {},
  };

  const validateStatus = config?.validateStatus || ((s: number) => s >= 200 && s < 300);
  if (validateStatus(status)) return Promise.resolve(response);

  const error: any = new Error(`Request failed with status code ${status}`);
  error.code = 'ERR_BAD_RESPONSE';
  error.config = config;
  error.response = response;
  return Promise.reject(error);
}

describe('Network Error Handling', () => {
  test('未配置凭证时不发起任何请求，直接报错', async () => {
    const client = new ZenTaoClient(
      { baseUrl: 'http://127.0.0.1:1', token: '', account: '', password: '' },
      global.testLogger
    );

    let adapterCalls = 0;
    setFakeAdapter(client, async (config) => {
      adapterCalls++;
      return respond(config, 200);
    });

    await expect(client.get('/api.php/v1/projects')).rejects.toThrow(/缺少认证信息/);
    // 凭证缺失是**配置错误**，不该白白浪费一次网络往返
    expect(adapterCalls).toBe(0);
  });

  test('verifyConnection 连不上时返回 false（而不是抛错）', async () => {
    const client = new ZenTaoClient(
      { baseUrl: 'http://127.0.0.1:1', token: 'test_token', retry: 0, retryDelay: 10 },
      global.testLogger
    );

    setFakeAdapter(client, () =>
      Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    );

    await expect(client.verifyConnection()).resolves.toBe(false);
  });

  test('临时性失败（5xx）会按配置重试，最终成功', async () => {
    const client = new ZenTaoClient(
      { baseUrl: 'http://127.0.0.1:1', token: 'test_token', retry: 3, retryDelay: 10 },
      global.testLogger
    );

    let attempts = 0;
    setFakeAdapter(client, (config) => {
      attempts++;
      if (attempts < 3) return respond(config, 503);
      return respond(config, 200, { status: 'success', projects: [] });
    });

    const result = await client.get('/api.php/v1/projects');
    expect(result).toBeDefined();
    expect(attempts).toBe(3);
  });

  test('重试耗尽后仍然抛出错误', async () => {
    const client = new ZenTaoClient(
      { baseUrl: 'http://127.0.0.1:1', token: 'test_token', retry: 2, retryDelay: 10 },
      global.testLogger
    );

    let attempts = 0;
    setFakeAdapter(client, (config) => {
      attempts++;
      return respond(config, 500);
    });

    await expect(client.get('/api.php/v1/projects')).rejects.toThrow();
    // 首次 + 2 次重试
    expect(attempts).toBe(3);
  });
});
