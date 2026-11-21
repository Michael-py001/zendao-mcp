/**
 * 禅道 API 客户端
 *
 * 默认对接**禅道 API 2.0**（`{站点根}/api.php/v2`）。
 * 之所以不是 v1：官方 CLI（easysoft/zentao-cli）与 SDK（zentao-api）都跑在 2.0 上，
 * 且只有 2.0 才把「任务」放在它真正该在的位置 —— 任务属于执行（execution），
 * 列表接口是 `/executions/{executionID}/tasks`，顶层 `/tasks` 根本不存在。
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { ZenTaoConfig, ZenTaoError } from './types';
import { Logger, LogLevel } from './utils/logger';

/**
 * 把禅道的失败原因格式化成**人能读懂的一句话**。
 *
 * 为什么需要它（2026-09-15 实测踩到）：禅道的**表单字段校验失败**返回的是
 *   { "status": "fail", "message": { "status": ["『Bug状态』不符合格式，应当为:『/active|resolved|closed/』。"] } }
 * —— `message` 是个**对象**。直接 `new Error(data.message)` 会得到一句
 * `[object Object]`，调用方完全看不出发生了什么（这一条曾把「确认 Bug 失败」伪装成了无名错误）。
 *
 * 这里把对象按 `字段: 错误1；错误2 | 字段2: …` 摊平成一句可读文本。
 */
function formatFailMessage(message: unknown): string {
  if (message === undefined || message === null) return '';
  if (typeof message === 'string') return message;
  if (typeof message === 'number' || typeof message === 'boolean') return String(message);

  if (typeof message === 'object') {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(message as Record<string, unknown>)) {
      const text = Array.isArray(value)
        ? value.map((item) => String(item)).join('；')
        : typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value);
      if (text) parts.push(`${field}: ${text}`);
    }
    if (parts.length) return parts.join(' | ');
  }

  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * 内网地址不该走 HTTP 代理。
 *
 * 2026-11-20 实测：本机 `HTTP_PROXY` 指向本地代理（127.0.0.1:7897），`NO_PROXY` 里
 * 没有禅道网段，于是请求全被代理转发。代理对 GET / POST 放行（200），**对 PUT 一律回 502**
 * —— 表现为「读一切正常，改 Bug 状态 / 改字段全失败」，错误码只有 502，
 * 极容易被误判成路由或权限问题（这次就绕了一圈）。
 *
 * axios 只认 `HTTP_PROXY` / `NO_PROXY` 环境变量，不会自己判断「内网地址该直连」。
 * 这里补上：目标是私有网段（10/8、172.16/12、192.168/16、127/8、localhost）且
 * 用户没在 `NO_PROXY` 里显式要求走代理时，直接 `proxy: false`。
 *
 * 显式 `NO_PROXY=*` 或把主机写进 `NO_PROXY` 的情况由 axios 自己处理，这里不抢。
 */
function shouldBypassProxy(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const privateB = /^172\.(\d{1,2})\./.exec(host);
  if (privateB) {
    const second = Number(privateB[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export class ZenTaoClient {
  private config: ZenTaoConfig;
  private http: AxiosInstance;
  private logger: Logger;
  /** REST API 前缀，形如 `/api.php/v2` */
  readonly apiPrefix: string;
  /** 由 account/password 换来的 REST Token，内存缓存 */
  private restToken: string | null = null;
  /**
   * `auto` 模式下学到的结论：本实例在 HTTP 层拒绝 PUT/DELETE。
   * 一旦探测到，后续写请求直接走方法覆盖，不再白挨一次连接重置。
   */
  private overrideLearned = false;
  /** 方法覆盖策略（从配置读入，见 ZenTaoConfig.methodOverride） */
  private methodOverride: 'auto' | 'always' | 'never';

  constructor(config: ZenTaoConfig, logger?: Logger) {
    this.config = {
      timeout: 30000,
      retry: 3,
      retryDelay: 1000,
      apiVersion: 'v2',
      methodOverride: 'auto',
      ...config,
    };
    this.apiPrefix = `/api.php/${this.config.apiVersion}`;
    this.methodOverride = this.config.methodOverride || 'auto';
    this.logger = logger || new Logger(LogLevel.INFO);

    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
      ...(shouldBypassProxy(this.config.baseUrl) ? { proxy: false } : {}),
    });

    // 请求拦截器
    this.http.interceptors.request.use(
      async (config) => {
        config.headers = config.headers || {};
        // 匿名请求（如 SDK 的站点配置探测 `/?mode=getconfig`）显式跳过认证注入：
        // 那类请求本来就不需要、也不该带 Token。
        if ((config as unknown as Record<string, unknown>)._skipAuth) return config;
        // 认证头可能是异步拿到的（自动换取 Token），所以这里必须 await
        const authHeaders = await this.resolveAuthHeaders();
        Object.assign(config.headers, authHeaders);
        return config;
      },
      (error) => {
        this.logger.error('请求配置错误', error);
        return Promise.reject(error);
      }
    );

    // 响应拦截器
    this.http.interceptors.response.use(
      (response: AxiosResponse<any>) => {
        this.logger.debug(`API 请求成功: ${response.config.url}`);
        return response;
      },
      async (error) => {
        const originalRequest = error.config;

        this.logger.error(`API 请求失败: ${originalRequest?.url}`, error.message);

        // 401 + 已配置账号密码 → Token 可能过期/被踢下线，重换一个再试一次。
        // 这是「REST Token 会失效」这个现实问题的兜底，跑长任务时尤其重要。
        if (
          error.response?.status === 401 &&
          this.config.account &&
          this.config.password &&
          originalRequest &&
          !originalRequest._authRetried
        ) {
          originalRequest._authRetried = true;
          this.logger.info('认证已失效，正在重新获取 Token 并重试…');
          this.restToken = null;
          try {
            await this.ensureRestToken();
            return this.http(originalRequest);
          } catch (refreshError) {
            return Promise.reject(this.transformError(refreshError));
          }
        }

        // 重试逻辑
        if (this.shouldRetry(error) && originalRequest && this.config.retry! > 0) {
          originalRequest._retryCount = originalRequest._retryCount || 0;

          if (originalRequest._retryCount < this.config.retry!) {
            originalRequest._retryCount++;
            this.logger.info(`重试请求 (${originalRequest._retryCount}/${this.config.retry}): ${originalRequest.url}`);

            await this.delay(this.config.retryDelay || 1000);
            return this.http(originalRequest);
          }
        }

        return Promise.reject(this.transformError(error));
      }
    );
  }

  /** 当前登录账号。用于「指派给我」这类需要本地兜底过滤的场景 */
  get currentAccount(): string | undefined {
    return this.config.account;
  }

  /** 站点根地址（形如 `http://host/zentaomax`）。用于拼附件这类非 API 资源的 URL */
  get siteBaseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * 网页（`index.php`）登录用的账号密码。
   *
   * ⚠️ 网页登录**必须**有明文密码 —— REST Token 和官方 CLI 的 profile（只存 Token）
   * 都用不上。所以这两项都可能为 `undefined`，调用方要自己判断题「该能力不可用」。
   * 用途见 `src/web/session.ts`（自定义日志写入 / 编辑 / 删除只有网页通路）。
   */
  get webCredentials(): { account?: string; password?: string } {
    return { account: this.config.account, password: this.config.password };
  }

  /**
   * 取一个**非 API 的原始字节资源**（目前用于下载附件）。
   *
   * 为什么不能复用 `get()`：
   * 1. `get()` 走 `handleResponse`，只接受 JSON，非 JSON 会直接抛错；
   * 2. 附件是二进制，必须 `responseType: 'arraybuffer'`；
   * 3. 本实例的静态响应**连 content-type 都不给**，任何基于头部的判断都不可靠。
   *
   * 这里刻意用 `validateStatus: () => true`：把状态码原样交给调用方判断，
   * 免得 302/404 被 axios 抛成异常、掩盖掉「到底拿到了什么」。
   * 认证头仍然带上（拦截器自动加）—— 万一该实例哪天收紧了静态目录权限，
   * 带 Token 的请求还能取到，不依赖它但也不白白放弃。
   */
  async fetchBinary(urlOrPath: string): Promise<{
    status: number;
    data: Buffer;
    contentType?: string;
    location?: string;
  }> {
    const url = /^https?:\/\//i.test(urlOrPath)
      ? urlOrPath
      : `${this.config.baseUrl}/${String(urlOrPath).replace(/^\/+/, '')}`;

    const response = await this.http.get(url, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
      timeout: this.config.timeout,
    });

    return {
      status: response.status,
      data: Buffer.from(response.data || []),
      contentType: response.headers?.['content-type'] as string | undefined,
      location: response.headers?.['location'] as string | undefined,
    };
  }

  /**
   * **低层原始请求**：原样返回 HTTP 状态与响应体，**不做业务状态判定**。
   *
   * 与 `get()` / `post()` 的区别（这是给官方 SDK 适配器用的，两者语义不能混）：
   *
   * | | `get()` / `post()` | `requestRaw()` |
   * | --- | --- | --- |
   * | 业务失败（HTTP 200 + `status:'fail'`） | **抛错**（`handleResponse` 判定） | **原样返回** |
   * | HTTP 4xx/5xx | 抛错（经拦截器转换） | 抛错（同上，保持 401 自动重登生效） |
   *
   * 为什么必须「不判业务状态」：官方 SDK 的 `normalizeResponse()` 需要拿到**原始响应体**，
   * 自己按 `status === 'fail'` 决定是返回 `{status:'fail'}` 还是抛 `E_API_FAILED`。
   * 如果这里先抛了，SDK 的 `rawMessage` / `raw` 上下文全丢，错误会退化成一句笼统的话。
   *
   * HTTP 层错误仍然照抛 —— 这正是我们想要的：让 `this.http` 拦截器（401 自动重登、
   * 重试、错误中文化）继续生效，由适配器负责把本项目的 `ZenTaoError` 翻译成 SDK 的 `ZentaoError`。
   *
   * @param options.endpoint    API 相对路径（如 `/bugs`），自动补 `api.php/v2` 前缀
   * @param options.absoluteUrl 完整 URL（如站点根的 `/?mode=getconfig`），与 endpoint 二选一
   * @param options.skipAuth    为 true 时不注入认证头（匿名请求）
   * @param options.timeout     单次请求超时，覆盖实例默认值
   * @param options.responseType 期望的响应体形态；默认 `json`（非 JSON 会原样保留为字符串）
   */
  async requestRaw(options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    endpoint?: string;
    absoluteUrl?: string;
    params?: Record<string, unknown>;
    data?: unknown;
    headers?: Record<string, string>;
    timeout?: number;
    responseType?: 'json' | 'text' | 'arraybuffer';
    skipAuth?: boolean;
  }): Promise<{ status: number; headers: Record<string, unknown>; data: unknown }> {
    if (!options.endpoint && !options.absoluteUrl) {
      throw new Error('requestRaw 需要 endpoint 或 absoluteUrl 之一');
    }

    const response = await this.http.request({
      method: options.method,
      url: options.absoluteUrl ?? this.resolveEndpoint(options.endpoint as string),
      params: options.params,
      data: options.data,
      headers: options.headers,
      timeout: options.timeout ?? this.config.timeout,
      responseType: options.responseType ?? 'json',
      _skipAuth: options.skipAuth,
    } as AxiosRequestConfig);

    return {
      status: response.status,
      // axios 的 headers 是 AxiosHeaders 实例，摊平成普通对象再交出去
      headers: { ...(response.headers as unknown as Record<string, unknown>) },
      data: response.data,
    };
  }

  /**
   * 把工具传入的「相对接口路径」补成完整 API 路径。
   *
   * 工具统一写 `/projects`、`/executions/{id}/tasks` 这种相对形式，
   * `api.php/v2` 前缀由这里集中拼，避免每个工具各自拼错版本号。
   * 若传入的已经是 `/api.php/...` 完整路径，则原样保留（方便临时调 v1 接口）。
   */
  resolveEndpoint(endpoint: string): string {
    const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    if (/^\/api\.php\//i.test(ep)) return ep;
    return `${this.apiPrefix}${ep}`;
  }

  /**
   * 生成当前 API 版本对应的分页参数。
   *
   * 禅道 2.0 用的是 `pageID` / `recPerPage`，1.0 是 `page` / `limit`。
   * 对外（MCP 工具）统一暴露更直观的 page/limit，映射集中在这里做。
   */
  paginationParams(page?: number, limit?: number): Record<string, number> {
    const isV2 = this.config.apiVersion !== 'v1';
    const out: Record<string, number> = {};
    if (page != null) out[isV2 ? 'pageID' : 'page'] = page;
    if (limit != null) out[isV2 ? 'recPerPage' : 'limit'] = limit;
    return out;
  }

  /**
   * GET 请求
   */
  async get<T = any>(endpoint: string, params?: any): Promise<T> {
    try {
      const response = await this.http.get(this.resolveEndpoint(endpoint), { params });
      return this.handleResponse<T>(response);
    } catch (error) {
      this.logger.error(`GET 请求失败: ${endpoint}`, error);
      throw error;
    }
  }

  /**
   * POST 请求
   */
  async post<T = any>(endpoint: string, data?: any): Promise<T> {
    try {
      const response = await this.http.post(this.resolveEndpoint(endpoint), data);
      return this.handleResponse<T>(response);
    } catch (error) {
      this.logger.error(`POST 请求失败: ${endpoint}`, error);
      throw error;
    }
  }

  /**
   * PUT 请求
   */
  async put<T = any>(endpoint: string, data?: any): Promise<T> {
    try {
      return await this.sendWithMethodOverride<T>('PUT', endpoint, data);
    } catch (error) {
      this.logger.error(`PUT 请求失败: ${endpoint}`, error);
      throw error;
    }
  }

  /**
   * DELETE 请求
   */
  async delete<T = any>(endpoint: string, params?: any): Promise<T> {
    try {
      return await this.sendWithMethodOverride<T>('DELETE', endpoint, undefined, params);
    } catch (error) {
      this.logger.error(`DELETE 请求失败: ${endpoint}`, error);
      throw error;
    }
  }

  /**
   * 用**原生 HTTP 方法**发一次请求，**永不**降级为方法覆盖。
   *
   * 为什么要有这个「逃生口」（2026-09-15 实测后新增）：
   *
   * 本实例的 `/api.php/v2` 入口**根本不认方法覆盖**。四种姿势全试过，一律无效：
   *   `_method=PUT` 放 query、`X-HTTP-Method-Override` 放头、`_method` 放 JSON body、
   *   `_method` 放表单 body —— 请求仍然按 **POST** 分发。
   *
   * 后果不是「失败」，而是**打到一个语义完全不同的端点**上：
   *   `POST /bugs/{id}`（本想 PUT 更新 / DELETE 删除）会掉进 `POST /bugs` 建单路由，
   *   返回一句莫名其妙的 `Product does not exist.`；参数恰好齐全时更糟 —— 会**建出脏数据**。
   *
   * 所以凡是不接受「被悄悄换成 POST」的调用（删除类、集合级 `/{id}` 的 PUT），
   * 一律走这里：宁可直接报「本实例不支持该方法」，也不要把请求送到别的语义上。
   */
  async requestNative<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: any,
    params?: any
  ): Promise<T> {
    const response = await this.http.request({
      method,
      url: this.resolveEndpoint(endpoint),
      data,
      params,
    });
    return this.handleResponse<T>(response);
  }

  /**
   * 判断错误是否属于「HTTP 方法被传输层拒绝」：
   * 连接被重置 / socket hang up / 405 Method Not Allowed / 501 Not Implemented。
   * 工具层用它把 `read ECONNRESET` 翻译成人能看懂的一句话。
   */
  isTransportMethodRejected(error: any): boolean {
    return this.isMethodRejected(error);
  }

  /** 当前实际生效的方法覆盖策略（供能力自检/诊断展示） */
  get methodOverrideMode(): 'auto' | 'always' | 'never' {
    return this.methodOverride;
  }

  /** 是否已经探测出「本实例拒绝原生 PUT/DELETE」 */
  get methodOverrideActive(): boolean {
    return this.methodOverride === 'always' || (this.methodOverride === 'auto' && this.overrideLearned);
  }

  /**
   * 发送 PUT / DELETE 写请求，并在必要时降级为「方法覆盖」。
   *
   * 为什么保留这套机制：本项目对接的禅道实例，前置 Web 服务器会在 HTTP 层
   * 直接掐断 PUT/DELETE（连接被 ECONNRESET，连响应体都拿不到）。方法覆盖
   * （`POST + X-HTTP-Method-Override` / `?_method=`）是**通用**的绕过手段，
   * 换个实例（或运维放开方法限制）就是它的用处。
   *
   * ⚠️ **但在当前这个实例上，覆盖是无效的** —— 2026-09-15 实测（`tmp-probe-*` 系列探针，
   * 结果记在 README「坑七」）：
   *   - `_method` 放 query / `X-HTTP-Method-Override` 放头 / 放 JSON body / 放表单 body，**全部无效**；
   *   - 请求仍按 POST 分发，于是 `POST /bugs/{id}` 掉进 `POST /bugs` 建单路由，
   *     报 `Product does not exist.`（**看着像「对象不存在」，其实是路走错了**）；
   *   - 真正能用的路子是：**动作端点 `/{module}/{id}/{action}` 直接用 POST，并把资源 ID 放进 body**
   *     （禅道的 action 路由按路径匹配、不校验方法，ID 则从 body 参数里取）。
   *
   * 所以策略是「谁需要覆盖谁显式用」：
   * - 工具层能走 POST 动作路由的，一律走 POST（见 `tools/bugActions.ts`）；
   * - 不希望被悄悄换成 POST 的（删除类），显式用 `requestNative()`，让它在传输层直接报错。
   *
   * 策略（本方法的 `auto` / `always` / `never`）：
   * - `always` / 已学到的 `auto` → 直接走覆盖，不发原生方法
   * - `auto`（默认）→ 先发原生方法，只在「被传输层拒绝」时改用覆盖重发一次，
   *   并把结论缓存下来，避免每次写操作都白挨一次连接重置
   * - `never` → 永不覆盖
   *
   * 判断标准刻意收紧（只看连接被重置 / socket hang up / 405 / 501），
   * 免得把正常的业务报错或网络抖动误判成「方法不被支持」。
   */
  private async sendWithMethodOverride<T>(
    method: 'PUT' | 'DELETE',
    endpoint: string,
    data?: any,
    params?: any
  ): Promise<T> {
    const url = this.resolveEndpoint(endpoint);

    if (this.methodOverride === 'never') {
      return this.sendNative<T>(method, url, data, params);
    }

    if (this.methodOverride === 'always' || this.overrideLearned) {
      return this.handleResponse<T>(await this.sendOverridden(method, url, data, params));
    }

    try {
      return await this.sendNative<T>(method, url, data, params);
    } catch (error: any) {
      if (!this.isMethodRejected(error)) throw error;

      this.overrideLearned = true;
      this.logger.warn(
        `本实例在 HTTP 层拒绝了 ${method}（${error?.code || error?.message || '未知'}），` +
          '改用 POST + X-HTTP-Method-Override 重试，后续写请求将直接走覆盖'
      );

      return this.handleResponse<T>(await this.sendOverridden(method, url, data, params));
    }
  }

  /** 按真实方法发一次（正常禅道实例走的就是这条） */
  private async sendNative<T>(
    method: 'PUT' | 'DELETE',
    url: string,
    data?: any,
    params?: any
  ): Promise<T> {
    const response =
      method === 'PUT' ? await this.http.put(url, data) : await this.http.delete(url, { params });
    return this.handleResponse<T>(response);
  }

  /**
   * 用 `POST + X-HTTP-Method-Override` 把请求转发到应用层。
   * 同时带上 `?_method=` 参数作双保险 —— 个别前置代理会剥掉自定义请求头。
   *
   * ⚠️ 更正一条旧结论（2026-09-15 实测）：**当前实例的 `/api.php/v2` 入口两种写法都不认**，
   * 请求会按 POST 分发、落到别的路由上。这条路径只对「真的支持方法覆盖的实例/前置代理」
   * 有意义；本实例的动作端点请直接走 POST（见 `requestNative()` 的说明）。
   */
  private sendOverridden(
    method: string,
    url: string,
    data?: any,
    params?: any
  ): Promise<AxiosResponse<any>> {
    return this.http.request({
      method: 'POST',
      url,
      params: { ...(params || {}), _method: method },
      data,
      headers: { 'X-HTTP-Method-Override': method },
    });
  }

  /**
   * 判断错误是否属于「HTTP 方法本身没被服务器接受」，
   * 即：连接被重置 / socket 被挂断 / 405 Method Not Allowed / 501 Not Implemented。
   */
  private isMethodRejected(error: any): boolean {
    const code = String(error?.code || '');
    if (code === 'ECONNRESET' || code === 'EPIPE') return true;
    // 注意：ECONNABORTED 是超时，不算方法被拒，不能盲目覆盖
    if (/socket hang up/i.test(String(error?.message || ''))) return true;

    const status = error?.response?.status;
    return status === 405 || status === 501;
  }

  /**
   * 验证连接（顺带确认认证是否有效）
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.get('/projects', this.paginationParams(1, 1));
      return true;
    } catch (error) {
      this.logger.error('连接验证失败', error);
      return false;
    }
  }

  /**
   * 检查某个接口路径在当前禅道实例上是否存在（只做 HEAD 式探测，不抛错）。
   * 用于「能力自检」：告诉使用者哪些模块这份实例真的开了。
   */
  async probeEndpoint(endpoint: string): Promise<{ ok: boolean; status: number; note?: string }> {
    try {
      const response = await axios.get(`${this.config.baseUrl}${this.resolveEndpoint(endpoint)}`, {
        headers: await this.resolveAuthHeaders(),
        timeout: this.config.timeout,
        validateStatus: () => true,
      });
      return { ok: response.status < 400, status: response.status };
    } catch (error: any) {
      return { ok: false, status: error.response?.status || 0, note: error.code };
    }
  }

  /**
   * 获取禅道版本。
   * 注意：禅道并没有一个所有版本都提供的版本号接口（实测 2.0 的 /system 会被
   * 当成产品路由，返回 `{"status":"fail"}`）。拿不到就安静降级，别当成错误。
   */
  async getVersion(): Promise<string> {
    try {
      const response = await axios.get(`${this.config.baseUrl}${this.resolveEndpoint('/system')}`, {
        headers: await this.resolveAuthHeaders(),
        timeout: this.config.timeout,
        validateStatus: () => true,
      });
      if (response.status >= 400) return '未知';
      const body: any = response.data;
      if (!body || body.status === 'fail') return '未知';
      return body.version || '未知';
    } catch {
      return '未知';
    }
  }

  /**
   * 解析本次请求要携带的认证头。
   *
   * - 配了 account + password：自动换取 REST Token，走 `Token` 头（推荐）
   * - 否则用静态 token：
   *     `账号:zentaosid`  → Cookie 头（兼容老配置，但会话几分钟就过期）
   *     纯 token 串        → Token 头
   */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (this.config.account && this.config.password) {
      return { Token: await this.ensureRestToken() };
    }

    const raw = (this.config.token || '').trim();
    if (!raw) {
      throw new Error('缺少认证信息：请配置 ZENTAO_ACCOUNT + ZENTAO_PASSWORD，或 ZENTAO_TOKEN');
    }

    // 形如 `your-account:xxxx` —— 冒号后是 zentaosid，走会话 Cookie
    const sep = raw.indexOf(':');
    if (sep > 0) {
      return { Cookie: `zentaosid=${raw.slice(sep + 1).trim()}` };
    }
    return { Token: raw };
  }

  /**
   * 向禅道换取 REST Token，并缓存在内存里。
   *
   * - API 2.0：`POST /api.php/v2/users/login` → `{"status":"success","token":"..."}`
   * - API 1.0：`POST /api.php/v1/tokens`      → `{"token":"..."}`
   */
  private async ensureRestToken(): Promise<string> {
    if (this.restToken) return this.restToken;

    const isV2 = this.config.apiVersion !== 'v1';
    const url = `${this.config.baseUrl}${this.apiPrefix}${isV2 ? '/users/login' : '/tokens'}`;

    const response = await axios.post(
      url,
      { account: this.config.account, password: this.config.password },
      {
        timeout: this.config.timeout,
        headers: { 'Content-Type': 'application/json' },
        // 自己判状态码，好把禅道的中文错误原样带出来
        validateStatus: () => true,
      }
    );

    const body: any = response.data;
    const token = body?.token || body?.data?.token;

    if (!token) {
      const reason = body?.error || body?.message || `HTTP ${response.status}`;
      const error = new ZenTaoError(`获取禅道 Token 失败：${reason}`) as ZenTaoError;
      error.status = response.status;
      error.hint =
        `请检查 ZENTAO_BASE_URL（当前 ${this.config.baseUrl}）、ZENTAO_ACCOUNT、ZENTAO_PASSWORD 是否正确，` +
        '并确认该账号在禅道后台拥有 REST API 访问权限';
      error.message = `${error.message}（${error.hint}）`;
      throw error;
    }

    this.restToken = String(token);
    this.logger.debug(`已获取禅道 Token（长度 ${this.restToken.length}，API ${this.config.apiVersion}）`);
    return this.restToken;
  }

  /**
   * 处理响应数据。
   *
   * 禅道两种 API 版本的响应形态不一样，这里统一收口：
   * - **2.0**：`{ status: 'success', <业务字段>: ... }`，失败是 `{ status: 'fail', message: '...' }`
   * - **1.0**：直接返回资源本体，错误体是 `{ error: '...' }`
   *
   * 成功时**原样返回整个 data**（含 status），业务字段在外层，由调用方自取
   * （如 `res.projects` / `res.task`），与官方 SDK 的行为保持一致。
   */
  private handleResponse<T>(response: AxiosResponse<any>): T {
    // 先兜一道：禅道接口只吐 JSON，如果拿到 HTML（比如被导到登录页），
    // 直接说清楚原因，别让它伪装成「API 请求失败」。
    const contentType = String(response.headers?.['content-type'] || '');
    if (contentType && !contentType.includes('json')) {
      const error = new ZenTaoError(
        `接口返回的不是 JSON（content-type: ${contentType}），` +
          '通常是 ZENTAO_BASE_URL 配错了，或请求被重定向到了登录页'
      ) as ZenTaoError;
      error.code = response.status;
      error.status = response.status;
      error.hint = 'ZENTAO_BASE_URL 应指向禅道站点根目录，形如 http://host/zentaomax（不要带 /index.php）';
      throw error;
    }

    const data: any = response.data;

    if (data === null || typeof data !== 'object') {
      return data as T;
    }

    // ---- API 2.0：status 是字符串 'success' / 'fail' ----
    if (typeof data.status === 'string') {
      if (data.status.toLowerCase() !== 'success') {
        const error = new ZenTaoError(
          formatFailMessage(data.message) || data.error || '禅道接口返回失败'
        ) as ZenTaoError;
        error.code = response.status;
        error.status = response.status;
        error.details = data;
        throw error;
      }
      return data as T;
    }

    // ---- API 1.0 的错误体：{ "error": "Unauthorized" } ----
    if (data.error && (typeof data.error === 'string' || typeof data.error === 'object')) {
      const error = new ZenTaoError(formatFailMessage(data.error)) as ZenTaoError;
      error.code = response.status;
      error.status = response.status;
      error.details = data;
      throw error;
    }

    // ---- 兜底：被网关/中间层包成 { status: <number>, data, message } 的形态 ----
    if (typeof data.status === 'number' && 'data' in data) {
      if (data.status !== 200 && data.status !== 0) {
        const error = new ZenTaoError(data.message || 'API 请求失败') as ZenTaoError;
        error.code = data.status;
        error.status = response.status;
        error.details = data;
        throw error;
      }
      return data.data as T;
    }

    // ---- API 1.0 成功：资源本体直接透出 ----
    return data as T;
  }

  /**
   * 转换错误
   */
  private transformError(error: any): ZenTaoError {
    const zenTaoError = new ZenTaoError(error.message || '未知错误') as ZenTaoError;
    zenTaoError.code = error.code || -1;
    zenTaoError.status = error.response?.status || 500;
    zenTaoError.details = error.response?.data;

    // 4xx/5xx 时 axios 只会给一句 "Request failed with status code 401"，
    // 禅道真正的原因（Unauthorized / Execution does not exist…）藏在响应体里，要捞出来。
    // 注意 message 也可能是**对象**（表单字段校验失败就是这样），别直接拼成 "[object Object]"。
    const serverMessage =
      formatFailMessage(error.response?.data?.message) || formatFailMessage(error.response?.data?.error);
    if (serverMessage && !String(zenTaoError.message).includes(String(serverMessage))) {
      zenTaoError.message = `${zenTaoError.message}: ${serverMessage}`;
    }

    if (error.response?.status === 401) {
      if (this.config.credentialSource === 'profile') {
        // profile store **不存密码**，我们没法自动续期。禅道 REST Token 有寿命（本实例 4 小时），
        // 过期就只能是这个 401 —— 说清楚该做什么，别让用户去查 ZENTAO_TOKEN。
        zenTaoError.hint =
          `认证失败：复用的官方 CLI 凭证（${this.config.credentialProfileKey}）已被禅道拒绝。` +
          '禅道 REST Token 有有效期（本实例 4 小时），过期后无法自动续期 —— ' +
          '请重新执行一次 `zentao login`，或在 .env 里改用 ZENTAO_ACCOUNT + ZENTAO_PASSWORD（可自动换 Token）';
      } else {
        zenTaoError.hint = this.config.account
          ? `认证失败：已用账号 ${this.config.account} 换取 Token 但仍被拒绝，请确认该账号有 REST API 权限`
          : '认证失败：请检查 ZENTAO_TOKEN；若用的是 `账号:zentaosid` 格式，zentaosid 只有 1-5 分钟有效期，' +
            '建议改用 ZENTAO_ACCOUNT + ZENTAO_PASSWORD 让程序自动换取 Token';
      }
    } else if (error.response?.status === 403) {
      zenTaoError.hint = '权限不足，请检查用户权限';
    } else if (error.response?.status === 404) {
      zenTaoError.hint =
        `接口不存在（404）：确认 ZENTAO_BASE_URL 指向站点根目录，` +
        `且当前 API 版本（${this.config.apiVersion}）与禅道实际版本匹配`;
    } else if (error.code === 'ECONNABORTED') {
      zenTaoError.hint = '请求超时，请检查网络连接';
    }

    // 把 hint 拼进 message，否则上层日志只看到 "Request failed with status code 401"，
    // 原因完全被吞掉。
    if (zenTaoError.hint) {
      zenTaoError.message = `${zenTaoError.message}（${zenTaoError.hint}）`;
    }

    return zenTaoError;
  }

  /**
   * 检查是否应该重试
   */
  private shouldRetry(error: any): boolean {
    // 网络错误或服务器错误
    return (
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      (error.response && error.response.status >= 500)
    );
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
