/**
 * 用户字典：把 `assignedTo` / `openedBy` 这类**账号**变成**人名**
 *
 * 现状缺口：禅道所有返回里的 `assignedTo` / `openedBy` / `resolvedBy` 存的都是
 * **账号字符串**（`your-account`），人跟名字对不上。这在前端开发场景里很要命 ——
 * 「这条 Bug 是谁提的、该找谁」是最高频的问题之一。
 *
 * ⚠️ 官方路径全废（2026-09-17 实测）：
 *
 * ```
 *   GET /users        ❌ 404
 *   GET /users/{id}   ❌ 404
 *   GET /projects/{id}/members   ❌ 404
 *   GET /executions/{id}/members ❌ 404
 * ```
 *
 * ⭐ 但 `/my/work` 的响应**每个 mode 都自带**两份 `{ 账号: 姓名 }` 字典：
 *
 * ```
 *   users       : { "your-account": "xxx", "admin": "admin", "caicheng": "xxx", … }   实测 200+ 条
 *   memberPairs : { "your-account": "xxx", "caijinai": "xxx", … }                    实测 100+ 条
 * ```
 *
 * 这是本实例**唯一**能拿到账号↔人名映射的地方，所以本工具绕道去取它。
 * 取数用的是最轻的一档（`mode=bug&recPerPage=1`），结果缓存 30 分钟。
 *
 * 顺带：`zendao_list_my_work` / `zendao_get_task` / `zendao_call { module: "story", action: "list" }` 等
 * 默认会自动补上 `xxxName` 字段，所以多数场景不必手动调本工具 ——
 * 除非你想看到**完整的人员名单**（比如选负责人、@某人）。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { applyPick, sortItems } from '../utils/fields';
import { fetchMyWorkUsers, MyWorkUser } from '../utils/myWork';

export interface ListUsersArgs {
  /** 关键词，在账号或姓名里模糊匹配（本地） */
  keyword?: string;
  /** 精确查某个账号（本地） */
  account?: string;
  /** 只看有真实姓名的（即 `姓名 !== 账号`），默认 false */
  realNameOnly?: boolean;
  page?: number;
  limit?: number;
  sort?: string;
  pick?: string;
}

export async function listUsers(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  params?: ListUsersArgs
): Promise<ToolResult> {
  const args: ListUsersArgs = params || {};

  try {
    const dict = await fetchMyWorkUsers(client, cache);
    let users: MyWorkUser[] = dict.users;

    if (args.account) {
      const target = String(args.account).trim().toLowerCase();
      users = users.filter((u) => u.account.toLowerCase() === target);
    }
    if (args.realNameOnly) {
      users = users.filter((u) => u.hasRealName);
    }
    if (args.keyword) {
      const kw = args.keyword.toLowerCase();
      users = users.filter(
        (u) => u.account.toLowerCase().includes(kw) || u.realName.toLowerCase().includes(kw)
      );
    }

    const page = args.page || 1;
    const limit = args.limit || 50;
    const total = users.length;
    const paged = users.slice((page - 1) * limit, (page - 1) * limit + limit);
    const sorted = args.sort ? sortItems(paged as any[], args.sort) : paged;

    const shaped: any[] = applyPick(sorted as any[], args.pick);

    const pageTotal = Math.max(1, Math.ceil(total / limit));
    // ⚠️ 计数必须基于**筛选后**的集合，否则「关键词只命中 2 人」却报「其中 106 人有真实姓名」，
    // 看着像筛选没生效。（字典级的总数另在 notes 里说明。）
    const withName = users.filter((u) => u.hasRealName).length;
    const dictWithName = dict.users.filter((u) => u.hasRealName).length;

    const header =
      shaped.length === 0
        ? '没有匹配的用户'
        : `用户字典：共 ${total} 人（其中 ${withName} 人填写了真实姓名），第 ${page}/${pageTotal} 页，本页 ${shaped.length} 人`;

    const notes = [
      `数据源：${dict.source}（${dict.rawCount} 条 users + ${Object.keys(dict.pairs).length} 条 memberPairs，已合并去重）` +
        `，全量 ${dict.users.length} 人中 ${dictWithName} 人填了真实姓名`,
      '⚠️ **部分实例**的 GET /users 与 /users/{id} 都是 404，官方路径拿不到人员名单，只能走这条路。',
      '姓名与账号相同的条目说明该用户没填真实姓名（如 admin / 供应商账号），不是数据缺失。',
    ];

    const lines = sorted.map((u) => `• ${u.realName}${u.hasRealName ? `（${u.account}）` : ''}`);

    return {
      content: [{ type: 'text', text: [header, ...notes, '', ...lines].filter((s) => s !== '').join('\n').trim() }],
      structuredContent: {
        source: 'GET /my/work（响应自带的 users / memberPairs 字典）',
        users: shaped,
        total,
        withRealName: withName,
        page,
        limit,
        pageTotal,
      },
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text:
            `获取用户字典失败: ${error.message || '未知错误'}\n` +
            '（本工具依赖服务端「地盘」接口 GET /my/work，该接口不可用时拿不到账号↔人名映射。）',
        },
      ],
      isError: true,
    };
  }
}
