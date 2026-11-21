/**
 * 官方 SDK ↔ 本项目 axios 客户端之间的**传输层适配器**。
 *
 * ## 它解决什么问题
 *
 * 官方 `zentao-api` 的 `request('bug/get', params, { client })` 只要求传入的对象
 * 具备两个方法（鸭子类型，见 SDK 的 `types/client.d.ts`）：
 *
 * ```ts
 * client.request(path, { method, query, body, bodyType, headers, responseType, timeout, insecure, signal })
 * client.getZentaoConfig(options) → { version, ... }
 * ```
 *
 * 于是有两条路：
 *
 * | 方案 | 结果 |
 * | --- | --- |
 * | 直接用 SDK 的 `ZentaoClient` | 要重写 401 自动重登、代理处理、中文错误、PUT/DELETE 被掐探测、附件下载 —— 丢掉本项目的实战调优 |
 * | ✅ **鸭子类型适配器**（本文件） | 复用现有 axios 客户端，把上面这些能力**全部保留**，只新增两个方法 |
 *
 * ## 关键语义：本适配器**不判业务状态**
 *
 * 禅道的业务失败是 **HTTP 200 + `{status:'fail'}`**。SDK 的 `normalizeResponse()`
 * 需要拿到这个原始响应体，自己决定返回 `{status:'fail', message, raw}` 还是抛 `E_API_FAILED`。
 * 所以这里一律走 `client.requestRaw()`（不解析业务状态），而不是 `client.get()`。
 *
 * HTTP 层错误（4xx/5xx）则**照抛** —— 转成 SDK 的 `ZentaoError`，
 * 让它能识别 `E_HTTP_ERROR` / `E_NETWORK_ERROR` / `E_TIMEOUT`（`isZentaoConfigFetchError` 依赖这个）。
 */

import type { ZenTaoClient } from '../client';
import type { SdkModule } from './loader';
import { getSdk } from './loader';

/** SDK 传给 `client.request()` 的选项（见 SDK `ClientRequestOptions`） */
export interface SdkClientRequestOptions {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  bodyType?: string;
  headers?: unknown;
  responseType?: string;
  timeout?: number;
  insecure?: boolean;
  signal?: AbortSignal;
}

/** SDK 站点配置（`/?mode=getconfig` 的响应），至少要有一个可解析的 `version` */
export interface SdkServerConfig {
  version: string;
  [key: string]: unknown;
}

/** SDK 的版本探测选项 */
export interface SdkConfigOptions {
  forceRefresh?: boolean;
  timeout?: number;
  insecure?: boolean;
  signal?: AbortSignal;
}

/** 站点配置缓存有效期：24 小时（与官方 `CONFIG_MAX_AGE` 对齐） */
const CONFIG_MAX_AGE = 24 * 60 * 60 * 1000;

/**
 * 判断路径是不是**动作端点**：`/{模块}/{对象ID}/{动作}` 三段式。
 *
 * 为什么要单独识别这一类（2026-11-20 实测）：本实例前置 Web 服务器在 HTTP 层
 * 直接 RST 掉 PUT/DELETE，而禅道的动作端点 `/{模块}/{ID}/{动作}` 只按路径匹配、
 * **不校验方法**，POST 能打到同一个处理器。
 *
 * 但「方法覆盖」（`POST /bugs/{id}/resolve` + `X-HTTP-Method-Override: PUT`）**不需要**：
 * 动作端点本来就吃 POST。实测 `POST /bugs/2011223/resolve` 直接返回
 * `{"status":"success","message":"保存成功"}`。
 *
 * ⚠️ 只对三段式动作端点这么做。两段式的 `PUT /bugs/{id}`（更新）与
 * `DELETE /bugs/{id}`（删除）**没有** POST 版本 —— 硬发 POST 会掉进「建单」路由
 * （报 `Product does not exist.`，参数凑巧齐全时还会造出脏数据）。
 * 那两类仍然如实失败，不做任何降级。
 */
export function isActionEndpoint(path: string): boolean {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  if (segments.length !== 3) return false;
  // 第二段必须是对象 ID（纯数字），第三段必须是动作名（非数字）。
  // 反例 `/doc/spaces/{spaceID}`、`/workflow/contract/{contractID}` 同是三段，
  // 但第二段是子资源名、第三段是 ID —— 那是 update 端点，不是动作端点。
  return /^\d+$/.test(segments[1]) && !/^\d+$/.test(segments[2]);
}

/**
 * 判断「这个 PUT 没法用，值得改走 POST」。
 *
 * 两种失败都要算（2026-11-20 实测本机）：
 *
 * 1. **传输层直接拒绝 PUT** —— 连接被 RST，报 `ECONNRESET` / `socket hang up`。
 *    直连禅道时就是这一种。
 * 2. **前置代理拒绝 PUT** —— 本机 `HTTP_PROXY` 指向本地代理，而 `NO_PROXY` 没包含
 *    禅道内网地址，代理对 GET/POST 放行（200）却对 PUT 回 **502**。
 *    这种情况报的是 `ERR_BAD_RESPONSE`，不是「方法被拒」，光看方法判定会漏掉。
 *
 * 只认 502/405/501 这三个状态码，别把「业务报错」或「500」误当成方法问题 ——
 * 误判的代价是同一份数据被提交两次。
 */
function isPutUnusable(error: unknown, transportRejected: boolean): boolean {
  if (transportRejected) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 502 || status === 405 || status === 501;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 查询参数序列化 —— **逐字对齐官方 `appendQueryValue`**。
 *
 * 官方规则（`dist/client/index.js`）：
 *   - 数组 → `key[0]=v0&key[1]=v1`
 *   - 普通对象 → `key[child]=v`（deepObject 风格，递归）
 *   - `null` → 空串
 *
 * ⚠️ 不能用 axios 默认的 paramsSerializer：它对数组用的是 `key[]=v0&key[]=v1`，
 * 与官方的 `key[0]` 形态不同，禅道的多值查询参数会解析失败。
 */
function appendQueryValue(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendQueryValue(search, `${key}[${index}]`, item));
    return;
  }
  if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendQueryValue(search, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  search.append(key, value === null ? '' : String(value));
}

/** 按官方规则把 query 对象拼成 `?a=1&b[0]=2` 形式（无参数时返回空串） */
export function buildQueryString(query?: Record<string, unknown>): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) appendQueryValue(search, key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** form 类型请求体的值序列化（数组展开成重复键，对象 JSON 化，null 变空串） */
function appendFormValue(form: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, key, item);
    return;
  }
  if (value === null) {
    form.append(key, '');
    return;
  }
  form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
}

/** 已识别为「原样透传给 axios」的请求体类型（multipart / 二进制 / 字符串等） */
function isRawBody(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (value instanceof URLSearchParams) return true;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  return false;
}

/**
 * 请求体整形：对齐官方 `serializeBody()` 的语义。
 *
 * | `bodyType` | 输入 | 处理 |
 * | --- | --- | --- |
 * | `form` | 普通对象 | → `URLSearchParams`（`application/x-www-form-urlencoded`） |
 * | `raw` | FormData / 二进制 / 字符串 | 原样透传（multipart 的 boundary 由 axios 生成） |
 * | 未指定 | 普通对象 | 原样交给 axios → JSON |
 *
 * ⚠️ multipart **不设置** `Content-Type`：必须让 axios 自己带上 `boundary`，
 * 手写 `multipart/form-data` 会因缺少 boundary 而被服务端拒收。
 */
function prepareBody(
  body: unknown,
  bodyType: string | undefined
): { data?: unknown; headers: Record<string, string> } {
  if (body === undefined || body === null) return { headers: {} };

  if (bodyType === 'form') {
    if (body instanceof URLSearchParams) return { data: body, headers: {} };
    if (isPlainObject(body)) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) appendFormValue(form, key, value);
      return { data: form, headers: {} };
    }
  }

  if (bodyType === 'raw' || isRawBody(body)) {
    return { data: body, headers: {} };
  }

  // 普通对象 → 交给 axios 序列化为 JSON（它会自己补 Content-Type）
  return { data: body, headers: {} };
}

/** 把 `Headers` 实例或普通对象统一成 `Record<string, string>` */
function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) out[key] = String(value);
    }
  }
  return out;
}

/** axios 的 `responseType` 取值 */
type AxiosResponseType = 'json' | 'text' | 'arraybuffer';

function mapResponseType(responseType: string | undefined): AxiosResponseType {
  switch (responseType) {
    case 'text':
      return 'text';
    case 'arrayBuffer':
    case 'blob':
      return 'arraybuffer';
    default:
      return 'json';
  }
}

/**
 * 把 SDK 期望的响应体形态还原出来。
 *
 * axios（Node）对 `arraybuffer` 给的是 `Buffer`，而 `fetch()` 的
 * `arrayBuffer()` 给的是 `ArrayBuffer` —— 形状不同，这里补平，
 * 免得后续依赖「二进制响应」的动作拿到意外类型。
 */
function restoreResponseShape(data: unknown, responseType: string | undefined): unknown {
  if (responseType === 'arrayBuffer') {
    if (Buffer.isBuffer(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return data;
  }
  if (responseType === 'blob' && Buffer.isBuffer(data) && typeof Blob !== 'undefined') {
    return new Blob([new Uint8Array(data)]);
  }
  return data;
}

/**
 * 把本项目的 `ZenTaoError`（axios 拦截器产物）翻译成 SDK 的 `ZentaoError`。
 *
 * 为什么必须翻译：SDK 内部靠 `error.code` 判断行为，例如
 * `isZentaoConfigFetchError()` 只认 `E_HTTP_ERROR` / `E_NETWORK_ERROR` / `E_TIMEOUT` /
 * `E_INVALID_ZENTAO_CONFIG`；`instanceof ZentaoError` 也用于区分「SDK 错误」与意外异常。
 */
function toSdkError(sdk: SdkModule, error: unknown): unknown {
  if (error instanceof sdk.ZentaoError) return error;

  const anyError = error as
    | { status?: unknown; code?: unknown; message?: unknown; hint?: unknown; details?: unknown }
    | null
    | undefined;
  const message = String(anyError?.message ?? error);
  const errorCode = anyError?.code;
  const httpStatus = typeof anyError?.status === 'number' ? anyError.status : undefined;

  if (errorCode === 'ECONNABORTED' || /timeout/i.test(message)) {
    return new sdk.ZentaoError('E_TIMEOUT', undefined, error);
  }

  if (httpStatus !== undefined && httpStatus >= 400) {
    return new sdk.ZentaoError(
      'E_HTTP_ERROR',
      { status: httpStatus, statusText: String(anyError?.hint ?? '') },
      { status: httpStatus, message, body: anyError?.details }
    );
  }

  return new sdk.ZentaoError('E_NETWORK_ERROR', { message }, error);
}

/**
 * 鸭子类型客户端：官方 SDK 只用到这两个方法。
 *
 * 用法：`request('bug/list', params, { client: adapter })`。
 */
export class SdkClientAdapter {
  private readonly client: ZenTaoClient;
  /** 站点配置缓存（`/?mode=getconfig` 的结果） */
  private serverConfig?: SdkServerConfig;
  /** 缓存时间戳（毫秒） */
  private serverConfigFetchedAt = 0;
  /** 进行中的配置请求，用于合并并发（对齐官方的 configRequest 语义） */
  private configRequest?: Promise<SdkServerConfig>;

  constructor(client: ZenTaoClient) {
    this.client = client;
  }

  /** 站点根地址（如 `http://host/zentaomax`），供拼 `/?mode=getconfig` 用 */
  get siteUrl(): string {
    return this.client.siteBaseUrl;
  }

  /**
   * 发起一次 API 请求，返回**原始的**响应体（不做业务状态判定）。
   *
   * @param path 相对 `/api.php/v2` 的路径，如 `/bugs`
   */
  async request(path: string, options: SdkClientRequestOptions = {}): Promise<unknown> {
    const sdk = await getSdk();
    const method = String(options.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE';

    if (options.responseType === 'response') {
      throw new sdk.ZentaoError('E_INVALID_PARAM', {
        param: 'responseType',
        value: 'response',
      });
    }

    const query = buildQueryString(options.query);
    const endpoint = query ? `${path}${query}` : path;
    const prepared = prepareBody(options.body, options.bodyType);

    const requestHeaders = { ...normalizeHeaders(options.headers), ...prepared.headers };

    try {
      const response = await this.requestWithActionFallback({
        method,
        endpoint,
        // GET 不带请求体，避免部分代理拒收（官方也这么做）
        data: method === 'GET' ? undefined : prepared.data,
        headers: requestHeaders,
        timeout: options.timeout,
        responseType: mapResponseType(options.responseType),
      });

      return restoreResponseShape(response.data, options.responseType);
    } catch (error) {
      throw toSdkError(sdk, error);
    }
  }

  /**
   * 发请求；PUT 被传输层掐断且目标是**动作端点**时，改用 POST 重发。
   *
   * 背景见 {@link isActionEndpoint}：本实例在 HTTP 层拒绝 PUT，但动作端点
   * `/{模块}/{ID}/{动作}` 吃 POST。走 `client.put()` 那条路时项目里已有
   * `sendWithMethodOverride()` 负责降级，可 SDK 这条路直接调 `requestRaw()`，
   * 把整套降级逻辑绕过去了 —— 于是 `zendao_call { module: "bug", action: "resolve" }`
   * 在这台机器上必定失败（实测 `E_HTTP_ERROR`）。
   *
   * 这里只补「动作端点」这一种情况。update / delete 的 `/{模块}/{ID}` 没有 POST 版本，
   * 不降级 —— 宁可如实报错，也不把请求送到建单路由上。
   */
  private async requestWithActionFallback(options: {
    method: string;
    endpoint: string;
    data?: unknown;
    headers: Record<string, string>;
    timeout?: number;
    responseType: AxiosResponseType;
  }): Promise<{ status: number; headers: Record<string, unknown>; data: unknown }> {
    const send = (method: string) =>
      this.client.requestRaw({ ...options, method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' });

    try {
      return await send(options.method);
    } catch (error) {
      if (options.method !== 'PUT' || !isActionEndpoint(options.endpoint)) throw error;
      if (!isPutUnusable(error, this.client.isTransportMethodRejected(error))) throw error;
      return send('POST');
    }
  }

  /**
   * 匿名读取站点配置，用于**运行时探测禅道版本**（SDK 的版本门槛判定依赖它）。
   *
   * 与官方实现对齐的要点：
   * - 请求 `{站点根}/?mode=getconfig`，**不带认证头**（官方用 `credentials: 'omit'`）
   * - 结果缓存 24 小时；`forceRefresh` 忽略缓存
   * - 并发调用合并为一次请求
   * - ⚠️ 官方用 `fetch` 的 `redirect: 'manual'`，axios 默认跟随重定向；
   *   这里通过 `skipAuth` + 校验响应体形态来保证「拿到登录页就报错」而不是静默成功
   */
  async getZentaoConfig(options: SdkConfigOptions = {}): Promise<SdkServerConfig> {
    const sdk = await getSdk();
    const now = Date.now();
    const age = now - this.serverConfigFetchedAt;

    if (!options.forceRefresh && this.serverConfig && age >= 0 && age <= CONFIG_MAX_AGE) {
      return { ...this.serverConfig };
    }

    if (this.configRequest) return this.configRequest;

    const pending = (async () => {
      let raw: { status: number; data: unknown };
      try {
        raw = await this.client.requestRaw({
          method: 'GET',
          absoluteUrl: `${this.siteUrl}/?mode=getconfig`,
          responseType: 'json',
          timeout: options.timeout,
          skipAuth: true,
        });
      } catch (error) {
        // 只有「取不到配置」这一种失败可以降级；转成 SDK 认识的字码，
        // 使 `skipVersionCheckOnConfigError` 能真正生效。
        throw toSdkError(sdk, error);
      }

      const config = raw.data;
      if (!isRecord(config) || typeof config.version !== 'string' || !config.version.trim()) {
        throw new sdk.ZentaoError('E_INVALID_ZENTAO_CONFIG', undefined, config);
      }

      this.serverConfig = config as SdkServerConfig;
      this.serverConfigFetchedAt = Date.now();
      return { ...(config as SdkServerConfig) };
    })();

    this.configRequest = pending;
    try {
      return await pending;
    } finally {
      this.configRequest = undefined;
    }
  }
}
