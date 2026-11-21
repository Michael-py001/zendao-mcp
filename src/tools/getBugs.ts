/**
 * Bug 列表与详情
 *
 * 权威端点（来自官方 SDK easysoft/zentao-api 的 bug 模块）：
 *   列表  GET /{scope}/{scopeID}/bugs   （scope：products / projects / executions）
 *   列表  GET /bugs                     （⚠️ 官方定义是全局，但本实例不是 —— 见下）
 *   详情  GET /bugs/{bugID}
 *
 * ⚠️ 三个实测坑，都影响实现：
 *
 * 1. **`GET /bugs` 在本实例不是全库列表。** 不带 `productID` 时它只返回某个产品
 *    （实测固定为产品 9「海上风电平台产品」）的 Bug，而 `pager.recTotal` 也**谎报**
 *    成该产品的条数。看着像「全库 766 条」，其实另有 30+ 个产品的 Bug 完全没出现。
 *    传 `productID=0` / `browseType=all` / `scope=all` 都无效，`productID=all` 直接报错。
 *    → 所以全局范围一律改走 `utils/products.ts` 的 `fetchAllBugs()`（逐产品合并）。
 *
 * 2. **`GET /products` 会漏掉影子产品**（`shadow=1` 的项目型产品）。
 *    只按它遍历产品，会**静默**丢掉整条产品线的 Bug。`fetchAllBugs()` 已用
 *    `/bugs` 响应里的产品字典补齐（见 utils/products.ts）。
 *
 * 3. **全局 `/bugs` 的响应不是数组**，而是页面渲染上下文（25 个顶层键），
 *    真正的数据在 `bugs` 这个**以 ID 为键的对象**里。`extractList` 已做归一化；
 *    但顺带说明：`/products/{id}/bugs` 才是干净数组形态，所以能用范围就优先用。
 *
 * 另注：**`filters` 参数被本实例完全忽略** —— 传 status/pri/title 各种条件，
 * 返回值与不传完全一致。所以条件过滤一律在本地做，并配合「放大拉取」，
 * 避免只筛一页就得出「没数据」的错误结论。
 *
 * 又注：`browseType` 在 Bug 上**是**被服务端解析的（传错值返回 0 而非全量），
 * 但本实例只有 `all` 与 `unresolved` 有明确语义，`closed` / `resolved`
 * 都返回 0 —— 而库里明明有大量已关闭的 Bug。所以这两个值**不作为 browseType 暴露**，
 * 要按状态筛请用 `status` 参数走本地过滤，结果才可信。
 */

import { ToolResult, IBug } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { applyPick, sortItems } from '../utils/fields';
import { convertHtmlFields } from '../utils/html';
import { extractList, extractOne } from '../utils/response';
import { fetchAllBugs } from '../utils/products';
import {
  applyEqualityFilters,
  applyFilterExpr,
  applyKeywordSearch,
  FilterJoin,
} from '../utils/filter';
import { bugStatusLabel, priorityLabel, severityLabel } from '../utils/labels';

export interface ListBugsArgs {
  /** 产品 ID。与 scope 二选一；都不传则查全局 */
  productID?: number;
  /** 显式指定范围（products / projects / executions） */
  scope?: 'products' | 'projects' | 'executions';
  /** 范围 ID */
  scopeID?: number;
  /** 浏览口径。只用本实例确定有语义的两个值 */
  browseType?: 'all' | 'unresolved' | 'assignedtome';
  /** 本地按状态精确筛选：active 激活 / resolved 已解决 / closed 已关闭 */
  status?: string;
  /** 严重程度 1-4（1 最严重） */
  severity?: number;
  /** 优先级 1-4（1 最高） */
  pri?: number;
  /** Bug 类型，如 codeerror / config / performance */
  type?: string;
  /** 指派给（账号） */
  assignedTo?: string;
  /** 关键词，在标题 / 重现步骤里模糊匹配 */
  keyword?: string;
  /** 过滤表达式（官方 CLI 风格），如 `status:active,pri<=2` */
  filter?: string;
  /** 过滤表达式多条件间的连接方式，默认 and */
  filterMode?: FilterJoin;
  orderBy?: string;
  page?: number;
  limit?: number;
  pick?: string;
  sort?: string;
}

const BROWSE_LABELS: Record<string, string> = {
  all: '全部',
  unresolved: '未解决',
  assignedtome: '指派给我',
};

/** 未解决：既不是已解决也不是已关闭 */
const isUnresolved = (status?: string): boolean => {
  const s = String(status || '').toLowerCase();
  return s !== 'resolved' && s !== 'closed';
};

/**
 * 允许传给服务端的 browseType 白名单。
 *
 * ⚠️ `assignedtome` **不在其中** —— 实测本实例传它会返回**空集**（不是报错，是 0 条），
 * 而本地兜底过滤只能在「已拉到的数据」上做，于是最终结果永远是 0 条。
 * 这是**假阴性**：库里明明有指派给我的 Bug，工具却说没有。
 * 所以 assignedtome 一律本地实现，不发给服务端。
 */
const SERVER_BROWSE_TYPES = new Set(['all', 'unresolved']);

/**
 * 单次拉取上限：实测 `limit=1000` 可一次取回全量（本实例 766 条）。
 * 这个值决定本地过滤能"看见"多少数据，调小会直接导致漏筛。
 */
export const MAX_BUG_FETCH = 1000;

/** 全局合并拉取的元信息 */
export interface GlobalBugMeta {
  /** 遍历的产品数 */
  productCount: number;
  /** 被 `/products` 漏掉、靠 `/bugs` 字典补回的影子产品数 */
  shadowProductCount: number;
  /** 拉取失败的产品 ID */
  failedProducts: number[];
  fromCache: boolean;
}

/**
 * 拉取原始 Bug 列表（不加任何本地过滤），供 listBugs / listMyBugs 共用。
 *
 * 关键约定一：**browseType 只有 all / unresolved 才发给服务端**。
 * 一旦调用方打算在本地过滤，就该传 `all` —— 否则服务端先筛一轮、本地再筛一轮，
 * 两次筛选会取交集，例如本地要 `status=resolved` 时会被服务端的 unresolved 口径清空，
 * 而库里明明有已解决的 Bug。
 *
 * 关键约定二：**`path === '/bugs'` 时不打这个端点**，改走 `fetchAllBugs()` 按产品合并。
 * 因为本实例的 `/bugs` 不带 `productID` 时只会返回某个产品（实测固定为产品 9）的 Bug，
 * 却把 `pager.recTotal` 报成该产品条数 —— 直接用它等于**静默丢掉其他产品的全部 Bug**。
 */
export async function fetchRawBugs(
  client: ZenTaoClient,
  opts: {
    path: string;
    browseType?: string;
    serverPage: number;
    fetchLimit: number;
    orderBy?: string;
    cache?: LRUCache<string, any>;
  }
): Promise<{ list: IBug[]; pager: any; global?: GlobalBugMeta }> {
  if (opts.path === '/bugs') {
    const all = await fetchAllBugs(client, opts.cache, undefined, opts.orderBy);
    return {
      list: all.bugs,
      pager: { total: all.bugs.length, page: 1, limit: all.bugs.length, pageTotal: 1 },
      global: {
        productCount: all.productCount,
        shadowProductCount: all.shadowProductCount,
        failedProducts: all.failedProducts,
        fromCache: all.fromCache,
      },
    };
  }

  const query: Record<string, unknown> = {
    ...client.paginationParams(opts.serverPage, opts.fetchLimit),
  };
  if (opts.browseType && opts.browseType !== 'all' && SERVER_BROWSE_TYPES.has(opts.browseType)) {
    query.browseType = opts.browseType;
  }
  if (opts.orderBy) query.orderBy = opts.orderBy;

  const res = await client.get<any>(opts.path, query);
  return extractList<IBug>(res, 'bugs', opts.fetchLimit);
}

/** 把全局合并元信息拼成一句人能看懂的话 */
export function globalScopeNote(meta: GlobalBugMeta): string {
  const parts = [
    `禅道没有「全库 Bug」接口（/bugs 不带 productID 时只返回单个产品，且分页数会谎报），` +
      `所以全局范围是逐产品合并得到的：已遍历 ${meta.productCount} 个产品`,
  ];
  if (meta.shadowProductCount > 0) {
    parts.push(
      `其中 ${meta.shadowProductCount} 个是 /products 列表漏掉的影子产品（shadow=1），已通过 /bugs 的产品字典补回`
    );
  }
  if (meta.failedProducts.length) {
    parts.push(`⚠️ 有 ${meta.failedProducts.length} 个产品拉取失败（ID: ${meta.failedProducts.join(',')}），结果可能不完整`);
  }
  if (meta.fromCache) parts.push('（本次命中缓存）');
  return parts.join('，') + '。';
}

/**
 * 解析出列表端点与范围描述。
 * 返回 null 表示参数不合法（scope 与 scopeID 必须成对）。
 *
 * 导出供 getMyBugs 复用，保证「我的 Bug」与「Bug 列表」的范围语义完全一致。
 */
export function resolveBugEndpoint(args: {
  scope?: 'products' | 'projects' | 'executions';
  scopeID?: number;
  productID?: number;
}): { path: string; label: string } | null {
  const { scope, scopeID, productID } = args;

  if (scope && scopeID) {
    const labelMap: Record<string, string> = {
      products: '产品',
      projects: '项目',
      executions: '执行',
    };
    return { path: `/${scope}/${scopeID}/bugs`, label: `${labelMap[scope] || scope} ${scopeID}` };
  }
  if (scope && !scopeID) return null; // scope 必须配 scopeID
  if (productID) return { path: `/products/${productID}/bugs`, label: `产品 ${productID}` };
  return { path: '/bugs', label: '全局' };
}

/** 获取 Bug 列表 */
export async function listBugs(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  params?: ListBugsArgs
): Promise<ToolResult> {
  void cache;

  const args: ListBugsArgs = params || {};
  const target = resolveBugEndpoint(args);

  if (!target) {
    return {
      content: [
        {
          type: 'text',
          text:
            'scope 与 scopeID 必须成对提供（scope 可选 products / projects / executions）。\n' +
            '或者改用 productID 只传产品 ID；都不传则查询全局 Bug。',
        },
      ],
      isError: true,
    };
  }

  try {
    const page = args.page || 1;
    const limit = args.limit || 20;
    const browseType = args.browseType || 'all';

    // 全局范围（`/bugs`）必须走「逐产品合并」，理由见 fetchRawBugs 的说明。
    // 也因此它天然需要本地分页 —— 合并后的列表没有服务端分页可言。
    const isGlobal = target.path === '/bugs';

    // 需要本地过滤的情况：全局范围，或除 browseType 之外的任何条件。
    // `assignedtome` 也算 —— 它服务端不认（见 SERVER_BROWSE_TYPES），只能本地兜底。
    const needsLocalFilter =
      isGlobal ||
      !!(
        args.status ||
        args.severity != null ||
        args.pri != null ||
        args.type ||
        args.assignedTo ||
        args.keyword ||
        args.filter ||
        browseType === 'assignedtome'
      );

    // 本地过滤时按单页上限拉满，尽量一次覆盖全量。
    // ⚠️ 这里曾是 500，等于主动丢掉一半数据，截断会直接造成「我的待处理是 0 条」这种假阴性。
    // 当时把原因记成「Bug 列表默认按 id 升序，前 500 条全是已关闭老单」—— 那是一次**误判**：
    // 服务端其实是 `id_desc`（最新在前），「升序」是本地解析把 ID 字典的键顺序规范化的结果
    // （详见 response.ts 的 restoreDictOrder，09-15 已修）。修好后前 N 条才是最新的。
    // 但截断本身依然危险，所以上限保持拉满。
    const fetchLimit = needsLocalFilter ? MAX_BUG_FETCH : limit;
    const serverPage = needsLocalFilter ? 1 : page;

    // 要在本地过滤时，服务端口径一律用 all（见 fetchRawBugs 的说明）。
    const { list, pager, global } = await fetchRawBugs(client, {
      path: target.path,
      browseType: needsLocalFilter ? 'all' : browseType,
      serverPage,
      fetchLimit,
      orderBy: args.orderBy,
      cache,
    });

    // ---- 本地过滤链（幂等：服务端没做就补上，做了也不重复） ----
    let filtered: any[] = list;

    if (browseType === 'unresolved') {
      filtered = filtered.filter((b) => isUnresolved(b.status));
    } else if (browseType === 'assignedtome') {
      const me = client.currentAccount;
      // ⚠️ 不能「拿不到账号就不过滤」—— 那会把全库 766 条当成「我的 Bug」返回，
      // 比报错严重得多。这里必须显式失败。
      if (!me) {
        return {
          content: [
            {
              type: 'text',
              text:
                '无法确定「我」是谁，因此不能使用 browseType=assignedtome。\n' +
                '当前配置用的是静态 ZENTAO_TOKEN，不含账号信息。\n' +
                '请改用 ZENTAO_ACCOUNT + ZENTAO_PASSWORD 登录，' +
                '或直接传 assignedTo 参数显式指定账号。',
            },
          ],
          isError: true,
        };
      }
      filtered = filtered.filter((b) => String(b.assignedTo || '') === me);
    }

    filtered = applyEqualityFilters(filtered, {
      status: args.status,
      severity: args.severity,
      pri: args.pri,
      type: args.type,
      assignedTo: args.assignedTo,
    });

    if (args.keyword) {
      filtered = applyKeywordSearch(filtered, args.keyword, ['title', 'steps']);
    }
    if (args.filter) {
      filtered = applyFilterExpr(filtered, args.filter, args.filterMode || 'and');
    }

    const total = needsLocalFilter ? filtered.length : pager.total;

    // 全局范围没有服务端可分页/可排序的列表（是本地合并来的），
    // 所以 orderBy 在这里降级为本地排序 —— 否则这个参数会被静默忽略。
    if (isGlobal && args.orderBy && !args.sort) {
      filtered = sortItems(filtered as any[], args.orderBy) as any[];
    }

    const paged = needsLocalFilter
      ? filtered.slice((page - 1) * limit, (page - 1) * limit + limit)
      : filtered;

    const sorted = args.sort ? sortItems(paged as any[], args.sort) : paged;

    // ⚠️ 顺序很重要：展示文案要用**未摘字段**的数据渲染。
    // pick 是为了给结构化返回省 token，若拿摘过字段的对象去拼文本，
    // 没被选中的字段会全部显示成「未知 / 未指派」，看起来像接口没返回。
    const display: any[] = convertHtmlFields(sorted) as any[];
    const shaped: any[] = applyPick(display, args.pick);

    const pageTotal = Math.max(1, Math.ceil(total / limit));
    const lines = display.map((b: any) => {
      const parts = [
        `状态: ${bugStatusLabel(b.status)}`,
        `严重: ${severityLabel(b.severity)}`,
        `优先级: ${priorityLabel(b.pri)}`,
      ];
      if (b.type) parts.push(`类型: ${b.type}`);
      parts.push(`指派: ${b.assignedTo || '未指派'}`);
      if (b.resolution) parts.push(`解决方案: ${b.resolution}`);
      const meta = `  ${parts.join(' | ')}`;
      const sub = `    由 ${b.openedBy || '-'} 创建于 ${b.openedDate || '-'}${b.deadline ? ` | 截止 ${b.deadline}` : ''}`;
      return `• [${b.id}] ${b.title}\n${meta}\n${sub}`;
    });

    const browseLabel = BROWSE_LABELS[browseType] || browseType;
    const conds: string[] = [];
    if (args.status) conds.push(`状态=${args.status}`);
    if (args.severity != null) conds.push(`严重=${args.severity}`);
    if (args.pri != null) conds.push(`优先级=${args.pri}`);
    if (args.type) conds.push(`类型=${args.type}`);
    if (args.assignedTo) conds.push(`指派=${args.assignedTo}`);
    if (args.keyword) conds.push(`关键词=${args.keyword}`);
    if (args.filter) conds.push(`表达式=${args.filter}`);

    const subsetNote = isGlobal && global
      ? globalScopeNote(global) +
        (conds.length || browseType !== 'all'
          ? `过滤同样在本地做（**部分实例**会忽略服务端 filters），已扫描 ${list.length} 条。`
          : '')
      : needsLocalFilter
      ? `注：**部分实例**会忽略服务端 filters 参数，所以过滤是本地做的 —— 基于已扫描的 ${list.length} 条` +
        (list.length >= fetchLimit
          ? `（已达单次拉取上限 ${fetchLimit}，若库里总量更大，结果可能未覆盖全部，可换更精确的条件收窄）`
          : '') +
        '。'
      : '';

    const scopeLabel = isGlobal && global ? `全局（合并 ${global.productCount} 个产品）` : target.label;

    const header =
      shaped.length === 0
        ? `没有符合条件的 Bug（范围：${scopeLabel}，口径：${browseLabel}）`
        : `Bug 列表（范围：${scopeLabel}，口径：${browseLabel}${conds.length ? '，' + conds.join('、') : ''}）：` +
          `共 ${total} 条，第 ${page}/${pageTotal} 页，本页 ${shaped.length} 条`;

    return {
      content: [
        {
          type: 'text',
          text: [header, subsetNote, ...lines]
            .filter((s) => s !== undefined && s !== '')
            .join('\n')
            .trim(),
        },
      ],
      structuredContent: {
        scope: scopeLabel,
        browseType,
        bugs: shaped,
        total,
        page,
        limit,
        pageTotal,
        // 全局合并时才有意义：遍历了多少产品、其中多少是被 /products 漏掉的影子产品
        ...(isGlobal && global
          ? { productScanned: global.productCount, shadowProductScanned: global.shadowProductCount }
          : {}),
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `获取 Bug 列表失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}

/** 获取单个 Bug 详情（含操作历史） */
export async function getBug(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  bugId: number,
  options?: { includeActions?: boolean; pick?: string }
): Promise<ToolResult> {
  void cache;

  try {
    const res = await client.get<any>(`/bugs/${bugId}`);
    const bug = extractOne<IBug>(res, 'bug');

    if (!bug || !(bug as any).id) {
      return {
        content: [
          {
            type: 'text',
            text:
              `未找到 Bug ${bugId}。\n` +
              '禅道对不存在的 ID 不会返回 404，而是返回 `{status:"fail"}`，' +
              '所以请用 zendao_list_bugs 确认 ID 是否正确。',
          },
        ],
        isError: true,
      };
    }

    const b: any = convertHtmlFields(bug as any);
    const lines = [
      `[${b.id}] ${b.title}`,
      `  状态: ${bugStatusLabel(b.status, '-')}${b.subStatus ? `(${b.subStatus})` : ''} | 严重: ${severityLabel(b.severity)} | 优先级: ${priorityLabel(b.pri)} | 类型: ${b.type || '-'}`,
      `  产品: ${b.product ?? '-'} | 项目: ${b.project || '-'} | 执行: ${b.execution || '-'} | 模块: ${b.module || '-'}`,
      `  指派给: ${b.assignedTo || '未指派'} | 是否确认: ${String(b.confirmed) === '1' ? '已确认' : '未确认'} | 激活次数: ${b.activatedCount ?? 0}`,
      `  影响版本: ${Array.isArray(b.openedBuild) ? b.openedBuild.join(',') : b.openedBuild || '-'}`,
      `  创建: ${b.openedBy || '-'} @ ${b.openedDate || '-'}`,
    ];
    if (b.deadline) lines.push(`  截止: ${b.deadline}`);
    if (b.resolution) {
      lines.push(
        `  解决: ${b.resolution} by ${b.resolvedBy || '-'} @ ${b.resolvedDate || '-'}（解决版本 ${b.resolvedBuild || '-'}）`
      );
    }
    if (b.closedBy) lines.push(`  关闭: ${b.closedBy} @ ${b.closedDate || '-'}`);
    if (b.steps) lines.push('', '重现步骤:', String(b.steps).slice(0, 1500));

    // 操作历史（可选）：官方 bug/get 会一并返回 actions
    const actions = Array.isArray(res?.actions) ? res.actions : [];
    if (options?.includeActions && actions.length) {
      lines.push('', `操作历史（${actions.length} 条，最近 10 条）:`);
      for (const a of actions.slice(-10)) {
        lines.push(`  · ${a.date || '-'} ${a.actor || '-'} ${a.action || '-'}${a.comment ? ` — ${String(a.comment).slice(0, 80)}` : ''}`);
      }
    }

    // structuredContent 用单键容器 `{ bug: ... }` 承载完整实体（outputSchema = { bug: z.any() }）。
    // 别再摊平到顶层：禅道实体 75 个字段，会撞上 outputSchema 的 additionalProperties:false。
    // pick 只作用于容器里的实体；上面的展示文案依旧用**未摘字段**渲染。
    const bugPayload = options?.pick ? (applyPick([b], options.pick)[0] as any) : { ...b };

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { bug: bugPayload },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `获取 Bug 详情失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}
