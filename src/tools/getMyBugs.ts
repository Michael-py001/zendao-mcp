/**
 * 「我的 Bug」——按身份列出与当前登录账号相关的 Bug。
 *
 * 为什么单独做一个工具，而不是让用户自己拼 list_bugs 的参数？
 *
 * 1. **禅道里「我」的身份有四种**，分散在不同字段上：
 *      assignedTo（指派给我）/ openedBy（我创建）/ resolvedBy（我解决）/ lastEditedBy（我最后修改）
 *    而 `list_bugs` 的具名参数只暴露了 `assignedTo`，其余得靠 filter 表达式绕。
 *    实际数据里这四种的差距极大 —— 本实例 your-account 是 `assignedTo` 6 条、`resolvedBy` 340 条，
 *    只查一种身份会得出「什么都没有」或「就这些」的错误结论。
 * 2. 「待处理」这个口径需要组合条件（身份 + 未关闭），拼起来容易漏。
 *
 * ## 数据源有两条路，优先走第一条
 *
 * **A. 服务端「地盘」接口**（首选，快）
 *
 *   网页 `m=my&f=work&mode=bug&type=assignedTo` 背后的接口就是
 *   `GET /api.php/v2/my/work?mode=bug&type=assignedTo`。
 *   服务端按身份过滤，一次请求返回，结果与网页逐条一致。
 *   封装见 `utils/myWork.ts`。
 *
 * **B. 逐产品遍历合并 + 本地按账号过滤**（兜底，慢但完整）
 *
 *   用于 A 覆盖不到的情况：`lastEditedBy` 这种身份「地盘」没有对应 tab；
 *   或者要「含已关闭」（`assignedTo` tab 本身只给未关闭的）。
 *   ⚠️ 走这条路时必须用 `fetchAllBugs`（逐产品合并）：本实例的 `/bugs` 不带产品时
 *   只返回单个产品（固定在产品 9），而 `/products` 又会漏掉 `shadow=1` 的影子产品。
 *   两点叠加曾让「我的待处理 Bug」永远返回 0 —— 真实答案是 6 条，
 *   全躺在影子产品 2000076「电网储能工程造价分析系统」里。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { applyPick, sortItems } from '../utils/fields';
import { convertHtmlFields } from '../utils/html';
import { applyKeywordSearch } from '../utils/filter';
import { fetchMyWorkBugs, MyWorkBugType } from '../utils/myWork';
import { bugStatusLabel, priorityLabel, severityLabel } from '../utils/labels';
import { fetchRawBugs, resolveBugEndpoint, MAX_BUG_FETCH, globalScopeNote, GlobalBugMeta } from './getBugs';

/** 「我」在禅道里可能扮演的身份 */
export type MyBugRole = 'assigned' | 'opened' | 'resolved' | 'edited' | 'any';

/** 身份 → 对应字段 */
export const ROLE_FIELDS: Record<Exclude<MyBugRole, 'any'>, string> = {
  assigned: 'assignedTo',
  opened: 'openedBy',
  resolved: 'resolvedBy',
  edited: 'lastEditedBy',
};

/**
 * 身份 → 「地盘」接口的 type 参数。
 *
 * 只有三种身份有对应的服务端 tab；`edited`（最后修改）没有，
 * 只能走「逐产品合并 + 本地过滤」那条慢路。
 */
export const ROLE_TO_MY_WORK_TYPE: Partial<Record<MyBugRole, MyWorkBugType>> = {
  assigned: 'assignedTo',
  opened: 'openedBy',
  resolved: 'resolvedBy',
};

/** 有服务端 tab 的身份，用于结果为空时逐个报命中数 */
const SERVER_BACKED_ROLES: Array<Exclude<MyBugRole, 'any'>> = ['assigned', 'opened', 'resolved'];

export const ROLE_LABELS: Record<MyBugRole, string> = {
  assigned: '指派给我',
  opened: '由我创建',
  resolved: '由我解决',
  edited: '由我最后修改',
  any: '与我相关（任一身份）',
};

export interface ListMyBugsArgs {
  /** 身份口径，默认 assigned（指派给我） */
  role?: MyBugRole;
  /** 是否包含已关闭的 Bug，默认 false（只看待处理） */
  includeClosed?: boolean;
  /** 进一步按状态精确筛选（本地）：active / resolved / closed */
  status?: string;
  /** 只查某个产品 */
  productID?: number;
  /** 关键词，在标题 / 重现步骤中模糊匹配 */
  keyword?: string;
  orderBy?: string;
  page?: number;
  limit?: number;
  pick?: string;
  sort?: string;
}

/**
 * 判断一条 Bug 是否命中指定身份。
 *
 * 抽成纯函数是为了能离线单测 —— 这里最容易出的错是「字段名写错」或
 * 「any 口径下漏掉某个字段」，两者都会静默返回空列表。
 */
export function matchRole(bug: Record<string, any>, role: MyBugRole, account: string): boolean {
  if (!account) return false;
  if (role === 'any') {
    return Object.values(ROLE_FIELDS).some((field) => String(bug[field] ?? '') === account);
  }
  const field = ROLE_FIELDS[role];
  return String(bug[field] ?? '') === account;
}

/** 获取「我的 Bug」列表 */
export async function listMyBugs(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  params?: ListMyBugsArgs
): Promise<ToolResult> {
  const args: ListMyBugsArgs = params || {};
  const me = client.currentAccount;

  // 拿不到账号就必须失败，不能「不过滤」—— 那会把全库 Bug 当成「我的」返回。
  if (!me) {
    return {
      content: [
        {
          type: 'text',
          text:
            '无法确定「我」是谁，所以不能列出「我的 Bug」。\n' +
            '当前配置用的是静态 ZENTAO_TOKEN，不含账号信息。\n' +
            '请改用 ZENTAO_ACCOUNT + ZENTAO_PASSWORD 登录，' +
            '或改用 zendao_list_bugs 并显式传 assignedTo / filter 参数。',
        },
      ],
      isError: true,
    };
  }

  const target = resolveBugEndpoint({ productID: args.productID });
  if (!target) {
    return {
      content: [
        { type: 'text', text: '范围参数不合法：productID 必须是正整数。' },
      ],
      isError: true,
    };
  }

  const role: MyBugRole = args.role || 'assigned';
  const includeClosed = args.includeClosed === true;

  try {
    const page = args.page || 1;
    const limit = args.limit || 20;

    let list: any[] = [];
    let scanned = 0;
    let scopeLabel = target.label;
    /** 结果为空时，用来记录「各身份各命中多少」的来源 */
    let global: GlobalBugMeta | undefined;
    let sourceLabel = '';
    let sourceNote = '';
    let serverTodoCount: number | null = null;
    let usedServer = false;

    // ── 路 A：服务端「地盘」接口 ─────────────────────────────────────────
    // 只在「身份有对应 tab」且「不要已关闭」且「没指定产品」时走：
    //   · 没对应 tab（edited）→ 服务端根本没这个筛选，谈不上用
    //   · 要已关闭 → assignedTo tab 本身不含已关闭，拿不到，别用假数据糊弄
    //   · 指定了产品 → 兜底路径只拉那一个产品，本来就很快，且语义更直白
    const serverType = !includeClosed && !args.productID ? ROLE_TO_MY_WORK_TYPE[role] : undefined;

    if (serverType) {
      try {
        const res = await fetchMyWorkBugs(client, serverType);
        list = res.bugs;
        scanned = res.bugs.length;
        serverTodoCount = res.todoCount;
        usedServer = true;
        scopeLabel = '全库';
        sourceLabel = `服务端地盘接口 GET /my/work?mode=bug&type=${serverType}`;
        sourceNote =
          `数据源：${sourceLabel}（与网页「我的地盘 → Bug」同一通路），` +
          `翻了 ${res.pagesFetched} 页取回 ${scanned} 条` +
          (res.truncated ? `（⚠️ 已达翻页上限 ${scanned} 条，结果可能不完整）` : '');
      } catch (err: any) {
        // 老版本禅道没有 /my/work，或临时故障 —— 安静回落到逐产品合并
        sourceNote = `服务端「地盘」接口不可用（${err?.message || '未知原因'}），已回落到「逐产品合并」。`;
      }
    }

    // ── 路 B：逐产品遍历合并 + 本地过滤（兜底） ──────────────────────────
    if (!usedServer) {
      const raw = await fetchRawBugs(client, {
        path: target.path,
        browseType: 'all',
        serverPage: 1,
        fetchLimit: MAX_BUG_FETCH,
        orderBy: args.orderBy,
        cache,
      });
      list = raw.list;
      global = raw.global;
      scanned = list.length;
      scopeLabel = global ? `全局（合并 ${global.productCount} 个产品）` : target.label;
      sourceLabel = global ? '逐产品合并全库 Bug' : `逐条拉取 ${target.label}`;
      // 只在还没写过说明时补一句，避免把「接口不可用」这条重要信息冲掉
      if (!sourceNote) sourceNote = `数据源：${sourceLabel}，共扫描 ${scanned} 条`;
    }

    let filtered: any[] = list.filter((b) => matchRole(b, role, me));

    const byRole = filtered.length;

    if (!includeClosed) {
      filtered = filtered.filter((b) => String(b.status || '').toLowerCase() !== 'closed');
    }
    if (args.status) {
      filtered = filtered.filter((b) => String(b.status || '') === String(args.status));
    }

    // productID 已经体现在端点上；这里只是双保险（幂等）
    if (args.productID) {
      filtered = filtered.filter((b) => String(b.product ?? '') === String(args.productID));
    }

    if (args.keyword) {
      filtered = applyKeywordSearch(filtered, args.keyword, ['title', 'steps']);
    }

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const sorted = args.sort ? sortItems(paged as any[], args.sort) : paged;

    // ⚠️ 展示文案必须用「未摘字段」的对象渲染，pick 只作用于 structuredContent，
    // 否则被摘掉的字段会显示成「未指派 / 未知」，看着像接口没返回。
    const display: any[] = convertHtmlFields(sorted) as any[];

    // 状态分布，用于解释「为什么是这个数」
    const statusCount: Record<string, number> = {};
    for (const b of filtered) {
      const s = String(b.status || '未知');
      statusCount[s] = (statusCount[s] || 0) + 1;
    }
    const statusText = Object.entries(statusCount)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ');

    const shaped: any[] = applyPick(display, args.pick);
    const roleLabel = ROLE_LABELS[role] || role;
    const pageTotal = Math.max(1, Math.ceil(total / limit));

    const lines = display.map((b: any) => {
      const parts = [
        `状态: ${bugStatusLabel(b.status)}`,
        `严重: ${severityLabel(b.severity)}`,
        `优先级: ${priorityLabel(b.pri)}`,
      ];
      if (b.type) parts.push(`类型: ${b.type}`);
      parts.push(`指派: ${b.assignedTo || '未指派'}`);
      if (b.resolution) parts.push(`方案: ${b.resolution}`);
      const sub = `    产品 ${b.product ?? '-'}${b.productName ? `（${b.productName}）` : ''} | 由 ${b.openedBy || '-'} 创建于 ${b.openedDate || '-'}`;
      return `• [${b.id}] ${b.title}\n  ${parts.join(' | ')}\n${sub}`;
    });

    const header =
      shaped.length === 0
        ? `没有符合条件的 Bug（账号 ${me}，范围：${scopeLabel}，口径：${roleLabel}${includeClosed ? '，含已关闭' : '，仅未关闭'}）`
        : `我的 Bug（账号 ${me}，范围：${scopeLabel}，口径：${roleLabel}${includeClosed ? '，含已关闭' : '，仅未关闭'}）：` +
          `共 ${total} 条，第 ${page}/${pageTotal} 页，本页 ${shaped.length} 条`;

    const notes: string[] = [];
    if (total === 0) {
      notes.push(
        `注：已扫描 ${scanned} 条 Bug（范围：${scopeLabel}），其中匹配「${roleLabel}」的 ${byRole} 条` +
          (byRole > 0 && !includeClosed
            ? `，但全部已关闭 —— 加 includeClosed: true 可以看到它们。`
            : '。')
      );

      // 结果为空时把**各身份**的命中数一并列出。
      // 这是踩过坑之后的经验：只报「指派给我 0 条」会让人以为「我没有任何 Bug」，
      // 而实际可能是「我的角色是解决人，有 340 条」。一次说清，省一轮往返。
      notes.push(`各身份命中（仅未关闭）：${await countByRole(client, list, role, serverType, usedServer, me)}`);

      // 结果为 0 时把数据来源也讲清楚 —— 「是不是漏了？」是最需要马上回答的疑问
      notes.push(sourceNote);
      if (global) notes.push(globalScopeNote(global));

      if (role === 'assigned') {
        notes.push(
          '若你在禅道里的角色是「解决人」而不是「被指派人」，把 role 改成 resolved / edited / any 试试。'
        );
      }
      if (global && global.failedProducts.length) {
        notes.push(`⚠️ 有 ${global.failedProducts.length} 个产品的 Bug 没拉到，结果可能不完整。`);
      }
      if (usedServer && typeof serverTodoCount === 'number' && serverTodoCount > 0) {
        notes.push(`服务端自报「待处理」计数（todoCount.bug）：${serverTodoCount} 条。`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: [header, ...notes, statusText ? `状态分布：${statusText}` : '', '', ...lines]
            .filter((s) => s !== '')
            .join('\n')
            .trim(),
        },
      ],
      structuredContent: {
        account: me,
        role,
        scope: scopeLabel,
        source: sourceLabel,
        includeClosed,
        bugs: shaped,
        total,
        scanned,
        page,
        limit,
        pageTotal,
        ...(typeof serverTodoCount === 'number' ? { serverTodoCount } : {}),
        ...(global
          ? { productScanned: global.productCount, shadowProductScanned: global.shadowProductCount }
          : {}),
      } satisfies {
        account: string;
        role: string;
        scope: string;
        source: string;
        includeClosed: boolean;
        bugs: any[];
        total: number;
        scanned: number;
        page: number;
        limit: number;
        pageTotal: number;
        serverTodoCount?: number;
        productScanned?: number;
        shadowProductScanned?: number;
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `获取「我的 Bug」失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}

/**
 * 统计「各身份各命中多少（仅未关闭）」。
 *
 * 已有本地数据时直接用；缺的身份走一次服务端「地盘」接口补上（只有结果为空时才调用，
 * 所以正常路径上不会多花请求）。`edited` 没有对应的服务端 tab，如实标注为「不支持」。
 */
async function countByRole(
  client: ZenTaoClient,
  known: any[],
  currentRole: MyBugRole,
  currentServerType: MyWorkBugType | undefined,
  usedServer: boolean,
  me: string
): Promise<string> {
  if (!usedServer) {
    const unresolved = known.filter((b) => String(b.status || '').toLowerCase() !== 'closed');
    const parts = (Object.keys(ROLE_FIELDS) as Array<Exclude<MyBugRole, 'any'>>).map(
      (r) => `${ROLE_LABELS[r]} ${unresolved.filter((b) => matchRole(b, r, me)).length}`
    );
    return `${parts.join(' / ')}（本次共扫描 ${known.length} 条，其中未关闭 ${unresolved.length} 条）`;
  }

  const counts: string[] = [];
  for (const r of SERVER_BACKED_ROLES) {
    const type = ROLE_TO_MY_WORK_TYPE[r];
    if (!type) continue;
    let bugs: any[] = [];
    if (r === currentRole && type === currentServerType) {
      bugs = known;
    } else {
      try {
        bugs = (await fetchMyWorkBugs(client, type)).bugs;
      } catch {
        counts.push(`${ROLE_LABELS[r]} ?`);
        continue;
      }
    }
    const open = bugs.filter((b) => String(b.status || '').toLowerCase() !== 'closed').length;
    counts.push(`${ROLE_LABELS[r]} ${open}`);
  }
  counts.push(`${ROLE_LABELS.edited} 暂不支持（服务端地盘无此 tab）`);
  return `${counts.join(' / ')}（来源：服务端地盘接口）`;
}
