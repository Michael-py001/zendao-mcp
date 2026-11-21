/**
 * 所有类型定义的统一导出
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// 实体类型
export * from './entities';

// 缓存类型
export * from './cache';

// 批量操作类型
export * from './batch';

// 错误类型
export class ZenTaoError extends Error {
  code: number = 0;
  status: number = 0;
  details?: any;
  hint?: string;

  constructor(message: string) {
    super(message);
    this.name = 'ZenTaoError';
  }
}

// 配置类型
export interface ZenTaoConfig {
  baseUrl: string;
  /**
   * 禅道 REST API 版本。
   * - `v2`（默认）：API 2.0，对应 `{站点根}/api.php/v2`。官方主推，覆盖 26 个模块，
   *   任务/执行等模块只有这一版才有正确语义。
   * - `v1`：旧版 API，仅为兼容极老版本保留。
   */
  apiVersion?: 'v2' | 'v1';
  /**
   * 静态凭证，两种形态都兼容：
   * - `<32位hex>`            → 作为 REST Token 走 `Token` 请求头（推荐）
   * - `<账号>:<zentaosid>`   → 作为会话 Cookie 走 `Cookie` 请求头（老写法，几分钟就过期）
   * 若已配置 account + password，则本字段可省略（会自动换取 Token）。
   */
  token?: string;
  /**
   * 禅道登录账号。与 password 同时存在时，自动向 `{API根}/users/login`（v2）
   * 或 `/api.php/v1/tokens`（v1）换取 REST Token。
   */
  account?: string;
  /** 禅道登录密码。仅用于换取 Token，不会出现在请求头里 */
  password?: string;
  /**
   * PUT / DELETE 的方法覆盖策略。
   *
   * 背景：部分禅道部署的前置 Web 服务器（nginx/Apache/WAF）会在 HTTP 层直接
   * 掐断 PUT/DELETE —— 连接被重置，连响应体都拿不到。禅道框架本身支持用
   * `X-HTTP-Method-Override` 头或 `?_method=` 参数把 POST 转成目标方法，
   * 从而绕过这类限制。
   *
   * - `auto`（默认）：先按真实方法发；被传输层拒绝时自动改用覆盖重发，并记住偏好
   * - `always`：所有 PUT/DELETE 一律走覆盖（明确知道实例不支持原生方法时用）
   * - `never`：永不覆盖（调试原生方法时用）
   */
  methodOverride?: 'auto' | 'always' | 'never';
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  /**
   * 本次凭证的实际来源 —— 仅供启动日志/排障展示，不参与任何请求。
   *
   * - `env-token` / `env-account`：来自环境变量或 `.env`（现行为，最高优先级）
   * - `profile`：复用官方 `zentao-cli` 的本地 profile store（`~/.config/zentao/zentao.json`）
   */
  credentialSource?: 'env-token' | 'env-account' | 'profile';
  /** 凭证来自 profile 时，记录用的是哪一条（`account@server`） */
  credentialProfileKey?: string;
  /**
   * 凭证来自 profile 时，**推算的 Token 失效时刻**（ISO 8601）。
   *
   * 禅道 REST Token 有寿命（本实例 4 小时），而 profile store **不存密码**、无法自动续期。
   * 启动时据此提前提醒「该重新 `zentao login` 了」，免得用户撞上难懂的 401。
   * 推算不出来时为 undefined。
   */
  credentialExpiresAt?: string;
}

// MCP 工具结果类型
// 直接复用 SDK 的 CallToolResult：registerTool 回调的返回类型就是它，
// 自己再声明一份结构很容易在 content 的判别联合类型上对不齐。
export type ToolResult = CallToolResult;
