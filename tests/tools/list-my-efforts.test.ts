/**
 * 地盘-日志（工时）—— 离线用例（**不碰真实禅道**）
 *
 * 为什么能离线：`listMyEfforts` 只用到 client 的三个成员
 * （`currentAccount` / `paginationParams` / `get`），注入一个假的就够了。
 *
 * 覆盖三块：
 *   ① 日期口径 —— 单日（紧凑与带横杠两种写法）、区间、区间颠倒；
 *   ② 本地过滤与汇总 —— keyword 只搜 work、按日/按月合计、orderBy 方向；
 *   ③ ⚠️ **安全回归** —— 服务端响应里那个 `user` 对象带 `password` 哈希与 `resetToken`，
 *      工具必须只吐 `efforts`，绝不能把 user 透进 `structuredContent`。
 */

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';
import { listMyEfforts } from '../../src/tools/getMyEfforts';

/** 一条日志的原始形态（字段名与真实接口一致） */
function rawEffort(over: Record<string, any> = {}) {
  return {
    id: 1,
    objectType: 'custom',
    objectID: 0,
    product: ',0,',
    project: 0,
    execution: 0,
    account: 'your-account',
    work: '随便写点',
    vision: 'rnd',
    date: '2026-09-17',
    left: 0,
    consumed: 8,
    dept: 17,
    ...over,
  };
}

const SAMPLE = [
  rawEffort({ id: 101, date: '2026-09-15', work: '储能-需求评审', consumed: 4 }),
  rawEffort({ id: 102, date: '2026-09-17', work: '技经-补单元测试', consumed: 1 }),
  rawEffort({ id: 103, date: '2026-09-17', work: '储能-补e2e测试', consumed: 3 }),
  rawEffort({ id: 104, date: '2026-10-08', work: '请假', consumed: 8, left: 2 }),
];

interface FakeOpts {
  /** 覆盖 pager.recTotal（模拟「服务端总数 > 本页条数」） */
  recTotal?: number;
  rows?: any[];
}

/** 造一个假 client：返回固定列表，并故意夹带一个带 password 的 user 对象 */
function fakeClient(opts: FakeOpts = {}): ZenTaoClient {
  const rows = opts.rows ?? SAMPLE;
  return {
    currentAccount: 'your-account',
    paginationParams: (page?: number, limit?: number) => {
      const out: Record<string, number> = {};
      if (page != null) out.pageID = page;
      if (limit != null) out.recPerPage = limit;
      return out;
    },
    get: jest.fn().mockResolvedValue({
      title: '地盘-我的日志',
      status: 'success',
      efforts: rows,
      // ⚠️ 真实响应里就有这个（见 src/tools/getMyEfforts.ts 文件头第 8 条），
      // 用它来验证工具不会把它带出去
      user: {
        id: 182,
        account: 'your-account',
        password: 'd37c75c34b619332d3fd6317bc37aeff',
        resetToken: 'deadbeef',
        ip: '10.200.58.100',
      },
      pager: { recTotal: opts.recTotal ?? rows.length, recPerPage: 1000, pageID: 1, pageTotal: 1 },
    }),
  } as unknown as ZenTaoClient;
}

function textOf(result: any): string {
  return result?.content?.[0]?.text ?? '';
}

describe('listMyEfforts（离线）', () => {
  let cache: LRUCache<string, any>;

  beforeEach(() => {
    cache = new LRUCache<string, any>({ maxSize: 10, defaultTtl: 1000, enableStats: false });
  });

  // ───────── ① 日期口径 ─────────

  it('不传日期时返回服务端全量，并算出总工时', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { type: 'all' });
    const sc: any = r.structuredContent;
    expect(r.isError).toBeFalsy();
    expect(sc.total).toBe(4);
    expect(sc.hoursTotal).toBe(16); // 4 + 1 + 3 + 8
    expect(sc.rangeMode).toBe('server-type');
    expect(sc.date).toBe('');
  });

  it('date 支持紧凑写法 20260917，只留当天', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '20260917' });
    const sc: any = r.structuredContent;
    expect(sc.total).toBe(2);
    expect(sc.date).toBe('2026-09-17');
    expect(sc.begin).toBe('2026-09-17');
    expect(sc.end).toBe('2026-09-17');
    expect(sc.rangeMode).toBe('local');
    expect(sc.hoursTotal).toBe(4); // 1 + 3
    expect(sc.items.every((i: any) => i.date === '2026-09-17')).toBe(true);
  });

  it('date 也接受带横杠的 2026-09-17', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '2026-09-17' });
    expect((r.structuredContent as any).total).toBe(2);
  });

  it('begin/end 区间按闭区间过滤', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { begin: '20260916', end: '20260930' });
    const sc: any = r.structuredContent;
    expect(sc.total).toBe(2);
    expect(sc.begin).toBe('2026-09-16');
    expect(sc.end).toBe('2026-09-30');
    expect(sc.byMonth).toEqual({ '2026-09': 4 });
  });

  it('只给 begin 或只给 end 也能用（单边区间）', async () => {
    const after = await listMyEfforts(fakeClient(), cache, { begin: '2026-09-17' });
    expect((after.structuredContent as any).total).toBe(3);
    const before = await listMyEfforts(fakeClient(), cache, { begin: '2026-09-01', end: '2026-09-16' });
    expect((before.structuredContent as any).total).toBe(1);
  });

  it('区间颠倒要报错，而不是悄悄返回空', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { begin: '2026-10-01', end: '2026-09-01' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('晚于截止日期');
  });

  // ───────── ② 校验 ─────────

  it('日期格式不认识时给出可照抄的格式说明', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '2026年10月15' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('20261015');
  });

  it('20260231 这种「格式对但日子不存在」要被拦下', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '20260231' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('不是有效日期');
  });

  it('date 与 begin/end 互斥', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '20261015', begin: '20260901' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('互斥');
  });

  it('不支持的 type 直接拦下（服务端只会静默回 0，容易误判成「没有数据」）', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { type: 'lastyear' as any });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('不支持的 type');
  });

  // ───────── ③ 本地过滤与汇总 ─────────

  it('keyword 只在「工作内容」上匹配', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { keyword: '储能' });
    const sc: any = r.structuredContent;
    expect(sc.total).toBe(2);
    expect(sc.items.map((i: any) => i.work).sort()).toEqual(['储能-补e2e测试', '储能-需求评审']);
  });

  it('orderBy=date_asc 时首条是最早那条', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { orderBy: 'date_asc', limit: 1 });
    expect((r.structuredContent as any).items[0].date).toBe('2026-09-15');
  });

  it('默认 date_desc 时首条是最新那条', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { limit: 1 });
    expect((r.structuredContent as any).items[0].date).toBe('2026-10-08');
  });

  it('汇总给出按日与按月的工时合计，left 另行统计', async () => {
    const r = await listMyEfforts(fakeClient(), cache, {});
    const sc: any = r.structuredContent;
    expect(sc.byDate).toEqual({ '2026-09-15': 4, '2026-09-17': 4, '2026-10-08': 8 });
    expect(sc.byMonth).toEqual({ '2026-09': 8, '2026-10': 8 });
    expect(sc.leftTotal).toBe(2);
    expect(sc.days).toBe(3);
  });

  it('summary=false 时不返回汇总映射', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { summary: false });
    const sc: any = r.structuredContent;
    expect(sc.byDate).toBeUndefined();
    expect(sc.byMonth).toBeUndefined();
    // 但总工时仍然算得出来
    expect(sc.hoursTotal).toBe(16);
  });

  it('服务端返回 0 条时提示「也可能是不支持的 type」，避免误判', async () => {
    const r = await listMyEfforts(fakeClient({ rows: [] }), cache, { type: 'thismonth' });
    const text = textOf(r);
    expect(text).toContain('没有符合条件的工时日志');
    expect(text).toContain('两种可能');
  });

  it('本土过滤后为空时，说明服务端原本返回了多少条', async () => {
    const r = await listMyEfforts(fakeClient(), cache, { date: '2030-01-01' });
    const sc: any = r.structuredContent;
    expect(sc.total).toBe(0);
    expect(sc.scanned).toBe(4);
    expect(textOf(r)).toContain('本地过滤后剩 0 条');
  });

  it('pager.recTotal 与列表长度不一致时，scanned 用实际拿到的条数', async () => {
    const r = await listMyEfforts(fakeClient({ recTotal: 938 }), cache, {});
    const sc: any = r.structuredContent;
    expect(sc.total).toBe(4);
    expect(sc.scanned).toBe(4);
    expect(sc.serverRecTotal).toBe(938);
  });

  // ───────── ④ 安全回归 ─────────

  it('⚠️ 不得把响应里内嵌的 user 对象（含 password 哈希）透进 structuredContent', async () => {
    const r = await listMyEfforts(fakeClient(), cache, {});
    const dumped = JSON.stringify(r.structuredContent);
    expect(dumped).not.toContain('password');
    expect(dumped).not.toContain('d37c75c34b619332d3fd6317bc37aeff');
    expect(dumped).not.toContain('resetToken');
    // 顶层也不该冒出 user 键
    expect((r.structuredContent as any).user).toBeUndefined();
    // 文本输出同样不能带哈希
    expect(textOf(r)).not.toContain('d37c75c34b619332d3fd6317bc37aeff');
  });
});
