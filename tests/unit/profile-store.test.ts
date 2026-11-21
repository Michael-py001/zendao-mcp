/**
 * 官方 CLI profile store 的只读访问器（`src/utils/profile-store.ts`）
 *
 * 覆盖：
 *   1. 路径解析（`ZENTAO_CONFIG_FILE` 覆盖、`~` 展开、相对路径转绝对、默认路径）
 *   2. 读取的容错（不存在 / 坏 JSON / 缺 profiles / 单条字段不全 / 尾斜杠规范化）
 *   3. 选择优先级（指定 key > currentProfile > 唯一一条 > 报错不猜）
 *
 * ⚠️ 全程只用**临时文件**，绝不读写真实的 `~/.config/zentao/zentao.json`。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getProfileStorePath,
  isTokenProbablyExpired,
  readProfileStore,
  selectProfile,
} from '../../src/utils/profile-store';

const STORE_KEY = 'ZENTAO_CONFIG_FILE';

function makeStore(content: unknown, name = 'zentao.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-ps-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

function p(server: string, account: string, token: string, extra: Record<string, unknown> = {}) {
  return { server, account, token, loginTime: '2026-09-01T00:00:00.000Z', lastUsedTime: '2026-09-02T00:00:00.000Z', ...extra };
}

beforeEach(() => {
  delete process.env[STORE_KEY];
});

afterAll(() => {
  delete process.env[STORE_KEY];
});

describe('getProfileStorePath', () => {
  test('没配 ZENTAO_CONFIG_FILE → ~/.config/zentao/zentao.json（与官方 CLI 一致）', () => {
    expect(getProfileStorePath()).toBe(
      path.join(os.homedir(), '.config', 'zentao', 'zentao.json')
    );
  });

  test('ZENTAO_CONFIG_FILE 覆盖，且 ~ 会展开为家目录', () => {
    process.env[STORE_KEY] = '~/.config/zentao/custom.json';
    expect(getProfileStorePath()).toBe(
      path.join(os.homedir(), '.config', 'zentao', 'custom.json')
    );
  });

  test('相对路径转成绝对路径（对齐官方 CLI 的 setConfigPath）', () => {
    process.env[STORE_KEY] = 'tmp/zentao.json';
    expect(path.isAbsolute(getProfileStorePath())).toBe(true);
    expect(getProfileStorePath()).toBe(path.resolve('tmp/zentao.json'));
  });

  test('空白值等于没配', () => {
    process.env[STORE_KEY] = '   ';
    expect(getProfileStorePath()).toBe(
      path.join(os.homedir(), '.config', 'zentao', 'zentao.json')
    );
  });
});

describe('readProfileStore - 容错', () => {
  test('文件不存在 → exists:false、空清单、无 error（没装官方 CLI 很正常）', () => {
    process.env[STORE_KEY] = path.join(os.tmpdir(), `nope-${Date.now()}.json`);

    const snap = readProfileStore();

    expect(snap.exists).toBe(false);
    expect(snap.profiles).toEqual([]);
    expect(snap.error).toBeUndefined();
  });

  test('内容不是合法 JSON → 记 error，不抛错', () => {
    process.env[STORE_KEY] = makeStore('{ 这不是 JSON');

    const snap = readProfileStore();

    expect(snap.exists).toBe(true);
    expect(snap.error).toMatch(/不是合法 JSON/);
    expect(snap.profiles).toEqual([]);
  });

  test('缺 profiles 数组 → 记 error', () => {
    process.env[STORE_KEY] = makeStore({ currentProfile: 'a@b' });

    expect(readProfileStore().error).toMatch(/缺少 profiles 数组/);
  });

  test('字段不全的条目被静默跳过，其余保留', () => {
    process.env[STORE_KEY] = makeStore({
      profiles: [
        { server: 'http://a', account: 'a' }, // 缺 token
        { server: 'http://b', token: 't' }, // 缺 account
        { account: 'c', token: 't' }, // 缺 server
        { server: '  ', account: 'd', token: 't' }, // server 空白
        { server: 'http://e', account: 'e', token: '   ' }, // token 空白
        'not-an-object',
        null,
        p('http://good', 'good', 'g'),
      ],
    });

    const snap = readProfileStore();

    expect(snap.profiles).toHaveLength(1);
    expect(snap.profiles[0].account).toBe('good');
  });

  test('server 尾斜杠被规范化，key 与官方 CLI 的 profileKey 对齐', () => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('http://10.0.0.9/zentaomax///', 'your-account', 't')] });

    const snap = readProfileStore();

    expect(snap.profiles[0].server).toBe('http://10.0.0.9/zentaomax');
    expect(snap.profiles[0].key).toBe('your-account@http://10.0.0.9/zentaomax');
  });

  test('account / token 两侧空白被裁掉', () => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('http://a', '  bob  ', '  ' + 'x'.repeat(32) + '  ')] });

    const snap = readProfileStore();

    expect(snap.profiles[0].account).toBe('bob');
    expect(snap.profiles[0].token).toBe('x'.repeat(32));
  });

  test('currentProfile 非字符串时视为未设置', () => {
    process.env[STORE_KEY] = makeStore({ currentProfile: 42, profiles: [p('http://a', 'a', 't')] });

    expect(readProfileStore().currentProfile).toBeUndefined();
  });
});

describe('selectProfile - 优先级', () => {
  test('store 只有一条 → 直接用（不看 currentProfile）', () => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('http://a', 'alice', 't')] });

    const sel = selectProfile(readProfileStore());

    expect(sel.reason).toBe('selected');
    expect(sel.profile?.account).toBe('alice');
  });

  test('多条 + 有 currentProfile → 用 currentProfile', () => {
    process.env[STORE_KEY] = makeStore({
      currentProfile: 'bob@http://b',
      profiles: [p('http://a', 'alice', 't'), p('http://b', 'bob', 't')],
    });

    expect(selectProfile(readProfileStore()).profile?.account).toBe('bob');
  });

  test('currentProfile 指向已不存在的条目 → 多条时按「无法确定」报错', () => {
    process.env[STORE_KEY] = makeStore({
      currentProfile: 'ghost@http://ghost',
      profiles: [p('http://a', 'alice', 't'), p('http://b', 'bob', 't')],
    });

    const sel = selectProfile(readProfileStore());

    expect(sel.reason).toBe('ambiguous');
    expect(sel.profile).toBeUndefined();
  });

  test('多条 + 无 currentProfile + 未指定 → ambiguous，且列出全部候选', () => {
    process.env[STORE_KEY] = makeStore({
      profiles: [p('http://a', 'alice', 't'), p('http://b', 'bob', 't')],
    });

    const sel = selectProfile(readProfileStore());

    expect(sel.reason).toBe('ambiguous');
    expect(sel.candidates).toEqual(['alice@http://a', 'bob@http://b']);
  });

  test('显式 selector 压过 currentProfile', () => {
    process.env[STORE_KEY] = makeStore({
      currentProfile: 'bob@http://b',
      profiles: [p('http://a', 'alice', 't'), p('http://b', 'bob', 't')],
    });

    expect(selectProfile(readProfileStore(), 'alice').profile?.account).toBe('alice');
  });

  test('selector 支持 account@server / 仅账号 / account@hostname 三种写法', () => {
    process.env[STORE_KEY] = makeStore({
      profiles: [p('http://a.example.com:8080/x', 'alice', 't')],
    });
    const snap = readProfileStore();

    expect(selectProfile(snap, 'alice@http://a.example.com:8080/x').profile?.account).toBe('alice');
    expect(selectProfile(snap, 'alice').profile?.account).toBe('alice');
    expect(selectProfile(snap, 'alice@a.example.com').profile?.account).toBe('alice');
  });

  test('selector 前后空白容忍', () => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('http://a', 'alice', 't')] });

    expect(selectProfile(readProfileStore(), '  alice  ').profile?.account).toBe('alice');
  });

  test('selector 没命中 → not-found（不回落到 currentProfile，「显式指定」必须严格）', () => {
    process.env[STORE_KEY] = makeStore({
      currentProfile: 'bob@http://b',
      profiles: [p('http://a', 'alice', 't'), p('http://b', 'bob', 't')],
    });

    const sel = selectProfile(readProfileStore(), 'nobody');

    expect(sel.reason).toBe('not-found');
    expect(sel.profile).toBeUndefined();
    expect(sel.candidates).toHaveLength(2);
  });

  test('空 store → empty', () => {
    expect(selectProfile({ path: '/nope', exists: false, profiles: [] }).reason).toBe('empty');
  });

  test('store 坏了 → store-error（优先于 empty / ambiguous）', () => {
    const sel = selectProfile({
      path: '/bad',
      exists: true,
      profiles: [],
      error: '内容不是合法 JSON',
    });

    expect(sel.reason).toBe('store-error');
  });

  test('server 不是合法 URL 时，「账号@主机名」形态不误命中也不抛异常', () => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('not-a-url', 'alice', 't')] });
    const snap = readProfileStore();

    // 完整 key 就是 `account@server`，照常命中
    expect(selectProfile(snap, 'alice@not-a-url').profile?.account).toBe('alice');
    // `account@hostname` 形态在这种数据上不成立 —— 不能靠字符串拼接误判
    expect(selectProfile(snap, 'alice@example.com').reason).toBe('not-found');
    // 仅账号仍然可用
    expect(selectProfile(snap, 'alice').profile?.account).toBe('alice');
  });
});

// 实测依据：禅道 REST Token 有寿命。本实例 store 里 `serverConfig.expiredTime` 为 **14400 秒（4 小时）**，
// 09-18 签发的 token 两天后打接口是 `401 Not allowed`，而同时新 login 的 token 可用
// （且多个 token 可并存，不存在「后签顶掉前签」）—— 所以过期才是主因。
// store **不存密码** ⇒ 过期后无法自动续期，只能提示用户重新 `zentao login`。
describe('Token 有效期推算', () => {
  const TTL = (seconds: number) => ({ expiredTime: String(seconds) });

  test('loginTime + expiredTime(秒) 推算出失效时刻', () => {
    process.env[STORE_KEY] = makeStore({
      profiles: [p('http://a', 'alice', 't', { serverConfig: TTL(14400) })],
    });

    // 2026-09-01T00:00:00Z + 4h
    expect(readProfileStore().profiles[0].tokenExpiresAt).toBe('2026-09-01T04:00:00.000Z');
  });

  test('expiredTime 是数字类型也认', () => {
    process.env[STORE_KEY] = makeStore({
      profiles: [p('http://a', 'alice', 't', { serverConfig: { expiredTime: 3600 } })],
    });

    expect(readProfileStore().profiles[0].tokenExpiresAt).toBe('2026-09-01T01:00:00.000Z');
  });

  test.each([
    ['没有 serverConfig', {}],
    ['serverConfig 不是对象', { serverConfig: 'x' }],
    ['缺 expiredTime', { serverConfig: {} }],
    ['expiredTime 不是数字', { serverConfig: { expiredTime: 'soon' } }],
    ['expiredTime 是 0 / 负数', { serverConfig: { expiredTime: '0' } }],
    ['缺 loginTime', { serverConfig: TTL(14400), loginTime: undefined }],
    ['loginTime 不是合法时间', { serverConfig: TTL(14400), loginTime: 'not-a-time' }],
  ])('%s → 不给推算结果（宁可不提示，也不给错提示）', (_label, extra) => {
    process.env[STORE_KEY] = makeStore({ profiles: [p('http://a', 'alice', 't', extra)] });

    expect(readProfileStore().profiles[0].tokenExpiresAt).toBeUndefined();
  });

  test('isTokenProbablyExpired：过没过期只看推算时刻，拿不准一律 false', () => {
    const at = (expiresAt?: string) => ({ key: 'a@b', server: 'b', account: 'a', token: 't', tokenExpiresAt: expiresAt });

    expect(isTokenProbablyExpired(at('2026-09-01T04:00:00.000Z'), Date.parse('2026-09-01T03:59:59Z'))).toBe(false);
    expect(isTokenProbablyExpired(at('2026-09-01T04:00:00.000Z'), Date.parse('2026-09-01T04:00:01Z'))).toBe(true);
    // 推算不出来 → 不猜，交给服务端 401 兜底
    expect(isTokenProbablyExpired(at(undefined))).toBe(false);
  });
});
