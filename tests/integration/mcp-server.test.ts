/**
 * MCP 服务器集成测试 —— 真客户端（stdio）+ 只读
 *
 * P1 收敛后重写过。旧版本的问题：
 *   1. 它 spawn 了**两个**服务进程（一个用来等「已启动」，一个交给 transport），
 *      前者没有被 kill，测试跑完会留下孤儿进程；
 *   2. 等启动的判据是「**stdout** 出现『MCP 服务器已启动』」—— 但本项目在 stdio
 *      模式下日志一律走 **stderr**（stdout 必须留给 JSON-RPC），所以这个条件
 *      永远不成立 → 10 秒超时 → beforeAll 抛错 → 整个套件 failed to run；
 *   3. 断言的工具名（zendao_list_projects / create_project / ...）已在 P1 收敛中删除。
 *
 * 现在只做三件事：**连接 → 断言工具集 → 调用只读工具**。
 * 不创建、不修改、不删除任何禅道数据；连不上禅道时只跑与网络无关的部分。
 *
 * ⚠️ 前置：先 `npm run build`（本文件测的就是 dist/index.js 这个真实产物）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import fs from 'fs';

/** 保留的 14 个工具 —— 这里就是「工具集不许漂移」的守门人 */
const EXPECTED_TOOLS = [
  'zendao_modules',
  'zendao_help',
  'zendao_call',
  'zendao_list_bugs',
  'zendao_get_bug',
  'zendao_get_bug_attachments',
  'zendao_list_my_bugs',
  'zendao_list_my_work',
  // 2026-10-09 新增：地盘-日志（工时）。官方 CLI 完全没有 effort 模块
  'zendao_list_my_efforts',
  // 2026-11-20 新增：日志**写入**。REST 没有自定义日志通路，走网页表单
  'zendao_fill_efforts',
  'zendao_delete_effort',
  'zendao_get_task',
  'zendao_list_users',
  'zendao_batch_create_tasks',
  // 2026-11-21 新增：从官方 zentao-cli 0.5.0 移植（SDK 0.9.3）
  'zendao_link',
  'zendao_read_attachment',
];

const TEST_TIMEOUT = 30000;
const SERVER_PATH = path.join(process.cwd(), 'dist', 'index.js');

describe('MCP 服务器集成（真客户端 / 只读）', () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let built = false;

  beforeAll(async () => {
    built = fs.existsSync(SERVER_PATH);
    if (!built) {
      console.warn(`⚠️ 未找到构建产物 ${SERVER_PATH} —— 请先 npm run build；本套件将跳过`);
      return;
    }

    // 用真实凭证（.env 已由 tests/setup.ts 加载），否则 zendao_modules 取不到版本
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: { ...process.env } as Record<string, string>,
    });

    client = new Client({ name: 'zendao-mcp-integration-test', version: '1.0.0' });
    await client.connect(transport);
    console.log('✅ MCP 服务器连接成功（stdio）');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // StdioClientTransport.close() 会终止它自己 spawn 的子进程，
    // 所以这里不需要（也不应该）再手动 spawn / kill 一个
    try {
      await client?.close();
    } catch {
      /* 关闭失败不影响结论 */
    }
    try {
      await transport?.close();
    } catch {
      /* 同上 */
    }
  }, TEST_TIMEOUT);

  const ready = (): boolean => {
    if (!built) return false;
    if (!client) {
      console.warn('⚠️ 客户端未就绪，跳过');
      return false;
    }
    return true;
  };

  it('tools/list 恰好给出保留的 16 个工具，且都带描述', async () => {
    if (!ready()) return;

    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([...EXPECTED_TOOLS].sort());

    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description!.length).toBeGreaterThan(0);
      // 每个工具都必须声明 inputSchema，否则模型没法知道怎么调
      expect(tool.inputSchema).toBeDefined();
    }

    // 手写工具才有 outputSchema：通用层是「全字段 z.any().optional()」的并集形状
    const withOutput = tools.filter((t) => (t as any).outputSchema).map((t) => t.name);
    for (const name of [
      'zendao_list_bugs',
      'zendao_get_bug',
      'zendao_list_my_work',
      'zendao_get_task',
      'zendao_list_users',
      'zendao_batch_create_tasks',
    ]) {
      expect(withOutput).toContain(name);
    }

    console.log('✅ 工具集正确：', names.join(', '));
  }, TEST_TIMEOUT);

  it('zendao_modules 可调用，返回注册表规模（纯本地，不需要业务数据）', async () => {
    if (!ready() || !global.testZendaoReachable) {
      console.warn('⚠️ 禅道不可达，跳过 zendao_modules 调用');
      return;
    }

    const result = await client!.callTool({ name: 'zendao_modules', arguments: {} });
    expect(result.isError).toBeFalsy();
    const sc: any = (result as any).structuredContent;
    expect(sc.actionTotal).toBeGreaterThan(0);
    expect(Array.isArray(sc.modules)).toBe(true);

    // 文本块是给人/模型看的，必须有内容
    const text = (result.content as any[]).find((c) => c.type === 'text');
    expect(text?.text).toBeTruthy();
    console.log(`✅ zendao_modules：${sc.actionTotal} 个动作，${sc.modules.length} 个模块`);
  }, TEST_TIMEOUT);

  it('zendao_help 给出动作契约（路由 + 参数）', async () => {
    if (!ready() || !global.testZendaoReachable) {
      console.warn('⚠️ 禅道不可达，跳过 zendao_help 调用');
      return;
    }

    const result = await client!.callTool({
      name: 'zendao_help',
      arguments: { module: 'bug', action: 'list' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any[]).map((c) => c.text).join('\n');
    expect(text).toMatch(/HTTP/i);
    expect(text).toMatch(/\/bugs/);
    console.log('✅ zendao_help：动作契约可读');
  }, TEST_TIMEOUT);

  it('非法参数被 inputSchema 拦下', async () => {
    if (!ready()) return;

    // zendao_list_my_work 的 mode 是必填枚举；给个不在枚举里的值
    await expect(
      client!.callTool({ name: 'zendao_list_my_work', arguments: { mode: 'not-a-mode' } })
    ).rejects.toThrow();
  }, TEST_TIMEOUT);

  it('不存在的工具名被拒绝', async () => {
    if (!ready()) return;

    await expect(
      client!.callTool({ name: 'zendao_this_tool_does_not_exist', arguments: {} })
    ).rejects.toThrow();
  }, TEST_TIMEOUT);

  it('并发调用同一工具不会互相污染（5 路）', async () => {
    if (!ready() || !global.testZendaoReachable) {
      console.warn('⚠️ 禅道不可达，跳过并发调用');
      return;
    }

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        client!.callTool({ name: 'zendao_modules', arguments: {} })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(5);
    for (const r of fulfilled as PromiseFulfilledResult<any>[]) {
      expect((r.value as any).structuredContent.actionTotal).toBeGreaterThan(0);
    }
    console.log('✅ 5 路并发调用全部成功');
  }, TEST_TIMEOUT);
});

/** 项目结构完整性（与网络无关，纯本地文件检查） */
describe('MCP 服务器完整性检查', () => {
  it('具备必要的项目结构文件', () => {
    for (const file of [
      'package.json',
      'tsconfig.json',
      'src/index.ts',
      'src/client.ts',
      'src/tools/index.ts',
      'src/utils/logger.ts',
      'src/utils/cache.ts',
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(true);
    }
  });
});
