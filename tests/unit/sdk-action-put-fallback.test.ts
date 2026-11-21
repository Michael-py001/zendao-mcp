/**
 * SDK 适配器的「动作端点 PUT 被拒 → 改走 POST」回归。
 *
 * 这一组钉的是 2026-11-20 实测出来的两个坑，两者都会让
 * `zendao_call { module: "bug", action: "resolve" }` 在真机上必定失败：
 *
 *   1. **传输层拒绝 PUT** —— 连接被 RST，报 ECONNRESET。
 *   2. **前置代理拒绝 PUT** —— GET/POST 放行（200），PUT 回 502。
 *      axios 把它包成 `ERR_BAD_RESPONSE`，光看「方法被拒」判定会漏掉。
 *
 * 修的是 `SdkClientAdapter.request()` —— 它直接调 `requestRaw()`，
 * 把 `ZenTaoClient` 里已有的方法覆盖逻辑整条绕过去了。
 *
 * 反向也要钉住：两段式的 `PUT /bugs/{id}`、`DELETE /bugs/{id}` **不许**降级成 POST，
 * 否则会掉进禅道的「建单」路由，参数凑巧齐全时会造出脏数据。
 */

import * as http from 'http';
import { AddressInfo } from 'net';

import { ZenTaoClient } from '../../src/client';
import { SdkClientAdapter, isActionEndpoint } from '../../src/sdk/client-adapter';
import { Logger, LogLevel } from '../../src/utils/logger';

describe('SdkClientAdapter - 动作端点 PUT 降级', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: Array<{ method: string; url: string }> = [];
  /** 每个用例自己决定「这个实例对 PUT 怎么反应」 */
  let putBehavior: 'reset' | 'proxy502' | 'ok';
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  beforeAll(async () => {
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
    // 临时服务在 127.0.0.1，必须绕开本机代理，否则测的就不是这个服务了
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.no_proxy = '127.0.0.1,localhost';

    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        let pathname = req.url || '';
        try {
          pathname = new URL(pathname, 'http://127.0.0.1').pathname;
        } catch {
          /* 保持原样 */
        }
        requests.push({ method: req.method || '', url: pathname });

        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.method === 'PUT' || req.method === 'DELETE') {
          if (putBehavior === 'reset') {
            req.socket.destroy();
            return;
          }
          if (putBehavior === 'proxy502') {
            json(502, { error: 'Bad Gateway' });
            return;
          }
          return json(200, { status: 'success', message: '保存成功' });
        }

        // 走到这里的 POST：说明适配器改用了 POST 打同一个路径
        return json(200, { status: 'success', message: '保存成功' });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (savedNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = savedNoProxy;
    if (savedNoProxyLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = savedNoProxyLower;

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
  });

  const makeAdapter = () =>
    new SdkClientAdapter(
      new ZenTaoClient({ baseUrl, token: 'x', timeout: 5000, retry: 0 }, new Logger(LogLevel.ERROR))
    );

  test('isActionEndpoint 只认三段式动作路径', () => {
    expect(isActionEndpoint('/bugs/1/resolve')).toBe(true);
    expect(isActionEndpoint('/bugs/1/close')).toBe(true);
    expect(isActionEndpoint('/bugs/1/resolve?_method=PUT')).toBe(true);
    // 两段式集合端点：update / delete，不许降级
    expect(isActionEndpoint('/bugs/1')).toBe(false);
    expect(isActionEndpoint('/bugs')).toBe(false);
    // 多段式的模块子路径也不算动作端点
    expect(isActionEndpoint('/doc/spaces/1')).toBe(false);
  });

  test('PUT 被传输层掐断（ECONNRESET）→ 改用 POST 打同一路径并成功', async () => {
    putBehavior = 'reset';
    const adapter = makeAdapter();

    await expect(
      adapter.request('/bugs/2011223/resolve', { method: 'PUT', body: { resolution: 'fixed' } })
    ).resolves.toMatchObject({ status: 'success' });

    expect(requests.map((r) => r.method)).toEqual(['PUT', 'POST']);
    expect(requests[1].url).toBe('/api.php/v2/bugs/2011223/resolve');
  });

  test('PUT 被前置代理拒成 502 → 同样改用 POST（这条曾漏掉）', async () => {
    putBehavior = 'proxy502';
    const adapter = makeAdapter();

    await expect(
      adapter.request('/bugs/2011223/resolve', { method: 'PUT', body: { resolution: 'fixed' } })
    ).resolves.toMatchObject({ status: 'success' });

    expect(requests.map((r) => r.method)).toEqual(['PUT', 'POST']);
  });

  test('实例支持原生 PUT 时不该多此一举改 POST', async () => {
    putBehavior = 'ok';
    const adapter = makeAdapter();

    await expect(
      adapter.request('/bugs/2011223/resolve', { method: 'PUT', body: { resolution: 'fixed' } })
    ).resolves.toMatchObject({ status: 'success' });

    expect(requests.map((r) => r.method)).toEqual(['PUT']);
  });

  test('两段式 PUT /bugs/{id}（更新）不许降级，否则会掉进建单路由', async () => {
    putBehavior = 'reset';
    const adapter = makeAdapter();

    await expect(adapter.request('/bugs/2011223', { method: 'PUT', body: { pri: 2 } })).rejects.toThrow();

    // 只有那一发被掐断的 PUT，没有 POST
    expect(requests.map((r) => r.method)).toEqual(['PUT']);
  });

  test('DELETE 不做降级（删除没有 POST 版本）', async () => {
    putBehavior = 'reset';
    const adapter = makeAdapter();

    await expect(adapter.request('/bugs/2011223', { method: 'DELETE' })).rejects.toThrow();

    expect(requests.every((r) => r.method === 'DELETE')).toBe(true);
  });
});

/**
 * 代理判定的补充说明：`shouldBypassProxy()` 是私有函数，不单独导出测试；
 * 它的行为在下面的「真实客户端」用例里间接覆盖 —— 若内网地址被错误地
 * 交给代理，`proxy: false` 不会生效，联调时表现为 PUT 502。
 */
describe('ZenTaoClient - 内网地址不走代理', () => {
  const make = (baseUrl: string) =>
    new ZenTaoClient({ baseUrl, token: 'x', timeout: 1000, retry: 0 }, new Logger(LogLevel.ERROR));

  test('私有网段与 localhost 关掉代理', () => {
    for (const url of [
      'http://10.0.0.8/zentaomax',
      'http://192.168.1.5/zentaomax',
      'http://172.16.0.9/zentaomax',
      'http://172.31.255.1/zentaomax',
      'http://127.0.0.1:8080/zentaomax',
      'http://localhost/zentaomax',
    ]) {
      expect((make(url) as unknown as { http: { defaults: { proxy?: unknown } } }).http.defaults.proxy).toBe(false);
    }
  });

  test('公网地址保持 axios 默认（交给环境变量决定）', () => {
    for (const url of ['https://zentao.example.com/zentaomax', 'http://172.32.0.1/zentaomax']) {
      expect(
        (make(url) as unknown as { http: { defaults: { proxy?: unknown } } }).http.defaults.proxy
      ).toBeUndefined();
    }
  });
});
