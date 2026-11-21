/**
 * 官方 SDK 错误 → 中文人话。
 *
 * `zentao-api` 的 `ZentaoError` 带稳定的 `code`（见 SDK 的 `ERRORS` 表），
 * 但消息模板是英文的。MCP 工具的输出是给人和 LLM 看的，英文错误码既难懂
 * 也不利于模型自我纠错 —— 这里统一翻译，同时**保留英文原文与错误码**，
 * 出问题时还能对得上官方文档。
 *
 * ⚠️ 尤其重要的是 `E_UNSUPPORTED_ZENTAO_VERSION`：它不是「出错」，而是
 * 「这个禅道版本没有这个能力」。**不翻译的话，8.2 用户看到一串英文会以为是 bug。**
 */

/** SDK 错误码 → 中文说明（补足「为什么 / 怎么办」） */
const HUMAN_MESSAGES: Record<string, string> = {
  E_UNSUPPORTED_ZENTAO_VERSION:
    '当前禅道实例的版本不支持该动作。禅道各版本提供的能力不同（例如「地盘」相关动作需要 max8.5 以上），' +
    '这不是配置错误。可用 `zendao_modules` 查看当前实例实际可用的动作清单。',
  E_API_FAILED: '禅道接口返回业务失败',
  E_HTTP_ERROR:
    'HTTP 请求失败。常见原因：路由不存在（404）、认证失效（401）、权限不足（403），' +
    '或站点地址配错（ZENTAO_BASE_URL 应指向站点根目录）',
  E_NETWORK_ERROR: '网络请求失败，请检查网络连接与代理设置（NO_PROXY 白名单）',
  E_TIMEOUT: '请求超时，可在环境变量 ZENTAO_TIMEOUT 调大超时时间（毫秒）',
  E_ABORTED: '请求已被取消',
  E_NO_GLOBAL_CLIENT: 'SDK 未初始化：缺少客户端实例',
  E_INVALID_MODULE: '模块名不存在，可用 `zendao_modules` 查看可用模块',
  E_INVALID_ACTION: '动作名不存在，可用 `zendao_help` 查看该模块的可用动作',
  E_MISSING_PARAM: '缺少必填参数，可用 `zendao_help` 查看该动作的参数表',
  E_INVALID_PARAM: '参数取值不合法，可用 `zendao_help` 查看该参数的说明与可选值',
  E_INVALID_REQUEST_NAME: '请求名格式不对，应为 `模块/动作`（如 `bug/list`）',
  E_INVALID_ZENTAO_CONFIG: '禅道站点配置无法解析（`/?mode=getconfig` 未返回有效 version）',
  E_INVALID_ZENTAO_VERSION: '禅道版本号格式无法识别',
  E_LOGIN_FAILED: '禅道登录失败：请检查账号密码，以及该账号是否已开通 REST API 权限',
  E_UPLOAD_PATH_UNSUPPORTED: '本地文件路径在当前运行时不受支持',
  E_UPLOAD_FILE_NOT_FOUND: '上传的文件不存在，请检查路径',
  E_UPLOAD_FILE_READ_FAILED: '读取上传文件失败，请检查文件权限',
  E_UPLOAD_FILE_TOO_LARGE: '上传文件超过大小上限',
  E_INVALID_UPLOAD_SOURCE: '上传内容的数据源不合法',
  E_PROFILE_NOT_FOUND: '未找到指定的本地 profile',
  E_NO_PROFILE: '本地还没有任何禅道 profile',
};

/** 结构化的错误信息，便于工具层直接拼装输出 */
export interface HumanizedError {
  /** SDK 错误码（非 SDK 错误时为 undefined） */
  code?: string;
  /** 中文说明 */
  message: string;
  /** 英文原文（排查用） */
  original: string;
  /** SDK 附带的上下文（参数名、HTTP 状态、原始响应等） */
  details?: unknown;
}

/**
 * 把任意错误翻译成中文人话。
 *
 * 非 `ZentaoError` 的错误（例如本项目的 `ZenTaoError`、原生 `Error`）也能处理 ——
 * 只要它带 `code` 且该 code 在映射表里，就一并翻译。
 */
export function humanizeError(error: unknown): HumanizedError {
  const original = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const codeStr = typeof code === 'string' ? code : undefined;
  const details = (error as { details?: unknown } | null | undefined)?.details;

  const human = codeStr ? HUMAN_MESSAGES[codeStr] : undefined;

  if (!human) {
    return { code: codeStr, message: original, original, details };
  }

  // 门槛错误额外把 SDK 原文里的「需要什么版本 / 当前什么版本」带出来，
  // 否则用户只知道「不支持」，不知道差在哪。
  const extra = codeStr === 'E_UNSUPPORTED_ZENTAO_VERSION' && original ? `（SDK 原文：${original}）` : '';

  return {
    code: codeStr,
    message: `${human}${extra}`,
    original,
    details,
  };
}

/**
 * 判断是否为「版本门槛」类错误 —— 这类失败**不是**配置或网络问题，
 * 调用方据此可以提示「换个动作或升级禅道」，而不是让用户去查配置。
 */
export function isVersionGateError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'E_UNSUPPORTED_ZENTAO_VERSION';
}
