/**
 * 展示层「中文化」字典
 *
 * 禅道的字段名与枚举值都是英文（`status: 'active'`、`severity: 3`、`pri: 2`），
 * 直接丢给用户/LLM 可读性差。这里做两件事：
 *
 * 1. **字段名 → 中文名**：直接复用官方 SDK 的静态字典 `getObjectProps(module)`，
 *    不用自己维护一份（官方 26 模块约 1200+ 字段，抄不全也抄不准）。
 * 2. **枚举值 → 中文名**：官方字典里**没有**值的中文（只有字段名的），
 *    所以这里硬编码几个最常用的（Bug/任务/需求状态、严重程度、优先级）。
 *
 * ⚠️ 铁律：**只作用于给人看的文本摘要**。`structuredContent` 的 key 与值一律保持原样，
 * 绝不因为「顺手中文化」而改变结构化契约（否则 `pick` 与 ajv 校验都会崩）。
 *
 * @module utils/labels
 */

import { getSdk } from '../sdk/loader';

/**
 * `objectType` → 字段字典。
 *
 * ⚠️ 原字典是**静态表直接查**，但我们的 SDK 是通过 `await import()` 加载的（ESM 互操作），
 * 所以这个函数只能是 **async**。好在 6 个调用点都在 async 函数里，成本可忽略；
 * 同一 `objectType` 只查一次（下面的 `dictCache`）。
 */
const dictCache = new Map<string, Record<string, string>>();

/**
 * 取某个对象的「字段名 → 中文名」字典。
 *
 * @param objectType 模块/对象名，如 `bug` / `task` / `story`（**大小写不敏感**）
 * @returns 字典；未知类型返回 `{}`（调用方回落英文原名，不丢字段）
 *
 * ⚠️ `getObjectProps` 是**大小写敏感**的（`'Bug'` 会拿到 `{}`），所以这里统一 `.toLowerCase()`。
 * ⚠️ **字典盲区**：服务端拼装出来的字段查不到 —— `productName` / `assignedToRealName` /
 * `storyTitle` / `executionName` 这类「xxx 名字」字段不在字典里，会原样回落英文名。
 */
export async function getFieldLabels(objectType: string): Promise<Record<string, string>> {
  const key = String(objectType ?? '').trim().toLowerCase();
  if (!key) return {};

  const cached = dictCache.get(key);
  if (cached) return cached;

  let dict: Record<string, string> = {};
  try {
    const sdk = await getSdk();
    const raw = sdk.getObjectProps?.(key);
    if (raw && typeof raw === 'object') dict = { ...(raw as Record<string, string>) };
  } catch {
    /* SDK 没加载成功不影响功能，回落英文名 */
  }

  dictCache.set(key, dict);
  return dict;
}

/**
 * 在已有字典上取中文名（同步，供渲染循环里高频调用）。
 *
 * @param labels  `getFieldLabels()` 的结果；可为 `undefined`（直接返回英文原名）
 * @param field   原始字段名，如 `assignedTo`
 * @returns 中文名，如「指派给」；字典没有则返回 `field` 本身
 */
export function fieldLabel(labels: Record<string, string> | undefined, field: string): string {
  if (!labels) return field;
  return labels[field] || field;
}

// ————————————————————————————————————————————————————————————
// 枚举值字典（官方字典只给字段名，值的中文只能自己补）
// ————————————————————————————————————————————————————————————

/** Bug 状态：禅道 `zt_bug.status` */
const BUG_STATUS: Record<string, string> = {
  active: '激活',
  resolved: '已解决',
  closed: '已关闭',
};

/** 任务状态：禅道 `zt_task.status` */
const TASK_STATUS: Record<string, string> = {
  wait: '未开始',
  doing: '进行中',
  done: '已完成',
  pause: '已暂停',
  cancel: '已取消',
  closed: '已关闭',
};

/** 需求/研发需求状态：禅道 `zt_story.status` */
const STORY_STATUS: Record<string, string> = {
  draft: '草稿',
  reviewing: '评审中',
  active: '激活',
  changed: '已变更',
  closed: '已关闭',
};

/** 执行/项目状态：禅道 `zt_project.status`（执行与项目共用一张表） */
const PROJECT_STATUS: Record<string, string> = {
  wait: '未开始',
  doing: '进行中',
  suspended: '已挂起',
  closed: '已关闭',
};

/** 按对象类型分发的状态字典 */
const STATUS_TABLES: Record<string, Record<string, string>> = {
  bug: BUG_STATUS,
  task: TASK_STATUS,
  story: STORY_STATUS,
  epic: STORY_STATUS,
  requirement: STORY_STATUS,
  project: PROJECT_STATUS,
  execution: PROJECT_STATUS,
};

/** 取原值文本：空值返回 `fallback`，字典未收录则原样返回（宁可显示英文也不吞数据） */
function fromTable(table: Record<string, string> | undefined, value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return table?.[raw] ?? raw;
}

/**
 * 状态值 → 中文。
 *
 * @param objectType `bug` / `task` / `story` / `project` / `execution`；不认识则原样返回
 * @param fallback   值为空时的占位（如 `'未知'` / `'-'`）
 */
export function statusLabel(objectType: string, value: unknown, fallback = '未知'): string {
  const key = String(objectType ?? '').trim().toLowerCase();
  return fromTable(STATUS_TABLES[key], value, fallback);
}

/** Bug 状态中文（`active` → 激活） */
export function bugStatusLabel(value: unknown, fallback = '未知'): string {
  return fromTable(BUG_STATUS, value, fallback);
}

/** 任务状态中文（`wait` → 未开始） */
export function taskStatusLabel(value: unknown, fallback = '未知'): string {
  return fromTable(TASK_STATUS, value, fallback);
}

/** 需求状态中文（`draft` → 草稿） */
export function storyStatusLabel(value: unknown, fallback = '未知'): string {
  return fromTable(STORY_STATUS, value, fallback);
}

/**
 * 严重程度（Bug `severity`）：禅道默认 1~4，**数字越小越严重**。
 * 非数字就原样返回。
 */
export function severityLabel(value: unknown, fallback = '-'): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (!/^[1-4]$/.test(raw)) return raw;
  return raw === '1' ? '1级(最严重)' : `${raw}级`;
}

/**
 * 优先级（`pri`，Bug/任务/需求通用）：禅道默认 1~4，**数字越小优先级越高**。
 * 非数字就原样返回。
 */
export function priorityLabel(value: unknown, fallback = '-'): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (!/^[1-4]$/.test(raw)) return raw;
  return raw === '1' ? '1级(最高)' : `${raw}级`;
}
