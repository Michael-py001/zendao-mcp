/**
 * 禅道「地盘（my）」接口封装
 *
 * 实测发现（本实例 zentaomax）：
 *
 * ```
 *   网页   index.php?m=my&f=work&mode=bug&type=assignedTo
 *   接口   GET /api.php/v2/my/work?mode=bug&type=assignedTo
 * ```
 *
 * 也就是说 —— **v2 是支持「我的待处理 Bug」的**，只是它不叫 `/my/bugs`
 * （那个路径 404），而是复用网页「地盘」页面的 `/my/work`，
 * 用 `mode` 选资源、用 `type` 选身份。
 *
 * 为什么值得单独封一层：本项目原先只能靠「逐产品遍历合并全库 Bug + 本地按账号过滤」，
 * 要发 35 次请求（首次约 10 秒）。走 `/my/work` 后默认口径一次请求就够，
 * 且结果与网页「我的地盘 → Bug」逐条一致。
 *
 * ## 四种 mode（2026-09-17 实测全部可用）
 *
 * 官方 CLI 的 `/my/bugs`、`/my/tasks`、`/my/stories`、`/my/todos` **在本实例全是 404**
 * （整个 `my` 模块要 max8.5），但 `/my/work` 用 `mode` 一次覆盖了四种资源：
 *
 * | mode | 列表字段 | 备注 |
 * | --- | --- | --- |
 * | `bug` | `bugs` | 最常用 |
 * | `task` | `tasks` | 额外带 `summary`（中文汇总句）、`kanbanList` |
 * | `story` | `stories` | 额外带 `gradeGroup`、`showGrade` |
 * | `todo` | `todos` | **结构差异最大**：顶层有 `date`/`waitCount`/`doingCount`，**没有 `todoCount`**；
 * 且服务端忽略分页参数（`recPerPage` 恒回 1），只能本地分页 |
 *
 * ⚠️ 四个实测细节，都会让「直接照直觉用」出问题：
 *
 * 1. **列表可能是 ID 字典**（`{ "2010511": {...} }`），空结果时才退化成数组 `[]`。
 *    交给 `extractList` 归一化，别自己 `Object.keys` 或当数组用。
 * 2. **顶层 `recTotal` 不可信**（bug mode 下有这个键但恒 0，task mode 干脆没有），
 *    真实总数只在 `pager.recTotal`。`extractList` 已优先取 `pager`。
 * 3. **`type` 的语义本身带状态条件**：`assignedTo` 只给未关闭的（「待处理」口径），
 *    而 `resolvedBy` 会把已关闭的一并给出。所以「含已关闭」这种需求要另想办法，
 *    不能指望这一条通路。
 * 4. **响应自带用户字典**：`users` 与 `memberPairs` 都是 `{ 账号: 姓名 }`，
 *    实测 200+ 条 —— 这是本实例**唯一**能拿到账号↔人名映射的地方
 *    （`/users`、`/users/{id}` 全部 404）。见 `fetchMyWorkUsers()`。
 *
 * 已知 `type` 取值（实测枚举，其余值静默返回 0 而不报错）：
 * `assignedTo` / `openedBy` / `resolvedBy` / `assignedBy` / `closedBy` / `feedbackBy`
 */

import { ZenTaoClient } from '../client';
import { LRUCache } from './cache';
import { extractList } from './response';

/** 「地盘」支持的资源维度 */
export type MyWorkMode = 'bug' | 'task' | 'story' | 'todo';

/** 「地盘 → Bug」的身份口径（其余 mode 共用同一组取值） */
export type MyWorkBugType =
  | 'assignedTo'
  | 'openedBy'
  | 'resolvedBy'
  | 'assignedBy'
  | 'closedBy'
  | 'feedbackBy';

/** mode → 响应里的列表字段名 */
export const MY_WORK_LIST_KEYS: Record<MyWorkMode, string> = {
  bug: 'bugs',
  task: 'tasks',
  story: 'stories',
  todo: 'todos',
};

/** mode → 中文名（拼文案用） */
export const MY_WORK_MODE_LABELS: Record<MyWorkMode, string> = {
  bug: 'Bug',
  task: '任务',
  story: '需求',
  todo: '待办',
};

/** 标题字段：Bug/需求叫 title，任务/待办叫 name */
export const MY_WORK_TITLE_FIELDS: Record<MyWorkMode, string[]> = {
  bug: ['title', 'name'],
  task: ['name', 'title'],
  story: ['title', 'name'],
  todo: ['name', 'title', 'content'],
};

/** 每页拉多少：实测 `recPerPage=100` 服务端接受，比默认 20 少 4/5 的往返 */
const PAGE_SIZE = 100;
/** 翻页上限：防止某个口径数据异常庞大时把客户端拖死（100 × 10 = 1000 条） */
const MAX_PAGES = 10;

export interface MyWorkResult {
  /** 资源维度 */
  mode: MyWorkMode;
  /** 响应里的列表字段名 */
  listKey: string;
  /** 归一化后的列表（顺序已按服务端 `orderBy` 还原） */
  items: any[];
  /** 服务端报告的总条数（`pager.recTotal`） */
  recTotal: number;
  /** 实际翻了几页 */
  pagesFetched: number;
  /** 是否因为超过翻页上限而被截断 */
  truncated: boolean;
  /**
   * 服务端自报的计数对象（响应里的 `todoCount`）。
   * `bug` / `task` / `story` 三种 mode 都有，`todo` mode **没有** —— 它给的是
   * 顶层的 `waitCount` / `doingCount`（已收进 `extras`）。
   * 与网页左侧菜单的红色角标同源，可用来交叉验证本地过滤结果。
   */
  counts: Record<string, number> | null;
  /** 服务端生成的中文汇总句（只有 task mode 有） */
  summary: string | null;
  /** 各 mode 额外的顶层标量（`todo` 的 date/waitCount/doingCount、`story` 的 showGrade 等） */
  extras: Record<string, any>;
}

export interface MyWorkOptions {
  /** 身份口径，缺省 assignedTo */
  type?: MyWorkBugType | string;
  /** 翻页上限，缺省 10 */
  maxPages?: number;
}

/** `todo` mode 会额外透出的顶层标量（其余字段是当页数据的附属，不收集） */
const EXTRA_SCALAR_KEYS = ['date', 'waitCount', 'doingCount', 'showGrade', 'time', 'times'];

/**
 * 拉取「地盘」里某个 mode + 某个身份下的数据。
 *
 * 会按 `pager.pageTotal` 自动翻页直到取完（上限 `maxPages` 页），
 * 所以默认口径（assignedTo）通常只发 1 次请求。
 *
 * 注意：这是**只读**调用；`/my/work` 不产生任何数据变更。
 */
export async function fetchMyWork(
  client: ZenTaoClient,
  mode: MyWorkMode,
  opts: MyWorkOptions = {}
): Promise<MyWorkResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const listKey = MY_WORK_LIST_KEYS[mode];
  if (!listKey) throw new Error(`不支持的 mode: ${mode}`);

  const items: any[] = [];
  const seen = new Set<string>();
  let counts: Record<string, number> | null = null;
  let summary: string | null = null;
  let recTotal = 0;
  let pageTotal = 1;
  let pagesFetched = 0;
  const extras: Record<string, any> = {};

  for (let page = 1; page <= pageTotal && page <= maxPages; page++) {
    const query: Record<string, unknown> = {
      mode,
      ...client.paginationParams(page, PAGE_SIZE),
    };
    // `todo` mode 没有身份维度，传了服务端也只是忽略 —— 索性不传，少一个变量
    if (opts.type && mode !== 'todo') query.type = opts.type;

    const res = await client.get<any>('/my/work', query);

    const { list, pager } = extractList<any>(res, listKey, PAGE_SIZE);

    if (counts === null && res && typeof res.todoCount === 'object' && res.todoCount) {
      counts = { ...(res.todoCount as Record<string, number>) };
    }
    if (summary === null && typeof res?.summary === 'string' && res.summary) {
      summary = res.summary;
    }
    for (const key of EXTRA_SCALAR_KEYS) {
      if (extras[key] === undefined && res?.[key] !== undefined && typeof res[key] !== 'object') {
        extras[key] = res[key];
      }
    }

    recTotal = pager.total || recTotal;
    pageTotal = pager.pageTotal || 1;
    pagesFetched++;

    for (const item of list) {
      const id = String(item?.id ?? '');
      // 翻页期间数据可能被改动导致重复，按 id 去重
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      items.push(item);
    }
  }

  return {
    mode,
    listKey,
    items,
    recTotal,
    pagesFetched,
    truncated: pageTotal > maxPages,
    counts,
    summary,
    extras,
  };
}

/**
 * 拉取「地盘」里某一身份下的 Bug（`fetchMyWork` 的向后兼容封装）。
 *
 * 保留它是为了不打断 `getMyBugs.ts` 的既有调用与离线用例；
 * 新代码直接用 `fetchMyWork(client, 'bug', { type })` 即可。
 */
export async function fetchMyWorkBugs(
  client: ZenTaoClient,
  type: MyWorkBugType = 'assignedTo',
  opts: { maxPages?: number } = {}
): Promise<{
  bugs: any[];
  todoCount: number | null;
  recTotal: number;
  pagesFetched: number;
  truncated: boolean;
}> {
  const res = await fetchMyWork(client, 'bug', { type, maxPages: opts.maxPages });
  return {
    bugs: res.items,
    todoCount: typeof res.counts?.bug === 'number' ? res.counts.bug : null,
    recTotal: res.recTotal,
    pagesFetched: res.pagesFetched,
    truncated: res.truncated,
  };
}

/**
 * 探测当前实例是否提供「地盘」接口。
 *
 * 老版本禅道没有这个路径（返回 404 → axios 抛错），
 * 调用方据此决定是走它还是回落到「逐产品合并」。
 */
export async function probeMyWork(client: ZenTaoClient): Promise<boolean> {
  try {
    await client.get<any>('/my/work', {
      mode: 'bug',
      ...client.paginationParams(1, 1),
    });
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── 用户字典 ─────────────────────────

/** 一条「账号 → 人名」映射 */
export interface MyWorkUser {
  /** 登录账号，如 `your-account` */
  account: string;
  /** 显示名。禅道里就是 `realname`，没填时退化成账号本身 */
  realName: string;
  /** 是否查到了真实姓名（没查到时为 false，`realName` 等于账号） */
  hasRealName: boolean;
}

export interface MyWorkUsersResult {
  users: MyWorkUser[];
  /** 账号 → 人名的查表对象 */
  map: Record<string, string>;
  /** `memberPairs`（响应里另一份同构映射，实测 100+ 条） */
  pairs: Record<string, string>;
  /**
   * `users` 原始条目数。若明显多于 `users.length`，说明有条目被过滤掉了
   * （见 `fetchMyWorkUsers` 的说明）。
   */
  rawCount: number;
  source: string;
}

/** 用户字典的缓存键与 TTL（人员变动不频繁，缓存 30 分钟） */
const USER_CACHE_KEY = 'mywork:users';
const USER_CACHE_TTL = 30 * 60 * 1000;

/**
 * 取「账号 → 人名」字典。
 *
 * ⚠️ 为什么绕道 `/my/work`：本实例 `GET /users` 与 `GET /users/{id}` **都是 404**，
 * 官方 CLI 的 `user` 模块也帮不上（账号列表在 max8.5 门槛外）。
 * 而 `/my/work` 的响应**每个 mode 都自带** `users`（`{账号: 人名}`）与 `memberPairs`，
 * 这是实测唯一能找到账号↔人名映射的地方。
 *
 * 取数用的是最轻的一档：`mode=bug&recPerPage=1`（一条数据都不多拿）。
 */
export async function fetchMyWorkUsers(
  client: ZenTaoClient,
  cache?: LRUCache<string, any>
): Promise<MyWorkUsersResult> {
  const cached = cache?.get(USER_CACHE_KEY) as MyWorkUsersResult | undefined;
  if (cached) return cached;

  const res = await client.get<any>('/my/work', {
    mode: 'bug',
    type: 'assignedTo',
    ...client.paginationParams(1, 1),
  });

  const raw: Record<string, string> = res?.users && typeof res.users === 'object' ? res.users : {};
  const pairs: Record<string, string> =
    res?.memberPairs && typeof res.memberPairs === 'object' ? res.memberPairs : {};

  const users: MyWorkUser[] = [];
  const map: Record<string, string> = {};

  for (const [account, name] of Object.entries(raw)) {
    const realName = String(name ?? '').trim() || account;
    const hasRealName = realName !== account;
    users.push({ account, realName, hasRealName });
    map[account] = realName;
  }
  // 字典里没有但 memberPairs 里有的，补进来（实测两者高度重叠，但不保证相等）
  for (const [account, name] of Object.entries(pairs)) {
    if (map[account] !== undefined) continue;
    const realName = String(name ?? '').trim() || account;
    users.push({ account, realName, hasRealName: realName !== account });
    map[account] = realName;
  }

  users.sort((a, b) => a.account.localeCompare(b.account));

  const result: MyWorkUsersResult = {
    users,
    map,
    pairs,
    rawCount: Object.keys(raw).length,
    source: '服务端地盘接口 GET /my/work 响应自带的 users / memberPairs 字典',
  };

  cache?.set(USER_CACHE_KEY, result, USER_CACHE_TTL);
  return result;
}

/**
 * 给列表项补上「账号对应的人名」。
 *
 * 不覆盖原字段，而是**追加** `xxxName`：这样 `pick` 语义不变，
 * 调用方也能同时拿到账号（用于回写接口）和人名（用于展示）。
 */
export function attachUserNames<T extends Record<string, any>>(
  items: T[],
  userMap: Record<string, string>
): T[] {
  if (!userMap || Object.keys(userMap).length === 0) return items;

  return items.map((item) => {
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      // 只处理「看着像账号」的字段：值为字符串、且字典里有这个键
      if (typeof value !== 'string' || !value) continue;
      if (!/^(assignedTo|openedBy|resolvedBy|closedBy|finishedBy|lastEditedBy|createdBy|canceledBy|assignedBy|addedBy)$/.test(key)) {
        continue;
      }
      const name = userMap[value];
      if (name && name !== value) extra[`${key}Name`] = name;
    }
    return Object.keys(extra).length ? { ...item, ...extra } : item;
  });
}
