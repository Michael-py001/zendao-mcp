/**
 * Bug 列表 / 「我的 Bug」离线回归测试
 *
 * 这里守的是三个**会静默返回假阴性**的实现缺陷 —— 它们不报错，
 * 只会让「我的待处理 Bug」显示成 0 条或少数几条，是最难被发现的一类 bug：
 *
 *   1. `browseType=assignedtome` 曾被原样发给服务端。本实例服务端不认这个口径，
 *      返回的是**空集**（不是报错），本地兜底过滤于是永远跑在空集上 → 恒为 0。
 *      修法：只把 all / unresolved 发给服务端，assignedtome 一律本地实现。
 *
 *   2. 本地过滤时拉取上限曾是 500，而库里 766 条。Bug 列表按 id 升序返回，
 *      前 500 条几乎全是已关闭的老单 —— 截断等于把正在处理的单全丢掉。
 *      修法：按单页上限拉满（1000），见 MAX_BUG_FETCH。
 *
 *   3. **数据源本身不全**（本轮发现，最隐蔽的一个）：本实例的 `GET /bugs`
 *      不带 `productID` 时只返回**某一个产品**的 Bug（而 `pager.recTotal` 也谎报成
 *      该产品的条数），同时 `GET /products` 又会**漏掉 shadow=1 的影子产品**。
 *      两者叠加 → 整个产品线的 Bug 凭空消失。
 *      修法：全局范围改走 utils/products.ts 的 fetchAllBugs（逐产品合并 + 用
 *      /bugs 的产品字典补齐影子产品）。真实数据里正是这一步让「我的待处理 Bug」
 *      从 0 条变成 6 条（都在影子产品 2000076 里）。
 *
 * 全程用本机 mock HTTP 服务，**不碰真实禅道**，可离线反复跑。
 */

import * as http from 'http';
import { AddressInfo } from 'net';

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';
import { Logger, LogLevel } from '../../src/utils/logger';
import { listBugs, MAX_BUG_FETCH } from '../../src/tools/getBugs';
import { listMyBugs, matchRole, ROLE_FIELDS, ROLE_LABELS, MyBugRole } from '../../src/tools/getMyBugs';
import { bugStatusLabel } from '../../src/utils/labels';

/** 模拟产品 9 的 Bug 总量。刻意 > 旧的 500 截断值，才能复现漏筛 */
const TOTAL = 766;
const ME = 'your-account';
/** `/bugs` 不带产品时默认返回的那个产品（真实实例里是产品 9） */
const DEFAULT_PRODUCT = 9;
/** 被 `/products` 列表漏掉的影子产品（真实实例里是 2000076 电网储能工程造价分析系统） */
const SHADOW_PRODUCT = 2000076;
/** 影子产品下那条「指派给我」的未关闭 Bug —— 修复前它完全看不见 */
const SHADOW_BUG_ID = 2010523;

/**
 * 构造产品 9 的数据集。
 *
 * 关键设计：把「指派给我」的那一条放在**列表最末尾**（id 最大），
 * 这样任何截断都会精确地把它丢掉 —— 这正是缺陷 2 返回 0 条的原因。
 */
function buildBugs(): Record<string, any> {
  const dict: Record<string, any> = {};
  for (let i = 1; i <= TOTAL; i++) {
    const id = 10000 + i;
    const open = i > TOTAL - 6; // 最后 6 条未关闭，其余已关闭
    dict[id] = {
      id,
      product: DEFAULT_PRODUCT,
      title: `Bug ${i}`,
      status: open ? 'active' : 'closed',
      // 禅道会把已关闭 Bug 的 assignedTo 置成字符串 'closed'
      assignedTo: open ? (i === TOTAL - 4 ? ME : 'someone') : 'closed',
      severity: 3,
      pri: 3,
      openedBy: 'tester',
      openedDate: '2026-01-01',
      // 每 10 条有一条是我解决的，且这些都在「已关闭」区间
      resolvedBy: i % 10 === 0 ? ME : 'someone',
      lastEditedBy: 'tester',
    };
  }
  return dict;
}

const BUGS = buildBugs();
const RESOLVED_BY_ME = Object.values(BUGS).filter((b) => b.resolvedBy === ME).length; // 76

/** 影子产品下的 Bug：产品列表里没有它，只能靠 /bugs 的产品字典发现 */
const SHADOW_BUGS = [
  {
    id: SHADOW_BUG_ID,
    product: SHADOW_PRODUCT,
    title: '电网储能：任务表含预制舱关键词匹配不完整',
    status: 'active',
    assignedTo: ME,
    severity: 3,
    pri: 2,
    openedBy: 'zhulili',
    openedDate: '2026-09-11',
    resolvedBy: '',
    lastEditedBy: 'zhulili',
  },
];

/** 「指派给我 + 未关闭」的真实答案：产品 9 里 1 条 + 影子产品里 1 条 */
const MY_ASSIGNED_OPEN = 2;
/** 全部未关闭：产品 9 的 6 条 + 影子产品的 1 条 */
const ALL_OPEN = 7;

/**
 * 从查询串里取分页大小。
 *
 * ⚠️ API 2.0 用的是 `pageID` / `recPerPage`，`page` / `limit` 只属于 v1。
 * 这里曾经只认 `limit`，于是 mock 永远按默认 20 条返回 —— 测试看起来"通过"，
 * 实际根本没验证到拉取上限。踩过一次，记在这里。
 */
function fetchLimitOf(search: string): number {
  const q = new URLSearchParams(search);
  return Number(q.get('recPerPage') ?? q.get('limit') ?? '20');
}

/**
 * 「地盘」接口（`/my/work`）的数据集。
 *
 * 刻意让 `resolvedBy` 超过单页 100 条（130 条），才能真的验证翻页 ——
 * 否则「只拉第一页」这种缺陷会假装通过。
 */
function buildMyWork() {
  const resolved: any[] = [];
  for (let i = 0; i < 130; i++) {
    const open = i >= 127; // 只有 3 条未关闭
    resolved.push({
      id: 900000 + i,
      product: DEFAULT_PRODUCT,
      title: `我解决的 Bug ${i}`,
      status: open ? 'resolved' : 'closed',
      assignedTo: open ? 'someone' : 'closed',
      resolvedBy: ME,
      severity: 3,
      pri: 3,
      openedBy: 'tester',
      openedDate: '2026-01-01',
      lastEditedBy: 'tester',
    });
  }
  return {
    assignedTo: [
      // 产品 9 里那条（与「逐产品合并」路径口径一致）
      Object.values(BUGS).find((b: any) => b.assignedTo === ME && b.status !== 'closed'),
      // 影子产品里那条 —— 关键：它不在 /products 列表里，只有走对数据源才看得到
      SHADOW_BUGS[0],
    ] as any[],
    openedBy: [] as any[],
    resolvedBy: resolved,
  };
}
const MY_WORK: Record<string, any[]> = buildMyWork();
/** resolvedBy 里未关闭的条数 */
const RESOLVED_OPEN = MY_WORK.resolvedBy.filter((b) => b.status !== 'closed').length;

/** 拉起一个模拟「真实实例这两个坑」的禅道 */
async function startMockZenTao(opts: { myWork?: boolean } = {}) {
  const requests: Array<{ method: string; pathname: string; search: string }> = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let pathname = req.url || '';
      let search = '';
      try {
        const parsed = new URL(pathname, 'http://127.0.0.1');
        pathname = parsed.pathname;
        search = parsed.search;
      } catch {
        /* 保持原样 */
      }
      requests.push({ method: req.method || '', pathname, search });

      const send = (obj: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const notFound = () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      };

      if (pathname.endsWith('/users/login')) {
        return send({ status: 'success', token: 'test-token' });
      }

      // 「地盘」接口 —— 网页 m=my&f=work&mode=bug&type=assignedTo 背后的 v2 通路。
      // 真实响应的两个坑都在这里复现：顶层 recTotal 恒为 0、bugs 是 ID 字典。
      if (pathname.endsWith('/my/work')) {
        if (opts.myWork === false) return notFound();
        const q = new URLSearchParams(search);
        const type = q.get('type') || 'assignedTo';
        const limit = fetchLimitOf(search);
        const pageID = Number(q.get('pageID') ?? '1');
        const all = MY_WORK[type] || [];
        const slice = all.slice((pageID - 1) * limit, pageID * limit);
        return send({
          status: 'success',
          title: '地盘-我的任务',
          mode: 'bug',
          type,
          // ⚠️ 真实实例这个顶层字段恒为 0，真实总数只在 pager.recTotal
          recTotal: 0,
          todoCount: { task: 0, story: 0, bug: MY_WORK.assignedTo.length },
          // ⚠️ 真实实例返回 ID 字典；只有空集时才退化成数组 []
          bugs: slice.length ? Object.fromEntries(slice.map((b: any) => [b.id, b])) : [],
          pager: {
            recTotal: all.length,
            pageID,
            recPerPage: limit,
            pageTotal: Math.max(1, Math.ceil(all.length / limit)),
          },
        });
      }

      // 产品列表：⚠️ 刻意不含影子产品 —— 复现真实实例的缺陷 3
      if (/\/products$/.test(pathname)) {
        return send({
          status: 'success',
          products: [
            { id: 7, name: '评标系统', type: 'normal', status: 'normal', shadow: 0 },
            { id: DEFAULT_PRODUCT, name: '海上风电平台产品', type: 'normal', status: 'normal', shadow: 0 },
          ],
          pager: { recTotal: 2, pageID: 1, recPerPage: 1000, pageTotal: 1 },
        });
      }

      // 单产品 Bug 列表（干净数组形态）
      const productBugs = pathname.match(/\/products\/(\d+)\/bugs$/);
      if (productBugs) {
        const pid = Number(productBugs[1]);
        const limit = fetchLimitOf(search);
        const all: any[] =
          pid === DEFAULT_PRODUCT ? Object.values(BUGS) : pid === SHADOW_PRODUCT ? SHADOW_BUGS : [];
        const slice = all.slice(0, limit);
        return send({
          status: 'success',
          bugs: slice,
          pager: {
            recTotal: all.length,
            pageID: 1,
            recPerPage: limit,
            pageTotal: Math.max(1, Math.ceil(all.length / limit)),
          },
        });
      }

      // ⚠️ 全局 /bugs：真实实例只返回默认产品（`pager.recTotal` 也谎报成该产品条数），
      // 但它附带的 products 字典是**唯一能看到影子产品的地方**
      if (pathname.endsWith('/bugs') && !pathname.includes('/products/')) {
        const limit = fetchLimitOf(search);
        const all = Object.values(BUGS);
        return send({
          status: 'success',
          products: { 7: '评标系统', [DEFAULT_PRODUCT]: '海上风电平台产品', [SHADOW_PRODUCT]: '电网储能工程造价分析系统' },
          bugs: Object.fromEntries(all.slice(0, limit).map((b: any) => [b.id, b])),
          pager: { recTotal: all.length, pageID: 1, recPerPage: limit, pageTotal: 1 },
        });
      }

      return notFound();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** NO_PROXY 的存取，防止本机 HTTP_PROXY 把回环请求改写 */
function mockNoProxy() {
  let savedUpper: string | undefined;
  let savedLower: string | undefined;
  return {
    install() {
      savedUpper = process.env.NO_PROXY;
      savedLower = process.env.no_proxy;
      process.env.NO_PROXY = '127.0.0.1,localhost';
      process.env.no_proxy = '127.0.0.1,localhost';
    },
    restore() {
      if (savedUpper === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedUpper;
      if (savedLower === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = savedLower;
    },
  };
}

describe('Bug 列表本地过滤（离线）', () => {
  let mock: Awaited<ReturnType<typeof startMockZenTao>>;
  let client: ZenTaoClient;
  let cache: LRUCache<string, any>;
  const noProxy = mockNoProxy();

  const silentLogger = () => new Logger(LogLevel.ERROR);
  /** ⚠️ 只匹配全局 `/bugs`；`/products/{id}/bugs` 也以 `/bugs` 结尾，必须排除 */
  const bugRequests = () =>
    mock.requests.filter((r) => r.pathname.endsWith('/bugs') && !r.pathname.includes('/products/'));
  const productBugRequests = () => mock.requests.filter((r) => /\/products\/\d+\/bugs$/.test(r.pathname));

  beforeAll(async () => {
    // axios 会读 HTTP_PROXY 把请求丢给代理，打 127.0.0.1 会变成绝对 URI 形式。
    // 显式放行本地地址，让测试只依赖回环。
    noProxy.install();
    mock = await startMockZenTao();
  });

  beforeEach(() => {
    mock.requests.length = 0;
    cache = new LRUCache<string, any>();
    // 每次重建 client，避免复用换好的 Token 与缓存的请求
    client = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );
  });

  afterAll(async () => {
    await mock.close();
    noProxy.restore();
  });

  // ---------- 缺陷 1：browseType 不能再转发给服务端 ----------

  test('browseType=assignedtome 不得出现在任何 Bug 请求里', async () => {
    await listBugs(client, cache, { browseType: 'assignedtome' });

    const all = [...bugRequests(), ...productBugRequests()];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(new URLSearchParams(r.search).get('browseType')).not.toBe('assignedtome');
    }
  });

  test('browseType=unresolved 保留服务端语义', async () => {
    await listBugs(client, cache, { productID: DEFAULT_PRODUCT, browseType: 'unresolved' });

    const last = productBugRequests()[productBugRequests().length - 1];
    expect(new URLSearchParams(last.search).get('browseType')).toBe('unresolved');
  });

  // ---------- 缺陷 2：本地过滤必须覆盖全量 ----------

  test('单产品拉取上限必须 ≥ 该产品 Bug 总量（否则尾部数据被截断）', async () => {
    await listBugs(client, cache, { productID: DEFAULT_PRODUCT, status: 'active' });

    const last = productBugRequests()[productBugRequests().length - 1];
    expect(fetchLimitOf(last.search)).toBeGreaterThanOrEqual(TOTAL);
    expect(MAX_BUG_FETCH).toBeGreaterThanOrEqual(TOTAL);
  });

  test('能捞到排在列表末尾、指派给我的未关闭 Bug（500 截断时代会漏成 0）', async () => {
    const result = await listBugs(client, cache, { productID: DEFAULT_PRODUCT, browseType: 'assignedtome' });

    expect(result.structuredContent.total).toBe(1);
    expect(result.content[0].text).toContain(String(10000 + TOTAL - 4));
  });

  test('按 status 本地过滤时，服务端口径不得先替我们筛一轮', async () => {
    // 若服务端先按 unresolved 筛过，再本地找 active 就会得 0（交集为空）
    const result = await listBugs(client, cache, { productID: DEFAULT_PRODUCT, status: 'active' });

    const last = productBugRequests()[productBugRequests().length - 1];
    expect(new URLSearchParams(last.search).get('browseType')).toBeNull();
    expect(result.structuredContent.total).toBe(6);
  });

  // ---------- 缺陷 3：全局范围必须是「逐产品合并」，不是 /bugs ----------

  test('全局范围不得把 /bugs 当数据源（它只返回单个产品）', async () => {
    await listBugs(client, cache, { status: 'active' });

    // /bugs 只为拿产品字典，应该是一条极小的请求（recPerPage=1）
    const globals = bugRequests();
    expect(globals.length).toBeGreaterThan(0);
    for (const r of globals) {
      expect(fetchLimitOf(r.search)).toBeLessThanOrEqual(1);
    }
    // 真正取数据的必须是逐产品端点
    expect(productBugRequests().length).toBeGreaterThanOrEqual(2);
  });

  test('全局范围能捞到影子产品（/products 列表里没有）下的 Bug', async () => {
    const result = await listBugs(client, cache, { status: 'active' });

    expect(result.structuredContent.total).toBe(ALL_OPEN);
    expect(result.content[0].text).toContain(String(SHADOW_BUG_ID));
    expect(result.structuredContent.productScanned).toBeGreaterThanOrEqual(3);
    expect(result.structuredContent.shadowProductScanned).toBe(1);
  });

  test('全局范围的说明文案要点明「没有全库接口」与影子产品', async () => {
    const result = await listBugs(client, cache, { status: 'active' });

    expect(result.content[0].text).toContain('逐产品合并');
    expect(result.content[0].text).toContain('影子产品');
  });

  test('第二次全局查询走缓存，不再逐产品请求', async () => {
    await listBugs(client, cache, { status: 'active' });
    mock.requests.length = 0;
    await listBugs(client, cache, { status: 'active' });

    expect(productBugRequests()).toHaveLength(0);
  });

  // ---------- 拿不到账号时必须显式失败，不能「不过滤」 ----------

  test('静态 Token 登录（无账号）时用 assignedtome 必须报错，而不是返回全库', async () => {
    const tokenOnly = new ZenTaoClient(
      { baseUrl: mock.baseUrl, token: 'x', timeout: 5000, retry: 0 },
      silentLogger()
    );

    const result = await listBugs(tokenOnly, cache, { browseType: 'assignedtome' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('无法确定');
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('listMyBugs - 我的 Bug（离线）', () => {
  let mock: Awaited<ReturnType<typeof startMockZenTao>>;
  let client: ZenTaoClient;
  let cache: LRUCache<string, any>;
  const noProxy = mockNoProxy();

  const silentLogger = () => new Logger(LogLevel.ERROR);
  const productBugRequests = () => mock.requests.filter((r) => /\/products\/\d+\/bugs$/.test(r.pathname));

  beforeAll(async () => {
    noProxy.install();
    mock = await startMockZenTao();
  });

  beforeEach(() => {
    mock.requests.length = 0;
    cache = new LRUCache<string, any>();
    client = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );
  });

  afterAll(async () => {
    await mock.close();
    noProxy.restore();
  });

  test('默认口径 = 指派给我 + 未关闭，且必须覆盖影子产品里的那条', async () => {
    const result = await listMyBugs(client, cache, {});

    expect(result.structuredContent.account).toBe(ME);
    expect(result.structuredContent.role).toBe('assigned');
    expect(result.structuredContent.total).toBe(MY_ASSIGNED_OPEN);
    // 默认口径走服务端「地盘」快路（选择规则见下面专门的一组用例）
    expect(result.structuredContent.source).toContain('/my/work');
    // 修复前这一条永远看不到（它在 /products 不返回的产品下）
    expect(result.content[0].text).toContain(String(SHADOW_BUG_ID));
  });

  test('单产品查询不触发全库遍历', async () => {
    await listMyBugs(client, cache, { productID: DEFAULT_PRODUCT });

    expect(productBugRequests()).toHaveLength(1);
    expect(productBugRequests()[0].pathname).toContain(`/products/${DEFAULT_PRODUCT}/`);
  });

  test('role=resolved：未关闭口径下只给还没关闭的那些', async () => {
    const result = await listMyBugs(client, cache, { role: 'resolved' });

    // 「地盘」的 resolvedBy tab 会把已关闭的一并给出，本地按未关闭再筛一道
    expect(result.structuredContent.total).toBe(RESOLVED_OPEN);
  });

  test('role=resolved + includeClosed 拿到全部已解决的', async () => {
    const result = await listMyBugs(client, cache, { role: 'resolved', includeClosed: true });

    expect(result.structuredContent.total).toBe(RESOLVED_BY_ME);
  });

  test('role=any 覆盖所有身份字段并去重', async () => {
    const result = await listMyBugs(client, cache, { role: 'any', includeClosed: true });

    // 指派给我(产品9 1 + 影子 1) + 由我解决(76)，三者无交集
    expect(result.structuredContent.total).toBe(MY_ASSIGNED_OPEN + RESOLVED_BY_ME);
  });

  test('status 参数可进一步精确到 active', async () => {
    const result = await listMyBugs(client, cache, { status: 'active' });

    expect(result.structuredContent.total).toBe(MY_ASSIGNED_OPEN);
  });

  test('分页对本地过滤后的结果生效', async () => {
    const result = await listMyBugs(client, cache, {
      role: 'resolved',
      includeClosed: true,
      limit: 10,
      page: 2,
    });

    expect(result.structuredContent.total).toBe(RESOLVED_BY_ME);
    expect(result.structuredContent.pageTotal).toBe(Math.ceil(RESOLVED_BY_ME / 10));
    expect(result.structuredContent.bugs).toHaveLength(10);
  });

  test('pick 只影响 structuredContent，展示文案不受影响', async () => {
    const result = await listMyBugs(client, cache, { pick: 'id' });

    expect(Object.keys(result.structuredContent.bugs[0])).toEqual(['id']);
    // 若展示文案误用「已摘字段」的对象，这里会显示成「未指派」或「未知」。
    // 状态走 utils/labels 的中文渲染（active → 激活），所以断言期望值由它给出，
    // 而不是写死字面量 —— 这个用例守的是「文案用未摘字段渲染」这条不变量。
    expect(result.content[0].text).toContain(`状态: ${bugStatusLabel('active')}`);
    expect(result.content[0].text).not.toContain('未知');
  });

  test('静态 Token 登录（无账号）时必须报错，而不是把全库当「我的」', async () => {
    const tokenOnly = new ZenTaoClient(
      { baseUrl: mock.baseUrl, token: 'x', timeout: 5000, retry: 0 },
      silentLogger()
    );

    const result = await listMyBugs(tokenOnly, cache, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('无法确定');
  });
});

describe('matchRole - 身份判定纯函数', () => {
  test.each([
    ['assigned', 'assignedTo'],
    ['opened', 'openedBy'],
    ['resolved', 'resolvedBy'],
    ['edited', 'lastEditedBy'],
  ] as Array<[MyBugRole, string]>)('role=%s 只认 %s 字段', (role, field) => {
    expect(ROLE_FIELDS[role as Exclude<MyBugRole, 'any'>]).toBe(field);
    expect(matchRole({ [field]: ME }, role, ME)).toBe(true);
    expect(matchRole({ [field]: 'other' }, role, ME)).toBe(false);
    expect(matchRole({}, role, ME)).toBe(false);
  });

  test('role=any 命中任一身份字段', () => {
    for (const field of Object.values(ROLE_FIELDS)) {
      expect(matchRole({ [field]: ME }, 'any', ME)).toBe(true);
    }
    expect(matchRole({ assignedTo: 'a', openedBy: 'b' }, 'any', ME)).toBe(false);
  });

  test('账号为空时一律不命中 —— 防止「不过滤」把全库当自己的', () => {
    expect(matchRole({ assignedTo: ME }, 'assigned', '')).toBe(false);
    expect(matchRole({ assignedTo: ME }, 'any', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * 「地盘」（/my/work）快路。
 *
 * 这是本轮的新发现：v2 **是**支持「我的待处理 Bug」的 ——
 * 网页 `m=my&f=work&mode=bug&type=assignedTo` 背后的接口就是
 * `GET /api.php/v2/my/work?mode=bug&type=assignedTo`（`/my/bugs` 反而 404）。
 *
 * 所以 list_my_bugs 改成优先走它：一次请求、约 1 秒，结果与网页逐条一致；
 * 只有「地盘」覆盖不到的口径才回落到「逐产品合并」。这组用例守的就是**这个选择规则** ——
 * 走错了不会报错，只会慢十倍，或者悄悄少给数据。
 */
describe('「地盘」接口快路（离线）', () => {
  let mock: Awaited<ReturnType<typeof startMockZenTao>>;
  let client: ZenTaoClient;
  let cache: LRUCache<string, any>;
  const noProxy = mockNoProxy();
  const silentLogger = () => new Logger(LogLevel.ERROR);

  const myWorkRequests = () => mock.requests.filter((r) => r.pathname.endsWith('/my/work'));
  const myWorkQuery = (index = 0) => new URLSearchParams(myWorkRequests()[index].search);
  const globalBugRequests = () =>
    mock.requests.filter((r) => r.pathname.endsWith('/bugs') && !r.pathname.includes('/products/'));
  const productListRequests = () => mock.requests.filter((r) => /\/products$/.test(r.pathname));
  const productScopedBugRequests = () =>
    mock.requests.filter((r) => /\/products\/\d+\/bugs$/.test(r.pathname));
  /** 只要碰了产品列表或全局 /bugs，就说明走了「逐产品合并」兜底路径 */
  const usedMergePath = () => productListRequests().length > 0 || globalBugRequests().length > 0;

  beforeAll(async () => {
    noProxy.install();
    mock = await startMockZenTao();
  });

  beforeEach(() => {
    mock.requests.length = 0;
    cache = new LRUCache<string, any>();
    client = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      silentLogger()
    );
  });

  afterAll(async () => {
    await mock.close();
    noProxy.restore();
  });

  test('默认口径走 /my/work 单次请求，且完全不触发全库遍历', async () => {
    const result = await listMyBugs(client, cache, {});

    expect(myWorkRequests().length).toBe(1);
    expect(myWorkQuery().get('mode')).toBe('bug');
    expect(myWorkQuery().get('type')).toBe('assignedTo');
    // 关键：不能再去逐产品扫库，否则「快路」名不副实
    expect(usedMergePath()).toBe(false);
    expect(result.structuredContent.total).toBe(MY_ASSIGNED_OPEN);
    expect(result.structuredContent.source).toContain('/my/work');
  });

  test('快路同样能捞到只存在于影子产品里的那条 Bug', async () => {
    const result = await listMyBugs(client, cache, {});

    expect(result.content[0].text).toContain(String(SHADOW_BUG_ID));
  });

  test('响应里的 ID 字典形态要归一化成数组（别当数组直接下标）', async () => {
    const result = await listMyBugs(client, cache, {});

    const bugs = result.structuredContent.bugs as any[];
    expect(Array.isArray(bugs)).toBe(true);
    expect(bugs.length).toBe(MY_ASSIGNED_OPEN);
    expect(bugs[0]).toHaveProperty('id');
    expect(bugs[0]).toHaveProperty('title');
  });

  test('顶层 recTotal 恒为 0，总数只能取 pager.recTotal', async () => {
    const result = await listMyBugs(client, cache, { role: 'resolved' });

    // 真实总数 130（其中未关闭 3），若误读顶层 recTotal 会变成 0 / 只拉一页
    expect(result.structuredContent.scanned).toBe(MY_WORK.resolvedBy.length);
    expect(result.structuredContent.total).toBe(RESOLVED_OPEN);
  });

  test('数据超过单页时必须翻完所有页（否则静默少给数据）', async () => {
    await listMyBugs(client, cache, { role: 'resolved' });

    const reqs = myWorkRequests();
    const pages = reqs.map((r) => new URLSearchParams(r.search).get('pageID'));
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    expect(pages).toContain('1');
    expect(pages).toContain('2');
    for (const r of reqs) {
      expect(new URLSearchParams(r.search).get('type')).toBe('resolvedBy');
    }
  });

  test('服务端自报的 todoCount 要带出来（可与网页角标交叉验证）', async () => {
    const result = await listMyBugs(client, cache, {});

    expect(result.structuredContent.serverTodoCount).toBe(MY_WORK.assignedTo.length);
  });

  test('结果为空时列出各身份命中数，便于判断「是真没有还是查错了」', async () => {
    const result = await listMyBugs(client, cache, { role: 'opened' });

    expect(result.structuredContent.total).toBe(0);
    const text = result.content[0].text;
    expect(text).toContain('各身份命中');
    expect(text).toContain(`${ROLE_LABELS.assigned} ${MY_ASSIGNED_OPEN}`);
  });

  // ---------- 该回落时必须回落 ----------

  test('role=edited 在「地盘」没有对应 tab，必须回落合并路径', async () => {
    await listMyBugs(client, cache, { role: 'edited' });

    expect(myWorkRequests().length).toBe(0);
    expect(usedMergePath()).toBe(true);
  });

  test('includeClosed=true 必须回落 —— assignedTo tab 本身只给未关闭，拿不到已关闭的', async () => {
    await listMyBugs(client, cache, { includeClosed: true });

    expect(myWorkRequests().length).toBe(0);
    expect(usedMergePath()).toBe(true);
  });

  test('指定 productID 时回落（快路不支持产品维度）', async () => {
    await listMyBugs(client, cache, { productID: DEFAULT_PRODUCT });

    expect(myWorkRequests().length).toBe(0);
    expect(productScopedBugRequests().length).toBeGreaterThan(0);
  });

  test('role=any 覆盖四种身份，只能回落', async () => {
    await listMyBugs(client, cache, { role: 'any' });

    expect(myWorkRequests().length).toBe(0);
    expect(usedMergePath()).toBe(true);
  });
});

/**
 * 老版本禅道没有 `/my/work`（返回 404）。
 * 这时必须安静回落到合并路径并给出正确答案 —— 而不是抛错或返回空。
 */
describe('「地盘」接口不可用时的回落（离线）', () => {
  let mock: Awaited<ReturnType<typeof startMockZenTao>>;
  let client: ZenTaoClient;
  let cache: LRUCache<string, any>;
  const noProxy = mockNoProxy();

  beforeAll(async () => {
    noProxy.install();
    mock = await startMockZenTao({ myWork: false });
  });

  beforeEach(() => {
    mock.requests.length = 0;
    cache = new LRUCache<string, any>();
    client = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      new Logger(LogLevel.ERROR)
    );
  });

  afterAll(async () => {
    await mock.close();
    noProxy.restore();
  });

  test('/my/work 404 时回落到合并路径，结果依然正确', async () => {
    const result = await listMyBugs(client, cache, {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.total).toBe(MY_ASSIGNED_OPEN);
    expect(result.structuredContent.source).not.toContain('/my/work');
    // 走的是合并路径，所以必须带上产品扫描信息
    expect(result.structuredContent.productScanned).toBeGreaterThan(0);
  });

  test('命中过但全部已关闭时，文案要解释这个 0（并提示 includeClosed）', async () => {
    const result = await listMyBugs(client, cache, { role: 'resolved' });

    // 合并路径下这些 Bug 全是已关闭的，未关闭口径应得 0 —— 而且要能说明白为什么
    expect(result.structuredContent.total).toBe(0);
    expect(result.content[0].text).toContain('includeClosed');
    expect(result.content[0].text).toContain('各身份命中');
  });
});

