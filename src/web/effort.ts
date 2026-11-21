/**
 * 禅道日志（工时）的 **网页表单写入**
 *
 * REST 只能在「挂任务」时写工时（`POST api.php/v1/tasks/{id}/estimate`），
 * 而**自定义日志**（`objectType=custom`，不挂任务/Bug）以及**编辑、删除**都没有 REST 通路。
 * 本模块走网页表单补齐这几块。
 *
 * ## 表单契约（2026-11-20 实测，MAX8.2）
 *
 * 入口：`GET index.php?m=effort&f=batchCreate&date=today&userID=&from=list&onlybody=yes`
 * 提交：`POST` 到同一地址（页面里 `<form id="effortBatchAddForm" action="">`，即提交回自身）
 *
 * 字段命名是「混合式」的，**必须照抄，别自作主张统一**：
 *
 * | 字段 | 命名 | 说明 |
 * | --- | --- | --- |
 * | `id[]` | 空括号 | 行号，1..8 |
 * | `work[]` | 空括号 | 工作内容；**留空则该行跳过** |
 * | `objectType[]` | 空括号 | `task_123` / `bug_456` / **空 = 自定义日志** |
 * | `consumed[]` | 空括号 | 耗时（小时） |
 * | `execution[N]` | **行号下标** | 执行（迭代）ID |
 * | `left[N]` | **行号下标** | 剩余工时；自定义日志留空 |
 *
 * ⚠️ `date` 是**整张表单一个值**，不是每行一个 —— 所以一次提交只能填同一天。
 * 跨天必须分多次提交，本模块按日期自动分组。
 *
 * ## 删除
 *
 * `GET index.php?m=effort&f=delete&id={id}&confirm=yes`
 *
 * ⚠️ 少一个 `confirm=yes` 就变成「返回一段 `confirm(...)` 的 JS 提示页」，**不会真删** ——
 * 一开始就是这么被误导的（响应 200、看着像成功）。真删成功时返回的是
 * `<script>if(parent !== window) parent.location.reload(true);</script>`。
 *
 * 删掉挂任务的日志，禅道会自动回滚该任务的已消耗工时。
 */

import { ZenTaoWebSession } from './session';

/** 一条待写入的日志 */
export interface EffortInput {
  /** 日期 `YYYY-MM-DD` */
  date: string;
  /** 工作内容（日志标题） */
  work: string;
  /** 耗时（小时） */
  consumed: number;
  /** 对象类型：`custom`（默认，不挂对象）/ `task` / `bug` / `story` … */
  objectType?: string;
  /** 对象 ID；`custom` 时忽略 */
  objectID?: number;
  /** 执行（迭代）ID */
  executionID?: number;
  /** 剩余工时；自定义日志通常留空 */
  left?: number;
}

/** 表单下拉里的候选项 */
export interface FormOption {
  /** 提交值，如 `task_2014540` / `2000649` */
  value: string;
  /** 展示文案，如 `[任务]2014540:系统bug修复` */
  label: string;
}

export interface BatchFormOptions {
  /** 当前日期输入框的默认值 */
  date: string;
  /** 可挂的对象（任务 / Bug / 需求…） */
  objects: FormOption[];
  /** 可选的执行（迭代） */
  executions: FormOption[];
  /** 表单一次最多几行 */
  maxRows: number;
}

/** 单行提交结果 */
export interface EffortWriteResult {
  date: string;
  work: string;
  consumed: number;
  /** 提交是否成功（表单层面） */
  submitted: boolean;
  /** 服务端返回的错误提示（若失败） */
  message?: string;
}

const BATCH_PATH = '/index.php?m=effort&f=batchCreate&date=today&userID=&from=list&onlybody=yes';

/** 页面表单一次能填几行（实测 8 行） */
const DEFAULT_MAX_ROWS = 8;

/** 把 HTML 转成可读文本，用来抠提示语 */
function squeeze(html: string): string {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 抓某个 select 的所有 option */
function selectOptions(html: string, fieldPattern: RegExp): FormOption[] {
  const out: FormOption[] = [];
  const selectRe = new RegExp(`<select\\b[^>]*name\\s*=\\s*["']${fieldPattern.source}["'][^>]*>([\\s\\S]*?)</select>`, 'i');
  const m = selectRe.exec(html);
  if (!m) return out;
  const optRe = /<option\b[^>]*value\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let om: RegExpExecArray | null;
  while ((om = optRe.exec(m[1]))) {
    const value = decodeEntities(om[1]).trim();
    const label = squeeze(decodeEntities(om[2]));
    if (!value) continue; // 跳过「请选择」空项
    out.push({ value, label });
  }
  return out;
}

/**
 * 读取「新增日志」表单的候选下拉。
 *
 * 用途：写入前先看有哪些任务/Bug 可挂、有哪些迭代可选，
 * 也用于把「执行 ID」翻译成人类可读的迭代名。
 */
export async function fetchBatchFormOptions(
  session: ZenTaoWebSession,
  date?: string
): Promise<BatchFormOptions> {
  await session.ensureLogin();
  const path = date
    ? `/index.php?m=effort&f=batchCreate&date=${encodeURIComponent(date)}&userID=&from=list&onlybody=yes`
    : BATCH_PATH;

  const { status, html } = await session.getHtml(path, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });

  if (status !== 200 || !/effortBatchAddForm/.test(html)) {
    throw new Error(
      '打开「新增日志」表单失败' +
        `（HTTP ${status}）。页面里没有找到 form#effortBatchAddForm。\n` +
        '可能原因：网页会话已失效，或该实例的日志模块做了定制。'
    );
  }

  const dateValue = /<input\b[^>]*name\s*=\s*["']date["'][^>]*value\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] || '';

  // 行数：数 id[] 出现次数
  const rowCount = (html.match(/name\s*=\s*["']id\[\]"?/gi) || []).length || DEFAULT_MAX_ROWS;

  return {
    date: dateValue,
    objects: selectOptions(html, /objectType\[\]/),
    executions: selectOptions(html, /execution\[\d+\]/),
    maxRows: rowCount,
  };
}

/** 把一条输入转成表单里 `objectType[]` 的取值 */
function objectTypeValue(item: EffortInput): string {
  const type = (item.objectType || 'custom').trim().toLowerCase();
  if (!type || type === 'custom' || type === 'none') return '';
  if (!item.objectID) {
    throw new Error(
      `日志「${item.work}」指定了 objectType=${type} 但没给 objectID。` +
        '要么补上 objectID，要么用 objectType=custom 填自定义日志。'
    );
  }
  return `${type}_${item.objectID}`;
}

/**
 * 按日期分组时，一组就是一次 `batchCreate` 提交。
 */
function groupByDate(items: EffortInput[]): Map<string, EffortInput[]> {
  const map = new Map<string, EffortInput[]>();
  for (const item of items) {
    const list = map.get(item.date) || [];
    list.push(item);
    map.set(item.date, list);
  }
  return map;
}

/**
 * 构造一张批量录入表单的 URLSearchParams。
 *
 * 注意字段命名的「混合式」：`work[]` 用空括号、`execution[N]` 用行号下标，
 * 这是页面原生写法，改统一会导致服务端按错位读取（实测对齐失败会写错行）。
 */
function buildBatchBody(date: string, rows: EffortInput[], maxRows: number): URLSearchParams {
  const p = new URLSearchParams();
  p.append('date', date);
  const total = Math.max(rows.length, Math.min(maxRows, rows.length));
  for (let i = 1; i <= total; i++) {
    const row = rows[i - 1];
    p.append('id[]', String(i));
    p.append('work[]', row ? row.work : '');
    p.append('objectType[]', row ? objectTypeValue(row) : '');
    p.append(`execution[${i}]`, row && row.executionID ? String(row.executionID) : '');
    p.append('consumed[]', row ? String(row.consumed) : '');
    p.append(`left[${i}]`, row && row.left !== undefined ? String(row.left) : '');
  }
  return p;
}

/** 判断一次 batchCreate 的响应是否成功 */
function batchSubmitSucceeded(html: string): { ok: boolean; message?: string } {
  const text = String(html);

  // 成功：服务端返回一段「关弹窗 + 刷新列表/日历」的小脚本（实测 696 字节）
  if (/parent\.parent\.location|refreshCalendar|zui\.Modal\.hide|m=my&f=effort/i.test(text)) {
    return { ok: true };
  }

  // 失败：服务端把**整个表单页重新渲染**回来（实测 28 万字节）。
  // ⚠️ 这里不能用「文本里有没有『错误』二字」来判 —— 对象下拉里全是 Bug 标题，
  //    随便一条「…错误提示，见图」就会命中（踩过）。
  if (/effortBatchAddForm/.test(text)) {
    const blocks = [...text.matchAll(
      /class="[^"]*(?:text-danger|alert-danger|form-?tip[^"]*error|error-?tip)[^"]*"[^>]*>([\s\S]{1,300}?)<\//gi
    )]
      .map((m) => squeeze(m[1]))
      .filter((s) => s && s.length > 1);
    const title = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim() || '新增日志表单';
    return {
      ok: false,
      message: blocks.slice(0, 3).join(' | ') ||
        `服务端重新渲染了「${title}」，说明校验未通过（常见原因：日期超出允许范围 / 耗时非法 / 该执行无权限 / 工作内容为空）`,
    };
  }

  return { ok: false, message: squeeze(text).slice(0, 200) || '服务端未返回可识别的结果' };
}

/**
 * 批量写日志（自定义类型也支持）。
 *
 * 按日期分组，每组提交一次表单；组内超过 8 行会拆成多次。
 */
export async function fillEfforts(
  session: ZenTaoWebSession,
  items: EffortInput[]
): Promise<EffortWriteResult[]> {
  if (!items.length) return [];
  await session.ensureLogin();

  const results: EffortWriteResult[] = [];
  const grouped = groupByDate(items);

  for (const [date, rows] of grouped) {
    for (let start = 0; start < rows.length; start += DEFAULT_MAX_ROWS) {
      const chunk = rows.slice(start, start + DEFAULT_MAX_ROWS);
      const body = buildBatchBody(date, chunk, DEFAULT_MAX_ROWS);

      const { status, text } = await session.postForm(BATCH_PATH, body, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          // ⚠️ 必须**绝对 URL**。用相对路径时服务端不认这是 ajax 提交，
          // 会把整张表单页重新渲染回来（28 万字节），表现得像「校验失败」。实测踩过。
          Referer: `${session.siteUrl}${BATCH_PATH}`,
        },
      });

      const verdict = status === 200
        ? batchSubmitSucceeded(text)
        : { ok: false, message: `HTTP ${status}` };

      if (status === 401 || /用户登录/.test(squeeze(text).slice(0, 200))) {
        // 会话中途失效 —— 重置后重试一次
        session.reset();
        await session.ensureLogin();
        const retry = await session.postForm(BATCH_PATH, body, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${session.siteUrl}${BATCH_PATH}`,
          },
        });
        const retryVerdict = retry.status === 200
          ? batchSubmitSucceeded(retry.text)
          : { ok: false, message: `HTTP ${retry.status}` };
        for (const row of chunk) {
          results.push({
            date, work: row.work, consumed: row.consumed,
            submitted: retryVerdict.ok, message: retryVerdict.message,
          });
        }
        continue;
      }

      for (const row of chunk) {
        results.push({
          date, work: row.work, consumed: row.consumed,
          submitted: verdict.ok, message: verdict.message,
        });
      }
    }
  }

  return results;
}

/**
 * 删除一条日志。
 *
 * ⚠️ `confirm=yes` 不能省，省了只会拿到一段 confirm 提示页（HTTP 200，很有欺骗性）。
 * 删除挂任务的日志时，禅道会连带回滚该任务的已消耗工时。
 */
export async function deleteEffort(
  session: ZenTaoWebSession,
  effortID: number
): Promise<{ deleted: boolean; message?: string; raw: string }> {
  await session.ensureLogin();

  const path = `/index.php?m=effort&f=delete&id=${encodeURIComponent(String(effortID))}&confirm=yes`;
  const { status, html } = await session.getHtml(path, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${session.siteUrl}/index.php?m=my&f=effort&type=all`,
    },
  });

  // 成功标志：让父页面刷新
  if (/parent\.location\.reload|parent\.location\s*=\s*['"][^'"]*m=my&f=effort/i.test(html)) {
    return { deleted: true, raw: squeeze(html).slice(0, 200) };
  }

  // 失败：常见是「没有确认」的提示页，或权限不足
  const readable = squeeze(html);
  return {
    deleted: false,
    message:
      status !== 200
        ? `HTTP ${status}`
        : readable.slice(0, 200) || '服务端未确认删除（返回内容为空）',
    raw: html.slice(0, 400),
  };
}
