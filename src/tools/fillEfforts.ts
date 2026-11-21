/**
 * 工具实现：`zendao_fill_efforts` —— 批量填写禅道日志（工时）
 *
 * ## 为什么要单独做这个工具
 *
 * 禅道写工时有三条互不相通的路：
 *
 * | 形态 | 通路 | 能力 |
 * | --- | --- | --- |
 * | 挂**任务** | REST `POST api.php/v1/tasks/{id}/estimate` | ✅ 但只能挂任务 |
 * | **自定义**日志（不挂对象） | 只有网页表单 | ✅ 原文件的习惯就是这个 |
 * | 编辑 / 删除 | 只有网页 | ✅ |
 *
 * 主人现有的日志全是 `objectType=custom`（不挂任务），所以只走 REST 是填不了的。
 * 本工具改走网页表单（见 `src/web/effort.ts`），把自定义日志也做成了纯接口。
 *
 * ## 安全设计：默认只预览
 *
 * 禅道**没有**日志的编辑回滚能力（网页能删，但写完立刻删是唯一收尾手段），
 * 而写错的日志会进考勤统计。所以：
 *
 * - `dryRun` 默认 `true`：只解析、只校验、只列出将要写什么
 * - 真写要显式 `dryRun: false`
 * - 真写后自动**回查一遍**，把落库的日志 ID 带回来（下次要用 `zendao_delete_effort` 得靠它）
 */

import { z } from 'zod';
import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { extractList } from '../utils/response';
import { resolveLatestExecution, resolveObjectContext } from '../utils/latestExecution';
import { ZenTaoWebSession } from '../web/session';
import { fillEfforts, EffortInput, deleteEffort } from '../web/effort';

/** 单条日志的入参形状（裸字典，供工具 schema 复用） */
export const EffortItemShape = {
  date: z.string().describe('日期，格式 `YYYY-MM-DD`'),
  work: z.string().min(1).max(200).describe('工作内容（日志标题），也就是日志列表里那行文字'),
  consumed: z.number().positive().describe('耗时（小时），如 2 或 0.5'),
  objectType: z
    .string()
    .optional()
    .describe('对象类型：`custom`（默认，不挂对象）/ `task` / `bug` / `story`'),
  objectID: z.number().int().positive().optional().describe('对象 ID，objectType 非 custom 时必填'),
  executionID: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('执行（迭代）ID；不填则按 autoExecution 自动推断'),
  projectID: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('项目 ID；用于「自动取该项目最新迭代」。可从 `zendao_call { module: "project", action: "list" }` 获得'),
  left: z.number().min(0).optional().describe('剩余工时；自定义日志通常留空'),
};

const EffortItemSchema = z.object(EffortItemShape);

/** 网页会话按 client 实例缓存，避免每次工具调用都重新登录 */
const sessionCache = new WeakMap<ZenTaoClient, ZenTaoWebSession>();

export function getWebSession(client: ZenTaoClient): ZenTaoWebSession {
  const cached = sessionCache.get(client);
  if (cached) return cached;
  const creds = client.webCredentials;
  const session = new ZenTaoWebSession(client.siteBaseUrl, creds.account, creds.password);
  sessionCache.set(client, session);
  return session;
}

export interface FillEffortsArgs {
  items: z.infer<typeof EffortItemSchema>[];
  dryRun?: boolean;
  autoExecution?: boolean;
}

/** 解析后的单条计划（含迭代推断结果与来源） */
interface PlannedItem extends EffortInput {
  executionSource?: string;
  objectTitle?: string;
  /** 自动算出 left 时的备注（如「读不到剩余工时」） */
  leftNote?: string;
}

/** 读某天已有的日志（用于防重复 + 写入后回查） */
async function readEffortsByDate(client: ZenTaoClient, date: string): Promise<any[]> {
  try {
    const res = await client.get<any>('/my/effort', {
      type: 'all',
      recPerPage: 500,
      orderBy: 'date_desc',
    });
    const { list } = extractList<any>(res, 'efforts', 500);
    return list.filter((e) => String(e.date) === date);
  } catch {
    return [];
  }
}

/**
 * 为每一条日志补全 `executionID`。
 *
 * 优先级（也是「自动填最新迭代」的全部逻辑）：
 *   1. 调用方显式给的 `executionID`
 *   2. 对象自身的执行 —— 任务/Bug 本来就在某个迭代里，直接沿用最准
 *   3. 显式 `projectID` → 该项目 `status=doing` 且 `begin` 最大的执行
 *   4. 对象反查到的 `project` → 同上
 *   5. 都拿不到 → 留空（禅道接受「日志不挂迭代」）
 *
 * 顺带把对象的**当前剩余工时**（`left`）带出来 —— 挂任务写日志时必填，见 `planLeft`。
 */
async function planExecution(
  client: ZenTaoClient,
  item: z.infer<typeof EffortItemSchema>,
  autoExecution: boolean
): Promise<{ executionID?: number; source?: string; objectTitle?: string; objectLeft?: number }> {
  const type = (item.objectType || 'custom').toLowerCase();

  let objectTitle: string | undefined;
  let objectLeft: number | undefined;
  let ctxExecutionID: number | undefined;
  let ctxProjectID: number | undefined;

  // 对象自身的执行最准；同时借这次请求拿到标题与剩余工时
  if (type !== 'custom' && item.objectID) {
    const ctx = await resolveObjectContext(client, type, item.objectID);
    objectTitle = ctx.title;
    objectLeft = ctx.left;
    ctxExecutionID = ctx.executionID;
    ctxProjectID = ctx.projectID;
  }

  if (item.executionID) return { executionID: item.executionID, source: '调用方指定', objectTitle, objectLeft };
  if (!autoExecution) return { objectTitle, objectLeft };
  if (ctxExecutionID) return { executionID: ctxExecutionID, source: '对象所在执行', objectTitle, objectLeft };

  const projectID = item.projectID || ctxProjectID;
  if (projectID) {
    const latest = await resolveLatestExecution(client, projectID);
    if (latest) {
      return {
        executionID: latest.id,
        source: `项目 ${projectID} 最新迭代「${latest.name}」（${latest.status ?? '-'}）`,
        objectTitle,
        objectLeft,
      };
    }
    return { source: `项目 ${projectID} 下没有可用的执行`, objectTitle, objectLeft };
  }

  return { objectTitle, objectLeft };
}

/** 保留两位小数，避免 0.1 + 0.2 这类浮点尾巴 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 算出这一条该填的**剩余工时**（表单的 `left[N]`）。
 *
 * ⚠️ 2026-11-20 实测：**挂任务（`objectType=task_xxx`）时 `left` 必填**。
 * 留空时服务端返回一个 246 字节的空壳页（`body{background:white}`），
 * 既不报错也不落库 —— 表现就是「整批全部失败，原因：服务端未返回可识别的结果」。
 * 而 `custom` 日志留空则完全正常。这一条踩过一次，8 条全灭。
 *
 * 算法：同一对象在本批次里按出现顺序**递减**，最后一条的 `left` 就是任务写完后该剩的值。
 * 例：任务剩余 16h，批内 3 条各 1.5h → left 依次 14.5 / 13 / 11.5。
 */
function planLeft(
  item: z.infer<typeof EffortItemSchema>,
  type: string,
  objectLeft: number | undefined,
  cursor: Map<string, number>
): { left?: number; note?: string } {
  // 自定义日志不需要 left（留空即可，传值反而会变成「挂空对象但记剩余工时」）
  if (type === 'custom') return { left: item.left };

  // 调用方显式给了就照用，不覆盖
  if (item.left !== undefined) return { left: item.left };

  if (!item.objectID) return { left: undefined };

  const key = `${type}_${item.objectID}`;
  const base = cursor.has(key) ? cursor.get(key)! : objectLeft;
  if (base === undefined || !Number.isFinite(base)) {
    // 读不到剩余工时（任务没设预计）→ 传 0，否则整表被拒
    cursor.set(key, 0);
    return { left: 0, note: '该对象读不到剩余工时，已按 0 处理' };
  }

  const next = Math.max(0, round2(base - item.consumed));
  cursor.set(key, next);
  return { left: next };
}

/** 删除工具的入参 */
export const DeleteEffortShape = {
  effortID: z.number().int().positive().describe('日志 ID（`zendao_list_my_efforts` 或 `zendao_fill_efforts` 的返回值里能拿到）'),
  date: z
    .string()
    .optional()
    .describe('该日志所属日期 `YYYY-MM-DD`；传了会用来做事后校验（确认那条真没了）'),
};

export interface DeleteEffortArgs {
  effortID: number;
  date?: string;
}

/**
 * 删除一条日志。
 *
 * ⚠️ 这是**不可撤销**的操作（禅道没有回收站）。删掉挂任务的日志时，
 * 该任务的已消耗工时会一并回滚 —— 这正是「写错了要怎么收尾」的答案。
 */
export async function deleteEffortTool(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  args: DeleteEffortArgs
): Promise<ToolResult> {
  const session = getWebSession(client);
  const res = await deleteEffort(session, args.effortID);

  if (!res.deleted) {
    return {
      content: [
        {
          type: 'text',
          text:
            `❌ 删除失败（日志 id=${args.effortID}）：${res.message}\n` +
            `服务端返回片段：${res.raw}`,
        },
      ],
      structuredContent: { effortID: args.effortID, deleted: false, message: res.message ?? null },
      isError: true,
    };
  }

  // 事后校验：能读日期就读一遍，确认真的没了
  let stillThere: boolean | null = null;
  if (args.date) {
    const rows = await readEffortsByDate(client, args.date);
    stillThere = rows.some((r) => String(r.id) === String(args.effortID));
  }

  const lines = [`✅ 已删除日志 id=${args.effortID}`];
  if (stillThere === true) lines.push('⚠️ 但回查时该日志仍在，可能删除未真正生效，请到网页确认。');
  if (stillThere === false) lines.push('已回查确认：该日期的日志列表里已经没有它了。');
  lines.push('挂任务的日志会同时回滚该任务的已消耗工时。');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      effortID: args.effortID,
      deleted: true,
      verifiedGone: stillThere,
      message: null,
    },
    isError: stillThere === true,
  };
}

export async function fillEffortsTool(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  args: FillEffortsArgs
): Promise<ToolResult> {
  const dryRun = args.dryRun !== false;
  const autoExecution = args.autoExecution !== false;
  const items = args.items || [];

  if (!items.length) {
    return {
      content: [{ type: 'text', text: 'items 为空，没有要填的日志。' }],
      isError: true,
    };
  }
  if (items.length > 50) {
    return {
      content: [{ type: 'text', text: `一次最多 50 条，收到 ${items.length} 条。请拆分批次。` }],
      isError: true,
    };
  }

  // ── 参数校验 ──
  const problems: string[] = [];
  for (const [i, item] of items.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      problems.push(`第 ${i + 1} 条：date「${item.date}」不是 YYYY-MM-DD`);
      continue;
    }
    const d = new Date(`${item.date}T00:00:00`);
    if (Number.isNaN(d.getTime())) problems.push(`第 ${i + 1} 条：date「${item.date}」不是合法日期`);
    const type = (item.objectType || 'custom').toLowerCase();
    if (type !== 'custom' && !item.objectID) {
      problems.push(`第 ${i + 1} 条：objectType=${type} 但没有 objectID`);
    }
  }
  if (problems.length) {
    return {
      content: [{ type: 'text', text: `参数有问题：\n- ${problems.join('\n- ')}` }],
      isError: true,
    };
  }

  // ── 迭代推断 + 剩余工时计算 ──
  const planned: PlannedItem[] = [];
  const leftCursor = new Map<string, number>();
  for (const item of items) {
    const exec = await planExecution(client, item, autoExecution);
    const type = (item.objectType || 'custom').toLowerCase();
    const { left, note } = planLeft(item, type, exec.objectLeft, leftCursor);
    planned.push({
      date: item.date,
      work: item.work,
      consumed: item.consumed,
      objectType: type,
      objectID: item.objectID,
      executionID: exec.executionID,
      left,
      leftNote: note,
      executionSource: exec.source,
      objectTitle: exec.objectTitle,
    });
  }

  // ── 已有日志（防重复提示） ──
  const dates = [...new Set(planned.map((p) => p.date))];
  const existingByDate = new Map<string, any[]>();
  for (const d of dates) existingByDate.set(d, await readEffortsByDate(client, d));

  const dupWarnings: string[] = [];
  for (const p of planned) {
    const same = (existingByDate.get(p.date) || []).filter(
      (e) => String(e.work).trim() === p.work.trim()
    );
    if (same.length) {
      dupWarnings.push(`${p.date} 已存在同名日志「${p.work}」（id=${same.map((e) => e.id).join(',')}），继续写入会产生重复`);
    }
  }

  // ── 预览 ──
  if (dryRun) {
    const lines: string[] = [];
    lines.push(`📋 预览（dryRun）：共 ${planned.length} 条，涉及 ${dates.length} 天`);
    lines.push('');
    for (const [i, p] of planned.entries()) {
      const obj = p.objectType === 'custom'
        ? '自定义日志'
        : `${p.objectType}#${p.objectID}${p.objectTitle ? ` ${p.objectTitle}` : ''}`;
      lines.push(
        `${i + 1}. ${p.date}  ${p.consumed}h  ${obj}` +
          `\n   工作内容：${p.work}` +
          `\n   执行(迭代)：${p.executionID ?? '（留空）'}${p.executionSource ? `  ← ${p.executionSource}` : ''}` +
          `\n   剩余工时：${p.left !== undefined ? `${p.left}h` : '（不适用）'}${p.leftNote ? `  ⚠️ ${p.leftNote}` : ''}`
      );
    }
    if (dupWarnings.length) {
      lines.push('');
      lines.push('⚠️ 重复提醒：');
      for (const w of dupWarnings) lines.push(`- ${w}`);
    }
    lines.push('');
    lines.push('尚未写入。确认无误后把 `dryRun` 设为 `false` 再调一次。');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        dryRun: true,
        total: planned.length,
        submitted: null,
        failed: null,
        days: dates,
        duplicates: dupWarnings,
        items: planned.map((p) => ({
          date: p.date,
          work: p.work,
          consumed: p.consumed,
          objectType: p.objectType,
          objectID: p.objectID ?? null,
          objectTitle: p.objectTitle ?? null,
          executionID: p.executionID ?? null,
          executionSource: p.executionSource ?? null,
          left: p.left ?? null,
          leftNote: p.leftNote ?? null,
        })),
      },
    };
  }

  // ── 真写 ──
  const session = getWebSession(client);
  const results = await fillEfforts(session, planned as EffortInput[]);

  // ── 回查：确认落库并带回 ID ──
  const verified: any[] = [];
  for (const d of dates) {
    const rows = await readEffortsByDate(client, d);
    for (const r of rows) {
      const hit = planned.find((p) => p.date === d && String(r.work).trim() === p.work.trim());
      if (hit) verified.push({ ...r, matched: true });
    }
  }

  const okCount = results.filter((r) => r.submitted).length;
  const failCount = results.length - okCount;

  const lines: string[] = [];
  lines.push(`✅ 提交完成：${okCount} 条成功${failCount ? `，${failCount} 条失败` : ''}`);
  lines.push('');
  for (const r of results) {
    const row = verified.find((v) => v.date === r.date && String(v.work).trim() === r.work.trim());
    lines.push(
      `${r.submitted ? '✅' : '❌'} ${r.date} ${r.consumed}h「${r.work}」` +
        (row ? `  → id=${row.id}` : '  → 回查未找到') +
        (r.message ? `\n   原因：${r.message}` : '')
    );
  }
  if (failCount) {
    lines.push('');
    lines.push('失败项可单独重试；若提示会话失效，工具会自动重新登录一次。');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      dryRun: false,
      total: results.length,
      submitted: okCount,
      failed: failCount,
      days: dates,
      duplicates: dupWarnings,
      items: results.map((r) => {
        const row = verified.find((v) => v.date === r.date && String(v.work).trim() === r.work.trim());
        return {
          date: r.date,
          work: r.work,
          consumed: r.consumed,
          submitted: r.submitted,
          effortID: row?.id ?? null,
          executionID: row?.execution ?? null,
          message: r.message ?? null,
        };
      }),
    },
    isError: failCount > 0 && okCount === 0,
  };
}
