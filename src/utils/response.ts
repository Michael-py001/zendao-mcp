/**
 * 禅道 API 2.0 响应结构解析
 *
 * 2.0 的列表接口返回形态高度统一：
 *   { "status": "success", "<资源名>": [...], "pager": { recTotal, pageID, recPerPage, pageTotal, ... } }
 *
 * 例如 `/executions/43/tasks` → `{ status, tasks: [...], pager: {...} }`
 *
 * 这个小模块把「取列表 + 读分页」这一步收口，避免每个工具各自写一遍
 * 又各自漏掉某一种字段名（v1 的 total/limit、v2 的 pager.recTotal 都得认）。
 */

import { parseOrderBy, sortItems } from './fields';

/**
 * ID 字典顺序还原时的缺省排序：禅道列表页的默认口径。
 * 实测 `/my/work`（bugs）与不带 productID 的 `/bugs` 都返回 `orderBy: "id_desc"`。
 */
const DEFAULT_DICT_ORDER = 'id_desc';

/** 归一化后的分页信息 */
export interface PagerInfo {
  /** 总条数 */
  total: number;
  /** 当前页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  limit: number;
  /** 总页数 */
  pageTotal: number;
}

/** 列表解包结果 */
export interface ListResult<T> {
  list: T[];
  pager: PagerInfo;
}

/**
 * 从响应里取出列表与分页信息。
 *
 * 同时兼容四种形态，保证切版本或换禅道部署方式时不会突然拿不到数据：
 * - 2.0：`{ status, tasks: [...], pager: { recTotal, pageID, recPerPage, pageTotal } }`
 * - 1.0：`{ page, total, limit, tasks: [...] }`
 * - 被网关包一层：`{ status, data: { tasks: [...] } }`
 * - **ID 字典**：`{ status, bugs: { 2010438: {...}, 2010439: {...} } }`
 *   ⚠️ 最后这种是实测发现的坑：不带范围参数的 `/bugs`、`/testcases`、`/testtasks`
 *   返回的是「页面渲染上下文」，真正的数据以**对象 ID 为键**存放，不是数组。
 *   直接用会得到 `undefined`，看着像接口坏了。
 *
 * @param res 原始响应
 * @param listKey 资源字段名，如 `'tasks'`、`'projects'`、`'executions'`、`'bugs'`
 * @param requestedLimit 调用方请求的每页条数，用于兜底
 */
export function extractList<T = any>(
  res: any,
  listKey: string,
  requestedLimit = 50
): ListResult<T> {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' && !res[listKey]
    ? res.data // 兼容被包成 { status, data: {...} } 的部署
    : res;

  // 列表本体：优先用约定的资源名，其次尝试常见别名
  const candidateKeys = [listKey, 'list', 'items', 'data'];
  let list: T[] = [];
  for (const key of candidateKeys) {
    const rawValue = body?.[key];
    const bag = toArray<T>(rawValue);
    if (bag) {
      // ⚠️ 数组天然保序，直接用；ID 字典的顺序已被 JS 整数键规范打乱（见 restoreDictOrder），
      // 必须按服务端自报的 orderBy 重建，否则「我的待处理」这类列表会整个颠倒。
      list = Array.isArray(rawValue) ? bag : restoreDictOrder(bag, body?.orderBy);
      break;
    }
  }
  // 最坏情况：响应本身就是数组
  if (!list.length) {
    const self = toArray<T>(body);
    if (self) list = self;
  }

  const pager = body?.pager || {};

  const total = firstNumber(
    pager.recTotal,
    body?.total,
    body?.recTotal,
    body?.count,
    list.length
  );

  const limit = firstNumber(pager.recPerPage, body?.limit, body?.recPerPage, requestedLimit);
  const page = firstNumber(pager.pageID, body?.page, body?.pageID, 1);
  const pageTotal = firstNumber(
    pager.pageTotal,
    body?.pageTotal,
    limit > 0 ? Math.ceil(total / limit) : 1
  );

  return {
    list,
    pager: { total, page, limit, pageTotal },
  };
}

/** 从一组候选值里取第一个有效数字 */
function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const num = Number(value);
    if (!Number.isNaN(num) && value !== null && value !== undefined && value !== '') {
      return num;
    }
  }
  return 0;
}

/**
 * 把「可能是数组、也可能是 ID 字典」的值统一成数组。
 *
 * 判定规则：
 * - 数组 → 原样返回
 * - 空对象 `{}` → `[]`（表示「这个资源确实没有数据」）
 * - 键**全为数字**且值都是对象 → 视为 ID 字典，取 `Object.values()`
 * - 其余对象（如页面上下文里 `products: {7:'评标系统', ...}` 这种 id→名称映射，
 *   或 `pager`）→ 返回 `null`，表示「这不是我们要的列表」
 *
 * 最后一条很关键：不加区分地把任何对象都 Object.values 化，
 * 会把 `products` 这种「字典」误当成资源列表，返回一堆字符串。
 */
function toArray<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return null;

  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return [];

  const allNumeric = keys.every((key) => /^\d+$/.test(key));
  if (!allNumeric) return null;

  const values = Object.values(value as Record<string, unknown>);
  const allObjects = values.every((v) => v !== null && typeof v === 'object');
  if (!allObjects) return null;

  return values as T[];
}

/**
 * 还原 ID 字典的顺序。
 *
 * ⚠️ 为什么非要有这个函数：v2 的部分列表接口返回的不是数组，而是「ID 字典」
 * （`{ "2010523": {...}, "2010521": {...} }`）。而 **ECMA-262 规定：对象的
 * 「数组索引键」（0 ≤ n < 2³²−1 的整数字符串）在属性枚举中排在最前，且按数值升序** ——
 * 于是 `JSON.parse` 之后，字典键的插入顺序（也就是服务端的排序结果）被永久规范化成升序，
 * `Object.keys` / `Object.values` / `for...in` 全都拿不回来（`JSON.parse` 的 reviver 也救不了，
 * 它拿到的 `this` 已经是规范化后的对象）。
 *
 * 实测证据：服务端原始 JSON 文本是 `2010523, 2010521, …, 2010511`（降序），
 * 同一份数据 `JSON.parse` 后再 `Object.keys` 就变成 `2010511, 2010515, …, 2010523`（升序）。
 * 表现就是「我的待处理 Bug」列表与网页顺序整个颠倒。
 *
 * 补救办法：用服务端自报的 `orderBy` 把字典的值重排一次。这不是凭空发明顺序，
 * 而是把服务端已经排好、被 JS 吃掉的那一层顺序重新算出来。
 *
 * 边界：`orderBy` 指向的字段在元素上不存在时**不排序** —— 宁可不还原，也不要按错字段乱排。
 * 数组不受影响（数组本身保序，调用方不该把它送进来）。
 */
export function restoreDictOrder<T>(values: T[], orderBy?: string | null): T[] {
  const expr = parseOrderBy(orderBy) ? String(orderBy) : DEFAULT_DICT_ORDER;
  const parsed = parseOrderBy(expr);
  if (!parsed) return values;

  const [field] = parsed;
  const usable = values.some(
    (item) => item !== null && typeof item === 'object' && field in (item as Record<string, unknown>)
  );
  if (!usable) return values;

  return sortItems(values as Record<string, any>[], expr) as T[];
}

/**
 * 从响应里取出单个对象。
 * 2.0 的详情接口形如 `{ status: 'success', 'task': { ... } }`，
 * 但也可能是 `{ status: 'success', data: { ... } }`，都认。
 */
export function extractOne<T = any>(res: any, key: string): T | null {
  if (!res || typeof res !== 'object') return null;
  if (res[key] && typeof res[key] === 'object') return res[key] as T;
  if (res.data && typeof res.data === 'object') {
    const inner = res.data;
    if (inner[key] && typeof inner[key] === 'object') return inner[key] as T;
    return inner as T;
  }
  return res as T;
}
