/**
 * 禅道实例版本探测与 SDK 全局策略。
 *
 * ## 为什么版本这么重要
 *
 * 官方 SDK 的**每一个动作**都带 `minVersion`（形如 `['22.0','biz13.0','max8.0','ipd5.0']`），
 * 调用时按「实例自报的版本」逐条判定，不满足就抛 `E_UNSUPPORTED_ZENTAO_VERSION`。
 * 这就是本项目的「通用性」来源 —— **同一份构建，8.2 实例少几个动作、8.5 实例全都有，
 * 不需要任何编译期分支**。
 *
 * 而版本从哪来？两条路，优先级从高到低：
 *
 * 1. **`ZENTAO_VERSION` 环境变量** —— 显式覆盖，适合 getconfig 被网关拦掉的实例
 * 2. **`{站点根}/?mode=getconfig`（匿名）** —— 官方做法，**无需登录**，实测本实例秒回 `max8.2`
 *
 * 两条都拿不到时**不阻断**：返回 `version: null`，并靠 SDK 的
 * `skipVersionCheckOnConfigError` 跳过门槛检查 —— 让请求直接打到服务端，
 * 由 REST 层的真实结果（404 / 200+fail）说话，而不是我们自己猜。
 *
 * ## 产品线（不是只有 max）
 *
 * 版本号前缀是产品线标识，**判定必须按同系列比较**：
 *
 * | 前缀 | 产品线 |
 * | --- | --- |
 * | （无） | 开源版，如 `22.0` |
 * | `biz` | 企业版 |
 * | `max` | 旗舰版（本实例 `max8.2`） |
 * | `ipd` | IPD 版 |
 *
 * ⚠️ **绝不能把版本写死成 max** —— 否则别人拿开源版 / 企业版一连就全被门槛拦掉。
 */

import type { SdkModule } from './loader';
import type { SdkClientAdapter } from './client-adapter';
import { humanizeError } from './errors';

/** 版本探测结果 */
export interface ZentaoVersionInfo {
  /** 实例自报版本（如 `max8.2`）；探测失败为 `null` */
  version: string | null;
  /** 产品线：`max` / `biz` / `ipd` / `''`（开源版） */
  edition: string;
  /** 版本来源 */
  source: 'env' | 'probe' | 'unknown';
  /** 给人看的补充说明（工具输出里会带上） */
  note: string;
}

/** 产品线中文名 */
const EDITION_LABELS: Record<string, string> = {
  '': '开源版',
  biz: '企业版',
  max: '旗舰版',
  ipd: 'IPD 版',
};

/**
 * 解析禅道版本号 —— **逐字对齐官方 `parseZentaoVersion()` 的正则**，
 * 保证「我们认得的版本」和「SDK 认得的版本」完全一致（否则会出现
 * 「我们放行、SDK 拒绝」的错位）。
 */
export function parseVersion(version: string): { edition: string; parts: number[] } | undefined {
  const match = /^(biz|max|ipd)?(\d+(?:\.\d+)*)$/i.exec(String(version).trim());
  if (!match) return undefined;
  const parts = match[2].split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return undefined;
  return { edition: (match[1] ?? '').toLowerCase(), parts };
}

/** 版本号对应的产品线中文名 */
export function editionLabel(edition: string): string {
  return EDITION_LABELS[edition] ?? edition;
}

/** `max8.2` → `旗舰版 8.2`；无法识别时原样返回 */
export function describeVersion(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return version;
  return parsed.edition ? `${editionLabel(parsed.edition)} ${parsed.parts.join('.')}` : `${version}（开源版）`;
}

/** 每个适配器一份探测结果缓存（同一实例不必反复探测） */
const versionCache = new WeakMap<SdkClientAdapter, Promise<ZentaoVersionInfo>>();

/**
 * 取当前实例的禅道版本（幂等、带缓存）。
 *
 * ⚠️ 缓存键是**适配器实例**而不是全局变量 —— 多站点场景下不会串台。
 */
export function resolveVersion(adapter: SdkClientAdapter): Promise<ZentaoVersionInfo> {
  const cached = versionCache.get(adapter);
  if (cached) return cached;

  const pending = probeVersion(adapter).catch((error) => ({
    version: null,
    edition: '',
    source: 'unknown' as const,
    note: `版本探测异常：${humanizeError(error).message}`,
  }));

  versionCache.set(adapter, pending);
  return pending;
}

/** 清空版本缓存（换站点、或需要强制重新探测时用） */
export function clearVersionCache(adapter: SdkClientAdapter): void {
  versionCache.delete(adapter);
}

async function probeVersion(adapter: SdkClientAdapter): Promise<ZentaoVersionInfo> {
  // ---- 1. 环境变量优先 ----
  const fromEnv = (process.env.ZENTAO_VERSION || '').trim();
  if (fromEnv) {
    const parsed = parseVersion(fromEnv);
    if (!parsed) {
      return {
        version: null,
        edition: '',
        source: 'env',
        note:
          `环境变量 ZENTAO_VERSION="${fromEnv}" 不是合法版本号（应形如 max8.2 / 22.0 / biz13.0），` +
          '已忽略；将跳过版本门槛检查',
      };
    }
    return {
      version: fromEnv,
      edition: parsed.edition,
      source: 'env',
      note: `版本取自环境变量 ZENTAO_VERSION（${describeVersion(fromEnv)}），已覆盖实例自报值`,
    };
  }

  // ---- 2. 向实例探测（匿名 getconfig，无需登录）----
  try {
    const config = await adapter.getZentaoConfig();
    const parsed = parseVersion(config.version);
    if (!parsed) {
      return {
        version: null,
        edition: '',
        source: 'probe',
        note: `实例自报版本 "${config.version}" 无法识别，将跳过版本门槛检查`,
      };
    }
    return {
      version: config.version,
      edition: parsed.edition,
      source: 'probe',
      note: `版本由实例匿名接口 /?mode=getconfig 自报（${describeVersion(config.version)}）`,
    };
  } catch (error) {
    return {
      version: null,
      edition: '',
      source: 'unknown',
      note:
        `无法探测实例版本（${humanizeError(error).message}）。` +
        '将跳过版本门槛检查、直接请求服务端；若某些动作报「路由不存在」，' +
        '可设置环境变量 ZENTAO_VERSION（如 max8.5）来显式指定',
    };
  }
}

/** SDK 全局策略选项 */
export interface SdkPolicyOptions {
  /** 单次请求超时（毫秒），来自 `ZENTAO_TIMEOUT` */
  timeout?: number;
  /** 是否跳过 TLS 校验（自签证书的内网实例），来自 `ZENTAO_INSECURE` */
  insecure?: boolean;
  /** 每页条数，来自 `ZENTAO_REC_PER_PAGE` */
  recPerPage?: number;
}

/** 解析 `ZENTAO_INSECURE` 这类布尔开关 */
function parseBooleanEnv(raw: string | undefined, fallback = false): boolean {
  const value = (raw || '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  return fallback;
}

/** 读一个正整数环境变量，非法或缺失返回 undefined */
function parseIntEnv(raw: string | undefined): number | undefined {
  const value = parseInt((raw || '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 从环境变量读 SDK 策略（与本项目既有风格一致：配置一律走 env） */
export function readPolicyFromEnv(): SdkPolicyOptions {
  return {
    timeout: parseIntEnv(process.env.ZENTAO_TIMEOUT),
    insecure: parseBooleanEnv(process.env.ZENTAO_INSECURE),
    recPerPage: parseIntEnv(process.env.ZENTAO_REC_PER_PAGE),
  };
}

/**
 * 配置 SDK 的全局策略 —— 进程内调一次即可（幂等）。
 *
 * 三处都是**有意的选择**：
 *
 * 1. **`persistProfiles: false`（显式关闭）** —— 官方默认也是关，但这里明确声明：
 *    本 MCP **绝不往用户 home 目录写任何东西**，凭证只从 `.env` / 环境变量来。
 * 2. **`skipVersionCheckOnConfigError: true`** —— 探不到版本时不卡死整条工具链，
 *    让请求打到服务端、用真实结果说话（对「先保证能用」的定位更重要）。
 * 3. **`throwOnFail: true`** —— 业务失败（HTTP 200 + `status:'fail'`）转成异常，
 *    工具层就能统一 catch + 翻译成中文，不必每个工具自己判 `status`。
 *
 * ⚠️ 刻意**不设** `globals.version`：让 SDK 每次走 `adapter.getZentaoConfig()`，
 * 那里有 24 小时缓存 + 并发合并，成本只是一次内存判断；好处是「版本探测结果」
 * 与「门槛判定依据」永远同源，不会因两处缓存不一致而错判。
 */
export function configureSdkPolicy(sdk: SdkModule, options: SdkPolicyOptions = {}): void {
  sdk.setGlobalOptions({
    persistProfiles: false,
    skipVersionCheckOnConfigError: true,
    throwOnFail: true,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.insecure !== undefined ? { insecure: options.insecure } : {}),
    // SDK 的全局 recPerPage 声明为 string（它会直接进 query 参数）
    ...(options.recPerPage !== undefined ? { recPerPage: String(options.recPerPage) } : {}),
  });
}

/** 给工具输出用的版本摘要（一行） */
export function versionSummary(info: ZentaoVersionInfo): string {
  if (!info.version) return '禅道版本：未知（未探测到）';
  return `禅道版本：${info.version}（${editionLabel(info.edition)}）`;
}

/**
 * 判断某个动作在当前实例版本下是否可用。
 *
 * 直接委托 SDK 的 `getModuleAction(name, action, { version })` ——
 * **不自己实现版本比较**：那套「同系列逐段比较、缺段视为零、未列出的系列不支持」
 * 的规则由 SDK 唯一实现，抄一份必然漂移。
 */
export function isActionAvailable(
  sdk: SdkModule,
  moduleName: string,
  actionName: string,
  version: string | null
): boolean {
  if (!version) return true; // 版本未知 → 不做门槛判定（与 SDK 的 skipVersionCheckOnConfigError 一致）
  return Boolean(sdk.getModuleAction(moduleName, actionName, { version }));
}
