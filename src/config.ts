/**
 * 配置管理
 */

import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ZenTaoConfig } from './types';
import {
  ProfileSelection,
  ProfileStoreSnapshot,
  readProfileStore,
  selectProfile,
} from './utils/profile-store';

// 加载环境变量。
// 注意：MCP 客户端是用子进程拉起本服务的，cwd 由客户端决定、不由我们决定，
// 所以优先按「相对本文件的项目根」找 .env，再兜底到当前工作目录。
// （src/config.ts 与 dist/config.js 都在项目根下一级，'..' 都能命中）
//
// 第三种来源是 CLI 安装器写的 `~/.zendao-mcp/.env`：npx 拉起的进程 cwd 不由用户控制，
// 所以不能指望项目目录里有 .env。ZENDAO_ENV_FILE 可显式指定一份，优先级最高。
const explicitConfigFile = (process.env.ZENDAO_ENV_FILE || '').trim();
dotenv.config({
  path: explicitConfigFile
    ? [explicitConfigFile]
    : [
        path.resolve(__dirname, '..', '.env'),
        path.resolve(process.cwd(), '.env'),
        path.join(process.env.ZENDAO_CONFIG_DIR || path.join(os.homedir(), '.zendao-mcp'), '.env'),
      ],
});

// CLI 安装器写入的密码是 base64：dotenv 不会反转义双引号里的 \" 和 \\，明文会失真。
// 这里解码回普通环境变量，后面的 loadConfig() 无需知道两种写法的区别。
if (process.env.ZENTAO_PASSWORD_B64 && !process.env.ZENTAO_PASSWORD) {
  process.env.ZENTAO_PASSWORD = Buffer.from(process.env.ZENTAO_PASSWORD_B64, 'base64').toString('utf8');
}

/**
 * 规范化禅道站点地址。
 * 禅道 REST 接口的完整路径是 `{站点根}/api.php/{版本}/...`：
 * - 结尾多一个 `/` 会产生 `//api.php` 这种别扭路径
 * - 结尾带 `/index.php` 会打到前台路由上，返回登录页 HTML 而不是 JSON
 */
function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/index\.php$/i, '')
    .replace(/\/+$/, '');
}

/**
 * 解析 REST API 版本。
 * 默认 v2（API 2.0，官方主推，覆盖 26 个模块）；只有显式写 v1 才回落旧版。
 * 顺带容错：用户可能把 `/api.php/v2` 直接写进 BASE_URL，这里也认。
 */
function normalizeApiVersion(raw: string | undefined, baseUrl: string): 'v2' | 'v1' {
  const input = (raw || '').trim().toLowerCase();
  if (input === 'v1' || input === '1') return 'v1';
  if (input === 'v2' || input === '2') return 'v2';
  // 没显式配置时，从 baseUrl 里嗅探（有人习惯把 api.php/v1 直接写进地址）
  if (baseUrl.includes('/api.php/v1')) return 'v1';
  return 'v2';
}

/**
 * 解析 PUT/DELETE 的方法覆盖策略，默认 `auto`。
 * 详见 ZenTaoConfig.methodOverride 的说明。
 */
function normalizeMethodOverride(raw: string | undefined): 'auto' | 'always' | 'never' {
  const input = (raw || '').trim().toLowerCase();
  if (input === 'always' || input === 'true' || input === '1' || input === 'on') return 'always';
  if (input === 'never' || input === 'false' || input === '0' || input === 'off') return 'never';
  return 'auto';
}

/**
 * 按顺序取第一个「有值」的环境变量。
 * 用于 `ZENTAO_BASE_URL` / `ZENTAO_URL` 这类别名 —— 官方 CLI 用的是后者，
 * 同事若已经为官方 CLI 设过 `ZENTAO_URL`，本服务不必再配一遍。
 */
function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw && raw.trim() !== '') return raw.trim();
  }
  return undefined;
}

/** 密码**不 trim**（首尾空格可能是密码的一部分），只把空串当没配 */
function envPassword(): string | undefined {
  const raw = process.env.ZENTAO_PASSWORD;
  return raw && raw !== '' ? raw : undefined;
}

/**
 * 一条凭证都没有时，拼一句能直接照着做的报错。
 * 分四种情况（store 坏了 / 空 / 有多条 / 指定的不存在）分别给不同提示。
 */
function describeMissingCredentials(
  store: ProfileStoreSnapshot,
  selection: ProfileSelection
): string {
  const howTo = [
    '缺少禅道认证信息。以下任一种即可：',
    '  1) ZENTAO_ACCOUNT + ZENTAO_PASSWORD（推荐：自动换取 Token，不会过期）',
    '  2) ZENTAO_TOKEN（静态 REST Token）',
    '  3) 复用官方 zentao-cli 的登录 —— 先跑一次 `zentao-cli login`，',
    `     本服务会直接读 ${store.path}`,
  ].join('\n');

  const list = (keys: string[]) => keys.map((k) => `       - ${k}`).join('\n');

  switch (selection.reason) {
    case 'store-error':
      return `${howTo}\n⚠️ 读到了官方 CLI 的配置文件，但用不了：${store.error}（${store.path}）`;
    case 'ambiguous':
      return (
        `${howTo}\n⚠️ 官方 CLI 的配置里有 ${selection.candidates.length} 条 profile，` +
        `无法确定用哪条（${store.path}）。请用 ZENTAO_PROFILE 指定一条：\n${list(selection.candidates)}`
      );
    case 'not-found':
      return (
        `${howTo}\n⚠️ ZENTAO_PROFILE 指定的 profile 不存在（${store.path}）。现有可选项：\n` +
        list(selection.candidates)
      );
    default:
      return `${howTo}\n（${store.path} ${store.exists ? '里没有任何 profile' : '不存在'}）`;
  }
}

export function loadConfig(): ZenTaoConfig {
  // 官方 CLI 的 profile 只读快照 —— 这一份数据既可能提供凭证，也可能只提供站点地址。
  const store = readProfileStore();
  const selection = selectProfile(store, envValue('ZENTAO_PROFILE'));

  const token = envValue('ZENTAO_TOKEN');
  const account = envValue('ZENTAO_ACCOUNT');
  const password = envPassword();

  // 凭证三选一（按优先级）：
  // 1) account + password  → 启动时/失效时自动换 REST Token（推荐，不会过期困扰）
  // 2) token               → 直接使用（REST Token 或 `账号:zentaosid` 旧格式）
  // 3) 官方 CLI profile    → 只读复用 `zentao login` 的结果（见 utils/profile-store.ts）
  //
  // 注意顺序：「只填了一半」必须先判，否则会被下面的通用报错吞掉，
  // 用户只看到「缺少认证信息」，却不知道到底缺哪个。
  //
  // ⚠️ 半填是**明确的配置错误**，即使 profile store 里有能用的凭证也照样报错 ——
  // 静默回落会把用户的笔误藏起来，反而更难查。
  if ((account && !password) || (!account && password)) {
    throw new Error('ZENTAO_ACCOUNT 与 ZENTAO_PASSWORD 必须成对配置');
  }

  let effectiveToken = token;
  let effectiveAccount = account;
  let effectivePassword = password;
  let credentialSource: ZenTaoConfig['credentialSource'];
  let credentialProfileKey: string | undefined;
  let credentialExpiresAt: string | undefined;

  if (token) {
    credentialSource = 'env-token';
  } else if (account && password) {
    credentialSource = 'env-account';
  }

  // 环境变量 / .env 没给出完整凭证 → 回落到官方 CLI 的 profile
  if (!credentialSource) {
    const fromProfile = selection.profile;
    if (!fromProfile) {
      throw new Error(describeMissingCredentials(store, selection));
    }
    effectiveToken = fromProfile.token;
    effectiveAccount = fromProfile.account;
    credentialSource = 'profile';
    credentialProfileKey = fromProfile.key;
    credentialExpiresAt = fromProfile.tokenExpiresAt;
  }

  // 站点地址：环境变量优先（`ZENTAO_BASE_URL` → 官方 CLI 用的 `ZENTAO_URL`），
  // 再回落选中 profile 的 server —— 这样「只 export 了账号密码」的同事也无需再配 URL。
  const rawBaseUrl = normalizeBaseUrl(
    envValue('ZENTAO_BASE_URL') ??
      envValue('ZENTAO_URL') ??
      selection.profile?.server ??
      'http://localhost'
  );
  const apiVersion = normalizeApiVersion(process.env.ZENTAO_API_VERSION, rawBaseUrl);

  // 万一有人把 `/api.php/v2` 也写进了地址，剥掉 —— 客户端会自己拼这一段，
  // 否则会拼出 `/api.php/v2/api.php/v2/...` 这种不存在的路径。
  const baseUrl = rawBaseUrl.replace(/\/api\.php\/v[12]\/?$/i, '').replace(/\/+$/, '');

  const timeout = parseInt(process.env.ZENTAO_TIMEOUT || '30000', 10);
  const retry = parseInt(process.env.ZENTAO_RETRY || '3', 10);
  const retryDelay = parseInt(process.env.ZENTAO_RETRY_DELAY || '1000', 10);

  return {
    baseUrl,
    apiVersion,
    token: effectiveToken,
    account: effectiveAccount,
    password: effectivePassword,
    methodOverride: normalizeMethodOverride(process.env.ZENTAO_METHOD_OVERRIDE),
    timeout,
    retry,
    retryDelay,
    credentialSource,
    credentialProfileKey,
    credentialExpiresAt,
  };
}
