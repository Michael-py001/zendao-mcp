/**
 * 字段摘取与排序
 *
 * 借鉴自官方 CLI 的 `--pick` / `--sort`：
 * 禅道返回的对象动辄四五十个字段（一大半是内部字段、审计字段），
 * 全量塞给 LLM 既贵又吵。让调用方按需摘字段、按需排序，是性价比最高的优化。
 */

/** 把 pick 参数统一成字段名数组。支持 `"id,name"` 或 `['id','name']` 两种写法 */
export function normalizePick(pick?: string | string[] | null): string[] {
  if (!pick) return [];
  const raw = Array.isArray(pick) ? pick : String(pick).split(',');
  return raw
    .map((field) => String(field).trim())
    .filter(Boolean);
}

/**
 * 从单个对象里摘取指定字段。
 * 字段不存在时跳过（不塞 undefined，避免污染 JSON 输出）。
 */
export function pickFields<T extends Record<string, any>>(
  item: T,
  fields: string[]
): Partial<T> {
  if (!fields.length || !item || typeof item !== 'object') return item;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(item, field)) {
      out[field] = item[field];
    }
  }
  return out as Partial<T>;
}

/** 对列表批量摘取字段 */
export function applyPick<T extends Record<string, any>>(list: T[], pick?: string | string[] | null): any[] {
  const fields = normalizePick(pick);
  if (!fields.length) return list;
  return list.map((item) => pickFields(item, fields));
}

/**
 * 解析排序表达式，兼容两种写法：
 * - `id:desc`（官方文档写法）
 * - `id_desc`（禅道接口原生写法）
 *
 * @returns [字段名, 是否降序]
 */
export function parseOrderBy(orderBy?: string | null): [string, boolean] | null {
  if (!orderBy) return null;
  const raw = String(orderBy).trim();
  if (!raw) return null;

  const colon = raw.split(':');
  if (colon.length === 2) {
    const field = colon[0].trim();
    const dir = colon[1].trim().toLowerCase();
    if (!field) return null;
    return [field, dir === 'desc' || dir === 'descending'];
  }

  const underscore = raw.match(/^(.+)_(asc|desc)$/i);
  if (underscore) {
    return [underscore[1], underscore[2].toLowerCase() === 'desc'];
  }

  return [raw, false];
}

/**
 * 按字段排序（本地内存排序）。
 * 数值按数值比，字符串按本地化比较；缺失值统一排在最后。
 */
export function sortItems<T extends Record<string, any>>(list: T[], orderBy?: string | null): T[] {
  const parsed = parseOrderBy(orderBy);
  if (!parsed) return list;
  const [field, desc] = parsed;

  const sorted = [...list].sort((a, b) => {
    const va = a?.[field];
    const vb = b?.[field];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    const na = Number(va);
    const nb = Number(vb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;

    // 注意用 vb（原始值）而不是 nb（Number 转换结果）——
    // 走到这里说明至少有一边不是数字，nb 很可能是 NaN，
    // 拿它去比会变成跟字符串 "NaN" 比较，排序结果完全错乱。
    return String(va).localeCompare(String(vb), 'zh-CN');
  });

  return desc ? sorted.reverse() : sorted;
}
