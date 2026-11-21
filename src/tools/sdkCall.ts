/**
 * `zendao_call` —— **执行层**：按 `模块/动作` 调用官方注册表里的任意动作。
 *
 * ## 定位
 *
 * 这一个工具就是**官方 229 个动作**的统一入口。禅道各版本的能力差异、
 * 路径拼接、参数类型强转、分页字段、结果提取、版本门槛，
 * 全部由官方 `zentao-api` 在内部处理 —— 我们只做三件事：
 *
 * 1. **参数透传**（并补上分页默认值，避免一次拉回上千条）
 * 2. **错误中文化**（把 `E_UNSUPPORTED_ZENTAO_VERSION` 这类码翻成人话 + 下一步建议）
 * 3. **结果呈现**（文本摘要 + 结构化数据双通道）
 *
 * ## 典型流程
 *
 * ```
 * zendao_modules                                  ← 看有哪些动作可用
 * zendao_help { module: "bug", action: "list" }   ← 看参数怎么传
 * zendao_call { module: "bug", action: "list", params: { productID: 7 } }
 * ```
 *
 * ⚠️ **写操作会真的落库**（create/update/delete/close 等）。本工具的注解标记为
 * 破坏性操作，客户端应给出确认提示。只读场景优先用 `bug/list`、`bug/get` 这类动作。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { convertHtmlFields } from '../utils/html';
import { fieldLabel, getFieldLabels } from '../utils/labels';
import { getSdkRuntime, humanizeError } from '../sdk';
import type { SdkCallOptions } from '../sdk';

export interface SdkCallArgs {
  /** 模块名，如 `bug` / `task` / `product`（大小写不敏感） */
  module: string;
  /** 动作名，如 `list` / `get` / `create` / `close`（大小写不敏感，`ls` 是 `list` 别名） */
  action: string;
  /** 动作参数（path / query / body 字段**平铺**在这里，不用嵌套区分） */
  params?: Record<string, unknown>;
  /** 页码（服务端分页，映射为 v2 的 `pageID`） */
  page?: number;
  /** 每页条数（服务端分页，映射为 v2 的 `recPerPage`） */
  recPerPage?: number;
  /** 只返回指定字段（逗号分隔），如 `id,name,status` */
  pick?: string;
  /** 本地排序，如 `id_desc` / `deadline:asc` */
  sort?: string;
  /** 本地限数（在服务端返回之后再截断） */
  limit?: number;
  /**
   * 本地搜索。语义：**字符串内逗号 = AND，数组元素之间 = OR**。
   *
   * - `search: '登录'` → 任一字段含「登录」即保留
   * - `search: '登录,导出'` → 两个词**都要**命中（AND）
   * - `search: ['登录', '导出']` → 命中**任一**即保留（OR）
   */
  search?: string | string[];
  /**
   * 本地过滤表达式，如 `status=active`、`pri<=2`、`title~登录`。
   * 语义：**字符串内逗号 = AND，数组元素之间 = OR**（与 `search` 一致）。
   * 运算符：`=` `!=` `~`（包含）`!~` `>` `<` `>=` `<=`，另 `:` 等价于 `=`。
   */
  filter?: string | string[];
  /** 搜索范围字段（如 `['title','steps']`）；省略则搜全部字段 */
  searchFields?: string[];
  /** `update` 动作是否先取现值再提交（默认 true，避免未提交字段被清空） */
  autoFill?: boolean;
  /** 是否把富文本字段（HTML）转成 Markdown（默认 true，列表与详情都生效） */
  convertHtml?: boolean;
  /** 返回服务端原始响应（不做结果提取与本地处理），排查问题时用 */
  raw?: boolean;
}

/** 文本里最多渲染的行数（超出只给提示，结构化数据仍是完整的） */
const MAX_PREVIEW_LINES = 60;
/** 列表里最多预览的条目数 */
const MAX_PREVIEW_ITEMS = 30;
/** 列表单条里最多预览的字段数（禅道实体动辄 70+ 字段，全铺开会淹掉上下文） */
const MAX_PREVIEW_FIELDS = 12;

/** 逐项 trim、丢掉空串；全空则返回 `undefined`（表示不启用该处理） */
function cleanList(list: unknown[]): string[] | undefined {
  const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/**
 * 逗号分隔 → 字段名数组（用于 `pick`）。
 * `pick` 的每一项就是一个字段名，所以**按逗号切分是正确的**（与 filter/search 相反）。
 */
function toFieldList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return cleanList(String(value).split(','));
}

/**
 * 过滤 / 搜索的「条件组」数组。
 *
 * ⚠️ 这里**绝不能按逗号切分** —— 官方 SDK 的语义是：
 *
 * - **同一个字符串元素内**的逗号 = **AND**
 *   （`parseFilterGroup` 把整串解析成一个 `{operator:'AND', conditions:[…]}` 条件组；
 *   `searchData` 对组内关键词用 `.every()`）
 * - **数组元素之间** = **OR**
 *   （`processData` 用 `groups.some(group => matchGroup(...))`）
 *
 * 若按逗号切开，`"status=active,pri<=2"` 就变成两个组 → 退化成 OR，与用户预期正好相反。
 * 详见 `node_modules/zentao-api/dist/utils/data.js` 的 `parseFilterGroup` / `processData`。
 */
function toGroupList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return cleanList(Array.isArray(value) ? value : [value]);
}

/** 单行 JSON（用于列表预览） */
function inlineJson(value: unknown, maxLength = 180): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return 'undefined';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 把对象的字段渲染成 `字段名(中文名): 值` 片段。
 *
 * 带中文名有两个用处：给人看更直观；给 LLM 看能顺便学到「英文键 ↔ 中文名」的映射，
 * 于是后面拼 `pick` / `filter` 时不容易写错字段名。
 * 字典里没有的字段（如服务端拼装的 `productName`）只显示英文名，**不丢字段**。
 */
function renderEntries(
  obj: Record<string, unknown>,
  labels: Record<string, string> | undefined,
  maxFields: number
): string[] {
  const entries = Object.entries(obj);
  const shown = entries.slice(0, maxFields);
  const parts = shown.map(([key, value]) => {
    const cn = fieldLabel(labels, key);
    const name = cn && cn !== key ? `${key}(${cn})` : key;
    // 嵌套值压成一行 JSON，避免细节展开后淹没上下文
    const text = value !== null && typeof value === 'object' ? inlineJson(value) : String(value);
    return `${name}: ${text}`;
  });
  if (entries.length > shown.length) {
    parts.push(`…还有 ${entries.length - shown.length} 个字段（用 pick 只取需要的）`);
  }
  return parts;
}

/** 把结果数据渲染成可读文本（带截断保护，避免几百条记录淹掉上下文） */
function renderData(data: unknown, labels?: Record<string, string>): string[] {
  if (data === undefined || data === null) return ['（无数据）'];

  // 有中文名词典时优先用它渲染成「字段(中文): 值」；没有（未知模块）就退回原始 JSON，
  // 免得把嵌套结构拍平了反而更难读。
  const useLabels = Boolean(labels && Object.keys(labels).length);

  if (Array.isArray(data)) {
    if (data.length === 0) return ['（列表为空）'];
    const shown = data.slice(0, MAX_PREVIEW_ITEMS);
    const lines = shown.map((item) => {
      if (useLabels && item && typeof item === 'object' && !Array.isArray(item)) {
        return `• ${renderEntries(item as Record<string, unknown>, labels, MAX_PREVIEW_FIELDS).join(' | ')}`;
      }
      return `• ${inlineJson(item)}`;
    });
    if (data.length > shown.length) {
      lines.push(`…还有 ${data.length - shown.length} 条（用 page / recPerPage 翻页，或 pick 精简字段）`);
    }
    return lines;
  }

  if (typeof data === 'object') {
    if (useLabels) {
      const lines = renderEntries(data as Record<string, unknown>, labels, MAX_PREVIEW_LINES).map(
        (line) => `  ${line}`
      );
      return lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES) : lines;
    }
    const pretty = JSON.stringify(data, null, 2);
    const lines = pretty.split('\n');
    if (lines.length > MAX_PREVIEW_LINES) {
      return [
        ...lines.slice(0, MAX_PREVIEW_LINES),
        `…（共 ${lines.length} 行，已截断；用 pick 参数只取需要的字段）`,
      ];
    }
    return lines;
  }

  return [String(data)];
}

export async function callSdkAction(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  params?: SdkCallArgs
): Promise<ToolResult> {
  const args = params as SdkCallArgs;
  const moduleName = String(args.module ?? '').trim().toLowerCase();
  const actionName = String(args.action ?? '').trim();
  const requestName = `${moduleName}/${actionName}`;

  // 分页默认值：不设的话 SDK 会把服务端默认页全量返回（大产品线单产品可能有 700+ 条 Bug）。
  const effectiveRecPerPage = args.recPerPage ?? (parseInt(process.env.ZENTAO_REC_PER_PAGE || '', 10) || 20);

  try {
    const runtime = await getSdkRuntime(client);
    const { sdk, version } = runtime;

    // 提前给出「模块/动作是否存在」的清晰提示（SDK 的报错是英文的，且不给候选项）
    if (!sdk.getModule(moduleName)) {
      const names = sdk.getModuleNames();
      return {
        content: [
          {
            type: 'text',
            text: `没有名为 "${args.module}" 的模块。可用模块：${names.join('、')}`,
          },
        ],
        isError: true,
      };
    }
    const actionDef = sdk.getModuleAction(moduleName, actionName || 'list');
    if (!actionDef) {
      const available = (sdk.getModule(moduleName)?.actions ?? []).map((item) => String(item.name));
      return {
        content: [
          {
            type: 'text',
            text:
              `模块 "${moduleName}" 里没有动作 "${args.action}"。\n` +
              `可用动作：${available.join('、')}\n` +
              `（用 zendao_help { module: "${moduleName}" } 查看各动作的参数）`,
          },
        ],
        isError: true,
      };
    }

    const callParams: Record<string, unknown> = {
      ...(args.params ?? {}),
      ...(args.page !== undefined ? { page: args.page } : {}),
      ...(effectiveRecPerPage !== undefined ? { recPerPage: effectiveRecPerPage } : {}),
    };

    const convertEnabled = args.convertHtml !== false;
    const isList = String(actionDef.type) === 'list';

    const autoFillEffective = args.autoFill ?? String(actionDef.type) === 'update';

    const options: SdkCallOptions = {
      pick: toFieldList(args.pick),
      sort: args.sort,
      limit: args.limit,
      // filter / search 走「组」语义：串内逗号=AND、数组元素=OR（见 toGroupList 注释）
      search: toGroupList(args.search),
      filter: toGroupList(args.filter),
      searchFields: cleanList(args.searchFields ?? []),
      autoFill: autoFillEffective,
      raw: args.raw,
      recPerPage: effectiveRecPerPage,
    };

    // 富文本转 Markdown：列表与单条用的是同一个深度遍历函数，
    // 但**必须包一层单参数闭包** —— SDK 是以 `(data, params, options)` 三参调用的，
    // 直接传 `convertHtmlFields` 会让它的第二个形参 `maxDepth` 收到 params 对象，
    // 深度上限从此变成 NaN（行为不可控）。
    if (convertEnabled) {
      const toMarkdown = (value: unknown): unknown => convertHtmlFields(value);
      if (isList) options.convert = toMarkdown;
      else options.convertSingle = toMarkdown;
    }

    const response = (await runtime.call(requestName, callParams, options)) as {
      status?: string;
      message?: string;
      data?: unknown;
      pager?: { total?: number; page?: number; recPerPage?: number };
      rawMessage?: unknown;
      apiCode?: unknown;
    };

    // throwOnFail 默认 true，正常不会走到这里；留一道兜底以防调用方显式关掉
    if (response?.status === 'fail') {
      return {
        content: [
          {
            type: 'text',
            text: `❌ ${requestName} 业务失败：${response.message ?? '服务端未给出原因'}`,
          },
        ],
        isError: true,
      };
    }

    const payload = args.raw ? response : response?.data;
    const pager = response?.pager;

    // 字段名中文化（只看文本摘要；structuredContent 一律保持原始键，见铁律）
    const labels = await getFieldLabels(moduleName);

    const headerParts = [`✅ ${requestName}`];
    if (pager?.total !== undefined) {
      headerParts.push(
        `共 ${pager.total} 条 · 第 ${pager.page ?? 1} 页 · 每页 ${pager.recPerPage ?? effectiveRecPerPage}`
      );
    } else if (Array.isArray(payload)) {
      headerParts.push(`${payload.length} 条`);
    } else if (payload && typeof payload === 'object') {
      headerParts.push(`${Object.keys(payload as Record<string, unknown>).length} 个字段`);
    }

    const notes: string[] = [
      `实例版本 ${version.version ?? '未知'} · 动作定义 ${String(actionDef.method ?? '').toUpperCase()} ${actionDef.path}`,
    ];

    // —— 下面三条都是「静默失效 / 静默危险」，必须显式说出来，
    //    否则调用方会以为参数生效了、或者以为变更范围只有自己传的那几个字段。——
    // ① 单条动作（非 list）走 SDK 的 ProcessSingleOptions 分支，只应用转换与 pick，
    //    filter / search / sort / limit 会被静默丢掉（dist/utils/data.js:314-318）。
    if (!isList) {
      const ignored = [
        args.filter !== undefined ? 'filter' : '',
        args.search !== undefined ? 'search' : '',
        args.sort !== undefined ? 'sort' : '',
        args.limit !== undefined ? 'limit' : '',
      ].filter(Boolean);
      if (ignored.length) {
        notes.push(
          `⚠️ 单条动作（type=${String(actionDef.type)}）只支持 pick 与富文本转换，` +
            `**${ignored.join(' / ')} 已被忽略**（它们是列表级处理）`
        );
      }
    }

    if (args.raw) {
      notes.push('已返回服务端原始响应（raw: true），未做结果提取与本地处理');
      // SDK 在 raw 模式下提前 return 原始体，不做归一化 → 拿不到 pager
      if (!pager) notes.push('⚠️ raw: true 不含分页信息（pager 为空）；要看分页请去掉 raw');
    }
    if (!convertEnabled) notes.push('已关闭富文本转 Markdown（convertHtml: false）');

    // ② autoFill 按「update body schema 声明 + 你没传 + 现值存在」补齐，**不过滤只读字段**，
    //    所以有可能把只读值原样回写（dist/request/index.js:61-83）。
    if (autoFillEffective && String(actionDef.type) === 'update') {
      notes.push(
        '⚠️ autoFill 已按现值补齐**未传**字段（避免它们被清空）；若补齐项里含只读字段，' +
          '会被原样回写。想精确控制请显式传全字段，或传 autoFill: false'
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: [headerParts.join(' · '), ...notes, '', ...renderData(payload, labels)].join('\n'),
        },
      ],
      structuredContent: {
        module: moduleName,
        action: String(actionDef.name),
        status: response?.status ?? 'success',
        pager: pager ?? null,
        data: payload,
        // 原始响应（含 status/raw 等）留在结构化通道，方便调用方按需取用
        response: response ?? null,
        kind: isList ? 'list' : 'object',
      },
    };
  } catch (error: unknown) {
    const human = humanizeError(error);

    // 门槛类错误不是「失败」，而是「这个版本没这个能力」——给出可执行的下一步
    const nextSteps: string[] = [];
    if (human.code === 'E_UNSUPPORTED_ZENTAO_VERSION') {
      nextSteps.push('用 `zendao_modules` 查看当前实例实际可用的动作（含被门槛拒绝的清单）');
      nextSteps.push('该动作需要更高版本的禅道；若实例确已升级，检查环境变量 ZENTAO_VERSION 是否写成了旧版本');
    } else if (human.code === 'E_INVALID_MODULE' || human.code === 'E_INVALID_ACTION') {
      nextSteps.push('用 `zendao_modules` 确认模块名与动作名');
    } else if (human.code === 'E_MISSING_PARAM' || human.code === 'E_INVALID_PARAM') {
      nextSteps.push(`用 \`zendao_help { module: "${moduleName}", action: "${actionName}" }\` 查参数表与必填项`);
    } else if (human.code === 'E_API_FAILED') {
      nextSteps.push('这是服务端业务失败（对象不存在 / 状态不允许等），检查参数里的 ID 与对象当前状态');
      nextSteps.push('用 `raw: true` 可以看到服务端原始响应体');
    } else if (human.code === 'E_HTTP_ERROR') {
      nextSteps.push('404 通常是该版本没有这条 REST 路由；401/403 是认证或权限问题');
    }

    return {
      content: [
        {
          type: 'text',
          text: [
            `❌ ${requestName} 调用失败${human.code ? `（${human.code}）` : ''}`,
            human.message,
            ...(nextSteps.length ? ['', '下一步：', ...nextSteps.map((step) => `  · ${step}`)] : []),
          ].join('\n'),
        },
      ],
      isError: true,
    };
  }
}
