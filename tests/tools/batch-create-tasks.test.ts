/**
 * 批量创建任务 —— 离线用例（**不碰真实禅道**）
 *
 * 为什么能离线：`batchCreateTasks` 的契约是
 *   · 入参校验失败 → `{ isError: true, content: [text] }`
 *   · 跑起来之后   → `{ content: [text], structuredContent: { total, successful, failed, duration, errors } }`
 *
 * 所以这里注入一个「POST 必定失败」的假 client：校验分支、分批并发、
 * 错误聚合、continueOnError 提前中断、reportMode=detailed 的文案
 * 全都能覆盖，却不会在禅道上留下任何脏数据。
 *
 * （旧版本用的是裸全局 `batchCreateTasks` / `createBatchTaskData` / `cleanupTask`，
 *   既没有 import 也真的往禅道里写任务 —— 已废弃。）
 */

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';
import { batchCreateTasks } from '../../src/tools/batchCreateTasks';

/** 造一个 POST 永远失败的假 client：走完整个批处理管线，但不产生任何写入 */
function failingClient(message = 'mock: 拒绝真实写入'): ZenTaoClient {
  return {
    post: jest.fn().mockRejectedValue(new Error(message)),
  } as unknown as ZenTaoClient;
}

describe('batchCreateTasks（离线）', () => {
  let cache: LRUCache<string, any>;

  beforeEach(() => {
    cache = new LRUCache<string, any>();
  });

  test('空列表直接拒绝', async () => {
    const result = await batchCreateTasks(failingClient(), cache, []);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('不能为空');
  });

  test('顶层没给 executionID、item 里也没写 → 提前拒绝而不是逐条去撞 404', async () => {
    const client = failingClient();
    const result = await batchCreateTasks(client, cache, [{ name: 'A' }, { name: 'B' }]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('没有指定归属执行');
    // 关键：校验必须发生在发请求**之前**
    expect((client.post as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('顶层 executionID 可作统一默认值，逐条失败也要如实聚合', async () => {
    // ⚠️ 必须显式传 continueOnError: true。
    // 它的默认值是在 MCP 层的 zod schema（BatchCreateTasksShape.options）里补的，
    // **函数级**直接调用时省略即为 falsy → 首批失败就 break。
    const result = await batchCreateTasks(
      failingClient(),
      cache,
      [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      { maxConcurrency: 2, continueOnError: true },
      999999
    );

    expect(result.isError).toBeFalsy();
    const sc: any = result.structuredContent;
    expect(sc.total).toBe(3);
    expect(sc.successful).toBe(0);
    expect(sc.failed).toBe(3);
    // 错误里必须带可定位的 index，否则 N 条任务失败了也不知道是哪几条
    expect(sc.errors).toHaveLength(3);
    expect(sc.errors.map((e: any) => e.index).sort()).toEqual([0, 1, 2]);
  });

  test('continueOnError=false 时首批失败后不再继续', async () => {
    const client = failingClient();
    const result = await batchCreateTasks(
      client,
      cache,
      [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      { maxConcurrency: 1, continueOnError: false },
      999999
    );

    // 只尝试了第一条就跳出
    expect((client.post as jest.Mock).mock.calls).toHaveLength(1);
    const sc: any = result.structuredContent;
    expect(sc.successful + sc.failed).toBe(1);
    expect(sc.total).toBe(3);
  });

  test('reportMode=detailed 会逐条列出成功/失败', async () => {
    const result = await batchCreateTasks(
      failingClient('boom'),
      cache,
      [{ name: '甲' }],
      { reportMode: 'detailed' },
      999999
    );

    const text = result.content[0].text;
    expect(text).toContain('详细结果');
    expect(text).toContain('甲');
    expect(text).toContain('boom');
  });

  test('batch_create_tasks 工具的 outputSchema 与实测返回键一致', async () => {
    const result = await batchCreateTasks(failingClient(), cache, [{ name: 'A' }], {}, 999999);

    // 与 src/tools/index.ts 的 BatchResultOutputShape 对齐：
    // 漏一个键，真客户端一调就被 ajv 判 InvalidParams
    expect(Object.keys(result.structuredContent || {}).sort()).toEqual(
      ['duration', 'errors', 'failed', 'successful', 'total'].sort()
    );
  });
});
