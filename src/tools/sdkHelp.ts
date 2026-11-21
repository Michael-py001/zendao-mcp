/**
 * `zendao_help` —— **定义层**：查单个动作的完整参数表。
 *
 * ## 为什么必须有这一步
 *
 * 官方注册表里每个动作的入参都带完整定义（类型 / 必填 / 枚举 / 默认值 / **中文说明**），
 * 但这些信息**不在** `zendao_modules` 的紧凑输出里（那是 229 个动作 × 平均 4 个参数，
 * 全塞进去会淹掉上下文）。
 *
 * 所以采用「**三步走**」：`zendao_modules`（有哪些动作）→ `zendao_help`（怎么传参）
 * → `zendao_call`（执行）。模型按这个顺序走就不会瞎猜参数，
 * 也不需要把 600+ 个参数定义一次性塞进工具描述。
 *
 * 传 `action` 时可以省略 —— 那样会列出该模块**全部动作**的参数，适合「不确定该用哪个动作」时。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { getSdkRuntime } from '../sdk';
import { editionLabel } from '../sdk/version';

export interface SdkHelpArgs {
  /** 模块名（必填），如 `bug` */
  module: string;
  /** 动作名，如 `list` / `get` / `create`；省略则列出该模块全部动作的参数摘要 */
  action?: string;
  /** 只看某类参数：path / query / body；省略则都列 */
  role?: 'path' | 'query' | 'body';
}

/** 参数在输出里的精简形态 */
interface ParamBrief {
  name: string;
  role: string;
  required: boolean;
  type: string;
  description?: string;
  defaultValue?: unknown;
  options?: Array<{ value: unknown; label: string }>;
}

const ROLE_LABELS: Record<string, string> = {
  path: '路径参数',
  query: '查询参数',
  body: '请求体字段',
};

/** 一个参数渲染成一行 */
function renderParam(param: ParamBrief): string {
  const flags = [param.type || 'string', param.required ? '必填' : '选填'];
  if (param.defaultValue !== undefined) flags.push(`默认 ${JSON.stringify(param.defaultValue)}`);
  const head = `  • ${param.name}  (${flags.join('，')})`;
  const desc = param.description ? `\n      ${param.description}` : '';
  const opts = param.options
    ? `\n      可选值：${param.options.map((option) => `${String(option.value)}=${option.label}`).join('，')}`
    : '';
  return `${head}${desc}${opts}`;
}

/** 用必填参数拼一个可直接粘贴的调用示例 */
function buildExample(moduleName: string, actionName: string, params: ParamBrief[]): string {
  const example: Record<string, unknown> = {};
  for (const param of params) {
    if (!param.required) continue;
    if (param.options?.length) {
      example[param.name] = param.options[0].value;
    } else if (param.type === 'number') {
      example[param.name] = 1;
    } else if (param.type === 'array') {
      example[param.name] = ['值'];
    } else {
      example[param.name] = '值';
    }
  }
  return (
    `zendao_call { module: "${moduleName}", action: "${actionName}"` +
    (Object.keys(example).length ? `, params: ${JSON.stringify(example)}` : '') +
    ' }'
  );
}

export async function getSdkActionHelp(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  params?: SdkHelpArgs
): Promise<ToolResult> {
  const args = params as SdkHelpArgs;

  try {
    const runtime = await getSdkRuntime(client);
    const { sdk, version } = runtime;
    const moduleName = String(args.module).trim().toLowerCase();
    const module = sdk.getModule(moduleName);

    if (!module) {
      const names = sdk.getModuleNames();
      const near = names.filter((name) => name.includes(moduleName) || moduleName.includes(name));
      return {
        content: [
          {
            type: 'text',
            text:
              `没有名为 "${args.module}" 的模块。\n` +
              (near.length ? `是不是想找：${near.join('、')}？` : `可用模块：${names.join('、')}`),
          },
        ],
        isError: true,
      };
    }

    // ---------- 不指定动作：列出该模块全部动作的参数摘要 ----------
    if (!args.action) {
      const filterOptions = version.version ? { version: version.version } : {};
      const filtered = version.version ? sdk.getModule(moduleName, filterOptions) : module;
      const supportedSet = new Set((filtered?.actions ?? []).map((action) => String(action.name)));

      const blocks = module.actions.map((action) => {
        const actionName = String(action.name);
        const supported = supportedSet.has(actionName);
        const actionParams = sdk.getModuleActionParams(moduleName, actionName, {}) as ParamBrief[];
        const required = actionParams.filter((param) => param.required).map((param) => param.name);
        return [
          `${supported ? '✅' : '❌'} ${actionName}${action.display ? ` ${action.display}` : ''} · ${String(action.method ?? '').toUpperCase()} ${action.path}`,
          action.description ? `    ${action.description}` : '',
          required.length ? `    必填：${required.join('、')}` : '    无必填参数',
        ]
          .filter((line) => line !== '')
          .join('\n');
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `📦 ${module.name}${module.display ? `（${module.display}）` : ''} · ${module.actions.length} 个动作`,
              `实例版本 ${version.version ?? '未知'}${version.edition ? `（${editionLabel(version.edition)}）` : ''}`,
              '',
              ...blocks,
              '',
              `查某个动作的完整参数表：zendao_help { module: "${module.name}", action: "<动作名>" }`,
            ].join('\n'),
          },
        ],
        structuredContent: {
          module: moduleName,
          display: module.display ?? null,
          version: version.version,
          actionTotal: module.actions.length,
          actions: module.actions.map((action) => {
            const actionParams = sdk.getModuleActionParams(moduleName, String(action.name), {}) as ParamBrief[];
            return {
              name: String(action.name),
              display: action.display ?? null,
              description: action.description ?? null,
              supported: supportedSet.has(String(action.name)),
              method: String(action.method ?? '').toUpperCase(),
              path: action.path,
              required: actionParams.filter((param) => param.required).map((param) => param.name),
            };
          }),
        },
      };
    }

    // ---------- 指定动作：完整参数表 ----------
    const actionName = String(args.action).trim();
    const action = sdk.getModuleAction(moduleName, actionName);

    if (!action) {
      const names = module.actions.map((item) => String(item.name));
      const near = names.filter((name) => name.includes(actionName.toLowerCase()));
      return {
        content: [
          {
            type: 'text',
            text:
              `模块 "${moduleName}" 里没有动作 "${args.action}"。\n` +
              (near.length ? `是不是想找：${near.join('、')}？` : '') +
              `\n该模块可用动作：${names.join('、')}`,
          },
        ],
        isError: true,
      };
    }

    const allParams = sdk.getModuleActionParams(moduleName, String(action.name), {}) as ParamBrief[];
    const visible = args.role ? allParams.filter((param) => param.role === args.role) : allParams;

    const supported = Boolean(
      version.version ? sdk.getModuleAction(moduleName, String(action.name), { version: version.version }) : action
    );
    const minVersion = [...action.minVersion];

    const header =
      `📌 ${moduleName}/${String(action.name)}${action.display ? ` · ${action.display}` : ''}`;
    const meta = [
      `HTTP ${String(action.method ?? '').toUpperCase()} ${action.path}`,
      `类型 ${String(action.type)}`,
      `最低版本 ${minVersion.join(' / ')}`,
      supported
        ? `当前实例（${version.version ?? '未知'}）✅ 可用`
        : `当前实例（${version.version ?? '未知'}）❌ 不可用`,
    ].join(' · ');

    const sections: string[] = [];
    for (const role of ['path', 'query', 'body'] as const) {
      const group = visible.filter((param) => param.role === role);
      if (!group.length) continue;
      sections.push(`${ROLE_LABELS[role]}（${group.length}）`);
      sections.push(...group.map(renderParam));
      sections.push('');
    }

    const mediaType =
      (action.requestBody as { mediaType?: string } | undefined)?.mediaType ?? 'application/json';
    const hasBody = allParams.some((param) => param.role === 'body');
    const bodyNote = hasBody
      ? `请求体格式：${mediaType}${mediaType === 'multipart/form-data' ? '（文件上传：字段值传本地文件路径或 {path} 形式即可，SDK 会转 multipart）' : ''}`
      : '';

    const notes = [
      '参数平铺在 `params` 里传（path / query / body 都平铺，不用嵌套区分）',
      bodyNote,
      supported ? '' : '⚠️ 该动作在当前实例版本下会被 SDK 门槛拦下；换等价动作，或把禅道升级到所需版本。',
    ].filter((line) => line !== '');

    return {
      content: [
        {
          type: 'text',
          text: [
            header,
            meta,
            action.description ? `说明：${action.description}` : '',
            '',
            ...(sections.length ? sections : ['该动作没有参数']),
            '调用示例：',
            `  ${buildExample(moduleName, String(action.name), allParams)}`,
            '',
            ...notes,
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
      ],
      structuredContent: {
        module: moduleName,
        action: String(action.name),
        display: action.display ?? null,
        description: action.description ?? null,
        method: String(action.method ?? '').toUpperCase(),
        path: action.path,
        type: String(action.type),
        resultType: String(action.resultType ?? ''),
        minVersion,
        supported,
        mediaType,
        params: allParams,
        example: buildExample(moduleName, String(action.name), allParams),
      },
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `查询动作定义失败: ${error?.message || '未知错误'}`,
        },
      ],
      isError: true,
    };
  }
}
