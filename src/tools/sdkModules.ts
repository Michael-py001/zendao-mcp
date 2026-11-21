/**
 * `zendao_modules` —— **发现层**：按「当前实例的实际版本」列出可用模块与动作。
 *
 * ## 为什么需要它
 *
 * 禅道各版本（开源版 / 企业版 / 旗舰版 / IPD 版）提供的能力差异巨大，
 * 官方注册表里 **229 个动作**，任一具体实例只会放行与自身版本匹配的一部分 ——
 * 其余的会被 SDK 以 `E_UNSUPPORTED_ZENTAO_VERSION` 拒绝。
 *
 * 所以「有哪些能力可用」不能靠文档猜，必须由实例自己回答。本工具就是那个回答：
 *
 * - **默认**：模块级摘要（每个模块一行，列出当前实例可用的动作名）—— 紧凑，适合先扫一遍
 * - **传 `module`**：下钻到单个模块，逐动作标注「可用 / 需升级到哪个版本」
 *
 * 它同时也是**移植 / 排查的权威依据**：想知道「这个动作在别人 8.5 的实例上有没有」，
 * 用 `includeUnsupported: true` 就能看到完整注册表与各自的版本门槛。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { getSdkRuntime } from '../sdk';
import { editionLabel, parseVersion } from '../sdk/version';

export interface ListSdkModulesArgs {
  /** 下钻到单个模块（如 `bug`、`product`），不传则给模块级摘要 */
  module?: string;
  /** 按模块名 / 动作名 / 说明做关键词过滤（本地） */
  keyword?: string;
  /** 是否把「被版本门槛拒绝的动作」也列出来（默认 false） */
  includeUnsupported?: boolean;
}

/** 动作的一个精简视图（注册表定义 → 稳定结构） */
interface ActionBrief {
  name: string;
  display?: string;
  type: string;
  method: string;
  path: string;
  /** 该动作要求的最低版本列表（按产品线） */
  minVersion: string[];
  /** 在当前实例版本下是否可用 */
  supported: boolean;
  /** 不可用时的原因说明 */
  requirement?: string;
}

/**
 * 「要满足哪个版本才能用」的人话说明。
 *
 * 关键点：**按产品线取同系列的那一条**。例如实例自报 `max8.2` 时，
 * 某动作的 `minVersion` 是 `['22.0','biz13.0','max8.5','ipd5.0']` ——
 * 只说「需 22.0」会让人误以为满足开源版就行，实际该产品线的门槛是 `max8.5`。
 */
function requirementHint(minVersion: readonly string[], edition: string, currentVersion: string | null): string {
  const same = minVersion.find((item) => (parseVersion(item)?.edition ?? '') === edition);
  if (same) {
    return currentVersion ? `需 ${same}（当前实例 ${currentVersion}）` : `需 ${same}`;
  }
  return `本产品线不支持（注册表门槛：${minVersion.join(' / ')}）`;
}

export async function listSdkModules(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  params?: ListSdkModulesArgs
): Promise<ToolResult> {
  const args: ListSdkModulesArgs = params || {};

  try {
    const runtime = await getSdkRuntime(client);
    const { sdk, version } = runtime;
    const currentVersion = version.version;
    const filterOptions = currentVersion ? { version: currentVersion } : {};

    const allModuleNames = sdk.getModuleNames();

    // ---------- 下钻单个模块 ----------
    if (args.module) {
      const target = String(args.module).trim().toLowerCase();
      const full = sdk.getModule(target);

      if (!full) {
        const near = allModuleNames.filter(
          (name) => name.includes(target) || target.includes(name)
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `没有名为 "${args.module}" 的模块。\n` +
                (near.length
                  ? `是不是想找：${near.join('、')}？`
                  : `可用模块：${allModuleNames.join('、')}`) +
                '\n（模块名大小写不敏感，可用 `zendao_modules` 查看完整清单。）',
            },
          ],
          isError: true,
        };
      }

      const filtered = currentVersion ? sdk.getModule(target, filterOptions) : full;
      const supportedSet = new Set((filtered?.actions ?? []).map((action) => String(action.name)));

      const actions: ActionBrief[] = full.actions
        .map((action) => {
          const supported = supportedSet.has(String(action.name));
          return {
            name: String(action.name),
            display: action.display,
            type: String(action.type),
            method: String(action.method ?? '').toUpperCase(),
            path: action.path,
            minVersion: [...action.minVersion],
            supported,
            requirement: supported
              ? undefined
              : requirementHint(action.minVersion, version.edition, currentVersion),
          };
        })
        .filter((action) => {
          if (action.supported || args.includeUnsupported) return true;
          return false;
        })
        .filter((action) => {
          if (!args.keyword) return true;
          const kw = args.keyword.toLowerCase();
          return (
            action.name.toLowerCase().includes(kw) ||
            (action.display ?? '').toLowerCase().includes(kw) ||
            action.path.toLowerCase().includes(kw)
          );
        });

      const lines = actions.map((action) => {
        const mark = action.supported ? '✅' : '❌';
        const name = action.name.padEnd(16, ' ');
        const display = (action.display ?? '').padEnd(14, ' ');
        const base = `  ${mark} ${name}${display}${action.method} ${action.path}`;
        return action.supported ? base : `${base}   → ${action.requirement}`;
      });

      const header =
        `📦 ${full.name}${full.display ? `（${full.display}）` : ''} · ` +
        `${full.actions.length} 个动作，当前实例可用 ${supportedSet.size} 个`;

      return {
        content: [
          {
            type: 'text',
            text: [
              header,
              `实例版本：${currentVersion ?? '未知'}${version.edition ? `（${editionLabel(version.edition)}）` : ''}`,
              version.note,
              '',
              ...lines,
              '',
              `用 \`zendao_help\` 查某个动作的参数表，例如：zendao_help { module: "${full.name}", action: "${actions[0]?.name ?? 'list'}" }`,
              `用 \`zendao_call\` 执行，例如：zendao_call { module: "${full.name}", action: "${actions[0]?.name ?? 'list'}" }`,
            ].join('\n'),
          },
        ],
        structuredContent: {
          module: String(full.name),
          display: full.display ?? null,
          version: currentVersion,
          edition: version.edition,
          versionSource: version.source,
          actionTotal: full.actions.length,
          actionSupported: supportedSet.size,
          actions,
        },
      };
    }

    // ---------- 模块级摘要（默认）----------
    const modules: Array<{
      name: string;
      display: string | null;
      actionTotal: number;
      actionSupported: number;
      supportedActions: string[];
      unsupportedActions: string[];
    }> = [];

    let totalActions = 0;
    let supportedActions = 0;

    for (const name of allModuleNames) {
      const full = sdk.getModule(name);
      if (!full) continue;

      const filtered = currentVersion ? sdk.getModule(name, filterOptions) : full;
      const supportedNames = (filtered?.actions ?? []).map((action) => String(action.name));
      const supportedSet = new Set(supportedNames);

      totalActions += full.actions.length;
      supportedActions += supportedSet.size;

      const entry = {
        name: String(full.name),
        display: full.display ?? null,
        actionTotal: full.actions.length,
        actionSupported: supportedSet.size,
        supportedActions: supportedNames,
        unsupportedActions: full.actions
          .map((action) => String(action.name))
          .filter((actionName) => !supportedSet.has(actionName)),
      };

      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        const hit =
          entry.name.toLowerCase().includes(kw) ||
          (entry.display ?? '').toLowerCase().includes(kw) ||
          entry.supportedActions.some((action) => action.toLowerCase().includes(kw));
        if (!hit) continue;
      }

      modules.push(entry);
    }

    const lines = modules.map((module) => {
      const label = `${module.name}${module.display ? ` ${module.display}` : ''}`.padEnd(18, ' ');
      const stat = `${module.actionSupported}/${module.actionTotal}`.padStart(6, ' ');
      const actions = module.supportedActions.join(' ');
      return `${label}${stat}  ${actions}`;
    });

    const header =
      modules.length === 0
        ? '没有匹配的模块'
        : `禅道版本 ${currentVersion ?? '未知'}${version.edition ? `（${editionLabel(version.edition)}）` : ''}` +
          ` · 注册表 ${allModuleNames.length} 个模块 / ${totalActions} 个动作，当前实例可用 ${supportedActions} 个`;

    const notes = [
      version.note,
      '格式：`模块 可用数/总数  可用动作名`',
      '用 `zendao_modules { module: "bug" }` 下钻查看单模块动作（含 HTTP 方法与路径）',
      '用 `includeUnsupported: true` 可看到被版本门槛拒绝的动作及其所需版本',
      '下一步：`zendao_help { module, action }` 查参数表 → `zendao_call { module, action, params }` 执行',
    ];

    return {
      content: [{ type: 'text', text: [header, ...notes, '', ...lines].join('\n') }],
      structuredContent: {
        version: currentVersion,
        edition: version.edition,
        versionSource: version.source,
        moduleTotal: allModuleNames.length,
        actionTotal: totalActions,
        actionSupported: supportedActions,
        modules,
      },
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text:
            `读取模块清单失败: ${error?.message || '未知错误'}\n` +
            '（本工具依赖官方 SDK 的本地注册表，不需要网络；若报错通常是依赖未安装或版本不兼容。）',
        },
      ],
      isError: true,
    };
  }
}
