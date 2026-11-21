/**
 * SDK 层的统一出口。
 *
 * 工具层只需要 `getSdkRuntime(client)` 一个入口，拿到：
 *
 * ```ts
 * const rt = await getSdkRuntime(client);
 * rt.version                     // 实例版本（已探测 + 缓存）
 * rt.sdk.getModuleNames({...})   // 注册表查询
 * await rt.call('bug/list', {…}) // 执行任意官方动作
 * ```
 *
 * 这样设计的原因：**把「ESM 互操作 + 适配器构造 + 版本探测 + 全局策略」四件事
 * 收在一个地方**，业务工具里看不到任何 ESM/CJS 的痕迹。
 */

import type { ZenTaoClient } from '../client';
import { getSdk, type SdkModule } from './loader';
import { SdkClientAdapter } from './client-adapter';
import { configureSdkPolicy, readPolicyFromEnv, resolveVersion, type ZentaoVersionInfo } from './version';

/** 已就绪的 SDK 运行上下文 */
export interface SdkRuntime {
  /** 官方 SDK 本体（动态 import 的结果，含全部导出的类型与函数） */
  sdk: SdkModule;
  /** 传输层适配器（复用本项目的 axios 客户端） */
  adapter: SdkClientAdapter;
  /** 实例版本信息 */
  version: ZentaoVersionInfo;
  /** 执行一个官方动作：`call('bug/list', { productID: 7 })` */
  call: (requestName: string, params?: Record<string, unknown>, options?: SdkCallOptions) => Promise<unknown>;
}

/** 单次调用可覆盖的选项（对应 SDK 的 `RequestOptions`） */
export interface SdkCallOptions {
  /**
   * 本地过滤条件**组**：`['status=active,pri<=2']`。
   * ⚠️ 语义是「**组内 AND，组间 OR**」——同一个字符串元素里的逗号是 AND，
   * 数组元素之间是 OR。见 `tools/sdkCall.ts` 的 `toGroupList`。
   */
  filter?: string[];
  /** 本地搜索词**组**，语义同 `filter`（组内 AND、组间 OR） */
  search?: string[];
  /** 搜索范围字段；省略则搜全部字段 */
  searchFields?: string[];
  /** 本地排序，如 `id_desc` / `id:desc` */
  sort?: string;
  /** 本地限数（SDK 声明为 `string`，运行时用 `Number()` 容错，故收 `number | string`） */
  limit?: number | string;
  /** 只保留指定字段 */
  pick?: string[];
  /** `update` 动作先取现值再提交，避免未提交字段被清空 */
  autoFill?: boolean;
  /** html 字段转 Markdown（列表元素） */
  convert?: unknown;
  /** html 字段转 Markdown（单条对象） */
  convertSingle?: unknown;
  /** 返回服务端原始响应，不做归一化 */
  raw?: boolean;
  /** 每页条数覆盖 */
  recPerPage?: number | string;
  /** 单次超时覆盖 */
  timeout?: number;
  /** 业务失败时是否抛错（默认 true，见 configureSdkPolicy） */
  throwOnFail?: boolean;
  /** 上传文件大小上限 */
  maxUploadBytes?: number;
}

/** 每个客户端实例一份运行上下文（惰性构造 + 失败可重试） */
const runtimeCache = new WeakMap<ZenTaoClient, Promise<SdkRuntime>>();

/**
 * 取（或惰性构造）SDK 运行上下文。
 *
 * 构造过程：加载 SDK → 配置全局策略 → 建适配器 → 探测实例版本。
 * 全程只做一次；探测失败也不抛错（会降级为「版本未知」）。
 */
export function getSdkRuntime(client: ZenTaoClient): Promise<SdkRuntime> {
  const cached = runtimeCache.get(client);
  if (cached) return cached;

  const pending = (async (): Promise<SdkRuntime> => {
    const sdk = await getSdk();
    configureSdkPolicy(sdk, readPolicyFromEnv());

    const adapter = new SdkClientAdapter(client);
    const version = await resolveVersion(adapter);

    const call = (
      requestName: string,
      params: Record<string, unknown> = {},
      options: SdkCallOptions = {}
    ): Promise<unknown> => {
      // 适配器在结构上满足 SDK 的 client 契约，但类型上是两个不同的类
      // （官方 ZentaoClient vs 我们的鸭子类型适配器），这里显式跨过类型边界。
      const requestOptions = { ...options, client: adapter } as unknown as NonNullable<
        Parameters<SdkModule['request']>[2]
      >;
      return sdk.request(requestName, params, requestOptions) as Promise<unknown>;
    };

    return { sdk, adapter, version, call };
  })().catch((error) => {
    // 失败不留缓存，否则一次瞬时故障（比如依赖没装好）会永久污染这个客户端
    runtimeCache.delete(client);
    throw error;
  });

  runtimeCache.set(client, pending);
  return pending;
}

export { humanizeError, isVersionGateError, type HumanizedError } from './errors';
export { SdkClientAdapter, buildQueryString } from './client-adapter';
export {
  resolveVersion,
  clearVersionCache,
  describeVersion,
  editionLabel,
  isActionAvailable,
  parseVersion,
  versionSummary,
  type ZentaoVersionInfo,
} from './version';
export type { SdkModule } from './loader';
