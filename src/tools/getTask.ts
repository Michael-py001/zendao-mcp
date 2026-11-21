/**
 * 任务详情（`GET /tasks/{taskID}`）
 *
 * 为什么需要它 —— 任务线原本是**断的**：
 *   `zendao_call { module: "task", action: "list" }`（列）、`task/create`（建）、`task/update`（改状态）
 * 这些动作都接受 taskID，但**拿到 ID 之后看不了详情**，只能回网页。
 *
 * 本项目记忆里曾记着「`zendao_get_task` 工具不存在，但 `GET /tasks/{id}` 路由存在」——
 * 前半句说的是「没这个工具」，不是「没这条路」。2026-09-17 端点探针实测确认：
 *
 * ```
 *   GET /api.php/v2/tasks/2012808  →  { status: 'success', task: {…78 个字段}, actions: [...] }
 * ```
 *
 * ⚠️ 详情类输出一律用**单键容器** `{ task: z.any() }`，不要写字段白名单 ——
 * 禅道任务实体实测 78 个字段（列表里 79 个），白名单必被 ajv 判 `additional properties`。
 * 详见 `tools/index.ts` 里对 `ProjectOutputShape` 的说明。
 */

import { ToolResult, ITask } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { pickFields } from '../utils/fields';
import { convertHtmlFields } from '../utils/html';
import { extractOne } from '../utils/response';
import { attachUserNames, fetchMyWorkUsers } from '../utils/myWork';
import { formatHours } from '../utils/format';
import { priorityLabel, taskStatusLabel } from '../utils/labels';

export interface GetTaskOptions {
  /** 是否附带操作历史（谁在什么时候做了什么） */
  includeActions?: boolean;
  /** 摘取字段 */
  pick?: string;
  /** 是否把账号补上人名（默认 true） */
  resolveUserNames?: boolean;
}

export async function getTask(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  taskId: number,
  opts: GetTaskOptions = {}
): Promise<ToolResult> {
  if (!taskId || Number.isNaN(taskId)) {
    return {
      content: [{ type: 'text', text: '错误：任务 ID 必须是一个有效的数字' }],
      isError: true,
    };
  }

  try {
    const res = await client.get<any>(`/tasks/${taskId}`);
    const raw = extractOne<ITask>(res, 'task');

    // 禅道对不存在的 ID 不返回 404，而是 HTTP 200 + status:fail（client 已抛成异常），
    // 但以防万一还是兜一道：没有 id 就说明没取到实体。
    if (!raw || !(raw as any).id) {
      return {
        content: [
          {
            type: 'text',
            text:
              `未找到任务 ${taskId}。请用 zendao_call { module: "task", action: "list", ` +
              `params: { executionID } }（需执行 ID）或 ` +
              `zendao_list_my_work（mode: "task"）确认任务 ID。`,
          },
        ],
        isError: true,
      };
    }

    let task: any = convertHtmlFields(raw as any);

    // 账号 → 人名（任务实体自带 assignedToRealName，其余字段没有）
    if (opts.resolveUserNames !== false) {
      try {
        const users = await fetchMyWorkUsers(client, cache);
        task = attachUserNames([task], users.map)[0];
      } catch {
        /* 拿不到字典不影响详情本身 */
      }
    }

    const actions = opts.includeActions
      ? Array.isArray(res?.actions)
        ? (convertHtmlFields(res.actions) as any[])
        : []
      : [];

    const who = (field: string) => {
      const account = task[field];
      if (!account) return '';
      const name = task[`${field}Name`] || task[`${field}RealName`];
      return name && name !== account ? `${name}(${account})` : String(account);
    };

    const lines: string[] = [`[${task.id}] ${task.name || '(无标题)'}`];
    const row1: string[] = [`状态: ${taskStatusLabel(task.status)}`];
    if (task.subStatus) row1.push(`子状态: ${task.subStatus}`);
    if (task.type) row1.push(`类型: ${task.type}`);
    if (task.pri != null) row1.push(`优先级: ${priorityLabel(task.pri)}`);
    lines.push(`  ${row1.join(' | ')}`);

    const row2: string[] = [];
    const owner = who('assignedTo');
    if (owner) row2.push(`负责人: ${owner}`);
    if (task.estimate != null) row2.push(`预计: ${formatHours(task.estimate)}`);
    if (task.consumed != null) row2.push(`已消耗: ${formatHours(task.consumed)}`);
    if (task.left != null) row2.push(`剩余: ${formatHours(task.left)}`);
    if (row2.length) lines.push(`  ${row2.join(' | ')}`);

    const row3: string[] = [];
    if (task.deadline) row3.push(`截止: ${task.deadline}`);
    if (task.estStarted) row3.push(`预计开始: ${task.estStarted}`);
    if (task.realStarted) row3.push(`实际开始: ${task.realStarted}`);
    if (task.finishedDate) row3.push(`完成: ${task.finishedDate}`);
    if (row3.length) lines.push(`  ${row3.join(' | ')}`);

    const row4: string[] = [];
    if (task.execution) {
      row4.push(`执行: ${task.execution}${task.executionName ? `（${task.executionName}）` : ''}`);
    }
    if (task.project) row4.push(`项目: ${task.project}${task.projectName ? `（${task.projectName}）` : ''}`);
    if (row4.length) lines.push(`  ${row4.join(' | ')}`);

    const row5: string[] = [];
    if (task.story) {
      row5.push(`关联需求: ${task.story}${task.storyTitle ? `（${task.storyTitle}）` : ''}`);
    }
    if (task.fromBug) row5.push(`来源 Bug: ${task.fromBug}`);
    if (task.parent) row5.push(`父任务: ${task.parent}`);
    if (row5.length) lines.push(`  ${row5.join(' | ')}`);

    const creator = who('openedBy');
    if (creator) lines.push(`  创建: ${creator} @ ${task.openedDate || '-'}`);

    // 空描述不打印标题 —— `if (task.desc)` 对 "<p></p>" 这类空富文本为真，
    // 转换后只剩空白，会出现「描述:」后面什么都没有的尴尬输出。
    const desc = String(task.desc || '').trim();
    if (desc) {
      lines.push('', '描述:', desc.slice(0, 1500) + (desc.length > 1500 ? '\n…（已截断）' : ''));
    }
    const spec = String(task.storySpec || '').trim();
    if (spec) {
      lines.push('', '关联需求描述:', spec.slice(0, 1000) + (spec.length > 1000 ? '\n…（已截断）' : ''));
    }

    if (opts.includeActions) {
      lines.push('', `操作历史（${actions.length} 条）:`);
      for (const a of actions.slice(-30) as any[]) {
        const actor = a?.actor || a?.account || '-';
        lines.push(`  · ${a?.date || '-'} ${actor} ${a?.action || ''}${a?.comment ? ` — ${String(a.comment).slice(0, 200)}` : ''}`);
      }
    }

    const shaped = opts.pick ? pickFields(task, opts.pick.split(',').map((s) => s.trim()).filter(Boolean)) : task;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      // 单键容器，对齐 outputSchema = { task: z.any() }（原因见 tools/index.ts）
      structuredContent: {
        task: { ...(shaped as any) },
        ...(opts.includeActions ? { actions } : {}),
      },
    };
  } catch (error: any) {
    if (error?.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text:
              `未找到任务 ${taskId}（HTTP 404）。禅道对不存在的任务通常返回 200 + status:fail，` +
              '拿到 404 说明这个实例的 /tasks/{id} 路由不可用 —— 请改用 `zendao_call { module: "task", action: "list", params: { executionID } }`。',
          },
        ],
        isError: true,
      };
    }

    // 禅道对不存在的对象**不返回 404**，而是 HTTP 200 + `status: 'fail'`，
    // 文案是 `Task does not exist.`（client 已把它抛成异常）——
    // 这里翻译成人话，并给出下一步该调什么。
    const msg = String(error?.message || '');
    if (/does not exist|not found/i.test(msg)) {
      return {
        content: [
          {
            type: 'text',
            text:
              `未找到任务 ${taskId}（禅道返回：${msg}）。\n` +
              '请用 `zendao_call { module: "task", action: "list", params: { executionID } }` 或 zendao_list_my_work（mode: "task"）确认任务 ID。',
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `获取任务详情失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}
