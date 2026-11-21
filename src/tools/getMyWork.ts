/**
 * 「我的地盘」四合一：我的 Bug / 我的任务 / 我的需求 / 我的待办
 *
 * 为什么值得单独做一个通用工具（而不是各写一个）：
 *
 * 1. **服务端本来就是同一个接口**，只是 `mode` 不同 —— `GET /my/work?mode=…&type=…`。
 *    写成四个工具只会让模型多记三个名字，能力没有增加。
 * 2. **官方 CLI 在本实例给不了**：它的 `/my/tasks`、`/my/stories`、`/my/todos`
 *    全是 404（整个 `my` 模块要 max8.5，15 个动作里 14 个被版本门槛拒绝）。
 *    所以「我的任务 / 我的需求 / 我的待办」是**本项目相对官方的独占能力**。
 * 3. `zendao_list_my_bugs` 只覆盖了 Bug 一种资源，而「我接下来要干什么」
 *    这件事对任务/待办的依赖同样强（本实例实测 `todoCount.task = 1`）。
 *
 * ## 与 `zendao_list_my_bugs` 的分工
 *
 * | 场景 | 用哪个 |
 * | --- | --- |
 * | 「我有哪些 Bug 要处理」（含 opened/resolved/edited/any 四种身份、含已关闭、按产品筛） | `zendao_list_my_bugs` |
 * | 「我有哪些任务 / 需求 / 待办」 | 本工具（`mode` 选资源） |
 * | 「我的 Bug」但只按默认口径（指派给我、未关闭） | 两者都行，本工具更轻 |
 *
 * 本工具**不做** `list_my_bugs` 那套「逐产品合并」回落 —— 那条路只为 Bug 存在
 * （Bug 归属产品，需要跨产品扫）。任务/需求/待办没有等价的全库视图，
 * 接口不可用时如实报错比给一份不完整的数据更有用。
 *
 * ## 实测要点（2026-09-17）
 *
 * - 四种 mode 全部 200；列表字段分别是 `bugs` / `tasks` / `stories` / `todos`。
 * - `todo` mode 结构差异最大：顶层是 `todos` + `date` + `waitCount` / `doingCount`，
 *   **没有 `todoCount`**，且服务端忽略分页参数（`recPerPage` 恒回 1）。
 * - `task` 列表自带 `assignedToRealName`（真名），但 `openedBy` / `resolvedBy` 没有 ——
 *   所以 `resolveUserNames` 仍有用（走 `/my/work` 自带的 users 字典）。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { applyPick, sortItems } from '../utils/fields';
import { convertHtmlFields, htmlToMarkdown } from '../utils/html';
import { applyKeywordSearch } from '../utils/filter';
import { formatHours } from '../utils/format';
import { priorityLabel, severityLabel, statusLabel } from '../utils/labels';
import {
  attachUserNames,
  fetchMyWork,
  fetchMyWorkUsers,
  MY_WORK_MODE_LABELS,
  MY_WORK_TITLE_FIELDS,
  MyWorkMode,
} from '../utils/myWork';

export interface ListMyWorkArgs {
  mode?: MyWorkMode;
  /** 身份口径，缺省 assignedTo（todo mode 无此维度） */
  type?: string;
  /** 是否包含已关闭的（本地过滤）。默认 false */
  includeClosed?: boolean;
  /** 进一步按状态精确筛选（本地） */
  status?: string;
  /** 关键词，在标题 / 描述里模糊匹配（本地） */
  keyword?: string;
  /** 是否把账号补上人名（默认 true） */
  resolveUserNames?: boolean;
  page?: number;
  limit?: number;
  sort?: string;
  pick?: string;
}

/**
 * 从条目里取标题：不同 mode 的标题字段名不同
 */
function titleOf(mode: MyWorkMode, item: Record<string, any>): string {
  for (const field of MY_WORK_TITLE_FIELDS[mode]) {
    const value = item?.[field];
    if (typeof value === 'string' && value.trim()) {
      return htmlToMarkdown(value).split('\n')[0].trim();
    }
  }
  return '(无标题)';
}

/** 「账号(真名)」格式化：没真名就只给账号 */
function who(item: Record<string, any>, field: string): string {
  const account = item?.[field];
  if (!account || typeof account !== 'string') return '';
  const name = item?.[`${field}Name`];
  return name ? `${name}(${account})` : account;
}

export async function listMyWork(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  params?: ListMyWorkArgs
): Promise<ToolResult> {
  const args: ListMyWorkArgs = params || {};
  const mode = (args.mode || 'task') as MyWorkMode;

  if (!MY_WORK_MODE_LABELS[mode]) {
    return {
      content: [
        {
          type: 'text',
          text: `不支持的 mode: ${mode}。可选值：bug / task / story / todo。`,
        },
      ],
      isError: true,
    };
  }

  const me = client.currentAccount;
  const modeLabel = MY_WORK_MODE_LABELS[mode];
  /** 「Bug」是英文词，按中文排版习惯留个空格：「我的 Bug」而不是「我的Bug」 */
  const mineLabel = mode === 'bug' ? '我的 Bug' : `我的${modeLabel}`;
  const includeClosed = args.includeClosed === true;
  const type = args.type || 'assignedTo';

  try {
    const page = args.page || 1;
    const limit = args.limit || 20;

    let result;
    try {
      result = await fetchMyWork(client, mode, { type: mode === 'todo' ? undefined : type });
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text',
            text:
              `获取「${mineLabel}」失败：${err?.message || '未知错误'}\n\n` +
              '服务端「地盘」接口（GET /my/work）不可用。可能原因：\n' +
              '  · 这个禅道版本没有 /my/work（本项目的「我的 Bug」在此情况下会回落到逐产品扫描，' +
              '但任务/需求/待办没有等价的全库通路）；\n' +
              '  · 认证失效或权限不足。\n' +
              (mode === 'task'
                ? '备选：先 `zendao_call { module: "execution", action: "list" }` 拿到执行 ID，' +
                  '再用 `zendao_call { module: "task", action: "list", params: { executionID } }` 逐执行查。'
                : mode === 'story'
                  ? '备选：`zendao_call { module: "story", action: "list" }` 需要显式指定 productID 或 projectID。'
                  : ''),
          },
        ],
        isError: true,
      };
    }

    const scanned = result.items.length;
    let filtered = result.items.slice();

    if (!includeClosed) {
      filtered = filtered.filter((item) => String(item?.status || '').toLowerCase() !== 'closed');
    }
    if (args.status) {
      filtered = filtered.filter((item) => String(item?.status || '') === String(args.status));
    }
    if (args.keyword) {
      const fields = [...MY_WORK_TITLE_FIELDS[mode], 'desc', 'steps', 'spec'];
      filtered = applyKeywordSearch(filtered as any[], args.keyword, fields);
    }

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const sorted = args.sort ? sortItems(paged as any[], args.sort) : paged;

    // ⚠️ 展示文案必须用「未摘字段」的对象渲染，pick 只作用于 structuredContent，
    // 否则被摘掉的字段会显示成「未指派 / 未知」，看着像接口没返回。
    let display: any[] = convertHtmlFields(sorted) as any[];

    // 账号 → 人名：默认打开。这是本实例唯一能修正「your-account 是谁」的地方。
    const resolveUserNames = args.resolveUserNames !== false;
    let userNote = '';
    if (resolveUserNames && display.length) {
      try {
        const users = await fetchMyWorkUsers(client, cache);
        display = attachUserNames(display, users.map);
        userNote = `账号人名映射来自地盘接口自带的 users 字典（${users.users.length} 条）`;
      } catch {
        userNote = '（账号人名映射本次获取失败，展示的是原始账号）';
      }
    }

    const shaped: any[] = applyPick(display, args.pick);

    const lines = display.map((item: any) => {
      const parts = [`状态: ${statusLabel(mode, item.status)}`];
      if (item.pri != null) parts.push(`优先级: ${priorityLabel(item.pri)}`);

      const owner = who(item, 'assignedTo') || who(item, 'finishedBy');
      if (owner) parts.push(`负责人: ${owner}`);
      if (mode === 'bug' && item.severity != null) parts.push(`严重: ${severityLabel(item.severity)}`);
      if (item.deadline) parts.push(`截止: ${item.deadline}`);
      // ⚠️ 地盘列表的 estimate 自带单位（"40h"），详情接口是纯数字（"40"）——
      // 统一走 formatHours，否则会输出「40hh」。
      if (item.estimate != null) parts.push(`预计: ${formatHours(item.estimate)}`);

      const sub: string[] = [];
      if (item.execution) {
        sub.push(`执行 ${item.execution}${item.executionName ? `（${item.executionName}）` : ''}`);
      }
      if (item.story) sub.push(`关联需求 ${item.story}`);
      if (item.product) sub.push(`产品 ${item.product}`);
      const creator = who(item, 'openedBy');
      if (creator) sub.push(`创建: ${creator} @ ${item.openedDate || '-'}`);

      return `• [${item.id}] ${titleOf(mode, item)}\n  ${parts.join(' | ')}${sub.length ? `\n  ${sub.join(' | ')}` : ''}`;
    });

    const pageTotal = Math.max(1, Math.ceil(total / limit));
    const scopeLabel = `服务端地盘接口（mode=${mode}${mode === 'todo' ? '' : `&type=${type}`}）`;

    const header =
      shaped.length === 0
        ? `没有符合条件的「${mineLabel}」（账号 ${me || '未知'}，口径：${type}${includeClosed ? '，含已关闭' : '，仅未关闭'}）`
        : `${mineLabel}（账号 ${me || '未知'}，口径：${type}${includeClosed ? '，含已关闭' : '，仅未关闭'}）：` +
          `共 ${total} 条，第 ${page}/${pageTotal} 页，本页 ${shaped.length} 条`;

    const notes: string[] = [];
    notes.push(
      `数据源：${scopeLabel}，翻了 ${result.pagesFetched} 页取回 ${scanned} 条` +
        (result.truncated ? `（⚠️ 已达翻页上限，结果可能不完整）` : '')
    );
    if (total === 0 && scanned > 0) {
      notes.push(
        `注：已扫描 ${scanned} 条，本地过滤后剩 ${total} 条` +
          (!includeClosed ? '（已排除 closed；要看到它们请传 includeClosed: true）' : '')
      );
    }
    if (result.summary) {
      // ⚠️ 服务端的 summary 是**页级**统计（原话是「本页共 N 个任务」）——
      // 翻了好几页时直接展示会被误读成全局总数，必须标注清楚。
      notes.push(
        `服务端汇总${result.pagesFetched > 1 ? `（仅第 ${result.pagesFetched} 页）` : ''}：` +
          htmlToMarkdown(result.summary)
      );
    }
    const counts = result.counts;
    if (counts && typeof counts[mode] === 'number') {
      notes.push(`服务端自报「待处理」计数（todoCount.${mode}）：${counts[mode]} 条。`);
    }
    if (mode === 'todo') {
      const bits: string[] = [];
      if (result.extras.date) bits.push(`日期 ${result.extras.date}`);
      if (result.extras.waitCount != null) bits.push(`未开始 ${result.extras.waitCount}`);
      if (result.extras.doingCount != null) bits.push(`进行中 ${result.extras.doingCount}`);
      if (bits.length) notes.push(`服务端待办概览：${bits.join(' / ')}`);
      notes.push('⚠️ 待办（todo）的服务端分页参数无效，本工具按「全量拉取 + 本地分页」处理。');
    }
    if (userNote) notes.push(userNote);

    return {
      content: [
        {
          type: 'text',
          text: [header, ...notes, '', ...lines].filter((s) => s !== '').join('\n').trim(),
        },
      ],
      structuredContent: {
        account: me || '',
        mode,
        type: mode === 'todo' ? '' : type,
        includeClosed,
        scope: scopeLabel,
        source: `GET /my/work?mode=${mode}`,
        items: shaped,
        total,
        scanned,
        page,
        limit,
        pageTotal,
        ...(counts ? { serverCounts: counts } : {}),
        ...(result.summary ? { serverSummary: htmlToMarkdown(result.summary) } : {}),
        ...(mode === 'todo' ? { extras: result.extras } : {}),
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `获取「${mineLabel}」失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}
