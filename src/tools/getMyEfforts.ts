/**
 * 「地盘 → 日志（工时）」查询
 *
 * ```
 *   网页   index.php?m=my&f=effort&type=lastmonth&orderBy=date_desc&recPerPage=100
 *   接口   GET /api.php/v2/my/effort?type=lastmonth&orderBy=date_desc&recPerPage=100
 * ```
 *
 * 官方 CLI **没有**这个能力：模块清单里根本没有 `effort`（`zentao ls effort` → E2001），
 * 它依赖的官方 SDK `zentao-api` 里也搜不到 `effort` / `工时` 字样（0.3.1 与 0.7.0 都查过）。
 * 而本实例的 `/my/effort` 实测可用，所以这是**本项目相对官方的独占能力**。
 *
 * ## 实测要点（2026-10-09，实例 MAX8.2 / 账号 your-account）
 *
 * 1. **分页参数是 `pageID` + `recPerPage`，不是 `page`**。
 *    `?page=2` 会被静默忽略（`pager.pageID` 恒为 1，翻页拿回第一页），
 *    而 `?pageID=2` 正常生效。`client.paginationParams()` 已经处理成 v2 的写法，直接用它。
 * 2. **`recPerPage` 可以开很大**：`1000` 一次就把全部 938 条吐出来（`pager.pageTotal` 变 1）。
 *    所以「要全量」不用循环翻页，把 `recPerPage` 调大即可。
 * 3. ⛔ **不要用 POST 打这个接口**。实测 `POST /my/effort`（带任何 body）会直接触发服务端
 *    `SQLSTATE[42S22]`（未知列）的 DAO 异常并返回框架报错栈 —— 它被路由到了写分支。
 *    只读查询一律用 **GET**。
 * 4. ⚠️ **`date` 参数不被 API 转发**（这是最容易踩的坑）。网页上点某一天用的
 *    `index.php?m=my&f=effort&date=20261015` 里的 `date`，经 `api.php/v2` 之后**完全失效**：
 *    紧凑 `20261015`、`2026-10-15` 两种写法都试过，都返回全量 938 条。
 *    一并被静默忽略的还有 `begin` / `end` / `start` / `date1` / `date2` / `dateFrom` / `dateTo` /
 *    `from` / `to` / `startDate` / `endDate` / `beginDate` / `startTime` / `endTime` /
 *    `date[begin]` / `date[end]` / `date=a~b` / `date=a,b`。
 *    **所以本工具的日期过滤全部是本地做的** —— `date` / `begin` / `end` 是我们自己加的参数，
 *    不是服务端契约（结果里会标 `rangeMode` 说明走的是哪条路）。
 * 5. **服务端只认 `type` 预设**，且取值相对「今天」解释：`lastmonth` 实测返回上月 1 号到月末。
 *    给不支持的取值（如 `thisyear` / `lastyear`）**不报错、只返回 0 条** ——
 *    所以「0 条」既可能是真没有，也可能是取值不支持，工具会把这个歧义提示出来。
 * 6. **`orderBy` 服务端生效**：`date_asc` / `id_asc` 实测都能改变首条。
 * 7. 列表字段名是 `efforts`；条目字段：
 *    `id / objectType / objectID / product / project / execution / account / work /
 *    date / left / consumed / begin / end / dept / order / deleted / vision / extra`。
 *    `objectType === 'custom'` 表示**自定义日志**（不挂任务/需求），此时 `objectID` 为 0。
 * 8. ⚠️ **响应里内嵌了完整 `user` 对象**（含 `password` MD5、`resetToken`、`ip`、`last`）。
 *    本工具**只提取 `efforts` 列表**，绝不把那个 `user` 对象透出去 —— 改这里时别顺手加 `raw`。
 *
 * ## 与其它工具的分工
 *
 * | 场景 | 用哪个 |
 * | --- | --- |
 * | 「我这个月填了多少工时 / 都填了啥」 | **本工具** |
 * | 「我有哪些任务 / 需求 / 待办」 | `zendao_list_my_work` |
 * | 「我有哪些 Bug 要处理」 | `zendao_list_my_bugs` |
 *
 * 本工具**只读**；禅道的日志写入（新增/编辑工时）不在范围内。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { applyPick, sortItems } from '../utils/fields';
import { applyKeywordSearch } from '../utils/filter';
import { extractList } from '../utils/response';

/** 服务端支持的 `type` 预设（相对「今天」解释） */
export type MyEffortRangeType =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'thisweek'
  | 'lastweek'
  | 'thismonth'
  | 'lastmonth';

/** `type` → 中文说明（拼文案用） */
export const MY_EFFORT_TYPE_LABELS: Record<MyEffortRangeType, string> = {
  all: '全部',
  today: '今天',
  yesterday: '昨天',
  thisweek: '本周',
  lastweek: '上周',
  thismonth: '本月',
  lastmonth: '上月',
};

export interface ListMyEffortsArgs {
  /** 服务端时间口径预设，默认 all */
  type?: MyEffortRangeType;
  /**
   * 单个日期（本地过滤）。接受 `20261015`、`2026-10-15`、`2026/10/15` 三种写法。
   * 等价于同时传 `begin` 与 `end`，不能与它们同时使用。
   */
  date?: string;
  /** 起始日期（含，本地过滤） */
  begin?: string;
  /** 截止日期（含，本地过滤） */
  end?: string;
  /** 关键词，在「工作内容」里模糊匹配（本地） */
  keyword?: string;
  /** 服务端排序，默认 date_desc */
  orderBy?: string;
  /** 是否附带按日 / 按月的工时汇总，默认 true */
  summary?: boolean;
  page?: number;
  limit?: number;
  sort?: string;
  pick?: string;
}

/** 一条工时日志的规范化形态 */
interface EffortRow {
  id: number | string;
  date: string;
  work: string;
  consumed: number;
  left: number;
  objectType: string;
  objectID: number | string;
  project: number | string;
  execution: number | string;
  product: number | string;
  account: string;
  [key: string]: any;
}

/** 每次请求向服务端要多少条。实测 1000 可用且能一次拿全，别调小。 */
const PAGE_SIZE = 1000;
/** 翻页上限：防某个账号日志极多时把客户端拖死（1000 × 20 = 2 万条） */
const MAX_PAGES = 20;

/**
 * 解析日期，兼容三种写法：`2026-10-15` / `2026/10/15` / `20261015`。
 *
 * 为什么要兼容紧凑写法：网页「地盘 → 日志」点某天时 URL 里就是 `date=20261015`，
 * 用户会照着这个格式传进来。
 */
function parseDate(value: string | undefined, field: string): { value?: string; error?: string } {
  const raw = String(value ?? '').trim();
  if (!raw) return {};

  let y = '';
  let mo = '';
  let d = '';
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    [, y, mo, d] = compact;
  } else {
    const sep = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
    if (!sep) {
      return { error: `${field} 需要日期格式（20261015 或 2026-10-15），收到「${raw}」` };
    }
    [, y, mo, d] = sep;
  }

  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { error: `${field} 不是有效日期：「${raw}」` };
  }
  const padded = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const parsed = new Date(`${padded}T00:00:00`);
  // 防 2026-02-31 这种「格式对但日子不存在」的值被 Date 静默滚到 3 月
  if (Number.isNaN(parsed.getTime()) || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) {
    return { error: `${field} 不是有效日期：「${raw}」` };
  }
  return { value: padded };
}

/**
 * 把一条原始日志规范化。
 *
 * 禅道返回的数值字段可能是字符串（`consumed: "8"`），统一转成 number，
 * 否则后面求和会变成字符串拼接 —— 本项目在 `estimate` 上踩过同类坑。
 */
function normalizeRow(raw: any): EffortRow {
  const num = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    ...raw,
    id: raw?.id ?? '',
    date: String(raw?.date ?? ''),
    work: String(raw?.work ?? ''),
    consumed: num(raw?.consumed),
    left: num(raw?.left),
    objectType: String(raw?.objectType ?? ''),
    objectID: raw?.objectID ?? 0,
    project: raw?.project ?? 0,
    execution: raw?.execution ?? 0,
    product: raw?.product ?? 0,
    account: String(raw?.account ?? ''),
  };
}

/** 保留一位小数，避免 `2471.4000000000005` 这种浮点噪声进输出 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 拉取指定口径下的全部工时日志。
 *
 * 内部按 `pager.pageTotal` 翻页，`recPerPage` 用 1000，
 * 所以常规数据量下**一次请求**就能取完。
 *
 * ⚠️ 必须用 GET —— 实测 POST 会触发服务端 SQL 异常（见文件头注释第 3 条）。
 */
async function fetchEfforts(
  client: ZenTaoClient,
  type: MyEffortRangeType,
  orderBy: string
): Promise<{ rows: EffortRow[]; recTotal: number; pagesFetched: number; truncated: boolean }> {
  const rows: EffortRow[] = [];
  const seen = new Set<string>();
  let recTotal = 0;
  let pageTotal = 1;
  let pagesFetched = 0;

  for (let page = 1; page <= pageTotal && page <= MAX_PAGES; page++) {
    const res = await client.get<any>('/my/effort', {
      type,
      orderBy,
      ...client.paginationParams(page, PAGE_SIZE),
    });

    const { list, pager } = extractList<any>(res, 'efforts', PAGE_SIZE);

    recTotal = pager.total || recTotal;
    pageTotal = pager.pageTotal || 1;
    pagesFetched++;

    for (const item of list) {
      const id = String(item?.id ?? '');
      // 翻页期间数据可能被改动导致重复，按 id 去重
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(normalizeRow(item));
    }
  }

  return { rows, recTotal, pagesFetched, truncated: pageTotal > MAX_PAGES };
}

/**
 * 查询当前账号的工时日志。
 *
 * 签名里的 `_cache` 是为了与其它工具保持一致的调用约定
 * （注册处统一传 `(client, cache, args)`）；工时日志本身不做缓存 ——
 * 数据随时会被用户补填，缓存反而容易给出过期结果。
 */
export async function listMyEfforts(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  params?: ListMyEffortsArgs
): Promise<ToolResult> {
  const args: ListMyEffortsArgs = params || {};
  const me = client.currentAccount;
  const type = (args.type || 'all') as MyEffortRangeType;

  if (!MY_EFFORT_TYPE_LABELS[type]) {
    return {
      content: [
        {
          type: 'text',
          text:
            `不支持的 type: ${type}。可选值：` +
            `${Object.keys(MY_EFFORT_TYPE_LABELS).join(' / ')}（相对「今天」解释）。` +
            '服务端对不支持的取值不报错、只返回 0 条，所以这里直接拦下来，免得你误以为「没有数据」。',
        },
      ],
      isError: true,
    };
  }

  // ── 日期参数：date 是 begin/end 的简写，三者互斥 ──
  if (args.date && (args.begin || args.end)) {
    return {
      content: [
        {
          type: 'text',
          text: '`date` 是「单日」简写，与 `begin` / `end` 互斥，请只传一种。',
        },
      ],
      isError: true,
    };
  }

  const single = parseDate(args.date, 'date');
  const begin = parseDate(args.begin, 'begin');
  const end = parseDate(args.end, 'end');
  const parseError = single.error || begin.error || end.error;
  if (parseError) {
    return {
      content: [
        {
          type: 'text',
          text:
            `${parseError}\n\n` +
            '（本工具的 date / begin / end 是**本地过滤**。原因：实测服务端只认 type 预设，' +
            'date、begin、end 这些参数名经 api.php/v2 之后全被静默忽略。）',
        },
      ],
      isError: true,
    };
  }

  // begin/end 只会有一个来源，合并成最终区间
  const rangeBegin = single.value || begin.value;
  const rangeEnd = single.value || end.value;

  if (rangeBegin && rangeEnd && rangeBegin > rangeEnd) {
    return {
      content: [{ type: 'text', text: `起始日期(${rangeBegin}) 晚于截止日期(${rangeEnd})，区间为空。` }],
      isError: true,
    };
  }

  try {
    const orderBy = args.orderBy || 'date_desc';
    const order = orderBy.endsWith('_asc') ? 'asc' : 'desc';

    const { rows, recTotal, pagesFetched, truncated } = await fetchEfforts(client, type, orderBy);
    const scanned = rows.length;

    // ── 本地过滤 ──
    let filtered = rows.slice();
    const rangeParts: string[] = [];
    if (rangeBegin) {
      filtered = filtered.filter((r) => r.date >= rangeBegin);
      rangeParts.push(`>= ${rangeBegin}`);
    }
    if (rangeEnd) {
      filtered = filtered.filter((r) => r.date <= rangeEnd);
      rangeParts.push(`<= ${rangeEnd}`);
    }
    if (args.keyword) {
      filtered = applyKeywordSearch(filtered as any[], args.keyword, ['work']).map(normalizeRow);
    }

    // ── 排序：本地过滤后按同一口径重排，保证顺序不跑偏 ──
    filtered.sort((a, b) => {
      const cmp = String(a.date).localeCompare(String(b.date));
      if (cmp !== 0) return order === 'asc' ? cmp : -cmp;
      const ai = Number(a.id) || 0;
      const bi = Number(b.id) || 0;
      return order === 'asc' ? ai - bi : bi - ai;
    });
    if (args.sort) {
      filtered = sortItems(filtered as any[], args.sort).map(normalizeRow);
    }

    const total = filtered.length;
    const hoursTotal = round1(filtered.reduce((s, r) => s + r.consumed, 0));
    const leftTotal = round1(filtered.reduce((s, r) => s + r.left, 0));

    // ── 汇总（按日 / 按月）──
    const byDate: Record<string, number> = {};
    const byMonth: Record<string, number> = {};
    for (const r of filtered) {
      if (!r.date) continue;
      byDate[r.date] = round1((byDate[r.date] || 0) + r.consumed);
      const month = r.date.slice(0, 7);
      byMonth[month] = round1((byMonth[month] || 0) + r.consumed);
    }

    const page = args.page || 1;
    const limit = args.limit || 20;
    const paged = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const pageTotal = Math.max(1, Math.ceil(total / limit));
    const picked = applyPick(paged as any[], args.pick);

    // ── 文案 ──
    const typeLabel = MY_EFFORT_TYPE_LABELS[type];
    const rangeLabel = single.value
      ? `，单日 ${single.value}`
      : rangeParts.length
        ? `，本地再筛 ${rangeParts.join(' 且 ')}`
        : '';
    const keywordLabel = args.keyword ? `，关键词「${args.keyword}」` : '';

    const dates = filtered.map((r) => r.date).filter(Boolean).sort();
    const header =
      total === 0
        ? `没有符合条件的工时日志（账号 ${me || '未知'}，口径：${typeLabel}${rangeLabel}${keywordLabel}）`
        : `工时日志（账号 ${me || '未知'}，口径：${typeLabel}${rangeLabel}${keywordLabel}）：` +
          `共 ${total} 条，合计 ${hoursTotal} 小时，${dates[0]} ~ ${dates[dates.length - 1]}；` +
          `第 ${page}/${pageTotal} 页，本页 ${picked.length} 条`;

    const notes: string[] = [];
    notes.push(
      `数据源：GET /my/effort（与网页「地盘 → 日志」同一通路），口径 type=${type}&orderBy=${orderBy}` +
        `${pagesFetched > 1 ? `，翻了 ${pagesFetched} 页` : '，一次取回'}` +
        (truncated ? `（⚠️ 已达翻页上限 ${MAX_PAGES} 页，结果可能不完整）` : '')
    );
    if (rangeLabel) {
      notes.push(
        '注：日期过滤是**本地做的** —— 实测服务端只认 `type` 预设，' +
          '`date`（含 `20261015` 紧凑写法）/ `begin` / `end` 这些参数经 api.php/v2 一律被静默忽略。'
      );
    }
    if (total === 0 && scanned > 0) {
      notes.push(`注：服务端返回 ${scanned} 条，本地过滤后剩 0 条（口径或区间收窄了）。`);
    }
    if (total === 0 && scanned === 0) {
      notes.push(
        `注：服务端口径「${typeLabel}」本身就返回 0 条。两种可能：① 该时间段确实没填日志；` +
          '② 这个 type 取值不被本实例支持（服务端对不支持的取值不报错、只回空）。' +
          '想确认就换成 `type: "all"` 再看总数。'
      );
    }
    if (leftTotal > 0) {
      notes.push(`这些日志的剩余工时（left）合计 ${leftTotal} 小时。`);
    }
    if (args.summary !== false && total > 0) {
      const months = Object.entries(byMonth).sort();
      if (months.length > 1) {
        notes.push(`按月：${months.map(([m, h]) => `${m} ${h}h`).join(' / ')}`);
      }
    }

    const lines = picked.map((r) => {
      const obj = r.objectType === 'custom' ? '自定义' : `${r.objectType}#${r.objectID}`;
      const bits = [`${r.date || '无日期'}`, `${r.consumed}h`, obj];
      if (r.left > 0) bits.push(`剩余 ${r.left}h`);
      if (r.project) bits.push(`项目 ${r.project}`);
      if (r.execution) bits.push(`执行 ${r.execution}`);
      return `• [${r.id}] ${r.work || '(无内容)'}\n  ${bits.join(' | ')}`;
    });

    return {
      content: [
        {
          type: 'text',
          text: [header, ...notes, '', ...lines].filter((s) => s !== '').join('\n').trim(),
        },
      ],
      structuredContent: {
        account: me || '',
        type,
        typeLabel,
        date: single.value || '',
        begin: rangeBegin || '',
        end: rangeEnd || '',
        rangeMode: single.value || rangeParts.length ? 'local' : 'server-type',
        keyword: args.keyword || '',
        orderBy,
        source: `GET /my/effort?type=${type}&orderBy=${orderBy}`,
        items: picked,
        total,
        scanned,
        page,
        limit,
        pageTotal,
        hoursTotal,
        leftTotal,
        days: Object.keys(byDate).length,
        serverRecTotal: recTotal,
        byDate: args.summary === false ? undefined : byDate,
        byMonth: args.summary === false ? undefined : byMonth,
      },
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text:
            `获取工时日志失败：${error?.message || '未知错误'}\n\n` +
            '服务端「地盘 → 日志」接口（GET /my/effort）不可用。可能原因：\n' +
            '  · 这个禅道版本没有 /my/effort（官方 CLI 从来就不覆盖工时，本项目是直连 web 动作）；\n' +
            '  · 认证失效或当前账号无权限。\n' +
            '备选：让用户直接打开网页「地盘 → 日志」查看；或先 `zendao_list_my_work { mode: "task" }` ' +
            '看看任务维度的数据。',
        },
      ],
      isError: true,
    };
  }
}
