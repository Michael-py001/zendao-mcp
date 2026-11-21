/**
 * 官方 SDK（`zentao-api`）的惰性加载器。
 *
 * ## 为什么需要这一层
 *
 * `zentao-api` 是**纯 ESM** 包（`package.json` 里 `"type": "module"`，且 `exports`
 * 只声明了 `import` 条件、**没有 `require`**）。本项目产物是 CJS，于是：
 *
 *   - `require('zentao-api')`        → ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED`（Node 24 也一样）
 *   - `await import('zentao-api')`   → ✅ 唯一可行的方式
 *
 * 而 `tsc` 在 `module: "CommonJS"` 下会把 `await import()` **降级成 `require()`**，
 * 编译期毫无异常、运行时才炸。所以 `tsconfig.json` 的 `module`/`moduleResolution`
 * 必须是 `node16` —— 这样 tsc 按 Node 的真实语义编译，CJS 文件里的 `import()`
 * 会被原样保留。
 *
 * ## 为什么类型这么写
 *
 * CJS 文件里写 `typeof import('zentao-api')` 这类**显式类型注解**会报 TS1541
 * （需要额外的 `resolution-mode` 属性）。这里改用「从函数返回值推导」的写法，
 * 全局只需在这一处处理 ESM 互操作。
 *
 * ## 惰性
 *
 * 注册表有 183KB（另有 457KB 的 `generated.js`），全量加载有明显开销。
 * 做成单例后，只在第一次真正调用 SDK 时加载一次，MCP 握手完全不受影响。
 */

/** 加载官方 SDK（进程内单例，失败会重置以便重试） */
export async function loadSdk() {
  return import('zentao-api');
}

/** 官方 SDK 的模块类型（从动态 import 推导，避免 TS1541） */
export type SdkModule = Awaited<ReturnType<typeof loadSdk>>;

let sdkPromise: Promise<SdkModule> | undefined;

/**
 * 取 SDK 单例。
 *
 * 失败时清空缓存 —— 否则一次瞬时故障（比如装依赖时的竞争）会把错误
 * 永久缓存下来，进程内再也拿不到 SDK。
 */
export function getSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = loadSdk().catch((error) => {
      sdkPromise = undefined;
      throw error;
    });
  }
  return sdkPromise;
}
