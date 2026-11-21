/**
 * 「某个项目的最新迭代（执行）」推断
 *
 * 禅道里「迭代」在数据上就是**执行（execution）**。日志要挂到正确迭代上，
 * 就得知道「这个项目当前在跑哪个迭代」。
 *
 * ## 为什么要本地筛，不能直接传参
 *
 * `GET /api.php/v2/executions?project=2000546` 的 `project` 参数**被服务端忽略** ——
 * 实测传进去仍返回横跨 10 个项目的 50 条记录。所以只能：
 *
 *   1. 拉全量（`recPerPage` 开大）
 *   2. 本地按 `project` 过滤
 *   3. `status === 'doing'` 优先，同状态取 `begin` 最大的那条
 *
 * 「doing + begin 最大」这个口径对应网页上「项目 → 执行 → 进行中的那个」，
 * 也符合直觉：正在进行的迭代里，开始时间最晚的就是最新的一轮。
 */

import { ZenTaoClient } from '../client';
import { extractList, extractOne } from './response';

export interface ExecutionBrief {
  id: number;
  name: string;
  project?: number;
  status?: string;
  begin?: string;
  end?: string;
}

/** 拉全量执行列表（服务端忽略 project 过滤，见文件头） */
async function fetchAllExecutions(client: ZenTaoClient): Promise<ExecutionBrief[]> {
  const res = await client.get<any>('/executions', {
    recPerPage: 1000,
    pageID: 1,
    orderBy: 'id_desc',
  });
  const { list } = extractList<any>(res, 'executions', 1000);
  return list
    .filter((e) => e && e.id)
    .map((e) => ({
      id: Number(e.id),
      name: String(e.name ?? ''),
      project: e.project != null ? Number(e.project) : undefined,
      status: e.status != null ? String(e.status) : undefined,
      begin: e.begin != null ? String(e.begin) : undefined,
      end: e.end != null ? String(e.end) : undefined,
    }));
}

/** 在给定执行里挑「最新」的那条：doing 优先，其次 begin 最大，再次 id 最大 */
function pickLatest(list: ExecutionBrief[]): ExecutionBrief | null {
  if (!list.length) return null;
  const score = (e: ExecutionBrief) => [
    e.status === 'doing' ? 1 : 0,
    e.begin || '',
    e.id,
  ] as const;
  return list.slice().sort((a, b) => {
    const [sa, ba, ia] = score(a);
    const [sb, bb, ib] = score(b);
    if (sa !== sb) return sb - sa;
    if (ba !== bb) return bb.localeCompare(ba);
    return ib - ia;
  })[0];
}

/**
 * 推断某项目当前最新的迭代。
 *
 * @param projectID 项目 ID
 * @returns 命中的执行；该项目没有任何执行时返回 `null`
 */
export async function resolveLatestExecution(
  client: ZenTaoClient,
  projectID: number
): Promise<ExecutionBrief | null> {
  const all = await fetchAllExecutions(client);
  const mine = all.filter((e) => Number(e.project) === Number(projectID));
  return pickLatest(mine);
}

/**
 * 从任务 / Bug 反查它所属的「执行 + 项目」。
 *
 * 日志挂在任务上时，最省事的做法是直接沿用任务自己的执行 ——
 * 那本来就是它所在的迭代，不需要再猜。
 */
export async function resolveObjectContext(
  client: ZenTaoClient,
  objectType: string,
  objectID: number
): Promise<{ executionID?: number; projectID?: number; title?: string; left?: number }> {
  const type = objectType.toLowerCase();

  const endpoint =
    type === 'task' ? `/tasks/${objectID}`
    : type === 'bug' ? `/bugs/${objectID}`
    : type === 'story' ? `/stories/${objectID}`
    : '';

  if (!endpoint) return {};

  try {
    const res = await client.get<any>(endpoint);
    const obj = extractOne<any>(res, type === 'task' ? 'task' : type === 'bug' ? 'bug' : 'story') || {};
    const executionID = obj.execution != null ? Number(obj.execution) : undefined;
    const projectID = obj.project != null ? Number(obj.project) : undefined;
    const title = obj.title || obj.name || undefined;
    // left = 当前剩余工时。挂任务写日志时**必须**带上递减后的 left，缺失会被服务端拒（见 fillEfforts）
    const left = obj.left != null && obj.left !== '' ? Number(obj.left) : undefined;
    return {
      executionID: Number.isFinite(executionID) ? executionID : undefined,
      projectID: Number.isFinite(projectID) ? projectID : undefined,
      title,
      left: Number.isFinite(left as number) ? (left as number) : undefined,
    };
  } catch {
    // 反查失败不该阻断写日志 —— 执行留空禅道也接受
    return {};
  }
}
