/**
 * 复用官方 `zentao-cli` 的本地凭证存储（**只读**）。
 *
 * 官方 CLI 把登录结果写在 `~/.config/zentao/zentao.json`（可用 `ZENTAO_CONFIG_FILE`
 * 覆盖路径，见官方 `src/config/store.ts` 的 `setConfigPath`）。装了官方 CLI 的同事
 * 只要跑过一次 `zentao-cli login`，本 MCP 服务器就不必再配一遍凭证 —— 直接复用。
 *
 * **三条铁律**（都有实测依据，改动时别破）：
 *
 * 1. **只读**。绝不调用 SDK 的 `addProfile` / `switchProfile` / `saveLoginProfile` ——
 *    那些会写盘。
 * 2. **不触碰 home 目录**。因此**不能**用 SDK 的 `getAllProfiles()`：它的 `readStore`
 *    会走 `withProfileFileLock`，**即使纯读**也会 `mkdir ~/.config/zentao/` 并建临时
 *    锁目录（见 `node_modules/zentao-api/dist/profiles/file-lock.js:18`）。
 *    这里用 `fs.readFileSync` 自己读，一个字节都不写。
 * 3. **格式漂移只降级、不报错**。文件不存在 / JSON 坏 / 某条字段不全 → 当作「没有可用
 *    profile」，由调用方回落到清晰的「请配置凭证」提示。
 *
 * ⚠️ 路径口径跟**官方 CLI**（`os.homedir()`），不跟 SDK（`HOME ?? USERPROFILE ?? homedir()`）——
 * 我们复用的是 CLI 写的那个文件，两边口径不一致时要以 CLI 为准。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 官方 CLI 的一条 profile —— 只保留本项目真正要用到的字段 */
export interface StoredProfile {
  /** `account@server`，与官方 CLI 的 `profileKey()` 格式一致 */
  key: string;
  /** 禅道站点根地址（已去尾斜杠） */
  server: string;
  account: string;
  /** REST Token（官方 CLI 只存 Token，**不存密码**，所以 token 过期后无法自动续期） */
  token: string;
  /** 官方 CLI 写入的最后使用时间（ISO 8601），仅用于展示 */
  lastUsedTime?: string;
  /**
   * Token 的**推算失效时刻**（ISO 8601），由 `loginTime + serverConfig.expiredTime` 得出。
   *
   * ⚠️ 实测：禅道 REST Token 是**有寿命**的 —— 本实例 `expiredTime=14400`（4 小时）。
   * store 里 09-18 签发的那个 token 在两天后打接口已 `401 Not allowed`，而同时新 login
   * 拿到的 token 可用（且**多个 token 可并存**，不存在「后签顶掉前签」）。所以过期是主因。
   *
   * 拿不到 `loginTime` / `expiredTime` 时为 undefined —— 此时**不猜**，交给运行时 401 兜底。
   */
  tokenExpiresAt?: string;
}

/** `readProfileStore()` 的快照 —— 描述「文件里有什么」，不做任何选择 */
export interface ProfileStoreSnapshot {
  /** 实际读取的文件路径 */
  path: string;
  /** 文件是否存在（不存在很正常：没装官方 CLI） */
  exists: boolean;
  /** 官方 CLI 记录的当前 profile key */
  currentProfile?: string;
  profiles: StoredProfile[];
  /** 文件存在却用不了的原因（不存在时为 undefined） */
  error?: string;
}

/** 选择结果的原因码，供调用方拼不同的人话 */
export type ProfileSelectionReason =
  /** 命中一条 */
  | 'selected'
  /** store 里一条都没有 */
  | 'empty'
  /** 显式指定了 key，但没命中 */
  | 'not-found'
  /** 有多条、又没指定 key、官方 CLI 也没记 currentProfile */
  | 'ambiguous'
  /** 文件在，但读不了 / 不是合法 JSON */
  | 'store-error';

export interface ProfileSelection {
  profile?: StoredProfile;
  reason: ProfileSelectionReason;
  /** 可选清单（`account@server`），供报错信息列出来 */
  candidates: string[];
}

/** 把路径首段的 `~` 展开为家目录（对齐官方 CLI 的 `expandHome`） */
function expandHome(input: string): string {
  const p = input.trim();
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * 官方 CLI 的配置文件路径。
 * `ZENTAO_CONFIG_FILE` 优先（官方 CLI 认这个变量，我们也认），否则 `~/.config/zentao/zentao.json`。
 * 相对路径按 cwd 解析为绝对路径 —— 与官方 CLI 的 `setConfigPath` 行为一致。
 */
export function getProfileStorePath(): string {
  const custom = process.env.ZENTAO_CONFIG_FILE;
  if (custom && custom.trim() !== '') {
    const expanded = expandHome(custom);
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  }
  return path.join(os.homedir(), '.config', 'zentao', 'zentao.json');
}

function normalizeServerUrl(server: string): string {
  return server.trim().replace(/\/+$/, '');
}

/**
 * 推算 Token 失效时刻：`loginTime + serverConfig.expiredTime`（后者单位是**秒**）。
 * 任一项缺失或不可解析都返回 undefined —— 宁可不给提示，也不要给错提示。
 */
function deriveTokenExpiry(item: Record<string, unknown>): string | undefined {
  const loginTime = typeof item.loginTime === 'string' ? item.loginTime : undefined;
  if (!loginTime) return undefined;

  const serverConfig = item.serverConfig;
  if (!serverConfig || typeof serverConfig !== 'object') return undefined;
  const rawTtl = (serverConfig as Record<string, unknown>).expiredTime;

  // 实测是字符串数字（"14400"），但别假定类型
  const ttlSeconds = typeof rawTtl === 'number' ? rawTtl : parseInt(String(rawTtl ?? ''), 10);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return undefined;

  const issuedAt = Date.parse(loginTime);
  if (Number.isNaN(issuedAt)) return undefined;

  return new Date(issuedAt + ttlSeconds * 1000).toISOString();
}

/** 逐条清洗：字段不全或类型不对的**静默丢弃**（不影响其余条） */
function toStoredProfile(raw: unknown): StoredProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const { server, account, token } = item;
  if (typeof server !== 'string' || typeof account !== 'string' || typeof token !== 'string') {
    return undefined;
  }
  const normalizedServer = normalizeServerUrl(server);
  const normalizedAccount = account.trim();
  const normalizedToken = token.trim();
  if (!normalizedServer || !normalizedAccount || !normalizedToken) return undefined;
  return {
    key: `${normalizedAccount}@${normalizedServer}`,
    server: normalizedServer,
    account: normalizedAccount,
    token: normalizedToken,
    lastUsedTime: typeof item.lastUsedTime === 'string' ? item.lastUsedTime : undefined,
    tokenExpiresAt: deriveTokenExpiry(item),
  };
}

/**
 * 读取 profile store 的快照。**只读、不抛错** —— 所有异常都折成 `snapshot.error`，
 * 让调用方自己决定是降级还是报错。
 */
export function readProfileStore(): ProfileStoreSnapshot {
  const file = getProfileStorePath();

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: file, exists: false, profiles: [] };
    }
    return {
      path: file,
      exists: true,
      profiles: [],
      error: `无法读取（${code || error?.message || '未知错误'}）`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path: file, exists: true, profiles: [], error: '内容不是合法 JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).profiles)) {
    return { path: file, exists: true, profiles: [], error: '缺少 profiles 数组' };
  }

  const raw = parsed as { profiles: unknown[]; currentProfile?: unknown };
  const profiles = raw.profiles
    .map(toStoredProfile)
    .filter((p): p is StoredProfile => p !== undefined);

  return {
    path: file,
    exists: true,
    currentProfile: typeof raw.currentProfile === 'string' ? raw.currentProfile : undefined,
    profiles,
  };
}

/**
 * 按官方 CLI 的匹配口径查一条 profile。三种 key 写法都认（对齐官方 `findProfileByKey`）：
 * `account@server` | `account` | `account@hostname`。
 */
function findByKey(profiles: StoredProfile[], selector: string): StoredProfile | undefined {
  const wanted = selector.trim();
  if (!wanted) return undefined;
  return profiles.find((p) => {
    if (p.key === wanted) return true;
    if (p.account === wanted) return true;
    try {
      return `${p.account}@${new URL(p.server).hostname}` === wanted;
    } catch {
      // server 不是合法 URL 时该形态不成立，不影响前两种
      return false;
    }
  });
}

/**
 * 从快照里挑一条 profile。
 *
 * 优先级：**显式 `selector`（`ZENTAO_PROFILE`）> 官方 CLI 的 `currentProfile` > 唯一一条**。
 * 有多条又无从判断时**宁可报错也不猜** —— 猜错就等于用别人的账号读写禅道。
 */
export function selectProfile(
  snapshot: ProfileStoreSnapshot,
  selector?: string
): ProfileSelection {
  const candidates = snapshot.profiles.map((p) => p.key);

  if (snapshot.error) {
    return { reason: 'store-error', candidates };
  }
  if (snapshot.profiles.length === 0) {
    return { reason: 'empty', candidates };
  }

  const wanted = (selector || '').trim();
  if (wanted) {
    const hit = findByKey(snapshot.profiles, wanted);
    return hit
      ? { profile: hit, reason: 'selected', candidates }
      : { reason: 'not-found', candidates };
  }

  if (snapshot.currentProfile) {
    const current = snapshot.profiles.find((p) => p.key === snapshot.currentProfile);
    if (current) return { profile: current, reason: 'selected', candidates };
  }

  if (snapshot.profiles.length === 1) {
    return { profile: snapshot.profiles[0], reason: 'selected', candidates };
  }

  return { reason: 'ambiguous', candidates };
}

/**
 * Token 是否**按推算**已过期。只做提示用 —— 推算不出来（无 `tokenExpiresAt`）时返回 false，
 * 真正判定以服务端 401 为准。
 */
export function isTokenProbablyExpired(profile: StoredProfile, now: number = Date.now()): boolean {
  if (!profile.tokenExpiresAt) return false;
  const at = Date.parse(profile.tokenExpiresAt);
  return !Number.isNaN(at) && now > at;
}
