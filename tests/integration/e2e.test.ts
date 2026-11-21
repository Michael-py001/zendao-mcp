/**
 * 端到端（只读）—— 打通「通用层 → 领域工具」的完整数据流
 *
 * 这个文件在 P1 收敛后重写过。原来的版本建在 getProjects / createProject /
 * createTask / updateTaskStatus / getProjectById / getTasks 六个**已删除**的工具上，
 * 而且用的是裸全局（连 import 都没有），还会真的往禅道里建项目、建任务。
 *
 * 现在只做三件事：
 *   1. **只读** —— 不创建、不修改、不删除任何禅道数据；
 *   2. 走**保留的工具**（zendao_modules / help / call + 8 个手写工具）；
 *   3. 验证的是**跨工具的数据流**（通用层拿到的 ID 能喂给领域工具），
 *      而不是单个工具的返回值形状 —— 后者由 verify-tools-live + 各离线用例守。
 *
 * 连不上禅道时整组跳过（不伪装成通过，也不把环境问题当代码问题）。
 */

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';

import { listSdkModules } from '../../src/tools/sdkModules';
import { getSdkActionHelp } from '../../src/tools/sdkHelp';
import { callSdkAction } from '../../src/tools/sdkCall';
import { listBugs, getBug } from '../../src/tools/getBugs';
import { listMyBugs } from '../../src/tools/getMyBugs';
import { listMyWork } from '../../src/tools/getMyWork';
import { getTask } from '../../src/tools/getTask';
import { listUsers } from '../../src/tools/getUsers';
import { getBugAttachments } from '../../src/tools/getBugAttachments';

/** 统一的「没环境就跳过」判定 */
function skipIfOffline(): boolean {
  if (!global.testZendaoReachable) {
    console.log('⏭️ 禅道不可达，跳过只读端到端用例');
    return true;
  }
  return false;
}

function client(): ZenTaoClient {
  return global.testClient;
}
function cache(): LRUCache<string, any> {
  return global.testCache;
}

/**
 * 断言工具调用没失败，**失败时把工具自己的文案带出来**。
 * 直接写 `expect(r.isError).toBeFalsy()` 的话，报错只有一句 `Received: true`，
 * 完全看不出是 404、403 还是认证问题 —— 这个版本 jest 的 expect 又不接受第二个参数。
 */
function expectOk(result: any, label: string): void {
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? '(工具未返回文案)';
    throw new Error(`${label} 调用失败：\n${text}`);
  }
}

describe('端到端（只读）：通用层与领域工具的数据流', () => {
  beforeEach(() => {
    global.testCache.clear();
  });

  test('zendao_modules 自描述 → zendao_help 给出动作契约', async () => {
    if (skipIfOffline()) return;

    const mods = await listSdkModules(client(), cache(), {});
    expectOk(mods, 'mods');
    const msc: any = mods.structuredContent;
    expect(msc.actionTotal).toBeGreaterThan(0);
    expect(Array.isArray(msc.modules)).toBe(true);

    const help = await getSdkActionHelp(client(), cache(), { module: 'bug', action: 'list' });
    expectOk(help, 'help');
    const text = help.content[0].text;
    expect(text).toContain('HTTP');
    // 动作定义里必须能看到路由，否则模型没法自查参数
    expect(text).toMatch(/\/bugs/);
    console.log(`✅ 注册表 ${msc.actionTotal} 个动作；bug/list 契约可读`);
  });

  test('通用层拿到的产品 ID 能直接喂给 bug 相关工具（跨工具串联）', async () => {
    if (skipIfOffline()) return;

    // 1) 通用层：product/list
    const products = await callSdkAction(client(), cache(), {
      module: 'product',
      action: 'list',
      recPerPage: 20,
    });
    expectOk(products, 'products');
    const psc: any = products.structuredContent;
    expect(psc.status).toBe('success');
    expect(Array.isArray(psc.data)).toBe(true);
    if (!psc.data.length) {
      console.log('⏭️ 该实例没有产品，跳过下游串联');
      return;
    }
    const productID = Number(psc.data[0].id);
    console.log(`✅ product/list 取到产品 ${productID}（${psc.data[0].name}）`);

    // 2) 通用层：bug/list 用同一个 productID
    const sdkBugs = await callSdkAction(client(), cache(), {
      module: 'bug',
      action: 'list',
      params: { productID },
      recPerPage: 3,
    });
    expectOk(sdkBugs, 'sdkBugs');
    const bsc: any = sdkBugs.structuredContent;
    expect(bsc.status).toBe('success');

    // 3) 手写工具：listBugs 同一个 productID
    const bugsResult = await listBugs(client(), cache(), { productID, limit: 3 });
    expectOk(bugsResult, 'bugsResult');
    const bugs: any[] = (bugsResult.structuredContent as any).bugs;
    expect(Array.isArray(bugs)).toBe(true);
    console.log(`✅ listBugs(productID=${productID}) 命中 ${bugs.length} 条`);

    if (!bugs.length) {
      console.log('⏭️ 该产品下没有 Bug，跳过详情串联');
      return;
    }

    // 4) 详情：getBug 用列表里的 id
    const bugID = Number(bugs[0].id);
    const detail = await getBug(client(), cache(), bugID);
    expectOk(detail, 'detail');
    expect((detail.structuredContent as any).bug.id).toBe(bugID);

    // 5) 附件：**不下载**，只验证附件提取这条链路可用（不落盘）
    const attachments = await getBugAttachments(client(), cache(), { bugID, download: false });
    expectOk(attachments, 'attachments');
    const asc: any = attachments.structuredContent;
    expect(asc.bugID).toBe(bugID);
    expect(Array.isArray(asc.attachments)).toBe(true);
    console.log(
      `✅ getBug(${bugID}) 详情可用；附件扫描 ${asc.attachments.length} 个（未下载）`
    );
  });

  test('「我的」线：listMyBugs 与 listMyWork 共用同一批地盘数据', async () => {
    if (skipIfOffline()) return;

    // 拿不到当前账号时必须报错，而不是把全库当「我的」
    const mine = await listMyBugs(client(), cache(), {});
    expectOk(mine, 'mine');
    const msc: any = mine.structuredContent;
    expect(msc.account).toBeTruthy();
    expect(Array.isArray(msc.bugs)).toBe(true);
    console.log(`✅ listMyBugs：账号 ${msc.account}，${msc.total} 条`);

    const work = await listMyWork(client(), cache(), { mode: 'bug', limit: 5 });
    expectOk(work, 'work');
    const wsc: any = work.structuredContent;
    expect(wsc.mode).toBe('bug');
    expect(Array.isArray(wsc.items)).toBe(true);
    console.log(`✅ listMyWork(mode=bug)：${wsc.total} 条`);

    // 同源：两者都走 /my/work，账号口径应当一致
    expect(wsc.account).toBe(msc.account);
  });

  test('任务线：执行 → 任务列表 → 任务详情', async () => {
    if (skipIfOffline()) return;

    // 从「我的任务」里取一个真实的执行 ID（避免写死，换实例也不会挂）
    const work = await listMyWork(client(), cache(), { mode: 'task', limit: 10 });
    expectOk(work, 'work');
    const items: any[] = (work.structuredContent as any).items || [];
    const withExecution = items.find((t) => Number(t.execution) > 0);

    if (!withExecution) {
      console.log('⏭️ 没有带执行归属的任务，跳过任务线下半段');
      return;
    }
    const executionID = Number(withExecution.execution);
    const taskId = Number(withExecution.id);
    console.log(`✅ 从地盘取到任务 ${taskId}（执行 ${executionID}）`);

    // 通用层：task/list 需要 executionID
    const sdkTasks = await callSdkAction(client(), cache(), {
      module: 'task',
      action: 'list',
      params: { executionID },
      recPerPage: 2,
    });
    expectOk(sdkTasks, 'sdkTasks');
    expect((sdkTasks.structuredContent as any).status).toBe('success');

    // 手写工具：getTask 详情
    const detail = await getTask(client(), cache(), taskId);
    expectOk(detail, 'detail');
    expect((detail.structuredContent as any).task.id).toBe(taskId);
    console.log(`✅ getTask(${taskId}) 详情可用`);
  });

  test('人员字典：/users 可能 404，但账号↔人名映射必须拿得到', async () => {
    if (skipIfOffline()) return;

    const users = await listUsers(client(), cache(), { limit: 5 });
    expectOk(users, 'users');
    const usc: any = users.structuredContent;
    expect(usc.total).toBeGreaterThan(0);
    expect(usc.users).toHaveLength(5);
    // 每条都要有账号，否则映射没意义
    for (const u of usc.users) {
      expect(String(u.account || '')).not.toBe('');
    }
    console.log(`✅ 账号字典 ${usc.total} 人（本页 ${usc.users.length}）`);
  });
});
