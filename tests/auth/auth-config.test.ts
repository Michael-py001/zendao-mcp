/**
 * 认证配置与换 Token 链路测试
 *
 * 覆盖：
 *   1. loadConfig 的认证规则（账号密码 / 静态 Token / 缺参报错）
 *   2. baseUrl 规范化（去结尾斜杠、去 /index.php、去误加的 /api.php/vX）
 *   3. API 版本解析（默认 v2，可回落 v1）
 *   4. 真实走一遍「换 Token → 带 Token 头访问业务接口」
 *      —— v2 走 `POST /api.php/v2/users/login`，v1 走 `POST /api.php/v1/tokens`
 *      —— 用本机临时 HTTP 服务，不碰真实禅道
 *   5. 凭证多源：环境变量 / .env 优先，缺失时回落到官方 `zentao-cli` 的 profile store
 *      —— 全程用临时 store 文件，只读，不碰真实 `~/.config/zentao/zentao.json`
 *
 * 本文件是本项目里少数**纯离线可跑**的测试。
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';

import { loadConfig } from '../../src/config';
import { ZenTaoClient } from '../../src/client';
import { Logger, LogLevel } from '../../src/utils/logger';

// config.ts 在模块加载时会 dotenv.config()，把真实 .env 灌进 process.env。
// 单测要可控，所以每个用例前先把认证相关的变量清干净再按需设置。
const AUTH_KEYS = [
  'ZENTAO_BASE_URL',
  'ZENTAO_URL',
  'ZENTAO_TOKEN',
  'ZENTAO_ACCOUNT',
  'ZENTAO_PASSWORD',
  'ZENTAO_PROFILE',
  'ZENTAO_CONFIG_FILE',
  'ZENTAO_API_VERSION',
  'ZENTAO_METHOD_OVERRIDE',
  'ZENTAO_TIMEOUT',
  'ZENTAO_RETRY',
  'ZENTAO_RETRY_DELAY',
] as const;

/** 一个**保证不存在**的 store 路径 —— 用来把真实 `~/.config/zentao/zentao.json` 隔离在测试之外 */
const EMPTY_STORE = path.join(
  os.tmpdir(),
  `zendao-no-such-store-${process.pid}-${Date.now()}.json`
);

/**
 * 清空认证相关的环境变量，并**把 profile store 指向一个不存在的文件**。
 *
 * ⚠️ 这一句是必须的（2026-09-20 加）：本机装了官方 `zentao-cli` 并登录过，
 * `~/.config/zentao/zentao.json` 里躺着一条能用的 profile。不隔离的话
 * loadConfig 会回落到它，于是「什么都不给就报错」「baseUrl 默认 localhost」
 * 这两条用例会因为**环境里有真凭证**而失败 —— 测试必须与开发机的现状无关。
 */
function clearEnv() {
  for (const k of AUTH_KEYS) delete process.env[k];
  process.env.ZENTAO_CONFIG_FILE = EMPTY_STORE;
}

/** 用给定内容造一个临时 store，返回它的路径 */
function writeStore(content: unknown, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-store-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

/** 造一条格式正确的 profile */
function profile(server: string, account: string, token: string) {
  return { server, account, token, loginTime: '2026-09-01T00:00:00.000Z', lastUsedTime: '2026-09-02T00:00:00.000Z' };
}

describe('loadConfig - 认证规则', () => {
  beforeEach(clearEnv);
  afterAll(clearEnv);

  test('账号密码齐全时返回 account/password，不要求 token', () => {
    process.env.ZENTAO_BASE_URL = 'http://zentao.example.com/zentaomax';
    process.env.ZENTAO_ACCOUNT = 'zhangsan';
    process.env.ZENTAO_PASSWORD = 'p@ss';

    const config = loadConfig();

    expect(config.account).toBe('zhangsan');
    expect(config.password).toBe('p@ss');
    expect(config.token).toBeUndefined();
    expect(config.baseUrl).toBe('http://zentao.example.com/zentaomax');
  });

  test('只给静态 Token 时也应放行（兼容 32 位 REST Token）', () => {
    process.env.ZENTAO_TOKEN = 'e3ac41d859269a5d572fcf2a65fd316a';

    const config = loadConfig();

    expect(config.token).toBe('e3ac41d859269a5d572fcf2a65fd316a');
    expect(config.account).toBeUndefined();
  });

  test('什么都不给时报错，且提示怎么配', () => {
    expect(() => loadConfig()).toThrow(/缺少禅道认证信息/);
    expect(() => loadConfig()).toThrow(/ZENTAO_ACCOUNT/);
  });

  test('只配了账号没配密码 → 报错要求成对配置', () => {
    process.env.ZENTAO_ACCOUNT = 'zhangsan';
    expect(() => loadConfig()).toThrow(/必须成对配置/);
  });

  test('只配了密码没配账号 → 报错要求成对配置', () => {
    process.env.ZENTAO_PASSWORD = 'p@ss';
    expect(() => loadConfig()).toThrow(/必须成对配置/);
  });

  test('超时与重试参数可解析，缺省时用默认值', () => {
    process.env.ZENTAO_ACCOUNT = 'a';
    process.env.ZENTAO_PASSWORD = 'b';

    const defaults = loadConfig();
    expect(defaults.timeout).toBe(30000);
    expect(defaults.retry).toBe(3);
    expect(defaults.retryDelay).toBe(1000);

    process.env.ZENTAO_TIMEOUT = '5000';
    process.env.ZENTAO_RETRY = '1';
    process.env.ZENTAO_RETRY_DELAY = '250';

    const custom = loadConfig();
    expect(custom.timeout).toBe(5000);
    expect(custom.retry).toBe(1);
    expect(custom.retryDelay).toBe(250);
  });
});

describe('loadConfig - 凭证多源（官方 CLI profile store）', () => {
  beforeEach(clearEnv);
  afterAll(clearEnv);

  test('环境变量给全了就不读 profile，来源标 env-account', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      { profiles: [profile('http://profile.example.com', 'profileuser', 'p'.repeat(32))] },
      'zentao.json'
    );
    process.env.ZENTAO_BASE_URL = 'http://env.example.com';
    process.env.ZENTAO_ACCOUNT = 'envuser';
    process.env.ZENTAO_PASSWORD = 'secret';

    const config = loadConfig();

    expect(config.credentialSource).toBe('env-account');
    expect(config.account).toBe('envuser');
    expect(config.token).toBeUndefined();
    // 站点地址同样以环境变量为准，不能悄悄被 profile 顶掉
    expect(config.baseUrl).toBe('http://env.example.com');
    expect(config.credentialProfileKey).toBeUndefined();
  });

  test('静态 Token 的来源标 env-token', () => {
    process.env.ZENTAO_TOKEN = 'e3ac41d859269a5d572fcf2a65fd316a';

    expect(loadConfig().credentialSource).toBe('env-token');
  });

  test('环境变量没有凭证 → 回落到 profile 的 account/token/server，且不产生 password', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        currentProfile: 'your-account@http://10.0.0.9/zentaomax',
        profiles: [profile('http://10.0.0.9/zentaomax/', 'your-account', 't'.repeat(32))],
      },
      'zentao.json'
    );

    const config = loadConfig();

    expect(config.credentialSource).toBe('profile');
    expect(config.token).toBe('t'.repeat(32));
    expect(config.account).toBe('your-account');
    // 尾斜杠被规范化掉，key 与官方 CLI 的 profileKey 一致
    expect(config.baseUrl).toBe('http://10.0.0.9/zentaomax');
    expect(config.credentialProfileKey).toBe('your-account@http://10.0.0.9/zentaomax');
    // 官方 CLI **不存密码** —— 落到这条路上就只有 Token
    expect(config.password).toBeUndefined();
  });

  test('只给了账号密码、没给 URL → 站点地址从 profile 借', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        currentProfile: 'zhangsan@http://10.0.0.9/zentaomax',
        profiles: [profile('http://10.0.0.9/zentaomax', 'zhangsan', 't'.repeat(32))],
      },
      'zentao.json'
    );
    process.env.ZENTAO_ACCOUNT = 'zhangsan';
    process.env.ZENTAO_PASSWORD = 'p@ss';

    const config = loadConfig();

    expect(config.credentialSource).toBe('env-account');
    expect(config.baseUrl).toBe('http://10.0.0.9/zentaomax');
  });

  test('ZENTAO_URL 是 ZENTAO_BASE_URL 的别名（官方 CLI 用的正是前者）', () => {
    process.env.ZENTAO_URL = 'http://legacy.example.com/zentaomax';
    process.env.ZENTAO_TOKEN = 'x'.repeat(32);

    expect(loadConfig().baseUrl).toBe('http://legacy.example.com/zentaomax');
  });

  test('ZENTAO_BASE_URL 优先于 ZENTAO_URL', () => {
    process.env.ZENTAO_BASE_URL = 'http://primary.example.com';
    process.env.ZENTAO_URL = 'http://legacy.example.com';
    process.env.ZENTAO_TOKEN = 'x'.repeat(32);

    expect(loadConfig().baseUrl).toBe('http://primary.example.com');
  });

  test('store 里有多条、又没记 currentProfile → 报错列清单，绝不瞎猜', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        profiles: [
          profile('http://a.example.com', 'alice', 'a'.repeat(32)),
          profile('http://b.example.com', 'bob', 'b'.repeat(32)),
        ],
      },
      'zentao.json'
    );

    expect(() => loadConfig()).toThrow(/无法确定用哪条/);
    expect(() => loadConfig()).toThrow(/alice@http:\/\/a\.example\.com/);
    expect(() => loadConfig()).toThrow(/bob@http:\/\/b\.example\.com/);
  });

  test('ZENTAO_PROFILE 指定 key → 精确命中那一条', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        profiles: [
          profile('http://a.example.com', 'alice', 'a'.repeat(32)),
          profile('http://b.example.com', 'bob', 'b'.repeat(32)),
        ],
      },
      'zentao.json'
    );
    process.env.ZENTAO_PROFILE = 'bob@http://b.example.com';

    const config = loadConfig();

    expect(config.account).toBe('bob');
    expect(config.baseUrl).toBe('http://b.example.com');
  });

  test('ZENTAO_PROFILE 也认「仅账号」和「账号@主机名」（对齐官方 CLI）', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        profiles: [
          profile('http://a.example.com', 'alice', 'a'.repeat(32)),
          profile('http://b.example.com', 'bob', 'b'.repeat(32)),
        ],
      },
      'zentao.json'
    );

    process.env.ZENTAO_PROFILE = 'bob';
    expect(loadConfig().baseUrl).toBe('http://b.example.com');

    process.env.ZENTAO_PROFILE = 'alice@a.example.com';
    expect(loadConfig().baseUrl).toBe('http://a.example.com');
  });

  test('ZENTAO_PROFILE 指定了不存在的 → 报错并列出现有可选项', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      { profiles: [profile('http://a.example.com', 'alice', 'a'.repeat(32))] },
      'zentao.json'
    );
    process.env.ZENTAO_PROFILE = 'nobody';

    expect(() => loadConfig()).toThrow(/指定的 profile 不存在/);
    expect(() => loadConfig()).toThrow(/alice@http:\/\/a\.example\.com/);
  });

  test('store 内容不是合法 JSON → 报错说明原因，而不是崩在解析上', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore('{ 这不是 JSON', 'zentao.json');

    expect(() => loadConfig()).toThrow(/不是合法 JSON/);
  });

  test('store 文件不存在 → 仍是原来的「缺少禅道认证信息」（clearEnv 已指向不存在的路径）', () => {
    expect(() => loadConfig()).toThrow(/缺少禅道认证信息/);
  });

  test('字段不全的 profile 条目被静默跳过，剩下的照用', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      {
        profiles: [
          { server: 'http://broken.example.com', account: 'nope' }, // 缺 token
          { server: '', account: 'blank', token: 'x' }, // server 空
          'not-an-object',
          profile('http://good.example.com', 'good', 'g'.repeat(32)),
        ],
      },
      'zentao.json'
    );

    const config = loadConfig();

    expect(config.credentialSource).toBe('profile');
    expect(config.account).toBe('good');
    expect(config.baseUrl).toBe('http://good.example.com');
  });

  test('环境变量账号半填 → 照旧报错，不被 profile 静默兜住', () => {
    process.env.ZENTAO_CONFIG_FILE = writeStore(
      { profiles: [profile('http://a.example.com', 'alice', 'a'.repeat(32))] },
      'zentao.json'
    );
    process.env.ZENTAO_ACCOUNT = 'alice'; // 故意不给密码

    expect(() => loadConfig()).toThrow(/必须成对配置/);
  });
});

describe('loadConfig - baseUrl 规范化', () => {
  beforeEach(() => {
    clearEnv();
    process.env.ZENTAO_ACCOUNT = 'a';
    process.env.ZENTAO_PASSWORD = 'b';
  });
  afterAll(clearEnv);

  test.each([
    ['http://host/zentaomax', 'http://host/zentaomax'],
    ['http://host/zentaomax/', 'http://host/zentaomax'],
    // 带 /index.php 会打到前台路由、返回登录页 HTML，必须被剥掉
    ['http://host/zentaomax/index.php', 'http://host/zentaomax'],
    ['http://host/zentaomax/index.php/', 'http://host/zentaomax'],
    ['  http://host/zentaomax///  ', 'http://host/zentaomax'],
    // 有人习惯把 api.php/v2 也写进地址，必须剥掉，否则会拼出 /api.php/v2/api.php/v2/...
    ['http://host/zentaomax/api.php/v2', 'http://host/zentaomax'],
    ['http://host/zentaomax/api.php/v1/', 'http://host/zentaomax'],
  ])('%s → %s', (input, expected) => {
    process.env.ZENTAO_BASE_URL = input;
    expect(loadConfig().baseUrl).toBe(expected);
  });

  test('未配置时回退到 http://localhost', () => {
    expect(loadConfig().baseUrl).toBe('http://localhost');
  });
});

describe('loadConfig - API 版本', () => {
  beforeEach(() => {
    clearEnv();
    process.env.ZENTAO_ACCOUNT = 'a';
    process.env.ZENTAO_PASSWORD = 'b';
  });
  afterAll(clearEnv);

  test('默认走 v2（API 2.0）', () => {
    expect(loadConfig().apiVersion).toBe('v2');
  });

  test('显式指定 v1 时回落旧版', () => {
    process.env.ZENTAO_API_VERSION = 'v1';
    expect(loadConfig().apiVersion).toBe('v1');
  });

  test('写 /api.php/v1 进 BASE_URL 时也能嗅探出版本', () => {
    process.env.ZENTAO_BASE_URL = 'http://host/zentaomax/api.php/v1';
    const config = loadConfig();
    expect(config.apiVersion).toBe('v1');
    expect(config.baseUrl).toBe('http://host/zentaomax');
  });

  test('非法值不影响默认（仍为 v2）', () => {
    process.env.ZENTAO_API_VERSION = 'v9';
    expect(loadConfig().apiVersion).toBe('v2');
  });
});

describe('loadConfig - 方法覆盖策略', () => {
  beforeEach(() => {
    clearEnv();
    process.env.ZENTAO_ACCOUNT = 'a';
    process.env.ZENTAO_PASSWORD = 'b';
  });
  afterAll(clearEnv);

  test('不配置时默认 auto（先试原生方法，被拒再覆盖）', () => {
    expect(loadConfig().methodOverride).toBe('auto');
  });

  test.each([
    ['always', 'always'],
    ['ALWAYS', 'always'],
    ['true', 'always'],
    ['1', 'always'],
    ['never', 'never'],
    ['false', 'never'],
    ['0', 'never'],
  ])('ZENTAO_METHOD_OVERRIDE=%s → %s', (input, expected) => {
    process.env.ZENTAO_METHOD_OVERRIDE = input;
    expect(loadConfig().methodOverride).toBe(expected);
  });

  test('非法值回落 auto', () => {
    process.env.ZENTAO_METHOD_OVERRIDE = 'maybe';
    expect(loadConfig().methodOverride).toBe('auto');
  });
});

describe('ZenTaoClient - 换 Token 链路（v2 默认 / v1 回落）', () => {
  let server: http.Server;
  let baseUrl: string;
  /** 记录服务端收到的每个请求，用来断言请求路径、查询串与请求头 */
  const requests: Array<{
    method: string;
    url: string;
    query: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  /** mock 里认可的 Token */
  const GOOD_TOKEN = 'test-rest-token';

  beforeAll(async () => {
    // axios 会读 HTTP_PROXY 环境变量把请求丢给代理（本机 WorkBuddy 运行时确实注入了 HTTP_PROXY），
    // 那样打到 127.0.0.1 的请求会变成绝对 URI 形式，甚至根本到不了 mock 服务端。
    // 显式放行本地地址，让测试只依赖本机回环。
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.no_proxy = '127.0.0.1,localhost';

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        // req.url 可能是 origin-form（/api.php/...）也可能是 absolute-form
        // （http://127.0.0.1:port/api.php/...），统一取 pathname，查询串单独留一份
        let pathname = req.url || '';
        let search = '';
        try {
          const parsedUrl = new URL(pathname, 'http://127.0.0.1');
          pathname = parsedUrl.pathname;
          search = parsedUrl.search;
        } catch {
          /* 保持原样 */
        }

        requests.push({
          method: req.method || '',
          url: pathname,
          query: search,
          headers: req.headers,
          body,
        });

        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        // ================= API 2.0（默认）=================
        // 换取 Token：POST /api.php/v2/users/login → { status:'success', token }
        if (req.method === 'POST' && pathname === '/api.php/v2/users/login') {
          const parsed = JSON.parse(body || '{}');
          if (parsed.account === 'zhangsan' && parsed.password === 'p@ss') {
            return json(200, {
              status: 'success',
              token: GOOD_TOKEN,
              user: { id: 1, account: 'zhangsan' },
            });
          }
          return json(401, { status: 'fail', message: 'Unauthorized' });
        }

        // 业务接口：2.0 的响应统一是 { status:'success', <资源>, pager }
        if (pathname.startsWith('/api.php/v2/projects')) {
          if (req.headers['token'] === GOOD_TOKEN) {
            return json(200, {
              status: 'success',
              projects: [],
              pager: { recTotal: 0, pageID: 1, recPerPage: 20, pageTotal: 1 },
            });
          }
          return json(401, { status: 'fail', message: 'Unauthorized' });
        }

        // 禅道很常见的一种形态：HTTP 200，但业务层失败（status:'fail' + message）。
        // 实测 /system、不存在的 execution 都是这个套路，必须能被识别成错误。
        if (pathname === '/api.php/v2/tasks/999') {
          return json(200, { status: 'fail', message: 'Execution does not exist' });
        }

        // ================= API 1.0（回落）=================
        if (req.method === 'POST' && pathname === '/api.php/v1/tokens') {
          const parsed = JSON.parse(body || '{}');
          if (parsed.account === 'zhangsan' && parsed.password === 'p@ss') {
            return json(201, { token: GOOD_TOKEN });
          }
          return json(401, { error: 'Unauthorized' });
        }

        if (pathname.startsWith('/api.php/v1/projects')) {
          if (req.headers['token'] === GOOD_TOKEN) {
            return json(200, { page: 1, total: 0, limit: 1, projects: [] });
          }
          return json(401, { error: 'Unauthorized' });
        }

        return json(404, { status: 'fail', message: 'Not Found' });
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

  const silentLogger = () => new Logger(LogLevel.ERROR);

  // ---------- v2（默认）----------

  test('[v2] 配了账号密码 → 先换 Token，再用 Token 头访问业务接口', async () => {
    const client = new ZenTaoClient(
      { baseUrl, account: 'zhangsan', password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await client.get('/projects', { limit: 1 });

    const tokenCall = requests.find((r) => r.url === '/api.php/v2/users/login');
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.method).toBe('POST');
    expect(JSON.parse(tokenCall!.body)).toEqual({ account: 'zhangsan', password: 'p@ss' });

    const businessCall = requests.find((r) => r.url?.startsWith('/api.php/v2/projects'));
    expect(businessCall).toBeDefined();
    expect(businessCall!.headers['token']).toBe(GOOD_TOKEN);

    // Token 换到后要缓存住，不该每次请求都换一次
    expect(requests.filter((r) => r.url === '/api.php/v2/users/login')).toHaveLength(1);
  });

  test('[v2] 分页参数映射成 pageID / recPerPage', async () => {
    const client = new ZenTaoClient(
      { baseUrl, account: 'zhangsan', password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await client.get('/projects', client.paginationParams(3, 15));

    const call = requests.find((r) => r.url?.startsWith('/api.php/v2/projects'));
    expect(call).toBeDefined();
    expect(call!.query).toContain('pageID=3');
    expect(call!.query).toContain('recPerPage=15');
    expect(call!.query).not.toContain('page=3');
  });

  test('[v2] HTTP 200 但业务返回 { status:"fail" } 时也要抛错并带出禅道文案', async () => {
    // 禅道很多接口是 200 + status:'fail'，不能当成成功
    const client = new ZenTaoClient(
      { baseUrl, token: GOOD_TOKEN, timeout: 5000, retry: 0 },
      silentLogger()
    );

    await expect(client.get('/tasks/999')).rejects.toThrow(/Execution does not exist/);
  });

  test('[v2] 业务接口 401 时抛错，并同时带出禅道文案与排查提示', async () => {
    const client = new ZenTaoClient(
      { baseUrl, token: 'bad-token', timeout: 5000, retry: 0 },
      silentLogger()
    );

    // 禅道的 "Unauthorized" 不该被 axios 的 "status code 401" 吞掉
    await expect(client.get('/projects')).rejects.toThrow(/Unauthorized/);
    // 同时要给出可操作的排查方向
    await expect(client.get('/projects')).rejects.toThrow(/认证失败|ZENTAO_TOKEN/);
  });

  test('[v2] 静态 Token 直接走 Token 头，不去换 Token', async () => {
    const client = new ZenTaoClient(
      { baseUrl, token: GOOD_TOKEN, timeout: 5000, retry: 0 },
      silentLogger()
    );

    await client.get('/projects', { limit: 1 });

    expect(requests.some((r) => r.url === '/api.php/v2/users/login')).toBe(false);
    expect(requests[0].headers['token']).toBe(GOOD_TOKEN);
  });

  test('[v2] 账号密码错误时，错误信息里带出禅道返回的原因', async () => {
    const client = new ZenTaoClient(
      { baseUrl, account: 'zhangsan', password: 'wrong', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await expect(client.get('/projects')).rejects.toThrow(/获取禅道 Token 失败/);
    await expect(client.get('/projects')).rejects.toThrow(/Unauthorized/);
  });

  test('[v2] verifyConnection：认证有效返回 true', async () => {
    const client = new ZenTaoClient(
      { baseUrl, account: 'zhangsan', password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await expect(client.verifyConnection()).resolves.toBe(true);
  });

  test('[v2] verifyConnection：认证无效返回 false（不抛异常）', async () => {
    const client = new ZenTaoClient(
      { baseUrl, token: 'bad-token', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await expect(client.verifyConnection()).resolves.toBe(false);
  });

  // ---------- v1（回落）----------

  test('[v1] 显式指定 v1 时走旧版端点 /api.php/v1/tokens', async () => {
    const client = new ZenTaoClient(
      { baseUrl, apiVersion: 'v1', account: 'zhangsan', password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await client.get('/projects', { limit: 1 });

    expect(requests.find((r) => r.url === '/api.php/v1/tokens')).toBeDefined();
    expect(requests.find((r) => r.url?.startsWith('/api.php/v1/projects'))).toBeDefined();
    // 不应碰到 v2 的任何路径
    expect(requests.some((r) => r.url?.startsWith('/api.php/v2'))).toBe(false);
  });

  test('[v1] 分页参数仍是 page / limit', async () => {
    const client = new ZenTaoClient(
      { baseUrl, apiVersion: 'v1', account: 'zhangsan', password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );

    await client.get('/projects', client.paginationParams(2, 10));

    const call = requests.find((r) => r.url?.startsWith('/api.php/v1/projects'));
    expect(call).toBeDefined();
    expect(call!.query).toContain('page=2');
    expect(call!.query).toContain('limit=10');
  });

  // ---------- 通用 ----------

  test('完全没配认证信息时立刻失败，不发匿名请求', async () => {
    const client = new ZenTaoClient({ baseUrl, timeout: 5000, retry: 0 }, silentLogger());

    await expect(client.get('/projects')).rejects.toThrow(/缺少认证信息/);
    expect(requests).toHaveLength(0);
  });

  test('resolveEndpoint：相对路径补前缀，绝对路径原样保留', () => {
    const v2 = new ZenTaoClient({ baseUrl, token: 'x' }, silentLogger());
    expect(v2.apiPrefix).toBe('/api.php/v2');
    expect(v2.resolveEndpoint('/projects')).toBe('/api.php/v2/projects');
    expect(v2.resolveEndpoint('projects')).toBe('/api.php/v2/projects');
    // 已经是完整路径就不该再叠一层
    expect(v2.resolveEndpoint('/api.php/v1/projects')).toBe('/api.php/v1/projects');

    const v1 = new ZenTaoClient({ baseUrl, apiVersion: 'v1', token: 'x' }, silentLogger());
    expect(v1.apiPrefix).toBe('/api.php/v1');
    expect(v1.resolveEndpoint('/projects')).toBe('/api.php/v1/projects');
  });
});

/**
 * PUT / DELETE 的方法覆盖（method override）
 *
 * 背景：本项目实测对接的禅道实例，前置 Web 服务器会在 HTTP 层直接掐断 PUT/DELETE
 * （连接被重置，连响应体都拿不到），但应用层是好的 —— 用
 * `POST + X-HTTP-Method-Override: PUT` 能正常转发到 `/bugs/{id}/resolve` 这类动作端点。
 *
 * 这里用 mock 服务端复现三种服务器行为，确认客户端能正确区分：
 *   1. 不支持原生方法   → 连接被掐断（ECONNRESET）
 *   2. 支持原生方法     → 正常响应（**不该**多此一举去覆盖）
 *   3. 业务报错         → HTTP 200 + status:'fail'（**不该**被误判为「方法被拒」而重试）
 */
describe('ZenTaoClient - PUT/DELETE 方法覆盖', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: Array<{ method: string; url: string; query: string; override?: string }> = [];
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  beforeAll(async () => {
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.no_proxy = '127.0.0.1,localhost';

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let pathname = req.url || '';
        let search = '';
        try {
          const parsedUrl = new URL(pathname, 'http://127.0.0.1');
          pathname = parsedUrl.pathname;
          search = parsedUrl.search;
        } catch {
          /* 保持原样 */
        }

        const override = req.headers['x-http-method-override'];
        requests.push({
          method: req.method || '',
          url: pathname,
          query: search,
          override: override ? String(override) : undefined,
        });

        const json = (payload: unknown) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const success = () => json({ status: 'success', bug: { id: 1, title: 'mock' } });
        const businessFail = () => json({ status: 'fail', message: 'Bug does not exist.' });

        if (req.method === 'PUT' || req.method === 'DELETE') {
          // .../3：这个实例支持原生 PUT/DELETE
          if (pathname.endsWith('/3')) return success();
          // .../2：方法没问题，是业务层报错
          if (pathname.endsWith('/2')) return businessFail();
          // 其余：模拟前置 Web 服务器在 HTTP 层掐断连接（不给任何响应）
          req.socket.destroy();
          return;
        }

        // 能用 POST 走到这里，说明客户端做了方法覆盖（或本来就是 POST 动作端点）
        if (pathname.endsWith('/2')) return businessFail();
        return success();
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

  const silentLogger = () => new Logger(LogLevel.ERROR);
  const makeClient = (methodOverride?: 'auto' | 'always' | 'never') =>
    new ZenTaoClient(
      { baseUrl, token: 'x', timeout: 5000, retry: 0, methodOverride },
      silentLogger()
    );

  test('auto：PUT 被掐断 → 自动改用 POST + X-HTTP-Method-Override 重试并成功', async () => {
    const client = makeClient('auto');
    expect(client.methodOverrideActive).toBe(false);

    await expect(client.put('/bugs/1', { title: 'x' })).resolves.toMatchObject({ status: 'success' });

    expect(requests).toHaveLength(2);
    // 第一发是原生 PUT（被掐断）
    expect(requests[0]).toMatchObject({ method: 'PUT', override: undefined });
    // 第二发改成 POST + 覆盖头，并带上 _method 作双保险
    expect(requests[1].method).toBe('POST');
    expect(requests[1].override).toBe('PUT');
    expect(requests[1].query).toContain('_method=PUT');
    // 探测结论要缓存下来，后续写请求不再白挨一次连接重置
    expect(client.methodOverrideActive).toBe(true);
  });

  test('auto：学到结论后，后续 PUT 直接走覆盖，不再发原生 PUT', async () => {
    const client = makeClient('auto');

    await client.put('/bugs/1', { title: 'a' });
    requests.length = 0;

    await client.put('/bugs/1', { title: 'b' });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].override).toBe('PUT');
  });

  test('auto：DELETE 同样能降级为覆盖', async () => {
    const client = makeClient('auto');

    await expect(client.delete('/bugs/1')).resolves.toMatchObject({ status: 'success' });

    expect(requests[0].method).toBe('DELETE');
    expect(requests[1].method).toBe('POST');
    expect(requests[1].override).toBe('DELETE');
  });

  test('auto：服务器支持原生 PUT 时不该去覆盖', async () => {
    const client = makeClient('auto');

    await expect(client.put('/bugs/3', { title: 'x' })).resolves.toMatchObject({ status: 'success' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'PUT', override: undefined });
  });

  test('auto：业务报错（200 + status:fail）不该被误判成「方法被拒」而重试', async () => {
    const client = makeClient('auto');

    await expect(client.put('/bugs/2', { title: 'x' })).rejects.toThrow(/Bug does not exist/);

    // 只该有那一发原生 PUT，不能因为业务失败就改走覆盖
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('PUT');
  });

  test('always：首次就发 POST + 覆盖头，完全不发原生 PUT', async () => {
    const client = makeClient('always');
    expect(client.methodOverrideActive).toBe(true);

    await expect(client.put('/bugs/1', { title: 'x' })).resolves.toMatchObject({ status: 'success' });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].override).toBe('PUT');
  });

  test('never：永不覆盖，被掐断就如实失败', async () => {
    const client = makeClient('never');

    await expect(client.put('/bugs/1', { title: 'x' })).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('PUT');
    expect(client.methodOverrideActive).toBe(false);
  });

  test('动作端点（POST 语义）走覆盖后能正常返回', async () => {
    const client = makeClient('auto');

    await expect(
      client.put('/bugs/1/resolve', { resolution: 'fixed' })
    ).resolves.toMatchObject({ status: 'success' });

    const override = requests.find((r) => r.override === 'PUT');
    expect(override).toBeDefined();
    expect(override!.url).toBe('/api.php/v2/bugs/1/resolve');
  });
});
