/**
 * 过滤表达式（借鉴官方 CLI 的 `--filter`）
 *
 * 官方 CLI 的写法：
 *   --filter='status:active'                 等于
 *   --filter='severity<=2,pri<=2'            与（逗号）
 *   --filter='status:active' --filter='status:resolved'   或（重复该参数）
 * 支持运算符：`:` 等于 / `!=` 不等于 / `>` `<` `>=` `<=` 大小比较 /
 *             `~` 包含 / `!~` 不包含
 *
 * ⚠️ 为什么是「本地」过滤？
 * 禅道 API 2.0 的列表接口虽然定义了 `filters` 参数，但**实测本实例完全忽略它**
 * （传什么条件返回值都不变）。所以这里把过滤放在本地做，保证「说筛就真筛」。
 * 代价是需要放大拉取，见 `src/utils/browse.ts` 的同款策略。
 */

/** 支持的运算符（长的写在前面，解析时优先匹配） */
const OPERATORS = ['!=', '<=', '>=', '!~', ':', '>', '<', '~'] as const;

export type FilterOperator = (typeof OPERATORS)[number];

export interface FilterClause {
  /** 字段名，如 `status`、`pri` */
  field: string;
  /** 运算符 */
  op: FilterOperator;
  /** 比较值（字符串，比较时按需转数字） */
  value: string;
}

/** 多个条件之间的连接方式 */
export type FilterJoin = 'and' | 'or';

/**
 * 解析过滤表达式字符串。
 *
 * 语法：条件是「字段 + 运算符 + 值」，多个条件用逗号分隔。
 * 例：`status:active,pri<=2,title~登录`
 *
 * 值里若含有逗号，会被误拆——这是刻意的取舍：禅道字段值极少含逗号，
 * 真需要匹配逗号时用 `~` 反而更合适。
 */
export function parseFilterExpr(expr?: string | null): FilterClause[] {
  if (!expr) return [];
  const clauses: FilterClause[] = [];

  for (const raw of String(expr).split(',')) {
    const text = raw.trim();
    if (!text) continue;

    // 从最长的运算符开始试，避免 `!=` 被误判成 `!` + `=`
    let matched: FilterOperator | null = null;
    let index = -1;
    for (const op of OPERATORS) {
      const at = text.indexOf(op);
      if (at > 0 && (index === -1 || at < index)) {
        // 取「最先出现」的运算符；同位置时长的优先（OPERATORS 已按长度降序）
        if (index === -1 || at < index) {
          matched = op;
          index = at;
        }
      }
    }

    if (!matched || index <= 0) continue;

    const field = text.slice(0, index).trim();
    const value = text.slice(index + matched.length).trim();
    if (!field) continue;
    clauses.push({ field, op: matched, value });
  }

  return clauses;
}

/** 取值转成可比较的形态：纯数字转 number，其余保持字符串 */
function coerce(value: unknown): number | string {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null) return '';
  const text = String(value).trim();
  if (text === '') return '';
  // 只认纯数字，避免把 '2023-11-01' 误转成 NaN
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

/** 判断单个条件是否命中 */
export function matchClause(item: Record<string, any>, clause: FilterClause): boolean {
  const actual = item?.[clause.field];
  const expected = clause.value;

  // 字段是数组时（如 openedBuild），任一元素命中即算命中
  if (Array.isArray(actual)) {
    const anyHit = actual.some((v) => matchClause({ v }, { ...clause, field: 'v' }));
    return clause.op === '!~' || clause.op === '!=' ? !anyHit : anyHit;
  }

  switch (clause.op) {
    case ':':
      return String(actual ?? '') === expected;
    case '!=':
      return String(actual ?? '') !== expected;
    case '~':
      return String(actual ?? '')
        .toLowerCase()
        .includes(expected.toLowerCase());
    case '!~':
      return !String(actual ?? '')
        .toLowerCase()
        .includes(expected.toLowerCase());
    default: {
      // 大小比较：两边都是数字时按数字比，否则按字符串比
      const a = coerce(actual);
      const b = coerce(expected);
      if (typeof a === 'number' && typeof b === 'number') {
        if (clause.op === '>') return a > b;
        if (clause.op === '<') return a < b;
        if (clause.op === '>=') return a >= b;
        return a <= b; // '<='
      }
      const sa = String(a);
      const sb = String(b);
      if (clause.op === '>') return sa > sb;
      if (clause.op === '<') return sa < sb;
      if (clause.op === '>=') return sa >= sb;
      return sa <= sb; // '<='
    }
  }
}

/**
 * 对列表应用过滤条件。
 *
 * @param list 待过滤列表
 * @param expr 过滤表达式，如 `status:active,pri<=2`
 * @param join 条件之间是「与」还是「或」，默认 and
 */
export function applyFilterExpr<T extends Record<string, any>>(
  list: T[],
  expr?: string | null,
  join: FilterJoin = 'and'
): T[] {
  const clauses = parseFilterExpr(expr);
  if (!clauses.length) return list;

  return list.filter((item) =>
    join === 'or'
      ? clauses.some((clause) => matchClause(item, clause))
      : clauses.every((clause) => matchClause(item, clause))
  );
}

/**
 * 便捷过滤：按「字段 → 期望值」的等值表过滤（用于工具里的具名参数，
 * 如 `status` / `severity` / `assignedTo`）。
 * 值为 undefined / null / '' 时跳过该条件。
 */
export function applyEqualityFilters<T extends Record<string, any>>(
  list: T[],
  conditions: Record<string, unknown>
): T[] {
  const entries = Object.entries(conditions).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (!entries.length) return list;

  return list.filter((item) =>
    entries.every(([field, value]) => String(item?.[field] ?? '') === String(value))
  );
}

/** 关键词模糊搜索：命中任一指定字段即算命中（大小写不敏感） */
export function applyKeywordSearch<T extends Record<string, any>>(
  list: T[],
  keyword?: string | null,
  fields: string[] = ['title', 'steps']
): T[] {
  const kw = String(keyword ?? '').trim().toLowerCase();
  if (!kw) return list;
  return list.filter((item) =>
    fields.some((field) =>
      String(item?.[field] ?? '')
        .toLowerCase()
        .includes(kw)
    )
  );
}
